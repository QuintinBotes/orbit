import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter } from '../../../src/adapters/types.ts';

type StepMod = typeof import('../../../src/controller/steps/index.ts');
type ReconcileMod = typeof import('../../../src/recovery/reconcile.ts');
type WatchdogMod = typeof import('../../../src/recovery/watchdog.ts');
type RetentionMod = typeof import('../../../src/storage/retention.ts');
type RunnerMod = typeof import('../../../src/evidence/runner.ts');
type StoreMod = typeof import('../../../src/controller/run-store.ts');
type ControllersMod = typeof import('../../../src/storage/controllers.ts');
type ReportMod = typeof import('../../../src/controller/report.ts');

const hooks = vi.hoisted(() => ({
  step: vi.fn(),
  reconcileOnStart: vi.fn(),
  watchdogTick: vi.fn(),
  pruneExpiredRuns: vi.fn(),
  reattachCheck: vi.fn(),
  renewLease: vi.fn(),
  releaseLease: vi.fn(),
  getRun: vi.fn(),
  heartbeatController: vi.fn(),
  markControllerStopped: vi.fn(),
  writeFinalReport: vi.fn(),
}));

vi.mock('../../../src/controller/steps/index.ts', async (orig) => {
  const actual = await orig<StepMod>();
  hooks.step.mockImplementation(actual.step);
  return { ...actual, step: hooks.step };
});
vi.mock('../../../src/recovery/reconcile.ts', async (orig) => {
  const actual = await orig<ReconcileMod>();
  hooks.reconcileOnStart.mockImplementation(actual.reconcileOnStart);
  return { ...actual, reconcileOnStart: hooks.reconcileOnStart };
});
vi.mock('../../../src/recovery/watchdog.ts', async (orig) => {
  const actual = await orig<WatchdogMod>();
  hooks.watchdogTick.mockImplementation(actual.watchdogTick);
  return { ...actual, watchdogTick: hooks.watchdogTick };
});
vi.mock('../../../src/storage/retention.ts', async (orig) => {
  const actual = await orig<RetentionMod>();
  hooks.pruneExpiredRuns.mockImplementation(actual.pruneExpiredRuns);
  return { ...actual, pruneExpiredRuns: hooks.pruneExpiredRuns };
});
vi.mock('../../../src/evidence/runner.ts', async (orig) => {
  const actual = await orig<RunnerMod>();
  hooks.reattachCheck.mockImplementation(actual.reattachCheck);
  return { ...actual, reattachCheck: hooks.reattachCheck };
});
vi.mock('../../../src/controller/run-store.ts', async (orig) => {
  const actual = await orig<StoreMod>();
  hooks.renewLease.mockImplementation(actual.renewLease);
  hooks.releaseLease.mockImplementation(actual.releaseLease);
  hooks.getRun.mockImplementation(actual.getRun);
  return { ...actual, renewLease: hooks.renewLease, releaseLease: hooks.releaseLease, getRun: hooks.getRun };
});
vi.mock('../../../src/storage/controllers.ts', async (orig) => {
  const actual = await orig<ControllersMod>();
  hooks.heartbeatController.mockImplementation(actual.heartbeatController);
  hooks.markControllerStopped.mockImplementation(actual.markControllerStopped);
  return { ...actual, heartbeatController: hooks.heartbeatController, markControllerStopped: hooks.markControllerStopped };
});
vi.mock('../../../src/controller/report.ts', async (orig) => {
  const actual = await orig<ReportMod>();
  hooks.writeFinalReport.mockImplementation(actual.writeFinalReport);
  return { ...actual, writeFinalReport: hooks.writeFinalReport };
});

const { Controller } = await import('../../../src/controller/loop.ts');
const { OrbitError } = await import('../../../src/core/errors.ts');
const store = await vi.importActual<StoreMod>('../../../src/controller/run-store.ts');
const reconcileActual = await vi.importActual<ReconcileMod>('../../../src/recovery/reconcile.ts');
const stepActual = await vi.importActual<StepMod>('../../../src/controller/steps/index.ts');
const controllersActual = await vi.importActual<ControllersMod>('../../../src/storage/controllers.ts');
const { planCheckRun, markCheckRunning, finishCheckRun } = await import('../../../src/evidence/store.ts');
const { planWorker, markWorkerRunning } = await import('../../../src/storage/workers.ts');
const { capturingLogger } = await import('./coverage-log.ts');
const { makeUnitLab, OWNER } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type ControllerOptions = import('../../../src/controller/loop.ts').ControllerOptions;
type CapturedLog = import('./coverage-log.ts').CapturedLog;

let lab: UnitLab;
let cap: CapturedLog;
const controllers: InstanceType<typeof Controller>[] = [];

beforeEach(() => {
  for (const [name, fn] of Object.entries(hooks)) {
    fn.mockClear();
  }
  // Every hook goes back to the real function unless a test overrides it.
  hooks.step.mockImplementation(stepActual.step);
  hooks.reconcileOnStart.mockImplementation(reconcileActual.reconcileOnStart);
  hooks.renewLease.mockImplementation(store.renewLease);
  hooks.releaseLease.mockImplementation(store.releaseLease);
  hooks.getRun.mockImplementation(store.getRun);
  hooks.heartbeatController.mockImplementation(controllersActual.heartbeatController);
  hooks.markControllerStopped.mockImplementation(controllersActual.markControllerStopped);
  cap = capturingLogger();
});

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.stop('test over').catch(() => undefined);
  lab?.cleanup();
});

