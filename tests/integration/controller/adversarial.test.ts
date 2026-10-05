// Defects found by adversarial verification of the controller, each pinned by
// a test that failed before its fix: worker intent and spawn fenced by the
// lease and the step's abort signal, and an interrupted verification leaving
// its checkout for the run's next owner. The in-flight step test is a
// regression guard: ticks are serial today, which is what keeps it green.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { killGroup } from '../../../src/core/proc.ts';
import { LAUNCH_FILE } from '../../../src/adapters/supervise.ts';
import { loadRunContext, repoKey, type ControllerDeps } from '../../../src/controller/context.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { step, STEPS } from '../../../src/controller/steps/index.ts';
import type { StepResult } from '../../../src/controller/steps/common.ts';
import { ensureWorker, type WorkerRequest } from '../../../src/controller/workers.ts';
import { listCheckRuns } from '../../../src/evidence/store.ts';
import { listWorkers, planWorker } from '../../../src/storage/workers.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, waitFor, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
const groups: number[] = [];
afterEach(() => {
  for (const g of groups.splice(0)) killGroup(g, 'SIGKILL');
  for (const l of labs.splice(0)) l.close();
});

function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
  return l;
}

function depsFor(l: Lab, ownerId: string): ControllerDeps {
  return { ...labDeps(l), ownerId };
}

