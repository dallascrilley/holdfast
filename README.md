# Holdfast

**An append-only decision ledger with a human approval gate: AI can propose, only a person can publish.**

Holdfast is a small Postgres-backed module for systems where an automated agent
drafts changes and a person decides whether they ship. It records every step —
proposal, approval, rejection, publication — as an immutable ledger entry linked
into a hash chain, and it enforces both the immutability and the approval gate in
the database rather than in application code.

---

## Where this came from, and what changed

This is an extract. The original pattern — a revision-keyed edit-decision ledger
with a reviewer-attributed approval step — was built inside a private production
system and is not published. Holdfast rebuilds the pattern around a synthetic
domain (release-note drafts) with fresh history, no client data, and no
production configuration.

The honest part matters more than the lineage. An audit of the original found
that its append-only guarantee was a convention, not a mechanism:

| | Original | Holdfast |
|---|---|---|
| Trigger blocking `UPDATE`/`DELETE` | none | `holdfast_block_mutation()` on UPDATE, DELETE and TRUNCATE |
| `REVOKE UPDATE, DELETE` from the app role | none — no `REVOKE` or `GRANT` statement in any of its 25 migrations | migration `0003`, plus a test asserting the role holds only `SELECT, INSERT` |
| Hash chain linking entries | none — per-row content hashes only, no `prev_hash` anywhere in the codebase | `prev_hash` / `entry_hash`, computed by the database, verified independently in JavaScript |
| Adversarial mutation test | none; two of its own code paths issue `delete from` against the ledger table | 14 tests that attack the ledger and assert failure |
| Publish gate | enforced in application code | enforced by a `CHECK` constraint and a `BEFORE INSERT` trigger |

So: the ledger *shape* is extracted. **The enforcement and the hash chain are new
work written for this repository** — they did not exist upstream, and the
upstream system's "append-only" description was not backed by anything the
database would refuse.

---

## Quickstart

Verbatim, from a clean checkout. Requires Docker and Node 20+.

```
git clone <this repo> && cd holdfast
npm install
cp .env.example .env
npm run db:up        # postgres 16 on port 55437, tmpfs, throwaway
npm test
```

```
> holdfast@0.1.0 test
> vitest run

 RUN  v2.1.8

[holdfast tests] cold migration applied: 0001_ledger.sql, 0002_append_only_and_chain.sql, 0003_app_role.sql, 0004_gate_concurrency.sql
 ✓ test/publish-gate.test.ts (12 tests) 151ms
 ✓ test/append-only-adversarial.test.ts (14 tests) 113ms
 ✓ test/chain.test.ts (8 tests) 72ms
 ✓ test/gate-concurrency.test.ts (2 tests) 659ms

 Test Files  4 passed (4)
      Tests  36 passed (36)
```

Then:

```
npm run demo         # append a proposal, an approval and a publication
npm run verify       # walk the chain and report tampering
```

```
proposed   743e80bd-a72d-40bb-ae9f-8884cb99ecdd by ai:drafting-agent
approved   bbc109e6-bb79-4fd4-9bb2-ee7c665c4d0a by human:rowan.mercer
published  a8d21c7b-d223-4208-8db8-d5d0e534f570 by human:rowan.mercer

chain for this decision:
  67  proposal    438ef7ba1d69332b…
  68  approval    0e7950225e5a172c…
  69  publication 1484854e2a440e0d…
```

```
holdfast: checked 54 entries
holdfast: chain intact, head 1484854e2a440e0d860324eb3732f867a0d4f88b15b6fd338280708bd54798f6
```

`npm run db:down` destroys the database.

---

## Proof

Claims about immutability are cheap. These are the transcripts.

### The ledger refuses to be rewritten

Connected as `holdfast_app`, the role the application uses — it was never granted
`UPDATE` or `DELETE`, so the statement dies on privilege check:

```
$ psql "postgres://holdfast_app:holdfast_app_local@127.0.0.1:55437/holdfast" \
    -c "update holdfast_ledger set payload='{}'::jsonb;" \
    -c "delete from holdfast_ledger;"
ERROR:  permission denied for table holdfast_ledger
ERROR:  permission denied for table holdfast_ledger
```

Connected as `holdfast_admin`, which **owns** the table and therefore bypasses its
own grants entirely — this is the case a `REVOKE`-only design misses:

```
$ psql "postgres://holdfast_admin:holdfast_admin_local@127.0.0.1:55437/holdfast" \
    -c "update holdfast_ledger set payload='{}'::jsonb;"
ERROR:  holdfast_ledger is append-only: UPDATE is not permitted
HINT:  Record a new entry instead of changing an existing one.
CONTEXT:  PL/pgSQL function holdfast_block_mutation() line 3 at RAISE

$ psql "postgres://holdfast_admin:holdfast_admin_local@127.0.0.1:55437/holdfast" \
    -c "delete from holdfast_ledger;"
ERROR:  holdfast_ledger is append-only: DELETE is not permitted
HINT:  Record a new entry instead of changing an existing one.
CONTEXT:  PL/pgSQL function holdfast_block_mutation() line 3 at RAISE
```

Two layers, failing for two different reasons, covering two different attackers.

