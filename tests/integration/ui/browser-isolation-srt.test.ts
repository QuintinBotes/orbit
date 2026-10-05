// Live demo 2: under the real srt on macOS every browser journey failed, because Chromium aborts when Seatbelt refuses
// its Mach rendezvous service (bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.<pid>) and srt has no
// mach-register option. Orbit's answer (docs/decisions/0001-runtime-choices.md, "Browsers under sandbox-runtime on
// macOS") is a preload on the unmodified srt CLI that adds two rules for that name pattern only, for UI checks only.
//
// These run examples/demo-app through Orbit's UI runner under the real srt, and skip only when this is not macOS or
// srt, Chromium or a C compiler (for the Mach probe) is unavailable:
//   (a) without the rules the FATAL still appears (once it does not, srt allows it itself and the preload can go);
//   (b) with them all 8 journeys pass on desktop and mobile, twice;
//   (c) inside the patched sandbox nothing else widened: other Mach names, denied reads, egress and HOME writes;
//   (d) an srt whose profile no longer has the expected shape is refused (exit 97) and reported as an environment error;
//   (e) orbit doctor's launch of the real headless Chromium passes with the rules and fails without them;
//   (f) orbit doctor runs no JavaScript of the repository.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { execCapture } from '../../../src/core/exec.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { classifyNotExecuted } from '../../../src/evidence/environment-failure.ts';
import { profileForCheck } from '../../../src/isolation/profiles.ts';
import { CHROMIUM_MACH_RENDEZVOUS, CHROMIUM_MACH_RENDEZVOUS_LIMITATION, SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import type { IsolationProvider, SandboxProfile } from '../../../src/isolation/types.ts';
import { defaultCheck, parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { runUiChecks } from '../../../src/ui/runner.ts';
import type { UiRunResult } from '../../../src/ui/types.ts';
import { chromiumAvailable, copyExample } from '../../../scripts/demo/lib/example.ts';
import { browserIsolationCheck } from '../../../src/cli/commands/doctor.ts';
import { freePort } from './helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = join(ROOT, 'examples/demo-app');
const SRT = join(ROOT, 'node_modules/.bin/srt');
const onMac = process.platform === 'darwin';
const srt = new SandboxRuntimeIsolation({ srtPath: SRT });
const srtStatus = onMac ? await srt.available() : { ok: false, detail: 'not macOS (Linux has no Mach and needs no rule)' };
const hasChromium = onMac && chromiumAvailable(ROOT);
const hasCc = onMac && spawnSync('cc', ['--version'], { stdio: 'ignore' }).status === 0;
const ready = srtStatus.ok && hasChromium && hasCc;
const why = !srtStatus.ok ? srtStatus.detail : !hasChromium ? "Playwright's Chromium is not installed" : 'no C compiler for the Mach probe';
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), 'Library', 'Caches', 'ms-playwright');

const MACH_PROBE = `#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <stdlib.h>
#include <mach/mach.h>
#include <servers/bootstrap.h>
int main(int argc, char **argv) {
  mach_port_t p = MACH_PORT_NULL; kern_return_t kr;
  if (argc < 3) return 2;
  if (!strcmp(argv[1], "checkin")) kr = bootstrap_check_in(bootstrap_port, argv[2], &p);
  else if (!strcmp(argv[1], "lookup")) kr = bootstrap_look_up(bootstrap_port, argv[2], &p);
  else return 2;
  printf("%s %s %d\\n", argv[1], argv[2], kr); fflush(stdout);
  if (kr == 0 && argc > 3) sleep(atoi(argv[3]));
  return 0;
}
`;

let base: string;
let tools: string;
let repo: string;
let home: string;
let candidate: Candidate;
let snapshot: PolicySnapshot;
let n = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

const hostEnv = () => ({ PATH: process.env.PATH ?? '', HOME: home, PLAYWRIGHT_BROWSERS_PATH: BROWSERS });

function runUi(isolation: IsolationProvider): Promise<UiRunResult> {
  const ui = snapshot.config.ui!;
  return runUiChecks({ checkoutDir: repo, snapshot, candidate, uiConfig: ui, journeyCheckIds: [...ui.journey_check_ids], isolation, outDir: join(home, '.orbit', 'runs', 'orb-browser', 'evidence', String(++n), 'ui'), homeDir: home, hostEnv: hostEnv() });
}

/** The provider Orbit would use, with the UI check's request for the Chromium rules taken away. */
function withoutRules(provider: SandboxRuntimeIsolation): IsolationProvider {
  return { kind: provider.kind, available: () => provider.available(), wrap: (argv, profile, opts) => provider.wrap(argv, { ...profile, chromiumMachRendezvous: false }, opts) };
}

