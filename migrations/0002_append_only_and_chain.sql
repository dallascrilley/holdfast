-- Holdfast 0002: append-only enforcement, the hash chain, and the publish gate.
--
-- Three separate mechanisms, all in the database:
--
--   1. holdfast_block_mutation()  -- UPDATE/DELETE/TRUNCATE raise, for every role
--   2. holdfast_chain_entry()     -- the database computes prev_hash/entry_hash
--   3. holdfast_enforce_gate()    -- approval/publication preconditions
--
-- None of these live in application code, so no application bug and no direct
-- psql session can route around them.

-- ---------------------------------------------------------------------------
-- 1. Append-only
-- ---------------------------------------------------------------------------

CREATE FUNCTION holdfast_block_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'holdfast_ledger is append-only: % is not permitted', TG_OP
    USING ERRCODE = 'restrict_violation',
          HINT = 'Record a new entry instead of changing an existing one.';
END;
$$;

CREATE TRIGGER holdfast_ledger_block_update
  BEFORE UPDATE ON holdfast_ledger
  FOR EACH ROW EXECUTE FUNCTION holdfast_block_mutation();

CREATE TRIGGER holdfast_ledger_block_delete
  BEFORE DELETE ON holdfast_ledger
  FOR EACH ROW EXECUTE FUNCTION holdfast_block_mutation();

CREATE TRIGGER holdfast_ledger_block_truncate
  BEFORE TRUNCATE ON holdfast_ledger
  FOR EACH STATEMENT EXECUTE FUNCTION holdfast_block_mutation();

-- ---------------------------------------------------------------------------
-- 2. Hash chain
-- ---------------------------------------------------------------------------

-- The exact byte string that gets hashed. Kept as its own function so the
-- verifier's independent reimplementation has a single spec to match.
CREATE FUNCTION holdfast_canonical_entry(
  p_prev_hash         char(64),
  p_entry_id          uuid,
  p_subject_id        text,
  p_decision_key      text,
  p_entry_type        holdfast_entry_type,
  p_actor_kind        holdfast_actor_kind,
  p_actor_id          text,
  p_approves_entry_id uuid,
  p_payload           jsonb,
  p_recorded_at       timestamptz
) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws(
    chr(31),
    p_prev_hash,
    p_entry_id::text,
    p_subject_id,
    p_decision_key,
    p_entry_type::text,
    p_actor_kind::text,
    p_actor_id,
    coalesce(p_approves_entry_id::text, ''),
    p_payload::text,
    to_char(p_recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  );
$$;

-- Genesis link for the first entry in the chain.
CREATE FUNCTION holdfast_genesis_hash() RETURNS char(64)
LANGUAGE sql IMMUTABLE AS $$ SELECT repeat('0', 64)::char(64) $$;

CREATE FUNCTION holdfast_chain_entry() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_prev char(64);
BEGIN
  -- Serialize appends so two concurrent writers cannot both chain off the same
  -- tip and produce a fork.
  PERFORM pg_advisory_xact_lock(4021559431);

  SELECT entry_hash INTO v_prev
  FROM holdfast_ledger
  ORDER BY seq DESC
  LIMIT 1;

  NEW.prev_hash := coalesce(v_prev, holdfast_genesis_hash());

  -- The caller does not get to choose these. Whatever was supplied is discarded.
  NEW.recorded_at := now();
  NEW.entry_hash := encode(
    sha256(
      convert_to(
        holdfast_canonical_entry(
          NEW.prev_hash, NEW.entry_id, NEW.subject_id, NEW.decision_key,
          NEW.entry_type, NEW.actor_kind, NEW.actor_id, NEW.approves_entry_id,
          NEW.payload, NEW.recorded_at
        ),
        'UTF8'
      )
    ),
    'hex'
  );

  RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. Publish gate
-- ---------------------------------------------------------------------------

CREATE FUNCTION holdfast_enforce_gate() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_target holdfast_ledger%ROWTYPE;
BEGIN
  IF NEW.entry_type = 'proposal' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_target
  FROM holdfast_ledger
  WHERE entry_id = NEW.approves_entry_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'holdfast gate: referenced entry % does not exist', NEW.approves_entry_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF v_target.subject_id <> NEW.subject_id OR v_target.decision_key <> NEW.decision_key THEN
    RAISE EXCEPTION 'holdfast gate: entry references a different decision (% / %)',
      v_target.subject_id, v_target.decision_key
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.entry_type IN ('approval', 'rejection') THEN
    IF v_target.entry_type <> 'proposal' THEN
      RAISE EXCEPTION 'holdfast gate: % must reference a proposal, got %',
        NEW.entry_type, v_target.entry_type
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- Four eyes: whoever proposed cannot be the one who signs off.
    IF v_target.actor_id = NEW.actor_id THEN
      RAISE EXCEPTION 'holdfast gate: actor % cannot % its own proposal',
        NEW.actor_id, NEW.entry_type
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF EXISTS (
      SELECT 1 FROM holdfast_ledger
      WHERE approves_entry_id = v_target.entry_id
        AND entry_type IN ('approval', 'rejection')
    ) THEN
      RAISE EXCEPTION 'holdfast gate: proposal % is already decided', v_target.entry_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.entry_type = 'publication' THEN
    -- A publication may only ever point at an approval. There is no path that
    -- publishes a bare proposal.
    IF v_target.entry_type <> 'approval' THEN
      RAISE EXCEPTION 'holdfast gate: publication must reference an approval, got %',
        v_target.entry_type
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF v_target.actor_kind <> 'human' THEN
      RAISE EXCEPTION 'holdfast gate: approval % was not human-attributed', v_target.entry_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    IF EXISTS (
      SELECT 1 FROM holdfast_ledger
      WHERE approves_entry_id = v_target.entry_id
        AND entry_type = 'publication'
    ) THEN
      RAISE EXCEPTION 'holdfast gate: approval % is already published', v_target.entry_id
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'holdfast gate: unhandled entry type %', NEW.entry_type
    USING ERRCODE = 'restrict_violation';
END;
$$;

-- Triggers fire in name order: gate first, then chain, so a rejected entry
-- never consumes a chain position.
CREATE TRIGGER holdfast_ledger_10_gate
  BEFORE INSERT ON holdfast_ledger
  FOR EACH ROW EXECUTE FUNCTION holdfast_enforce_gate();

CREATE TRIGGER holdfast_ledger_20_chain
  BEFORE INSERT ON holdfast_ledger
  FOR EACH ROW EXECUTE FUNCTION holdfast_chain_entry();
