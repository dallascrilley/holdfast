// `pg` is CommonJS; see the note in src/migrate.ts.
import pg from 'pg';
import type { Pool } from 'pg';

const { Pool: PgPool } = pg;

import { loadConfig, type HoldfastConfig } from '../../src/config.js';

/**
 * Test harness.
 *
 * `adminPool` connects as the schema owner (superuser in docker-compose and in
 * CI). `appPool` connects as the restricted application role. The adversarial
 * tests depend on these being genuinely different principals — if they were the
 * same connection the privilege layer would be untested, so the harness asserts
 * that they are not.
 */

let config: HoldfastConfig;
let admin: Pool;
let app: Pool;

export function adminPool(): Pool {
  return admin;
}

export function appPool(): Pool {
  return app;
}

export function appRole(): string {
  return config.appRole;
}

/** Opens both connections. The schema itself is built once by test/global-setup.ts. */
export async function setupDatabase(): Promise<void> {
  config = loadConfig();
  admin = new PgPool({ connectionString: config.adminUrl });
  app = new PgPool({ connectionString: config.appUrl });

  const [adminUser, appUser] = await Promise.all([
    admin.query<{ current_user: string }>('select current_user').then((r) => r.rows[0].current_user),
    app.query<{ current_user: string }>('select current_user').then((r) => r.rows[0].current_user),
  ]);
  if (adminUser === appUser) {
    throw new Error(
      `admin and app connections use the same role (${adminUser}); the privilege layer would be untested`,
    );
  }
  if (appUser !== config.appRole) {
    throw new Error(`app connection is ${appUser}, expected ${config.appRole}`);
  }
}

export async function teardownDatabase(): Promise<void> {
  await Promise.all([admin?.end(), app?.end()]);
}

/** A fresh subject/decision pair so tests never collide on the shared ledger. */
export function newDecision(label: string): { subjectId: string; decisionKey: string } {
  const nonce = Math.random().toString(36).slice(2, 10);
  const subjectId = `release-notes/${label}-${nonce}`;
  return { subjectId, decisionKey: `${subjectId}#body` };
}

export const DRAFTING_AGENT = { id: 'drafting-agent', kind: 'ai' } as const;
export const SCHEDULER = { id: 'nightly-scheduler', kind: 'system' } as const;
export const EDITOR = { id: 'rowan.mercer', kind: 'human' } as const;
export const SECOND_EDITOR = { id: 'imani.okafor', kind: 'human' } as const;
