import { describe, expect, it } from 'vitest';
import { acquireLease, getRun, markProgress, setPaused } from '../../../src/controller/run-store.ts';
import { getWorker, markWorkerRunning, planWorker } from '../../../src/storage/workers.ts';
import { heartbeatController, registerController, getController } from '../../../src/storage/controllers.ts';
import { DEFAULT_WATCHDOG, watchdogLoop, watchdogTick } from '../../../src/recovery/watchdog.ts';
import { counters, eventTypes, makeRun, setup } from './helpers.ts';

const MIN = 60_000;
const common = { adapters: {}, workerActivityAt: () => null, config: { graceMs: 50 } };

describe('watchdog', () => {
  it('leaves a run alone while it is within its step timeout and has recent progress', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    clock.advance(5 * MIN);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common });
    expect(rep.findings).toEqual([]);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('reports a stall once per quiet period, without changing the run', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    clock.advance(DEFAULT_WATCHDOG.stallMs + MIN);
    const first = await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common });
    expect(first.findings).toMatchObject([{ kind: 'stalled-run', runId: 'r1', action: null }]);
    expect((await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common })).findings).toEqual([]);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
    expect(eventTypes(db, 'r1')).toContain('watchdog.stall');
    // Progress ends the quiet period; a later stall is reported afresh.
    clock.advance(MIN);
    markProgress(db, 'r1', 'fixed_checks', {}, clock);
    clock.advance(DEFAULT_WATCHDOG.stallMs + MIN);
    expect((await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common })).findings).toHaveLength(1);
  });

  it('abandons a stuck step it owns: workers stopped, run RECOVERING with the stage to resume, one recovery attempt spent', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 3 });
    planWorker(db, { id: 'w1', runId: 'r1', role: 'implementer', provider: 'claude', workerDir: '/nonexistent/w1', cwd: '/wt' }, clock);
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common });
    expect(rep.findings).toMatchObject([{ kind: 'stuck-step', runId: 'r1', action: 'abandoned-to-recovering' }]);
    const run = getRun(db, 'r1');
    expect(run.state).toBe('RECOVERING');
    expect(run.resumeState).toBe('IMPLEMENTING');
    expect(getWorker(db, 'w1')).toMatchObject({ state: 'CANCELLED', cancelRequested: true });
    expect(db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = 'r1' AND counter = 'recovery_attempts'")?.used).toBe(1);
  });

  it('a worker still writing its log counts as activity, so a busy step is not abandoned', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    planWorker(db, { id: 'w1', runId: 'r1', role: 'implementer', provider: 'claude', workerDir: '/w1', cwd: '/wt' }, clock);
    markWorkerRunning(db, 'w1', { pid: 4242, pgid: 4242, procStart: 'x' }, clock);
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const lastWrite = clock.now() - MIN;
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, workerActivityAt: () => lastWrite });
    expect(rep.findings).toEqual([]);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
    // A log timestamp from another clock (the future) is not evidence of life.
    const rep2 = await watchdogTick({ db, clock, ownerId: 'ctl-1', adapters: {}, workerActivityAt: () => clock.now() + 10 * MIN, config: { graceMs: 20 } });
    expect(rep2.findings[0]?.kind).toBe('stuck-step');
  });

  it('exhausts the run when the recovery budget is spent, instead of abandoning forever', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1');
    counters(db, 'r1', { recovery_attempts: 0 });
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common });
    expect(rep.findings[0]).toMatchObject({ kind: 'stuck-step', action: 'exhausted' });
    expect(getRun(db, 'r1').state).toBe('EXHAUSTED');
  });

  it('a recovery that never finishes ends BLOCKED for a person rather than recovering from recovery forever', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', 'ctl-1', ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING']);
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.RECOVERING! + MIN);
    acquireLease(db, 'r1', 'ctl-1', 60_000, clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common });
    expect(rep.findings[0]).toMatchObject({ kind: 'stuck-step', action: 'blocked' });
    const run = getRun(db, 'r1');
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toMatch(/orbit resume r1/);
  });

  it('reports but does not act on a run another controller leases, on paused runs, or in dry-run mode', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'theirs', 'ctl-2');
    makeRun(db, clock, 'paused', 'ctl-1');
    setPaused(db, 'paused', true, 'cli', clock);
    makeRun(db, clock, 'mine', 'ctl-1');
    clock.advance(DEFAULT_WATCHDOG.stepTimeoutMs.IMPLEMENTING! + MIN);
    acquireLease(db, 'mine', 'ctl-1', 60_000, clock);
    acquireLease(db, 'theirs', 'ctl-2', 60_000, clock);
    const dry = await watchdogTick({ db, clock, ownerId: 'ctl-1', dryRun: true, ...common });
    expect(dry.findings.filter((f) => f.kind === 'stuck-step').map((f) => f.runId).sort()).toEqual(['mine', 'theirs']);
    expect(dry.findings.every((f) => f.action === null)).toBe(true);
    const real = await watchdogTick({ db, clock, ownerId: 'ctl-1', ...common });
    expect(getRun(db, 'theirs').state).toBe('IMPLEMENTING');
    expect(getRun(db, 'paused').state).toBe('IMPLEMENTING');
    expect(getRun(db, 'mine').state).toBe('RECOVERING');
    expect(real.findings.find((f) => f.runId === 'theirs')?.detail).toMatch(/not ours to act on/);
  });

  it('marks a controller whose heartbeat stopped and whose process is gone as stopped; its leases are reported, not stolen', async () => {
    const { db, clock } = setup();
    registerController(db, { id: 'ctl-dead', pid: 2_000_000_000, host: 'h1', mode: 'service' }, clock);
    registerController(db, { id: 'ctl-live', pid: 1, host: 'h1', mode: 'service' }, clock);
    makeRun(db, clock, 'r1', 'ctl-dead', ['PREFLIGHT'], 30_000);
    clock.advance(10 * MIN);
    heartbeatController(db, 'ctl-live', clock);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-me', host: 'h1', ...common });
    expect(rep.findings.some((f) => f.kind === 'stale-controller' && f.controllerId === 'ctl-dead')).toBe(true);
    expect(rep.findings.some((f) => f.kind === 'expired-lease' && f.runId === 'r1' && f.controllerId === 'ctl-dead')).toBe(true);
    expect(getController(db, 'ctl-dead').stoppedAt).not.toBeNull();
    expect(getController(db, 'ctl-live').stoppedAt).toBeNull();
    expect(db.get<{ owner_id: string }>("SELECT owner_id FROM leases WHERE run_id = 'r1'")?.owner_id).toBe('ctl-dead');
  });

  it('a stale heartbeat on a live process is a wedged controller: reported, never marked stopped', async () => {
    const { db, clock } = setup();
    registerController(db, { id: 'ctl-wedged', pid: process.pid, host: 'h1', mode: 'service' }, clock);
    clock.advance(10 * MIN);
    const rep = await watchdogTick({ db, clock, ownerId: 'ctl-me', host: 'h1', ...common });
    expect(rep.findings).toMatchObject([{ kind: 'wedged-controller', controllerId: 'ctl-wedged', action: null }]);
    expect(getController(db, 'ctl-wedged').stoppedAt).toBeNull();
  });

  it('loops until aborted and survives a failing tick', async () => {
    const { db, clock } = setup();
    const ac = new AbortController();
    const reports: number[] = [];
    const errors: unknown[] = [];
    let ticks = 0;
    // A closed database makes every tick fail; the loop keeps its schedule.
    db.close();
    await watchdogLoop({
      db, clock, ownerId: 'x', ...common, intervalMs: 1000, signal: ac.signal,
      onReport: (r) => reports.push(r.at),
      onError: (e) => { errors.push(e); if (++ticks === 3) ac.abort(); },
    });
    expect(errors).toHaveLength(3);
    expect(reports).toEqual([]);
  });
});
