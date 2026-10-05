import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isGroupAlive } from '../../../src/core/proc.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider } from '../../../src/isolation/types.ts';
import { startApp, stopApp, type AppState, type StartAppOptions } from '../../../src/ui/app-fixture.ts';

const profile = { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 1000, memoryMb: null, cpus: null, pids: null }, allowLocalBinding: true };
const SLEEPER = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-app-cov-'));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

/** The no-isolation provider, counting how often the wrapper's cleanup ran. */
function counting(): { provider: IsolationProvider; cleaned: () => number } {
  const inner = new NoIsolation();
  let cleaned = 0;
  const provider = { kind: inner.kind, available: () => inner.available(), wrap: (argv: string[], p: Parameters<NoIsolation['wrap']>[1], o: { cwd: string; env: Record<string, string> }) => {
    const w = inner.wrap(argv, p, o);
    return { ...w, cleanup: () => { cleaned++; w.cleanup(); } };
  } } as unknown as IsolationProvider;
  return { provider, cleaned: () => cleaned };
}

const opts = (over: Partial<StartAppOptions> = {}): StartAppOptions => ({
  command: SLEEPER,
  cwd: dir,
  baseUrl: 'http://127.0.0.1:9',
  readyTimeoutMs: 5_000,
  isolation: { provider: new NoIsolation(), profile },
  stateDir: join(dir, 'state'),
  clock: new ManualClock(),
  pollMs: 10,
  ...over,
});

describe('startApp refusals and failures', () => {
  it('refuses an empty start command', async () => {
    await expect(startApp(opts({ command: [], probe: async () => null }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('start_command is empty') });
    expect(existsSync(join(dir, 'state', 'app.json'))).toBe(false);
  });

  it('cleans up the isolation wrapper when the command cannot be started, and leaves the state at "starting"', async () => {
    const c = counting();
    await expect(startApp(opts({ command: ['definitely-not-a-real-binary-acme'], isolation: { provider: c.provider, profile }, probe: async () => null }))).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(c.cleaned()).toBe(1);
    expect((JSON.parse(readFileSync(join(dir, 'state', 'app.json'), 'utf8')) as AppState).state).toBe('starting');
  });

  it('says "(no output)" when the app exits without writing anything', async () => {
    const command = [process.execPath, '-e', 'process.exit(3)'];
    let calls = 0;
    const probe = async () => {
      if (++calls > 1) await new Promise((r) => setTimeout(r, 150));
      return null;
    };
    await expect(startApp(opts({ command, probe }))).rejects.toMatchObject({ code: 'INTERNAL', details: { reason: 'app_exited' }, message: expect.stringMatching(/exited before it became ready: \(no output\)$/) });
  });

  it('says "(no output)" at the ready timeout when the log cannot be read, and stops the app', async () => {
    let pgid = 0;
    const probe = async () => {
      const state = join(dir, 'state', 'app.json');
      if (existsSync(state)) {
        const s = JSON.parse(readFileSync(state, 'utf8')) as AppState;
        pgid = s.pgid ?? pgid;
        rmSync(s.logPath, { force: true });
      }
      return null;
    };
    await expect(startApp(opts({ readyTimeoutMs: 100, probe }))).rejects.toMatchObject({ code: 'INTERNAL', details: { reason: 'ready_timeout' }, message: expect.stringMatching(/within 100 ms: \(no output\)$/) });
    expect(isGroupAlive(pgid)).toBe(false);
  });

  it('shows the tail of the app log, redacted, in the ready-timeout error', async () => {
    const command = [process.execPath, '-e', 'console.log("listening soon ghp_abcdefghijklmnopqrstuvwxyz0123456789"); setInterval(() => {}, 1000)'];
    let calls = 0;
    const probe = async () => {
      if (++calls > 1) await new Promise((r) => setTimeout(r, 120));
      return null;
    };
    const err = (await startApp(opts({ command, readyTimeoutMs: 600, probe })).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('listening soon');
    expect(err.message).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

describe('the default readiness probe', () => {
  it('asks fetch without following redirects, treats a failing request as not ready, and tolerates a body that cannot be cancelled', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    let n = 0;
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (++n === 1) throw new Error('ECONNREFUSED');
      if (n === 2) throw new Error('ECONNREFUSED');
      return { status: 302, body: { cancel: () => Promise.reject(new Error('already closed')) } };
    });
    const h = await startApp(opts({ requestTimeoutMs: 500 }));
    await stopApp(h);
    expect(n).toBe(3);
    expect(calls.every((c) => c.url === 'http://127.0.0.1:9' && c.init.redirect === 'manual')).toBe(true);
  });

  it('works with a response that has no body', async () => {
    let n = 0;
    vi.stubGlobal('fetch', async () => {
      if (++n === 1) throw new Error('ECONNREFUSED');
      return { status: 200, body: null };
    });
    const h = await startApp(opts());
    await stopApp(h);
    expect(n).toBe(2);
  });
});