/** A lab whose run is free for the controller under test to take: the helper's own lease is released. */
function setup(path: Parameters<typeof makeUnitLab>[0] extends infer O ? (O extends { path?: infer P } ? P : never) : never = ['PREFLIGHT'], adapters: Record<string, ProviderAdapter> = {}, tweak?: Parameters<typeof makeUnitLab>[0]): void {
  lab = makeUnitLab({ ...(tweak ?? {}), path, adapters, logger: cap.logger });
  store.releaseLease(lab.db, lab.runId, OWNER);
}

function make(opts: Partial<ControllerOptions> = {}) {
  const { deps: depsOver, ...rest } = opts;
  const c = new Controller({
    deps: { ...lab.deps, ...(depsOver ?? {}), ownerId: depsOver?.ownerId ?? 'ctl-loop' },
    mode: 'service',
    leaseTtlMs: 60_000,
    leaseRenewMs: 3_600_000,
    heartbeatMs: 3_600_000,
    tickIntervalMs: 5,
    watchdogMs: 0,
    credentialCheckMs: 0,
    retention: { intervalMs: 0 },
    ...rest,
  });
  controllers.push(c);
  return c;
}

// The controller's private methods, called the way its own timers call them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const priv = (c: unknown): any => c;
const logs = (msg: string) => cap.lines().filter((l) => l.msg === msg);
const eventTypes = (): string[] => lab.db.all<{ type: string }>('SELECT type FROM events WHERE run_id = ? ORDER BY id', lab.runId).map((r) => r.type);
const stateOf = () => store.getRun(lab.db, lab.runId).state;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('construction and lifecycle', () => {
  it('a foreground controller must be told which run it drives; a service controller generates its own id', () => {
    setup();
    expect(() => new Controller({ deps: { ...lab.deps, ownerId: 'x' }, mode: 'foreground' })).toThrow('a foreground controller needs the run it drives');
    const generated = new Controller({ deps: { ...lab.deps, ownerId: undefined as never }, mode: 'service' });
    expect(generated.ownerId).toMatch(/\S/);
    expect(generated.deps.ownerId).toBe(generated.ownerId);
    expect(make().ownerId).toBe('ctl-loop');
  });

  it('cannot be started twice', async () => {
    setup();
    const c = make({ tickIntervalMs: 1 });
    const done = c.start();
    await expect(c.start()).rejects.toThrow('controller already started');
    await c.stop('test');
    await done;
  });

  it('a foreground controller drives its run to a terminal state, records its start and stop, and releases the lease', async () => {
    setup(['PREFLIGHT']);
    let calls = 0;
    hooks.step.mockImplementation(async (_deps: unknown, runId: string) => {
      calls++;
      if (calls === 1) return { progressed: true };
      store.transition(lab.db, { runId, to: 'CANCELLED', ownerId: 'ctl-loop', reason: 'done' }, lab.clock);
      return { progressed: true, done: true };
    });
    const c = make({ mode: 'foreground', runId: lab.runId });
    await c.start();
    expect(calls).toBe(2);
    expect(stateOf()).toBe('CANCELLED');
    const row = controllersActual.getController(lab.db, 'ctl-loop');
    expect(row).toMatchObject({ mode: 'foreground', stopReason: 'foreground run finished' });
    expect(row.stoppedAt).not.toBeNull();
    expect(store.getLease(lab.db, lab.runId)).toBeNull();
    expect(c.ownedRuns()).toEqual([]);
  });

  it('a service controller keeps ticking until stopped and records why', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false, waiting: 'nothing to do' });
    const c = make({ tickIntervalMs: 2 });
    const done = c.start();
    await vi.waitFor(() => expect(hooks.step.mock.calls.length).toBeGreaterThan(2));
    await c.stop('operator asked');
    await done;
    expect(controllersActual.getController(lab.db, 'ctl-loop').stopReason).toBe('operator asked');
    // Asking again returns the same stop, not a second one.
    expect(c.stop('again')).toBe(c.stop('once more'));
  });

  it('a controller that never started records no stop', async () => {
    setup();
    const c = make();
    await c.stop('never ran');
    expect(hooks.markControllerStopped).not.toHaveBeenCalled();
    expect(logs('controller stopped')).toHaveLength(1);
  });

  it('a tick after the controller stopped does nothing', async () => {
    setup();
    const c = make();
    await c.stop('x');
    expect(await c.tick()).toEqual({ owned: [], steps: [] });
    expect(hooks.step).not.toHaveBeenCalled();
  });

  it('installs and removes its signal handlers when asked, and a signal stops it gracefully', async () => {
    setup();
    const before = { term: process.listeners('SIGTERM'), int: process.listeners('SIGINT') };
    const c = make({ handleSignals: true, tickIntervalMs: 2 });
    const done = c.start();
    await vi.waitFor(() => expect(process.listeners('SIGTERM').length).toBe(before.term.length + 1));
    const handler = process.listeners('SIGTERM').find((l) => !before.term.includes(l)) as (sig: string) => void;
    expect(process.listeners('SIGINT').length).toBe(before.int.length + 1);
    handler('SIGTERM');
    await done;
    expect(controllersActual.getController(lab.db, 'ctl-loop').stopReason).toBe('received SIGTERM');
    expect(process.listeners('SIGTERM')).toEqual(before.term);
    expect(process.listeners('SIGINT')).toEqual(before.int);
  });
});

