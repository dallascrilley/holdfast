# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities privately through
[GitHub Security Advisories](https://github.com/dallascrilley/holdfast/security/advisories/new),
or by email to dallas@dallascrilley.com. Please do not open a public issue for
a security problem.

Include the affected commit, what you believe the impact is, and steps to
reproduce it. I aim to acknowledge within seven days and to say whether the
report is accepted, with a rough timeline for a fix.

## Supported versions

This project is pre-1.0 and single-branch. Only `main` receives security fixes.

## What this repository is

Holdfast is a reference module: an append-only decision ledger with a human
approval gate enforced in Postgres. It is deliberately small enough to read end
to end. There is no hosted service and no published npm package
(`"private": true`).

## Trust boundary (short)

| Layer | What it does |
| --- | --- |
| Mutation triggers | `UPDATE` / `DELETE` / `TRUNCATE` raise for every role, including the table owner |
| App role grants | `holdfast_app` has `SELECT, INSERT` only — no `UPDATE`/`DELETE`/`TRUNCATE` |
| Publish gate | Approvals/publications require a human actor and valid references; uniqueness is concurrency-safe (migration `0004`) |
| Hash chain | `prev_hash` / `entry_hash` computed in the database; `npm run verify` recomputes in JavaScript |

The full list of deliberate non-claims — tamper-*evidence* not proof, superuser
full rewrite, `actor_kind` as assertion not authentication, and the need for an
external head anchor — is in [README.md](README.md) under **Honest boundaries**.
Read that section before treating the chain as a security control.

## Credentials

`.env.example` and docker-compose use throwaway local passwords. The app role
password is substituted into migration `0003` by the migrator from
`HOLDFAST_APP_PASSWORD` — do not reuse those defaults on a shared or long-lived
cluster. `HOLDFAST_ADMIN_URL` must never be handed to application request paths.
