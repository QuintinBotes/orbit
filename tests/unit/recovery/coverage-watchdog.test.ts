import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const procMock = vi.hoisted(() => ({ isAlive: vi.fn<(pid: number, start?: string | null) => boolean>() }));
vi.mock('../../../src/core/proc.ts', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/proc.ts')>();
  procMock.isAlive.mockImplementation(actual.isAlive);
  return { ...actual, isAlive: procMock.isAlive };
});

const { acquireLease, getRun } = await import('../../../src/controller/run-store.ts');
const { planWorker, markWorkerRunning } = await import('../../../src/storage/workers.ts');
const { getController, registerController } = await import('../../../src/storage/controllers.ts');
const { LOG_FILE } = await import('../../../src/adapters/shim.ts');
const { DEFAULT_WATCHDOG, watchdogLoop, watchdogTick } = await import('../../../src/recovery/watchdog.ts');
const { ManualClock } = await import('../../../src/core/clock.ts');
const { counters, eventTypes, makeRun, setup } = await import('./helpers.ts');

const MIN = 60_000;
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('watchdog edges', () => {
  it('never reports its own controller as stale', async () => {
    const { db, clock } = setup();
    registerController(db, { id: 'ctl-me', pid: 2_000_000_000, host: 'h1', mode: 'service' }, clock);
    clock.advance(10 * MIN);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-me', host: 'h1', adapters: {} });
    expect(rep.findings).toEqual([]);
    expect(getController(db, 'ctl-me').stoppedAt).toBeNull();
  });

  it('a dead controller is reported but not marked stopped in dry-run mode', async () => {
    const { db, clock } = setup();
    registerController(db, { id: 'ctl-dead', pid: 2_000_000_000, host: 'h1', mode: 'service' }, clock);
    clock.advance(10 * MIN);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-me', host: 'h1', adapters: {}, dryRun: true });
    expect(rep.findings).toMatchObject([{ kind: 'stale-controller', controllerId: 'ctl-dead', action: null }]);
    expect(getController(db, 'ctl-dead').stoppedAt).toBeNull();
  });

  it('a controller on another host is never inspected through the local process table', async () => {
    const { db, clock } = setup();
    registerController(db, { id: 'ctl-far', pid: process.pid, host: 'elsewhere', mode: 'service' }, clock);
    clock.advance(10 * MIN);
    procMock.isAlive.mockClear();
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-me', host: 'h1', adapters: {} });
    expect(procMock.isAlive).not.toHaveBeenCalled();
    expect(rep.findings[0]).toMatchObject({ kind: 'stale-controller', action: 'marked-stopped' });
  });

  it('when the process table cannot be read a controller is not declared dead on a guess', async () => {
    const { db, clock } = setup();
    registerController(db, { id: 'ctl-x', pid: 4242, host: 'h1', procStart: 'Sat Oct 3 09:37:05 2026', mode: 'service' }, clock);
    clock.advance(10 * MIN);
    procMock.isAlive.mockImplementationOnce(() => {
      throw new Error('ps is not installed');
    });
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-me', host: 'h1', adapters: {} });
    expect(rep.findings).toMatchObject([{ kind: 'wedged-controller', controllerId: 'ctl-x', action: null }]);
    expect(getController(db, 'ctl-x').stoppedAt).toBeNull();
  });

  it('skips an expired lease held by this controller itself', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-me', ['PREFLIGHT'], 30_000);
    clock.advance(10 * MIN);
    acquireLease(db, 'r1', 'ctl-me', 1, clock);
    clock.advance(10);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-me', host: 'h1', adapters: {}, config: { stallMs: 10 * MIN * 100 } });
    expect(rep.findings.filter((f) => f.kind === 'expired-lease')).toEqual([]);
  });

  it('a stuck step with no lease at all is reported as not ours, naming the absence', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    db.run("DELETE FROM leases WHERE run_id = 'r1'");
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, workerActivityAt: () => null });
    expect(rep.findings[0]).toMatchObject({ kind: 'stuck-step', action: null });
    expect(rep.findings[0]?.detail).toContain('lease: none');
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('a lease that expired is not ours to act on even for its former holder', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1', undefined, 1_000);
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, workerActivityAt: () => null });
    expect(rep.findings.find((f) => f.kind === 'stuck-step')?.detail).toContain('not ours to act on (lease: ctl-1)');
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('a run whose recovery cannot be recorded becomes an error finding and the other runs are still judged', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'bad', 'ctl-1');
    makeRun(db, clock, 'good', 'ctl-1');
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'bad', 'ctl-1', 60_000, clock);
    acquireLease(db, 'good', 'ctl-1', 60_000, clock);
    counters(db, 'good', { recovery_attempts: 3 });
    const rep = await watchdogTick({
      db,
      clock,
      ownerId: 'ctl-1',
      adapters: {},
      workerActivityAt: () => null,
      ledgerFor: (id) =>
        id === 'bad'
          ? {
              consume: () => {
                throw new Error('ledger corrupt');
              },
            }
          : null,
    });
    const err = rep.findings.find((f) => f.kind === 'error');
    expect(err).toMatchObject({ runId: 'bad', action: null });
    expect(err?.detail).toBe('the watchdog could not act on run bad: ledger corrupt');
    expect(getRun(db, 'bad').state).toBe('IMPLEMENTING');
    expect(getRun(db, 'good').state).toBe('RECOVERING');
  });

  it('a non-Error failure is reported with its text', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({
      db,
      clock,
      ownerId: 'ctl-1',
      adapters: {},
      workerActivityAt: () => null,
      ledgerFor: () => ({
        consume: () => {
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw 'plain string';
        },
      }),
    });
    expect(rep.findings.find((f) => f.kind === 'error')?.detail).toBe('the watchdog could not act on run r1: plain string');
  });

  it('a pending cancellation leaves the run to the controller after the workers are stopped', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', 'r1');
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, workerActivityAt: () => null });
    expect(rep.findings).toMatchObject([{ kind: 'stuck-step', action: null }]);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
    expect(eventTypes(db, 'r1')).not.toContain('recovery.attempt');
  });

  it('reads the worker log mtime as activity by default and treats a missing log as none', async () => {
    const { db, clock } = setup();
    // The log's mtime is real time, so the run's clock starts at real time too.
    const real = new ManualClock(Date.now());
    const db2 = db;
    makeRun(db2, real, 'r1', 'ctl-1');
    const dir = mkdtempSync(join(tmpdir(), 'orbit-wd-'));
    dirs.push(dir);
    const wdir = join(dir, 'w1');
    mkdirSync(wdir);
    planWorker(db2, { id: 'w1', runId: 'r1', role: 'implementer', provider: 'claude', workerDir: wdir, cwd: '/wt' }, real);
    markWorkerRunning(db2, 'w1', { pid: 4242, pgid: 4242, procStart: 'x' }, real);
    real.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db2, 'r1', 'ctl-1', 60_000, real);
    // No log yet: no evidence of life, the step is stuck.
    const none = await watchdogTick({ db: db2, clock: real, ownerId: 'ctl-1', adapters: {}, dryRun: true });
    expect(none.findings[0]?.kind).toBe('stuck-step');
    // A log written a minute ago keeps the step alive.
    writeFileSync(join(wdir, LOG_FILE), '{}\n');
    const t = (real.now() - MIN) / 1000;
    utimesSync(join(wdir, LOG_FILE), t, t);
    const alive = await watchdogTick({ db: db2, clock: real, ownerId: 'ctl-1', adapters: {}, dryRun: true });
    expect(alive.findings).toEqual([]);
  });
});

