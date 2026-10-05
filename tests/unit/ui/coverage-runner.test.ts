import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { CHROMIUM_MACH_RENDEZVOUS_LIMITATION } from '../../../src/isolation/sandbox-runtime.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { defaultCheck, defaultConfig, defaultUi } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { CheckDefinition, PolicySnapshot, UiConfig } from '../../../src/policy/types.ts';
import { a11yFailOn, assertCheckCommandAllowed, assertCheckoutMatchesCandidate, changedBetween, collectAttachments, runUiChecks, toEvidenceUi, type UiRunInput } from '../../../src/ui/runner.ts';
import type { RawAttachment } from '../../../src/ui/report.ts';
import { runResult, journeyResult } from './builders.ts';

// ---------------------------------------------------------------------------
// A Playwright that is not Playwright: the isolation provider swaps the command for a script that writes the report
// a scenario describes. The application under test and anything else Orbit starts pass through untouched.

interface Scenario {
  /** Written as the JSON report (an object) or as raw text. */
  report?: unknown;
  exitCode?: number;
  signal?: boolean;
  sleepMs?: number;
  stdout?: string;
  stderr?: string;
  /** Files the "run" writes, by path (absolute, or relative to the checkout). */
  files?: Record<string, string>;
}
interface RunContext {
  call: number;
  checkId: string;
  outputDir: string;
  cwd: string;
  argv: string[];
}

const SCRIPT = `
const fs = require('fs'); const path = require('path');
const s = JSON.parse(process.argv[1]);
for (const [p, c] of Object.entries(s.files || {})) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }
if (s.report !== undefined) { const f = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof s.report === 'string' ? s.report : JSON.stringify(s.report)); }
if (s.stdout) console.log(s.stdout);
if (s.stderr) console.error(s.stderr);
const finish = () => { if (s.signal) process.kill(process.pid, 'SIGKILL'); process.exit(s.exitCode || 0); };
if (s.sleepMs) setTimeout(finish, s.sleepMs); else finish();
`;

function fakePlaywright(scenario: (c: RunContext) => Scenario): { provider: IsolationProvider; calls: RunContext[]; apps: string[][] } {
  const inner = new NoIsolation();
  const calls: RunContext[] = [];
  const apps: string[][] = [];
  const provider: IsolationProvider = {
    kind: 'none',
    available: () => inner.available(),
    wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
      if (opts.env.ORBIT_UI_RUN !== '1') {
        apps.push(argv);
        return inner.wrap(argv, profile, opts);
      }
      const output = argv.find((a) => a.startsWith('--output='))!.slice('--output='.length);
      const ctx: RunContext = { call: calls.length + 1, checkId: basename(dirname(output)), outputDir: output, cwd: opts.cwd, argv };
      calls.push(ctx);
      const w = inner.wrap([process.execPath, '-e', SCRIPT, JSON.stringify(scenario(ctx))], profile, opts);
      return w;
    },
  };
  return { provider, calls, apps };
}

// ---------------------------------------------------------------------------
// Reports

interface PwResult {
  status: string;
  duration?: number;
  retry?: number;
  error?: Record<string, unknown>;
  steps?: unknown[];
  attachments?: unknown[];
}
interface PwTest {
  title: string;
  outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped';
  expectedStatus?: string;
  project?: string;
  results?: PwResult[];
  annotations?: string[];
}
const ok = (title: string, over: Partial<PwTest> = {}): PwTest => ({ title, outcome: 'expected', results: [{ status: 'passed', duration: 10, retry: 0 }], ...over });
const failed = (title: string, over: Partial<PwTest> = {}): PwTest => ({ title, outcome: 'unexpected', results: [{ status: 'failed', duration: 10, retry: 0, error: { message: 'Error: expect(received).toBe(expected)\n\nExpected: "a"\nReceived: "b"' } }], ...over });

function report(tests: PwTest[], over: { config?: Record<string, unknown>; errors?: unknown[]; stats?: Record<string, number>; file?: string } = {}): unknown {
  const file = over.file ?? 'journeys/a.spec.ts';
  const count = (o: string) => tests.filter((t) => t.outcome === o).length;
  return {
    config: { version: '1.63.0', updateSnapshots: 'none', projects: [{ name: 'desktop' }], ...over.config },
    suites: [{ title: basename(file), file, specs: tests.map((t, i) => ({ title: t.title, file, line: 3 + i, tests: [{ projectName: t.project ?? 'desktop', status: t.outcome, expectedStatus: t.expectedStatus ?? 'passed', annotations: (t.annotations ?? []).map((type) => ({ type })), results: t.results ?? [] }] })) }],
    errors: over.errors ?? [],
    stats: over.stats ?? { expected: count('expected'), unexpected: count('unexpected'), flaky: count('flaky'), skipped: count('skipped') },
  };
}

// ---------------------------------------------------------------------------
// A repository, a candidate and a policy

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();
const put = (dir: string, rel: string, content: string | Buffer) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), content);
};

