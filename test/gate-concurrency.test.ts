import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';

import { approve, history, propose, publish, reject } from '../src/ledger.js';
import {
  adminPool,
  appPool,
  DRAFTING_AGENT,
  EDITOR,
  newDecision,
  SECOND_EDITOR,
  setupDatabase,
  teardownDatabase,
} from './support/harness.js';

beforeAll(setupDatabase);
afterAll(teardownDatabase);

/** Same key as holdfast_serialize_append / holdfast_chain_entry. */
const APPEND_LOCK_KEY = 4021559431;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait until at least one backend is *waiting* on the append advisory lock.
 * Replaces a fixed sleep: the competing writer has entered the insert path and
 * is blocked, so the first transaction can commit knowing the race is live.
 */
async function waitForAppendLockWaiter(
  watcher: PoolClient,
  timeoutMs = 5_000,
): Promise<void> {
  // Single-arg pg_advisory_xact_lock(bigint): high 32 bits → classid, low → objid.
  const classid = Math.floor(APPEND_LOCK_KEY / 2 ** 32);
  const objid = APPEND_LOCK_KEY >>> 0;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { rows } = await watcher.query<{ n: number }>(
      `select count(*)::int as n
         from pg_locks
        where locktype = 'advisory'
          and classid = $1
          and objid = $2
          and not granted`,
      [classid, objid],
    );
    if ((rows[0]?.n ?? 0) >= 1) return;
    await sleep(20);
  }
  throw new Error(
    `timed out waiting for a waiter on advisory lock ${APPEND_LOCK_KEY} (classid=${classid}, objid=${objid})`,
  );
}

async function racePublish(
  approvalEntryId: string,
  decision: { subjectId: string; decisionKey: string },
): Promise<{ outcome: 'committed' | Error; publications: number }> {
  const first = await appPool().connect();
  const second = await appPool().connect();
  const watcher = await adminPool().connect();
  try {
    await first.query('BEGIN');
    await publish(first, { ...decision, actor: EDITOR, approvalEntryId });

    const competing = (async () => {
      await second.query('BEGIN');
      try {
        await publish(second, {
          ...decision,
          actor: SECOND_EDITOR,
          approvalEntryId,
        });
        await second.query('COMMIT');
        return 'committed' as const;
      } catch (error) {
        await second.query('ROLLBACK');
        return error as Error;
      }
    })();

    await waitForAppendLockWaiter(watcher);
    await first.query('COMMIT');

    const outcome = await competing;
    const entries = await history(appPool(), decision.decisionKey);
    return {
      outcome,
      publications: entries.filter((e) => e.entryType === 'publication').length,
    };
  } finally {
    first.release();
    second.release();
    watcher.release();
  }
}

async function raceRejectThenApprove(
  proposalEntryId: string,
  decision: { subjectId: string; decisionKey: string },
): Promise<{ outcome: 'committed' | Error; types: string[] }> {
  const first = await appPool().connect();
  const second = await appPool().connect();
  const watcher = await adminPool().connect();
  try {
    await first.query('BEGIN');
    await reject(first, {
      ...decision,
      actor: EDITOR,
      proposalEntryId,
      payload: { reason: 'unsafe' },
    });

    const competing = (async () => {
      await second.query('BEGIN');
      try {
        await approve(second, {
          ...decision,
          actor: SECOND_EDITOR,
          proposalEntryId,
        });
        await second.query('COMMIT');
        return 'committed' as const;
      } catch (error) {
        await second.query('ROLLBACK');
        return error as Error;
      }
    })();

    await waitForAppendLockWaiter(watcher);
    await first.query('COMMIT');

    const outcome = await competing;
    const entries = await history(appPool(), decision.decisionKey);
    return { outcome, types: entries.map((e) => e.entryType) };
  } finally {
    first.release();
    second.release();
    watcher.release();
  }
}