describe('claiming runs', () => {
  it('takes a free run, steps it once per tick and reports what it did', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: true });
    const c = make();
    const rep = await c.tick();
    expect(rep.owned).toEqual([lab.runId]);
    expect(rep.steps).toEqual([{ runId: lab.runId, state: 'PREFLIGHT', result: { progressed: true } }]);
    expect(store.getLease(lab.db, lab.runId)?.ownerId).toBe('ctl-loop');
    expect(hooks.heartbeatController.mock.calls.at(-1)?.[3]).toEqual({ progress: true });
  });

  it('leaves a run another live controller holds, and one that is paused', async () => {
    setup(['PREFLIGHT']);
    store.acquireLease(lab.db, lab.runId, 'someone-else', 60_000, lab.clock);
    const c = make();
    expect((await c.tick()).owned).toEqual([]);
    store.releaseLease(lab.db, lab.runId, 'someone-else');
    store.setPaused(lab.db, lab.runId, true, 'user', lab.clock);
    expect((await c.tick()).owned).toEqual([]);
    expect(hooks.step).not.toHaveBeenCalled();
  });

  it('respects the cap on runs owned at once', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const c = make({ maxRuns: 0 });
    expect((await c.tick()).owned).toEqual([]);
    expect(store.getLease(lab.db, lab.runId)).toBeNull();
  });

  it('releases a run whose reconciliation was not clean instead of working on it', async () => {
    setup(['PREFLIGHT']);
    hooks.reconcileOnStart.mockImplementation(async (opts: { ownerId: string; runIds?: string[] }) => {
      const real = await reconcileActual.reconcileOnStart(opts as never);
      return { ...real, runs: real.runs.map((r) => ({ ...r, skipped: 'leased-by-other' as const })) };
    });
    const c = make();
    expect((await c.tick()).owned).toEqual([]);
    expect(store.getLease(lab.db, lab.runId)).toBeNull();
    expect(logs('run not reconciled; not taken up')).toHaveLength(1);
  });

  it('a reconciliation that fails outright is logged and no run is taken up', async () => {
    setup(['PREFLIGHT']);
    hooks.reconcileOnStart.mockImplementation(async (opts: { ownerId: string; runIds?: string[] }) => {
      await reconcileActual.reconcileOnStart(opts as never);
      throw new Error('database busy');
    });
    const c = make();
    expect((await c.tick()).owned).toEqual([]);
    expect(logs('reconcile failed')[0]?.error).toBe('database busy');
    expect(c.lastReconcile).toBeNull();
    expect(store.getLease(lab.db, lab.runId)).toBeNull();
  });

  it('logs each problem reconciliation reports for a run', async () => {
    setup(['PREFLIGHT']);
    hooks.reconcileOnStart.mockImplementation(async (opts: { ownerId: string; runIds?: string[] }) => {
      const real = await reconcileActual.reconcileOnStart(opts as never);
      return { ...real, errors: [{ runId: lab.runId, message: 'worker w1: damaged' }] };
    });
    await make().tick();
    expect(logs('reconcile error')[0]).toMatchObject({ run_id: lab.runId, error: 'worker w1: damaged' });
  });

  it('a foreground controller releases every other run its reconciliation happened to take', async () => {
    setup(['PREFLIGHT']);
    const other = store.createRun(lab.db, { id: 'orb-other', repoRoot: lab.repo, goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, lab.clock);
    hooks.step.mockResolvedValue({ progressed: false });
    hooks.reconcileOnStart.mockImplementation(async (opts: { ownerId: string; runIds?: string[] }) => {
      const real = await reconcileActual.reconcileOnStart(opts as never);
      store.acquireLease(lab.db, other.id, opts.ownerId, 60_000, lab.clock);
      return { ...real, runs: [...real.runs, { runId: other.id, state: 'CREATED', skipped: null, recovery: null, workers: [], checks: [], apps: [], actions: [] }] };
    });
    const c = make({ mode: 'foreground', runId: lab.runId });
    await c.tick();
    expect(c.ownedRuns()).toEqual([lab.runId]);
    expect(store.getLease(lab.db, other.id)).toBeNull();
  });

  it('a foreground controller that is stopped during a tick does not wait for another one', async () => {
    setup(['PREFLIGHT']);
    const c = make({ mode: 'foreground', runId: lab.runId, tickIntervalMs: 60_000 });
    hooks.step.mockImplementation(async () => {
      void c.stop('stopped mid-tick');
      return { progressed: false };
    });
    const started = Date.now();
    await c.start();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(controllersActual.getController(lab.db, 'ctl-loop').stopReason).toBe('stopped mid-tick');
  });

  it('a run paused between claim and reconciliation is released for another controller', async () => {
    setup(['PREFLIGHT']);
    hooks.reconcileOnStart.mockImplementation(async (opts: { ownerId: string; runIds?: string[] }) => {
      const real = await reconcileActual.reconcileOnStart(opts as never);
      store.setPaused(lab.db, lab.runId, true, 'user', lab.clock);
      return real;
    });
    const c = make();
    expect((await c.tick()).owned).toEqual([]);
    expect(store.getLease(lab.db, lab.runId)).toBeNull();
  });

  it('drops a run that ended or was paused while owned, releasing its lease', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const c = make();
    await c.tick();
    expect(c.ownedRuns()).toEqual([lab.runId]);
    store.setPaused(lab.db, lab.runId, true, 'user', lab.clock);
    const rep = await c.tick();
    expect(rep.owned).toEqual([]);
    expect(store.getLease(lab.db, lab.runId)).toBeNull();
    expect(logs('run released')[0]?.reason).toBe('run paused');
    store.setPaused(lab.db, lab.runId, false, 'user', lab.clock);
    await c.tick();
    store.transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: 'ctl-loop', reason: 'x' }, lab.clock);
    await c.tick();
    expect(logs('run released').map((l) => l.reason)).toContain('run CANCELLED');
  });

  it('drops a run whose row has disappeared', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const c = make();
    await c.tick();
    hooks.getRun.mockImplementation((db: unknown, id: string) => {
      if (id === lab.runId) throw new OrbitError('NOT_FOUND', 'no run');
      return store.getRun(db as never, id);
    });
    const rep = await c.tick();
    expect(logs('run released').map((l) => l.reason)).toContain('run disappeared');
    expect(rep.owned).toEqual([]);
  });

  it('a step that finishes the run releases it at once', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockImplementation(async (_d: unknown, runId: string) => {
      store.transition(lab.db, { runId, to: 'CANCELLED', ownerId: 'ctl-loop', reason: 'x' }, lab.clock);
      return { progressed: true, done: true };
    });
    const c = make();
    const rep = await c.tick();
    expect(rep.owned).toEqual([]);
    expect(store.getLease(lab.db, lab.runId)).toBeNull();
    expect(hooks.heartbeatController.mock.calls.at(-1)?.[3]).toEqual({ progress: true });
  });

  it('a step that says it is done for a run that is still live keeps it', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false, done: true });
    const c = make();
    expect((await c.tick()).owned).toEqual([lab.runId]);
  });

  it('does not start a second step of a run whose step is still running', async () => {
    setup(['PREFLIGHT']);
    let release!: () => void;
    hooks.step.mockImplementation(() => new Promise((r) => (release = () => r({ progressed: true }))));
    const c = make();
    const first = c.tick();
    await vi.waitFor(() => expect(hooks.step).toHaveBeenCalledTimes(1));
    const second = c.tick();
    // The second tick cannot finish launching anything before the first step ends: only one step exists.
    await sleep(20);
    expect(hooks.step).toHaveBeenCalledTimes(1);
    release();
    await first;
    await second;
  });
});

