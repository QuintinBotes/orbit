import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ManualClock } from '../../../src/core/clock.ts';
import { execCapture } from '../../../src/core/exec.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { runUiChecks, type UiRunInput } from '../../../src/ui/runner.ts';
import type { UiRunResult } from '../../../src/ui/types.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
export const FIXTURE_APP = join(ROOT, 'tests/fixtures/ui-app');
export const TEMPLATE = join(ROOT, 'templates/playwright/orbit-fixtures.ts');

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_NOSYSTEM: '1' } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export interface UiRepo {
  dir: string;
  baseSha: string;
  home: string;
  cleanup(): void;
}

/**
 * A real git repository holding the fixture application and its journeys at
 * the repository root, as an adopting repository would have them. node_modules
 * is a link to Orbit's own so Playwright resolves without an install.
 */
export async function makeUiRepo(): Promise<UiRepo> {
  const base = mkdtempSync(join(tmpdir(), 'orbit-ui-'));
  const dir = join(base, 'repo');
  const home = join(base, 'home');
  mkdirSync(home);
  // dereference: the journeys' orbit-fixtures.ts is a link to the template, and a repository holds a copy.
  cpSync(FIXTURE_APP, dir, { recursive: true, dereference: true, filter: (src) => !/node_modules|test-results/.test(src) });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'dev@acme.test');
  git(dir, 'config', 'user.name', 'acme dev');
  git(dir, 'config', 'commit.gpgsign', 'false');
  if (!existsSync(join(dir, 'journeys/__screenshots__/desktop', process.platform))) {
    // Committed baselines exist for the platform they were recorded on; elsewhere a person would record them first.
    await updateBaselines(dir, {});
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  return { dir, baseSha: git(dir, 'rev-parse', 'HEAD'), home, cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

/** A person recording baselines: starts the app, runs the visual journey with -u. Never done by Orbit. */
export async function updateBaselines(dir: string, appEnv: Record<string, string>): Promise<void> {
  const port = await freePort();
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', PORT: String(port), ...appEnv };
  const app = spawn('node', ['server.mjs'], { cwd: dir, env, stdio: 'ignore', detached: true });
  try {
    await new Promise((r) => setTimeout(r, 700));
    const r = await execCapture(['npx', '--no-install', 'playwright', 'test', 'visual', '-u', '--reporter=null'], {
      cwd: dir,
      env: { ...env, ORBIT_UI_BASE_URL: `http://127.0.0.1:${port}` },
      timeoutMs: 90_000,
    });
    if (r.exitCode !== 0) throw new Error(`baseline update failed: ${r.stdout}${r.stderr}`);
  } finally {
    if (app.pid) process.kill(-app.pid, 'SIGKILL');
  }
}

export function commitAll(dir: string, message: string): Candidate {
  const parentSha = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
  return candidateAt(dir, parentSha);
}

export function candidateAt(dir: string, parentSha: string): Candidate {
  const commitSha = git(dir, 'rev-parse', 'HEAD');
  return { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-ui-test', seq: 1, attempt: 1, commitSha, treeHash: git(dir, 'rev-parse', 'HEAD^{tree}'), parentSha };
}

let harnessCount = 0;

export interface Harness {
  snapshot: PolicySnapshot;
  port: number;
  baseUrl: string;
}

/** Policy with one Playwright check; `filter` narrows it to some spec files, as a repository's check command may. */
export function harness(repo: UiRepo, port: number, opts: { filter?: string[]; baseUrl?: string; startCommand?: boolean; checkExtra?: string[]; a11yFailOn?: boolean } = {}): Harness {
  const baseUrl = opts.baseUrl ?? `http://127.0.0.1:${port}`;
  const command = ['npx', '--no-install', 'playwright', 'test', ...(opts.filter ?? []), ...(opts.checkExtra ?? [])];
  const yaml = `
version: 1
mode: supervised
checks:
  ui-journeys:
    command: ${JSON.stringify(command)}
    kind: playwright
    timeout_seconds: 120
ui:
  required_when_ui_changes: true
  ui_paths: ["public/**", "server.mjs"]
  browsers: [chromium]
  viewports:
    - {width: 1440, height: 900}
    - {width: 390, height: 844}
  environment:
    base_url: ${baseUrl}
    start_command: ${opts.startCommand === false ? 'null' : '[node, server.mjs]'}
    ready_timeout_seconds: 20
    isolated_test_data: true
    production_accounts: false
  journey_check_ids: [ui-journeys]
  accessibility: {enabled: true, fail_on_new_serious_or_critical: ${opts.a11yFailOn ?? true}}
  visual: {enabled: true, baseline_changes_require_review: true, baseline_globs: ["**/__screenshots__/**"]}
`;
  const runDir = join(repo.home, `run-${port}-${++harnessCount}`);
  const { snapshot } = snapshotPolicy(parseConfig(yaml), { runId: 'orb-ui-test', repoRoot: repo.dir, runDir, clock: new ManualClock() });
  return { snapshot, port, baseUrl };
}

export async function runUi(repo: UiRepo, candidate: Candidate, h: Harness, extra: Partial<UiRunInput> & { name: string }): Promise<UiRunResult> {
  const { name, ...rest } = extra;
  const ui = h.snapshot.config.ui;
  if (!ui) throw new Error('harness has no ui config');
  return runUiChecks({
    checkoutDir: repo.dir,
    snapshot: h.snapshot,
    candidate,
    uiConfig: ui,
    journeyCheckIds: [...ui.journey_check_ids],
    isolation: new NoIsolation(),
    outDir: join(repo.home, 'evidence', name),
    homeDir: repo.home,
    // The browser cache lives under the real home; the runner's safe env passes HOME through.
    ...rest,
  });
}

export function writeFile(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

/** Back to the base commit with nothing left over, so each test builds its candidate from the same tree. */
export function resetTo(repo: UiRepo): void {
  git(repo.dir, 'reset', '-q', '--hard', repo.baseSha);
  git(repo.dir, 'clean', '-q', '-fd');
}
