// An environment failure is not repaired. The first live run (demo app) failed its `unit` check on the base revision and on
// every candidate with `listen EPERM: operation not permitted 127.0.0.1` (the trusted checks ran with loopback binding
// denied), and Orbit spent every implementation attempt on a failure the code could not cause. A mandatory check that fails
// on the candidate as it failed on the base revision, with a sandbox or environment denial in its output, now ends the run
// BLOCKED before the repair loop, naming the check, the cause and the two ways forward. A plain pre-existing code failure
// keeps the repair loop.
import { afterEach, describe, expect, it } from 'vitest';
import { defaultCheck, defaultUi } from '../../../src/policy/config.ts';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { acquireLease, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { baseScenario, DIAGNOSIS, implementMul, PLANNER_OUTPUT, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

const attemptsUsed = (l: Lab, runId: string): number => l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", runId)!.used;
const runDirOf = (l: Lab, runId: string): string => join(l.repo, '.orbit', 'runs', runId);

// What the demo app's suite printed when its server could not listen under the sandbox. The same on every revision.
const DENIED = "console.error('Error: listen EPERM: operation not permitted 127.0.0.1');\nprocess.exit(1);\n";
// A pre-existing bug: the same failure on every revision, with no word about the sandbox.
const BROKEN = 'console.error("legacy report exporter is broken");\nprocess.exit(1);\n';

describe.skipIf(!canStripTypes)('controller: environment failures are not repaired', () => {
  it('the live sequence: `unit` fails on the base revision and on the candidate with an EPERM denial, and the run ends BLOCKED after zero repair attempts', async () => {
    const l = lab({
      files: { 'tools/unit-denied.mjs': DENIED },
      tweak: (c) => {
        c.checks.unit = { ...c.checks.unit!, command: [process.execPath, 'tools/unit-denied.mjs'] };
      },
    });
    // Repairs would produce the identical tree again, as they did live; a diagnosis is on hand for the code path that must not run.
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/Check unit fails on candidate 1 exactly as on the base revision/);
    expect(reason).toMatch(/environment cause/);
    expect(reason).toContain('listen EPERM: operation not permitted 127.0.0.1');
    expect(reason).toMatch(/sandbox/);
    expect(reason).toMatch(/fix the environment or the check definition/);
    expect(reason).toMatch(/approve a baseline exception/);

    // Zero repair attempts: one implementation attempt, no diagnosis, no repair brief, no repair worker.
    const path = transitions(l, run.id);
    expect(path).not.toContain('DIAGNOSING');
    expect(path).not.toContain('REPAIRING');
    expect(path.at(-1)).toBe('BLOCKED');
    expect(attemptsUsed(l, run.id)).toBe(1);
    expect(existsSync(join(runDirOf(l, run.id), 'briefs'))).toBe(false);

    // The way forward through the existing G27 question is real: PREFLIGHT raised it and the reason names its answer command.
    const [question] = listQuestions(l.db(), run.id, { status: 'open' });
    expect(question?.id).toMatch(/^q-baseline-/);
    expect(reason).toContain(`orbit decide ${run.id} ${question!.id} Approve`);

    // The decision record and the final report say so too.
    const [decision] = listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' });
    expect(decision?.data).toMatchObject({ checks: [expect.objectContaining({ check_id: 'unit', question_id: question!.id })] });
    const final = readFileSync(join(runDirOf(l, run.id), 'final.md'), 'utf8');
    expect(final).toMatch(/^# Orbit run \S+: BLOCKED/);
    expect(final).toMatch(/Check unit fails on candidate 1 exactly as on the base revision/);
    expect(final).toMatch(/environment cause/);
    expect(final).toMatch(/approve a baseline exception/);
    expect(final).not.toMatch(/[\u2013\u2014]/);
    const [ev] = listEvidenceReports(l.db(), run.id);
    expect(ev?.verdict).toBe('FAIL');
  }, 180_000);

  it('a plain pre-existing code failure, with no environment signal, still enters the repair loop', async () => {
    const l = lab({
      files: { 'tools/unit-broken.mjs': BROKEN },
      tweak: (c) => {
        c.checks.unit = { ...c.checks.unit!, command: [process.execPath, 'tools/unit-broken.mjs'] };
      },
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const path = transitions(l, run.id);
    expect(path).toContain('DIAGNOSING');
    expect(listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' })).toEqual([]);
    expect(runState(l, run.id).outcomeReason ?? '').not.toMatch(/environment cause/);
  }, 240_000);

  it('approving the baseline exception named in the reason lets the resumed run carry on: the excepted check is accepted, nothing is repaired', async () => {
    // `legacy` is a second mandatory check, denied by the sandbox on every revision; `unit` really passes and proves the criterion.
    const l = lab({
      files: { 'tools/legacy-denied.mjs': DENIED },
      tweak: (c) => {
        c.checks.legacy = { ...c.checks.unit!, id: 'legacy', command: [process.execPath, 'tools/legacy-denied.mjs'], mandatory: true };
      },
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/Check legacy fails on candidate 1/);
    expect(blocked.outcomeReason).not.toMatch(/[Cc]heck unit/);
    expect(attemptsUsed(l, run.id)).toBe(1);

    // What `orbit decide` and `orbit resume` do.
    const [question] = listQuestions(l.db(), run.id, { status: 'open' });
    const answer = answerQuestion(l.db(), runDirOf(l, run.id), question!.id, 'Approve', 'alice', systemClock);
    expect(answer.baselineException?.status).toBe('applied');
    expect(acquireLease(l.db(), run.id, 'resumer', 60_000, systemClock)).not.toBeNull();
    transition(l.db(), { runId: run.id, to: 'VERIFYING', ownerId: 'resumer', reason: 'resumed after a decision', actor: 'alice', expectedFrom: 'BLOCKED' }, systemClock);
    releaseLease(l.db(), run.id, 'resumer');
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const path = transitions(l, run.id);
    expect(path.slice(path.lastIndexOf('BLOCKED'))).not.toContain('DIAGNOSING');
    expect(path).not.toContain('REPAIRING');
    expect(attemptsUsed(l, run.id)).toBe(1);
    const reports = listEvidenceReports(l.db(), run.id);
    expect(reports.at(-1)?.verdict).toBe('PASS');
    expect(reports.at(-1)?.report.unverified.join('\n')).toMatch(/baseline exception; accepted/);
  }, 240_000);
});

// The first live run on the demo app, second finding: the UI app fixture crashed at start (the app aborted under the
// sandbox), so the mandatory UI check could not execute at all. The unit check passed and the evidence was INCOMPLETE.
// The implementer had claimed the journeys passed, which the controller had no result for, so the run went to the
// Inquisition and the repair loop and repeated the identical tree before it blocked. A mandatory check that could not
// execute because of the environment now ends the run BLOCKED at once, through the same path as the failures above.
const NATIVE_ABORT = 'process.abort();\n';
const THROWING_APP = "throw new SyntaxError('Unexpected token } in tools/app-throws.mjs');\n";

/** The planner also commits to a mandatory UI criterion proven by the `ui` journey check, which the contract's required checks do not list. */
function withUiCriterion(scenario: object): object {
  const s = scenario as { roles: { planner: { structured: typeof PLANNER_OUTPUT }[] } };
  const plan = s.roles.planner[0]!.structured;
  const criterion = { key: 'ui', statement: 'The calculator page shows the product of 2 and 3 as 6.', mandatory: true, ui: true, proof: ['journeys/mul.spec.ts asserts the page shows 6'], check_ids: ['ui'], changes: [{ path: 'apps/calc.mjs', summary: 'add mul' }] };
  return { ...s, roles: { ...s.roles, planner: [{ structured: { ...plan, criteria: [...plan.criteria, criterion] } }] } };
}

/** The implementer says it ran the journeys and they pass, which the controller has no result for: an unsupported claim that opens an inquiry. */
function implementClaimingUi(): object {
  const claim = {
    checks_run: [{ check_id: 'ui', command: 'npx --no-install playwright test', claimed_result: 'passed', note: 'ran the journeys in my own session' }],
    evidence_refs: [{ criterion_id: 'AC-2', ref: 'journeys/mul.spec.ts', note: 'the journey passes in my session' }],
  };
  const mul = implementMul('*') as { edits: object[]; structured: object };
  return { ...mul, structured: { ...mul.structured, ...claim } };
}

function uiLab(appFile: string, appSource: string): Lab {
  return lab({
    files: { [appFile]: appSource },
    tweak: (c) => {
      c.checks.ui = { ...defaultCheck('ui'), command: ['npx', '--no-install', 'playwright', 'test'], kind: 'playwright', mandatory: true, timeout_seconds: 120 };
      c.ui = {
        ...defaultUi(),
        ui_paths: ['apps/**'],
        required_when_ui_changes: true,
        environment: { base_url: 'http://127.0.0.1:4399', start_command: [process.execPath, appFile], ready_timeout_seconds: 20, isolated_test_data: true, production_accounts: false },
        journey_check_ids: ['ui'],
      };
    },
  });
}

describe.skipIf(!canStripTypes)('controller: a check that could not execute is an environment failure', () => {
  it('the live sequence: the UI app aborts at start, the mandatory UI check never runs, and the run ends BLOCKED after zero repair attempts', async () => {
    const l = uiLab('tools/app-abort.mjs', NATIVE_ABORT);
    writeScenario(l, withUiCriterion(baseScenario({ implementer: [implementClaimingUi(), implementClaimingUi(), implementClaimingUi()], verifier: [DIAGNOSIS] })));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/^Check ui could not execute on candidate 1, and the output shows an environment cause, not a defect in the change/);
    expect(reason).toMatch(/killed by a fatal signal before it printed anything of its own/);
    expect(reason).toContain('app.log');
    expect(reason).toMatch(/\. No repair attempt was spent/);
    expect(reason).toMatch(/fix the environment \(orbit doctor checks the isolation provider and its limits\) or the check definition and start a new run/);

    // Straight from the first verification to BLOCKED: no inquiry, no diagnosis, no repair, no second implementation, no brief.
    const path = transitions(l, run.id);
    expect(path).toEqual(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'BLOCKED']);
    expect(attemptsUsed(l, run.id)).toBe(1);
    expect(existsSync(join(runDirOf(l, run.id), 'briefs'))).toBe(false);

    // The evidence was INCOMPLETE (the UI run errored), and the decision record names the cause and the log.
    const [ev] = listEvidenceReports(l.db(), run.id);
    expect(ev?.verdict).toBe('INCOMPLETE');
    const [decision] = listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' });
    expect(decision?.data).toMatchObject({ checks: [expect.objectContaining({ check_id: 'ui', fingerprint: null, signals: ['process-aborted'], question_id: null, log_path: expect.stringContaining('app.log') })] });
    const final = readFileSync(join(runDirOf(l, run.id), 'final.md'), 'utf8');
    expect(final).toMatch(/^# Orbit run \S+: BLOCKED/);
    expect(final).toMatch(/Check ui could not execute on candidate 1/);
    expect(final).not.toMatch(/[\u2013\u2014]/);
  }, 180_000);

  it('a UI app that throws while loading is the code\'s failure: the same evidence still goes through the inquiry and the repair loop', async () => {
    const l = uiLab('tools/app-throws.mjs', THROWING_APP);
    writeScenario(l, withUiCriterion(baseScenario({ implementer: [implementClaimingUi(), implementClaimingUi(), implementClaimingUi()], verifier: [DIAGNOSIS] })));
    const run = startLabRun(l);
    await drive(l, run.id);

    const path = transitions(l, run.id);
    expect(path).toContain('INQUISITION');
    expect(path).toContain('REPAIRING');
    expect(listDecisions(l.db(), run.id, { kind: 'verification.environment-failure' })).toEqual([]);
    expect(runState(l, run.id).outcomeReason ?? '').not.toMatch(/could not execute/);
  }, 240_000);

  // Issue #10 moved this block earlier: the check aborts on the base revision too, where it now ends the run at PREFLIGHT
  // (it never ran, so it is no pre-existing failure and gets no baseline-exception question), before any implementation
  // attempt. It used to block at the first candidate, after one attempt.
  it('a command check whose process aborts before it runs, on every revision, ends BLOCKED at PREFLIGHT before any attempt', async () => {
    const l = lab({
      files: { 'tools/unit-abort.mjs': NATIVE_ABORT },
      tweak: (c) => {
        c.checks.unit = { ...c.checks.unit!, command: [process.execPath, 'tools/unit-abort.mjs'] };
      },
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/^Check unit could not run on the base revision [0-9a-f]{12}/);
    expect(done.outcomeReason).toMatch(/killed by a fatal signal/);
    const path = transitions(l, run.id);
    expect(path).not.toContain('DIAGNOSING');
    expect(path).not.toContain('REPAIRING');
    expect(path).not.toContain('INQUISITION');
    expect(path).toEqual(['PREFLIGHT', 'BLOCKED']);
    expect(listQuestions(l.db(), run.id)).toEqual([]);
  }, 180_000);
});
