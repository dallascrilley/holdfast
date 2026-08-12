import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
// `pg` is CommonJS, so a named import is not statically resolvable from an ES
// module. Default-import the namespace and destructure at runtime.
import pg from 'pg';

const { Client } = pg;

import { loadConfig, type HoldfastConfig } from './config.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function quoteIdent(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function substitute(sql: string, config: HoldfastConfig, dbName: string): string {
  return sql
    .replaceAll('{{app_role_literal}}', quoteLiteral(config.appRole))
    .replaceAll('{{app_password_literal}}', quoteLiteral(config.appPassword))
    .replaceAll('{{app_role}}', quoteIdent(config.appRole))
    .replaceAll('{{db_name}}', quoteIdent(dbName));
}

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
}

/**
 * Applies every migration that has not been applied yet, in filename order.
 * Each migration runs in its own transaction, so a failure leaves the schema at
 * the last complete migration rather than half-applied.
 */
export async function migrate(config: HoldfastConfig = loadConfig()): Promise<string[]> {
  const client = new Client({ connectionString: config.adminUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    const { rows } = await client.query<{ current_database: string }>('select current_database()');
    const dbName = rows[0].current_database;

    await client.query(`
      create table if not exists holdfast_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )
    `);

    const done = new Set(
      (await client.query<{ name: string }>('select name from holdfast_migrations')).rows.map(
        (row) => row.name,
      ),
    );

    for (const name of migrationFiles()) {
      if (done.has(name)) continue;
      const sql = substitute(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'), config, dbName);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into holdfast_migrations (name) values ($1)', [name]);
        await client.query('commit');
      } catch (error) {
        await client.query('rollback');
        throw new Error(`migration ${name} failed: ${(error as Error).message}`, { cause: error });
      }
      applied.push(name);
    }
  } finally {
    await client.end();
  }
  return applied;
}

/**
 * Drops everything this module owns. Used by the test harness to guarantee a
 * cold start; never wired into the application entrypoints.
 */
export async function reset(config: HoldfastConfig = loadConfig()): Promise<void> {
  const client = new Client({ connectionString: config.adminUrl });
  await client.connect();
  try {
    await client.query(`
      drop table if exists holdfast_ledger cascade;
      drop table if exists holdfast_migrations cascade;
      drop function if exists holdfast_block_mutation() cascade;
      drop function if exists holdfast_serialize_append() cascade;
      drop function if exists holdfast_chain_entry() cascade;
      drop function if exists holdfast_enforce_gate() cascade;
      drop function if exists holdfast_genesis_hash() cascade;
      drop function if exists holdfast_canonical_entry(
        char(64), uuid, text, text, holdfast_entry_type, holdfast_actor_kind, text, uuid, jsonb, timestamptz
      ) cascade;
      drop type if exists holdfast_entry_type cascade;
      drop type if exists holdfast_actor_kind cascade;
    `);
  } finally {
    await client.end();
  }
}