describe('a step that goes wrong', () => {
  it('a crash is reported and logged, the run stays owned for the next tick', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockRejectedValue(new Error('step blew up sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF'));
    const c = make();
    const rep = await c.tick();
    expect(rep.steps[0]?.result).toMatchObject({ error: expect.stringContaining('step blew up') });
    expect(JSON.stringify(rep.steps[0])).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(logs('step crashed')).toHaveLength(1);
    expect(c.ownedRuns()).toEqual([lab.runId]);
  });

  it('a lost lease forgets the run and records it', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockRejectedValue(new OrbitError('LEASE_LOST', 'lease gone'));
    const c = make();
    const rep = await c.tick();
    expect(rep.owned).toEqual([]);
    expect(eventTypes()).toContain('lease.lost');
    expect(logs('step crashed')).toHaveLength(0);
  });

  it('a step the watchdog aborted is not logged as a crash', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockImplementation((_d: unknown, _r: string, signal: AbortSignal) => new Promise((_ok, bad) => signal.addEventListener('abort', () => bad(new Error('aborted')))));
    const c = make({ stepTimeoutMs: 15, stepAbortGraceMs: 5_000 });
    const rep = await c.tick();
    expect(rep.steps[0]?.result).toEqual({ error: 'aborted' });
    expect(logs('step crashed')).toHaveLength(0);
    expect(eventTypes()).toContain('step.timeout');
    expect(c.ownedRuns()).toEqual([lab.runId]);
  });

  it('a step that ignores its abort is given up on: the run is no longer ours, nothing new starts until it settles', async () => {
    setup(['PREFLIGHT']);
    let settle!: () => void;
    let calls = 0;
    hooks.step.mockImplementation(() => {
      calls++;
      return new Promise((r) => (settle = () => r({ progressed: false })));
    });
    const c = make({ stepTimeoutMs: 10, stepAbortGraceMs: 10 });
    const rep = await c.tick();
    expect(rep.steps.at(-1)?.result).toMatchObject({ error: expect.stringContaining('did not stop within 10 ms of its 10 ms timeout') });
    expect(logs('step wedged; giving the run up')).toHaveLength(1);
    expect(c.ownedRuns()).toEqual([]);
    expect(eventTypes()).toContain('step.wedged');
    // While the stuck step is unsettled the run is not claimed again.
    await c.tick();
    expect(calls).toBe(1);
    settle();
    await sleep(10);
    await c.tick();
    expect(calls).toBe(2);
    // A shutdown does not wait forever for it either.
    settle();
  });

  it('a wedged step that settles late removes itself from the draining set', async () => {
    setup(['PREFLIGHT']);
    let settle!: () => void;
    hooks.step.mockImplementation(() => new Promise((r) => (settle = () => r({ progressed: false }))));
    const c = make({ stepTimeoutMs: 5, stepAbortGraceMs: 5 });
    await c.tick();
    const draining = (c as unknown as { draining: Map<string, unknown> }).draining;
    expect([...draining.keys()]).toEqual([lab.runId]);
    settle();
    await vi.waitFor(() => expect(draining.size).toBe(0));
  });
});