beforeAll(async () => {
  if (!ready) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-browser-srt-')));
  // Outside base: the profile denies the repository's parent directory, and the probe and the srt copy must stay readable.
  tools = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-browser-tools-')));
  repo = join(base, 'repo');
  home = join(base, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'canary'), 'acme-canary\n');
  copyExample(repo);
  symlinkSync(join(ROOT, 'node_modules'), join(repo, 'node_modules'));
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'dev@acme.test');
  git(repo, 'config', 'user.name', 'acme dev');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const parentSha = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'README.md'), `${readFileSync(join(repo, 'README.md'), 'utf8')}\nA candidate.\n`);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'candidate');
  const commitSha = git(repo, 'rev-parse', 'HEAD');
  candidate = { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-browser', seq: 1, attempt: 1, commitSha, treeHash: git(repo, 'rev-parse', 'HEAD^{tree}'), parentSha };

  // The demo's own policy, on a free port.
  const yaml = readFileSync(join(DEMO, '.orbit/config.yaml'), 'utf8');
  expect(yaml).toContain('base_url: http://127.0.0.1:4310');
  const config = parseConfig(yaml.replace('base_url: http://127.0.0.1:4310', `base_url: http://127.0.0.1:${await freePort()}`));
  snapshot = snapshotPolicy(config, { runId: 'orb-browser', repoRoot: repo, runDir: join(base, 'run'), clock: new ManualClock() }).snapshot;

  writeFileSync(join(tools, 'mach.c'), MACH_PROBE);
  execFileSync('cc', ['-o', join(tools, 'mach'), join(tools, 'mach.c')]);
}, 120_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
  if (tools) rmSync(tools, { recursive: true, force: true });
});