/**
 * These attacks run two sessions with application-managed transactions, which
 * is exactly what `Queryable` invites callers to do. The first session holds
 * its transaction open long enough for the second to attempt the conflicting
 * write mid-flight. Without serialize-before-check (migration 0004), both
 * inserts pass the gate's EXISTS checks against the pre-commit snapshot and
 * both commit.
 */
describe('the gate under concurrency', () => {
  it('the same approval cannot be published twice by racing sessions', async () => {
    const decision = newDecision('race-double-publish');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { text: 'contended revision' },
    });
    const approval = await approve(appPool(), {
      ...decision,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });

    const { outcome, publications } = await racePublish(approval.entryId, decision);
    expect(outcome).not.toBe('committed');
    expect((outcome as Error).message).toMatch(/already published|duplicate key/);
    expect(publications).toBe(1);
  });

  it('a proposal being rejected cannot be concurrently approved', async () => {
    const decision = newDecision('race-reject-approve');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { text: 'ship the risky thing' },
    });

    const { outcome, types } = await raceRejectThenApprove(proposal.entryId, decision);
    expect(outcome).not.toBe('committed');
    expect((outcome as Error).message).toMatch(/already decided|duplicate key/);
    expect(types).toEqual(['proposal', 'rejection']);
  });
});

/**
 * Machine-check that the race is real without migration 0004, not only
 * author-asserted. Drops the serialize trigger and partial unique indexes,
 * re-runs the double-publish race, expects both sessions to commit, then
 * restores 0004 so later tests keep a correct schema.
 */
describe('without migration 0004 the race lands (fail-closed only after the fix)', () => {
  async function dropConcurrencyFix(admin: PoolClient): Promise<void> {
    await admin.query('drop trigger if exists holdfast_ledger_00_serialize on holdfast_ledger');
    await admin.query('drop function if exists holdfast_serialize_append() cascade');
    await admin.query('drop index if exists holdfast_one_decision_per_proposal');
    await admin.query('drop index if exists holdfast_one_publication_per_approval');
  }

  async function restoreConcurrencyFix(admin: PoolClient): Promise<void> {
    const sqlPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'migrations',
      '0004_gate_concurrency.sql',
    );
    await admin.query(readFileSync(sqlPath, 'utf8'));
  }

  it('two racing publishes both commit when 0004 is absent', async () => {
    const admin = await adminPool().connect();
    let pollutedDecisionKey: string | null = null;
    try {
      await dropConcurrencyFix(admin);

      const decision = newDecision('pre-0004-double-publish');
      pollutedDecisionKey = decision.decisionKey;
      const proposal = await propose(appPool(), {
        ...decision,
        actor: DRAFTING_AGENT,
        payload: { text: 'should double-publish without 0004' },
      });
      const approval = await approve(appPool(), {
        ...decision,
        actor: EDITOR,
        proposalEntryId: proposal.entryId,
      });

      const { outcome, publications } = await racePublish(approval.entryId, decision);

      // The bug: both writers pass the gate's EXISTS checks against the
      // pre-commit snapshot, then both commit. Without 0004 this is green for
      // the attacker.
      expect(outcome).toBe('committed');
      expect(publications).toBe(2);
    } finally {
      try {
        // The double publication violates the unique index we are about to
        // re-create. Drop those rows (triggers off) before restoring 0004.
        if (pollutedDecisionKey) {
          await admin.query('alter table holdfast_ledger disable trigger all');
          try {
            await admin.query('delete from holdfast_ledger where decision_key = $1', [
              pollutedDecisionKey,
            ]);
          } finally {
            await admin.query('alter table holdfast_ledger enable trigger all');
          }
        }
        await restoreConcurrencyFix(admin);
      } finally {
        admin.release();
      }
    }

    // Sanity: with 0004 restored, the same race fails closed again.
    const decision = newDecision('post-restore-double-publish');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { text: 'must be unique again' },
    });
    const approval = await approve(appPool(), {
      ...decision,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });
    const { outcome, publications } = await racePublish(approval.entryId, decision);
    expect(outcome).not.toBe('committed');
    expect(publications).toBe(1);
  });
});