describe('credential checks while a run works', () => {
  const adapterFor = (state: 'valid' | 'expired') => ({ claude: { id: 'claude', validateCredentials: async () => ({ state, method: 'api_key', detail: 'd' }) } as unknown as ProviderAdapter });

  it('is off when the interval is zero, and skips runs that have not started, are paused or are being cancelled', async () => {
    setup(['PREFLIGHT'], adapterFor('expired'));
    hooks.step.mockResolvedValue({ progressed: false });
    lab.clock.advance(3_600_000);
    expect(await priv(make({ credentialCheckMs: 0 }))['credentialCheck'](lab.runId, new AbortController().signal)).toBe(false);
    const c = make({ credentialCheckMs: 1_000 });
    store.setPaused(lab.db, lab.runId, true, 'u', lab.clock);
    expect(await priv(c)['credentialCheck'](lab.runId, new AbortController().signal)).toBe(false);
    store.setPaused(lab.db, lab.runId, false, 'u', lab.clock);
    store.requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await priv(c)['credentialCheck'](lab.runId, new AbortController().signal)).toBe(false);
  });

  it('does not check a run younger than the interval, or one checked recently', async () => {
    setup(['PREFLIGHT'], adapterFor('expired'));
    const c = make({ credentialCheckMs: 10_000 });
    expect(await priv(c)['credentialCheck'](lab.runId, new AbortController().signal)).toBe(false);
    lab.clock.advance(20_000);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'credentials.checked', 'x', '{}')", lab.runId, lab.clock.now());
    expect(await priv(c)['credentialCheck'](lab.runId, new AbortController().signal)).toBe(false);
  });

  it('a check that finds the credentials fine lets the step run', async () => {
    setup(['PREFLIGHT'], adapterFor('valid'));
    hooks.step.mockResolvedValue({ progressed: false });
    lab.clock.advance(20_000);
    const c = make({ credentialCheckMs: 10_000 });
    await c.tick();
    expect(hooks.step).toHaveBeenCalledTimes(1);
    expect(stateOf()).toBe('PREFLIGHT');
  });

  it('expired credentials block the run, stop its workers, write its report and skip the step', async () => {
    setup(['PREFLIGHT'], adapterFor('expired'));
    lab.clock.advance(20_000);
    const w = planWorker(lab.db, { id: 'wrk-1', runId: lab.runId, role: 'planner', provider: 'claude', workerDir: join(lab.base, 'w'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    const c = make({ credentialCheckMs: 10_000 });
    const rep = await c.tick();
    expect(hooks.step).not.toHaveBeenCalled();
    expect(rep.steps).toEqual([{ runId: lab.runId, state: 'PREFLIGHT', result: { progressed: true, done: true } }]);
    expect(stateOf()).toBe('BLOCKED');
    expect(rep.owned).toEqual([]);
    expect(existsSync(join(lab.ctx().runDir, 'final.md'))).toBe(true);
  });

  it('names the workers it could not stop', async () => {
    setup(['PREFLIGHT'], adapterFor('expired'));
    lab.clock.advance(20_000);
    const w = planWorker(lab.db, { id: 'wrk-stuck', runId: lab.runId, role: 'planner', provider: 'claude', workerDir: join(lab.base, 'w'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: process.pid, pgid: process.pid, procStart: null }, lab.clock, OWNER);
    const c = make({ credentialCheckMs: 10_000 });
    await c.tick();
    expect(eventTypes()).toContain('workers.stop-failed');
  });

  it('a step that was already aborted does not act on the verdict', async () => {
    setup(['PREFLIGHT'], adapterFor('expired'));
    lab.clock.advance(20_000);
    const ac = new AbortController();
    ac.abort();
    store.acquireLease(lab.db, lab.runId, 'ctl-loop', 60_000, lab.clock);
    const c = make({ credentialCheckMs: 10_000 });
    expect(await priv(c)['credentialCheck'](lab.runId, ac.signal)).toBe(false);
    expect(stateOf()).toBe('BLOCKED');
  });

  it('checks the claude provider by default when an adapter for it exists, and nothing when none does', async () => {
    setup(['PREFLIGHT'], {});
    lab.clock.advance(20_000);
    const c = make({ credentialCheckMs: 10_000 });
    expect(await priv(c)['credentialCheck'](lab.runId, new AbortController().signal)).toBe(false);
    expect(eventTypes()).toContain('credentials.checked');
  });
});

describe('lease renewal and heartbeat', () => {
  it('renews every owned lease, and a lease that cannot be renewed aborts the step and forgets the run', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const c = make();
    await c.tick();
    priv(c)['renewAll']();
    expect(hooks.renewLease).toHaveBeenCalledTimes(1);
    expect(c.ownedRuns()).toEqual([lab.runId]);
    hooks.renewLease.mockReturnValue(false);
    priv(c)['renewAll']();
    expect(c.ownedRuns()).toEqual([]);
    expect(eventTypes()).toContain('lease.lost');
  });

  it('a renewal that throws is logged and counts as lost', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const c = make();
    await c.tick();
    hooks.renewLease.mockImplementation(() => {
      throw new Error('disk I/O');
    });
    priv(c)['renewAll']();
    expect(logs('lease renewal failed')[0]?.error).toBe('disk I/O');
    expect(c.ownedRuns()).toEqual([]);
  });

  it('a controller marked stopped by someone else stops itself; a failing heartbeat is only logged', async () => {
    setup(['PREFLIGHT']);
    const c = make();
    await c.stop('prepare');
    hooks.heartbeatController.mockReturnValue(false);
    const live = make();
    priv(live)['heartbeat']();
    await vi.waitFor(() => expect(logs('controller stopped').some((l) => l.reason === 'this controller was marked stopped by another process')).toBe(true));
    hooks.heartbeatController.mockImplementation(() => {
      throw new Error('locked');
    });
    priv(make())['heartbeat']();
    expect(logs('heartbeat failed')[0]?.error).toBe('locked');
  });

  it('the timers do the renewing and heartbeating on their own schedule', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const c = make({ leaseRenewMs: 5, heartbeatMs: 5, tickIntervalMs: 2 });
    const done = c.start();
    await vi.waitFor(() => {
      expect(hooks.renewLease.mock.calls.length).toBeGreaterThan(1);
      expect(hooks.heartbeatController.mock.calls.length).toBeGreaterThan(1);
    });
    await c.stop('done');
    await done;
  });

  it('derives the renewal period from the lease time to live when not given', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const c = new Controller({ deps: { ...lab.deps, ownerId: 'ctl-loop' }, mode: 'service', leaseTtlMs: 1_000, heartbeatMs: 3_600_000, tickIntervalMs: 2, watchdogMs: 0, credentialCheckMs: 0, retention: { intervalMs: 0 } });
    controllers.push(c);
    const done = c.start();
    await vi.waitFor(() => expect(hooks.renewLease).toHaveBeenCalled(), { timeout: 2_000 });
    await c.stop('done');
    await done;
  });
});

