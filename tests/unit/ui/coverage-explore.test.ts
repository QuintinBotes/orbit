import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { defaultConfig, defaultUi } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot, UiConfig } from '../../../src/policy/types.ts';
import { exploreUi, explorationFollowUps, explorerWorkUnit, lintExplorationSpec, renderExplorationReport, type CandidateFinding, type ExplorationResult, type ExploreOptions, type ExplorerRun, type SpecResponse } from '../../../src/ui/explore.ts';

// ---------------------------------------------------------------------------
// The spec linter: what the main tests do not reach

describe('lintExplorationSpec: remaining refusals', () => {
  const BASE = 'http://127.0.0.1:4173';
  const GOOD = "import { expect, test } from '@playwright/test';\ntest('x', async ({ page }) => {\n  await page.goto('/a');\n  await expect(page.locator('#c')).toHaveText('1');\n});\n";

  it('refuses a side-effect import and a module re-exported from elsewhere', () => {
    expect(lintExplorationSpec(`import './setup.ts';\n${GOOD}`, BASE).join(' ')).toContain('"./setup.ts"');
    expect(lintExplorationSpec(`export * from 'left-pad';\n${GOOD}`, BASE).join(' ')).toContain('"left-pad"');
  });

  it('refuses everything when the base URL is not valid, and names a URL it cannot parse', () => {
    const bad = lintExplorationSpec(GOOD.replace("'/a'", "'https://example.com/a'"), 'not a url');
    expect(bad).toContain('the base URL is not valid');
    expect(bad.join(' ')).toContain('"https://example.com"');
    const malformed = lintExplorationSpec(GOOD.replace("'/a'", "'http://[::1/a'"), BASE);
    expect(malformed.join(' ')).toContain('the spec contains a malformed URL "http://[::1/a"');
    expect(lintExplorationSpec(GOOD.replace("'/a'", "'ftp://127.0.0.1:4173/a'"), BASE).join(' ')).toContain('which is not the application under test');
  });

  it('does not count a URL in a comment, and lets an https URL of the same host through only on the same port', () => {
    expect(lintExplorationSpec(`// see http://elsewhere.test/x\n${GOOD}`, BASE)).toEqual([]);
    expect(lintExplorationSpec(GOOD.replace("'/a'", "'https://127.0.0.1:4173/a'"), BASE)).toEqual([]);
  });

  it('asks for a request-based test to open the application too', () => {
    const api = "import { expect, test } from '@playwright/test';\ntest('x', async ({ request }) => { const r = await request.get('/api'); expect(r.status()).toBe(200); });";
    expect(lintExplorationSpec(api, BASE)).toEqual([]);
  });
});

describe('the explorer work unit and report', () => {
  it('defaults the browser and viewports, and appends a harness only when there is one', () => {
    const text = explorerWorkUnit({ baseUrl: 'http://x', viewports: [], browsers: [], goal: 'g' }, { enabled: true, max_minutes: 3, budget_usd: 1 });
    expect(text).toContain('browsers: chromium; viewports: default');
    expect(text).not.toContain('Exploration harness');
    expect(explorerWorkUnit({ baseUrl: 'http://x', viewports: [{ width: 1, height: 2 }], browsers: ['firefox'], goal: 'g' }, { enabled: true, max_minutes: 3, budget_usd: 1 }, '  run the tool  ')).toContain('Exploration harness: run the tool');
  });

  const result = (over: Partial<ExplorationResult>): ExplorationResult => ({ outcome: 'completed', findings: [], reproduced: [], unreproduced: [], observations: [], coverageNotes: null, budgetUsd: 2, maxMinutes: 5, costUsd: null, reasons: [], unverified: [], acceptanceEvidence: false, baseUrl: 'http://x', outDir: '/o', startedAt: 1, endedAt: 2, ...over });

  it('reports cost as not reported, why it stopped, and what was not verified', () => {
    const md = renderExplorationReport(result({ outcome: 'timeout', reasons: ['ran out ``` of time'], unverified: ['no cost'] }));
    expect(md).toContain('- Cost: not reported of USD 2');
    expect(md).toContain('Why exploration stopped early:');
    expect(md).toContain('````text\nran out ``` of time\n````');
    expect(md).toContain('## Not verified\n- no cost');
    expect(renderExplorationReport(result({ costUsd: 0.5 }))).toContain('- Cost: USD 0.5 of USD 2');
  });

  it('follow-ups need a spec and a reproduction command', () => {
    const f = (over: object) => ({ id: 'A', severity: 'low', summary: 's', steps: [], expected: 'e', observed: 'o', proposedTest: 't', status: 'reproduced', reason: 'r', runs: [], spec: null, reproduction: null, artifacts: [], countsAsAcceptanceEvidence: false, ...over }) as never;
    const spec = { path: '/s.spec.ts', sha256: 'h', source: 'src' };
    expect(explorationFollowUps(result({ reproduced: [f({}), f({ spec }), f({ spec, reproduction: 'cmd', id: 'B' })] }))).toEqual([{ id: 'B', severity: 'low', summary: 's', specPath: '/s.spec.ts', specSource: 'src', reproduction: 'cmd' }]);
  });
});