let root: string;
let repo: string;
let home: string;
let baseSha: string;
let n = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orbit-ui-cov-'));
  repo = join(root, 'repo');
  home = join(root, 'home');
  mkdirSync(repo);
  mkdirSync(home);
  sh(repo, 'init', '-q', '-b', 'main');
  put(repo, '.gitignore', 'node_modules/\ntest-results/\n');
  put(repo, 'README.md', '# acme\n');
  put(repo, 'journeys/a.spec.ts', "import { test } from '@playwright/test';\n");
  put(repo, 'journeys/__screenshots__/home.png', 'png-bytes');
  put(repo, 'src/app.js', 'export const a = 1;\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  baseSha = sh(repo, 'rev-parse', 'HEAD');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Commit `change` on top of the base and leave the working tree at that commit. */
function candidate(change: () => void = () => put(repo, 'src/app.js', 'export const a = 2;\n')): Candidate {
  change();
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '--allow-empty', '-m', 'candidate');
  const commitSha = sh(repo, 'rev-parse', 'HEAD');
  return { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-ui-cov', seq: 1, attempt: 1, commitSha, treeHash: sh(repo, 'rev-parse', 'HEAD^{tree}'), parentSha: baseSha };
}

interface Policy {
  snapshot: PolicySnapshot;
  ui: UiConfig;
}
function policy(over: { checks?: Record<string, Partial<CheckDefinition>>; ui?: (u: UiConfig) => void; baseUrl?: string } = {}): Policy {
  const config = defaultConfig('supervised');
  const ids = Object.keys(over.checks ?? { 'ui-journeys': {} });
  for (const id of ids) {
    config.checks[id] = { ...defaultCheck(id), kind: 'playwright', command: ['playwright-cli', 'test'], timeout_seconds: 30, ...(over.checks?.[id] ?? {}) };
  }
  config.ui = defaultUi();
  const ui = config.ui;
  ui.journey_check_ids = ids;
  ui.browsers = ['chromium'];
  ui.viewports = [{ width: 1440, height: 900 }];
  ui.environment.base_url = over.baseUrl ?? 'http://127.0.0.1:3999';
  ui.environment.start_command = null;
  over.ui?.(ui);
  const { snapshot } = snapshotPolicy(config, { runId: 'orb-ui-cov', repoRoot: repo, runDir: join(home, `run-${++n}`), clock: new ManualClock() });
  return { snapshot, ui: snapshot.config.ui! };
}

function input(p: Policy, c: Candidate, provider: IsolationProvider, over: Partial<UiRunInput> = {}): UiRunInput {
  return { checkoutDir: repo, snapshot: p.snapshot, candidate: c, uiConfig: p.ui, journeyCheckIds: [...p.ui.journey_check_ids], isolation: provider, outDir: join(root, 'evidence', `r${++n}`), homeDir: home, ...over };
}

const run = (p: Policy, c: Candidate, scenario: (ctx: RunContext) => Scenario, over: Partial<UiRunInput> = {}) => {
  const fake = fakePlaywright(scenario);
  return runUiChecks(input(p, c, fake.provider, over)).then((result) => ({ result, fake }));
};

describe('refusals before anything runs', () => {
  it('refuses a configuration that allows production accounts, without starting a journey', async () => {
    const p = policy();
    const c = candidate();
    const uiConfig = { ...p.ui, environment: { ...p.ui.environment, production_accounts: true as unknown as false } };
    const fake = fakePlaywright(() => ({ report: report([ok('x')]) }));
    await expect(runUiChecks(input(p, c, fake.provider, { uiConfig }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'ui.environment.production_accounts' } });
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses journey check ids that are missing, undefined or not playwright checks', async () => {
    const p = policy({ checks: { 'ui-journeys': {}, plain: { kind: 'command' } } });
    const c = candidate();
    const fake = fakePlaywright(() => ({}));
    await expect(runUiChecks(input(p, c, fake.provider, { journeyCheckIds: [] }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', details: { rule: 'ui.journey_check_ids' } });
    await expect(runUiChecks(input(p, c, fake.provider, { journeyCheckIds: ['ghost'] }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('"ghost" is not defined') });
    await expect(runUiChecks(input(p, c, fake.provider, { journeyCheckIds: ['plain'] }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('must have kind: playwright') });
    expect(fake.calls).toHaveLength(0);
  });

  it('refuses a check whose working directory leaves the checkout', async () => {
    const p = policy({ checks: { 'ui-journeys': { cwd: '../elsewhere' } } });
    const c = candidate();
    await expect(run(p, c, () => ({}))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'checks.cwd' } });
  });

  it('refuses a candidate whose commit has another tree than the one named, a checkout that drifted, and one with stray files', async () => {
    const p = policy();
    const c = candidate();
    await expect(run(p, { ...c, treeHash: 'f'.repeat(40) }, () => ({}))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('names tree') });
    put(repo, 'src/app.js', 'drifted\n');
    await expect(run(p, c, () => ({}))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('checkout differs') });
    sh(repo, 'checkout', '--', 'src/app.js');
    put(repo, 'journeys/extra.spec.ts', 'x');
    await expect(run(p, c, () => ({}))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('untracked files') });
    await expect(assertCheckoutMatchesCandidate(repo, c, join(repo, 'journeys'))).resolves.toBeUndefined();
  });

  it('reports git failing (a commit that does not exist) as GIT_FAILED with the tail of its stderr', async () => {
    const p = policy();
    const c = candidate();
    await expect(run(p, { ...c, commitSha: '1'.repeat(40) }, () => ({}))).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('git rev-parse failed') });
  });
});

describe('a clean run', () => {
  it('passes, binds the evidence to the candidate and says what it could not establish', async () => {
    const p = policy({ ui: (u) => void (u.accessibility.enabled = false) });
    const c = candidate();
    const { result, fake } = await run(p, c, () => ({ report: report([ok('home page shows reports')]) }));
    expect(result).toMatchObject({ verdict: 'PASS', passed: true, stats: { passed: 1, failed: 0, flaky: 0, skipped: 0, other: 0 }, flaky: false });
    expect(result.binding).toMatchObject({ candidateId: c.id, treeHash: c.treeHash, commitSha: c.commitSha, playwrightVersion: '1.63.0', accessibilityFailOn: 'serious,critical', baseUrl: 'http://127.0.0.1:3999' });
    expect(result.unverified).toEqual(expect.arrayContaining([expect.stringContaining('start_command is not set'), 'configured viewports never exercised: 1440x900']));
    // The journey carries a reproduction that Orbit can rerun, with the flags it enforces.
    expect(result.journeys[0]!.reproduction.argv).toEqual(expect.arrayContaining(['--update-snapshots=none', '--trace=retain-on-failure', '--project=desktop']));
    expect(fake.calls[0]!.argv).toEqual(expect.arrayContaining(['--reporter=json', '--update-snapshots=none', '--retries=0']));
    expect(JSON.parse(readFileSync(join(result.outDir, 'ui-result.json'), 'utf8')).verdict).toBe('PASS');
  });

  it('passes the projects it was told to run, and a shell check its flags as parameters', async () => {
    const p = policy({ checks: { 'ui-journeys': { shell: true, command: ['playwright-cli test'] } } });
    const c = candidate();
    const { fake } = await run(p, c, () => ({ report: report([ok('x')]) }), { projects: ['desktop', 'mobile'] });
    expect(fake.calls[0]!.argv.slice(0, 3)).toEqual(['/bin/sh', '-c', 'playwright-cli test "$@"']);
    expect(fake.calls[0]!.argv).toEqual(expect.arrayContaining(['--project=desktop', '--project=mobile']));
  });

  it('hashes a check the snapshot has no recorded hash for, and notes a report that was narrowed', async () => {
    const p = policy();
    const c = candidate();
    const snapshot = { ...p.snapshot, check_config_hashes: {} };
    const { result } = await run(p, c, () => ({ report: report([ok('x')], { config: { argv: ['playwright', 'test', '-g', 'x'], grepInvert: 'slow' } }) }), { snapshot });
    expect(result.verdict).toBe('PASS');
    expect(result.unverified.join('\n')).toContain('the run was narrowed (grepInvert is set; the command line carries -g)');
  });
});

