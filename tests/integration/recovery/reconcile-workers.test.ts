import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readExitRecord, readPidRecord } from '../../../src/adapters/shim.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import { requestCancel, transition, getRun } from '../../../src/controller/run-store.ts';
import { requestWorkerCancel } from '../../../src/storage/workers.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { IMPLEMENTER_OUTPUT, OWNER, alive, canStripTypes, cleanupAll, clock, counterUsed, makeEnv, makeRun, planImplementer, seedCounters, sleep, startWorker, strangerProcess, waitFor, workerRow } from './helpers.ts';
import { implementerSpec } from '../adapters/helpers.ts';

afterEach(cleanupAll);

const SLOW = { sleepMs: 4_000, structured: IMPLEMENTER_OUTPUT };
const run = (env: ReturnType<typeof makeEnv>, extra: object = {}) => reconcileOnStart({ db: env.db, ownerId: OWNER, clock, adapters: env.adapters, graceMs: 300, ...extra });

describe.skipIf(!canStripTypes)('reconcileOnStart: workers', () => {
  it('a running worker is reattached, not duplicated: still one process, row RUNNING, nothing killed', async () => {
    const env = makeEnv();
    makeRun(env);
    const { shimPid, childPid } = await startWorker(env, SLOW);
    const rep = await run(env);
    expect(rep.runs[0]!.workers).toMatchObject([{ workerId: 'w1', observation: 'running', adoptedFromPidFile: false, restartPlanned: false }]);
    expect(workerRow(env).state).toBe('RUNNING');
    expect(alive(shimPid) && alive(childPid)).toBe(true);
    expect(readFileSync(env.f.argvLog, 'utf8').trim().split('\n')).toHaveLength(1);
    expect(rep.summary).toMatchObject({ workersRunning: 1, workersLost: 0, restartsPlanned: 0 });
  });

  it('a worker spawned but never recorded (crash between spawn and bookkeeping) is adopted from pid.json', async () => {
    const env = makeEnv();
    makeRun(env);
    const { handle } = await startWorker(env, SLOW, { recorded: false });
    expect(workerRow(env).state).toBe('PLANNED');
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'running', adoptedFromPidFile: true, state: 'RUNNING' });
    const row = env.db.get<{ pid: number; pgid: number; proc_start: string }>('SELECT pid, pgid, proc_start FROM workers WHERE id = ?', 'w1')!;
    expect(row.pid).toBe(handle.pid);
    expect(row.proc_start).toBe(readPidRecord(env.f.workerDir)!.shimStart);
  });

  it('a PLANNED worker with nothing launched is left for the controller to spawn', async () => {
    const env = makeEnv();
    makeRun(env);
    planImplementer(env);
    const rep = await run(env);
    expect(rep.runs[0]!.workers).toMatchObject([{ observation: 'unlaunched', state: 'PLANNED' }]);
  });

  it('exit.json present: the finished worker is collected, validated and recorded; usage is handed to the controller', async () => {
    const env = makeEnv();
    makeRun(env);
    await startWorker(env, { structured: IMPLEMENTER_OUTPUT });
    await waitFor(() => readExitRecord(env.f.workerDir));
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'finished', state: 'SUCCEEDED' });
    expect(workerRow(env)).toMatchObject({ state: 'SUCCEEDED', result_status: 'succeeded' });
    expect(rep.collected).toHaveLength(1);
    expect(rep.collected[0]!.result.status).toBe('succeeded');
    expect(rep.collected[0]!.result.usage.provider).toBe('claude');
    // Idempotent: a second pass has no active worker left to look at.
    expect((await run(env)).runs[0]!.workers).toEqual([]);
  });

  it('exit.json present but the worker failed: recorded FAILED with the adapter\'s classification', async () => {
    const env = makeEnv();
    makeRun(env);
    await startWorker(env, { structured: { nonsense: true } });
    await waitFor(() => readExitRecord(env.f.workerDir));
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]!.observation).toBe('finished');
    expect(workerRow(env).state).toBe('FAILED');
    expect(workerRow(env).result_status).toBe('malformed_output');
  });

  it('exit.json absent and every process dead: LOST, a bounded restart is planned, the worktree and archive are preserved', async () => {
    const env = makeEnv();
    makeRun(env);
    seedCounters(env, { recovery_attempts: 3 });
    const { shimPid, childPid } = await startWorker(env, SLOW);
    writeFileSync(join(env.f.repo, 'apps', 'wip.ts'), 'export const wip = true;\n');
    process.kill(shimPid, 'SIGKILL');
    process.kill(childPid, 'SIGKILL');
    await waitFor(() => !alive(shimPid) && !alive(childPid));
    expect(existsSync(join(env.f.workerDir, 'exit.json'))).toBe(false);

    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true, restartRefused: null, state: 'PLANNED' });
    expect(workerRow(env)).toMatchObject({ state: 'PLANNED', restart_count: 1 });
    expect(counterUsed(env, 'recovery_attempts')).toBe(1);
    // Uncommitted work in the worktree is untouched; the dead attempt's files moved aside so a restart can launch cleanly.
    expect(readFileSync(join(env.f.repo, 'apps', 'wip.ts'), 'utf8')).toContain('wip');
    expect(existsSync(join(env.f.workerDir, 'pid.json'))).toBe(false);
    expect(existsSync(join(env.f.workerDir, 'attempts', '1', 'pid.json'))).toBe(true);

    // The restart really can start (no "already launched" refusal) and no second worker was started before it.
    expect(readFileSync(env.f.argvLog, 'utf8').trim().split('\n')).toHaveLength(1);
    const handle = await env.adapter.startTask(implementerSpec(env.f));
    expect(alive(handle.pid)).toBe(true);
    await waitFor(() => readFileSync(env.f.argvLog, 'utf8').trim().split('\n').length === 2 || null);
  });

  it('a lost worker whose provider outlived its shim: the orphan is stopped before the restart is planned', async () => {
    const env = makeEnv();
    makeRun(env);
    const { shimPid, childPid } = await startWorker(env, { sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT });
    process.kill(shimPid, 'SIGKILL');
    await waitFor(() => !alive(shimPid));
    expect(alive(childPid)).toBe(true);
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true });
    await waitFor(() => !alive(childPid) || null);
    expect(workerRow(env).state).toBe('PLANNED');
  });

  it('restarts are bounded: the per-worker limit and the recovery budget each end in LOST without a restart', async () => {
    const limited = makeEnv();
    makeRun(limited);
    const s1 = await startWorker(limited, SLOW);
    process.kill(s1.shimPid, 'SIGKILL');
    process.kill(s1.childPid, 'SIGKILL');
    await waitFor(() => !alive(s1.shimPid) && !alive(s1.childPid));
    const rep1 = await run(limited, { maxWorkerRestarts: 0 });
    expect(rep1.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: false, restartRefused: 'restart-limit', state: 'LOST' });
    expect(workerRow(limited)).toMatchObject({ state: 'LOST', restart_count: 0 });

    const broke = makeEnv();
    makeRun(broke);
    seedCounters(broke, { recovery_attempts: 0 });
    const s2 = await startWorker(broke, SLOW);
    process.kill(s2.shimPid, 'SIGKILL');
    process.kill(s2.childPid, 'SIGKILL');
    await waitFor(() => !alive(s2.shimPid) && !alive(s2.childPid));
    const rep2 = await run(broke);
    expect(rep2.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: false, restartRefused: 'budget', state: 'LOST' });
    expect(workerRow(broke)).toMatchObject({ state: 'LOST', restart_count: 0 });
    expect(getRun(broke.db, broke.runId).state).toBe('IMPLEMENTING');
  });
});