describe('watchdog: timeouts and step starts', () => {
  it('falls back to the default timeout for a state whose own timeout is unset', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    clock.advance(6 * MIN);
    const cfg = { stepTimeoutMs: { IMPLEMENTING: undefined }, defaultStepTimeoutMs: 5 * MIN, stallMs: 100 * MIN };
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, dryRun: true, workerActivityAt: () => null, config: cfg });
    expect(rep.findings).toMatchObject([{ kind: 'stuck-step', runId: 'r1' }]);
    expect(rep.findings[0]?.detail).toContain('the step timeout is 5 min');
  });

  it('measures a step from the run\'s last update when no transition into its state was recorded', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    // The state was set without a transition event (a repaired database): the run's own update time is the start.
    db.run("UPDATE runs SET state = 'PLANNING', updated_at = ? WHERE id = 'r1'", clock.now());
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.PLANNING! + MIN);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, dryRun: true, workerActivityAt: () => null });
    expect(rep.findings).toMatchObject([{ kind: 'stuck-step', runId: 'r1', action: null }]);
    expect(rep.findings[0]?.detail).toContain('has been in PLANNING for 31 min');
  });

  it('stops the step\'s workers with the default grace when the config sets none', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 3 });
    planWorker(db, { id: 'w1', runId: 'r1', role: 'implementer', provider: 'claude', workerDir: '/nonexistent/w1', cwd: '/wt' }, clock);
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, workerActivityAt: () => null });
    expect(rep.findings).toMatchObject([{ kind: 'stuck-step', action: 'abandoned-to-recovering' }]);
    expect(getRun(db, 'r1').state).toBe('RECOVERING');
  });
});

describe('watchdogLoop', () => {
  it('reports each tick, survives a failing one, and stops when aborted', async () => {
    const { db, clock } = setup();
    const ac = new AbortController();
    const reports: number[] = [];
    const errors: unknown[] = [];
    let ticks = 0;
    const sleepy = Object.assign(Object.create(clock), {
      sleep: async () => {
        ticks++;
        if (ticks === 1) db.close();
        if (ticks === 3) ac.abort();
      },
    }) as typeof clock;
    await watchdogLoop({ db, clock: sleepy, ownerId: 'ctl-1', adapters: {}, intervalMs: 10, signal: ac.signal, onReport: (r) => reports.push(r.at), onError: (e) => errors.push(e) });
    expect(reports).toHaveLength(1);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('returns at once when already aborted and without callbacks tolerates failures', async () => {
    const { db, clock } = setup();
    const ac = new AbortController();
    ac.abort();
    await watchdogLoop({ db, clock, ownerId: 'ctl-1', adapters: {}, intervalMs: 10, signal: ac.signal });
    const ac2 = new AbortController();
    db.close();
    const sleepy = Object.assign(Object.create(clock), {
      sleep: async () => {
        ac2.abort();
      },
    }) as typeof clock;
    await expect(watchdogLoop({ db, clock: sleepy, ownerId: 'ctl-1', adapters: {}, intervalMs: 10, signal: ac2.signal })).resolves.toBeUndefined();
  });

  it('stops right after a tick when the signal fires during it, without sleeping', async () => {
    const { db, clock } = setup();
    const ac = new AbortController();
    const slept = vi.fn();
    const clk = Object.assign(Object.create(clock), { sleep: slept }) as typeof clock;
    await watchdogLoop({ db, clock: clk, ownerId: 'ctl-1', adapters: {}, intervalMs: 10, signal: ac.signal, onReport: () => ac.abort() });
    expect(slept).not.toHaveBeenCalled();
  });
});
