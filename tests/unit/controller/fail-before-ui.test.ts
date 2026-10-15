// The fail-before ui probe through collectFailBefore (ADR 0016, item 4), driven by a scripted ui runner: no browser
// starts. A criterion resting on a new journey under a browser check is probed on the base revision with the
// candidate's test-owned changes, after a control run of the base revision alone, once per run, shows the journeys
// pass there. The scripted runner tells the control from the probe by the checkout it is given.
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkRunnerFor } from '../../../src/controller/context.ts';
import { collectFailBefore } from '../../../src/controller/fail-before.ts';
import type { UiRunner } from '../../../src/controller/fail-before-ui.ts';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { criterionFailBefore, newTestSupport, type CheckProbe } from '../../../src/evidence/fail-before.ts';
import type { BaseComparison } from '../../../src/evidence/report.ts';
import type { CandidateRecord } from '../../../src/evidence/store.ts';
import { defaultCheck, defaultUi } from '../../../src/policy/config.ts';
import type { UiRunInput } from '../../../src/ui/runner.ts';
import type { UiJourneyResult, UiJourneyStatus, UiNotExecuted, UiRunResult, UiRunVerdict } from '../../../src/ui/types.ts';
import { result } from '../evidence/report-fixtures.ts';
import { giveRepository, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';

const labs: UnitLab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.cleanup();
});

function journey(status: UiJourneyStatus, error: string | null = null): UiJourneyResult {
  return {
    id: 'chromium/e2e/login.spec.ts#login signs in',
    title: 'login signs in',
    titlePath: ['login signs in'],
    file: 'e2e/login.spec.ts',
    line: 3,
    project: 'chromium',
    checkId: 'journeys',
    status,
    attempts: 1,
    durationMs: 5,
    browser: null,
    viewport: null,
    steps: [],
    failedStep: null,
    error: error === null ? null : { message: error, location: null, snippet: null, expected: null, observed: null, diff: null },
    artifacts: [],
    diagnostics: null,
    a11y: [],
    keyboard: [],
    errorContext: null,
    reproduction: { cwd: '.', argv: [], env: {}, command: '' },
    annotations: [],
  };
}

interface Script {
  verdict?: UiRunVerdict;
  journeyStatus?: UiJourneyStatus;
  error?: string;
  notExecuted?: UiNotExecuted[];
  reasons?: string[];
}

function uiRun(input: UiRunInput, s: Script): UiRunResult {
  const status = s.journeyStatus ?? 'PASSED';
  const verdict = s.verdict ?? (status === 'PASSED' ? 'PASS' : 'FAIL');
  return {
    verdict,
    passed: verdict === 'PASS',
    reasons: s.reasons ?? (verdict === 'PASS' ? [] : ['journey login signs in failed']),
    binding: { candidateId: input.candidate.id, treeHash: input.candidate.treeHash, checkConfigHash: 'h', policyHash: 'p', commitSha: input.candidate.commitSha, playwrightVersion: null, browsers: [], viewports: [], baseUrl: 'http://127.0.0.1:9', keyboard: { scans: 0, failed: 0 }, accessibilityFailOn: 'none' },
    journeys: [journey(status, s.error ?? null)],
    checks: [{ checkId: 'journeys', argv: [], exitCode: status === 'PASSED' ? 0 : 1, timedOut: false, cancelled: false, durationMs: 5, logPath: join(input.outDir, 'journeys', 'run.log'), reportPath: join(input.outDir, 'journeys', 'report.json'), reportFound: true, isolation: 'none', isolationLimitations: [], playwrightVersion: null }],
    stats: { passed: status === 'PASSED' ? 1 : 0, failed: status === 'PASSED' ? 0 : 1, flaky: 0, skipped: 0, other: 0 },
    flaky: false,
    visualBaselineChanges: [],
    a11yBaselineChanges: [],
    a11yAdvisory: [],
    consoleErrorCount: 0,
    coverage: { configuredViewports: [], observedViewports: [], missingViewports: [], configuredBrowsers: [], observedBrowsers: [], missingBrowsers: [] },
    unverified: [],
    notExecuted: s.notExecuted ?? [],
    limitations: [],
    outDir: input.outDir,
    startedAt: 0,
    endedAt: 1,
  };
}

interface ScriptedRunner {
  runner: UiRunner;
  controls: UiRunInput[];
  probes: UiRunInput[];
}

/** A ui runner answering `control` on the base revision alone and `probe` on the probe tree, recording each call. */
function scripted(control: Script, probe: Script): ScriptedRunner {
  const out: ScriptedRunner = {
    controls: [],
    probes: [],
    runner: async (input) => {
      const isControl = input.checkoutDir.endsWith('fail-before-ui-control');
      (isControl ? out.controls : out.probes).push(input);
      return uiRun(input, isControl ? control : probe);
    },
  };
  return out;
}

