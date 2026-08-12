/**
 * Connection settings.
 *
 * Two URLs on purpose. `HOLDFAST_ADMIN_URL` owns the schema and is the only one
 * that can run migrations. `HOLDFAST_APP_URL` is what the application uses, and
 * it connects as a role with no UPDATE, DELETE, or TRUNCATE on the ledger.
 * Handing the admin URL to application code defeats the second enforcement
 * layer, so they are kept apart from the very first line of the module.
 */

import { loadDotEnv } from './env.js';

export interface HoldfastConfig {
  adminUrl: string;
  appUrl: string;
  appRole: string;
  appPassword: string;
}

const DEFAULT_APP_ROLE = 'holdfast_app';

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) {
    throw new Error(
      `${name} is not set. See README "Quickstart" — docker compose up -d, then copy .env.example to .env.`,
    );
  }
  return value;
}

export function loadConfig(): HoldfastConfig {
  loadDotEnv();
  const appRole = process.env.HOLDFAST_APP_ROLE ?? DEFAULT_APP_ROLE;
  if (!/^[a-z_][a-z0-9_]*$/.test(appRole)) {
    throw new Error(`HOLDFAST_APP_ROLE must be a plain lowercase identifier, got ${appRole}`);
  }
  return {
    adminUrl: required('HOLDFAST_ADMIN_URL'),
    appUrl: required('HOLDFAST_APP_URL'),
    appRole,
    appPassword: required('HOLDFAST_APP_PASSWORD'),
  };
}
