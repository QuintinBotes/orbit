import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnDetached } from '../../../src/core/exec.ts';
import { processStartTime } from '../../../src/core/proc.ts';
import { ensureShim, shimPath, type ShimIntent, type ShimLaunch } from '../../../src/evidence/check-shim.ts';
import { markCheckRunning, planCheckRun } from '../../../src/evidence/store.ts';
import { transition } from '../../../src/controller/run-store.ts';
import { reconcileOnStart } from '../../../src/recovery/reconcile.ts';
import { APP_STATE_FILE } from '../../../src/ui/app-fixture.ts';
import { OWNER, alive, canStripTypes, cleanupAll, clock, makeEnv, makeRun, waitFor, type Env } from './helpers.ts';

afterEach(cleanupAll);

const run = (env: Env, extra: object = {}) => reconcileOnStart({ db: env.db, ownerId: OWNER, clock, adapters: env.adapters, graceMs: 300, ...extra });

/** A real check: the real check shim supervising `sleep`, planned and started the way evidence/runner does it. */
function startCheck(env: Env, name = 'lint'): { checkRunId: string; dir: string; shimPid: number; childPid: () => number } {
  const dir = join(env.runDir, 'baseline', name);
  mkdirSync(dir, { recursive: true });
  const row = planCheckRun(env.db, { runId: env.runId, candidateId: null, checkId: name, kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: env.f.policyHash, command: ['sleep', '30'], cwd: env.f.repo, isolation: 'none', limitations: [] }, clock);
  const token = 'tok-' + name;
  const intent: ShimIntent = { token, checkRunId: row.id, argv: ['sleep', '30'], cwd: env.f.repo, timeoutMs: 60_000, killGraceMs: 300, maxOutputBytes: 100_000, writtenAt: Date.now() };
  writeFileSync(shimPath(dir, 'intent'), JSON.stringify(intent));
  const shim = ensureShim(env.runDir);
  const { pid } = spawnDetached([process.execPath, shim, dir], { cwd: dir, env: { PATH: process.env.PATH }, stdoutPath: join(dir, 'shim.out'), stderrPath: join(dir, 'shim.out') });
  writeFileSync(shimPath(dir, 'launch'), JSON.stringify({ token, pid, procStart: processStartTime(pid) } satisfies ShimLaunch));
  markCheckRunning(env.db, row.id, pid, clock);
  // The shim writes pid.json a moment after it starts; 0 until then.
  const childPid = (): number => {
    try {
      return (JSON.parse(readFileSync(join(dir, 'pid.json'), 'utf8')) as { childPid: number | null }).childPid ?? 0;
    } catch {
      return 0;
    }
  };
  return { checkRunId: row.id, dir, shimPid: pid, childPid };
}

const checkRow = (env: Env, id: string) => env.db.get<{ status: string; cancelled: number }>('SELECT status, cancelled FROM check_runs WHERE id = ?', id)!;

