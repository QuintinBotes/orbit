import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, TaskResult } from '../../../src/adapters/types.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { getWorker, markWorkerRunning, planWorker } from '../../../src/storage/workers.ts';
import { planCheckRun, markCheckRunning } from '../../../src/evidence/store.ts';
import { shimPath, type ShimIntent } from '../../../src/evidence/check-shim.ts';
import { reconcileOnStart, stopRowProcess, stopWorker, type ReconcileOptions } from '../../../src/recovery/reconcile.ts';
import { counters, makeRun, setup } from './helpers.ts';

const DEAD = 2_000_000_000;
const OWNER = 'ctl-1';

const dirs: string[] = [];
const kids: ChildProcess[] = [];
const locked: string[] = [];
afterEach(() => {
  for (const k of kids.splice(0)) {
    try {
      process.kill(-k.pid!, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  for (const d of locked.splice(0)) chmodSync(d, 0o700);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

let base: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-rec-'));
  dirs.push(base);
});

function wdir(name: string): string {
  const d = join(base, 'workers', name);
  mkdirSync(d, { recursive: true });
  return d;
}

function sleeper(): { pid: number; start: string } {
  const child = spawn('sleep', ['60'], { detached: true, stdio: 'ignore' });
  child.unref();
  kids.push(child);
  return { pid: child.pid!, start: processStartTime(child.pid!)! };
}

function writePid(dir: string, p: { shimPid: number; shimStart?: string | null; pgid?: number; childPid?: number | null; childStart?: string | null }): void {
  writeFileSync(join(dir, 'pid.json'), JSON.stringify({ version: 1, shimPid: p.shimPid, shimStart: p.shimStart ?? null, pgid: p.pgid ?? p.shimPid, childPid: p.childPid ?? null, childStart: p.childStart ?? null, sessionId: null, argvHash: 'h', startedAt: 1 }));
}

function writeExit(dir: string): void {
  writeFileSync(join(dir, 'exit.json'), JSON.stringify({ version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, endedAt: 2, startedAt: 1 }));
}

const RESULT: TaskResult = { status: 'succeeded', structured: { ok: true }, text: 't', error: null, exitCode: 0, usage: { provider: 'claude', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' }, durationMs: 5 };

function adapter(collect: () => Promise<TaskResult | null>): Record<string, ProviderAdapter> {
  return { claude: { id: 'claude', collectResult: collect } as unknown as ProviderAdapter };
}

function plan(db: OrbitDb, clock: ReturnType<typeof setup>['clock'], id: string, dir: string, role: 'implementer' | 'inquisitor' = 'implementer') {
  return planWorker(db, { id, runId: 'r1', role, provider: 'claude', workerDir: dir, cwd: '/wt' }, clock);
}

function reconcile(db: OrbitDb, clock: ReturnType<typeof setup>['clock'], extra: Partial<ReconcileOptions> = {}) {
  return reconcileOnStart({ db, ownerId: OWNER, clock, adapters: {}, graceMs: 100, runDirFor: () => join(base, 'run'), ...extra });
}

const eventTypes = (db: OrbitDb): string[] => db.all<{ type: string }>("SELECT type FROM events WHERE run_id = 'r1' ORDER BY id").map((r) => r.type);

describe('reconcile: observing a worker directory', () => {
  it('an unreadable launch.json counts as no launch: a PLANNED worker is unlaunched, a RUNNING one without a pid file is lost and restarted', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    const d1 = wdir('w1');
    writeFileSync(join(d1, 'launch.json'), '{not json');
    plan(db, clock, 'w1', d1);
    const d2 = wdir('w2');
    writeFileSync(join(d2, 'launch.json'), '{not json');
    plan(db, clock, 'w2', d2);
    markWorkerRunning(db, 'w2', { pid: DEAD, pgid: DEAD, procStart: 'x' }, clock);
    const rep = await reconcile(db, clock);
    const byId = Object.fromEntries(rep.runs[0]!.workers.map((w) => [w.workerId, w]));
    expect(byId.w1).toMatchObject({ observation: 'unlaunched', restartPlanned: false });
    expect(byId.w2).toMatchObject({ observation: 'lost', restartPlanned: true, state: 'PLANNED' });
    expect(byId.w2!.detail).toContain('holds no launch or pid record');
    expect(getWorker(db, 'w2').restartCount).toBe(1);
    expect(existsSync(join(d2, 'attempts', '1', 'launch.json'))).toBe(true);
  });

  it('a launch recorded moments ago is starting; one older than the grace with no pid.json is lost', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    const d = wdir('w1');
    writeFileSync(join(d, 'launch.json'), JSON.stringify({ version: 1, provider: 'claude', workerId: 'w1', argvHash: 'h', sessionId: null, requestedAt: clock.now() }));
    plan(db, clock, 'w1', d);
    const first = await reconcile(db, clock, { startGraceMs: 20_000 });
    expect(first.runs[0]!.workers[0]).toMatchObject({ observation: 'starting', restartPlanned: false });
    clock.advance(30_000);
    const second = await reconcile(db, clock, { startGraceMs: 20_000 });
    expect(second.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true });
    expect(second.runs[0]!.workers[0]!.detail).toBe('a launch was recorded but the shim never wrote pid.json');
  });

  it('a worker that never started in a run being cancelled is closed CANCELLED, not left PLANNED', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const d = wdir('w1');
    writeFileSync(join(d, 'launch.json'), JSON.stringify({ version: 1, provider: 'claude', workerId: 'w1', argvHash: 'h', sessionId: null, requestedAt: clock.now() }));
    plan(db, clock, 'w1', d);
    plan(db, clock, 'w2', wdir('w2'));
    requestCancel(db, 'r1', 'user', clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers.map((w) => [w.workerId, w.observation, w.state])).toEqual([
      ['w1', 'orphan-terminated', 'CANCELLED'],
      ['w2', 'orphan-terminated', 'CANCELLED'],
    ]);
    expect(getWorker(db, 'w1').error).toBe('never started: run has a durable cancellation request');
    expect(rep.summary.orphansTerminated).toBe(2);
  });

  it('a worker with its own cancellation request but a live run says so in the reason', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    plan(db, clock, 'w1', wdir('w1'));
    db.run('UPDATE workers SET cancel_requested = 1 WHERE id = ?', 'w1');
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'orphan-terminated', state: 'CANCELLED' });
    expect(getWorker(db, 'w1').error).toBe('never started: worker has a durable cancellation request');
  });
});

