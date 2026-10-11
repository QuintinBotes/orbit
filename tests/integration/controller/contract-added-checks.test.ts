// A check the contract requires that the base revision did not run (issue #32, docs/decisions/0012-contract-checks-and-judged-trees.md).
//
// Doctor advised checks.format.mandatory: false for a dotnet format check that cannot run in the macOS check sandbox.
// The baseline then skipped it, the planner cited it in an optional criterion (contract.check-added: format), and on the
// candidate it failed on the sandbox's refused named pipe. The base revision had never run it, so the candidate gate
// (ADR 0010: a new denial counts on a candidate only when the same check's base result had the same classification)
// could not tell the environment from the code: the run went to diagnosis and repair on an identical tree and ended
// EXHAUSTED. Now the check is run on the base revision before any change is judged (a baseline amendment, recorded):
// an environment failure there blocks the run as PREFLIGHT does, a pre-existing failure follows the existing rules,
// and a pass establishes a clean base.
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { resetFaults } from '../../../src/core/faults.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { frozenPolicySetting, resumeTarget } from '../../../src/controller/resume.ts';
import { acquireLease, getRun, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { listCheckRuns } from '../../../src/evidence/store.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, PLANNER_OUTPUT, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (dir: string, name: string): string => readFileSync(join(here, '../../fixtures', dir, name), 'utf8').replace(/^\[orbit\] .*\n?$/m, '');

const labs: Lab[] = [];
const bins: string[] = [];
afterEach(() => {
  delete process.env.ORBIT_FAULTS;
  resetFaults();
  for (const l of labs.splice(0)) l.close();
  for (const b of bins.splice(0)) rmSync(b, { recursive: true, force: true });
});

/** A directory for the check's PATH holding a stand-in program that prints `output` and exits with `exit`. */
function binWith(name: string, output: string, exit: number): string {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-bin-')));
  bins.push(bin);
  install(bin, name, output, exit);
  return bin;
}

function install(bin: string, name: string, output: string, exit: number): void {
  const path = join(bin, name);
  writeFileSync(path, `#!${process.execPath}\nprocess.stdout.write(${JSON.stringify(output)});\nprocess.exit(${exit});\n`);
  chmodSync(path, 0o755);
}

const PATH = (bin: string): Record<string, string> => ({ PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` });

/** A lab whose policy defines `checks` beside the mandatory unit check, each optional unless it says otherwise. */
function labWith(checks: Record<string, Partial<CheckDefinition>>, files: Record<string, string> = {}): Lab {
  const l = makeLab({
    files,
    tweak: (c) => {
      for (const [id, d] of Object.entries(checks)) c.checks[id] = { ...c.checks.unit!, id, mandatory: false, ...d };
    },
  });
  labs.push(l);
  return l;
}

/** The planner's output with one more criterion, optional unless said, that cites `checkId` as its evidence. */
function plannerCiting(checkId: string, opts: { mandatory?: boolean; statement?: string } = {}): object {
  return {
    ...PLANNER_OUTPUT,
    criteria: [
      ...PLANNER_OUTPUT.criteria,
      { key: checkId, statement: opts.statement ?? 'The changed files keep the repository formatting.', mandatory: opts.mandatory ?? false, ui: false, proof: [`check ${checkId} passes`], check_ids: [checkId], changes: [] },
    ],
  };
}

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

/** What `orbit resume` does for a blocked run. */
function resume(l: Lab, runId: string): void {
  acquireLease(l.db(), runId, 'person-resume', 60_000, systemClock);
  transition(l.db(), { runId, to: resumeTarget(l.db(), getRun(l.db(), runId)), ownerId: 'person-resume', reason: 'resumed', actor: 'acme-dev', expectedFrom: 'BLOCKED' }, systemClock);
  releaseLease(l.db(), runId, 'person-resume');
}

interface Baseline {
  checkIds: string[];
  checks: { checkId: string; status: string }[];
  failures: { checkId: string; classification?: string; signals?: string[] }[];
  amendments?: { checkIds: string[]; stage: string }[];
  complete: boolean;
}

function baselineOf(l: Lab, runId: string): Baseline {
  return JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', runId, 'baseline.json'), 'utf8')) as Baseline;
}

const baseRuns = (l: Lab, runId: string, checkId: string): string[] => listCheckRuns(l.db(), { runId, candidateId: null, checkId, rootsOnly: true }).map((r) => r.status);

/** Step the run, holding its lease, until it is about to run VERIFYING, and return the deps that stepped it. */
async function stepToVerifying(l: Lab, runId: string): Promise<ControllerDeps> {
  const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
  acquireLease(l.db(), runId, 'controller-a', 3_600_000, systemClock);
  for (let i = 0; i < 2_400 && runState(l, runId).state !== 'VERIFYING'; i++) {
    await step(deps, runId, new AbortController().signal);
    if (runState(l, runId).state !== 'VERIFYING') await new Promise((r) => setTimeout(r, 25));
  }
  expect(runState(l, runId).state, runState(l, runId).outcomeReason ?? '').toBe('VERIFYING');
  return deps;
}

describe.skipIf(!canStripTypes)('a check the contract adds is run on the base revision before any change is judged (issue #32)', () => {
  it('an optional dotnet format check the contract cites, which cannot run in the sandbox, blocks before any attempt, and a resume runs it again', async () => {
    // What the real dotnet format printed under srt on macOS (SDK 9.0.305) when the sandbox refused its build host's pipe.
    const bin = binWith('dotnet', fixture('environment', 'dotnet-format-build-host-timeout.log'), 1);
    const l = labWith({ format: { command: ['dotnet', 'format', '--verify-no-changes'], env: PATH(bin) } });
    writeScenario(l, baseScenario({ planner: [{ structured: plannerCiting('format') }], implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    // PREFLIGHT ran the mandatory unit check only; the contract added format; it was run on the base revision before any attempt.
    expect(listDecisions(l.db(), run.id, { kind: 'contract.check-added' }).map((d) => (d.data as { subject: string }).subject)).toEqual(['format']);
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'BLOCKED']);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toEqual([]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'verifier' })).toEqual([]);
    const reason = done.outcomeReason ?? '';
    expect(reason).toMatch(/^Check format could not run on the base revision [0-9a-f]{12}, and the output shows an environment cause, not a pre-existing failure: the sandbox refused a \.NET process the named pipe it binds under \/tmp/);
    expect(reason).toMatch(/\. The contract requires check format \(criterion AC-2 cites it as evidence\), which the policy does not mark mandatory, so it was run on the base revision before any change was judged \(a baseline amendment\)\./);
    // The fix never offers to make the check optional: an optional check the contract requires blocks as a mandatory one does.
    expect(reason).not.toMatch(/mandatory: false/);
    if (process.platform === 'darwin') expect(reason).toMatch(/remove checks\.format from \.orbit\/config\.yaml and run dotnet format in CI/);
    expect(reason).toMatch(/Then orbit resume orb-[\w-]+ runs the baseline again/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    for (const sentence of reason.split(/(?<=[a-z0-9)"\]])\. (?=\S)/)) expect(sentence, sentence).toMatch(/^[A-Z]/);
    // An environment failure, not the policy's: a resume after the environment is fixed is the way forward.
    expect(frozenPolicySetting(getRun(l.db(), run.id))).toBeNull();
    expect(listQuestions(l.db(), run.id)).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' })).toEqual([]);

    const baseline = baselineOf(l, run.id);
    expect(baseline.checkIds).toEqual(['format', 'unit']);
    expect(baseline.failures.map((f) => [f.checkId, f.classification, f.signals])).toEqual([['format', 'environment', ['pipe-denied']]]);
    expect(baseline.amendments).toEqual([expect.objectContaining({ checkIds: ['format'], stage: 'PLANNING' })]);
    // PREFLIGHT's baseline was complete, and an amendment that blocks leaves it so (issue #33 marks only PREFLIGHT's own
    // incomplete): its classification is what makes the resume run the check again.
    expect(baseline.complete).toBe(true);
    const [amended] = listDecisions(l.db(), run.id, { kind: 'baseline.amended' });
    expect(amended?.data).toMatchObject({ stage: 'PLANNING', checks: [expect.objectContaining({ check_id: 'format', status: 'FAILED', classification: 'environment', cited_by: ['AC-2'] })] });
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })[0]?.data).toMatchObject({ checks: [expect.objectContaining({ check_id: 'format', classification: 'environment', signals: ['pipe-denied'] })] });

    // The environment is fixed: the resume runs the check on the base revision again, and the run goes on and succeeds.
    install(bin, 'dotnet', 'Formatted 0 of 1 files.\n', 0);
    resume(l, run.id);
    await drive(l, run.id);
    const again = runState(l, run.id);
    expect(again.state, again.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(transitions(l, run.id).slice(0, 6)).toEqual(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'BLOCKED', 'PLANNING', 'IMPLEMENTING']);
    expect(baseRuns(l, run.id, 'format')).toEqual(['FAILED', 'PASSED']);
    expect(baseRuns(l, run.id, 'unit')).toEqual(['PASSED']);
    const after = baselineOf(l, run.id);
    expect(after.failures).toEqual([]);
    expect(after.complete).toBe(true);
    expect(after.checks.map((c) => [c.checkId, c.status]).sort()).toEqual([['format', 'PASSED'], ['unit', 'PASSED']]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(1);
  }, 240_000);

  // Issue #36: a direct argv whose executable is absent becomes ERROR rather than a shell's exit 127. It must receive
  // the same baseline classification and PLANNING block as an executable that did start and then reported a refusal.
  it('a contract-required check the runner cannot start blocks at PLANNING before an implementer session', async () => {
    const l = labWith({ lint: { command: ['orbit-missing-linter', '--check'] } });
    writeScenario(l, baseScenario({ planner: [{ structured: plannerCiting('lint') }], implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'BLOCKED']);
    expect(done.outcomeReason).toContain('the check could not be started');
    expect(done.outcomeReason).toContain('The contract requires check lint (criterion AC-2 cites it as evidence)');
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toEqual([]);
    expect(listCheckRuns(l.db(), { runId: run.id, checkId: 'unit' }).filter((r) => r.candidateId !== null)).toEqual([]);

    const baseline = baselineOf(l, run.id);
    expect(baseline.checkIds).toEqual(['unit']);
    expect(baseline.checks.find((c) => c.checkId === 'lint')?.status).toBe('ERROR');
    expect(baseline.failures).toEqual([expect.objectContaining({ checkId: 'lint', classification: 'environment', signals: ['start-failed'] })]);
    expect(baseline.complete).toBe(false);
    expect(baseRuns(l, run.id, 'lint')).toEqual(['ERROR']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })[0]?.data).toMatchObject({ stage: 'PLANNING', checks: [expect.objectContaining({ check_id: 'lint', signals: ['start-failed'] })] });
  }, 240_000);

  it('a check a contract amendment adds after PLANNING is run on the base revision before the candidate is judged, and blocks there when it cannot run', async () => {
    const l = labWith({ lint: { command: ['orbit-acme-missing-linter --check'], shell: true } });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    const deps = await stepToVerifying(l, run.id);
    // What an approved add_required_checks amendment leaves on the run: the contract requires lint from now on.
    const contract = JSON.parse(getRun(l.db(), run.id).contractJson!) as { required_check_ids: string[] };
    contract.required_check_ids.push('lint');
    l.db().run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(contract), run.id);
    await step(deps, run.id, new AbortController().signal);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.resumeState).toBe('VERIFYING');
    expect(done.outcomeReason).toMatch(/^Check lint could not run on the base revision [0-9a-f]{12}, and the output shows an environment cause, not a pre-existing failure: the program "orbit-acme-missing-linter" was not found where the check runs \(exit 127\)/);
    expect(done.outcomeReason).toContain('. The contract requires check lint (the contract lists it among its required checks), which the policy does not mark mandatory, so it was run on the base revision before any change was judged (a baseline amendment).');
    // The candidate was not judged: no check ran on it, and no evidence report was written.
    expect(listCheckRuns(l.db(), { runId: run.id, checkId: 'unit' }).filter((r) => r.candidateId !== null)).toEqual([]);
    expect(baselineOf(l, run.id).amendments).toEqual([expect.objectContaining({ checkIds: ['lint'], stage: 'VERIFYING' })]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })[0]?.data).toMatchObject({ stage: 'VERIFYING', checks: [expect.objectContaining({ check_id: 'lint', signals: ['program-not-found'] })] });
  }, 240_000);

  it('a missing target an amendment found stops blocking once an approved amendment stops requiring the check', async () => {
    // cargo's answer when the nextest plugin is not installed: a missing target on the base revision. AC-2 cites the
    // check, so at PLANNING it is expected to flip, and the run goes on.
    const bin = binWith('cargo', fixture('misconfigured', 'cargo-plugin-not-installed.log'), 101);
    const l = labWith({ nextest: { command: ['cargo', 'nextest', 'run'], env: PATH(bin) } });
    writeScenario(l, baseScenario({ planner: [{ structured: plannerCiting('nextest', { statement: 'The calculator tests run under nextest.' }) }], implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    const deps = await stepToVerifying(l, run.id);
    expect(baselineOf(l, run.id).failures.map((f) => [f.checkId, f.classification])).toEqual([['nextest', 'missing-target']]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.expected-to-flip' }).map((d) => (d.data as { check_id: string }).check_id)).toEqual(['nextest']);

    // What an approved remove_required_checks (criterion_id null) leaves on the run: no criterion cites nextest and the
    // contract no longer requires it, so verification never runs it and its base-revision result judges nothing.
    const contract = JSON.parse(getRun(l.db(), run.id).contractJson!) as { required_check_ids: string[]; acceptance_criteria: { check_ids?: string[] }[] };
    contract.required_check_ids = contract.required_check_ids.filter((id) => id !== 'nextest');
    for (const c of contract.acceptance_criteria) c.check_ids = (c.check_ids ?? []).filter((id) => id !== 'nextest');
    l.db().run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(contract), run.id);
    await step(deps, run.id, new AbortController().signal);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('REVIEWING');
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.check-misconfigured' })).toEqual([]);
    // Not run again on the base revision, and never on the candidate.
    expect(baseRuns(l, run.id, 'nextest')).toEqual(['FAILED']);
    expect(listCheckRuns(l.db(), { runId: run.id, checkId: 'nextest' }).filter((r) => r.candidateId !== null)).toEqual([]);
  }, 240_000);

  it('an amendment cut short after it recorded the baseline, before it judged the check, is amended and judged on the next pass', async () => {
    // tools/lint.mjs fails on the base revision (apps/calc.mjs has no mul yet), a pre-existing failure of the code, and
    // passes on the candidate. No criterion cites lint, so its baseline-exception question stays open.
    const lint = "import { readFileSync } from 'node:fs';\nif (!readFileSync('apps/calc.mjs', 'utf8').includes('mul')) { console.error('apps/calc.mjs: missing export mul'); process.exit(1); }\nconsole.log('lint clean');\n";
    const l = labWith({ lint: { command: [process.execPath, 'tools/lint.mjs'] } }, { 'tools/lint.mjs': lint });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    const deps = await stepToVerifying(l, run.id);
    // What an approved add_required_checks (criterion_id null) leaves on the run.
    const contract = JSON.parse(getRun(l.db(), run.id).contractJson!) as { required_check_ids: string[] };
    contract.required_check_ids.push('lint');
    l.db().run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(contract), run.id);

    // The step dies right after the amended baseline is written: as a crash would, it leaves the check recorded and unjudged.
    process.env.ORBIT_FAULTS = 'controller.baseline-amendment.after-write=throw';
    resetFaults();
    const cut = await step(deps, run.id, new AbortController().signal);
    expect(cut.waiting).toMatch(/fault injected at controller\.baseline-amendment\.after-write/);
    expect(runState(l, run.id).state).toBe('VERIFYING');
    expect(baselineOf(l, run.id).amendments).toEqual([expect.objectContaining({ checkIds: ['lint'], stage: 'VERIFYING' })]);
    expect(listQuestions(l.db(), run.id)).toEqual([]);

    // The next pass does not take the recorded result as judged: it amends the baseline again and judges lint. The
    // recorded run of lint is a failure of the code, which runBaseline reuses as recorded, so lint does not run twice.
    await step(deps, run.id, new AbortController().signal);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('REVIEWING');
    expect(baseRuns(l, run.id, 'lint')).toEqual(['FAILED']);
    expect(baselineOf(l, run.id).amendments?.map((a) => a.stage)).toEqual(['VERIFYING', 'VERIFYING']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.amended' }).map((d) => d.data)).toEqual([expect.objectContaining({ stage: 'VERIFYING', checks: [expect.objectContaining({ check_id: 'lint', status: 'FAILED' })] })]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.failures' }).map((d) => d.data)).toEqual([expect.objectContaining({ failures: [expect.objectContaining({ checkId: 'lint' })] })]);
    expect(listQuestions(l.db(), run.id).map((q) => [q.affected, q.status])).toEqual([[['check:lint'], 'open']]);
  }, 240_000);

  it('a check the contract adds that passes on the base revision is recorded there, and the run goes on as before', async () => {
    const l = labWith({ lint: { command: [process.execPath, 'tools/lint.mjs'] } }, { 'tools/lint.mjs': "console.log('lint clean');\n" });
    writeScenario(l, baseScenario({ planner: [{ structured: plannerCiting('lint', { statement: 'The calculator stays lint clean.' }) }], implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(transitions(l, run.id).slice(0, 4)).toEqual(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING']);
    const baseline = baselineOf(l, run.id);
    expect(baseline.checkIds).toEqual(['lint', 'unit']);
    expect(baseline.checks.find((c) => c.checkId === 'lint')?.status).toBe('PASSED');
    expect(baseline.failures).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.amended' })[0]?.data).toMatchObject({ stage: 'PLANNING', checks: [expect.objectContaining({ check_id: 'lint', status: 'PASSED' })] });
    expect(listQuestions(l.db(), run.id)).toEqual([]);
    // Run once on the base revision, however many steps read the baseline afterwards.
    expect(baseRuns(l, run.id, 'lint')).toEqual(['PASSED']);
  }, 240_000);

  // Final review: with no check the policy marks mandatory PREFLIGHT ran nothing, yet its baseline gate said "pass" with
  // "0 check(s)", and the checks the contract requires then ran through the amendment, which recorded no gate at all.
  it('records the baseline gate as not applicable when PREFLIGHT ran nothing, and again with the checks an amendment ran', async () => {
    const l = labWith({ unit: {} });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(baselineOf(l, run.id).amendments?.map((a) => [a.stage, a.checkIds])).toEqual([['PLANNING', ['unit']]]);
    const gates = listDecisions(l.db(), run.id, { kind: 'gate.baseline' }).map((d) => d.data as { status: string; evidence: string[]; notes: string[] });
    expect(gates.map((g) => g.status)).toEqual(['not_applicable', 'pass']);
    expect(gates[0]).toMatchObject({ evidence: [], notes: [expect.stringMatching(/no check/)] });
    expect(gates[1]?.evidence).toEqual([expect.stringMatching(/: 1 check\(s\)$/)]);
  }, 240_000);

  it('a pre-existing failure of a check the contract adds follows the existing rules: the contract names it as a proof, so it is expected to flip', async () => {
    // tools/lint.mjs fails on the base revision because apps/calc.mjs has no mul yet: a failure of the code, which the goal fixes.
    const lint = "import { readFileSync } from 'node:fs';\nif (!readFileSync('apps/calc.mjs', 'utf8').includes('mul')) { console.error('apps/calc.mjs: missing export mul'); process.exit(1); }\nconsole.log('lint clean');\n";
    const l = labWith({ lint: { command: [process.execPath, 'tools/lint.mjs'] } }, { 'tools/lint.mjs': lint });
    writeScenario(l, baseScenario({ planner: [{ structured: plannerCiting('lint', { mandatory: true, statement: 'apps/calc.mjs exports mul.' }) }], implementer: [implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const baseline = baselineOf(l, run.id);
    expect(baseline.failures.map((f) => [f.checkId, f.classification])).toEqual([['lint', undefined]]);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.failures' }).map((d) => d.data)).toEqual([expect.objectContaining({ failures: [expect.objectContaining({ checkId: 'lint' })] })]);
    // Its baseline-exception question was raised and, the contract naming the check as the proof of AC-2, withdrawn.
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.expected-to-flip' }).map((d) => d.data)).toEqual([expect.objectContaining({ check_id: 'lint', criteria: ['AC-2'] })]);
    expect(listQuestions(l.db(), run.id).map((q) => q.status)).toEqual(['withdrawn']);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.environment-failure' })).toEqual([]);
  }, 240_000);
});
