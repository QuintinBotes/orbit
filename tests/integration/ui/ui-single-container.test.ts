// UI checks under the real container provider. Every container runs with --network none, so it has a loopback of its
// own: an application started by the app fixture in one container is unreachable from the readiness probe on the host
// and from a browser in a second container. Like srt on Linux, the provider says so (privateLoopback), and each journey
// check runs in one container: the Orbit launcher starts the application there, waits until it is ready, runs
// Playwright and stops the application (src/ui/single-sandbox.ts), with the image's own node.
//
// The default check image (templates/worker.Dockerfile) has no browser, so this needs an image that has Playwright's
// browsers for the demo's Playwright version: ORBIT_TEST_UI_IMAGE, by default the official Playwright image. It skips
// when docker or that image is not available locally (it is never pulled here).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { ContainerIsolation } from '../../../src/isolation/container.ts';
import type { IsolationProvider } from '../../../src/isolation/types.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { runUiChecks } from '../../../src/ui/runner.ts';
import { LAUNCH_STATUS_FILE, UI_SINGLE_CONTAINER_LIMITATION, UI_SINGLE_SANDBOX, readLaunchStatus } from '../../../src/ui/single-sandbox.ts';
import type { UiRunResult } from '../../../src/ui/types.ts';
import { copyExample, installDependencies } from '../../../scripts/demo/lib/example.ts';
import { freePort } from './helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const DEMO = join(ROOT, 'examples/demo-app');
const PLAYWRIGHT_VERSION = (JSON.parse(readFileSync(join(DEMO, 'package.json'), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies['@playwright/test'];
const IMAGE = process.env.ORBIT_TEST_UI_IMAGE ?? `mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble`;
const container = new ContainerIsolation({ image: IMAGE });
const status = await container.available();
const ready = status.ok;

let base: string;
let repo: string;
let home: string;
let candidate: Candidate;
let snapshot: PolicySnapshot;
let n = 0;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } }).trim();
}

function runUi(isolation: IsolationProvider, s: PolicySnapshot = snapshot): Promise<UiRunResult> {
  const ui = s.config.ui!;
  return runUiChecks({ checkoutDir: repo, snapshot: s, candidate, uiConfig: ui, journeyCheckIds: [...ui.journey_check_ids], isolation, outDir: join(base, 'evidence', String(++n), 'ui'), homeDir: home, hostEnv: { PATH: process.env.PATH ?? '', HOME: home } });
}

beforeAll(async () => {
  if (!ready) return;
  base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-container-ui-')));
  repo = join(base, 'repo');
  home = join(base, 'home');
  mkdirSync(join(home, '.ssh'), { recursive: true });
  writeFileSync(join(home, '.ssh', 'canary'), 'acme-canary\n');
  copyExample(repo);
  // Only mounted paths exist in the container, so the dependencies must be inside the checkout, not linked from outside.
  expect(installDependencies(repo, { allowNetwork: true })).not.toBe('linked');
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
  candidate = { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-container-ui', seq: 1, attempt: 1, commitSha, treeHash: git(repo, 'rev-parse', 'HEAD^{tree}'), parentSha };

  const yaml = readFileSync(join(DEMO, '.orbit/config.yaml'), 'utf8');
  expect(yaml).toContain('base_url: http://127.0.0.1:4310');
  const config = parseConfig(yaml.replace('base_url: http://127.0.0.1:4310', `base_url: http://127.0.0.1:${await freePort()}`));
  snapshot = snapshotPolicy(config, { runId: 'orb-container-ui', repoRoot: repo, runDir: join(base, 'run'), clock: new ManualClock() }).snapshot;
}, 300_000);

afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

describe.skipIf(!ready)(ready ? `browser journeys of the demo app under the container provider (${IMAGE})` : `browser journeys under the container provider skipped: ${status.detail}`, () => {
  it('(a) the two-process path cannot work: the application started in its own container is never reachable', async () => {
    expect(container.privateLoopback).toBe(true);
    const twoProcess: IsolationProvider = { kind: container.kind, privateLoopback: false, available: () => container.available(), wrap: (argv, profile, opts) => container.wrap(argv, profile, opts) };
    const ui = structuredClone(snapshot.config.ui!);
    ui.environment.ready_timeout_seconds = 10;
    const result = await runUi(twoProcess, { ...snapshot, config: { ...snapshot.config, ui } });
    expect(result.verdict, result.reasons.join('\n')).toBe('ERROR');
    expect(result.reasons[0]).toMatch(/^the application did not start: the application was not ready at http:\/\/127\.0\.0\.1:\d+ within 10000 ms/);
    expect(result.checks).toEqual([]);
  }, 120_000);

  it('(b) in one container the 8 journeys run: functional and accessibility journeys pass, visual ones fail only on the missing Linux baselines', async () => {
    const result = await runUi(container);
    const summary = result.journeys.map((j) => `${j.id} ${j.status} ${j.error?.message.split('\n')[0] ?? ''}`).join('\n');
    const log = result.checks[0] ? readFileSync(result.checks[0].logPath, 'utf8').slice(-3000) : '';
    expect(result.checks, `${result.reasons.join('\n')}\n${log}`).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({ isolation: 'container', isolationAdjustments: [UI_SINGLE_SANDBOX], reportFound: true });
    expect(result.journeys, `${result.reasons.join('\n')}\n${summary}\n${log}`).toHaveLength(8);
    const visual = result.journeys.filter((j) => j.file.endsWith('visual.spec.ts'));
    const functional = result.journeys.filter((j) => !j.file.endsWith('visual.spec.ts'));
    expect(functional.map((j) => `${j.id} ${j.status}`), summary).toEqual(functional.map((j) => `${j.id} PASSED`));
    expect(functional).toHaveLength(6);
    for (const j of visual) {
      expect(j.status, summary).toBe('FAILED');
      expect(j.error?.message, summary).toMatch(/snapshot doesn't exist|missing/i);
    }
    expect(result.verdict).toBe('FAIL');
    expect(result.visualBaselineChanges).toEqual([]);
    expect(existsSync(join(repo, 'tests/e2e/__screenshots__/desktop/linux'))).toBe(false);
    expect(readLaunchStatus(join(result.outDir, 'app', LAUNCH_STATUS_FILE))).toMatchObject({ app: 'stopped', exitedDuringCheck: false });
    expect(result.limitations).toContain(UI_SINGLE_CONTAINER_LIMITATION);
  }, 600_000);
});