### The AI actor cannot publish

An AI actor proposes a change; a human approves it. The AI then tries to publish
its own approved proposal with raw SQL, as the application role:

```
-- AI tries to publish the human-approved proposal:
ERROR:  new row for relation "holdfast_ledger" violates check constraint "holdfast_ledger_human_only_transitions"
DETAIL:  Failing row contains (63, a5da72d6-…, release-notes/demo, release-notes/demo#body,
         publication, ai, drafting-agent, 22222222-…, {}, 2026-08-12 13:53:55.888956+00, …).

-- AI tries to skip approval entirely:
ERROR:  holdfast gate: publication must reference an approval, got proposal
CONTEXT:  PL/pgSQL function holdfast_enforce_gate() line 54 at RAISE
```

### The full adversarial suite

Every line below is an attack that is asserted to fail (or an invariant asserted
to hold), run against a cold Postgres 16:

```
 ✓ test/publish-gate.test.ts > the happy path > an AI proposes, a human approves, a human publishes
 ✓ test/publish-gate.test.ts > a non-human actor cannot cross the gate > the AI actor cannot approve its own proposal
 ✓ test/publish-gate.test.ts > a non-human actor cannot cross the gate > the AI actor cannot approve someone else’s proposal either
 ✓ test/publish-gate.test.ts > a non-human actor cannot cross the gate > a system actor cannot approve
 ✓ test/publish-gate.test.ts > a non-human actor cannot cross the gate > the AI actor cannot publish an approval a human granted
 ✓ test/publish-gate.test.ts > a non-human actor cannot cross the gate > raw SQL does not help: the AI actor is refused at the database
 ✓ test/publish-gate.test.ts > publication requires a real, distinct human approval > cannot publish a proposal that was never approved
 ✓ test/publish-gate.test.ts > publication requires a real, distinct human approval > a human cannot approve their own proposal
 ✓ test/publish-gate.test.ts > publication requires a real, distinct human approval > cannot publish a rejected proposal
 ✓ test/publish-gate.test.ts > publication requires a real, distinct human approval > cannot publish the same approval twice
 ✓ test/publish-gate.test.ts > publication requires a real, distinct human approval > cannot borrow an approval from a different decision
 ✓ test/publish-gate.test.ts > publication requires a real, distinct human approval > cannot reference an entry that does not exist
 ✓ test/append-only-adversarial.test.ts > raw SQL as the application role > cannot UPDATE a ledger row
 ✓ test/append-only-adversarial.test.ts > raw SQL as the application role > cannot DELETE a ledger row
 ✓ test/append-only-adversarial.test.ts > raw SQL as the application role > cannot TRUNCATE the ledger
 ✓ test/append-only-adversarial.test.ts > raw SQL as the application role > cannot UPDATE with a WHERE clause that matches nothing either
 ✓ test/append-only-adversarial.test.ts > raw SQL as the application role > cannot grant itself the missing privileges
 ✓ test/append-only-adversarial.test.ts > raw SQL as the application role > cannot disable the append-only triggers
 ✓ test/append-only-adversarial.test.ts > raw SQL as the application role > still has the privileges it is supposed to have
 ✓ test/append-only-adversarial.test.ts > the trigger layer, tested independently of privileges > refuses UPDATE even for the schema owner
 ✓ test/append-only-adversarial.test.ts > the trigger layer, tested independently of privileges > refuses DELETE even for the schema owner
 ✓ test/append-only-adversarial.test.ts > the trigger layer, tested independently of privileges > refuses TRUNCATE even for the schema owner
 ✓ test/append-only-adversarial.test.ts > the trigger layer, tested independently of privileges > leaves the row exactly as it was written
 ✓ test/append-only-adversarial.test.ts > the application layer offers no mutation path > exports no update or delete function
 ✓ test/append-only-adversarial.test.ts > the application layer offers no mutation path > inserting a duplicate entry_id is refused rather than silently upserting
 ✓ test/append-only-adversarial.test.ts > the application layer offers no mutation path > cannot supply its own hash values
 ✓ test/chain.test.ts > an untampered chain > verifies clean and links every entry to its predecessor
 ✓ test/chain.test.ts > an untampered chain > starts from the all-zero genesis hash
 ✓ test/chain.test.ts > an untampered chain > each entry carries the previous entry hash
 ✓ test/chain.test.ts > tampering behind the triggers > an edited payload is detected as a hash mismatch
 ✓ test/chain.test.ts > tampering behind the triggers > a changed actor is detected — attribution is inside the hash
 ✓ test/chain.test.ts > tampering behind the triggers > a removed entry is detected as a broken link
 ✓ test/chain.test.ts > tampering behind the triggers > recomputing the hash to cover the edit still breaks the next link
 ✓ test/chain.test.ts > the verifier does not trust the database to grade itself > recomputes hashes in JavaScript, so a corrupted stored hash is caught
 ✓ test/gate-concurrency.test.ts > the gate under concurrency > the same approval cannot be published twice by racing sessions 324ms
 ✓ test/gate-concurrency.test.ts > the gate under concurrency > a proposal being rejected cannot be concurrently approved 314ms
```