describe('reconcile: collecting finished workers', () => {
  it('reports a finished worker uncollected when its provider has no adapter', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const d = wdir('w1');
    writePid(d, { shimPid: DEAD });
    writeExit(d);
    plan(db, clock, 'w1', d);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'finished-uncollected', adoptedFromPidFile: true, state: 'RUNNING' });
    expect(rep.runs[0]!.workers[0]!.detail).toBe('no adapter for provider claude; the controller must collect this result');
  });

  it('reports it uncollected when the adapter has no result, and records an adapter that throws without losing the pass', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const d1 = wdir('w1');
    writePid(d1, { shimPid: DEAD });
    writeExit(d1);
    plan(db, clock, 'w1', d1);
    const none = await reconcile(db, clock, { adapters: adapter(async () => null) });
    expect(none.runs[0]!.workers[0]).toMatchObject({ observation: 'finished-uncollected', detail: 'the adapter could not collect the result' });
    const boom = await reconcile(db, clock, {
      adapters: adapter(async () => {
        throw new Error('cannot read result sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF');
      }),
    });
    expect(boom.runs[0]!.workers[0]!.observation).toBe('finished-uncollected');
    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = 'r1' AND type = 'recovery.collect-failed'");
    expect(JSON.parse(ev!.data_json).error).toContain('cannot read result');
    expect(ev!.data_json).not.toContain('abcdefghijklmnopqrstuvwxyz');
  });

  it('collects with the caller schema when one is given and records the result once', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const d = wdir('w1');
    writePid(d, { shimPid: DEAD });
    writeExit(d);
    plan(db, clock, 'w1', d);
    const seen: unknown[] = [];
    const schema = { type: 'object', title: 'custom' };
    const rep = await reconcile(db, clock, {
      adapters: adapter(async () => RESULT),
      outputSchemaFor: (w) => (seen.push(w.id), schema),
    });
    expect(seen).toEqual(['w1']);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'finished', state: 'SUCCEEDED' });
    expect(rep.collected).toMatchObject([{ workerId: 'w1', result: { status: 'succeeded' } }]);
    expect(rep.summary.workersFinished).toBe(1);
  });

  it('a lost worker whose provider has no adapter still gets restarted: nothing partial is collected', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    const d = wdir('w1');
    writePid(d, { shimPid: DEAD });
    plan(db, clock, 'w1', d);
    markWorkerRunning(db, 'w1', { pid: DEAD, pgid: DEAD, procStart: 'x' }, clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true });
    expect(rep.collected).toEqual([]);
  });
});