describe('stopping with work in flight', () => {
  it('waits briefly for the step, then aborts it and releases the lease; a failing release or stop record is only logged', async () => {
    setup(['PREFLIGHT']);
    let aborted = false;
    hooks.step.mockImplementation((_d: unknown, _r: string, signal: AbortSignal) => new Promise((ok) => signal.addEventListener('abort', () => ((aborted = true), ok({ progressed: false })))));
    const c = make({ shutdownGraceMs: 10 });
    const tick = c.tick();
    await vi.waitFor(() => expect(hooks.step).toHaveBeenCalled());
    hooks.releaseLease.mockImplementation(() => {
      throw new Error('release failed');
    });
    hooks.markControllerStopped.mockImplementation(() => {
      throw new Error('cannot record');
    });
    await priv(c)['stop']('shutdown');
    await tick;
    expect(aborted).toBe(true);
    expect(logs('lease release failed')[0]?.error).toBe('release failed');
    expect(logs('controller stopped')).toHaveLength(1);
  });

  it('records a stop failure for a controller that had started', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    hooks.markControllerStopped.mockImplementation(() => {
      throw new Error('cannot record');
    });
    const c = make({ tickIntervalMs: 2 });
    const done = c.start();
    await vi.waitFor(() => expect(hooks.step).toHaveBeenCalled());
    await c.stop('x');
    await done;
    expect(logs('could not record the stop')[0]?.error).toBe('cannot record');
  });
});