The tamper tests get behind the triggers the only way anyone can — the schema
owner disables them — then rewrite rows and assert that `verifyChain` notices.
Each runs inside a transaction that is rolled back, so the attack is real but the
damage is not.

---

## How it works

### The ledger

One table, `holdfast_ledger`. Every row is a fact:

| entry_type | who may write it | points at |
|---|---|---|
| `proposal` | any actor, including `ai` and `system` | nothing |
| `approval` | a `human`, not the proposer | the proposal |
| `rejection` | a `human`, not the proposer | the proposal |
| `publication` | a `human` | **the approval**, never the proposal |

The last row of that table is the whole gate. `publish()` takes an *approval*
entry id. There is no function signature, and no valid row shape, that expresses
"publish this proposal" without a human approval sitting in between.

### Three enforcement mechanisms

1. **`holdfast_block_mutation()`** — `BEFORE UPDATE`, `BEFORE DELETE` and
   `BEFORE TRUNCATE` triggers that raise. Applies to every role, including the
   table owner.
2. **`REVOKE UPDATE, DELETE, TRUNCATE`** from the application role, which is
   granted `SELECT, INSERT` and nothing else. Survives a trigger being disabled.
3. **`holdfast_enforce_gate()`** plus the `holdfast_ledger_human_only_transitions`
   check constraint — approval, rejection and publication require `actor_kind =
   'human'`, an approval cannot come from the proposer, a publication must
   reference a human approval of the same decision, and neither can happen twice.
   The "happens once" rules survive concurrency two independent ways: every
   append takes the chain's advisory lock *before* the gate's checks run, and
   two partial unique indexes enforce one decision per proposal and one
   publication per approval even under snapshot isolation.

### The hash chain

Each entry stores `prev_hash` (the previous entry's hash) and `entry_hash`
(SHA-256 over this entry's fields, including `prev_hash`). Both are computed by
a `BEFORE INSERT` trigger inside the database — an application cannot supply
them, and a test asserts that supplying them is ignored.

`npm run verify` walks the chain and recomputes every hash **in JavaScript**,
from the row data, rather than calling the database's own hash function. A check
that asks the suspect to grade its own work proves nothing.

An attacker who edits a row is caught by a hash mismatch. An attacker who edits a
row *and* repairs that row's hash is caught by the next entry's `prev_hash` no
longer matching — that case has its own test.

---

## Honest boundaries

Things Holdfast does not do. Read this section as carefully as the proof section.

- **The chain is tamper-evident, not tamper-proof.** It detects edits after the
  fact. It does not prevent someone with superuser rights from disabling the
  triggers, and it never claims to.
- **A full rewrite is only caught if you anchor the head.** An attacker with
  superuser rights who rewrites *every* entry from the tampered row forward
  produces an internally consistent chain. Detecting that requires comparing the
  head hash against a copy held somewhere Holdfast does not control — an
  append-only log store, another database, a printout. Holdfast does not ship
  that anchoring, and without it the chain protects against partial tampering
  only.
- **"Human" is an assertion, not an authentication.** `actor_kind = 'human'` is
  whatever the calling application says it is. Holdfast enforces that the
  *recorded* approver is human and distinct from the proposer; it cannot tell you
  that a real person was actually at the keyboard. Bind `actor_id` to your own
  authenticated session, and treat any service that can set `actor_kind` freely
  as trusted.
- **It protects the ledger, not the world.** Holdfast records that a publication
  was authorised. Whatever your system does when it sees a `publication` entry is
  outside this module, and nothing here stops code from acting on an unpublished
  proposal if you write it that way.
- **Migrations require an owner connection.** Migration `0003` creates a role and
  issues grants, so `HOLDFAST_ADMIN_URL` must be a superuser or role-creating
  user. Handing that URL to application code silently removes the second
  enforcement layer. The test harness refuses to run if the two connections
  resolve to the same role.
- **Single chain, serialised appends.** Every insert takes one advisory lock, so
  writes are globally ordered. That is correct, and it is a throughput ceiling.
  Sharding the chain per subject would lift it and weaken cross-subject ordering.
- **Verified on Postgres 16 and 17 only.** CI runs both. The triggers use
  `sha256()`, built in since Postgres 11; nothing older has been tried.
- **This is a reference module, not a library.** It is deliberately small enough
  to read end to end. There is no versioned package, no migration framework
  integration, and no retention or archival story.

---

## Layout

```
migrations/0001_ledger.sql              table, enums, constraints
migrations/0002_append_only_and_chain.sql   triggers: block mutation, chain, gate
migrations/0003_app_role.sql            the restricted application role
migrations/0004_gate_concurrency.sql    serialize-before-check + unique indexes
src/ledger.ts     propose / approve / reject / publish / history
src/verify.ts     independent JavaScript chain verification
src/migrate.ts    migration runner and cold reset
src/cli.ts        holdfast migrate | verify | demo
src/config.ts     connection URLs and role names from the environment
src/env.ts        dotenv-free .env loader
src/index.ts      library entrypoint
test/             the adversarial suite
```

## License

MIT. Copyright (c) 2026 Dallas Crilley.