// ---------------------------------------------------------------------------
// Running the explorer against a repository, with Playwright replaced by a script

interface Scenario {
  report?: unknown;
  exitCode?: number;
  sleepMs?: number;
  stdout?: string;
  stderr?: string;
  /** Called while the "run" is being set up, to act in the middle of an attempt. */
  during?: () => void;
}
interface RunContext {
  call: number;
  findingId: string;
  attempt: number;
  specDir: string;
}

const SCRIPT = `
const fs = require('fs'); const path = require('path');
const s = JSON.parse(process.argv[1]);
if (s.report !== undefined) { const f = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE; fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof s.report === 'string' ? s.report : JSON.stringify(s.report)); }
if (s.stdout) console.log(s.stdout);
if (s.stderr) console.error(s.stderr);
const finish = () => process.exit(s.exitCode || 0);
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
      const ctx: RunContext = { call: calls.length + 1, findingId: basename(dirname(output)), attempt: Number(basename(output).replace('run-', '')), specDir: dirname(output) };
      calls.push(ctx);
      const s = scenario(ctx);
      s.during?.();
      return inner.wrap([process.execPath, '-e', SCRIPT, JSON.stringify({ ...s, during: undefined })], profile, opts);
    },
  };
  return { provider, calls, apps };
}

const pwTest = (results: { status: string; error?: Record<string, unknown>; attachments?: unknown[] }[]) => ({ projectName: 'desktop', status: 'unexpected', expectedStatus: 'passed', annotations: [], results });
const pwReport = (tests: unknown[], over: Record<string, unknown> = {}) => ({ config: { version: '1.63.0', updateSnapshots: 'none' }, suites: [{ title: 'x.spec.ts', file: 'x.spec.ts', specs: tests.map((t, i) => ({ title: `t${i}`, file: 'x.spec.ts', line: 1, tests: [t] })) }], errors: [], stats: {}, ...over });
/** A run in which the one test fails inside the spec, with an optional trace and screenshot attached. */
const failing = (specPath: string, message = 'expect(received).toBe(expected)\n\nExpected: "2 reports"\nReceived: "3 reports"', attachments: unknown[] = []) =>
  ({ report: pwReport([pwTest([{ status: 'failed', error: { message, location: { file: specPath, line: 4, column: 1 } }, attachments }])]), exitCode: 1 }) as Scenario;
const passing = (): Scenario => ({ report: pwReport([{ ...pwTest([{ status: 'passed' }]), status: 'expected' }]) });

const GOOD_SPEC = "import { expect, test } from '@playwright/test';\ntest('count', async ({ page }) => {\n  await page.goto('/reports');\n  await expect(page.locator('#count')).toHaveText('2 reports');\n});\n";
const cand = (id: string, over: Partial<CandidateFinding> = {}): CandidateFinding => ({ id, summary: `defect ${id}`, steps: ['open /reports'], expected: '2 reports', observed: '3 reports', severity: 'medium', proposed_test: 'count the reports', ...over });
const explored = (findings: CandidateFinding[]): ExplorerRun => ({ output: { observations: ['saw the list'], candidate_findings: findings, coverage_notes: 'only /reports' }, costUsd: 0.1, status: 'succeeded' });

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();

let root: string;
let repo: string;
let candidate: Candidate;
let snapshot: PolicySnapshot;
let ui: UiConfig;
let n = 0;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orbit-explore-cov-'));
  repo = join(root, 'repo');
  mkdirSync(join(root, 'home'));
  mkdirSync(repo);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n');
  writeFileSync(join(repo, 'README.md'), '# acme\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  const parentSha = sh(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'app.js'), 'export const a = 1;\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'candidate');
  const commitSha = sh(repo, 'rev-parse', 'HEAD');
  candidate = { id: 'cand-1', runId: 'orb-explore', seq: 1, attempt: 1, commitSha, treeHash: sh(repo, 'rev-parse', 'HEAD^{tree}'), parentSha };
  const config = defaultConfig('supervised');
  config.ui = defaultUi();
  config.ui.environment.base_url = 'http://127.0.0.1:3998';
  config.ui.exploration = { enabled: true, max_minutes: 5, budget_usd: 2 };
  ({ snapshot } = snapshotPolicy(config, { runId: 'orb-explore', repoRoot: repo, runDir: join(root, 'home', 'run'), clock: new ManualClock() }));
  ui = snapshot.config.ui!;
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function options(over: Partial<ExploreOptions> & { scenario?: (c: RunContext) => Scenario } = {}): { opts: ExploreOptions; fake: ReturnType<typeof fakePlaywright> } {
  const { scenario, ...rest } = over;
  const fake = fakePlaywright(scenario ?? ((c) => failing(join(c.specDir, `${c.findingId}.spec.ts`))));
  const opts: ExploreOptions = {
    checkoutDir: repo,
    snapshot,
    candidate,
    uiConfig: ui,
    isolation: fake.provider,
    outDir: join(root, 'evidence', `x${++n}`),
    explore: async () => explored([cand('F-1')]),
    authorSpec: async () => ({ source: GOOD_SPEC, costUsd: 0.05 }),
    homeDir: join(root, 'home'),
    ...rest,
  };
  return { opts, fake };
}

describe('exploration set-up', () => {
  it('does nothing when exploration is disabled, naming the setting', async () => {
    const config = { ...ui, exploration: { enabled: false, max_minutes: 5, budget_usd: 2 } };
    const { opts } = options({ uiConfig: config });
    expect(await exploreUi(opts)).toMatchObject({ outcome: 'disabled', reasons: ['ui.exploration.enabled is false'], findings: [], acceptanceEvidence: false });
  });

  it('refuses production accounts, a non-positive time limit and an invalid base URL as configuration errors', async () => {
    const { opts } = options();
    await expect(exploreUi({ ...opts, uiConfig: { ...ui, environment: { ...ui.environment, production_accounts: true as unknown as false } } })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    await expect(exploreUi({ ...opts, exploration: { enabled: true, max_minutes: 0, budget_usd: 1 } })).rejects.toMatchObject({ code: 'CONFIG_INVALID', details: { rule: 'ui.exploration.max_minutes' } });
    await expect(exploreUi({ ...opts, uiConfig: { ...ui, environment: { ...ui.environment, base_url: 'ftp://x' } } })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('is ERROR-free when the application will not start: app_failed, no explorer, and a rethrow for isolation or policy failures', async () => {
    const config = { ...ui, environment: { ...ui.environment, start_command: ['definitely-not-a-real-binary-acme'], base_url: 'http://localhost' } };
    const { opts } = options({ uiConfig: config });
    let asked = false;
    const result = await exploreUi({ ...opts, explore: async () => ((asked = true), explored([])) });
    expect(result.outcome).toBe('app_failed');
    expect(result.reasons[0]).toMatch(/^the application did not start: /);
    expect(asked).toBe(false);

    const inner = options().fake.provider;
    for (const code of ['ISOLATION_UNAVAILABLE', 'POLICY_DENIED'] as const) {
      const provider: IsolationProvider = { ...inner, wrap: () => { throw new OrbitError(code, 'refused'); } };
      await expect(exploreUi({ ...opts, isolation: provider })).rejects.toMatchObject({ code });
    }
    const plain: IsolationProvider = { ...inner, wrap: () => { throw new Error('plain'); } };
    expect((await exploreUi({ ...opts, isolation: plain })).reasons).toEqual(['the application did not start: plain']);
  });

  it('notes that the application was not started by Orbit when there is no start command', async () => {
    const { opts } = options({ scenario: () => passing() });
    const result = await exploreUi(opts);
    expect(result.unverified).toEqual(expect.arrayContaining([expect.stringContaining('start_command is not set')]));
  });
});

describe('the explorer', () => {
  const run = async (explore: ExploreOptions['explore'], over: Partial<ExploreOptions> = {}) => exploreUi(options({ explore, ...over }).opts);

  it('is explorer_failed when the worker throws, ends badly or returns output that does not match the schema', async () => {
    expect(await run(async () => { throw new Error('worker crashed'); })).toMatchObject({ outcome: 'explorer_failed', reasons: ['the explorer worker failed: worker crashed'] });
    expect((await run(async () => { throw 'a string'; })).reasons).toEqual(['the explorer worker failed: a string']);
    expect(await run(async () => ({ output: null, costUsd: null, status: 'failed', error: 'rate limited ghp_abcdefghijklmnopqrstuvwxyz0123456789' }))).toMatchObject({ outcome: 'explorer_failed' });
    expect((await run(async () => ({ output: null, costUsd: null, status: 'failed' }))).reasons).toEqual(['the explorer ended with status failed']);
    const malformed = await run(async () => ({ output: { observations: [] }, costUsd: 0.1, status: 'succeeded' }));
    expect(malformed.outcome).toBe('explorer_failed');
    expect(malformed.findings).toEqual([]);
  });

  it('reports the worker stopping on its own time limit or being cancelled, with its error text', async () => {
    const timeout = await run(async () => ({ output: null, costUsd: 0.2, status: 'timeout', error: 'took too long' }));
    expect(timeout).toMatchObject({ outcome: 'timeout', reasons: ['the explorer timed out: took too long'], costUsd: 0.2 });
    expect((await run(async () => ({ output: null, costUsd: null, status: 'timeout' }))).reasons).toEqual(['the explorer timed out']);
    expect(await run(async () => ({ output: null, costUsd: null, status: 'cancelled' }))).toMatchObject({ outcome: 'cancelled', reasons: ['the explorer was cancelled'] });
  });

  it('gives up on a worker that outlives ui.exploration.max_minutes, and tells it to stop', async () => {
    let aborted = false;
    const result = await run(
      (task) => new Promise<ExplorerRun>(() => task.signal.addEventListener('abort', () => (aborted = true))),
      { exploration: { enabled: true, max_minutes: 0.0002, budget_usd: 1 } },
    );
    expect(result).toMatchObject({ outcome: 'timeout', reasons: ['the explorer did not finish within ui.exploration.max_minutes (0.0002)'] });
    expect(aborted).toBe(true);
  });

  it('is cancelled, and tests nothing, when the caller aborted before it started or while it ran', async () => {
    const ac = new AbortController();
    ac.abort();
    const before = await run(async () => explored([cand('F-1')]), { abortSignal: ac.signal });
    expect(before.outcome).toBe('cancelled');
    expect(before.findings[0]).toMatchObject({ status: 'not_attempted', reason: 'exploration was cancelled before every candidate was tested' });
    expect(before.reasons).toEqual(['exploration was cancelled before every candidate was tested']);

    const during = new AbortController();
    const empty = await run(async () => { during.abort(); return explored([]); }, { abortSignal: during.signal });
    expect(empty).toMatchObject({ outcome: 'cancelled', reasons: ['exploration was cancelled'] });
  });

  it('hands the worker a task with the defaults the policy gives it', async () => {
    let seen: Parameters<ExploreOptions['explore']>[0] | null = null;
    await run(async (task) => ((seen = task), explored([])), { harness: ' use tool ' });
    expect(seen).toMatchObject({ role: 'explorer', baseUrl: 'http://127.0.0.1:3998', browsers: ['chromium'], goal: 'Explore the main user flows of the application for defects a user would notice.', budgetUsd: 2 });
    expect(seen!.workUnit).toContain('Exploration harness: use tool');
  });
});

describe('proving candidates', () => {
  it('reproduces a finding that fails on every run, with the spec, the artifacts of the first failing run and a command that reruns it', async () => {
    const { opts, fake } = options({
      scenario: (c) => failing(join(c.specDir, `${c.findingId}.spec.ts`), undefined, [{ name: 'trace', path: join(c.specDir, `run-${c.attempt}`, 'trace.zip') }, { name: 'screenshot', path: join(c.specDir, 'shot.png') }, { name: 'video' }]),
    });
    const r = await exploreUi(opts);
    expect(fake.calls).toHaveLength(3);
    expect(r.reproduced.map((f) => f.id)).toEqual(['F-1']);
    const f = r.reproduced[0]!;
    expect(f).toMatchObject({ status: 'reproduced', reason: 'the test failed on all 3 runs against the candidate', countsAsAcceptanceEvidence: false });
    expect(f.runs.map((x) => x.status)).toEqual(['failed', 'failed', 'failed']);
    expect(f.runs[0]!.error).toContain('expect(received).toBe(expected)');
    expect(f.artifacts).toEqual([join(f.spec!.path, '..', 'run-1', 'trace.zip'), join(f.spec!.path, '..', 'shot.png')]);
    expect(f.reproduction).toContain('--reporter=list');
    expect(readFileSync(f.spec!.path, 'utf8')).toBe(GOOD_SPEC);
    expect(r.unverified.join('\n')).toContain('a reproduced finding is a failing test on this candidate');
    expect(explorationFollowUps(r)).toHaveLength(1);
    expect(r.costUsd).toBeCloseTo(0.15, 6);
    expect(JSON.parse(readFileSync(join(r.outDir, 'exploration.json'), 'utf8')).outcome).toBe('completed');
  });

  it('classifies findings that pass, fail only sometimes or cannot be tested', async () => {
    const findings = [cand('pass', { severity: 'critical' }), cand('flaky', { severity: 'high' }), cand('nospec'), cand('throws'), cand('refused', { severity: 'low' })];
    const { opts } = options({
      explore: async () => explored(findings),
      authorSpec: async (req) => {
        if (req.finding.id === 'nospec') return null;
        if (req.finding.id === 'throws') throw new Error('model unavailable');
        if (req.finding.id === 'refused') return { source: "import fs from 'node:fs';\ntest('x', async ({ page }) => { await page.goto('/'); expect(1).toBe(2); });", costUsd: null };
        return { source: GOOD_SPEC, costUsd: 0.01 };
      },
      scenario: (c) => (c.findingId === 'pass' ? passing() : c.attempt === 1 ? failing(join(c.specDir, 'flaky.spec.ts')) : passing()),
    });
    const r = await exploreUi(opts);
    const by = Object.fromEntries(r.findings.map((f) => [f.id, f]));
    expect(by.pass).toMatchObject({ status: 'not_reproduced', reason: 'the test passed on the candidate, so the defect did not reproduce' });
    expect(by.flaky).toMatchObject({ status: 'intermittent', reason: expect.stringContaining('failed 1 of 2 run(s) and passed on run 2') });
    expect(by.nospec).toMatchObject({ status: 'no_test', reason: 'no test could be written from this candidate' });
    expect(by.throws).toMatchObject({ status: 'no_test', reason: 'the test could not be written: model unavailable' });
    expect(by.refused).toMatchObject({ status: 'invalid_test', reason: expect.stringContaining('the test was refused') });
    expect(r.reproduced).toEqual([]);
    expect(r.unverified.join('\n')).toContain('the provider reported no cost for 1 call(s)');
    // Most severe first.
    expect(r.findings.map((f) => f.id)).toEqual(['pass', 'flaky', 'nospec', 'throws', 'refused']);
  });

  it('does not test more candidates than maxFindings, and says why', async () => {
    const { opts, fake } = options({ explore: async () => explored([cand('A', { severity: 'low' }), cand('B', { severity: 'critical' }), cand('C', { severity: 'high' })]), maxFindings: 1, scenario: () => passing() });
    const r = await exploreUi(opts);
    expect(r.findings.map((f) => [f.id, f.status])).toEqual([['B', 'not_reproduced'], ['C', 'not_attempted'], ['A', 'not_attempted']]);
    expect(r.findings[1]!.reason).toBe('only the 1 most severe candidates are tested per run');
    // The most severe candidate passed on its first run, so it took one run.
    expect(fake.calls).toHaveLength(1);
  });

  it('cleans candidate ids so they are safe file names and unique', async () => {
    const { opts } = options({ explore: async () => explored([cand('a b/c'), cand('a b/c'), cand('///'), cand('x'.repeat(60))]), scenario: () => passing() });
    const r = await exploreUi(opts);
    expect(r.findings.map((f) => f.id)).toEqual(['a-b-c', 'a-b-c-2', 'F-3', 'x'.repeat(40)]);
    expect(existsSync(join(r.outDir, 'specs', 'a-b-c-2', 'a-b-c-2.spec.ts'))).toBe(true);
  });

  it('stops testing when the budget is spent, and names the reason on what is left', async () => {
    const { opts } = options({ explore: async () => explored([cand('A', { severity: 'high' }), cand('B', { severity: 'low' })]), authorSpec: async () => ({ source: GOOD_SPEC, costUsd: 5 }), exploration: { enabled: true, max_minutes: 5, budget_usd: 1 }, scenario: () => passing() });
    const r = await exploreUi(opts);
    expect(r.outcome).toBe('budget_exhausted');
    expect(r.findings.map((f) => f.status)).toEqual(['not_reproduced', 'not_attempted']);
    expect(r.reasons).toEqual(['ui.exploration.budget_usd was spent before every candidate was tested']);
  });

  it('stops testing when the clock runs out, between candidates and between attempts of one', async () => {
    const clock = new ManualClock();
    const { opts } = options({ clock, explore: async () => explored([cand('A', { severity: 'high' }), cand('B', { severity: 'low' })]), exploration: { enabled: true, max_minutes: 1, budget_usd: 1 }, scenario: (c) => ({ ...passing(), during: () => c.attempt >= 1 && clock.advance(61_000) }) });
    const r = await exploreUi(opts);
    expect(r.outcome).toBe('timeout');
    expect(r.findings.map((f) => f.status)).toEqual(['not_reproduced', 'not_attempted']);
    expect(r.findings[1]!.reason).toBe('ui.exploration.max_minutes ran out before every candidate was tested');

    const clock2 = new ManualClock();
    const mid = options({ clock: clock2, exploration: { enabled: true, max_minutes: 1, budget_usd: 1 }, scenario: (c) => ({ ...failing(join(c.specDir, 'F-1.spec.ts')), during: () => clock2.advance(61_000) }) });
    const r2 = await exploreUi(mid.opts);
    expect(r2.findings[0]).toMatchObject({ status: 'not_attempted', reason: 'ui.exploration.max_minutes ran out while this finding was being reproduced' });
    expect(r2.findings[0]!.runs).toHaveLength(1);
  });

  it('stops reproducing a finding when the run is cancelled while its test was being written', async () => {
    const ac = new AbortController();
    const { opts, fake } = options({ abortSignal: ac.signal, authorSpec: async () => (ac.abort(), { source: GOOD_SPEC, costUsd: 0.01 }) });
    const r = await exploreUi(opts);
    expect(r.findings[0]).toMatchObject({ status: 'not_attempted', reason: 'exploration was cancelled while this finding was being reproduced', runs: [] });
    expect(fake.calls).toHaveLength(0);
  });

  it('links the checkout node_modules for the spec, and keeps an existing link on a second run', async () => {
    mkdirSync(join(repo, 'node_modules', '@playwright', 'test'), { recursive: true });
    const first = options({ scenario: () => passing() });
    const out = first.opts.outDir;
    await exploreUi(first.opts);
    const link = join(out, 'specs', 'F-1', 'node_modules');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    await exploreUi({ ...first.opts });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
  });
});

describe('a run of a spec that cannot be believed', () => {
  const reason = async (scenario: Scenario | ((c: RunContext) => Scenario)) => {
    const { opts } = options({ scenario: typeof scenario === 'function' ? scenario : () => scenario });
    const f = (await exploreUi(opts)).findings[0]!;
    return f;
  };
  const invalid = (text: string | RegExp) => ({ status: 'invalid_test', reason: expect.stringMatching(text) });

  it('is invalid when there is no report, or the report cannot be read, has errors or lists no tests', async () => {
    expect(await reason({ exitCode: 2, stderr: 'playwright: not found' })).toMatchObject(invalid(/no Playwright report \(exit 2\): playwright: not found/));
    expect(await reason({ exitCode: 2 })).toMatchObject(invalid(/no Playwright report \(exit 2\): $/));
    expect(await reason({ report: 'not json' })).toMatchObject(invalid(/the report could not be parsed: /));
    expect(await reason({ report: '"text"' })).toMatchObject(invalid(/the report could not be parsed: Playwright report is not an object/));
    expect(await reason({ report: pwReport([], { errors: [{ message: 'webServer died' }] }) })).toMatchObject(invalid(/Playwright reported errors: webServer died/));
    expect(await reason({ report: pwReport([]) })).toMatchObject(invalid(/the spec ran no tests/));
  });

  it('is invalid when the test was skipped or interrupted, or never reported a result', async () => {
    expect(await reason({ report: pwReport([pwTest([{ status: 'skipped' }])]) })).toMatchObject(invalid(/the test was skipped or interrupted/));
    expect(await reason({ report: pwReport([pwTest([{ status: 'interrupted' }])]) })).toMatchObject(invalid(/the test was skipped or interrupted/));
    expect(await reason({ report: pwReport([pwTest([])]) })).toMatchObject(invalid(/the test was skipped or interrupted/));
  });

  it('is invalid when the failure is about the environment, or did not start in the spec', async () => {
    expect(await reason((c) => failing(join(c.specDir, 'F-1.spec.ts'), 'browserType.launch: Executable doesn\'t exist at /x\nmore'))).toMatchObject(invalid(/the failure is not about the application: browserType\.launch: Executable doesn't exist at \/x$/));
    expect(await reason((c) => failing(join(c.specDir, 'F-1.spec.ts'), 'net::ERR_CONNECTION_REFUSED at http://x'))).toMatchObject(invalid(/not about the application/));
    expect(await reason(failing('/somewhere/else/helper.ts', 'expect(received).toBe(expected)'))).toMatchObject(invalid(/the failure did not originate in the spec/));
  });

  it('accepts a failure whose error has no location, using the first line of its message', async () => {
    const f = await reason({ report: pwReport([pwTest([{ status: 'failed', error: { message: 'plain failure\nsecond line' } }])]), exitCode: 1 });
    expect(f.status).toBe('reproduced');
    expect(f.runs[0]!.error).toBe('plain failure');
    const none = await reason({ report: pwReport([pwTest([{ status: 'timedOut' }])]), exitCode: 1 });
    expect(none.status).toBe('reproduced');
    expect(none.runs[0]!.error).toBe('failed');
  });

  it('counts a spec as passed when any of its tests passed, and as failed only when all of them failed', async () => {
    const mixed = pwReport([pwTest([{ status: 'failed', error: { message: 'x' } }]), { ...pwTest([{ status: 'passed' }]), status: 'expected' }]);
    expect(await reason({ report: mixed })).toMatchObject({ status: 'not_reproduced' });
  });

  it('is invalid when the run was cancelled, and when it outlived its time limit', async () => {
    const ac = new AbortController();
    const cancelled = options({ abortSignal: ac.signal, scenario: () => ({ sleepMs: 5_000, during: () => ac.abort() }) });
    expect((await exploreUi(cancelled.opts)).findings[0]).toMatchObject({ status: 'invalid_test', reason: expect.stringContaining('the run was cancelled') });

    const slow = options({ exploration: { enabled: true, max_minutes: 0.01, budget_usd: 1 }, scenario: () => ({ sleepMs: 5_000 }) });
    expect((await exploreUi(slow.opts)).findings[0]).toMatchObject({ status: 'invalid_test', reason: expect.stringContaining('the run exceeded its time limit') });
  }, 30_000);
});
