import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDetached } from '../../../src/core/exec.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import { ensureShim, shimPath, type ShimIntent } from '../../../src/evidence/check-shim.ts';
import { markCheckRunning, planCheckRun } from '../../../src/evidence/store.ts';
import { transition } from '../../../src/controller/run-store.ts';
import { getWorker, markWorkerRunning } from '../../../src/storage/workers.ts';
import { reconcileOnStart, stopWorker } from '../../../src/recovery/reconcile.ts';
import { OWNER, alive, canStripTypes, cleanupAll, clock, makeEnv, makeRun, planImplementer, seedCounters, waitFor, workerRow, type Env } from './helpers.ts';

/**
 * Regression tests from the adversarial review: process identity for check
 * shims recorded only in pid.json (the controller died before writing
 * launch.json, which is where the shim's start time lives).
 */

afterEach(cleanupAll);

const run = (env: Env) => reconcileOnStart({ db: env.db, ownerId: OWNER, clock, adapters: env.adapters, graceMs: 300 });

function planCheck(env: Env, name: string): { id: string; dir: string; token: string } {
  const dir = join(env.runDir, 'baseline', name);
  mkdirSync(dir, { recursive: true });
  const row = planCheckRun(env.db, { runId: env.runId, candidateId: null, checkId: name, kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: env.f.policyHash, command: ['sleep', '30'], cwd: env.f.repo, isolation: 'none', limitations: [] }, clock);
  const token = 'tok-' + name;
  const intent: ShimIntent = { token, checkRunId: row.id, argv: ['sleep', '30'], cwd: env.f.repo, timeoutMs: 60_000, killGraceMs: 300, maxOutputBytes: 100_000, writtenAt: Date.now() };
  writeFileSync(shimPath(dir, 'intent'), JSON.stringify(intent));
  return { id: row.id, dir, token };
}

const checkStatus = (env: Env, id: string) => env.db.get<{ status: string }>('SELECT status FROM check_runs WHERE id = ?', id)!.status;

describe.skipIf(!canStripTypes)('reconcileOnStart: check shims known only from pid.json', () => {
  it('an unrelated process that now holds the recorded shim pid is not signalled when the run is over', async () => {
    const env = makeEnv();
    makeRun(env);
    const c = planCheck(env, 'lint');
    // The stranger stands in for whatever recycled the dead shim's pid.
    const stranger = spawnDetached(['sleep', '30'], { env: { PATH: process.env.PATH }, stdoutPath: join(c.dir, 'x.out'), stderrPath: join(c.dir, 'x.out') });
    env.kids.push({ pid: stranger.pid } as never);
    markCheckRunning(env.db, c.id, stranger.pid, clock);
    // No launch.json; pid.json written by the dead shim three hours ago.
    writeFileSync(shimPath(c.dir, 'pid'), JSON.stringify({ token: c.token, shimPid: stranger.pid, childPid: null, childPgid: null, startedAt: Date.now() - 3 * 3_600_000 }));
    transition(env.db, { runId: env.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'test' }, clock);

    const rep = await run(env);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ terminated: false, closed: true });
    expect(rep.runs[0]!.checks[0]!.observation).not.toBe('orphan-terminated');
    expect(alive(stranger.pid)).toBe(true);
    expect(checkStatus(env, c.id)).toBe('CANCELLED');
  });

  it('the real shim, identified by when it wrote pid.json, is still stopped when the run is over', async () => {
    const env = makeEnv();
    makeRun(env);
    const c = planCheck(env, 'test');
    const shim = ensureShim(env.runDir);
    const { pid } = spawnDetached([process.execPath, shim, c.dir], { cwd: c.dir, env: { PATH: process.env.PATH }, stdoutPath: join(c.dir, 'shim.out'), stderrPath: join(c.dir, 'shim.out') });
    markCheckRunning(env.db, c.id, pid, clock);
    const child = await waitFor(() => {
      try {
        return (JSON.parse(readFileSync(shimPath(c.dir, 'pid'), 'utf8')) as { childPid: number | null }).childPid;
      } catch {
        return null;
      }
    });
    // The controller died before recording launch.json.
    rmSync(shimPath(c.dir, 'launch'), { force: true });
    expect(processStartTime(pid)).not.toBeNull();
    transition(env.db, { runId: env.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'test' }, clock);

    const rep = await run(env);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'orphan-terminated', terminated: true, closed: true });
    await waitFor(() => (!alive(pid) && !alive(child)) || null);
  });
});

describe('reconcileOnStart: a RUNNING worker whose files are gone', () => {
  function recordedProcess(env: Env): { pid: number; pgid: number; start: string } {
    const dir = join(env.f.base, 'stray');
    mkdirSync(dir, { recursive: true });
    const p = spawnDetached(['sleep', '30'], { env: { PATH: process.env.PATH }, stdoutPath: join(dir, 'o'), stderrPath: join(dir, 'o') });
    env.kids.push({ pid: p.pid } as never);
    return { pid: p.pid, pgid: p.pgid, start: processStartTime(p.pid)! };
  }

  it('the process the row records is stopped before a restart is planned, so no second worker runs beside it', async () => {
    const env = makeEnv();
    makeRun(env);
    seedCounters(env, { recovery_attempts: 3 });
    const proc = recordedProcess(env);
    planImplementer(env);
    markWorkerRunning(env.db, 'w1', { pid: proc.pid, pgid: proc.pgid, procStart: proc.start }, clock);
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true });
    await waitFor(() => !alive(proc.pid) || null);
    expect(workerRow(env).state).toBe('PLANNED');
  });

  it('a recorded pid with another start time is a recycled pid: left alone, and the restart still planned', async () => {
    const env = makeEnv();
    makeRun(env);
    seedCounters(env, { recovery_attempts: 3 });
    const proc = recordedProcess(env);
    planImplementer(env);
    markWorkerRunning(env.db, 'w1', { pid: proc.pid, pgid: proc.pgid, procStart: 'Thu Jan 1 00:00:00 2015' }, clock);
    const rep = await run(env);
    expect(rep.runs[0]!.workers[0]).toMatchObject({ observation: 'lost', restartPlanned: true });
    expect(alive(proc.pid)).toBe(true);
  });

  it('stopWorker does not record CANCELLED while a process it cannot verify may still be the worker', async () => {
    const env = makeEnv();
    makeRun(env);
    const proc = recordedProcess(env);
    planImplementer(env);
    const w = markWorkerRunning(env.db, 'w1', { pid: proc.pid, pgid: proc.pgid, procStart: null }, clock);
    await expect(stopWorker({ db: env.db, clock, ownerId: OWNER, adapters: env.adapters, graceMs: 100 }, w, 'test')).rejects.toThrow(/could not be verified/);
    expect(getWorker(env.db, 'w1')).toMatchObject({ state: 'RUNNING', cancelRequested: true });
    expect(alive(proc.pid)).toBe(true);
  });
});
