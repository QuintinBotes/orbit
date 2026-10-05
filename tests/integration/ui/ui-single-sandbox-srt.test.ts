// UI checks under the real srt on Linux. Every srt process there gets its own network namespace (srt's
// allowLocalBinding is macOS-only), so the application the app fixture starts in one srt process is unreachable from a
// browser in another (ECONNREFUSED). Orbit's answer (docs/decisions/0001-runtime-choices.md, "Browsers under
// sandbox-runtime on macOS", Linux paragraph) is one sandbox per journey check: an Orbit launcher inside it starts the
// application, waits until it is ready, runs Playwright and stops the application (src/ui/single-sandbox.ts).
//
// These run examples/demo-app through Orbit's UI runner under the real srt, and skip only when this is not Linux or
// srt or Playwright's Chromium is unavailable:
//   (a) the two-process path cannot work here: the application never becomes reachable from outside its sandbox;
//   (b) in one sandbox the demo's 8 journeys run: the 6 functional and accessibility journeys pass, and the 2 visual
//       journeys fail only because the demo's baselines are recorded for darwin (none is written);
//   (c) inside that sandbox the profile still holds: credentials stay unreadable, HOME unwritable, egress filtered.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import type { IsolationProvider } from '../../../src/isolation/types.ts';
import { defaultCheck, parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { runUiChecks } from '../../../src/ui/runner.ts';
import { LAUNCH_STATUS_FILE, UI_SINGLE_SANDBOX, UI_SINGLE_SANDBOX_LIMITATION, readLaunchStatus } from '../../../src/ui/single-sandbox.ts';
import type { UiRunResult } from '../../../src/ui/types.ts';
import { chromiumAvailable, copyExample } from '../../../scripts/demo/lib/example.ts';
import { freePort } from './helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = join(ROOT, 'examples/demo-app');
const SRT = join(ROOT, 'node_modules/.bin/srt');
const onLinux = process.platform === 'linux';
const srt = new SandboxRuntimeIsolation({ srtPath: SRT });
const srtStatus = onLinux ? await srt.available() : { ok: false, detail: 'not Linux (srt shares the host loopback on macOS)' };
const hasChromium = onLinux && chromiumAvailable(ROOT);
const ready = srtStatus.ok && hasChromium;
const why = !srtStatus.ok ? srtStatus.detail : "Playwright's Chromium is not installed";
const BROWSERS = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), '.cache', 'ms-playwright');

let base: string;
let repo: string;
let home: string;
let candidate: Candidate;
let snapshot: PolicySnapshot;
let n = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

const hostEnv = () => ({ PATH: process.env.PATH ?? '', HOME: home, PLAYWRIGHT_BROWSERS_PATH: BROWSERS });

function runUi(isolation: IsolationProvider, s: PolicySnapshot = snapshot): Promise<UiRunResult> {
  const ui = s.config.ui!;
  return runUiChecks({ checkoutDir: repo, snapshot: s, candidate, uiConfig: ui, journeyCheckIds: [...ui.journey_check_ids], isolation, outDir: join(home, '.orbit', 'runs', 'orb-linux-ui', 'evidence', String(++n), 'ui'), homeDir: home, hostEnv: hostEnv() });
}