describe('journeys of every status', () => {
  it('fails on a failing, a timed out and a skipped journey, and keeps flaky ones visible', async () => {
    const p = policy({ ui: (u) => void (u.accessibility.enabled = false) });
    const c = candidate();
    const tests: PwTest[] = [
      ok('passes'),
      { title: 'flaky one', outcome: 'flaky', results: [{ status: 'failed', retry: 0, error: { message: 'first attempt failed' } }, { status: 'passed', retry: 1 }] },
      { title: 'skipped one', outcome: 'skipped', results: [{ status: 'skipped' }] },
      failed('fails loudly', { results: [{ status: 'failed', error: { message: 'boom' }, steps: [{ title: 'open page', error: undefined }, { title: 'click export', error: { message: 'x' } }] }] }),
      { title: 'times out', outcome: 'unexpected', results: [{ status: 'timedOut', error: { message: 'Test timeout of 30000ms exceeded' } }] },
      ok('inverted', { expectedStatus: 'failed', annotations: ['slow'] }),
    ];
    const { result } = await run(p, c, () => ({ report: report(tests), exitCode: 1 }));
    expect(result.verdict).toBe('FAIL');
    expect(result.stats).toEqual({ passed: 2, failed: 2, flaky: 1, skipped: 1, other: 0 });
    expect(result.flaky).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/journey .*fails loudly failed at step "click export"/), expect.stringMatching(/journey .*times out timed out$/), expect.stringMatching(/journey .*skipped one was skipped, which proves nothing/)]),
    );
    expect(result.unverified.join('\n')).toMatch(/journey .*inverted is annotated test.fail\(\): a "pass" there means the failure still happens/);
    const statuses = Object.fromEntries(result.journeys.map((j) => [j.title, j.status]));
    expect(statuses).toEqual({ passes: 'PASSED', 'flaky one': 'FLAKY', 'skipped one': 'SKIPPED', 'fails loudly': 'FAILED', 'times out': 'TIMED_OUT', inverted: 'PASSED' });
    expect(result.journeys.find((j) => j.title === 'fails loudly')).toMatchObject({ failedStep: 'click export', error: { message: 'boom', expected: null, observed: null } });
  });

  it('ends the whole run as CANCELLED when a journey was interrupted', async () => {
    const p = policy({ checks: { first: {}, second: {} }, ui: (u) => void (u.accessibility.enabled = false) });
    const c = candidate();
    const { result, fake } = await run(p, c, () => ({ report: report([{ title: 'cut short', outcome: 'unexpected', results: [{ status: 'interrupted' }] }]), exitCode: 1 }));
    expect(result.verdict).toBe('CANCELLED');
    expect(result.journeys[0]!.status).toBe('INTERRUPTED');
    expect(result.stats.other).toBe(2);
    expect(fake.calls.map((x) => x.checkId)).toEqual(['first', 'second']);
  });

  it('stops after the first check when the run is cancelled between checks', async () => {
    const p = policy({ checks: { first: {}, second: {} }, ui: (u) => void (u.accessibility.enabled = false) });
    const c = candidate();
    const ac = new AbortController();
    ac.abort();
    const { result, fake } = await run(p, c, () => ({ report: report([ok('x')]) }), { abortSignal: ac.signal });
    expect(result.verdict).toBe('CANCELLED');
    expect(fake.calls.map((x) => x.checkId)).toEqual(['first']);
  });
});