describe('the watchdog', () => {
  const report = (findings: object[]) => ({ at: 0, findings });

  it('logs its findings, aborts the step of a run it abandoned, and writes the report of one it exhausted', async () => {
    setup(['PREFLIGHT']);
    let aborted = false;
    hooks.step.mockImplementation((_d: unknown, _r: string, signal: AbortSignal) => new Promise((ok) => signal.addEventListener('abort', () => ((aborted = true), ok({ progressed: false })))));
    const c = make();
    const tick = c.tick();
    await vi.waitFor(() => expect(hooks.step).toHaveBeenCalled());
    hooks.watchdogTick.mockResolvedValue(report([{ kind: 'stuck-step', runId: lab.runId, action: 'abandoned-to-recovering', detail: 'x'.repeat(400) }, { kind: 'stalled-run', runId: null, action: null, detail: 'quiet' }, { kind: 'stuck-step', runId: lab.runId, action: 'exhausted', detail: 'budget' }]));
    await priv(c)['watchdog']();
    await tick;
    expect(aborted).toBe(true);
    expect(logs('watchdog')).toHaveLength(3);
    expect((logs('watchdog')[0]?.detail as string).length).toBe(300);
    expect(logs('watchdog')[1]).toMatchObject({ run_id: null, controller: null });
  });

  it('passes its configuration and ledger lookup through, and a run with no ledger has none', async () => {
    setup(['PREFLIGHT']);
    hooks.watchdogTick.mockResolvedValue(report([]));
    const c = make({ watchdog: { stallMs: 1234 } });
    await priv(c)['watchdog']();
    const arg = hooks.watchdogTick.mock.calls[0]![0] as { config?: { stallMs: number }; ledgerFor: (id: string) => unknown };
    expect(arg.config).toEqual({ stallMs: 1234 });
    expect(arg.ledgerFor(lab.runId)).toBeNull();
    const plain = make();
    await priv(plain)['watchdog']();
    expect('config' in (hooks.watchdogTick.mock.calls[1]![0] as object)).toBe(false);
  });

  it('a ledger lookup finds the budget of a run that has counters, and nothing for one with a broken snapshot', async () => {
    setup(['PREFLIGHT']);
    const { initLedger } = await import('./coverage-helpers.ts');
    initLedger(lab);
    hooks.watchdogTick.mockResolvedValue(report([]));
    const c = make();
    await priv(c)['watchdog']();
    const arg = hooks.watchdogTick.mock.calls[0]![0] as { ledgerFor: (id: string) => { consume: unknown } | null };
    expect(typeof arg.ledgerFor(lab.runId)?.consume).toBe('function');
    const policy = lab.ctx().run.policyPath;
    chmodSync(policy, 0o644);
    writeFileSync(policy, '{}');
    expect(arg.ledgerFor(lab.runId)).toBeNull();
  });

  it('a pass that fails is logged and does not stop the watchdog from running again; passes do not overlap', async () => {
    setup(['PREFLIGHT']);
    let release!: () => void;
    hooks.watchdogTick.mockImplementationOnce(() => new Promise((r) => (release = () => r(report([])))));
    const c = make();
    const first = priv(c)['watchdog']() as Promise<void>;
    await priv(c)['watchdog']();
    expect(hooks.watchdogTick).toHaveBeenCalledTimes(1);
    release();
    await first;
    hooks.watchdogTick.mockRejectedValueOnce(new Error('tick failed'));
    await priv(c)['watchdog']();
    expect(logs('watchdog failed')[0]?.error).toBe('tick failed');
    hooks.watchdogTick.mockResolvedValue(report([]));
    await priv(c)['watchdog']();
    expect(hooks.watchdogTick).toHaveBeenCalledTimes(3);
  });

  it('does nothing once the controller has stopped, and runs on its own timer in service mode only', async () => {
    setup(['PREFLIGHT']);
    hooks.watchdogTick.mockResolvedValue(report([]));
    const stopped = make();
    await stopped.stop('x');
    await priv(stopped)['watchdog']();
    expect(hooks.watchdogTick).not.toHaveBeenCalled();
    const svc = make({ watchdogMs: 5, tickIntervalMs: 2 });
    const done = svc.start();
    await vi.waitFor(() => expect(hooks.watchdogTick).toHaveBeenCalled());
    await svc.stop('x');
    await done;
    hooks.watchdogTick.mockClear();
    const fg = make({ mode: 'foreground', runId: lab.runId, watchdogMs: 5, tickIntervalMs: 2, deps: { ownerId: 'ctl-fg' } as never });
    hooks.step.mockImplementation(async () => {
      await sleep(30);
      store.transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: 'ctl-fg', reason: 'x' }, lab.clock);
      return { progressed: true, done: true };
    });
    await fg.start();
    expect(hooks.watchdogTick).not.toHaveBeenCalled();
  });
});

describe('finished checks found by reconciliation', () => {
  function openCheck(status: 'RUNNING' | 'PASSED' = 'RUNNING') {
    const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: null, checkId: 'unit', kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: lab.ctx().run.policyHash, command: ['true'], cwd: lab.repo, isolation: 'none', limitations: [] }, lab.clock);
    markCheckRunning(lab.db, row.id, 1, lab.clock);
    if (status === 'PASSED') finishCheckRun(lab.db, row.id, { status: 'PASSED', exitCode: 0, timedOut: false, cancelled: false, logPath: null, logSha256: null, fingerprint: null, excerpt: '', artifacts: [], endedAt: lab.clock.now() });
    return row.id;
  }
  const reconcileWith = (checks: object[]) =>
    hooks.reconcileOnStart.mockImplementation(async (opts: { ownerId: string; runIds?: string[] }) => {
      const real = await reconcileActual.reconcileOnStart(opts as never);
      return { ...real, runs: real.runs.map((r) => ({ ...r, checks })) };
    });

  it('collects a check that finished while nobody supervised it, once, and skips one already final', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    hooks.reattachCheck.mockResolvedValue({});
    const open = openCheck();
    const done = openCheck('PASSED');
    reconcileWith([
      { checkRunId: open, observation: 'finished', closed: false },
      { checkRunId: done, observation: 'finished', closed: false },
      { checkRunId: 'x', observation: 'running', closed: false },
      { checkRunId: 'y', observation: 'finished', closed: true },
    ]);
    await make().tick();
    expect(hooks.reattachCheck.mock.calls.map((c) => c[1])).toEqual([open]);
    const runner = hooks.reattachCheck.mock.calls[0]![0] as { detachSignal: AbortSignal; pollMs: number };
    expect(runner.detachSignal.aborted).toBe(true);
    expect(runner.pollMs).toBe(20);
  });

  it('a collection a cancellation interrupted is not worth a warning, any other failure is', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const a = openCheck();
    reconcileWith([{ checkRunId: a, observation: 'finished', closed: false }]);
    hooks.reattachCheck.mockRejectedValueOnce(new OrbitError('CANCELLED', 'detached'));
    await make().tick();
    expect(logs('could not collect a finished check')).toHaveLength(0);
    hooks.reattachCheck.mockRejectedValueOnce(new Error('shim vanished'));
    const c2 = make();
    await c2.tick();
    expect(logs('could not collect a finished check')[0]).toMatchObject({ check_run: a, error: 'shim vanished' });
  });

  it('a run whose context cannot be loaded costs only the collection', async () => {
    setup(['PREFLIGHT']);
    hooks.step.mockResolvedValue({ progressed: false });
    const a = openCheck();
    reconcileWith([{ checkRunId: a, observation: 'finished', closed: false }]);
    const policy = lab.ctx().run.policyPath;
    hooks.reconcileOnStart.mockImplementationOnce(async (opts: { ownerId: string; runIds?: string[] }) => {
      const real = await reconcileActual.reconcileOnStart(opts as never);
      chmodSync(policy, 0o644);
      writeFileSync(policy, '{}');
      return { ...real, runs: real.runs.map((r) => ({ ...r, checks: [{ checkRunId: a, observation: 'finished', closed: false }] })) };
    });
    await make().tick();
    expect(logs('could not collect finished checks')).toHaveLength(1);
  });
});

