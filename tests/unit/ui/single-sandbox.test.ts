// UI checks for a provider whose sandboxes each get their own loopback (srt on Linux): the application and the journey
// check must run in one sandbox, or the browser reaches nothing (ECONNREFUSED). These run the real launcher under a
// pass-through provider that only says privateLoopback, with a real HTTP server as the application and a script in
// place of Playwright, so they behave the same on macOS and Linux. The real srt on Linux is
// tests/integration/ui/ui-single-sandbox-srt.test.ts.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import type { IsolationProvider, SandboxProfile, WrapOptions, WrappedCommand } from '../../../src/isolation/types.ts';
import { defaultCheck, defaultConfig, defaultUi } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot, UiConfig } from '../../../src/policy/types.ts';
import { runUiChecks } from '../../../src/ui/runner.ts';
import { LAUNCH_ENV, LAUNCH_STATUS_FILE, UI_SINGLE_CONTAINER_LIMITATION, UI_SINGLE_SANDBOX, UI_SINGLE_SANDBOX_LIMITATION, describeLaunchFailure, launchFailed, launcherArgv, readLaunchStatus, singleSandboxLimitation } from '../../../src/ui/single-sandbox.ts';
import { ContainerIsolation } from '../../../src/isolation/container.ts';

// The "Playwright" run: reaches the application at the base URL, says what it saw beside its report, and writes a
// one-journey report that passes when the application answered.
const JOURNEYS = `
const fs = require('fs'); const path = require('path');
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
fs.mkdirSync(path.dirname(out), { recursive: true });
const mode = process.argv[1];
(async () => {
  let status = null;
  try { const r = await fetch(process.env.ORBIT_UI_BASE_URL); status = r.status; await r.text(); } catch (e) { status = String(e.cause && e.cause.code || e.message); }
  fs.writeFileSync(path.join(path.dirname(out), 'seen.json'), JSON.stringify({ status, seed: process.env.SEED ?? null, launch: process.env.${LAUNCH_ENV} ?? null, journeyOnly: process.env.JOURNEY_ONLY ?? null }));
  if (mode === 'sleep') await new Promise((r) => setTimeout(r, 60000));
  const passed = status === 200;
  fs.writeFileSync(out, JSON.stringify({ config: { version: '1.63.0', updateSnapshots: 'none', projects: [{ name: 'desktop' }] }, suites: [{ title: 'a.spec.ts', file: 'journeys/a.spec.ts', specs: [{ title: 'home', file: 'journeys/a.spec.ts', line: 3, tests: [{ projectName: 'desktop', status: passed ? 'expected' : 'unexpected', expectedStatus: 'passed', annotations: [], results: [{ status: passed ? 'passed' : 'failed', duration: 5, retry: 0, ...(passed ? {} : { error: { message: 'Error: not reachable' } }) }] }] }] }], errors: [], stats: { expected: passed ? 1 : 0, unexpected: passed ? 0 : 1, flaky: 0, skipped: 0 } }));
  process.exit(passed ? 0 : 1);
})();
`;

// The application: serves on PORT, logs the environment it got and records its pid.
const APP = `
const fs = require('fs');
console.log('app env ' + JSON.stringify({ seed: process.env.SEED ?? null, report: process.env.PLAYWRIGHT_JSON_OUTPUT_FILE ?? null, launch: process.env.${LAUNCH_ENV} ?? null, journeyOnly: process.env.JOURNEY_ONLY ?? null }));
fs.writeFileSync(process.env.PID_FILE, String(process.pid));
require('http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1');
`;

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();

