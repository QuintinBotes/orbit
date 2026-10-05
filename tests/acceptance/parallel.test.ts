/**
 * Spec section 17, scenario 15 (spec section 8, agent scheduling): parallel
 * work respects isolation and resource limits. Two runs share one service
 * controller: with room for both they overlap in separate worktrees outside
 * the repository and never see each other's edits; with room for one, the
 * second waits for the first instead of exceeding the limit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { Controller } from '../../src/controller/loop.ts';
import { isTerminal } from '../../src/controller/states.ts';
import { listWorkers, type WorkerRecord } from '../../src/storage/workers.ts';
import { listCandidates } from '../../src/evidence/store.ts';
import { git, labDeps, makeLab, READY, runState, startLabRun, waitFor, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, implementer, NOT_FOUND_TEXT, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, assertWorkersBounded } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

/** An implementer that works long enough for two runs to overlap. */
function marking(): object {
  return implementer([SRC_TEXT, TEST_TEXT], { extra: { sleepMs: 2_500 } });
}

async function serve(l: Lab, runIds: string[], maxRuns: number): Promise<void> {
  const c = new Controller({ mode: 'service', deps: labDeps(l), maxRuns, tickIntervalMs: 50, leaseTtlMs: 30_000, leaseRenewMs: 1_000, graceMs: 300, watchdogMs: 0 });
  const started = c.start();
  try {
    await waitFor(() => runIds.every((id) => isTerminal(runState(l, id).state)), 240_000, 100);
  } finally {
    await c.stop('scenario over');
    await started;
  }
}

function overlapMs(a: WorkerRecord[], b: WorkerRecord[]): number {
  let total = 0;
  for (const x of a) for (const y of b) total += Math.max(0, Math.min(x.endedAt ?? 0, y.endedAt ?? 0) - Math.max(x.spawnedAt ?? 0, y.spawnedAt ?? 0));
  return total;
}

describe.skipIf(!READY)('acceptance: parallel work, isolation and resource limits', () => {
  it('scenario 15: two runs work at once, each writer in its own worktree outside the repository, and neither sees the other\'s edits', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [marking()] }));
    const a = startLabRun(l, GOAL);
    const b = startLabRun(l, `${GOAL} (second request)`);
    await serve(l, [a.id, b.id], 2);

    const db = l.db();
    for (const id of [a.id, b.id]) expect(runState(l, id).state, runState(l, id).outcomeReason ?? '').toBe('SUCCEEDED');
    const wa = listWorkers(db, { runId: a.id, role: 'implementer' });
    const wb = listWorkers(db, { runId: b.id, role: 'implementer' });
    // They did run in parallel...
    expect(overlapMs(wa, wb)).toBeGreaterThan(0);
    // ...in separate worktrees under ~/.orbit, never in the repository or in each other's worktree.
    const [ca, cb] = [wa[0]!.cwd, wb[0]!.cwd];
    expect(ca).not.toBe(cb);
    for (const cwd of [ca, cb]) {
      expect(cwd.startsWith(join(l.orbitHome, 'worktrees'))).toBe(true);
      expect(relative(l.repo, cwd).startsWith('..')).toBe(true);
    }
    expect(ca.includes(a.id) && cb.includes(b.id)).toBe(true);
    // Each candidate holds exactly the files its own contract allowed, from its own worktree.
    for (const id of [a.id, b.id]) {
      const [cand] = listCandidates(db, id);
      expect(cand!.diffStat?.paths.sort()).toEqual(['src/server.ts', 'tests/unit/server.test.ts']);
    }
    // Two runs, two branches, two PRs; the user's checkout is untouched.
    expect(l.github().state.prs.map((p) => p.headRefName).sort()).toEqual([`orbit/${a.id}`, `orbit/${b.id}`].sort());
    expect(readFileSync(join(l.repo, 'src/server.ts'), 'utf8')).not.toContain(NOT_FOUND_TEXT);
    expect(git(l.repo, 'status', '--porcelain', '--untracked-files=no')).toBe('');
    // Within each run, active workers stayed within parallel_workers.
    for (const id of [a.id, b.id]) {
      assertWorkersBounded(db, id, l.config.scheduler.hard_limits.parallel_workers);
      assertRunInvariants(l, id);
    }
  }, 300_000);

  it('scenario 15: with capacity for one run, the second run waits for the first instead of exceeding the limit', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [marking()] }));
    const a = startLabRun(l, GOAL);
    const b = startLabRun(l, `${GOAL} (second request)`);
    await serve(l, [a.id, b.id], 1);

    const db = l.db();
    for (const id of [a.id, b.id]) expect(runState(l, id).state, runState(l, id).outcomeReason ?? '').toBe('SUCCEEDED');
    const all = [...listWorkers(db, { runId: a.id }), ...listWorkers(db, { runId: b.id })];
    // No instant had workers of both runs alive.
    expect(overlapMs(listWorkers(db, { runId: a.id }), listWorkers(db, { runId: b.id }))).toBe(0);
    expect(all.every((w) => w.spawnedAt !== null && w.endedAt !== null)).toBe(true);
    for (const id of [a.id, b.id]) assertRunInvariants(l, id);
  }, 300_000);
});
