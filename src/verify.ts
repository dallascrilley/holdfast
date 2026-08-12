import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/**
 * Independent verification of the hash chain.
 *
 * The database computes each entry_hash on insert (migration 0002). This module
 * recomputes the same value in JavaScript, from the row data, and compares. It
 * deliberately does not call the database's own hashing function — a check that
 * asks the suspect to grade its own work proves nothing.
 *
 * Two values are read as text straight from Postgres rather than reconstructed
 * here: `payload::text` (jsonb's canonical serialisation) and the UTC timestamp
 * format. Both are stable, documented Postgres output formats; reimplementing
 * jsonb key ordering and microsecond formatting in JavaScript would introduce
 * mismatches that look like tampering.
 */

const GENESIS_HASH = '0'.repeat(64);
/** ASCII unit separator, matching Postgres chr(31) in holdfast_canonical_entry(). */
const UNIT_SEPARATOR = String.fromCharCode(31);

export type ChainFailureReason =
  | 'hash_mismatch'
  | 'broken_link'
  | 'bad_genesis'
  | 'duplicate_hash';

export interface ChainFailure {
  seq: string;
  entryId: string;
  reason: ChainFailureReason;
  detail: string;
}

export interface ChainReport {
  entriesChecked: number;
  intact: boolean;
  failures: ChainFailure[];
  headHash: string | null;
}

interface ChainRow {
  seq: string;
  entryId: string;
  subjectId: string;
  decisionKey: string;
  entryType: string;
  actorKind: string;
  actorId: string;
  approvesEntryId: string | null;
  payloadCanonical: string;
  recordedAtCanonical: string;
  prevHash: string;
  entryHash: string;
}

export function canonicalEntry(row: ChainRow, prevHash: string): string {
  return [
    prevHash,
    row.entryId,
    row.subjectId,
    row.decisionKey,
    row.entryType,
    row.actorKind,
    row.actorId,
    row.approvesEntryId ?? '',
    row.payloadCanonical,
    row.recordedAtCanonical,
  ].join(UNIT_SEPARATOR);
}

export function hashEntry(row: ChainRow, prevHash: string): string {
  return createHash('sha256').update(canonicalEntry(row, prevHash), 'utf8').digest('hex');
}

export async function verifyChain(db: Pool | PoolClient): Promise<ChainReport> {
  const { rows } = await db.query<ChainRow>(`
    select seq::text          as "seq",
           entry_id           as "entryId",
           subject_id         as "subjectId",
           decision_key       as "decisionKey",
           entry_type::text   as "entryType",
           actor_kind::text   as "actorKind",
           actor_id           as "actorId",
           approves_entry_id  as "approvesEntryId",
           payload::text      as "payloadCanonical",
           to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                              as "recordedAtCanonical",
           prev_hash          as "prevHash",
           entry_hash         as "entryHash"
      from holdfast_ledger
     -- Qualified deliberately: an unqualified seq would bind to the text output
     -- alias above and sort the chain lexicographically (1, 10, 2, ...).
     order by holdfast_ledger.seq asc
  `);

  const failures: ChainFailure[] = [];
  const seen = new Map<string, string>();
  let expectedPrev = GENESIS_HASH;

  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      failures.push({
        seq: row.seq,
        entryId: row.entryId,
        reason: expectedPrev === GENESIS_HASH ? 'bad_genesis' : 'broken_link',
        detail: `prev_hash is ${row.prevHash}, expected ${expectedPrev}`,
      });
    }

    const recomputed = hashEntry(row, row.prevHash);
    if (recomputed !== row.entryHash) {
      failures.push({
        seq: row.seq,
        entryId: row.entryId,
        reason: 'hash_mismatch',
        detail: `stored entry_hash ${row.entryHash} does not match recomputed ${recomputed}; the row's contents changed after it was written`,
      });
    }

    const priorSeq = seen.get(row.entryHash);
    if (priorSeq !== undefined) {
      failures.push({
        seq: row.seq,
        entryId: row.entryId,
        reason: 'duplicate_hash',
        detail: `entry_hash also appears at seq ${priorSeq}`,
      });
    }
    seen.set(row.entryHash, row.seq);

    expectedPrev = row.entryHash;
  }

  return {
    entriesChecked: rows.length,
    intact: failures.length === 0,
    failures,
    headHash: rows.length > 0 ? rows[rows.length - 1].entryHash : null,
  };
}