beforeAll(async () => {
  if (!ready) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-linux-ui-')));
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
  candidate = { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-linux-ui', seq: 1, attempt: 1, commitSha, treeHash: git(repo, 'rev-parse', 'HEAD^{tree}'), parentSha };

  // The demo's own policy, on a free port.
  const yaml = readFileSync(join(DEMO, '.orbit/config.yaml'), 'utf8');
  expect(yaml).toContain('base_url: http://127.0.0.1:4310');
  const config = parseConfig(yaml.replace('base_url: http://127.0.0.1:4310', `base_url: http://127.0.0.1:${await freePort()}`));
  snapshot = snapshotPolicy(config, { runId: 'orb-linux-ui', repoRoot: repo, runDir: join(base, 'run'), clock: new ManualClock() }).snapshot;
}, 120_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!ready)(ready ? 'browser journeys of the demo app under the real srt on Linux' : `browser journeys under the real srt on Linux skipped: ${why}`, () => {
  it('(a) the two-process path cannot work: the application started in its own srt process is never reachable', async () => {
    expect(srt.privateLoopback).toBe(true);
    const twoProcess: IsolationProvider = { kind: srt.kind, privateLoopback: false, available: () => srt.available(), wrap: (argv, profile, opts) => srt.wrap(argv, profile, opts) };
    const ui = structuredClone(snapshot.config.ui!);
    ui.environment.ready_timeout_seconds = 10;
    const short = { ...snapshot, config: { ...snapshot.config, ui } };
    const result = await runUi(twoProcess, short);
    expect(result.verdict, result.reasons.join('\n')).toBe('ERROR');
    expect(result.reasons[0]).toMatch(/^the application did not start: the application was not ready at http:\/\/127\.0\.0\.1:\d+ within 10000 ms/);
    expect(result.checks).toEqual([]);
  }, 120_000);

  it('(b) in one sandbox the 8 journeys run: functional and accessibility journeys pass, visual ones fail only on the missing Linux baselines', async () => {
    const result = await runUi(srt);
    const summary = result.journeys.map((j) => `${j.id} ${j.status} ${j.error?.message.split('\n')[0] ?? ''}`).join('\n');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ isolation: 'sandbox-runtime', isolationAdjustments: [UI_SINGLE_SANDBOX], srtVersion: '0.0.78', reportFound: true });
    expect(result.journeys, `${result.reasons.join('\n')}\n${summary}`).toHaveLength(8);
    const visual = result.journeys.filter((j) => j.file.endsWith('visual.spec.ts'));
    const functional = result.journeys.filter((j) => !j.file.endsWith('visual.spec.ts'));
    expect(functional.map((j) => `${j.id} ${j.status}`)).toEqual(functional.map((j) => `${j.id} PASSED`));
    expect(functional).toHaveLength(6);
    expect(new Set(functional.map((j) => j.project))).toEqual(new Set(['desktop', 'mobile']));
    // Reported separately: the demo records its visual baselines for darwin only, and Orbit never records one.
    expect(visual.map((j) => j.project).sort()).toEqual(['desktop', 'mobile']);
    for (const j of visual) {
      expect(j.status, summary).toBe('FAILED');
      expect(j.error?.message, summary).toMatch(/snapshot doesn't exist|missing/i);
    }
    expect(result.verdict).toBe('FAIL');
    expect(result.visualBaselineChanges).toEqual([]);
    expect(readdirSync(join(repo, 'tests/e2e/__screenshots__/desktop'))).toEqual(['darwin']);
    // The application ran inside, wrote its log there, and was stopped by the launcher.
    expect(readLaunchStatus(join(result.outDir, 'app', LAUNCH_STATUS_FILE))).toMatchObject({ app: 'stopped', exitedDuringCheck: false });
    expect(existsSync(join(result.outDir, 'app', 'app.log'))).toBe(true);
    expect(result.limitations).toContain(UI_SINGLE_SANDBOX_LIMITATION);
  }, 600_000);

  it('(c) inside the one sandbox the profile still holds for the application and the journeys', async () => {
    // A journey check that probes from inside, after the launcher started the demo application there.
    const probeOut = join(base, 'probe-out');
    const canary = join(home, '.ssh', 'canary');
    const target = join(home, 'written-from-inside');
    const probe = [
      "const fs = require('fs');",
      'const out = {};',
      `try { out.read = fs.readFileSync(${JSON.stringify(canary)}, 'utf8'); } catch (e) { out.read = e.code; }`,
      `try { fs.writeFileSync(${JSON.stringify(target)}, 'x'); out.write = 'wrote'; } catch (e) { out.write = e.code; }`,
      '(async () => {',
      "  try { const r = await fetch(process.env.ORBIT_UI_BASE_URL + '/reports'); out.app = r.status; } catch (e) { out.app = String(e.cause?.code ?? e.name); }",
      "  try { const r = await fetch('https://example.com', { signal: AbortSignal.timeout(15000) }); out.egress = r.status; } catch (e) { out.egress = 'failed'; }",
      // The check's own evidence directory (<outDir>/<check id>) is writable from inside.
      `  fs.writeFileSync(${JSON.stringify(join(probeOut, 'ui', 'probe.json'))}, JSON.stringify(out));`,
      '  process.exit(1);',
      '})();',
    ].join('\n');
    const config = structuredClone(snapshot.config);
    config.checks.ui = { ...defaultCheck('ui'), ...config.checks.ui!, command: [process.execPath, '-e', probe, '--'] };
    const s = snapshotPolicy(config, { runId: 'orb-linux-ui', repoRoot: repo, runDir: join(base, 'run-probe'), clock: new ManualClock() }).snapshot;
    const ui = s.config.ui!;
    const result = await runUiChecks({ checkoutDir: repo, snapshot: s, candidate, uiConfig: ui, journeyCheckIds: [...ui.journey_check_ids], isolation: srt, outDir: probeOut, homeDir: home, hostEnv: hostEnv() });
    expect(result.checks[0]!.isolationAdjustments).toEqual([UI_SINGLE_SANDBOX]);
    const probed = join(probeOut, 'ui', 'probe.json');
    expect(existsSync(probed), `${result.reasons.join('\n')}\n${readFileSync(result.checks[0]!.logPath, 'utf8')}`).toBe(true);
    const seen = JSON.parse(readFileSync(join(probeOut, 'ui', 'probe.json'), 'utf8'));
    expect(seen.app).toBe(200);
    expect(seen.read).not.toBe('acme-canary\n');
    expect(seen.write).not.toBe('wrote');
    expect(existsSync(target)).toBe(false);
    expect(seen.egress).toBe('failed');
  }, 300_000);
});