describe('reconcile: lost workers and the recovery budget', () => {
  function lost(db: OrbitDb, clock: ReturnType<typeof setup>['clock'], id = 'w1', role: 'implementer' | 'inquisitor' = 'implementer'): string {
    const d = wdir(id);
    plan(db, clock, id, d, role);
    markWorkerRunning(db, id, { pid: DEAD, pgid: DEAD, procStart: 'x' }, clock);
    return d;
  }

  it('an inquisitor is finished LOST without a restart or a spent attempt', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    lost(db, clock, 'w1', 'inquisitor');
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: false, state: 'LOST' });
    expect(rep.runs[0]!.workers[0]!.detail).toContain('the inquisition step starts its own worker');
    expect(db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = 'r1'")?.used).toBe(0);
  });

  it('a worker past its restart limit is given up on, LOST', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    lost(db, clock);
    const rep = await reconcile(db, clock, { maxWorkerRestarts: 0 });
    expect(rep.runs[0]!.workers[0]).toMatchObject({ restartRefused: 'restart-limit', state: 'LOST' });
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('a spent recovery budget ends the run EXHAUSTED and the worker is LOST', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 0 });
    lost(db, clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ restartRefused: 'budget', state: 'LOST' });
    expect(getRun(db, 'r1').state).toBe('EXHAUSTED');
    expect(rep.summary.runsExhausted).toBeGreaterThanOrEqual(1);
  });

  it('a ledger that refuses after the budget check passed also ends the run EXHAUSTED', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    lost(db, clock);
    const rep = await reconcile(db, clock, {
      ledgerFor: () => ({
        consume: () => {
          throw new OrbitError('BUDGET_EXHAUSTED', 'ledger says no', {});
        },
      }),
    });
    expect(rep.runs[0]!.workers[0]).toMatchObject({ restartRefused: 'budget', state: 'LOST' });
    expect(getRun(db, 'r1').state).toBe('EXHAUSTED');
    expect(getRun(db, 'r1').outcomeReason).toContain('ledger says no');
  });

  it('a cancellation that lands while the restart is being recorded gives up CANCELLED without planning anything', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    lost(db, clock);
    const rep = await reconcile(db, clock, {
      ledgerFor: () => ({
        consume: () => {
          throw new OrbitError('CANCELLED', 'run was cancelled', {});
        },
      }),
    });
    expect(rep.runs[0]!.workers[0]).toMatchObject({ restartRefused: 'cancelled', state: 'LOST', restartPlanned: false });
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('any other failure while recording the restart is reported for that worker and the pass goes on', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    lost(db, clock);
    const rep = await reconcile(db, clock, {
      ledgerFor: () => ({
        consume: () => {
          throw new Error('disk full');
        },
      }),
    });
    expect(rep.errors).toEqual([{ runId: 'r1', message: 'worker w1: disk full' }]);
    expect(rep.runs).toHaveLength(1);
    expect(eventTypes(db)).toContain('recovery.worker-error');
  });

  it('reports a failure to end the run after a refused restart instead of throwing', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 0 });
    lost(db, clock);
    let armed = false;
    const flaky = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'run') {
          return (sql: string, ...args: unknown[]) => {
            if (args.includes('recovery.restart-refused')) armed = true;
            return (target.run as (...a: unknown[]) => unknown)(sql, ...args);
          };
        }
        if (prop === 'tx') {
          return (fn: () => unknown) => {
            if (armed) {
              armed = false;
              throw new Error('database is locked');
            }
            return target.tx(fn as never);
          };
        }
        const v = Reflect.get(target, prop, receiver);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as OrbitDb;
    const rep = await reconcile(flaky, clock);
    expect(rep.errors).toEqual([{ runId: 'r1', message: 'could not end the run after a refused restart: database is locked' }]);
    expect(getRun(db, 'r1').state).toBe('IMPLEMENTING');
  });

  it('when the restart is refused for budget, the workers left running in the ended run are stopped on the second pass', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 0 });
    lost(db, clock, 'w1');
    plan(db, clock, 'w2', wdir('w2'));
    const rep = await reconcile(db, clock);
    expect(getRun(db, 'r1').state).toBe('EXHAUSTED');
    const byId = Object.fromEntries(rep.runs[0]!.workers.map((w) => [w.workerId, w]));
    expect(byId.w1).toMatchObject({ restartRefused: 'budget', state: 'LOST' });
    expect(byId.w2).toMatchObject({ observation: 'orphan-terminated', state: 'CANCELLED' });
    expect(rep.runs[0]!.workers).toHaveLength(2);
  });

  it('refuses to restart beside a process the row names but cannot be verified as the worker', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    plan(db, clock, 'w1', wdir('w1'));
    // Our own pid is alive, and with no recorded start time nothing proves it is the worker.
    markWorkerRunning(db, 'w1', { pid: process.pid, pgid: process.pid, procStart: null }, clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartRefused: 'archive-failed', state: 'RUNNING', restartPlanned: false });
    expect(rep.runs[0]!.workers[0]!.detail).toContain('could not be verified or stopped');
    expect(eventTypes(db)).toContain('recovery.restart-refused');
    expect(getWorker(db, 'w1').state).toBe('RUNNING');
  });

  it('stops the recorded process group of a worker whose files are gone, then restarts', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    const s = sleeper();
    plan(db, clock, 'w1', wdir('w1'));
    markWorkerRunning(db, 'w1', { pid: s.pid, pgid: s.pid, procStart: s.start }, clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true });
    expect(rep.runs[0]!.workers[0]!.detail).toContain(`recorded process ${s.pid} was still running; its group was stopped`);
    expect(() => process.kill(s.pid, 0)).toThrow();
  });

  it('gives up LOST when the lost attempt cannot be archived', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    counters(db, 'r1', { recovery_attempts: 3 });
    const d = wdir('w1');
    writePid(d, { shimPid: DEAD });
    plan(db, clock, 'w1', d);
    markWorkerRunning(db, 'w1', { pid: DEAD, pgid: DEAD, procStart: 'x' }, clock);
    chmodSync(d, 0o500);
    locked.push(d);
    if (process.getuid?.() === 0) return;
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ restartRefused: 'archive-failed', state: 'LOST', restartPlanned: false });
    expect(rep.runs[0]!.workers[0]!.detail).toMatch(/^could not archive the lost attempt: /);
    expect(readdirSync(d)).toContain('pid.json');
  });
});