describe('final reports and retention', () => {
  it('writes the report of a recently ended run that lost it, and leaves one that has it', async () => {
    setup(['PREFLIGHT']);
    store.acquireLease(lab.db, lab.runId, OWNER, 60_000, lab.clock);
    store.transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
    const c = make();
    priv(c)['ensureFinalReports']();
    const md = join(lab.ctx().runDir, 'final.md');
    expect(existsSync(md)).toBe(true);
    hooks.writeFinalReport.mockClear();
    priv(c)['ensureFinalReports']();
    expect(hooks.writeFinalReport).not.toHaveBeenCalled();
  });

  it('writes it without a snapshot when the policy no longer verifies, and logs a report that cannot be written', async () => {
    setup(['PREFLIGHT']);
    store.acquireLease(lab.db, lab.runId, OWNER, 60_000, lab.clock);
    store.transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
    const policy = lab.ctx().run.policyPath;
    chmodSync(policy, 0o644);
    writeFileSync(policy, '{}');
    const c = make();
    priv(c)['ensureFinalReports']();
    expect(hooks.writeFinalReport.mock.calls[0]![2]).toMatchObject({ snapshot: null });
    rmSync(join(policy, '..', 'final.md'), { force: true });
    hooks.writeFinalReport.mockImplementation(() => {
      throw new Error('disk full');
    });
    priv(c)['ensureFinalReports']();
    expect(logs('final report repair failed')[0]).toMatchObject({ run_id: lab.runId, error: 'disk full' });
  });

  it('prunes by the retention period of the newest run\'s frozen policy and reports what it did', async () => {
    setup(['PREFLIGHT'], {}, { tweak: (c) => void (c.retention = { ...c.retention, keep_runs_days: 9 }) });
    hooks.pruneExpiredRuns.mockResolvedValue({ cutoff: 0, pruned: [{ runId: 'old-1' }], skipped: [{ runId: 'old-2', reason: 'pinned' }] });
    const c = make();
    const out = await c.pruneRetention();
    expect(out).toHaveLength(1);
    expect(hooks.pruneExpiredRuns.mock.calls[0]![1]).toMatchObject({ repoRoot: lab.repo, keepDays: 9, orbitHome: lab.home });
    expect(logs('retention pass')[0]).toMatchObject({ keep_days: 9, pruned: ['old-1'], skipped: 1 });
  });

  it('an explicit period overrides the policy, and a quiet pass logs nothing', async () => {
    setup(['PREFLIGHT']);
    hooks.pruneExpiredRuns.mockResolvedValue({ cutoff: 0, pruned: [], skipped: [] });
    const c = make({ retention: { keepDays: 3, intervalMs: 0 } });
    await c.pruneRetention();
    expect(hooks.pruneExpiredRuns.mock.calls[0]![1]).toMatchObject({ keepDays: 3 });
    expect(logs('retention pass')).toHaveLength(0);
  });

  it('skips a repository whose runs name no usable period, and logs a pass that fails', async () => {
    setup(['PREFLIGHT']);
    const policy = lab.ctx().run.policyPath;
    chmodSync(policy, 0o644);
    writeFileSync(policy, '{}');
    const c = make();
    expect(await c.pruneRetention()).toEqual([]);
    expect(hooks.pruneExpiredRuns).not.toHaveBeenCalled();
    const c2 = make({ retention: { keepDays: 2, intervalMs: 0 } });
    hooks.pruneExpiredRuns.mockRejectedValue(new Error('rmdir failed'));
    expect(await c2.pruneRetention()).toEqual([]);
    expect(logs('retention pass failed')[0]).toMatchObject({ repo: lab.repo, error: 'rmdir failed' });
  });

  it('does not overlap passes and does nothing once stopped; the periodic pass runs in service mode', async () => {
    setup(['PREFLIGHT']);
    let release!: () => void;
    hooks.pruneExpiredRuns.mockImplementationOnce(() => new Promise((r) => (release = () => r({ cutoff: 0, pruned: [], skipped: [] }))));
    const c = make({ retention: { keepDays: 2, intervalMs: 0 } });
    const first = c.pruneRetention();
    expect(await c.pruneRetention()).toEqual([]);
    release();
    await first;
    await c.stop('x');
    expect(await c.pruneRetention()).toEqual([]);

    hooks.pruneExpiredRuns.mockClear();
    hooks.pruneExpiredRuns.mockResolvedValue({ cutoff: 0, pruned: [], skipped: [] });
    hooks.step.mockResolvedValue({ progressed: false });
    const svc = make({ retention: { keepDays: 2, intervalMs: 5 }, tickIntervalMs: 2 });
    const done = svc.start();
    await vi.waitFor(() => expect(hooks.pruneExpiredRuns.mock.calls.length).toBeGreaterThan(1));
    await svc.stop('x');
    await done;
  });
});
