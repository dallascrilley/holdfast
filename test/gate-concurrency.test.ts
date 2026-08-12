import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { approve, history, propose, publish, reject } from '../src/ledger.js';
import {
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const first = await appPool().connect();
    const second = await appPool().connect();
    try {
      await first.query('BEGIN');
      await publish(first, { ...decision, actor: EDITOR, approvalEntryId: approval.entryId });

      // The competing publish starts while the first is uncommitted. It must
      // block on the append lock, then fail once the first commit is visible.
      const competing = (async () => {
        await second.query('BEGIN');
        try {
          await publish(second, {
            ...decision,
            actor: SECOND_EDITOR,
            approvalEntryId: approval.entryId,
          });
          await second.query('COMMIT');
          return 'committed';
        } catch (error) {
          await second.query('ROLLBACK');
          return error as Error;
        }
      })();

      await sleep(300);
      await first.query('COMMIT');

      const outcome = await competing;
      expect(outcome).not.toBe('committed');
      expect((outcome as Error).message).toMatch(/already published|duplicate key/);
    } finally {
      first.release();
      second.release();
    }

    const entries = await history(appPool(), decision.decisionKey);
    expect(entries.filter((e) => e.entryType === 'publication')).toHaveLength(1);
  });

  it('a proposal being rejected cannot be concurrently approved', async () => {
    const decision = newDecision('race-reject-approve');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { text: 'ship the risky thing' },
    });

    const first = await appPool().connect();
    const second = await appPool().connect();
    try {
      await first.query('BEGIN');
      await reject(first, {
        ...decision,
        actor: EDITOR,
        proposalEntryId: proposal.entryId,
        payload: { reason: 'unsafe' },
      });

      const competing = (async () => {
        await second.query('BEGIN');
        try {
          await approve(second, {
            ...decision,
            actor: SECOND_EDITOR,
            proposalEntryId: proposal.entryId,
          });
          await second.query('COMMIT');
          return 'committed';
        } catch (error) {
          await second.query('ROLLBACK');
          return error as Error;
        }
      })();

      await sleep(300);
      await first.query('COMMIT');

      const outcome = await competing;
      expect(outcome).not.toBe('committed');
      expect((outcome as Error).message).toMatch(/already decided|duplicate key/);
    } finally {
      first.release();
      second.release();
    }

    const entries = await history(appPool(), decision.decisionKey);
    expect(entries.map((e) => e.entryType)).toEqual(['proposal', 'rejection']);
  });
});
