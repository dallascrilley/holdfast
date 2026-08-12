-- Holdfast 0003: the application role.
--
-- The triggers in 0002 stop anyone from rewriting history. This migration is the
-- second, independent layer: the role the application connects as is never
-- granted UPDATE, DELETE, or TRUNCATE in the first place, so those statements
-- fail on privilege check before a trigger is ever consulted.
--
-- Two layers because they fail in different situations. A superuser can
-- ALTER TABLE ... DISABLE TRIGGER; the grant still holds. A role could in
-- principle be over-granted by a later migration; the trigger still holds.
--
-- {{app_role}}, {{app_role_literal}}, {{app_password_literal}} and {{db_name}}
-- are substituted by the migration runner (src/migrate.ts), which quotes
-- identifiers and escapes literals before substitution.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = {{app_role_literal}}) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', {{app_role_literal}}, {{app_password_literal}});
  ELSE
    EXECUTE format('ALTER ROLE %I LOGIN PASSWORD %L', {{app_role_literal}}, {{app_password_literal}});
  END IF;
END;
$$;

GRANT CONNECT ON DATABASE {{db_name}} TO {{app_role}};
GRANT USAGE ON SCHEMA public TO {{app_role}};

-- Nobody gets a blanket grant.
REVOKE ALL ON holdfast_ledger FROM PUBLIC;
REVOKE ALL ON holdfast_ledger FROM {{app_role}};

-- The application may read the ledger and append to it. That is the whole
-- surface. Note there is no UPDATE, no DELETE, no TRUNCATE.
GRANT SELECT, INSERT ON holdfast_ledger TO {{app_role}};

-- Stated again explicitly, so the intent survives review of a future migration
-- that reaches for GRANT ALL.
REVOKE UPDATE, DELETE, TRUNCATE ON holdfast_ledger FROM {{app_role}};

GRANT EXECUTE ON FUNCTION holdfast_canonical_entry(
  char(64), uuid, text, text, holdfast_entry_type, holdfast_actor_kind, text, uuid, jsonb, timestamptz
) TO {{app_role}};
GRANT EXECUTE ON FUNCTION holdfast_genesis_hash() TO {{app_role}};
