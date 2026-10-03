// One contending controller for lease-contention.test.ts. Loops: take the
// run's lease, make a few transitions around VERIFYING -> DIAGNOSING ->
// REPAIRING -> VERIFYING, sometimes stall past the lease TTL (so the other
// process takes over by expiry), release, pause briefly. Prints its counters
// as JSON. Runs under Node's strip-only TypeScript, so it imports clock.ts
// for types only.
import { writeSync } from 'node:fs';
import type { Clock } from '../../../../src/core/clock.ts';
import { isOrbitError } from '../../../../src/core/errors.ts';
import { acquireLease, getRun, releaseLease, transition } from '../../../../src/controller/run-store.ts';
import type { RunState } from '../../../../src/controller/states.ts';
import { openDb } from '../../../../src/storage/db.ts';

const [dbPath, runId, ownerId, holdsArg, ttlArg, seedArg, stallArg] = process.argv.slice(2) as [string, string, string, string, string, string, string];
const targetHolds = Number(holdsArg);
const ttlMs = Number(ttlArg);
const stallProbability = Number(stallArg);
const deadline = Date.now() + 45_000;

const clock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Deterministic per-child randomness so a failure can be replayed.
let seed = Number(seedArg) >>> 0 || 1;
const rand = (): number => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2 ** 32;
};

const NEXT: Partial<Record<RunState, RunState>> = { VERIFYING: 'DIAGNOSING', DIAGNOSING: 'REPAIRING', REPAIRING: 'VERIFYING' };
const stats = { holds: 0, transitions: 0, leaseLost: 0, conflicts: 0, stalls: 0, failedAcquires: 0 };

const db = openDb(dbPath, { busyTimeoutMs: 15_000 });
while (stats.holds < targetHolds && Date.now() < deadline) {
  if (!acquireLease(db, runId, ownerId, ttlMs, clock)) {
    stats.failedAcquires++;
    await sleep(1 + Math.floor(rand() * 4));
    continue;
  }
  stats.holds++;
  const steps = 1 + Math.floor(rand() * 4);
  for (let i = 0; i < steps; i++) {
    const run = getRun(db, runId);
    const to = NEXT[run.state];
    if (!to) throw new Error(`unexpected state ${run.state}`);
    try {
      transition(db, { runId, to, ownerId, reason: 'contend', actor: ownerId, expectedFrom: run.state }, clock);
      stats.transitions++;
    } catch (err) {
      if (isOrbitError(err, 'LEASE_LOST')) {
        stats.leaseLost++;
        break;
      }
      if (isOrbitError(err, 'CONCURRENT_UPDATE')) {
        stats.conflicts++;
        break;
      }
      throw err;
    }
    if (rand() < stallProbability) {
      stats.stalls++;
      await sleep(ttlMs + 40);
    } else {
      await sleep(Math.floor(rand() * 3));
    }
  }
  // Only deletes the row if it is still ours; a lease taken over stays with its new owner.
  releaseLease(db, runId, ownerId);
  await sleep(2 + Math.floor(rand() * 8));
}
db.close();
writeSync(1, JSON.stringify(stats));