interface BrowserLab {
  lab: UnitLab;
  base: string;
  worktree: string;
  cand: CandidateRecord;
  comparison: BaseComparison;
}

async function browserLab(opts: { startCommand?: string[] | null; timeoutSeconds?: number; installCommand?: string[] } = {}): Promise<BrowserLab> {
  const lab = makeUnitLab({
    tweak: (c) => {
      c.checks.journeys = { ...defaultCheck('journeys'), kind: 'playwright', category: 'ui', command: ['npx', 'playwright', 'test'] };
      const ui = defaultUi();
      c.ui = { ...ui, journey_check_ids: ['journeys'], environment: { ...ui.environment, start_command: opts.startCommand === undefined ? ['node', 'server.mjs'] : opts.startCommand } };
      c.verification.fail_before = 'required';
      if (opts.timeoutSeconds !== undefined) c.verification.fail_before_timeout_seconds = opts.timeoutSeconds;
      // The locked install the probe runs in each checkout, scripted as the command probe's tests script it:
      // a real dependencies.install_command the runner executes (a marker it leaves, or a failure it exits with).
      if (opts.installCommand !== undefined) c.dependencies.install_command = opts.installCommand;
    },
  });
  labs.push(lab);
  const { base, tree, worktree } = await giveRepository(lab, { 'apps/calc.mjs': 'export const add = (a, b) => a + b;\n', 'e2e/add.spec.ts': 'test("add", () => {});\n' });
  setContract(lab, {
    acceptance_criteria: [{ id: 'AC-1', statement: 'the login journey signs in', proof: ['e2e/login.spec.ts'], mandatory: true, ui: true, check_ids: ['journeys'] }],
    required_check_ids: ['unit', 'journeys'],
    baseline_revision: base,
  });
  writeFileSync(join(worktree, 'apps/calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  writeFileSync(join(worktree, 'e2e/login.spec.ts'), 'test("login signs in", () => {});\n');
  const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree, runId: lab.runId, baseRev: base, attempt: 1, workerId: null });
  const comparison: BaseComparison = { treeHash: tree, checks: [{ checkId: 'unit', status: 'PASSED' }], changedPaths: ['apps/calc.mjs', 'e2e/login.spec.ts'] };
  return { lab, base, worktree, cand, comparison };
}

async function collect(b: BrowserLab, uiRunner: UiRunner, cand: CandidateRecord = b.cand) {
  const ctx = b.lab.ctx();
  return collectFailBefore(ctx, cand, {
    contract: ctx.contract!,
    base: b.comparison,
    results: [result(ctx.snapshot, 'unit')],
    installOk: true,
    runner: { ...checkRunnerFor(ctx), checkoutDir: b.worktree },
    uiRunner,
  });
}

const probed = (evidence: Awaited<ReturnType<typeof collect>>): CheckProbe => evidence.probe!.checks.find((c) => c.checkId === 'journeys')!;