describe('stopRowProcess', () => {
  const row = (over: Record<string, unknown>) => ({ pid: null, pgid: null, procStart: null, ...over }) as never;

  it('a row with no pid names no process', async () => {
    expect(await stopRowProcess(50, row({}))).toBe('gone');
  });

  it('a process that is gone, or whose pid now belongs to another process, is gone', async () => {
    expect(await stopRowProcess(50, row({ pid: DEAD, pgid: DEAD, procStart: 'x' }))).toBe('gone');
    const s = sleeper();
    expect(await stopRowProcess(50, row({ pid: s.pid, pgid: s.pid, procStart: 'Mon Jan 1 00:00:00 2001' }))).toBe('gone');
    expect(() => process.kill(s.pid, 0)).not.toThrow();
  });

  it('a live process with no recorded start is unknown and left alone', async () => {
    const s = sleeper();
    expect(await stopRowProcess(50, row({ pid: s.pid, pgid: s.pid }))).toBe('unknown');
    expect(() => process.kill(s.pid, 0)).not.toThrow();
  });

  it('a verified process without a usable group is unknown: nothing is signalled', async () => {
    const s = sleeper();
    expect(await stopRowProcess(50, row({ pid: s.pid, pgid: null, procStart: s.start }))).toBe('unknown');
    expect(await stopRowProcess(50, row({ pid: s.pid, pgid: 1, procStart: s.start }))).toBe('unknown');
    expect(() => process.kill(s.pid, 0)).not.toThrow();
  });

  it('a group this process refuses to signal is unknown', async () => {
    const s = sleeper();
    expect(await stopRowProcess(50, row({ pid: s.pid, pgid: process.pid, procStart: s.start }))).toBe('unknown');
  });

  it('a verified process in its own group is stopped', async () => {
    const s = sleeper();
    expect(await stopRowProcess(100, row({ pid: s.pid, pgid: s.pid, procStart: s.start }))).toBe('stopped');
  });
});

