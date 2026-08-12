import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

import { approve, propose, publish } from '../src/ledger.js';
import { verifyChain } from '../src/verify.js';
import {
  adminPool,
  appPool,
  DRAFTING_AGENT,
  EDITOR,
  newDecision,
  setupDatabase,
  teardownDatabase,
} from './support/harness.js';

/**
 * Tamper detection.
 *
 * The triggers stop tampering through the front door. These tests take the back
 * door: the schema owner disables the append-only triggers, rewrites history,
 * and the chain verifier is expected to notice. Each attack runs inside a
 * transaction that is rolled back, so the ledger the other tests share is never
 * actually damaged.
 */

beforeAll(setupDatabase);
afterAll(teardownDatabase);

async function seedDecision(label: string): Promise<{ proposalEntryId: string }> {
  const decision = newDecision(label);
  const proposal = await propose(appPool(), {
    ...decision,
    actor: DRAFTING_AGENT,
    payload: { body: `body for ${label}` },
  });
  const approval = await approve(appPool(), {
    ...decision,
    actor: EDITOR,
    proposalEntryId: proposal.entryId,
  });
  await publish(appPool(), { ...decision, actor: EDITOR, approvalEntryId: approval.entryId });
  return { proposalEntryId: proposal.entryId };
}

/** Runs `fn` with the append-only triggers off, then rolls everything back. */
async function withTriggersDisabled<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await adminPool().connect();
  try {
    await client.query('begin');
    await client.query('alter table holdfast_ledger disable trigger holdfast_ledger_block_update');
    await client.query('alter table holdfast_ledger disable trigger holdfast_ledger_block_delete');
    return await fn(client);
  } finally {
    await client.query('rollback');
    client.release();
  }
}

describe('an untampered chain', () => {
  it('verifies clean and links every entry to its predecessor', async () => {
    await seedDecision('chain-clean');
    const report = await verifyChain(appPool());
    expect(report.failures).toEqual([]);
    expect(report.intact).toBe(true);
    expect(report.entriesChecked).toBeGreaterThanOrEqual(3);
    expect(report.headHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('starts from the all-zero genesis hash', async () => {
    const { rows } = await appPool().query<{ prev_hash: string }>(
      'select prev_hash from holdfast_ledger order by seq asc limit 1',
    );
    expect(rows[0].prev_hash).toBe('0'.repeat(64));
  });

  it('each entry carries the previous entry hash', async () => {
    const { rows } = await appPool().query<{ prev_hash: string; entry_hash: string }>(
      'select prev_hash, entry_hash from holdfast_ledger order by seq asc',
    );
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].entry_hash);
    }
  });
});

describe('tampering behind the triggers', () => {
  it('an edited payload is detected as a hash mismatch', async () => {
    const { proposalEntryId } = await seedDecision('chain-edit');
    const report = await withTriggersDisabled(async (client) => {
      const { rowCount } = await client.query(
        'update holdfast_ledger set payload = $1::jsonb where entry_id = $2',
        [JSON.stringify({ body: 'quietly rewritten after the fact' }), proposalEntryId],
      );
      expect(rowCount).toBe(1); // the tamper genuinely landed
      return verifyChain(client);
    });

    expect(report.intact).toBe(false);
    const mismatch = report.failures.find((failure) => failure.reason === 'hash_mismatch');
    expect(mismatch?.entryId).toBe(proposalEntryId);
  });

  it('a changed actor is detected — attribution is inside the hash', async () => {
    const { proposalEntryId } = await seedDecision('chain-actor');
    const report = await withTriggersDisabled(async (client) => {
      await client.query(
        "update holdfast_ledger set actor_kind = 'human', actor_id = 'rowan.mercer' where entry_id = $1",
        [proposalEntryId],
      );
      return verifyChain(client);
    });
    expect(report.failures.some((f) => f.reason === 'hash_mismatch')).toBe(true);
  });

  it('a removed entry is detected as a broken link', async () => {
    const { proposalEntryId } = await seedDecision('chain-delete');
    // Something has to come after the row we remove, otherwise we would only be
    // truncating the chain rather than punching a hole in it.
    await seedDecision('chain-delete-successor');

    const report = await withTriggersDisabled(async (client) => {
      // Delete the publication. It is a leaf — nothing references it — so the
      // foreign key does not save us here; only the chain does.
      const { rowCount } = await client.query(
        `delete from holdfast_ledger
          where entry_type = 'publication'
            and approves_entry_id in (
              select entry_id from holdfast_ledger where approves_entry_id = $1
            )`,
        [proposalEntryId],
      );
      expect(rowCount).toBe(1);
      return verifyChain(client);
    });
    expect(report.failures.some((f) => f.reason === 'broken_link')).toBe(true);
  });

  it('recomputing the hash to cover the edit still breaks the next link', async () => {
    // The thorough attacker: change the payload AND repair that row's own hash.
    // The row now self-verifies, but the entry written after it still carries
    // the old hash, so the chain does not close.
    const { proposalEntryId } = await seedDecision('chain-repair');
    const report = await withTriggersDisabled(async (client) => {
      await client.query(
        `update holdfast_ledger
            set payload = $1::jsonb,
                entry_hash = encode(sha256(convert_to(holdfast_canonical_entry(
                  prev_hash, entry_id, subject_id, decision_key, entry_type, actor_kind,
                  actor_id, approves_entry_id, $1::jsonb, recorded_at), 'UTF8')), 'hex')
          where entry_id = $2`,
        [JSON.stringify({ body: 'rewritten and re-hashed' }), proposalEntryId],
      );
      return verifyChain(client);
    });

    expect(report.intact).toBe(false);
    expect(report.failures.some((f) => f.reason === 'hash_mismatch')).toBe(false);
    expect(report.failures.some((f) => f.reason === 'broken_link')).toBe(true);
  });
});