describe('the fail-before ui probe', () => {
  it('a new journey failing twice on the probe tree, with a passing control, is failed-before', async () => {
    const b = await browserLab();
    const s = scripted({}, { journeyStatus: 'FAILED' });
    const evidence = await collect(b, s.runner);
    expect(s.controls).toHaveLength(1);
    expect(s.probes).toHaveLength(2);
    expect(s.probes[0]!.candidate.treeHash).toBe(evidence.probe!.probeTree);
    expect(s.probes[0]!.candidate.treeHash).not.toBe(b.cand.treeHash);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'failed-before' });
    expect(check.attempts.map((a) => a.status)).toEqual(['FAILED', 'FAILED']);
    expect(check.attempts[0]!.log).toContain('evidence/1/fail-before/ui/probe-1/');
    const ctx = b.lab.ctx();
    const support = newTestSupport(ctx.contract!, ctx.snapshot, b.comparison)[0]!;
    expect(criterionFailBefore(support, evidence)).toMatchObject({ outcome: 'failed-before', checks: [{ id: 'journeys', outcome: 'failed-before' }] });
  }, 60_000);

  it('a journey passing on the probe tree is passed-before, and runs once', async () => {
    const b = await browserLab();
    const s = scripted({}, {});
    const evidence = await collect(b, s.runner);
    expect(s.controls).toHaveLength(1);
    expect(s.probes).toHaveLength(1);
    expect(probed(evidence)).toMatchObject({ outcome: 'passed-before' });
  }, 60_000);

  // A skipped journey failed nothing: verification counts it against a candidate, but on the probe tree a failure is the
  // evidence, so counting a skip as one would credit a journey that never ran (the hole ADR 0015 closed for test checks).
  it('a journey skipped on the probe tree is not a failure: passed-before, never failed-before', async () => {
    const b = await browserLab();
    const s = scripted({}, { journeyStatus: 'SKIPPED', verdict: 'FAIL' });
    const evidence = await collect(b, s.runner);
    expect(probed(evidence)).toMatchObject({ outcome: 'passed-before' });
  }, 60_000);

  it('a failing control establishes nothing: the journeys do not pass on the base revision', async () => {
    const b = await browserLab();
    const s = scripted({ journeyStatus: 'FAILED' }, { journeyStatus: 'FAILED' });
    const evidence = await collect(b, s.runner);
    expect(s.controls).toHaveLength(1);
    expect(s.probes).toHaveLength(0);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'base-failed' });
    expect(check.reason).toMatch(/the journeys do not pass on the base revision/);
  }, 60_000);

  it('a process that never reached the repository code on the probe tree is an environment cause', async () => {
    const b = await browserLab();
    const s = scripted({}, { verdict: 'ERROR', journeyStatus: 'FAILED', notExecuted: [{ stage: 'application', checkId: null, logPath: 'app.log', signal: null }], reasons: ['the application did not start'] });
    const evidence = await collect(b, s.runner);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(check.reason).toMatch(/never ran the repository's code/);
  }, 60_000);

  // A missing browser executable fails the journeys with no notExecuted entry: its launch error belongs to the
  // environment, so repeated such runs on the probe tree must not become failed-before.
  it('journeys failing because the browser never launched are an environment cause, not failed-before', async () => {
    const b = await browserLab();
    const s = scripted({}, { journeyStatus: 'FAILED', error: "browserType.launch: Executable doesn't exist at /cache/chromium/chrome" });
    const evidence = await collect(b, s.runner);
    expect(s.controls).toHaveLength(1);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(check.reason).toMatch(/the browser did not start/);
  }, 60_000);

  it('with no start command the ui probe establishes nothing and runs no journeys', async () => {
    const b = await browserLab({ startCommand: null });
    const s = scripted({}, { journeyStatus: 'FAILED' });
    const evidence = await collect(b, s.runner);
    expect(s.controls).toHaveLength(0);
    expect(s.probes).toHaveLength(0);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'not-probed' });
    expect(check.reason).toMatch(/ui\.environment\.start_command is not set/);
    expect(check.reason).toMatch(/not started from the probe's checkout/);
  }, 60_000);

  // The wait is capped, so a runner that is never aborted still returns (its failed journeys then speak for
  // themselves); with the bound enforced the abort comes first and its failures establish nothing.
  it('a run the probe bound cuts short is the budget, even when it reports failed journeys', async () => {
    // The bound is real time (an abort is observed, not a clock value): 8 s leaves the control and the checkout setup
    // room on a slow runner, and the scripted run waits far longer, so only the abort ends it.
    const b = await browserLab({ timeoutSeconds: 8 });
    let sawAbort = false;
    let probes = 0;
    const runner: UiRunner = async (input) => {
      if (input.checkoutDir.endsWith('fail-before-ui-control')) return uiRun(input, {});
      probes++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 20_000);
        if (input.abortSignal?.aborted) {
          sawAbort = true;
          clearTimeout(timer);
          resolve();
          return;
        }
        input.abortSignal?.addEventListener(
          'abort',
          () => {
            sawAbort = true;
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      return uiRun(input, { journeyStatus: 'FAILED' });
    };
    const evidence = await collect(b, runner);
    expect(sawAbort).toBe(true);
    expect(probes).toBe(1);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'budget' });
    expect(check.reason).toMatch(/the probe's bound of 8 s \(verification\.fail_before_timeout_seconds\) ran out/);
  }, 60_000);

  it('the control runs once per run: a second candidate reuses it by the base tree', async () => {
    const b = await browserLab();
    const s = scripted({}, { journeyStatus: 'FAILED' });
    await collect(b, s.runner);
    writeFileSync(join(b.worktree, 'apps/calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => b * a;\n');
    const cand2 = await snapshotCandidate({ db: b.lab.db, clock: b.lab.clock, repoRoot: b.lab.repo, worktree: b.worktree, runId: b.lab.runId, baseRev: b.base, attempt: 2, workerId: null });
    expect(cand2.seq).not.toBe(b.cand.seq);
    const evidence = await collect(b, s.runner, cand2);
    expect(s.controls).toHaveLength(1);
    expect(probed(evidence)).toMatchObject({ outcome: 'failed-before' });
  }, 60_000);

  // The install the command probe gives its probe tree: each ui checkout gets it before its journeys, so a journey
  // process never fetches its own tooling from a registry the sandbox refuses.
  it('the control and the probe checkouts are installed before the journeys run', async () => {
    const install = [process.execPath, '-e', "require('node:fs').writeFileSync('installed.marker', 'installed\\n')"];
    const b = await browserLab({ installCommand: install });
    const installed: boolean[] = [];
    const runner: UiRunner = async (input) => {
      installed.push(existsSync(join(input.checkoutDir, 'installed.marker')));
      return uiRun(input, input.checkoutDir.endsWith('fail-before-ui-control') ? {} : { journeyStatus: 'FAILED' });
    };
    const evidence = await collect(b, runner);
    // The control, then the failing probe run and its repeat: every checkout the runner saw was installed first.
    expect(installed).toEqual([true, true, true]);
    expect(probed(evidence)).toMatchObject({ outcome: 'failed-before' });
  }, 60_000);

  it('a failing install stops the ui probe as an install cause, and the journeys never run', async () => {
    const install = [process.execPath, '-e', "console.error('registry unreachable'); process.exit(3)"];
    const b = await browserLab({ installCommand: install });
    const s = scripted({}, { journeyStatus: 'FAILED' });
    const evidence = await collect(b, s.runner);
    expect(s.controls).toHaveLength(0);
    expect(s.probes).toHaveLength(0);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'install' });
    expect(check.reason).toMatch(/the locked install \(orbit-install\) ended FAILED for the ui control on the base revision/);
  }, 60_000);

  it('a control whose output shows a registry refusal is an environment cause, not the journeys failing on the base revision, and is not reused', async () => {
    const refused = 'npm error code E403\nnpm error 403 Forbidden - GET https://registry.npmjs.org/playwright';
    const b = await browserLab();
    const s = scripted({ journeyStatus: 'FAILED', error: refused }, { journeyStatus: 'FAILED' });
    const evidence = await collect(b, s.runner);
    expect(s.controls).toHaveLength(1);
    expect(s.probes).toHaveLength(0);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(check.reason).toMatch(/a dependency could not be fetched or installed/);
    expect(check.reason).not.toMatch(/the journeys do not pass on the base revision/);
    // Not cached for a later candidate: its probe runs the control again.
    writeFileSync(join(b.worktree, 'apps/calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => b * a;\n');
    const cand2 = await snapshotCandidate({ db: b.lab.db, clock: b.lab.clock, repoRoot: b.lab.repo, worktree: b.worktree, runId: b.lab.runId, baseRev: b.base, attempt: 2, workerId: null });
    await collect(b, s.runner, cand2);
    expect(s.controls).toHaveLength(2);
  }, 60_000);

  it('a probe attempt whose output shows a registry refusal is an environment cause, not a journey failure', async () => {
    const refused = 'npm error code E403\nnpm error 403 Forbidden - GET https://registry.npmjs.org/playwright';
    const b = await browserLab();
    const s = scripted({}, { journeyStatus: 'FAILED', error: refused });
    const evidence = await collect(b, s.runner);
    const check = probed(evidence);
    expect(check).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(check.outcome).not.toBe('failed-before');
    expect(check.reason).toMatch(/a dependency could not be fetched or installed/);
  }, 60_000);

  it('a command check criterion is probed as before, and the ui runner is never called', async () => {
    const lab = makeUnitLab({ tweak: (c) => void (c.verification.fail_before = 'advisory') });
    labs.push(lab);
    const { base, tree, worktree } = await giveRepository(lab);
    setContract(lab, { baseline_revision: base });
    writeFileSync(join(worktree, 'apps/calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
    writeFileSync(join(worktree, 'tests/mul.test.mjs'), 'export {};\n');
    const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree, runId: lab.runId, baseRev: base, attempt: 1, workerId: null });
    const s = scripted({}, {});
    const ctx = lab.ctx();
    const evidence = await collectFailBefore(ctx, cand, {
      contract: ctx.contract!,
      base: { treeHash: tree, checks: [{ checkId: 'unit', status: 'PASSED' }], changedPaths: ['apps/calc.mjs', 'tests/mul.test.mjs'] },
      results: [result(ctx.snapshot, 'unit')],
      installOk: true,
      runner: { ...checkRunnerFor(ctx), checkoutDir: worktree },
      uiRunner: s.runner,
    });
    expect(s.controls).toHaveLength(0);
    expect(s.probes).toHaveLength(0);
    expect(evidence.probe!.checks).toEqual([{ checkId: 'unit', outcome: 'passed-before', reason: 'unit passed on the base revision with the new tests', attempts: [expect.objectContaining({ status: 'PASSED', exitCode: 0 })] }]);
  }, 120_000);
});
