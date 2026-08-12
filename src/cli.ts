/**
 * holdfast <command>
 *
 *   migrate   apply pending migrations (connects as the admin role)
 *   verify    walk the hash chain and report any tampering
 *   demo      append a synthetic proposal/approval/publication and print the chain
 */

import { Pool } from 'pg';

import { loadConfig } from './config.js';
import { migrate } from './migrate.js';
import { approve, history, propose, publish } from './ledger.js';
import { verifyChain } from './verify.js';

async function withAppPool<T>(fn: (pool: Pool) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: loadConfig().appUrl });
  try {
    return await fn(pool);
  } finally {
    await pool.end();
  }
}

async function runMigrate(): Promise<number> {
  const applied = await migrate();
  if (applied.length === 0) {
    console.log('holdfast: schema already current');
  } else {
    for (const name of applied) console.log(`holdfast: applied ${name}`);
  }
  return 0;
}

async function runVerify(): Promise<number> {
  return withAppPool(async (pool) => {
    const report = await verifyChain(pool);
    console.log(`holdfast: checked ${report.entriesChecked} entries`);
    if (report.intact) {
      console.log(`holdfast: chain intact, head ${report.headHash ?? '(empty ledger)'}`);
      return 0;
    }
    console.error(`holdfast: chain BROKEN — ${report.failures.length} failure(s)`);
    for (const failure of report.failures) {
      console.error(`  seq ${failure.seq} [${failure.reason}] ${failure.detail}`);
    }
    return 1;
  });
}

async function runDemo(): Promise<number> {
  return withAppPool(async (pool) => {
    const subjectId = `release-notes/v${Date.now()}`;
    const decisionKey = `${subjectId}#headline`;

    const proposal = await propose(pool, {
      subjectId,
      decisionKey,
      actor: { id: 'drafting-agent', kind: 'ai' },
      payload: { headline: 'Chain verification is now a first-class command' },
    });
    console.log(`proposed   ${proposal.entryId} by ai:${proposal.actorId}`);

    const approval = await approve(pool, {
      subjectId,
      decisionKey,
      actor: { id: 'rowan.mercer', kind: 'human' },
      proposalEntryId: proposal.entryId,
    });
    console.log(`approved   ${approval.entryId} by human:${approval.actorId}`);

    const publication = await publish(pool, {
      subjectId,
      decisionKey,
      actor: { id: 'rowan.mercer', kind: 'human' },
      approvalEntryId: approval.entryId,
    });
    console.log(`published  ${publication.entryId} by human:${publication.actorId}`);

    console.log('\nchain for this decision:');
    for (const entry of await history(pool, decisionKey)) {
      console.log(`  ${entry.seq}  ${entry.entryType.padEnd(11)} ${entry.entryHash.slice(0, 16)}…`);
    }
    return 0;
  });
}

const commands: Record<string, () => Promise<number>> = {
  migrate: runMigrate,
  verify: runVerify,
  demo: runDemo,
};

const command = process.argv[2];
const handler = command ? commands[command] : undefined;

if (!handler) {
  console.error(`usage: holdfast <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}

handler()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`holdfast: ${(error as Error).message}`);
    process.exit(1);
  });