function plannerRequest(l: Lab): WorkerRequest {
  return { role: 'planner', purpose: 'plan#1', provider: 'claude', model: null, effort: null, cwd: l.repo, readOnly: true, prompt: () => 'Draft the contract.' };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!canStripTypes)('controller: adversarial checks', () => {
  it('a controller that no longer holds the lease cannot record or start a worker', async () => {
    const l = lab();
    const run = startLabRun(l);
    // Another controller took the run (this one was paused, or its renewal has not fired yet).
    acquireLease(l.db(), run.id, 'controller-b', 3_600_000, systemClock);
    const ctx = loadRunContext(depsFor(l, 'controller-a'), run.id, new AbortController().signal);
    await expect(ensureWorker(ctx, plannerRequest(l))).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
  });

  it('a controller that lost the lease does not spawn the new owner\'s planned worker a second time', async () => {
    const l = lab();
    const run = startLabRun(l);
    acquireLease(l.db(), run.id, 'controller-b', 3_600_000, systemClock);
    // controller-b recorded its intent and is about to spawn.
    const planned = planWorker(l.db(), { id: 'wrk-b-plan', runId: run.id, role: 'planner', purpose: 'plan#1', provider: 'claude', model: null, effort: null, workerDir: join(l.repo, '.orbit', 'runs', run.id, 'workers', 'wrk-b-plan'), cwd: l.repo }, systemClock, 'controller-b');
    const ctx = loadRunContext(depsFor(l, 'controller-a'), run.id, new AbortController().signal);
    await expect(ensureWorker(ctx, plannerRequest(l))).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(existsSync(join(planned.workerDir, LAUNCH_FILE))).toBe(false);
    expect(listWorkers(l.db(), { runId: run.id }).map((w) => [w.id, w.state])).toEqual([['wrk-b-plan', 'PLANNED']]);
  });

  it('a step whose signal was aborted (watchdog or lease loss) starts no worker', async () => {
    const l = lab();
    const run = startLabRun(l);
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    const ac = new AbortController();
    const ctx = loadRunContext(depsFor(l, 'controller-a'), run.id, ac.signal);
    ac.abort(new Error('step CONTRACTING exceeded 1000 ms'));
    await expect(ensureWorker(ctx, plannerRequest(l))).rejects.toThrow(/exceeded/);
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
  });

  it('regression guard: no second step of a run while its aborted step is still in flight', async () => {
    const l = lab();
    const run = startLabRun(l);
    const table = STEPS as Record<string, (ctx: unknown) => Promise<StepResult>>;
    const original = table.CREATED!;
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    // A step that does not notice its abort promptly (a git call, an install, a provider probe).
    table.CREATED = async () => {
      calls++;
      active++;
      maxActive = Math.max(maxActive, active);
      try {
        await gate;
      } finally {
        active--;
      }
      return { progressed: false, waiting: 'test' };
    };
    const c = new Controller({ mode: 'service', deps: labDeps(l), leaseTtlMs: 5_000, leaseRenewMs: 100, tickIntervalMs: 50, graceMs: 300, shutdownGraceMs: 100 });
    const started = c.start();
    try {
      await waitFor(() => calls === 1, 10_000);
      // The renewal fails (another owner for a moment), then the lease is free again.
      l.db().run('UPDATE leases SET owner_id = ?, expires_at = ? WHERE run_id = ?', 'controller-b', Date.now() + 3_600_000, run.id);
      await waitFor(() => c.ownedRuns().length === 0, 5_000);
      l.db().run('DELETE FROM leases WHERE run_id = ?', run.id);
      await sleep(1_000);
      expect(maxActive).toBe(1);
      expect(calls).toBe(1);
      // Once the aborted step settles, the run is claimed and stepped again.
      release();
      await waitFor(() => calls >= 2, 10_000);
      expect(maxActive).toBe(1);
    } finally {
      release();
      table.CREATED = original;
      await c.stop('test over');
      await started;
    }
  });

  it('a step that ignores its watchdog does not stall the controller\'s other runs and is not stepped twice', async () => {
    const l = lab();
    const stuck = startLabRun(l);
    const other = startLabRun(l, 'Add a sub function to the calculator.');
    const table = STEPS as Record<string, (ctx: { run: { id: string } }) => Promise<StepResult>>;
    const original = table.CREATED!;
    let stuckCalls = 0;
    let otherCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    table.CREATED = async (ctx) => {
      if (ctx.run.id === stuck.id) {
        stuckCalls++;
        await gate;
      } else otherCalls++;
      return { progressed: false, waiting: 'test' };
    };
    const c = new Controller({ mode: 'service', deps: labDeps(l), leaseTtlMs: 1_000, leaseRenewMs: 100, tickIntervalMs: 50, graceMs: 300, stepTimeoutMs: 300, stepAbortGraceMs: 300, shutdownGraceMs: 100 });
    const started = c.start();
    try {
      await waitFor(() => stuckCalls === 1 && otherCalls >= 1, 10_000);
      const before = otherCalls;
      // Before the fix every tick waited for the stuck step, so the other run was never stepped again.
      await waitFor(() => otherCalls >= before + 5, 10_000);
      expect(c.ownedRuns()).toEqual([other.id]);
      expect(l.db().all("SELECT id FROM events WHERE run_id = ? AND type = 'step.wedged'", stuck.id)).toHaveLength(1);
      // Its lease has long expired, yet this process does not start a second step of it while the first runs.
      await sleep(2_000);
      expect(stuckCalls).toBe(1);
      // Nor does it reconcile the run under the stuck step (which would move it to RECOVERING).
      expect(runState(l, stuck.id).state).toBe('CREATED');
    } finally {
      release();
      table.CREATED = original as typeof table.CREATED;
      await c.stop('test over');
      await started;
    }
  });

  it('an interrupted verification leaves the candidate checkout for the run\'s next owner', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/slow.flag', content: '1\n' }])] }));
    const run = startLabRun(l);
    const deps = depsFor(l, 'controller-a');
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    for (let i = 0; i < 1_200 && runState(l, run.id).state !== 'VERIFYING'; i++) {
      await step(deps, run.id, new AbortController().signal);
      if (runState(l, run.id).state !== 'VERIFYING') await sleep(50);
    }
    expect(runState(l, run.id).state).toBe('VERIFYING');

    const ac = new AbortController();
    const verifying = step(deps, run.id, ac.signal).catch(() => null);
    const check = await waitFor(() => listCheckRuns(l.db(), { runId: run.id }).find((r) => r.candidateId !== null && r.status === 'RUNNING' && r.pid !== null), 30_000);
    expect(check.pid).not.toBeNull();
    const root = join(l.orbitHome, 'worktrees', repoKey(l.repo), run.id);
    const checkouts = readdirSync(root).filter((n) => n.startsWith('check-'));
    expect(checkouts).toHaveLength(1);
    ac.abort(new Error('lease lost'));
    await verifying;
    expect(existsSync(join(root, checkouts[0]!))).toBe(true);
    expect(runState(l, run.id).state).toBe('VERIFYING');
  }, 90_000);
});
