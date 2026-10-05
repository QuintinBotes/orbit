import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isGroupAlive, isAlive } from '../../../src/core/proc.ts';
import { buildSrtSettings, SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { reconcileApp, startApp, stopApp, type AppIsolation } from '../../../src/ui/app-fixture.ts';
import { FIXTURE_APP, freePort } from './helpers.ts';

const profile = (writable: string[] = []) => ({ writablePaths: writable, denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null }, allowLocalBinding: true });
const none: AppIsolation = { provider: new NoIsolation(), profile: profile() };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-appint-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the fixture application as a real process', () => {
  it('serves its pages, stops with its whole process group, and frees the port', async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const h = await startApp({ command: ['node', 'server.mjs'], cwd: FIXTURE_APP, baseUrl, readyTimeoutMs: 15_000, env: { PORT: String(port) }, isolation: none, stateDir: join(dir, 'state') });
    expect(h.baseUrl).toBe(baseUrl);
    const csv = await fetch(`${baseUrl}/export.csv?status=closed`);
    expect(csv.headers.get('content-disposition')).toContain('reports-closed.csv');
    expect((await csv.text()).trim().split('\n')).toHaveLength(3);
    expect(readFileSync(h.logPath, 'utf8')).toContain('listening');

    await stopApp(h);
    expect(isGroupAlive(h.pgid)).toBe(false);
    await expect(fetch(baseUrl)).rejects.toThrow();
  });

  it('injects defects only when asked', async () => {
    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const h = await startApp({ command: ['node', 'server.mjs'], cwd: FIXTURE_APP, baseUrl, readyTimeoutMs: 15_000, env: { PORT: String(port), APP_DEFECT_EXPORT: '1', APP_DEFECT_A11Y: '1' }, isolation: none, stateDir: join(dir, 'state') });
    try {
      expect((await (await fetch(`${baseUrl}/export.csv?status=closed`)).text()).trim().split('\n')).toHaveLength(7);
      expect(await (await fetch(`${baseUrl}/reports`)).text()).not.toContain('<label for="status">');
    } finally {
      await stopApp(h);
    }
  });

  it('stops processes the application itself started', async () => {
    const port = await freePort();
    const childPidFile = join(dir, 'child.pid');
    const script = join(dir, 'parent.mjs');
    // The server forks a helper into the same group, as dev servers do with their watchers.
    writeFileSync(
      script,
      `import { spawn } from 'node:child_process'; import { writeFileSync } from 'node:fs'; import { createServer } from 'node:http';
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(${JSON.stringify(childPidFile)}, String(c.pid));
createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');
`,
    );
    const h = await startApp({ command: ['node', script], cwd: dir, baseUrl: `http://127.0.0.1:${port}`, readyTimeoutMs: 15_000, isolation: none, stateDir: join(dir, 'state') });
    const childPid = Number(readFileSync(childPidFile, 'utf8'));
    expect(isAlive(childPid)).toBe(true);
    await stopApp(h);
    expect(isAlive(childPid)).toBe(false);
  });

  it('a restarted controller finds and stops an app it only knows from the state file', async () => {
    const port = await freePort();
    const h = await startApp({ command: ['node', 'server.mjs'], cwd: FIXTURE_APP, baseUrl: `http://127.0.0.1:${port}`, readyTimeoutMs: 15_000, env: { PORT: String(port) }, isolation: none, stateDir: join(dir, 'state') });
    expect(await reconcileApp(h.stateFile)).toBe('stopped');
    await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
  });

  it('refuses to start when the port is already taken by something else', async () => {
    const port = await freePort();
    const first = await startApp({ command: ['node', 'server.mjs'], cwd: FIXTURE_APP, baseUrl: `http://127.0.0.1:${port}`, readyTimeoutMs: 15_000, env: { PORT: String(port) }, isolation: none, stateDir: join(dir, 'a') });
    try {
      await expect(startApp({ command: ['node', 'server.mjs'], cwd: FIXTURE_APP, baseUrl: `http://127.0.0.1:${port}`, readyTimeoutMs: 5_000, env: { PORT: String(port) }, isolation: none, stateDir: join(dir, 'b') })).rejects.toMatchObject({ details: { reason: 'port_in_use' } });
    } finally {
      await stopApp(first);
    }
  });
});

// Under srt the application is wrapped like any untrusted process. buildSrtSettings honours the
// profile's allowLocalBinding, and startApp sets it, so a loopback server can listen and answer.
const srt = new SandboxRuntimeIsolation({ orbitInstallDir: resolve(dirname(fileURLToPath(import.meta.url)), '../../..') });
const srtStatus = await srt.available();

describe('srt settings for the application', () => {
  it('carry allowLocalBinding from the profile, and default it off for every other profile', () => {
    expect(buildSrtSettings(profile()).network.allowLocalBinding).toBe(true);
    const { allowLocalBinding: _omitted, ...plain } = profile();
    expect(buildSrtSettings(plain).network.allowLocalBinding).toBe(false);
  });
});

// srt's allowLocalBinding is macOS-only. On Linux every srt process gets its own network namespace, so an application started under srt
// listens on a loopback nobody else can reach (the readiness probe, a browser, a second srt process all get ECONNREFUSED).
// UI checks there run the application and the browser in one sandbox instead (ui-single-sandbox-srt.test.ts).
const LOOPBACK_SHARED = process.platform !== 'linux';

describe.skipIf(!srtStatus.ok || !LOOPBACK_SHARED)(srtStatus.ok ? 'the application under srt' : `the application under srt skipped: ${srtStatus.detail}`, () => {
  const launch = async (port: number, appProfile: ReturnType<typeof profile> | Omit<ReturnType<typeof profile>, 'allowLocalBinding'>) => {
    const app = join(dir, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'server.mjs'), `import { createServer } from 'node:http'; createServer((q, r) => r.end('ok')).listen(${port}, '127.0.0.1');\n`);
    return startApp({
      command: [process.execPath, 'server.mjs'],
      cwd: app,
      baseUrl: `http://127.0.0.1:${port}`,
      readyTimeoutMs: 20_000,
      isolation: { provider: srt, profile: appProfile },
      stateDir: join(dir, 'state'),
    });
  };

  it('starts, answers on loopback and is stopped, with the isolation limitations recorded', async () => {
    const port = await freePort();
    const h = await launch(port, profile([join(dir, 'app')]));
    try {
      expect(h.limitations.length).toBeGreaterThan(0);
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe('ok');
    } finally {
      await stopApp(h);
    }
    expect(isGroupAlive(h.pgid)).toBe(false);
  }, 60_000);

  it('is reachable even when the caller built a profile without allowLocalBinding: startApp grants it', async () => {
    const port = await freePort();
    const { allowLocalBinding: _omitted, ...plain } = profile([join(dir, 'app')]);
    const h = await launch(port, plain);
    try {
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(200);
    } finally {
      await stopApp(h);
    }
    expect(isGroupAlive(h.pgid)).toBe(false);
  }, 60_000);
});
