import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { atomicWriteJson } from '../../../src/core/fsx.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { reconcileApp, startApp, stopApp, type AppState } from '../../../src/ui/app-fixture.ts';

// Process control under test: every call goes through these doubles, so no real process is signalled.
const proc = vi.hoisted(() => ({
  isAlive: (_pid: number, _start?: string | null): boolean => false,
  isGroupAlive: (_pgid: number): boolean => false,
  terminateGroup: async (_pgid: number, _graceMs: number): Promise<{ exited: boolean; signal: string | null }> => ({ exited: true, signal: null }),
  processStartTime: (_pid: number): string | null => 'Mon Jan  1 00:00:00 2026',
  terminateCalls: 0,
}));
vi.mock('../../../src/core/proc.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/proc.ts')>()),
  isAlive: (pid: number, start?: string | null) => proc.isAlive(pid, start),
  isGroupAlive: (pgid: number) => proc.isGroupAlive(pgid),
  terminateGroup: (pgid: number, graceMs: number) => {
    proc.terminateCalls++;
    return proc.terminateGroup(pgid, graceMs);
  },
}));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-app-proc-'));
  proc.terminateCalls = 0;
  proc.isAlive = () => false;
  proc.isGroupAlive = () => false;
  proc.terminateGroup = async () => ({ exited: true, signal: null });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const stateFile = () => join(dir, 'app.json');
const running = (over: Partial<AppState> = {}): AppState => ({ state: 'running', command: ['x'], cwd: dir, baseUrl: 'http://127.0.0.1:9', startedAt: 1, pid: 4242, pgid: 4242, start: 'Mon Jan  1 00:00:00 2026', logPath: join(dir, 'app.log'), ...over });
const write = (s: AppState) => atomicWriteJson(stateFile(), s);
const read = () => JSON.parse(readFileSync(stateFile(), 'utf8')) as AppState;

describe('reconcileApp decisions', () => {
  it('leaves a pid that now belongs to another process alone', async () => {
    write(running());
    proc.isAlive = (_pid, start) => start === undefined;
    proc.isGroupAlive = () => true;
    expect(await reconcileApp(stateFile())).toBe('foreign-process');
    expect(proc.terminateCalls).toBe(0);
    expect(read().state).toBe('running');
  });

  it('marks an app whose group is gone as stopped, without signalling', async () => {
    write(running());
    const clock = new ManualClock();
    expect(await reconcileApp(stateFile(), { clock })).toBe('already-stopped');
    expect(read()).toMatchObject({ state: 'stopped', stoppedAt: clock.now() });
    expect(proc.terminateCalls).toBe(0);
  });

  it('stops a live app and records it, and reports one that survives every signal as still running', async () => {
    write(running());
    proc.isAlive = () => true;
    proc.isGroupAlive = () => true;
    expect(await reconcileApp(stateFile())).toBe('stopped');
    expect(read().state).toBe('stopped');

    write(running());
    proc.terminateGroup = async () => ({ exited: false, signal: 'SIGKILL' });
    expect(await reconcileApp(stateFile())).toBe('still-running');
    expect(read().state).toBe('stopped');
  });
});

describe('startApp with an earlier app that will not stop', () => {
  it('refuses to start another and names the state file', async () => {
    write(running());
    proc.isAlive = () => true;
    proc.isGroupAlive = () => true;
    proc.terminateGroup = async () => ({ exited: false, signal: 'SIGKILL' });
    const err = await startApp({ command: [process.execPath, '-e', ''], cwd: dir, baseUrl: 'http://127.0.0.1:9', readyTimeoutMs: 100, isolation: { provider: new NoIsolation(), profile: { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 1, memoryMb: null, cpus: null, pids: null } } }, stateDir: dir, clock: new ManualClock(), probe: async () => null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'CONFIG_INVALID', details: { reason: 'previous_app_running' }, message: expect.stringContaining(stateFile()) });
  });

  it('treats a failing liveness check as the app being gone', async () => {
    proc.isGroupAlive = () => {
      throw new Error('EPERM');
    };
    // The spawn succeeds for real; the doubled liveness check then reports the group dead, which the loop reads as an exit.
    const err = await startApp({ command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: dir, baseUrl: 'http://127.0.0.1:9', readyTimeoutMs: 5_000, isolation: { provider: new NoIsolation(), profile: { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 1, memoryMb: null, cpus: null, pids: null } } }, stateDir: join(dir, 'state'), clock: new ManualClock(), probe: async () => null }).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INTERNAL', details: { reason: 'app_exited' } });
    // stopApp went through the doubled terminateGroup, so the real process is still there: stop it by hand.
    const st = JSON.parse(readFileSync(join(dir, 'state', 'app.json'), 'utf8')) as AppState;
    process.kill(-st.pgid!, 'SIGKILL');
  });
});

describe('stopApp retries', () => {
  const handle = () => {
    write(running());
    return { pgid: 4242, stateFile: stateFile() };
  };

  it('retries a signal the system refused while the process was still starting, then records the stop', async () => {
    let failures = 2;
    proc.terminateGroup = async () => {
      if (failures-- > 0) throw new OrbitError('INTERNAL', 'EPERM while the group is in fork/exec');
      return { exited: true, signal: 'SIGINT' };
    };
    expect(await stopApp(handle())).toEqual({ exited: true });
    expect(proc.terminateCalls).toBe(3);
    expect(read().state).toBe('stopped');
  });

  it('gives up after six refusals and rethrows the last one, leaving the state file as it was', async () => {
    proc.terminateGroup = async () => {
      throw new OrbitError('INTERNAL', 'EPERM forever');
    };
    await expect(stopApp(handle())).rejects.toMatchObject({ code: 'INTERNAL', message: 'EPERM forever' });
    expect(proc.terminateCalls).toBe(6);
    expect(read().state).toBe('running');
  });

  it('does not retry any other failure', async () => {
    proc.terminateGroup = async () => {
      throw new OrbitError('POLICY_DENIED', 'no');
    };
    await expect(stopApp(handle())).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    proc.terminateCalls = 0;
    proc.terminateGroup = async () => {
      throw new TypeError('not an OrbitError');
    };
    await expect(stopApp(handle())).rejects.toThrow(TypeError);
    expect(proc.terminateCalls).toBe(1);
  });

  it('is a no-op for the state file when there is none', async () => {
    expect(await stopApp({ pgid: 4242, stateFile: join(dir, 'never-written.json') })).toEqual({ exited: true });
  });
});