describe.skipIf(!ready)(ready ? 'browser journeys of the demo app under the real srt on macOS' : `browser journeys under the real srt skipped: ${why}`, () => {
  it('(a) without the rules Chromium still aborts on its Mach rendezvous service, and the run is an environment ERROR', async () => {
    const result = await runUi(withoutRules(srt));
    expect(result.verdict, result.reasons.join('\n')).toBe('ERROR');
    expect(result.journeys).toEqual([]);
    expect(result.notExecuted).toHaveLength(1);
    expect(result.notExecuted[0]!.environment).toMatch(/^Chromium could not register its Mach rendezvous service: .*(bootstrap_check_in|mach_port_rendezvous)/);
    expect(result.checks[0]!.isolationAdjustments).toEqual([]);
  }, 300_000);

  it('(b) with the rules all 8 journeys pass on desktop and mobile, twice, and the evidence says what was adjusted', async () => {
    for (let round = 1; round <= 2; round++) {
      const result = await runUi(srt);
      expect(result.verdict, `round ${round}: ${result.reasons.join('\n')}`).toBe('PASS');
      expect(result.stats).toMatchObject({ passed: 8, failed: 0, flaky: 0, skipped: 0 });
      expect(result.journeys.filter((j) => j.project === 'desktop' && j.status === 'PASSED')).toHaveLength(4);
      expect(result.journeys.filter((j) => j.project === 'mobile' && j.status === 'PASSED')).toHaveLength(4);
      expect(result.checks[0]).toMatchObject({ isolation: 'sandbox-runtime', isolationAdjustments: [CHROMIUM_MACH_RENDEZVOUS], srtVersion: '0.0.78' });
      expect(result.checks[0]!.isolationLimitations).toContain(CHROMIUM_MACH_RENDEZVOUS_LIMITATION);
      expect(result.unverified).toContain(`check ui ran its browser under sandbox-runtime 0.0.78 with the isolation adjustment ${CHROMIUM_MACH_RENDEZVOUS}: ${CHROMIUM_MACH_RENDEZVOUS_LIMITATION}`);
    }
  }, 600_000);

  it('(c) inside the patched sandbox only the Chromium names widen: other Mach names, denied reads, egress and HOME writes stay refused', async () => {
    const mach = join(tools, 'mach');
    const tmp = join(base, 'probe-tmp');
    mkdirSync(tmp, { recursive: true });
    const check = { ...defaultCheck('ui'), command: ['true'], network_hosts: [] as string[], timeout_seconds: 60 };
    const profile: SandboxProfile = { ...profileForCheck({ worktree: repo, check, snapshot, extraWritable: [tmp], homeDir: home, env: hostEnv() }), allowLocalBinding: true, chromiumMachRendezvous: true };
    const inside = async (argv: string[]) => {
      const w = srt.wrap(argv, profile, { cwd: repo, env: { ...hostEnv(), TMPDIR: tmp } });
      try {
        expect(w.adjustments).toEqual([CHROMIUM_MACH_RENDEZVOUS]);
        return await execCapture(w.argv, { cwd: repo, env: w.env, timeoutMs: 60_000 });
      } finally {
        w.cleanup();
      }
    };
    // Names registered outside the sandbox, so a lookup that fails is the sandbox refusing it (1100), not a missing name (1102).
    const pid = process.pid;
    const outsideNames = [`com.example.orbit-probe.${pid}`, `org.chromium.Chromium.MachPortRendezvousServer.x${pid}`];
    const holders = outsideNames.map((name) => spawn(mach, ['checkin', name, '60'], { stdio: ['ignore', 'pipe', 'ignore'] }));
    try {
      for (const h of holders) await new Promise((r) => h.stdout!.once('data', r));
      const probe = await inside([
        '/bin/sh',
        '-c',
        [
          `"$1" checkin org.chromium.Chromium.MachPortRendezvousServer.9${pid}`,
          `"$1" checkin com.example.orbit-probe.in${pid}`,
          `"$1" checkin org.chromium.Chromium.MachPortRendezvousServer.abc${pid}`,
          `"$1" lookup ${outsideNames[0]}`,
          `"$1" lookup ${outsideNames[1]}`,
        ].join('; '),
        'sh',
        mach,
      ]);
      const lines = probe.stdout.trim().split('\n');
      expect(lines, probe.stderr).toEqual([
        `checkin org.chromium.Chromium.MachPortRendezvousServer.9${pid} 0`,
        `checkin com.example.orbit-probe.in${pid} 1100`,
        `checkin org.chromium.Chromium.MachPortRendezvousServer.abc${pid} 1100`,
        `lookup ${outsideNames[0]} 1100`,
        `lookup ${outsideNames[1]} 1100`,
      ]);
    } finally {
      for (const h of holders) h.kill('SIGKILL');
    }

    const canary = join(home, '.ssh', 'canary');
    const read = await inside([process.execPath, '-e', `try { require('fs').readFileSync(${JSON.stringify(canary)}); console.log('read'); } catch (e) { console.log(e.code); }`]);
    expect(read.stdout.trim()).toBe('EPERM');

    const egress = await inside([process.execPath, '-e', "fetch('https://example.com', { signal: AbortSignal.timeout(15000) }).then((r) => console.log('status', r.status), (e) => console.log('failed', e.cause?.code ?? e.name))"]);
    expect(egress.stdout.trim()).toMatch(/^failed/);
    const curl = await inside(['/usr/bin/curl', '-sS', '-o', '/dev/null', '-w', '%{http_code}', '--max-time', '15', 'https://example.com']);
    expect(curl.exitCode === 0 && curl.stdout.trim() === '200').toBe(false);

    const target = join(home, 'written-from-inside');
    const write = await inside([process.execPath, '-e', `try { require('fs').writeFileSync(${JSON.stringify(target)}, 'x'); console.log('wrote'); } catch (e) { console.log(e.code); }`]);
    expect(write.stdout.trim()).toBe('EPERM');
    expect(existsSync(target)).toBe(false);
  }, 300_000);

  it('(d) an srt whose profile no longer has the shape the preload was verified against is refused (exit 97) and reported as an environment error', async () => {
    // A copy of the installed srt 0.0.78 with (allow process-exec) written twice, its dependencies linked from Orbit's.
    const pkgSrc = join(ROOT, 'node_modules/@anthropic-ai/sandbox-runtime');
    const lib = join(tools, 'lib', 'node_modules');
    const pkg = join(lib, '@anthropic-ai', 'sandbox-runtime');
    cpSync(pkgSrc, pkg, { recursive: true });
    const meta = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    for (const dep of Object.keys(meta.dependencies ?? {})) {
      mkdirSync(dirname(join(lib, dep)), { recursive: true });
      if (!existsSync(join(lib, dep))) symlinkSync(join(ROOT, 'node_modules', dep), join(lib, dep));
    }
    const utils = join(pkg, 'dist', 'sandbox', 'macos-sandbox-utils.js');
    const source = readFileSync(utils, 'utf8');
    expect(source.split("'(allow process-exec)',").length - 1).toBe(1);
    writeFileSync(utils, source.replace("'(allow process-exec)',", "'(allow process-exec)',\n        '(allow process-exec)',"));
    chmodSync(join(pkg, 'dist', 'cli.js'), 0o755);
    const tampered = new SandboxRuntimeIsolation({ srtPath: join(pkg, 'dist', 'cli.js') });

    const result = await runUi(tampered);
    expect(result.verdict, result.reasons.join('\n')).toBe('ERROR');
    expect(result.checks[0]!.exitCode).toBe(97);
    expect(result.journeys).toEqual([]);
    const entry = result.notExecuted[0]!;
    expect(entry.environment).toMatch(/^the srt preload refused srt's sandbox command \(exit 97\): the profile does not hold \(allow process-exec\) exactly once/);
    // What the controller makes of it: an environment failure that blocks at once, not a journey failure to repair.
    expect(classifyNotExecuted({ checkId: 'ui', output: readFileSync(entry.logPath, 'utf8'), signal: entry.signal, browserIsolation: entry.environment ?? null })).toMatchObject({ signals: ['browser-isolation'], cause: 'the browser could not start under sandbox-runtime' });
  }, 300_000);

  it('(d2) a read-denied path that spells the marker, sandbox-exec or an apostrophe is patched around, not refused', async () => {
    const odd = join(base, 'odd');
    mkdirSync(odd, { recursive: true });
    const profile: SandboxProfile = { writablePaths: [odd], denyReadPaths: [join(odd, '.env(allow process-exec)'), join(odd, 'usr', 'bin', 'sandbox-exec'), join(odd, "it's")], allowedHosts: [], chromiumMachRendezvous: true, limits: { timeoutMs: 60_000, memoryMb: null, cpus: null, pids: null } };
    const w = srt.wrap(['/bin/echo', 'inside'], profile, { cwd: odd, env: { ...hostEnv(), TMPDIR: odd } });
    try {
      const r = await execCapture(w.argv, { cwd: odd, env: w.env, timeoutMs: 60_000 });
      expect(r.exitCode, r.stderr).toBe(0);
      expect(r.stdout.trim()).toBe('inside');
      expect(w.preloadRefusal?.()).toBeNull();
    } finally {
      w.cleanup();
    }
  }, 120_000);

  it('(e) orbit doctor launches Playwright\'s real headless Chromium through the preload and passes, and fails without the rules', async () => {
    const c = await browserIsolationCheck({ wanted: true, provider: srt, available: true, repo, env: hostEnv(), homeDir: home });
    expect(c.status, `${c.summary}\n${c.details.join('\n')}`).toBe('pass');
    expect(c.summary).toBe('Chromium starts under srt 0.0.78 with the two Mach rendezvous rules');
    // The same launch without the rules: Chromium aborts, so the pass above is the rules' doing.
    const stripped = Object.assign(withoutRules(srt), { browserIsolation: () => srt.browserIsolation() });
    const without = await browserIsolationCheck({ wanted: true, provider: stripped, available: true, repo, env: hostEnv(), homeDir: home });
    expect(without.status, without.summary).toBe('fail');
    expect(without.summary).toMatch(/did not start under srt 0\.0\.78 .*(bootstrap_check_in|mach_port_rendezvous|SIGTRAP)/);
  }, 180_000);

  it('(f) orbit doctor runs no code of the repository: a hostile @playwright/test neither runs, reads the canary, nor passes doctor', async () => {
    // A repository whose Playwright entry would read the SSH canary and exit 0, and whose Playwright names a Chromium
    // revision that is not installed.
    const hostile = join(base, 'hostile');
    const ran = join(base, 'hostile-ran');
    const pwt = join(hostile, 'node_modules', '@playwright', 'test');
    const core = join(hostile, 'node_modules', 'playwright-core');
    mkdirSync(pwt, { recursive: true });
    mkdirSync(core, { recursive: true });
    writeFileSync(join(hostile, 'package.json'), '{"name":"acme-hostile"}');
    writeFileSync(join(pwt, 'package.json'), JSON.stringify({ name: '@playwright/test', version: '1.63.0', main: 'index.js' }));
    const canary = join(home, '.ssh', 'canary');
    writeFileSync(join(pwt, 'index.js'), `const fs = require('fs'); let t = 'denied'; try { t = fs.readFileSync(${JSON.stringify(canary)}, 'utf8'); } catch {} try { fs.writeFileSync(${JSON.stringify(ran)}, t); } catch {} console.log(t); process.exit(0);`);
    writeFileSync(join(core, 'package.json'), JSON.stringify({ name: 'playwright-core', version: '1.63.0' }));
    writeFileSync(join(core, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium-headless-shell', revision: '999999' }] }));
    const c = await browserIsolationCheck({ wanted: true, provider: srt, available: true, repo: hostile, env: hostEnv(), homeDir: home });
    expect(c.status, c.summary).toBe('warn');
    expect(c.summary).toMatch(/headless Chromium \(revision 999999\) is not installed/);
    expect(existsSync(ran)).toBe(false);
    expect(JSON.stringify(c)).not.toContain('acme-canary');
    // With the real revision the real browser runs (and passes), and the stub still never does.
    writeFileSync(join(core, 'browsers.json'), readFileSync(join(ROOT, 'node_modules', 'playwright-core', 'browsers.json')));
    const real = await browserIsolationCheck({ wanted: true, provider: srt, available: true, repo: hostile, env: hostEnv(), homeDir: home });
    expect(real.status, real.summary).toBe('pass');
    expect(existsSync(ran)).toBe(false);
    expect(JSON.stringify(real)).not.toContain('acme-canary');
  }, 180_000);
});
