// The first live run of the demo app: the UI app fixture crashed at start, so the mandatory UI checks never ran.
// app.log held only a native stack trace from node::InitializeOncePerProcessInternal and "Process killed by signal:
// SIGABRT". Cause: startApp hands the app a descriptor for app.log, opened for writing, and app.log lives in the run's
// evidence directory, which the profile read-denies (~/.orbit holds every run's state). On macOS Seatbelt answers EPERM
// to fstat on such a descriptor, and node's own startup (PlatformInit) aborts on any fstat failure for fds 0 to 2.
// The unit checks were never affected: the check shim gives the sandboxed command pipes, not a file under ~/.orbit.
//
// These tests start the real examples/demo-app through startApp under the real srt with the policy's default limits,
// laid out as a run lays it out (state under the home's .orbit), and skip only when srt is unavailable.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isGroupAlive } from '../../../src/core/proc.ts';
import { getIsolation } from '../../../src/isolation/index.ts';
import { profileForCheck } from '../../../src/isolation/profiles.ts';
import { buildSrtSettings, SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { defaultCheck, isolationLimits, parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import { startApp, stopApp } from '../../../src/ui/app-fixture.ts';
import { freePort } from './helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = join(ROOT, 'examples/demo-app');
const srt = new SandboxRuntimeIsolation({ orbitInstallDir: ROOT });
const srtStatus = await srt.available();

let base: string;
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-appsrt-')));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore', env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
}

describe.skipIf(!srtStatus.ok)(srtStatus.ok ? 'the demo app under srt with the default limits' : `the demo app under srt skipped: ${srtStatus.detail}`, () => {
  it('starts through the app fixture and becomes ready, with its log under the read-denied run directory', async () => {
    // The demo's own policy: its ui.environment.start_command, its isolation section, limits at their defaults.
    const config = parseConfig(readFileSync(join(DEMO, '.orbit/config.yaml'), 'utf8'));
    const limits = isolationLimits(config);
    expect(limits).toEqual({ cpu_seconds: 3600, max_processes: 2048, max_file_mb: 2048, memory_mb: 4096 });
    const startCommand = config.ui!.environment.start_command!;
    expect(startCommand).toEqual(['node', 'src/main.ts']);

    const home = join(base, 'home');
    const repo = join(base, 'repo');
    mkdirSync(home);
    cpSync(DEMO, repo, { recursive: true, filter: (src) => !/node_modules/.test(src) });
    git(repo, 'init', '-q', '-b', 'main');
    const { snapshot } = snapshotPolicy(config, { runId: 'orb-demo', repoRoot: repo, runDir: join(base, 'run'), clock: new ManualClock() });

    // A run's evidence lives under ~/.orbit/runs/<id>/..., which every profile read-denies.
    const outDir = join(home, '.orbit', 'runs', 'orb-demo', 'evidence', '1', 'ui');
    const tmpDir = join(outDir, 'tmp');
    mkdirSync(tmpDir, { recursive: true });
    const stateDir = join(outDir, 'app');

    const hostEnv = { PATH: process.env.PATH, HOME: home };
    const appCheck = { ...defaultCheck('ui-app'), command: startCommand, network_hosts: [], timeout_seconds: 60 };
    const profile = profileForCheck({ worktree: repo, check: appCheck, snapshot, extraWritable: [tmpDir], homeDir: home, env: hostEnv });
    expect(profile.denyReadPaths).toContain(join(realpathSync(home), '.orbit'));

    const port = await freePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const provider = getIsolation(config.isolation, { orbitInstallDir: ROOT, mode: config.mode });
    const handle = await startApp({
      command: startCommand,
      cwd: repo,
      baseUrl,
      readyTimeoutMs: 30_000,
      env: { ORBIT_UI_BASE_URL: baseUrl, PORT: String(port), ORBIT_UI_PORT: String(port), ORBIT_UI_ISOLATED_TEST_DATA: '1', TMPDIR: tmpDir },
      isolation: { provider, profile },
      stateDir,
      hostEnv,
    });
    try {
      const res = await fetch(baseUrl);
      expect(res.status).toBeLessThan(500);
      expect(readFileSync(handle.logPath, 'utf8')).toContain('demo-app listening');
      expect(handle.limitations.join('\n')).toMatch(/ulimit hard limits/);
      expect(handle.limitations.join('\n')).toMatch(/watchdog/);
    } finally {
      await stopApp(handle);
    }
    expect(isGroupAlive(handle.pgid)).toBe(false);
  }, 120_000);
});

// What must stay true for the other srt paths: a worker shim hands its command a spill file it has already unlinked
// and a prompt file opened for reading, and neither is affected by the deny. Only a descriptor opened for writing on a
// path the sandbox cannot read makes node abort.
describe.skipIf(!srtStatus.ok)(srtStatus.ok ? 'descriptors handed to a sandboxed node under a read-denied directory' : 'descriptors skipped', () => {
  const nodeUnderSrt = (denied: string, stdio: (number | 'ignore' | 'pipe')[]) => {
    const repo = join(base, 'repo');
    mkdirSync(repo, { recursive: true });
    const profile = { writablePaths: [repo], denyReadPaths: [denied], allowedHosts: [], limits: { timeoutMs: 30_000, memoryMb: null, cpus: null, pids: null } };
    const settings = join(base, 'settings.json');
    writeFileSync(settings, JSON.stringify(buildSrtSettings(profile)));
    return spawnSync(join(ROOT, 'node_modules/.bin/srt'), ['--settings', settings, '--', process.execPath, '-e', 'console.log("ran")'], { cwd: repo, env: { PATH: process.env.PATH ?? '', HOME: base }, stdio, encoding: 'utf8' });
  };

  it('an unlinked spill file and a read-only prompt file do not stop node from starting', () => {
    const dir = join(base, 'worker');
    mkdirSync(dir);
    const spillPath = join(dir, '.spill');
    const spill = openSync(spillPath, 'a+', 0o600);
    unlinkSync(spillPath);
    const promptPath = join(dir, 'prompt.md');
    writeFileSync(promptPath, 'x');
    const prompt = openSync(promptPath, 'r');
    const r = nodeUnderSrt(dir, [prompt, spill, spill]);
    expect(r.status).toBe(0);
    expect(r.signal).toBeNull();
  });
});
