-- Holdfast 0004: make the gate's uniqueness rules concurrency-safe.
--
-- The gate trigger (name order 10) ran its EXISTS checks before the chain
-- trigger (name order 20) took the advisory lock. Under READ COMMITTED, a
-- second writer's gate check runs while the first writer's row is still
-- uncommitted and invisible, then merely queues on the advisory lock and
-- inserts anyway: the same approval could be published twice, and a proposal
-- rejected in one session could be approved concurrently in another.
--
-- Two independent layers close it:
--
--   1. Serialize BEFORE checking. A trigger that sorts before the gate takes
--      the same advisory xact lock the chain trigger uses. A blocked writer
--      resumes after the earlier transaction commits, and in READ COMMITTED
--      the gate's checks (each statement takes a fresh snapshot inside a
--      volatile function) then see the committed row.
--   2. Unique partial indexes. Snapshot-independent, so the invariants hold
--      even under REPEATABLE READ / SERIALIZABLE, where layer 1's re-check
--      would still read the transaction's old snapshot.

CREATE FUNCTION holdfast_serialize_append() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  -- Same lock key as holdfast_chain_entry(); advisory xact locks are
  -- re-entrant within a transaction, so the chain trigger's own call is a
  -- no-op after this one.
  PERFORM pg_advisory_xact_lock(4021559431);
  RETURN NEW;
END;
$$;

CREATE TRIGGER holdfast_ledger_00_serialize
  BEFORE INSERT ON holdfast_ledger
  FOR EACH ROW EXECUTE FUNCTION holdfast_serialize_append();

-- A proposal is decided at most once, ever.
CREATE UNIQUE INDEX holdfast_one_decision_per_proposal
  ON holdfast_ledger (approves_entry_id)
  WHERE entry_type IN ('approval', 'rejection');

-- An approval is published at most once, ever.
CREATE UNIQUE INDEX holdfast_one_publication_per_approval
  ON holdfast_ledger (approves_entry_id)
  WHERE entry_type = 'publication';