describe('stopWorker', () => {
  it('refuses to record a worker CANCELLED while its provider process survives the stop', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const s = sleeper();
    const d = wdir('w1');
    // The shim and its group are gone but the provider it started still runs; there is no group left to signal.
    writePid(d, { shimPid: DEAD, pgid: DEAD, childPid: s.pid, childStart: s.start });
    plan(db, clock, 'w1', d);
    markWorkerRunning(db, 'w1', { pid: DEAD, pgid: DEAD, procStart: 'x' }, clock);
    await expect(stopWorker({ db, clock, ownerId: OWNER, adapters: {}, graceMs: 50 }, getWorker(db, 'w1'), 'test')).rejects.toThrow(/could not be stopped/);
    expect(getWorker(db, 'w1')).toMatchObject({ state: 'RUNNING', cancelRequested: true });
    expect(() => process.kill(s.pid, 0)).not.toThrow();
  });

  it('records the result of a worker that finished while being stopped, and tolerates an adapter that cannot read it', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const d1 = wdir('w1');
    writePid(d1, { shimPid: DEAD });
    writeExit(d1);
    plan(db, clock, 'w1', d1);
    markWorkerRunning(db, 'w1', { pid: DEAD, pgid: DEAD, procStart: 'x' }, clock);
    const ok = await stopWorker({ db, clock, ownerId: OWNER, adapters: adapter(async () => RESULT), graceMs: 50 }, getWorker(db, 'w1'), 'abandon');
    expect(ok).toMatchObject({ state: 'CANCELLED', exitCode: 0, error: 'abandon' });
    const d2 = wdir('w2');
    writePid(d2, { shimPid: DEAD });
    writeExit(d2);
    plan(db, clock, 'w2', d2);
    markWorkerRunning(db, 'w2', { pid: DEAD, pgid: DEAD, procStart: 'x' }, clock);
    const bad = await stopWorker(
      {
        db,
        clock,
        ownerId: OWNER,
        adapters: adapter(async () => {
          throw new Error('unreadable');
        }),
      },
      getWorker(db, 'w2'),
      'abandon',
    );
    expect(bad).toMatchObject({ state: 'CANCELLED', exitCode: null });
  });

  it('refuses when there is no pid.json and the recorded process cannot be verified', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    plan(db, clock, 'w1', wdir('w1'));
    markWorkerRunning(db, 'w1', { pid: process.pid, pgid: process.pid, procStart: null }, clock);
    await expect(stopWorker({ db, clock, ownerId: OWNER, adapters: {} }, getWorker(db, 'w1'), 'test')).rejects.toThrow(/no pid.json and its recorded process/);
    expect(getWorker(db, 'w1').state).toBe('RUNNING');
  });
});

