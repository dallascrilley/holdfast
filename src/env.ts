import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal .env loader — enough for `KEY=value` lines, and nothing more.
 *
 * A real dependency would work too; this exists so the module has exactly one
 * runtime dependency (`pg`) and a reader can audit the whole thing in a sitting.
 * Values already present in the environment always win, so CI (which sets real
 * environment variables and ships no .env file) is unaffected.
 */

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '.env');

let loaded = false;

export function loadDotEnv(path: string = ENV_PATH): void {
  if (loaded || !existsSync(path)) {
    loaded = true;
    return;
  }
  loaded = true;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    if (key === '' || process.env[key] !== undefined) continue;
    process.env[key] = trimmed.slice(separator + 1).trim();
  }
}
