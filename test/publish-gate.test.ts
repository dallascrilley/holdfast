import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  approve,
  history,
  LedgerRefused,
  propose,
  publish,
  publishedRevisions,
  reject,
} from '../src/ledger.js';
import {
  appPool,
  DRAFTING_AGENT,
  EDITOR,
  newDecision,
  SCHEDULER,
  SECOND_EDITOR,
  setupDatabase,
  teardownDatabase,
} from './support/harness.js';

beforeAll(setupDatabase);
afterAll(teardownDatabase);

describe('the happy path', () => {
  it('an AI proposes, a human approves, a human publishes', async () => {
    const decision = newDecision('happy');

    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'Postgres 16 is now the minimum supported version.' },
    });
    const approval = await approve(appPool(), {
      ...decision,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });
    const publication = await publish(appPool(), {
      ...decision,
      actor: EDITOR,
      approvalEntryId: approval.entryId,
    });

    expect((await history(appPool(), decision.decisionKey)).map((e) => e.entryType)).toEqual([
      'proposal',
      'approval',
      'publication',
    ]);

    const published = await publishedRevisions(appPool(), decision.subjectId);
    expect(published).toHaveLength(1);
    expect(published[0].payload).toEqual({
      body: 'Postgres 16 is now the minimum supported version.',
    });
    expect(published[0].publishedBy).toBe(EDITOR.id);
    expect(publication.approvesEntryId).toBe(approval.entryId);
  });
});

describe('a non-human actor cannot cross the gate', () => {
  it('the AI actor cannot approve its own proposal', async () => {
    const decision = newDecision('ai-self-approve');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'draft' },
    });
    await expect(
      approve(appPool(), { ...decision, actor: DRAFTING_AGENT, proposalEntryId: proposal.entryId }),
    ).rejects.toBeInstanceOf(LedgerRefused);
  });

  it('the AI actor cannot approve someone else’s proposal either', async () => {
    const decision = newDecision('ai-approve-other');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: EDITOR,
      payload: { body: 'draft' },
    });
    await expect(
      approve(appPool(), { ...decision, actor: DRAFTING_AGENT, proposalEntryId: proposal.entryId }),
    ).rejects.toMatchObject({ pgCode: '23514' }); // check_violation: human-only transitions
  });

  it('a system actor cannot approve', async () => {
    const decision = newDecision('system-approve');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'draft' },
    });
    await expect(
      approve(appPool(), { ...decision, actor: SCHEDULER, proposalEntryId: proposal.entryId }),
    ).rejects.toMatchObject({ pgCode: '23514' });
  });

  it('the AI actor cannot publish an approval a human granted', async () => {
    const decision = newDecision('ai-publish');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'draft' },
    });
    const approval = await approve(appPool(), {
      ...decision,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });
    await expect(
      publish(appPool(), {
        ...decision,
        actor: DRAFTING_AGENT,
        approvalEntryId: approval.entryId,
      }),
    ).rejects.toMatchObject({ pgCode: '23514' });
  });

  it('raw SQL does not help: the AI actor is refused at the database', async () => {
    const decision = newDecision('ai-publish-raw');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'draft' },
    });
    const approval = await approve(appPool(), {
      ...decision,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });
    await expect(
      appPool().query(
        `insert into holdfast_ledger
           (entry_id, subject_id, decision_key, entry_type, actor_kind, actor_id,
            approves_entry_id, payload)
         values (gen_random_uuid(), $1, $2, 'publication', 'ai', 'drafting-agent', $3, '{}'::jsonb)`,
        [decision.subjectId, decision.decisionKey, approval.entryId],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    expect(await publishedRevisions(appPool(), decision.subjectId)).toEqual([]);
  });
});

describe('publication requires a real, distinct human approval', () => {
  it('cannot publish a proposal that was never approved', async () => {
    const decision = newDecision('unapproved');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'draft' },
    });
    // Point the publication straight at the proposal, skipping approval.
    await expect(
      publish(appPool(), { ...decision, actor: EDITOR, approvalEntryId: proposal.entryId }),
    ).rejects.toMatchObject({ pgCode: '23001' }); // restrict_violation from the gate
    expect(await publishedRevisions(appPool(), decision.subjectId)).toEqual([]);
  });

  it('a human cannot approve their own proposal', async () => {
    const decision = newDecision('self-approve');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: EDITOR,
      payload: { body: 'draft' },
    });
    await expect(
      approve(appPool(), { ...decision, actor: EDITOR, proposalEntryId: proposal.entryId }),
    ).rejects.toMatchObject({ pgCode: '23001' });

    // A second, distinct human can.
    const approval = await approve(appPool(), {
      ...decision,
      actor: SECOND_EDITOR,
      proposalEntryId: proposal.entryId,
    });
    expect(approval.actorId).toBe(SECOND_EDITOR.id);
  });

  it('cannot publish a rejected proposal', async () => {
    const decision = newDecision('rejected');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'draft' },
    });
    const rejection = await reject(appPool(), {
      ...decision,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });
    await expect(
      publish(appPool(), { ...decision, actor: EDITOR, approvalEntryId: rejection.entryId }),
    ).rejects.toMatchObject({ pgCode: '23001' });

    // And it cannot be approved after the fact to unlock publication.
    await expect(
      approve(appPool(), { ...decision, actor: SECOND_EDITOR, proposalEntryId: proposal.entryId }),
    ).rejects.toMatchObject({ pgCode: '23001' });
  });

  it('cannot publish the same approval twice', async () => {
    const decision = newDecision('double-publish');
    const proposal = await propose(appPool(), {
      ...decision,
      actor: DRAFTING_AGENT,
      payload: { body: 'draft' },
    });
    const approval = await approve(appPool(), {
      ...decision,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });
    await publish(appPool(), { ...decision, actor: EDITOR, approvalEntryId: approval.entryId });
    await expect(
      publish(appPool(), { ...decision, actor: SECOND_EDITOR, approvalEntryId: approval.entryId }),
    ).rejects.toMatchObject({ pgCode: '23001' });
  });

  it('cannot borrow an approval from a different decision', async () => {
    const approvedElsewhere = newDecision('borrow-source');
    const proposal = await propose(appPool(), {
      ...approvedElsewhere,
      actor: DRAFTING_AGENT,
      payload: { body: 'harmless typo fix' },
    });
    const approval = await approve(appPool(), {
      ...approvedElsewhere,
      actor: EDITOR,
      proposalEntryId: proposal.entryId,
    });

    const target = newDecision('borrow-target');
    await propose(appPool(), { ...target, actor: DRAFTING_AGENT, payload: { body: 'not reviewed' } });
    await expect(
      publish(appPool(), { ...target, actor: EDITOR, approvalEntryId: approval.entryId }),
    ).rejects.toMatchObject({ pgCode: '23001' });
    expect(await publishedRevisions(appPool(), target.subjectId)).toEqual([]);
  });

  it('cannot reference an entry that does not exist', async () => {
    const decision = newDecision('phantom');
    await expect(
      publish(appPool(), {
        ...decision,
        actor: EDITOR,
        approvalEntryId: '00000000-0000-4000-8000-000000000000',
      }),
    ).rejects.toBeInstanceOf(LedgerRefused);
  });
});