let root: string;
let repo: string;
let home: string;
let candidate: Candidate;
let n = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orbit-ui-single-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  mkdirSync(join(repo, 'journeys'), { recursive: true });
  mkdirSync(home);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'test-results/\n');
  writeFileSync(join(repo, 'journeys', 'a.spec.ts'), "import { test } from '@playwright/test';\n");
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  const parentSha = sh(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'README.md'), '# acme\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'candidate');
  const commitSha = sh(repo, 'rev-parse', 'HEAD');
  candidate = { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-single', seq: 1, attempt: 1, commitSha, treeHash: sh(repo, 'rev-parse', 'HEAD^{tree}'), parentSha };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

function policy(port: number, start: string[] | null, mode = 'pass'): { snapshot: PolicySnapshot; ui: UiConfig } {
  const config = defaultConfig('supervised');
  config.checks.ui = { ...defaultCheck('ui'), kind: 'playwright', command: [process.execPath, '-e', JOURNEYS, mode], env: { JOURNEY_ONLY: '1' }, timeout_seconds: 3 };
  config.ui = defaultUi();
  const ui = config.ui;
  ui.journey_check_ids = ['ui'];
  ui.browsers = ['chromium'];
  ui.viewports = [{ width: 1440, height: 900 }];
  ui.accessibility.enabled = false;
  ui.environment.base_url = `http://127.0.0.1:${port}`;
  ui.environment.start_command = start;
  ui.environment.ready_timeout_seconds = 2;
  const { snapshot } = snapshotPolicy(config, { runId: 'orb-single', repoRoot: repo, runDir: join(home, `run-${++n}`), clock: new ManualClock() });
  return { snapshot, ui: snapshot.config.ui! };
}

/** No confinement, but each wrap is "its own sandbox" as far as the runner is told. */
function privateLoopback(): { provider: IsolationProvider; wraps: { argv: string[]; profile: SandboxProfile; opts: WrapOptions }[] } {
  const inner = new NoIsolation();
  const wraps: { argv: string[]; profile: SandboxProfile; opts: WrapOptions }[] = [];
  const provider: IsolationProvider = {
    kind: 'none',
    privateLoopback: true,
    available: () => inner.available(),
    wrap(argv, profile, opts): WrappedCommand {
      wraps.push({ argv, profile, opts });
      return inner.wrap(argv, profile, opts);
    },
  };
  return { provider, wraps };
}

const outDirOf = () => join(home, '.orbit', 'runs', 'orb-single', 'evidence', String(++n), 'ui');

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function run(p: { snapshot: PolicySnapshot; ui: UiConfig }, provider: IsolationProvider, pidFile: string) {
  return runUiChecks({ checkoutDir: repo, snapshot: p.snapshot, candidate, uiConfig: p.ui, journeyCheckIds: ['ui'], isolation: provider, outDir: outDirOf(), homeDir: home, appEnv: { SEED: 'acme-seed', PID_FILE: pidFile }, appPollMs: 20, hostEnv: { PATH: process.env.PATH ?? '', HOME: home } });
}

describe('UI checks for a provider with a private loopback per sandbox', () => {
  it('runs the application and the journeys in one wrapped launcher, which starts, serves and stops the application', async () => {
    const port = await freePort();
    const pidFile = join(root, 'app.pid');
    const { provider, wraps } = privateLoopback();
    const result = await run(policy(port, [process.execPath, '-e', APP]), provider, pidFile);
    expect(result.verdict, result.reasons.join('\n')).toBe('PASS');
    // One sandbox: the launcher, wrapped once, with the application's directory writable and loopback binding allowed.
    expect(wraps).toHaveLength(1);
    expect(wraps[0]!.argv).toEqual(launcherArgv());
    expect(wraps[0]!.profile.allowLocalBinding).toBe(true);
    expect(wraps[0]!.profile.writablePaths).toContain(join(result.outDir, 'app'));
    // The journeys reached the application, and each side kept its own environment.
    const seen = JSON.parse(readFileSync(join(result.outDir, 'ui', 'seen.json'), 'utf8'));
    expect(seen).toEqual({ status: 200, seed: null, launch: null, journeyOnly: '1' });
    const log = readFileSync(join(result.outDir, 'app', 'app.log'), 'utf8');
    expect(JSON.parse(/app env (.*)/.exec(log)![1]!)).toEqual({ seed: 'acme-seed', report: null, launch: null, journeyOnly: null });
    // Stopped afterwards, and the launcher's record says so.
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
    expect(readLaunchStatus(join(result.outDir, 'app', LAUNCH_STATUS_FILE))).toMatchObject({ app: 'stopped', exitedDuringCheck: false });
    // Disclosed with the evidence.
    expect(result.checks[0]!.isolationAdjustments).toContain(UI_SINGLE_SANDBOX);
    expect(result.limitations).toContain(UI_SINGLE_SANDBOX_LIMITATION);
    expect(result.unverified.join('\n')).toContain(UI_SINGLE_SANDBOX_LIMITATION);
  }, 30_000);

  it('is an application ERROR, with its log, when the application exits before it is ready; the journeys never run', async () => {
    const port = await freePort();
    const { provider, wraps } = privateLoopback();
    const result = await run(policy(port, [process.execPath, '-e', "console.error('acme boot failure'); process.exit(3)"]), provider, join(root, 'app.pid'));
    expect(result.verdict).toBe('ERROR');
    expect(wraps).toHaveLength(1);
    expect(result.reasons[0]).toMatch(/^the application did not start: the application exited before it became ready \(exit 3\): .*acme boot failure/);
    expect(result.notExecuted).toEqual([{ stage: 'application', checkId: null, logPath: join(result.outDir, 'app', 'app.log'), signal: null }]);
    expect(existsSync(join(result.outDir, 'ui', 'seen.json'))).toBe(false);
    expect(result.journeys).toEqual([]);
  }, 30_000);

  it('is an application ERROR when the application never becomes ready, and stops it', async () => {
    const port = await freePort();
    const pidFile = join(root, 'app.pid');
    const { provider } = privateLoopback();
    const silent = `require('fs').writeFileSync(process.env.PID_FILE, String(process.pid)); setInterval(() => {}, 1000);`;
    const result = await run(policy(port, [process.execPath, '-e', silent]), provider, pidFile);
    expect(result.verdict).toBe('ERROR');
    expect(result.reasons[0]).toMatch(new RegExp(`^the application did not start: the application was not ready at http://127\\.0\\.0\\.1:${port} within 2000 ms`));
    expect(result.notExecuted[0]!.stage).toBe('application');
    expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  }, 30_000);

  it('refuses to test something that already answers at the base URL inside the sandbox', async () => {
    const port = await freePort();
    const squatter = (await import('node:http')).createServer((_req, res) => res.end('not ours'));
    await new Promise<void>((r) => squatter.listen(port, '127.0.0.1', () => r()));
    try {
      const { provider } = privateLoopback();
      const result = await run(policy(port, [process.execPath, '-e', APP]), provider, join(root, 'app.pid'));
      expect(result.verdict).toBe('ERROR');
      expect(result.reasons[0]).toMatch(/^the application did not start: something already answers at .* inside the sandbox \(HTTP 200\)/);
      expect(existsSync(join(root, 'app.pid'))).toBe(false);
    } finally {
      await new Promise((r) => squatter.close(r));
    }
  }, 30_000);

  it('stops the application when the journeys outlive their limit', async () => {
    const port = await freePort();
    const pidFile = join(root, 'app.pid');
    const { provider } = privateLoopback();
    const result = await run(policy(port, [process.execPath, '-e', APP], 'sleep'), provider, pidFile);
    expect(result.verdict).toBe('TIMEOUT');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  it("starts the launcher with the provider's own node and discloses the provider's mode (a container: the image's node)", async () => {
    const port = await freePort();
    const inner = privateLoopback();
    // A container provider names the node on the image's PATH; here a link to this node stands in for it, so the
    // check still runs and the argv shows which node started the launcher.
    const imageNode = join(root, 'image-node');
    if (!existsSync(imageNode)) symlinkSync(process.execPath, imageNode);
    const asContainer: IsolationProvider = { ...inner.provider, kind: 'container', launcherNode: imageNode };
    const result = await run(policy(port, [process.execPath, '-e', APP]), asContainer, join(root, 'app.pid'));
    expect(result.verdict, result.reasons.join('\n')).toBe('PASS');
    expect(inner.wraps[0]!.argv).toEqual(launcherArgv(imageNode));
    expect(inner.wraps[0]!.argv[0]).not.toBe(process.execPath);
    expect(result.limitations).toContain(UI_SINGLE_CONTAINER_LIMITATION);
    expect(result.limitations).not.toContain(UI_SINGLE_SANDBOX_LIMITATION);
    expect(result.unverified.join('\n')).toContain('--network none');
    expect(singleSandboxLimitation('sandbox-runtime')).toBe(UI_SINGLE_SANDBOX_LIMITATION);
    expect(new ContainerIsolation()).toMatchObject({ privateLoopback: true, launcherNode: 'node' });
    expect(launcherArgv('node')[0]).toBe('node');
  }, 30_000);

  it('keeps the two-process path for a provider whose sandboxes share the loopback', async () => {
    const port = await freePort();
    const inner = privateLoopback();
    const shared: IsolationProvider = { ...inner.provider, privateLoopback: false };
    const result = await run(policy(port, [process.execPath, '-e', APP]), shared, join(root, 'app.pid'));
    expect(result.verdict, result.reasons.join('\n')).toBe('PASS');
    expect(inner.wraps.map((w) => w.argv[0])).toEqual([process.execPath, process.execPath]);
    expect(inner.wraps[0]!.argv).not.toEqual(launcherArgv());
    expect(result.checks[0]!.isolationAdjustments ?? []).not.toContain(UI_SINGLE_SANDBOX);
    expect(result.limitations).not.toContain(UI_SINGLE_SANDBOX_LIMITATION);
  }, 30_000);
});

describe('the launcher record', () => {
  it('reads only a record of a known state, and keeps the fields it knows', () => {
    const dir = join(root, 'status');
    mkdirSync(dir);
    const file = join(dir, LAUNCH_STATUS_FILE);
    expect(readLaunchStatus(file)).toBeNull();
    for (const bad of ['not json', '[]', 'null', '{"app":"passed"}', '{"app":3}']) {
      writeFileSync(file, bad);
      expect(readLaunchStatus(file), bad).toBeNull();
    }
    writeFileSync(file, JSON.stringify({ app: 'exited', code: null, signal: 'SIGSEGV', detail: 'x'.repeat(400), readyMs: 'soon', extra: true }));
    expect(readLaunchStatus(file)).toEqual({ app: 'exited', code: null, signal: 'SIGSEGV', detail: 'x'.repeat(300) });
    expect(launchFailed(readLaunchStatus(file))).toBe(true);
    expect(launchFailed(null)).toBe(false);
    expect(launchFailed({ app: 'stopped' })).toBe(false);
    const spec = { baseUrl: 'http://127.0.0.1:4310', readyTimeoutMs: 5 };
    expect(describeLaunchFailure({ app: 'exited', signal: 'SIGSEGV' }, spec)).toBe('the application exited before it became ready (signal SIGSEGV)');
    expect(describeLaunchFailure({ app: 'spawn_failed', detail: 'spawn acme ENOENT' }, spec)).toBe('the application could not be started: spawn acme ENOENT');
    expect(describeLaunchFailure({ app: 'ready' }, spec)).toBe('the application did not start (ready)');
    expect(dirname(file)).toBe(dir);
  });
});

describe('sandbox-runtime says when its sandboxes have their own loopback', () => {
  it('on Linux, where srt always gives each sandbox a network namespace, and not on macOS', () => {
    expect(new SandboxRuntimeIsolation({ platform: 'linux' }).privateLoopback).toBe(true);
    expect(new SandboxRuntimeIsolation({ platform: 'darwin' }).privateLoopback).toBe(false);
  });
});
