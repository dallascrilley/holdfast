import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approve, propose, publish, type LedgerEntry } from '../src/ledger.js';
import {
  adminPool,
  appPool,
  appRole,
  DRAFTING_AGENT,
  EDITOR,
  newDecision,
  setupDatabase,
  teardownDatabase,
} from './support/harness.js';

/**
 * The adversary here is not a confused caller. It is someone holding a
 * connection as the application role, writing raw SQL, trying to change history.
 * Every test below is an attack, and the assertion is that it fails.
 */

let entry: LedgerEntry;

beforeAll(async () => {
  await setupDatabase();
  const { subjectId, decisionKey } = newDecision('append-only');
  const proposal = await propose(appPool(), {
    subjectId,
    decisionKey,
    actor: DRAFTING_AGENT,
    payload: { body: 'Ledger entries are immutable once written.' },
  });
  const approval = await approve(appPool(), {
    subjectId,
    decisionKey,
    actor: EDITOR,
    proposalEntryId: proposal.entryId,
  });
  await publish(appPool(), {
    subjectId,
    decisionKey,
    actor: EDITOR,
    approvalEntryId: approval.entryId,
  });
  entry = proposal;
});

afterAll(teardownDatabase);

describe('raw SQL as the application role', () => {
  it('cannot UPDATE a ledger row', async () => {
    await expect(
      appPool().query('update holdfast_ledger set payload = $1::jsonb where entry_id = $2', [
        JSON.stringify({ body: 'rewritten' }),
        entry.entryId,
      ]),
    ).rejects.toMatchObject({ code: '42501' }); // insufficient_privilege
  });

  it('cannot DELETE a ledger row', async () => {
    await expect(
      appPool().query('delete from holdfast_ledger where entry_id = $1', [entry.entryId]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot TRUNCATE the ledger', async () => {
    await expect(appPool().query('truncate holdfast_ledger')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('cannot UPDATE with a WHERE clause that matches nothing either', async () => {
    // Privilege is checked before rows are matched, so even a no-op update is
    // refused. This rules out "it only failed because a trigger saw a row".
    await expect(
      appPool().query("update holdfast_ledger set payload = '{}'::jsonb where false"),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot grant itself the missing privileges', async () => {
    // Postgres does not error here — a GRANT you have no right to make emits a
    // warning and grants nothing. So the assertion is on the outcome, not the
    // statement: the privileges are unchanged, and UPDATE still fails after.
    await appPool().query(`grant update, delete on holdfast_ledger to ${appRole()}`);

    const { rows } = await appPool().query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.table_privileges
        where table_name = 'holdfast_ledger' and grantee = $1
        order by privilege_type`,
      [appRole()],
    );
    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);

    await expect(
      appPool().query("update holdfast_ledger set payload = '{}'::jsonb where entry_id = $1", [
        entry.entryId,
      ]),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('cannot disable the append-only triggers', async () => {
    await expect(
      appPool().query('alter table holdfast_ledger disable trigger holdfast_ledger_block_update'),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('still has the privileges it is supposed to have', async () => {
    const { rows } = await appPool().query<{ privilege_type: string }>(
      `select privilege_type
         from information_schema.table_privileges
        where table_name = 'holdfast_ledger' and grantee = $1
        order by privilege_type`,
      [appRole()],
    );
    expect(rows.map((row) => row.privilege_type)).toEqual(['INSERT', 'SELECT']);
  });
});

describe('the trigger layer, tested independently of privileges', () => {
  // The schema owner is not blocked by GRANT — table owners bypass their own
  // privilege checks. If append-only rested on REVOKE alone, these would pass.
  it('refuses UPDATE even for the schema owner', async () => {
    await expect(
      adminPool().query('update holdfast_ledger set payload = $1::jsonb where entry_id = $2', [
        JSON.stringify({ body: 'rewritten by the owner' }),
        entry.entryId,
      ]),
    ).rejects.toMatchObject({ message: expect.stringContaining('append-only') });
  });

  it('refuses DELETE even for the schema owner', async () => {
    await expect(
      adminPool().query('delete from holdfast_ledger where entry_id = $1', [entry.entryId]),
    ).rejects.toMatchObject({ message: expect.stringContaining('append-only') });
  });

  it('refuses TRUNCATE even for the schema owner', async () => {
    await expect(adminPool().query('truncate holdfast_ledger')).rejects.toMatchObject({
      message: expect.stringContaining('append-only'),
    });
  });

  it('leaves the row exactly as it was written', async () => {
    const { rows } = await adminPool().query<{ payload: Record<string, unknown>; count: string }>(
      `select payload, (select count(*)::text from holdfast_ledger) as count
         from holdfast_ledger where entry_id = $1`,
      [entry.entryId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toEqual({ body: 'Ledger entries are immutable once written.' });
  });
});

describe('the application layer offers no mutation path', () => {
  it('exports no update or delete function', async () => {
    const api = await import('../src/index.js');
    const names = Object.keys(api);
    expect(names.filter((name) => /update|delete|edit|amend|rewrite/i.test(name))).toEqual([]);
    expect(names).toContain('propose');
  });

  it('inserting a duplicate entry_id is refused rather than silently upserting', async () => {
    const { subjectId, decisionKey } = newDecision('dup');
    await expect(
      appPool().query(
        `insert into holdfast_ledger
           (entry_id, subject_id, decision_key, entry_type, actor_kind, actor_id, payload)
         values ($1, $2, $3, 'proposal', 'ai', 'drafting-agent', '{}'::jsonb)`,
        [entry.entryId, subjectId, decisionKey],
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation
  });

  it('cannot supply its own hash values', async () => {
    const { subjectId, decisionKey } = newDecision('forged-hash');
    const forged = 'a'.repeat(64);
    const { rows } = await appPool().query<{ prev_hash: string; entry_hash: string }>(
      `insert into holdfast_ledger
         (entry_id, subject_id, decision_key, entry_type, actor_kind, actor_id, payload,
          prev_hash, entry_hash)
       values (gen_random_uuid(), $1, $2, 'proposal', 'ai', 'drafting-agent', '{}'::jsonb, $3, $3)
       returning prev_hash, entry_hash`,
      [subjectId, decisionKey, forged],
    );
    expect(rows[0].prev_hash).not.toBe(forged);
    expect(rows[0].entry_hash).not.toBe(forged);
  });
});
