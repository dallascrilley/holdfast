# Contributing

Thanks for taking a look. Issues and pull requests are welcome.

## Setup

Requires Node 20+, npm, and Docker.

```bash
git clone https://github.com/dallascrilley/holdfast.git
cd holdfast
npm ci
cp .env.example .env
npm run db:up        # Postgres 16 on host port 55437 (tmpfs, throwaway)
npm test             # 36+ adversarial and concurrency proofs
```

`npm run db:down` destroys the container and its data.

## The checks CI runs

CI (`.github/workflows/ci.yml`) runs against **Postgres 16 and 17**:

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run verify
```

Run the same sequence locally before opening a pull request. Direct dependency
versions are pinned in `package.json`; the committed lockfile pins the rest.

## What a good change looks like

- **Proofs stay honest.** The suite under `test/` is the product surface. If you
  change a trigger, a grant, the gate, or the chain, update the matching tests
  and the README claim in the same change.
- **Keep admin and app identities separate.** The harness fails closed when both
  URLs resolve to the same role; do not collapse them for convenience.
- **Concurrency rules are dual-layer.** Migration `0004` serializes before the
  gate checks *and* adds partial unique indexes. Do not drop either layer without
  re-proving `test/gate-concurrency.test.ts` (including the pre-0004 failure case).
- **Migrations are append-only.** Add a new numbered file; do not rewrite an
  applied migration in place.

## Scope

This is a reference module, not a product. Prefer a focused patch over a
framework. There is no versioned package registry release.