describe('checks that cannot be believed', () => {
  const p = () => policy({ ui: (u) => void (u.accessibility.enabled = false) });
  const verdictOf = async (scenario: Scenario, over: Partial<UiRunInput> = {}) => {
    const c = candidate();
    return (await run(p(), c, () => scenario, over)).result;
  };

  it('is CANCELLED when the run was aborted, and TIMEOUT when the check outlived its limit', async () => {
    const ac = new AbortController();
    ac.abort();
    const cancelled = await verdictOf({ report: report([ok('x')]) }, { abortSignal: ac.signal });
    expect(cancelled).toMatchObject({ verdict: 'CANCELLED' });
    expect(cancelled.reasons).toEqual(['check ui-journeys was cancelled']);
    // (a fresh repository state for the second run)
    const q = policy({ checks: { 'ui-journeys': { timeout_seconds: 1 } } });
    const c = candidate(() => put(repo, 'src/app.js', 'export const a = 3;\n'));
    const { result } = await run(q, c, () => ({ sleepMs: 5_000, report: report([ok('x')]) }));
    expect(result.verdict).toBe('TIMEOUT');
    expect(result.reasons).toEqual(['check ui-journeys exceeded its 1 s limit']);
  }, 30_000);

  it('is ERROR with the end of the output when there is no report, and says "no output" when there is none', async () => {
    expect((await verdictOf({ exitCode: 3, stderr: 'playwright: command not found' })).reasons).toEqual(['check ui-journeys produced no Playwright report (exit 3): playwright: command not found']);
    expect((await verdictOf({ exitCode: 3 })).reasons[0]).toContain('(exit 3): (no output)');
    expect((await verdictOf({ exitCode: 3, stdout: 'only stdout ghp_abcdefghijklmnopqrstuvwxyz0123456789' })).reasons[0]).toMatch(/\(exit 3\): only stdout \[REDACTED/);
    expect((await verdictOf({ exitCode: 3, stderr: `${'x'.repeat(900)}END` })).reasons[0]).toMatch(/\(exit 3\): \.\.\.x+END$/);
    expect((await verdictOf({ signal: true })).reasons[0]).toContain('(exit signal)');
  });

  it('records a journey check whose process wrote no report as not executed, with its log and signal; a report that exists but cannot be read is not', async () => {
    const killed = await verdictOf({ signal: true });
    expect(killed.notExecuted).toEqual([{ stage: 'journeys', checkId: 'ui-journeys', logPath: join(killed.outDir, 'ui-journeys', 'run.log'), signal: 'SIGKILL' }]);
    const exited = await verdictOf({ exitCode: 3, stderr: 'playwright: command not found' });
    expect(exited.notExecuted).toEqual([{ stage: 'journeys', checkId: 'ui-journeys', logPath: join(exited.outDir, 'ui-journeys', 'run.log'), signal: null }]);
    expect((await verdictOf({ report: 'not json at all' })).notExecuted).toEqual([]);
    expect((await verdictOf({ report: report([ok('x')]) })).notExecuted).toEqual([]);
  });

  it('is ERROR when the report cannot be read, has global errors, was written with snapshots updating, or lists no journeys', async () => {
    expect((await verdictOf({ report: 'not json at all' })).reasons[0]).toMatch(/^the Playwright report could not be parsed: /);
    expect((await verdictOf({ report: '[1]' })).reasons[0]).toBe('the Playwright report could not be parsed: Playwright report is not an object');
    expect((await verdictOf({ report: report([ok('x')], { errors: [{ message: 'webServer failed' }, { message: 'globalSetup failed' }] }) })).reasons[0]).toBe('Playwright reported global errors in ui-journeys: webServer failed; globalSetup failed');
    expect((await verdictOf({ report: report([ok('x')], { config: { updateSnapshots: 'all' } }) })).reasons[0]).toContain('updateSnapshots=all instead of none');
    expect((await verdictOf({ report: report([ok('x')], { config: { updateSnapshots: undefined } }) })).reasons[0]).toContain('updateSnapshots=null');
    expect((await verdictOf({ report: report([]) })).reasons[0]).toBe('check ui-journeys ran no journeys; an empty run is not a pass');
  });

  it('is ERROR when the totals or the exit status disagree with the journeys listed', async () => {
    expect((await verdictOf({ report: report([ok('x')], { stats: { expected: 3, unexpected: 0, flaky: 0, skipped: 0 } }) })).reasons[0]).toContain("totals (3) do not match the 1 journeys it lists");
    expect((await verdictOf({ report: report([ok('x')]), exitCode: 1 })).reasons[0]).toBe('check ui-journeys exited with 1 but its report lists none; the report cannot be trusted');
    expect((await verdictOf({ report: report([failed('x')]), exitCode: 0 })).reasons[0]).toBe('check ui-journeys exited with 0 but its report lists failures; the report cannot be trusted');
    expect((await verdictOf({ report: report([ok('x')]), signal: true })).reasons[0]).toBe('check ui-journeys exited with a signal but its report lists none; the report cannot be trusted');
  });
});

describe('what a run does to the checkout', () => {
  const quiet = () => policy({ ui: (u) => void (u.accessibility.enabled = false) });

  it('is ERROR when the run modified a tracked file, and lists untracked files it left', async () => {
    const c = candidate();
    const { result } = await run(quiet(), c, () => ({ report: report([ok('x')]), files: { [join(repo, 'src/app.js')]: 'tampered\n', [join(repo, 'src/new.js')]: 'new\n', [join(repo, 'src/new2.js')]: 'new\n' } }));
    expect(result.verdict).toBe('ERROR');
    expect(result.reasons).toEqual(['the run modified tracked files, so its evidence no longer describes the candidate: src/app.js']);
    expect(result.unverified.join('\n')).toContain('the run left untracked files in the checkout: src/new.js, src/new2.js');
  });

  it('blocks when the run wrote a baseline itself, and says so', async () => {
    const c = candidate();
    const { result } = await run(quiet(), c, () => ({ report: report([ok('x')]), files: { [join(repo, 'journeys/__screenshots__/new.png')]: 'png' } }));
    expect(result.verdict).toBe('BLOCKED');
    expect(result.reasons).toEqual(expect.arrayContaining(['the run itself wrote baseline files: journeys/__screenshots__/new.png', expect.stringContaining('stored baselines changed in the candidate and need human review')]));
    expect(result.visualBaselineChanges).toEqual(['journeys/__screenshots__/new.png']);
  });

  it('blocks a candidate that changes a stored baseline or an accessibility baseline, unless review is switched off', async () => {
    const c = candidate(() => {
      put(repo, 'journeys/__screenshots__/home.png', 'changed-png');
      put(repo, 'tests/a11y-baseline.json', '{}');
    });
    const { result } = await run(quiet(), c, () => ({ report: report([ok('x')]) }));
    expect(result.verdict).toBe('BLOCKED');
    expect(result.visualBaselineChanges).toEqual(['journeys/__screenshots__/home.png']);
    expect(result.a11yBaselineChanges).toEqual(['tests/a11y-baseline.json']);

    const free = policy({ ui: (u) => { u.accessibility.enabled = false; u.visual.baseline_changes_require_review = false; } });
    const c2 = candidate(() => put(repo, 'journeys/__screenshots__/home.png', 'changed-again'));
    const { result: relaxed } = await run(free, c2, () => ({ report: report([ok('x')]) }));
    expect(relaxed.verdict).toBe('PASS');
    expect(relaxed.visualBaselineChanges).toEqual(['journeys/__screenshots__/home.png']);
  });

  it('notes deleted journey files and edited journeys it executed', async () => {
    const c = candidate(() => {
      sh(repo, 'rm', '-q', 'journeys/a.spec.ts');
      put(repo, 'journeys/b.spec.ts', 'x');
    });
    const { result } = await run(quiet(), c, () => ({ report: report([ok('x')]) }));
    expect(result.unverified).toEqual(expect.arrayContaining(['the candidate deleted journey files, so their coverage is gone: journeys/a.spec.ts']));

    const c2 = candidate(() => put(repo, 'journeys/b.spec.ts', 'edited'));
    const { result: edited } = await run(quiet(), c2, () => ({ report: report([ok('x')], { file: 'journeys/b.spec.ts' }) }));
    expect(edited.unverified.join('\n')).toContain('the candidate changed journey definitions that this run executed (check that no assertion was weakened): journeys/b.spec.ts');
  });
});

describe('coverage and accessibility notes', () => {
  it('names configured viewports and browsers that no journey exercised, and a missing accessibility scan', async () => {
    const p = policy({ ui: (u) => { u.browsers = ['chromium', 'firefox']; u.viewports = [{ width: 1440, height: 900 }, { width: 390, height: 844 }]; } });
    const c = candidate();
    const { result } = await run(p, c, () => ({ report: report([ok('x')]) }));
    expect(result.coverage).toMatchObject({ missingViewports: [{ width: 1440, height: 900 }, { width: 390, height: 844 }], missingBrowsers: ['chromium', 'firefox'] });
    expect(result.unverified).toEqual(
      expect.arrayContaining(['configured viewports never exercised: 1440x900, 390x844', 'configured browsers never exercised: chromium, firefox', 'accessibility is enabled but no journey ran an accessibility scan']),
    );
  });

  it('records advisory accessibility findings as unverified, not as failures', async () => {
    const p = policy({ ui: (u) => void (u.accessibility.fail_on_new_serious_or_critical = false) });
    const c = candidate();
    const scan = { url: 'http://x/', viewport: '1440x900', baselinePath: null, baselineLoaded: false, seriousOrCritical: 1, newViolations: [{ ruleId: 'color-contrast', impact: 'serious', target: '#a', url: 'u', viewport: 'v', help: 'h', fingerprint: 'f' }], baselined: [], advisory: true };
    const body = Buffer.from(JSON.stringify(scan)).toString('base64');
    const { result, fake } = await run(p, c, () => ({ report: report([ok('x', { results: [{ status: 'passed', attachments: [{ name: 'orbit-a11y', contentType: 'application/json', body }] }] })]) }));
    expect(result.verdict).toBe('PASS');
    expect(result.a11yAdvisory).toHaveLength(1);
    expect(result.unverified.join('\n')).toContain('1 new serious or critical accessibility violation(s) were recorded as advisory');
    expect(fake.calls[0]!.argv).not.toContain('--retries=1');
  });
});

describe('starting the application', () => {
  it('is ERROR when it will not start, and passes the port only when the base URL names one', async () => {
    const p = policy({ baseUrl: 'http://localhost', ui: (u) => { u.environment.start_command = ['definitely-not-a-real-binary-acme']; } });
    const c = candidate();
    const { result, fake } = await run(p, c, () => ({ report: report([ok('x')]) }));
    expect(result.verdict).toBe('ERROR');
    expect(result.reasons[0]).toMatch(/^the application did not start: /);
    expect(fake.apps).toEqual([['definitely-not-a-real-binary-acme']]);
    expect(fake.calls).toHaveLength(0);
  });

  it('records that the application never ran, with where its log is, so the controller can tell a crash from the application\'s own error', async () => {
    const p = policy({ ui: (u) => { u.environment.start_command = ['definitely-not-a-real-binary-acme']; } });
    const c = candidate();
    const { result } = await run(p, c, () => ({ report: report([ok('x')]) }));
    expect(result.notExecuted).toEqual([{ stage: 'application', checkId: null, logPath: join(result.outDir, 'app', 'app.log'), signal: null }]);
    expect(JSON.parse(readFileSync(join(result.outDir, 'ui-result.json'), 'utf8')).notExecuted).toEqual(result.notExecuted);
  });

  it('reports a plain failure to start as ERROR, but lets a missing isolation provider or a policy refusal stop the run', async () => {
    const p = policy({ ui: (u) => { u.environment.start_command = ['node', '-e', '']; } });
    const c = candidate();
    const inner = fakePlaywright(() => ({}));
    const throwing: IsolationProvider = { ...inner.provider, wrap: () => { throw new Error('no sandbox'); } };
    await expect(runUiChecks(input(p, c, throwing))).resolves.toMatchObject({ verdict: 'ERROR', reasons: ['the application did not start: no sandbox'] });
    const unavailable: IsolationProvider = { ...inner.provider, wrap: () => { throw new OrbitError('ISOLATION_UNAVAILABLE', 'srt is missing'); } };
    await expect(runUiChecks(input(p, c, unavailable))).rejects.toMatchObject({ code: 'ISOLATION_UNAVAILABLE' });
    const denied: IsolationProvider = { ...inner.provider, wrap: () => { throw new OrbitError('POLICY_DENIED', 'not allowed'); } };
    await expect(runUiChecks(input(p, c, denied))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });

  it('starts the application with the base URL, port and test-data flag in its environment, and stops it afterwards', async () => {
    // A real server on a free port, so readiness is real.
    const { createServer } = await import('node:net');
    const port = await new Promise<number>((resolve) => {
      const s = createServer();
      s.listen(0, '127.0.0.1', () => {
        const a = s.address();
        s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
      });
    });
    const server = `require('http').createServer((req, res) => res.end('ok')).listen(Number(process.env.PORT), '127.0.0.1')`;
    const p = policy({ baseUrl: `http://127.0.0.1:${port}`, ui: (u) => { u.environment.start_command = [process.execPath, '-e', server]; u.accessibility.enabled = false; } });
    const c = candidate();
    const { result, fake } = await run(p, c, () => ({ report: report([ok('x')]) }), { appEnv: { SEED: '1' }, appPollMs: 50 });
    expect(result.verdict).toBe('PASS');
    expect(fake.apps).toHaveLength(1);
    expect(result.unverified.join('\n')).not.toContain('start_command is not set');
  }, 30_000);
});

describe('fallback browser and a11y baselines', () => {
  it('reads the browser version a repository declares for Playwright when a journey did not report one, and none when it does not', async () => {
    put(repo, 'node_modules/playwright-core/package.json', '{"name":"playwright-core","version":"1.63.0"}');
    put(repo, 'node_modules/playwright-core/browsers.json', JSON.stringify({ browsers: [{ name: 'chromium', browserVersion: '153.0.1' }, { name: 'firefox' }] }));
    sh(repo, 'add', '-f', 'node_modules');
    sh(repo, 'commit', '-q', '-m', 'vendored playwright-core');
    baseSha = sh(repo, 'rev-parse', 'HEAD');
    const p = policy({ ui: (u) => void (u.accessibility.enabled = false) });
    const c = candidate();
    const { result } = await run(p, c, () => ({ report: report([ok('x')]) }));
    expect(result.journeys[0]!.browser).toEqual({ name: 'chromium', version: '153.0.1 (declared by playwright-core, not observed)' });
    expect(result.binding.browsers).toEqual([{ name: 'chromium', version: '153.0.1 (declared by playwright-core, not observed)' }]);

    const f = policy({ ui: (u) => { u.accessibility.enabled = false; u.browsers = ['firefox']; } });
    const c2 = candidate(() => put(repo, 'src/app.js', 'export const a = 9;\n'));
    const { result: noVersion } = await run(f, c2, () => ({ report: report([ok('x')]) }));
    expect(noVersion.journeys[0]!.browser).toBeNull();
  });

  it('names an accessibility baseline a scan loaded when the candidate changed it', async () => {
    const p = policy();
    const c = candidate(() => put(repo, 'quality/known-issues.json', '{"changed":true}'));
    const base = join(repo, 'quality', 'known-issues.json');
    const scans = [
      { url: 'u', viewport: 'v', baselinePath: base, baselineLoaded: true, seriousOrCritical: 0, newViolations: [], baselined: [], advisory: false },
      { url: 'u', viewport: 'v', baselinePath: join(root, 'outside.json'), baselineLoaded: true, seriousOrCritical: 0, newViolations: [], baselined: [], advisory: false },
      { url: 'u', viewport: 'v', baselinePath: null, baselineLoaded: false, seriousOrCritical: 0, newViolations: [], baselined: [], advisory: false },
    ];
    const attachments = scans.map((s) => ({ name: 'orbit-a11y', contentType: 'application/json', body: Buffer.from(JSON.stringify(s)).toString('base64') }));
    const { result } = await run(p, c, () => ({ report: report([ok('x', { results: [{ status: 'passed', attachments }] })]) }));
    expect(result.a11yBaselineChanges).toEqual(['quality/known-issues.json']);
    expect(result.verdict).toBe('BLOCKED');
  });
});

// ---------------------------------------------------------------------------
// Pure helpers

describe('helpers', () => {
  it('a11yFailOn names the two settings', () => {
    expect(a11yFailOn({ accessibility: { enabled: true, fail_on_new_serious_or_critical: true } })).toBe('serious,critical');
    expect(a11yFailOn({ accessibility: { enabled: true, fail_on_new_serious_or_critical: false } })).toBe('none');
  });

  it('assertCheckCommandAllowed sees a forbidden token only when it stands alone', () => {
    const base = { id: 'ui', kind: 'playwright', shell: true, command: ['npx playwright test --headless -x'] } as unknown as CheckDefinition;
    expect(() => assertCheckCommandAllowed(base)).not.toThrow();
    expect(() => assertCheckCommandAllowed({ ...base, shell: true, command: [] } as CheckDefinition)).not.toThrow();
  });

  it('changedBetween pairs each status with its path and ignores a trailing separator', async () => {
    const c = candidate(() => {
      put(repo, 'src/app.js', 'changed\n');
      put(repo, 'src/new.js', 'x');
      sh(repo, 'rm', '-q', 'README.md');
    });
    expect(await changedBetween(repo, baseSha, c.commitSha)).toEqual([{ status: 'D', path: 'README.md' }, { status: 'M', path: 'src/app.js' }, { status: 'A', path: 'src/new.js' }]);
  });
});

describe('toEvidenceUi', () => {
  const journey = (status: Parameters<typeof journeyResult>[0] extends infer T ? (T extends { status?: infer S } ? S : never) : never) => journeyResult({ status, id: `j-${status}` });

  it('maps every journey status, and lets a run-level outcome override them', () => {
    const r = runResult({ verdict: 'FAIL', journeys: [journey('PASSED'), journey('FLAKY'), journey('TIMED_OUT'), journey('INTERRUPTED'), journey('FAILED'), journey('SKIPPED')] });
    expect(toEvidenceUi(r).map((e) => e.status)).toEqual(['PASSED', 'PASSED', 'TIMEOUT', 'CANCELLED', 'FAILED', 'FAILED']);
    for (const [verdict, status] of [['TIMEOUT', 'TIMEOUT'], ['CANCELLED', 'CANCELLED'], ['ERROR', 'ERROR']] as const) {
      expect(toEvidenceUi(runResult({ verdict, journeys: [journey('PASSED')] }))[0]!.status).toBe(status);
    }
  });

  it('adds a run-level row when the verdict is not a pass but every journey row is green, carrying the changed baselines', () => {
    const blocked = runResult({ verdict: 'BLOCKED', journeys: [journey('PASSED')], visualBaselineChanges: ['a.png'], a11yBaselineChanges: ['b.json'], checks: [{ checkId: 'ui-journeys' } as never] });
    const rows = toEvidenceUi(blocked);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toEqual({ journey: 'orbit:ui-run', checkId: 'ui-journeys', status: 'FAILED', artifacts: ['a.png', 'b.json'] });
    const noChecks = toEvidenceUi(runResult({ verdict: 'ERROR', journeys: [] }));
    expect(noChecks).toEqual([{ journey: 'orbit:ui-run', status: 'ERROR', artifacts: [] }]);
    expect(toEvidenceUi(runResult({ verdict: 'PASS', journeys: [] }))).toEqual([]);
  });
});

describe('collectAttachments: the cases the main tests leave', () => {
  let out: string;
  let checkout: string;
  let outputDir: string;
  let artifactDir: string;
  beforeEach(() => {
    out = join(root, 'collect');
    checkout = join(out, 'checkout');
    outputDir = join(out, 'test-results');
    artifactDir = join(out, 'artifacts');
    mkdirSync(checkout, { recursive: true });
    mkdirSync(outputDir, { recursive: true });
  });
  const att = (over: Partial<RawAttachment>): RawAttachment => ({ name: 'x', contentType: 'application/octet-stream', path: null, body: null, ...over });
  const collect = (list: RawAttachment[]) => collectAttachments(list, { checkoutDir: checkout, outputDir, artifactDir });

  it('classifies attachments by name and content type', () => {
    const kinds = collect([
      att({ name: 'screenshot', body: Buffer.from('a') }),
      att({ name: 'orbit-failure-screenshot', body: Buffer.from('b') }),
      att({ name: 'trace', body: Buffer.from('c') }),
      att({ name: 'recording', contentType: 'video/webm', body: Buffer.from('d') }),
      att({ name: 'video', body: Buffer.from('e') }),
      att({ name: 'home-expected.png', body: Buffer.from('f') }),
      att({ name: 'home-actual.png', body: Buffer.from('g') }),
      att({ name: 'home-diff.png', body: Buffer.from('h') }),
      att({ name: 'notes', body: Buffer.from('i') }),
    ]).artifacts.map((a) => a.kind);
    expect(kinds).toEqual(['screenshot', 'screenshot', 'trace', 'video', 'video', 'visual-expected', 'visual-actual', 'visual-diff', 'other']);
  });

  it('stores an inline body with an extension from its content type, redacting text and keeping binary as it is', () => {
    const c = collect([
      att({ name: 'log', contentType: 'text/plain; charset=utf-8', body: Buffer.from('token ghp_abcdefghijklmnopqrstuvwxyz0123456789') }),
      att({ name: 'pic', contentType: 'image/png', body: Buffer.from([0x89, 0x50]) }),
      att({ name: 'weird name!', contentType: 'application/x-unknown', body: Buffer.from('z') }),
    ]);
    expect(c.artifacts.map((a) => basename(a.path))).toEqual(['log.txt', 'pic.png', 'weird_name_.bin']);
    expect(readFileSync(c.artifacts[0]!.path, 'utf8')).toContain('[REDACTED');
    expect(readFileSync(c.artifacts[1]!.path)).toEqual(Buffer.from([0x89, 0x50]));
  });

  it('skips an attachment that has neither a path nor a body, a path that is not a file, one outside the allowed places, and one that is too big', () => {
    writeFileSync(join(out, 'outside.txt'), 'secret');
    symlinkSync(join(out, 'outside.txt'), join(outputDir, 'link.txt'));
    mkdirSync(join(outputDir, 'a-directory'));
    writeFileSync(join(outputDir, 'big.bin'), '');
    truncateSync(join(outputDir, 'big.bin'), 51 * 1024 * 1024);
    writeFileSync(join(outputDir, 'fine.txt'), 'fine');
    const c = collect([att({ name: 'empty' }), att({ path: join(outputDir, 'missing.txt') }), att({ path: join(out, 'outside.txt') }), att({ path: join(outputDir, 'link.txt') }), att({ path: join(outputDir, 'a-directory') }), att({ path: join(outputDir, 'big.bin') }), att({ name: 'ok', path: join(outputDir, 'fine.txt') })]);
    expect(c.artifacts.map((a) => a.name)).toEqual(['ok']);
  });

  it('copies a file from the checkout into the artifact directory, and lists a file attached twice once', () => {
    writeFileSync(join(checkout, 'shot.png'), 'png');
    writeFileSync(join(outputDir, 'twice.txt'), 'x');
    const c = collect([att({ name: 'screenshot', path: join(checkout, 'shot.png') }), att({ name: 'trace', path: join(outputDir, 'twice.txt') }), att({ name: 'trace', path: join(outputDir, 'twice.txt') })]);
    expect(c.artifacts).toHaveLength(2);
    expect(c.artifacts[0]!.path).toBe(join(artifactDir, 'screenshot-shot.png'));
    expect(readFileSync(c.artifacts[0]!.path, 'utf8')).toBe('png');
  });

  it('parses diagnostics, accessibility, keyboard and error-context attachments, taking the first of each single-valued kind', () => {
    const json = (v: unknown) => Buffer.from(JSON.stringify(v));
    const c = collect([
      att({ name: 'orbit-diagnostics', contentType: 'application/json', body: json({ browserName: 'chromium', browserVersion: '1', consoleErrors: [{ text: 'e', url: 'u', line: 1 }] }) }),
      att({ name: 'orbit-diagnostics', contentType: 'application/json', body: json({ browserName: 'firefox', browserVersion: '2', pageErrors: [{ name: 'E', message: 'm' }] }) }),
      att({ name: 'orbit-a11y', contentType: 'application/json', body: json({ url: 'u' }) }),
      att({ name: 'orbit-a11y', contentType: 'application/json', body: Buffer.from('not json') }),
      att({ name: 'orbit-keyboard', contentType: 'application/json', body: json({ url: 'u', passed: true }) }),
      att({ name: 'orbit-keyboard', contentType: 'application/json', body: Buffer.from('nope') }),
      att({ name: 'error-context', contentType: 'text/markdown', body: Buffer.from('# Error details\nfirst') }),
      att({ name: 'error-context', contentType: 'text/markdown', body: Buffer.from('# Error details\nsecond') }),
    ]);
    expect(c.browser).toMatchObject({ name: 'chromium' });
    expect(c.diagnostics!.consoleErrors).toHaveLength(1);
    expect(c.a11y).toHaveLength(1);
    expect(c.keyboard).toHaveLength(1);
    expect(c.errorContext).toEqual({ errorDetails: 'first', pageSnapshot: null });
  });
});

// ---------------------------------------------------------------------------
// Browsers under sandbox-runtime on macOS (docs/decisions/0001-runtime-choices.md): the journey check's profile, and
// only it, asks for Chromium's Mach rendezvous rules; a browser that could not start under the sandbox is the
// environment's ERROR, never a journey failure.

const FATAL = '[pid=73671][err] [1005/200336.908127:FATAL:base/apple/mach_port_rendezvous_mac.cc:159] Check failed: kr == KERN_SUCCESS. bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.73671: Permission denied (1100)';
const launchFailed = (title: string, logs: string): PwTest => failed(title, { results: [{ status: 'failed', duration: 10, retry: 0, error: { message: `Error: browserType.launch: Target page, context or browser has been closed\nBrowser logs:\n\n${logs}` } }] });

function srtLikePlaywright(scenario: (c: RunContext) => Scenario, wrapExtra: Partial<WrappedCommand> = { adjustments: ['chromium-mach-rendezvous'], runtimeVersion: '0.0.78', limitations: ['srt limitation', 'chromium limitation'] }, kind: IsolationProvider['kind'] = 'sandbox-runtime') {
  const fake = fakePlaywright(scenario);
  const profiles: { ui: boolean; profile: SandboxProfile }[] = [];
  const provider: IsolationProvider = {
    kind,
    available: fake.provider.available,
    wrap(argv, profile, opts) {
      profiles.push({ ui: opts.env.ORBIT_UI_RUN === '1', profile });
      const w = fake.provider.wrap(argv, profile, opts);
      return opts.env.ORBIT_UI_RUN === '1' ? { ...w, ...wrapExtra } : w;
    },
  };
  return { provider, profiles, fake };
}

describe('browsers under sandbox-runtime', () => {
  const p = (start: string[] | null = null) => policy({ ui: (u) => { u.accessibility.enabled = false; u.environment.start_command = start; } });

  it('asks for the Chromium Mach rules on the journey check\'s profile only, never the application\'s', async () => {
    const { createServer } = await import('node:net');
    const srv = createServer().listen(0, '127.0.0.1');
    await new Promise((r) => srv.once('listening', r));
    const port = (srv.address() as { port: number }).port;
    srv.close();
    const app = ['node', '-e', `require('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1')`];
    const pol = policy({ baseUrl: `http://127.0.0.1:${port}`, ui: (u) => { u.accessibility.enabled = false; u.environment.start_command = app; } });
    const s = srtLikePlaywright(() => ({ report: report([ok('x')]) }));
    const result = await runUiChecks(input(pol, candidate(), s.provider, { appPollMs: 50 }));
    expect(result.verdict, result.reasons.join('; ')).toBe('PASS');
    expect(s.profiles.map((x) => [x.ui, x.profile.chromiumMachRendezvous === true])).toEqual([[false, false], [true, true]]);
  });

  it('records the adjustment, the srt version and its limitation on the check run and in what the evidence report carries', async () => {
    const s = srtLikePlaywright(() => ({ report: report([ok('x')]) }));
    const result = await runUiChecks(input(p(), candidate(), s.provider));
    expect(result.verdict).toBe('PASS');
    expect(result.checks[0]).toMatchObject({ isolation: 'sandbox-runtime', isolationAdjustments: ['chromium-mach-rendezvous'], srtVersion: '0.0.78', isolationLimitations: ['srt limitation', 'chromium limitation'] });
    expect(result.unverified).toContain(`check ui-journeys ran its browser under sandbox-runtime 0.0.78 with the isolation adjustment chromium-mach-rendezvous: ${CHROMIUM_MACH_RENDEZVOUS_LIMITATION}`);
    expect(result.limitations).toContain(CHROMIUM_MACH_RENDEZVOUS_LIMITATION);
    const plain = srtLikePlaywright(() => ({ report: report([ok('x')]) }), {}, 'none');
    const r2 = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 9;\n')), plain.provider));
    expect(r2.checks[0]).toMatchObject({ isolationAdjustments: [], srtVersion: null });
    expect(r2.unverified.filter((u) => /isolation adjustment/.test(u))).toEqual([]);
    expect(r2.limitations).not.toContain(CHROMIUM_MACH_RENDEZVOUS_LIMITATION);
  });

  it('is an environment ERROR, not a failed journey, when Chromium could not register its Mach rendezvous service', async () => {
    const s = srtLikePlaywright(() => ({ report: report([launchFailed('x', FATAL), launchFailed('y', FATAL)]), exitCode: 1, stderr: FATAL }));
    const result = await runUiChecks(input(p(), candidate(), s.provider, { platform: 'darwin' }));
    expect(result.verdict).toBe('ERROR');
    expect(result.journeys).toEqual([]);
    expect(result.reasons).toEqual([expect.stringMatching(/^check ui-journeys: the browser could not start under sandbox-runtime \(Chromium could not register its Mach rendezvous service\): .*bootstrap_check_in org\.chromium/)]);
    expect(result.notExecuted).toEqual([{ stage: 'journeys', checkId: 'ui-journeys', logPath: join(result.outDir, 'ui-journeys', 'run.log'), signal: null, environment: expect.stringMatching(/^Chromium could not register its Mach rendezvous service: .*bootstrap_check_in/) }]);
    expect(toEvidenceUi(result)).toEqual([expect.objectContaining({ status: 'ERROR' })]);
  });

  it('reads the same failure from the report alone, and Chromium\'s own sandbox failing to start inside srt', async () => {
    const fromReport = srtLikePlaywright(() => ({ report: report([launchFailed('x', FATAL)]), exitCode: 1 }));
    expect((await runUiChecks(input(p(), candidate(), fromReport.provider, { platform: 'darwin' }))).notExecuted[0]?.environment).toMatch(/Mach rendezvous/);
    const own = srtLikePlaywright(() => ({ report: report([launchFailed('x', '[pid=53857][err] sandbox initialization failed: Operation not permitted')]), exitCode: 1 }));
    const r = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 5;\n')), own.provider, { platform: 'darwin' }));
    expect(r.verdict).toBe('ERROR');
    expect(r.notExecuted[0]?.environment).toMatch(/^Chromium's own sandbox could not start inside srt \(chromiumSandbox: true\): .*sandbox initialization failed/);
  });

  it('is an environment ERROR when the srt preload recorded its refusal (exit 97), and an ordinary one without that record', async () => {
    const line = 'the profile does not hold (allow process-exec) exactly once, on a line of its own';
    const refused = srtLikePlaywright(() => ({ exitCode: 97, stderr: `orbit srt-chromium-preload: ${line}; refusing to start the sandbox (exit 97)` }), { adjustments: ['chromium-mach-rendezvous'], runtimeVersion: '0.0.78', limitations: [], preloadRefusal: () => line });
    const r = await runUiChecks(input(p(), candidate(), refused.provider, { platform: 'darwin' }));
    expect(r.verdict).toBe('ERROR');
    expect(r.notExecuted[0]?.environment).toBe(`the srt preload refused srt's sandbox command (exit 97): ${line}`);
    const plain = srtLikePlaywright(() => ({ exitCode: 97, stderr: 'something else' }), {}, 'sandbox-runtime');
    const r2 = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 6;\n')), plain.provider, { platform: 'darwin' }));
    expect(r2.verdict).toBe('ERROR');
    expect(r2.notExecuted[0]).not.toHaveProperty('environment');
  });

  it('does not take the repository\'s own exit 97, or a preload line it printed, for a preload refusal', async () => {
    // srt passes the command's exit code through, so a globalSetup that exits 97 looks the same from outside.
    const forged = srtLikePlaywright(() => ({ exitCode: 97, stderr: 'orbit srt-chromium-preload: srt started a second sandbox; refusing to start the sandbox (exit 97)' }), { adjustments: ['chromium-mach-rendezvous'], runtimeVersion: '0.0.78', limitations: [], preloadRefusal: () => null });
    const r = await runUiChecks(input(p(), candidate(), forged.provider, { platform: 'darwin' }));
    expect(r.verdict).toBe('ERROR');
    expect(r.notExecuted).toHaveLength(1);
    expect(r.notExecuted[0]).not.toHaveProperty('environment');
    const bare = srtLikePlaywright(() => ({ exitCode: 97 }));
    const r2 = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 16;\n')), bare.provider, { platform: 'darwin' }));
    expect(r2.notExecuted[0]).not.toHaveProperty('environment');
  });

  it('keeps a journey failure whose message quotes the browser\'s words a failure, and a passing run a pass', async () => {
    const quoted = failed('x', { results: [{ status: 'failed', duration: 10, retry: 0, error: { message: 'Error: expect(locator).toHaveText(expected)\n\nExpected: "ready"\nReceived: "sandbox initialization failed: bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer.1"' } }] });
    const a = srtLikePlaywright(() => ({ report: report([quoted]), exitCode: 1 }));
    const ra = await runUiChecks(input(p(), candidate(), a.provider, { platform: 'darwin' }));
    expect(ra.verdict).toBe('FAIL');
    expect(ra.notExecuted).toEqual([]);
    // Every journey passed: whatever the application or the tests printed, the browser started.
    const printed = srtLikePlaywright(() => ({ report: report([ok('x')]), stdout: `sandbox initialization failed\n${FATAL}`, stderr: 'browserType.launch: sandbox initialization failed' }));
    const rb = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 17;\n')), printed.provider, { platform: 'darwin' }));
    expect(rb.verdict, rb.reasons.join('; ')).toBe('PASS');
    // One journey passed and another hit a launch error: the browser did start for this run.
    const mixed = srtLikePlaywright(() => ({ report: report([ok('x'), launchFailed('y', FATAL)]), exitCode: 1 }));
    const rc = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 18;\n')), mixed.provider, { platform: 'darwin' }));
    expect(rc.verdict).toBe('FAIL');
    expect(rc.notExecuted).toEqual([]);
  });

  it('reads no browser-isolation failure off Linux or another provider, whatever the output says', async () => {
    const own = launchFailed('x', '[pid=53857][err] sandbox initialization failed: Operation not permitted');
    const container = srtLikePlaywright(() => ({ report: report([own]), exitCode: 1, stderr: FATAL }), {}, 'container');
    const r = await runUiChecks(input(p(), candidate(), container.provider, { platform: 'linux' }));
    expect(r.verdict).toBe('FAIL');
    expect(r.notExecuted).toEqual([]);
    const linuxSrt = srtLikePlaywright(() => ({ report: report([launchFailed('x', FATAL)]), exitCode: 1 }), {}, 'sandbox-runtime');
    const r2 = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 19;\n')), linuxSrt.provider, { platform: 'linux' }));
    expect(r2.verdict).toBe('FAIL');
    expect(r2.notExecuted).toEqual([]);
  });

  it('is an environment ERROR when Firefox or WebKit could not start under srt on macOS, and an ordinary failure elsewhere', async () => {
    const firefox = '<launching> /Users/acme/Library/Caches/ms-playwright/firefox-1490/firefox/Nightly.app/Contents/MacOS/firefox -no-remote -headless';
    const mac = srtLikePlaywright(() => ({ report: report([launchFailed('x', firefox)]), exitCode: 1 }));
    const r = await runUiChecks(input(p(), candidate(), mac.provider, { platform: 'darwin' }));
    expect(r.verdict).toBe('ERROR');
    expect(r.notExecuted[0]?.environment).toMatch(/^only Playwright's bundled Chromium is supported under sandbox-runtime on macOS: .*firefox/);
    const linux = srtLikePlaywright(() => ({ report: report([launchFailed('x', firefox)]), exitCode: 1 }));
    const r2 = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 7;\n')), linux.provider, { platform: 'linux' }));
    expect(r2.verdict).toBe('FAIL');
    const unsandboxed = srtLikePlaywright(() => ({ report: report([launchFailed('x', firefox)]), exitCode: 1 }), {}, 'none');
    const r3 = await runUiChecks(input(p(), candidate(() => put(repo, 'src/app.js', 'export const a = 8;\n')), unsandboxed.provider, { platform: 'darwin' }));
    expect(r3.verdict).toBe('FAIL');
  });

  it('keeps an ordinary failing journey a failure', async () => {
    const s = srtLikePlaywright(() => ({ report: report([failed('x')]), exitCode: 1 }));
    const r = await runUiChecks(input(p(), candidate(), s.provider, { platform: 'darwin' }));
    expect(r.verdict).toBe('FAIL');
    expect(r.notExecuted).toEqual([]);
  });
});