describe('the verifier does not trust the database to grade itself', () => {
  it('recomputes hashes in JavaScript, so a corrupted stored hash is caught', async () => {
    const { proposalEntryId } = await seedDecision('chain-independent');
    const report = await withTriggersDisabled(async (client) => {
      await client.query('update holdfast_ledger set entry_hash = $1 where entry_id = $2', [
        'f'.repeat(64),
        proposalEntryId,
      ]);
      return verifyChain(client);
    });
    expect(report.failures.some((f) => f.reason === 'hash_mismatch')).toBe(true);
  });
});

describe('honest boundary: full rewrite is not detected without an external head anchor', () => {
  it('a superuser who rewrites every entry from a point forward can leave verifyChain green', async () => {
    // Documents the README claim: the chain is tamper-evident against partial
    // edits, not tamper-proof against a full forward rewrite. Without a head
    // hash held outside this database, an internal re-hash from the edit point
    // forward produces an intact chain. This test is the negative control.
    const { proposalEntryId } = await seedDecision('chain-full-rewrite');
    // A later entry so the rewrite has a successor to re-link.
    await seedDecision('chain-full-rewrite-tail');

    const report = await withTriggersDisabled(async (client) => {
      // Punch a payload change into the proposal, then re-hash every row from
      // that seq forward so prev_hash/entry_hash stay consistent end-to-end.
      const { rows: fromHere } = await client.query<{ seq: string }>(
        'select seq::text as seq from holdfast_ledger where entry_id = $1',
        [proposalEntryId],
      );
      const startSeq = fromHere[0]?.seq;
      expect(startSeq).toBeTruthy();

      await client.query(
        `update holdfast_ledger
            set payload = jsonb_set(payload, '{body}', '"full rewrite of history"')
          where entry_id = $1`,
        [proposalEntryId],
      );

      const { rows } = await client.query<{
        seq: string;
        entry_id: string;
        prev_hash: string;
      }>(
        `select seq::text as seq, entry_id, prev_hash
           from holdfast_ledger
          where seq >= $1::bigint
          order by seq asc`,
        [startSeq],
      );

      let prev = rows[0]!.prev_hash;
      for (const row of rows) {
        await client.query(
          `update holdfast_ledger
              set prev_hash = $1,
                  entry_hash = encode(sha256(convert_to(holdfast_canonical_entry(
                    $1::char(64), entry_id, subject_id, decision_key, entry_type,
                    actor_kind, actor_id, approves_entry_id, payload, recorded_at
                  ), 'UTF8')), 'hex')
            where entry_id = $2
            returning entry_hash`,
          [prev, row.entry_id],
        );
        const { rows: hashed } = await client.query<{ entry_hash: string }>(
          'select entry_hash from holdfast_ledger where entry_id = $1',
          [row.entry_id],
        );
        prev = hashed[0]!.entry_hash;
      }

      return verifyChain(client);
    });

    expect(report.intact).toBe(true);
    expect(report.failures).toEqual([]);
  });
});

