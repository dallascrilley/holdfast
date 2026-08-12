import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type ActorKind = 'human' | 'ai' | 'system';
export type EntryType = 'proposal' | 'approval' | 'rejection' | 'publication';

export interface Actor {
  id: string;
  kind: ActorKind;
}

export interface LedgerEntry {
  seq: string;
  entryId: string;
  subjectId: string;
  decisionKey: string;
  entryType: EntryType;
  actorKind: ActorKind;
  actorId: string;
  approvesEntryId: string | null;
  payload: Record<string, unknown>;
  recordedAt: Date;
  prevHash: string;
  entryHash: string;
}

/**
 * Raised when the database refuses a write. The ledger never translates a
 * refusal into a soft failure — if Postgres said no, the caller hears no.
 */
export class LedgerRefused extends Error {
  constructor(
    message: string,
    readonly pgCode: string | undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LedgerRefused';
  }
}

type Queryable = Pool | PoolClient;

const SELECT_COLUMNS = `
  seq::text                as seq,
  entry_id                 as "entryId",
  subject_id               as "subjectId",
  decision_key             as "decisionKey",
  entry_type               as "entryType",
  actor_kind               as "actorKind",
  actor_id                 as "actorId",
  approves_entry_id        as "approvesEntryId",
  payload                  as payload,
  recorded_at              as "recordedAt",
  prev_hash                as "prevHash",
  entry_hash               as "entryHash"
`;

async function append(
  db: Queryable,
  input: {
    subjectId: string;
    decisionKey: string;
    entryType: EntryType;
    actor: Actor;
    approvesEntryId: string | null;
    payload: Record<string, unknown>;
  },
): Promise<LedgerEntry> {
  try {
    const { rows } = await db.query<LedgerEntry>(
      // recorded_at, prev_hash and entry_hash are deliberately absent: the
      // BEFORE INSERT trigger computes all three. There is no application code
      // path that can propose a hash.
      `insert into holdfast_ledger
         (entry_id, subject_id, decision_key, entry_type, actor_kind, actor_id,
          approves_entry_id, payload)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       returning ${SELECT_COLUMNS}`,
      [
        randomUUID(),
        input.subjectId,
        input.decisionKey,
        input.entryType,
        input.actor.kind,
        input.actor.id,
        input.approvesEntryId,
        JSON.stringify(input.payload),
      ],
    );
    return rows[0];
  } catch (error) {
    const pgError = error as { message?: string; code?: string };
    throw new LedgerRefused(
      `ledger refused ${input.entryType} by ${input.actor.kind}:${input.actor.id} — ${pgError.message ?? 'unknown error'}`,
      pgError.code,
      { cause: error },
    );
  }
}

/**
 * Record a proposed change. Any actor may propose — that is the point: an AI
 * agent is a first-class writer here. Proposing changes nothing downstream.
 */
export function propose(
  db: Queryable,
  input: { subjectId: string; decisionKey: string; actor: Actor; payload: Record<string, unknown> },
): Promise<LedgerEntry> {
  return append(db, {
    subjectId: input.subjectId,
    decisionKey: input.decisionKey,
    entryType: 'proposal',
    actor: input.actor,
    approvesEntryId: null,
    payload: input.payload,
  });
}

/**
 * Sign off on a proposal. The database rejects this unless the actor is human
 * and is not the proposer.
 */
export function approve(
  db: Queryable,
  input: {
    subjectId: string;
    decisionKey: string;
    actor: Actor;
    proposalEntryId: string;
    payload?: Record<string, unknown>;
  },
): Promise<LedgerEntry> {
  return append(db, {
    subjectId: input.subjectId,
    decisionKey: input.decisionKey,
    entryType: 'approval',
    actor: input.actor,
    approvesEntryId: input.proposalEntryId,
    payload: input.payload ?? {},
  });
}

/** Decline a proposal. Same human-only rule as approval. */
export function reject(
  db: Queryable,
  input: {
    subjectId: string;
    decisionKey: string;
    actor: Actor;
    proposalEntryId: string;
    payload?: Record<string, unknown>;
  },
): Promise<LedgerEntry> {
  return append(db, {
    subjectId: input.subjectId,
    decisionKey: input.decisionKey,
    entryType: 'rejection',
    actor: input.actor,
    approvesEntryId: input.proposalEntryId,
    payload: input.payload ?? {},
  });
}

/**
 * Publish an approved proposal. Takes the *approval* entry id, not the
 * proposal's — there is no signature on this function that lets a caller
 * express "publish this proposal", approved or not.
 */
export function publish(
  db: Queryable,
  input: {
    subjectId: string;
    decisionKey: string;
    actor: Actor;
    approvalEntryId: string;
    payload?: Record<string, unknown>;
  },
): Promise<LedgerEntry> {
  return append(db, {
    subjectId: input.subjectId,
    decisionKey: input.decisionKey,
    entryType: 'publication',
    actor: input.actor,
    approvesEntryId: input.approvalEntryId,
    payload: input.payload ?? {},
  });
}

/** Every entry for one decision thread, oldest first. */
export async function history(db: Queryable, decisionKey: string): Promise<LedgerEntry[]> {
  const { rows } = await db.query<LedgerEntry>(
    // The sort column is qualified because the select list aliases a text cast
    // to the same name, and an unqualified sort would bind to that alias.
    `select ${SELECT_COLUMNS} from holdfast_ledger
      where decision_key = $1 order by holdfast_ledger.seq asc`,
    [decisionKey],
  );
  return rows;
}

/**
 * The published state of a subject: the payload of the proposal behind each
 * publication, newest first. Anything not published is not here.
 */
export async function publishedRevisions(
  db: Queryable,
  subjectId: string,
): Promise<Array<{ publishedAt: Date; publishedBy: string; payload: Record<string, unknown> }>> {
  const { rows } = await db.query<{
    publishedAt: Date;
    publishedBy: string;
    payload: Record<string, unknown>;
  }>(
    `select pub.recorded_at as "publishedAt",
            pub.actor_id    as "publishedBy",
            prop.payload    as payload
       from holdfast_ledger pub
       join holdfast_ledger app  on app.entry_id  = pub.approves_entry_id
       join holdfast_ledger prop on prop.entry_id = app.approves_entry_id
      where pub.entry_type = 'publication'
        and pub.subject_id = $1
      order by pub.seq desc`,
    [subjectId],
  );
  return rows;
}
