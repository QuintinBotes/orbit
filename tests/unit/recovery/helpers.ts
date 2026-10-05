import { ManualClock } from '../../../src/core/clock.ts';
import type { RunState } from '../../../src/core/run-states.ts';
import { acquireLease, createRun, transition, type RunRecord } from '../../../src/controller/run-store.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';

export function setup(): { db: OrbitDb; clock: ManualClock } {
  return { db: openDb(':memory:'), clock: new ManualClock() };
}

/** A run walked through `path` by `owner`, who ends up holding its lease (ttl 60 s). */
export function makeRun(db: OrbitDb, clock: ManualClock, id: string, owner: string, path: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], ttlMs = 60_000): RunRecord {
  let run = createRun(db, { id, repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: `/repo/.orbit/runs/${id}/policy.json` }, clock);
  acquireLease(db, id, owner, ttlMs, clock);
  for (const to of path) run = transition(db, { runId: id, to, ownerId: owner, reason: 'test' }, clock);
  return run;
}

export function counters(db: OrbitDb, runId: string, allowance: Record<string, number>): void {
  for (const [counter, n] of Object.entries(allowance)) db.run('INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, ?, 0, ?, ?)', runId, counter, n, n);
}

export function eventTypes(db: OrbitDb, runId: string): string[] {
  return db.all<{ type: string }>('SELECT type FROM events WHERE run_id = ? ORDER BY id', runId).map((r) => r.type);
}
