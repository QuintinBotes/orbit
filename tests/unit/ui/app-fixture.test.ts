import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { atomicWriteJson } from '../../../src/core/fsx.ts';
import { isGroupAlive } from '../../../src/core/proc.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { assertBaseUrl, isLoopbackHost, isReadyStatus, reconcileApp, startApp, stopApp, type AppState, type StartAppOptions } from '../../../src/ui/app-fixture.ts';

const isolation = { provider: new NoIsolation(), profile: { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 1000, memoryMb: null, cpus: null, pids: null }, allowLocalBinding: true } };
// A process that stays up until it is stopped; readiness is decided by the injected probe.
const SLEEPER = [process.execPath, '-e', 'setInterval(() => {}, 1000)'];

describe('base URL rules', () => {
  it.each(['127.0.0.1', '127.1.2.3', 'localhost', 'app.localhost', '[::1]', '::1'])('%s is loopback', (h) => expect(isLoopbackHost(h)).toBe(true));
  it.each(['10.0.0.1', '192.168.1.5', 'example.test', '0.0.0.0', '127.0.0.256', '128.0.0.1', 'localhost.evil.test'])('%s is not loopback', (h) => expect(isLoopbackHost(h)).toBe(false));

  it('refuses a non-loopback host when isolated test data is required, allows it otherwise', () => {
    expect(() => assertBaseUrl('http://staging.acme.test/', true)).toThrowError(expect.objectContaining({ code: 'POLICY_DENIED' }));
    expect(assertBaseUrl('http://staging.acme.test/', false).hostname).toBe('staging.acme.test');
    expect(assertBaseUrl('http://127.0.0.1:3000', true).port).toBe('3000');
  });

  it('refuses malformed URLs, other schemes and embedded credentials', () => {
    expect(() => assertBaseUrl('not a url', true)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => assertBaseUrl('file:///etc/passwd', true)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => assertBaseUrl('http://user:pw@127.0.0.1/', true)).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('readiness follows Playwright: 2xx, 3xx and 400 to 403 count, 404 and 5xx do not', () => {
    for (const s of [200, 204, 302, 400, 401, 403]) expect(isReadyStatus(s)).toBe(true);
    for (const s of [199, 404, 500, 503]) expect(isReadyStatus(s)).toBe(false);
  });
});

describe('startApp', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-app-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const opts = (over: Partial<StartAppOptions> = {}): StartAppOptions => ({
    command: SLEEPER,
    cwd: dir,
    baseUrl: 'http://127.0.0.1:9',
    readyTimeoutMs: 5_000,
    isolation,
    stateDir: join(dir, 'state'),
    clock: new ManualClock(),
    pollMs: 10,
    ...over,
  });
  const state = (file: string) => JSON.parse(readFileSync(file, 'utf8')) as AppState;

  it('records intent, waits for readiness, and stops the whole group', async () => {
    let calls = 0;
    // First call is the "is something already there" check; then not ready twice; then ready.
    const probe = async () => (++calls <= 3 ? null : 200);
    const h = await startApp(opts({ probe }));
    expect(calls).toBe(4);
    expect(isGroupAlive(h.pgid)).toBe(true);
    expect(state(h.stateFile)).toMatchObject({ state: 'running', pid: h.pid, pgid: h.pgid, baseUrl: 'http://127.0.0.1:9' });
    expect(state(h.stateFile).start).toBeTruthy();
    expect((await stopApp(h)).exited).toBe(true);
    expect(isGroupAlive(h.pgid)).toBe(false);
    expect(state(h.stateFile).state).toBe('stopped');
    // Stopping twice is harmless.
    expect((await stopApp(h)).exited).toBe(true);
  });

  it('grants allowLocalBinding to the provider whatever profile the caller built', async () => {
    const seen: (boolean | undefined)[] = [];
    const none = new NoIsolation();
    const recording = { kind: none.kind, available: () => none.available(), wrap: (argv: string[], profile: Parameters<NoIsolation['wrap']>[1], o: { cwd: string; env: Record<string, string> }) => (seen.push(profile.allowLocalBinding), none.wrap(argv, profile, o)) };
    const { allowLocalBinding: _omitted, ...plain } = isolation.profile;
    let calls = 0;
    const h = await startApp(opts({ isolation: { provider: recording, profile: plain }, probe: async () => (++calls <= 1 ? null : 200) }));
    await stopApp(h);
    expect(seen).toEqual([true]);
    // The caller's own object is not modified.
    expect('allowLocalBinding' in plain).toBe(false);
  });

  it('tells the provider about the log it hands the app as stdout and stderr, and creates it first (a sandboxed node aborts at startup on a descriptor it may not read)', async () => {
    const seen: { stdioFiles: string[] | undefined; existed: boolean; mode: number }[] = [];
    const none = new NoIsolation();
    const recording = {
      kind: none.kind,
      available: () => none.available(),
      wrap: (argv: string[], profile: Parameters<NoIsolation['wrap']>[1], o: Parameters<NoIsolation['wrap']>[2]) => {
        const file = o.stdioFiles?.[0];
        seen.push({ stdioFiles: o.stdioFiles, existed: file !== undefined && existsSync(file), mode: file !== undefined && existsSync(file) ? statSync(file).mode & 0o777 : 0 });
        return none.wrap(argv, profile, o);
      },
    };
    let calls = 0;
    const h = await startApp(opts({ isolation: { provider: recording, profile: isolation.profile }, probe: async () => (++calls <= 1 ? null : 200) }));
    await stopApp(h);
    expect(seen).toEqual([{ stdioFiles: [h.logPath], existed: true, mode: 0o600 }]);
    expect(h.logPath).toBe(join(dir, 'state', 'app.log'));
  });

  it('refuses to test a server it did not start', async () => {
    await expect(startApp(opts({ probe: async () => 200 }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', details: { reason: 'port_in_use' } });
  });

  it('refuses a non-loopback base URL before spawning anything', async () => {
    await expect(startApp(opts({ baseUrl: 'http://staging.acme.test:3000', probe: async () => null }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    // Without the isolation requirement the same URL is accepted (and is only ever started, never reused).
    let calls = 0;
    const h = await startApp(opts({ baseUrl: 'http://staging.acme.test:3000', isolatedTestData: false, probe: async () => (++calls > 1 ? 200 : null) }));
    await stopApp(h);
  });

  it('fails fast, with the app output, when the process exits before it is ready', async () => {
    const command = [process.execPath, '-e', 'console.error("cannot bind port"); process.exit(2)'];
    // The ManualClock would skip over the process start-up, so give it real time to exit.
    let calls = 0;
    const probe = async () => {
      if (++calls > 1) await new Promise((r) => setTimeout(r, 100));
      return null;
    };
    await expect(startApp(opts({ command, probe }))).rejects.toMatchObject({ code: 'INTERNAL', details: { reason: 'app_exited' }, message: expect.stringContaining('cannot bind port') });
  });

  it('times out when the app never answers, and leaves nothing running', async () => {
    const clock = new ManualClock();
    let pgid = 0;
    const err = await startApp(opts({ clock, readyTimeoutMs: 300, probe: async () => null })).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'INTERNAL', details: { reason: 'ready_timeout' } });
    const st = state(join(dir, 'state', 'app.json'));
    pgid = st.pgid ?? 0;
    expect(st.state).toBe('stopped');
    expect(isGroupAlive(pgid)).toBe(false);
  });

  it('gives the app a scrubbed environment: host credentials do not reach it', async () => {
    const out = join(dir, 'env.json');
    const command = [process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.env)); setInterval(() => {}, 1000)`];
    let calls = 0;
    const probe = async () => {
      if (++calls > 1) await new Promise((r) => setTimeout(r, 150));
      return calls > 1 ? 200 : null;
    };
    const h = await startApp(opts({ command, probe, env: { PORT: '4321' }, hostEnv: { PATH: process.env.PATH, HOME: '/home/acme', GH_TOKEN: 'ghp_secretsecretsecretsecretsecretsecret', ANTHROPIC_API_KEY: 'sk-ant-xyz', SSH_AUTH_SOCK: '/tmp/agent' } }));
    try {
      const env = JSON.parse(readFileSync(out, 'utf8')) as Record<string, string>;
      expect(env.PORT).toBe('4321');
      expect(env.HOME).toBe('/home/acme');
      for (const k of ['GH_TOKEN', 'ANTHROPIC_API_KEY', 'SSH_AUTH_SOCK']) expect(env[k]).toBeUndefined();
    } finally {
      await stopApp(h);
    }
  });
});

describe('reconcileApp', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'orbit-app-rec-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const base = (): AppState => ({ state: 'running', command: ['x'], cwd: dir, baseUrl: 'http://127.0.0.1:9', startedAt: 1, pid: null, pgid: null, start: null, logPath: join(dir, 'app.log') });
  const write = (s: AppState) => {
    atomicWriteJson(join(dir, 'app.json'), s);
    return join(dir, 'app.json');
  };

  it('does nothing without a state file', async () => {
    expect(await reconcileApp(join(dir, 'missing.json'))).toBe('none');
  });

  it('treats a crash between intent and spawn as nothing to stop', async () => {
    expect(await reconcileApp(write({ ...base(), state: 'starting' }))).toBe('already-stopped');
  });

  it('stops an app left behind by an earlier incarnation', async () => {
    let calls = 0;
    const h = await startApp({
      command: SLEEPER,
      cwd: dir,
      baseUrl: 'http://127.0.0.1:9',
      readyTimeoutMs: 5000,
      isolation,
      stateDir: join(dir, 'state'),
      clock: new ManualClock(),
      probe: async () => (++calls > 1 ? 200 : null),
    });
    expect(isGroupAlive(h.pgid)).toBe(true);
    // A new controller knows only the state file.
    expect(await reconcileApp(h.stateFile)).toBe('stopped');
    expect(isGroupAlive(h.pgid)).toBe(false);
    expect(await reconcileApp(h.stateFile)).toBe('already-stopped');
  });

  it('leaves a process alone when the pid now belongs to something else', async () => {
    // This test process stands in for an unrelated process that was handed the recorded pid.
    const file = write({ ...base(), pid: process.pid, pgid: process.pid, start: 'Thu Jan 1 00:00:00 1970' });
    expect(await reconcileApp(file)).toBe('foreign-process');
  });

  it('marks a recorded app that is already gone as stopped', async () => {
    const done = spawnSync(process.execPath, ['-e', '0']);
    const file = write({ ...base(), pid: done.pid, pgid: done.pid, start: null });
    expect(await reconcileApp(file)).toBe('already-stopped');
  });
});
