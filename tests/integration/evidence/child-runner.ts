/**
 * Stand-in for a controller process: runs checks for a candidate and is meant
 * to be killed mid-flight by the test. Started with the node binary directly,
 * so it uses only syntax Node can strip (no enums, no parameter properties).
 */
import { join } from 'node:path';
import { runChecks } from '../../../src/evidence/runner.ts';
import { getCandidate } from '../../../src/evidence/store.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { openDb } from '../../../src/storage/db.ts';

const [dbPath, runId, runDir, checkoutDir, candidateId, checkIds] = process.argv.slice(2) as [string, string, string, string, string, string];
const db = openDb(dbPath);
const run = db.get<{ policy_hash: string }>('SELECT policy_hash FROM runs WHERE id = ?', runId)!;
const snapshot = verifySnapshot(join(runDir, 'policy.json'), run.policy_hash);
const results = await runChecks({
  db,
  run: { id: runId, policyHash: run.policy_hash },
  candidate: getCandidate(db, candidateId),
  snapshot,
  isolation: new NoIsolation(),
  checkoutDir,
  runDir,
  clock: systemClock,
  checkIds: checkIds.split(','),
  pollMs: 20,
});
process.stdout.write(JSON.stringify(results.map((r) => r.status)));