describe('reconcile: checks', () => {
  function openCheck(db: OrbitDb, clock: ReturnType<typeof setup>['clock'], name: string) {
    const row = planCheckRun(db, { runId: 'r1', candidateId: null, checkId: name, kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: 'sha256:x', command: ['sleep', '30'], cwd: '/repo', isolation: 'none', limitations: [] }, clock);
    markCheckRunning(db, row.id, 1, clock);
    const dir = join(base, 'run', 'baseline', name);
    mkdirSync(dir, { recursive: true });
    return { id: row.id, dir };
  }
  const intent = (id: string, over: Partial<ShimIntent> = {}): ShimIntent => ({ token: 'tok', checkRunId: id, argv: ['sleep', '30'], cwd: '/repo', timeoutMs: 1000, killGraceMs: 50, maxOutputBytes: 1000, writtenAt: Date.now(), ...over });

  it('a check with no directory has not started', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    openCheck(db, clock, 'lint');
    // The row exists but nothing was written for it: no intent.json, so no directory is matched.
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'not-started', closed: false, terminated: false });
  });

  it('records a pid file whose token is not this check as not started', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const c = openCheck(db, clock, 'lint');
    writeFileSync(shimPath(c.dir, 'intent'), JSON.stringify(intent(c.id)));
    writeFileSync(shimPath(c.dir, 'pid'), JSON.stringify({ token: 'other', shimPid: process.pid, childPid: null, childPgid: null, startedAt: Date.now() }));
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'not-started' });
  });

  it('does not signal a shim whose identity cannot be established when the run is over, and says so', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const c = openCheck(db, clock, 'lint');
    const s = sleeper();
    writeFileSync(shimPath(c.dir, 'intent'), JSON.stringify(intent(c.id, { writtenAt: Date.now() - 3_600_000 })));
    // pid.json only: the identity is judged from the recorded time, and a process started now is not what was recorded an hour ago: a recycled pid.
    writeFileSync(shimPath(c.dir, 'pid'), JSON.stringify({ token: 'tok', shimPid: s.pid, childPid: null, childPgid: null, startedAt: Date.now() - 3_600_000 }));
    requestCancel(db, 'r1', 'user', clock);
    const rep = await reconcile(db, clock);
    // A recycled pid reads as dead: the check is lost, its row is closed, and the stranger is untouched.
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', closed: true });
    expect(() => process.kill(s.pid, 0)).not.toThrow();
  });

  it('closes an unfinished check of an ended run even when nothing of it ran', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    const c = openCheck(db, clock, 'lint');
    writeFileSync(shimPath(c.dir, 'intent'), JSON.stringify(intent(c.id)));
    requestCancel(db, 'r1', 'user', clock);
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'not-started', closed: true });
    expect(db.get<{ status: string; excerpt: string }>('SELECT status, excerpt FROM check_runs WHERE id = ?', c.id)).toMatchObject({ status: 'CANCELLED', excerpt: 'closed by recovery: run has a durable cancellation request' });
  });

  it('finds app fixtures only to a bounded depth', async () => {
    const { db, clock } = setup();
    makeRun(db, clock, 'r1', OWNER);
    let deep = join(base, 'run', 'evidence');
    for (let i = 0; i < 9; i++) deep = join(deep, `d${i}`);
    mkdirSync(join(deep, 'app'), { recursive: true });
    writeFileSync(join(deep, 'app', 'app.json'), '{}');
    const rep = await reconcile(db, clock);
    expect(rep.runs[0]!.apps).toEqual([]);
  });
});