describe.skipIf(!canStripTypes)('reconcileOnStart: pid identity', () => {
  it('a recorded pid that now belongs to an unrelated process (start time differs) is dead to us and is never signalled', async () => {
    const env = makeEnv();
    makeRun(env);
    const stranger = strangerProcess(env);
    planImplementer(env);
    // A worker directory as a crashed controller left it, except that the shim's pid has since been recycled by `stranger`.
    const realStart = processStartTime(stranger.pid)!;
    writeFileSync(
      join(env.f.workerDir, 'pid.json'),
      JSON.stringify({ version: 1, shimPid: stranger.pid, shimStart: 'Thu Jan 1 00:00:00 2015', pgid: stranger.pid, childPid: stranger.pid, childStart: 'Thu Jan 1 00:00:00 2015', sessionId: null, argvHash: 'sha256:x', startedAt: Date.now() - 1000 }),
    );
    const { markWorkerRunning } = await import('../../../src/storage/workers.ts');
    markWorkerRunning(env.db, 'w1', { pid: stranger.pid, pgid: stranger.pid, procStart: 'Thu Jan 1 00:00:00 2015' }, clock);
    expect(realStart).not.toBe('Thu Jan 1 00:00:00 2015');

    const rep = await run(env, { maxWorkerRestarts: 0 });
    expect(rep.runs[0]!.workers[0]!.observation).toBe('lost');
    expect(alive(stranger.pid)).toBe(true);

    // Even when the run is over and orphans are terminated, the stranger survives.
    transition(env.db, { runId: env.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'test' }, clock);
    await run(env);
    await sleep(300);
    expect(alive(stranger.pid)).toBe(true);
  });

  it('the same pid with the matching start time is recognized as the worker (control for the test above)', async () => {
    const env = makeEnv();
    makeRun(env);
    const stranger = strangerProcess(env);
    planImplementer(env);
    const start = processStartTime(stranger.pid)!;
    writeFileSync(join(env.f.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: stranger.pid, shimStart: start, pgid: stranger.pid, childPid: stranger.pid, childStart: start, sessionId: null, argvHash: 'sha256:x', startedAt: Date.now() }));
    const { markWorkerRunning } = await import('../../../src/storage/workers.ts');
    markWorkerRunning(env.db, 'w1', { pid: stranger.pid, pgid: stranger.pid, procStart: start }, clock);
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]!.observation).toBe('running');
    expect(alive(stranger.pid)).toBe(true);
  });
});