describe.skipIf(!canStripTypes)('reconcileOnStart: detached checks', () => {
  it('a running check of a live run is left running for the evidence runner to reattach', async () => {
    const env = makeEnv();
    makeRun(env);
    const c = startCheck(env);
    await waitFor(() => c.childPid() || null);
    const rep = await run(env);
    expect(rep.runs[0]!.checks).toMatchObject([{ checkRunId: c.checkRunId, observation: 'running', terminated: false, closed: false }]);
    expect(alive(c.shimPid) && alive(c.childPid())).toBe(true);
    expect(checkRow(env, c.checkRunId).status).toBe('RUNNING');
  });

  it('a finished check (exit.json present) is reported for collection and not rerun', async () => {
    const env = makeEnv();
    makeRun(env);
    const c = startCheck(env);
    const child = await waitFor(() => c.childPid() || null);
    process.kill(child, 'SIGTERM');
    await waitFor(() => existsSync(shimPath(c.dir, 'exit')) || null);
    const rep = await run(env);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'finished', closed: false });
  });

  it('a check whose run was cancelled is stopped through its shim and its row is closed CANCELLED', async () => {
    const env = makeEnv();
    makeRun(env);
    const c = startCheck(env);
    const child = await waitFor(() => c.childPid() || null);
    transition(env.db, { runId: env.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'test' }, clock);
    const rep = await run(env);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'orphan-terminated', terminated: true, closed: true });
    await waitFor(() => (!alive(c.shimPid) && !alive(child)) || null);
    expect(checkRow(env, c.checkRunId)).toMatchObject({ status: 'CANCELLED', cancelled: 1 });
  });

  it('a check whose shim was killed (no exit.json) but whose process still runs: the orphan is stopped, the row is left for the evidence runner to close as lost', async () => {
    const env = makeEnv();
    makeRun(env);
    const c = startCheck(env);
    const child = await waitFor(() => c.childPid() || null);
    process.kill(c.shimPid, 'SIGKILL');
    await waitFor(() => !alive(c.shimPid));
    expect(alive(child)).toBe(true);
    const rep = await run(env);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', terminated: true, closed: false });
    await waitFor(() => !alive(child) || null);
    expect(checkRow(env, c.checkRunId).status).toBe('RUNNING');
  });

  it('a recycled pid in the check record is not killed: its start time does not match the record', async () => {
    const env = makeEnv();
    makeRun(env);
    const c = startCheck(env);
    const child = await waitFor(() => c.childPid() || null);
    process.kill(c.shimPid, 'SIGKILL');
    process.kill(child, 'SIGKILL');
    await waitFor(() => !alive(c.shimPid) && !alive(child));
    // Whatever now lives at the recorded group id started long after the record was written.
    const stranger = spawnDetached(['sleep', '30'], { env: { PATH: process.env.PATH }, stdoutPath: join(c.dir, 'x.out'), stderrPath: join(c.dir, 'x.out') });
    env.kids.push({ pid: stranger.pid } as never);
    const rec = JSON.parse(readFileSync(join(c.dir, 'pid.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(c.dir, 'pid.json'), JSON.stringify({ ...rec, childPid: stranger.pid, childPgid: stranger.pgid, startedAt: Date.now() - 3 * 3_600_000 }));
    const rep = await run(env);
    expect(rep.runs[0]!.checks[0]).toMatchObject({ observation: 'lost', terminated: false });
    expect(alive(stranger.pid)).toBe(true);
  });
});

describe.skipIf(!canStripTypes)('reconcileOnStart: UI app fixtures', () => {
  function appFixture(env: Env, recordedStart: (real: string) => string): { pid: number; stateFile: string } {
    const dir = join(env.runDir, 'evidence', '1', 'ui', 'app');
    mkdirSync(dir, { recursive: true });
    const { pid, pgid } = spawnDetached([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { env: { PATH: process.env.PATH }, stdoutPath: join(dir, 'app.log'), stderrPath: join(dir, 'app.log') });
    env.kids.push({ pid } as never);
    const real = processStartTime(pid)!;
    const stateFile = join(dir, APP_STATE_FILE);
    writeFileSync(stateFile, JSON.stringify({ state: 'running', command: ['node'], cwd: env.f.repo, baseUrl: 'http://127.0.0.1:1', startedAt: Date.now(), pid, pgid, start: recordedStart(real), logPath: join(dir, 'app.log') }));
    return { pid, stateFile };
  }

  it('an app fixture left by a dead controller is stopped, in a run that is live or over', async () => {
    const env = makeEnv();
    makeRun(env);
    const app = appFixture(env, (real) => real);
    const rep = await run(env);
    expect(rep.runs[0]!.apps).toMatchObject([{ outcome: 'stopped' }]);
    await waitFor(() => !alive(app.pid) || null);

    const over = makeEnv();
    makeRun(over, ['PREFLIGHT', 'BLOCKED']);
    const app2 = appFixture(over, (real) => real);
    const rep2 = await run(over);
    expect(rep2.runs[0]!.apps).toMatchObject([{ outcome: 'stopped' }]);
    await waitFor(() => !alive(app2.pid) || null);
  });

  it('a recorded pid whose start time differs is a foreign process and is left alone', async () => {
    const env = makeEnv();
    makeRun(env);
    const app = appFixture(env, () => 'Thu Jan 1 00:00:00 2015');
    const rep = await run(env);
    expect(rep.runs[0]!.apps).toMatchObject([{ outcome: 'foreign-process' }]);
    expect(alive(app.pid)).toBe(true);
  });
});
