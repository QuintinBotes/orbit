// Wave-3 controller fixes, each pinned by a test that failed before it:
//  - an inquisitor is never started by a controller that lost the run, and a stopped inquisition step
//    leaves its worker running for the next owner instead of waiting on it;
//  - the budget charge for starting a worker is made once even when the step dies before the worker row exists;
//  - an implementer the scheduler deferred for capacity starts once the capacity frees.
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { killGroup } from '../../../src/core/proc.ts';
import { loadRunContext, type ControllerDeps } from '../../../src/controller/context.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { obtain } from '../../../src/controller/steps/obtain.ts';
import { finishWorker, listWorkers, planWorker } from '../../../src/storage/workers.ts';
import { join } from 'node:path';
import { baseScenario, implementMul, labDeps, makeLab, PLANNER_OUTPUT, runState, startLabRun, waitFor, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
const groups: number[] = [];
afterEach(() => {
  for (const g of groups.splice(0)) {
    try {
      killGroup(g, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const l of labs.splice(0)) l.close();
});

function lab(roles: Record<string, object[]>): Lab {
  const l = makeLab();
  labs.push(l);
  writeScenario(l, baseScenario(roles));
  return l;
}

function depsFor(l: Lab, ownerId: string): ControllerDeps {
  return { ...labDeps(l), ownerId };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Step the run as `deps.ownerId` until it reaches `state` (waiting out workers between steps). */
async function driveTo(l: Lab, deps: ControllerDeps, runId: string, state: string): Promise<void> {
  for (let i = 0; i < 1_200 && runState(l, runId).state !== state; i++) {
    await step(deps, runId, new AbortController().signal);
    if (runState(l, runId).state !== state) await sleep(25);
  }
  expect(runState(l, runId).state).toBe(state);
}

const MATERIAL_PLANNER = { ...PLANNER_OUTPUT, unresolved_decisions: [{ question: 'Should mul round fractional results or keep full precision?', options: ['round', 'keep'], recommendation: null, material: true, affected_criteria: ['mul'] }] };
const INQUISITOR_OUTPUT = { mode: 'clarify', summary: 'needs a decision', facts: [], assumptions: [], unknowns: [], interpretations: [], questions: [], decisions: [], experiments: [], amendments: [], blocked_criteria: [], continuing_criteria: [] };

describe.skipIf(!canStripTypes)('controller: lease fences and budget charges', () => {
  it('an inquisition step whose controller lost the lease records and starts no inquisitor', async () => {
    const l = lab({ planner: [{ structured: MATERIAL_PLANNER }], inquisitor: [{ sleepMs: 60_000, structured: INQUISITOR_OUTPUT }] });
    const run = startLabRun(l);
    const a = depsFor(l, 'controller-a');
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    await driveTo(l, a, run.id, 'INQUISITION');
    // controller-b took the run over; controller-a has not noticed yet.
    l.db().run('UPDATE leases SET owner_id = ?, expires_at = ? WHERE run_id = ?', 'controller-b', Date.now() + 3_600_000, run.id);
    await expect(step(a, run.id, new AbortController().signal)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(listWorkers(l.db(), { runId: run.id, role: 'inquisitor' })).toEqual([]);
  }, 90_000);

  it('a stopped inquisition step stops supervising at once and leaves its inquisitor running for the next owner', async () => {
    const l = lab({ planner: [{ structured: MATERIAL_PLANNER }], inquisitor: [{ sleepMs: 60_000, structured: INQUISITOR_OUTPUT }] });
    const run = startLabRun(l);
    const a = depsFor(l, 'controller-a');
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    await driveTo(l, a, run.id, 'INQUISITION');
    const ac = new AbortController();
    const pending = step(a, run.id, ac.signal).then(
      () => null,
      (e: unknown) => e,
    );
    const w = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'inquisitor' }).find((x) => x.state === 'RUNNING' && x.pgid !== null), 30_000);
    groups.push(w.pgid!);
    const t0 = Date.now();
    ac.abort(new Error('lease lost'));
    const err = await pending;
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(err).toBeInstanceOf(Error);
    expect(listWorkers(l.db(), { runId: run.id, role: 'inquisitor' }).map((x) => x.state)).toEqual(['RUNNING']);
    expect(runState(l, run.id).state).toBe('INQUISITION');
  }, 90_000);

  it('the charge for starting a worker is made once when the step dies between the charge and the worker row', async () => {
    const l = lab({ implementer: [implementMul('*')] });
    const run = startLabRun(l);
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    const ctx = loadRunContext(depsFor(l, 'controller-a'), run.id, new AbortController().signal);
    let charges = 0;
    let crash = true;
    const opts = {
      base: 'probe',
      maxAttempts: 1,
      what: 'the probe',
      beforeStart: () => void charges++,
      request: (purpose: string) => {
        if (crash) {
          crash = false;
          throw new Error('controller died after the charge and before the worker row');
        }
        return { role: 'planner' as const, purpose, provider: 'claude', model: null, effort: null, cwd: l.repo, readOnly: true, prompt: () => 'Draft the contract.' };
      },
      accept: () => true,
    };
    await expect(obtain(ctx, opts)).rejects.toThrow(/controller died/);
    expect(charges).toBe(1);
    const again = await obtain(ctx, opts);
    expect(again.ok).toBe(false);
    expect(charges).toBe(1);
    const w = listWorkers(l.db(), { runId: run.id }).find((x) => x.purpose === 'probe#1');
    expect(w).toBeDefined();
    if (w?.pgid) groups.push(w.pgid);
  }, 60_000);

  it('an implementer deferred for capacity is admitted on a later step once the capacity frees', async () => {
    const l = lab({ implementer: [implementMul('*')] });
    const run = startLabRun(l);
    const a = depsFor(l, 'controller-a');
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    await driveTo(l, a, run.id, 'IMPLEMENTING');
    // Another unit of this run holds the only slot (default parallelism 1).
    const busy = planWorker(l.db(), { id: 'wrk-busy', runId: run.id, role: 'verifier', purpose: 'busy#1', provider: 'claude', model: null, effort: null, workerDir: join(l.base, 'busy'), cwd: l.repo }, systemClock, 'controller-a');
    const deferred = await step(a, run.id, new AbortController().signal);
    expect(deferred.waiting).toMatch(/deferred/);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toEqual([]);
    const again = await step(a, run.id, new AbortController().signal);
    expect(again.waiting).toMatch(/deferred/);
    finishWorker(l.db(), busy.id, { state: 'CANCELLED', resultStatus: 'cancelled', error: 'done' }, systemClock, 'controller-a');
    const started = await step(a, run.id, new AbortController().signal);
    expect(started.waiting).toMatch(/implementer .* is running/);
    const [impl] = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(impl?.purpose).toBe('implement:1#1');
    await driveTo(l, a, run.id, 'SUCCEEDED');
  }, 120_000);
});