describe.skipIf(!canStripTypes)('reconcileOnStart: orphans', () => {
  it('a live worker whose run is terminal is stopped: its process group ends and the row is CANCELLED', async () => {
    const env = makeEnv();
    makeRun(env);
    const { shimPid, childPid } = await startWorker(env, { sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT });
    transition(env.db, { runId: env.runId, to: 'BLOCKED', ownerId: OWNER, reason: 'test' }, clock);
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'orphan-terminated', state: 'CANCELLED' });
    await waitFor(() => !alive(shimPid) && !alive(childPid) || null);
    expect(workerRow(env)).toMatchObject({ state: 'CANCELLED', result_status: 'cancelled' });
    expect(rep.summary.orphansTerminated).toBe(1);
  });

  it('a durable cancellation request survives the restart: the worker is stopped and never restarted (scenario 20)', async () => {
    const env = makeEnv();
    makeRun(env);
    seedCounters(env, { recovery_attempts: 3 });
    const { shimPid, childPid } = await startWorker(env, { sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT });
    requestCancel(env.db, env.runId, 'cli', clock);
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'orphan-terminated', state: 'CANCELLED' });
    await waitFor(() => !alive(shimPid) && !alive(childPid) || null);
    expect(counterUsed(env, 'recovery_attempts')).toBe(0);
    // The run itself is the controller's to finish; recovery did not resurrect it.
    expect(getRun(env.db, env.runId).state).toBe('IMPLEMENTING');
    expect(getRun(env.db, env.runId).cancelRequested).toBe(true);
  });

  it('a worker with its own durable cancel request is stopped even in a healthy run', async () => {
    const env = makeEnv();
    makeRun(env);
    const { shimPid, childPid } = await startWorker(env, { sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT });
    requestWorkerCancel(env.db, 'w1', clock, 'ctl', 'obsolete');
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]!.observation).toBe('orphan-terminated');
    await waitFor(() => !alive(shimPid) && !alive(childPid) || null);
  });

  it('an orphaned provider whose shim died, in a terminal run, is stopped and the worker is closed', async () => {
    const env = makeEnv();
    makeRun(env);
    const { shimPid, childPid } = await startWorker(env, { sleepMs: 30_000, structured: IMPLEMENTER_OUTPUT });
    process.kill(shimPid, 'SIGKILL');
    await waitFor(() => !alive(shimPid));
    transition(env.db, { runId: env.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'test' }, clock);
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]!.state).toBe('CANCELLED');
    await waitFor(() => !alive(childPid) || null);
  });

  it('terminal runs with nothing left behind are not touched', async () => {
    const env = makeEnv();
    makeRun(env, ['PREFLIGHT', 'BLOCKED']);
    await sleep(10);
    const rep = await run(env, { orphanScanWindowMs: 0 });
    expect(rep.runs).toEqual([]);
  });
});
