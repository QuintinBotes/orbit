// The fail-before ui probe through collectFailBefore (ADR 0016, item 4), driven by a scripted ui runner: no browser
// starts. A criterion resting on a new journey under a browser check is probed on the base revision with the
// candidate's test-owned changes, after a control run of the base revision alone, once per run, shows the journeys
// pass there. The scripted runner tells the control from the probe by the checkout it is given.
import { writeFileSync } from 'node:fs';
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

function journey(status: UiJourneyStatus): UiJourneyResult {
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
    error: null,
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
    journeys: [journey(status)],
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

async function browserLab(): Promise<BrowserLab> {
  const lab = makeUnitLab({
    tweak: (c) => {
      c.checks.journeys = { ...defaultCheck('journeys'), kind: 'playwright', category: 'ui', command: ['npx', 'playwright', 'test'] };
      c.ui = { ...defaultUi(), journey_check_ids: ['journeys'] };
      c.verification.fail_before = 'required';
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
