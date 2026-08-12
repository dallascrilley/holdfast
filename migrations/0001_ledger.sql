-- Holdfast 0001: the ledger table.
--
-- One table, one global chain. Every row is an immutable fact about a decision:
-- something was proposed, approved, rejected, or published. Rows are never
-- updated and never deleted (see 0002 for how that is enforced).

CREATE TYPE holdfast_actor_kind AS ENUM ('human', 'ai', 'system');

CREATE TYPE holdfast_entry_type AS ENUM ('proposal', 'approval', 'rejection', 'publication');

CREATE TABLE holdfast_ledger (
  seq               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entry_id          uuid        NOT NULL UNIQUE,

  -- Synthetic domain: the thing being decided about. In this reference module a
  -- subject is a release-note draft, identified by a slug.
  subject_id        text        NOT NULL,

  -- Groups the entries that belong to one decision thread.
  decision_key      text        NOT NULL,

  entry_type        holdfast_entry_type NOT NULL,
  actor_kind        holdfast_actor_kind NOT NULL,
  actor_id          text        NOT NULL,

  -- The entry this one acts on: an approval points at a proposal, a publication
  -- points at an approval. Proposals point at nothing.
  approves_entry_id uuid        REFERENCES holdfast_ledger (entry_id),

  payload           jsonb       NOT NULL DEFAULT '{}'::jsonb,

  recorded_at       timestamptz NOT NULL,

  -- Chain columns. Both are computed by the database, never by the caller.
  prev_hash         char(64)    NOT NULL,
  entry_hash        char(64)    NOT NULL UNIQUE,

  CONSTRAINT holdfast_ledger_subject_id_not_blank
    CHECK (length(btrim(subject_id)) > 0),
  CONSTRAINT holdfast_ledger_decision_key_not_blank
    CHECK (length(btrim(decision_key)) > 0),
  CONSTRAINT holdfast_ledger_actor_id_not_blank
    CHECK (length(btrim(actor_id)) > 0),
  CONSTRAINT holdfast_ledger_payload_is_object
    CHECK (jsonb_typeof(payload) = 'object'),
  CONSTRAINT holdfast_ledger_prev_hash_hex
    CHECK (prev_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT holdfast_ledger_entry_hash_hex
    CHECK (entry_hash ~ '^[a-f0-9]{64}$'),

  -- A proposal answers to nothing; every other entry type acts on an earlier entry.
  CONSTRAINT holdfast_ledger_reference_shape
    CHECK (
      (entry_type = 'proposal' AND approves_entry_id IS NULL)
      OR (entry_type <> 'proposal' AND approves_entry_id IS NOT NULL)
    ),

  -- The gate, stated as a constraint: only a human can approve, reject, or
  -- publish. A non-human actor that tries is rejected before any trigger runs.
  CONSTRAINT holdfast_ledger_human_only_transitions
    CHECK (
      entry_type = 'proposal'
      OR actor_kind = 'human'
    )
);

CREATE INDEX holdfast_ledger_decision_key_idx ON holdfast_ledger (decision_key, seq);
CREATE INDEX holdfast_ledger_subject_idx ON holdfast_ledger (subject_id, seq);
CREATE INDEX holdfast_ledger_approves_idx ON holdfast_ledger (approves_entry_id);

COMMENT ON TABLE holdfast_ledger IS
  'Append-only decision ledger. UPDATE and DELETE are blocked by trigger and revoked from the application role.';
