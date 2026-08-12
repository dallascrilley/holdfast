import { loadConfig } from '../src/config.js';
import { migrate, reset } from '../src/migrate.js';

/**
 * Runs once, before any test file. Drops everything and migrates from nothing,
 * so the suite always proves the migrations work from a cold database rather
 * than against whatever state a previous run left behind.
 */
export async function setup(): Promise<void> {
  const config = loadConfig();
  await reset(config);
  const applied = await migrate(config);
  if (applied.length === 0) {
    throw new Error('cold migration run applied nothing; the database was not actually reset');
  }
  console.log(`[holdfast tests] cold migration applied: ${applied.join(', ')}`);
}
