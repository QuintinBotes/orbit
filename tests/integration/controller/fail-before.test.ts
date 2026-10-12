// Fail-before evidence end to end through the controller (ADR 0014, issue #65), with the fake adapters and the lab's real
// check (`node tests/run.mjs`, which imports every tests/*.test.mjs).
//
// Issue #65: a Python goal asked for "unit tests that fail before the change and pass after". The run ended SUCCEEDED
// with every criterion supported by the candidate's one check log, and nothing showed the new tests failing on the base
// revision. Reproduced here with a new test that cannot fail (it never imports the code it claims to test): under the
// default `advisory` the probe finds it passing on the base revision, the report says so, and the run succeeds as
// before; under `required` it goes to repair. A test that imports the new function fails on the base revision, so it is
// evidence. The probe's attempts live in their own table: check_runs and failures never see them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { resumeTarget } from '../../../src/controller/resume.ts';
import { acquireLease, getRun, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { listProbeAttempts } from '../../../src/evidence/fail-before.ts';
import { listCandidates, listCheckRuns, listEvidenceReports } from '../../../src/evidence/store.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { buildTimeline } from '../../../src/observability/timeline.ts';
import type { FailBeforeMode, OrbitConfig } from '../../../src/policy/types.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { baseScenario, git as labGit, IMPLEMENTER_OUTPUT, implementMul, labDeps, makeLab, PLANNER_OUTPUT, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

function lab(mode: FailBeforeMode | null, opts: { files?: Record<string, string>; tweak?: (c: OrbitConfig) => void } = {}): Lab {
  const l = makeLab({
    ...(opts.files ? { files: opts.files } : {}),
    tweak: (c) => {
      if (mode !== null) c.verification.fail_before = mode;
      opts.tweak?.(c);
    },
  });
  labs.push(l);
  return l;
}

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

/** What `orbit resume` does: the CLI records run.resumed and moves the run to its resume target. */
function resume(l: Lab, runId: string): void {
  acquireLease(l.db(), runId, 'person-resume', 60_000, systemClock);
  const target = resumeTarget(l.db(), getRun(l.db(), runId));
  l.db().tx(() => appendEvent(l.db(), runId, 'run.resumed', 'acme-dev', { from: 'BLOCKED', to: target, forced: false }, systemClock.now()));
  transition(l.db(), { runId, to: target, ownerId: 'person-resume', reason: 'resumed', actor: 'acme-dev', expectedFrom: 'BLOCKED' }, systemClock);
  releaseLease(l.db(), runId, 'person-resume');
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

/** The newest evidence report of the run's candidate `seq`. */
function reportOf(l: Lab, runId: string, seq: number): EvidenceReport {
  const cand = listCandidates(l.db(), runId).find((c) => c.seq === seq)!;
  return listEvidenceReports(l.db(), runId).filter((r) => r.candidateId === cand.id).at(-1)!.report;
}

/** Probe attempts never reach the tables diagnosis, the baseline, reconcile and the learning layer read. */
function expectProbesApart(l: Lab, runId: string): void {
  const probes = listProbeAttempts(l.db(), runId);
  expect(probes.length).toBeGreaterThan(0);
  const probeTrees = new Set(probes.map((p) => p.probeTree));
  const ids = new Set(probes.map((p) => p.id));
  for (const row of listCheckRuns(l.db(), { runId })) {
    expect(probeTrees.has(row.treeHash), `check run ${row.id} ran on a probe tree`).toBe(false);
    expect(ids.has(row.id)).toBe(false);
  }
  for (const f of l.db().all<{ source_id: string | null; excerpt: string | null }>('SELECT source_id, excerpt FROM failures WHERE run_id = ?', runId)) {
    expect(ids.has(f.source_id ?? '')).toBe(false);
  }
}

/** A new test that cannot fail: it never imports mul, so it passes on the base revision too (issue #65). */
const TAUTOLOGY = "// mul multiplies: covered by the arithmetic below\nif (2 * 3 !== 6) { console.error('2 * 3 expected 6'); process.exit(1); }\n";

function implementTautology(): object {
  return {
    edits: [
      { op: 'write', path: 'apps/calc.mjs', content: 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n' },
      { op: 'write', path: 'tests/mul.test.mjs', content: TAUTOLOGY },
    ],
    structured: IMPLEMENTER_OUTPUT,
  };
}

/** A repair that changes production code only: the probe tree (the base tree with the new tests) is the same. */
const PRODUCTION_ONLY = {
  edits: [{ op: 'write', path: 'apps/calc.mjs', content: 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => b * a;\n' }],
  structured: { ...IMPLEMENTER_OUTPUT, summary: 'mul takes its operands in the other order', changed_paths: [{ path: 'apps/calc.mjs', change: 'modify', purpose: 'mul' }] },
};

describe.skipIf(!canStripTypes)('fail-before evidence through the controller', () => {
  it('issue #65 under the default advisory mode: a new test that passes on the base revision is reported, and the run succeeds as before', async () => {
    const l = lab(null);
    expect(l.config.verification.fail_before).toBe('advisory');
    writeScenario(l, baseScenario({ implementer: [implementTautology()] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const report = reportOf(l, run.id, 1);
    expect(report.verdict).toBe('PASS');
    expect(report.acceptance_evidence[0]).toMatchObject({ criterion_id: 'AC-1', status: 'supported', fail_before: { mode: 'advisory', outcome: 'passed-before', test_paths: { paths: ['tests/mul.test.mjs'], count: 1 } } });
    expect(report.unverified).toContain('fail-before (advisory): the new tests of AC-1 pass on the base revision (unit passed on the base revision with the new tests)');
    const [decision] = listDecisions(l.db(), run.id, { kind: 'verification.fail-before' });
    expect(decision?.summary).toBe('unit passed on the base revision with the new tests: AC-1');
    expect(decision?.data).toMatchObject({ base_revision: done.baseRevision, probe_tree: report.acceptance_evidence[0]!.fail_before!.probe_tree, checks: [{ check_id: 'unit', outcome: 'passed-before', criteria: ['AC-1'] }] });
    // The probe tree is the base tree with the new test, pinned under the run's fail-before ref.
    expect(labGit(l.repo, 'show', `refs/orbit/${run.id}/fail-before/1:tests/mul.test.mjs`)).toBe(TAUTOLOGY.trim());
    expect(labGit(l.repo, 'show', `refs/orbit/${run.id}/fail-before/1:apps/calc.mjs`)).toBe('export const add = (a, b) => a + b;');
    expect(buildTimeline(l.db(), getRun(l.db(), run.id)).entries.map((e) => e.text)).toContainEqual('verification.fail-before: unit passed on the base revision with the new tests: AC-1');
    expectProbesApart(l, run.id);
  }, 240_000);

  it('a test that imports the new function fails on the base revision: the run succeeds under required, with the decision recorded', async () => {
    const l = lab('required');
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(transitions(l, run.id)).not.toContain('INQUISITION');
    const report = reportOf(l, run.id, 1);
    expect(report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { mode: 'required', outcome: 'failed-before', reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)' } });
    expect(report.acceptance_evidence[0]!.fail_before!.checks).toEqual([{ id: 'unit', outcome: 'failed-before', attempts: [expect.objectContaining({ status: 'FAILED', exit_code: 1, log: 'evidence/1/fail-before/unit.log' }), expect.objectContaining({ status: 'FAILED', exit_code: 1, log: 'evidence/1/fail-before/unit~1.log' })] }]);
    expect(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'evidence', '1', 'fail-before', 'unit.log'), 'utf8')).toMatch(/does not provide an export named 'mul'/);
    const [decision] = listDecisions(l.db(), run.id, { kind: 'verification.fail-before' });
    expect(decision?.summary).toBe('unit failed on the base revision with the new tests (exit 1, 2 attempts): AC-1');
    expect(buildTimeline(l.db(), getRun(l.db(), run.id)).entries.map((e) => e.text)).toContainEqual('verification.fail-before: unit failed on the base revision with the new tests (exit 1, 2 attempts): AC-1');
    // The expected failures on the probe tree are not the run's: the run itself never failed a check.
    expect(listProbeAttempts(l.db(), run.id).map((p) => [p.checkId, p.attempt, p.status])).toEqual([
      ['unit', 1, 'FAILED'],
      ['unit', 2, 'FAILED'],
    ]);
    expect(l.db().all('SELECT * FROM failures WHERE run_id = ?', run.id)).toEqual([]);
    expectProbesApart(l, run.id);
    // The review packet carries the probe log, and asks whether the failure is an assertion or only a load failure.
    const packet = readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'reviews', '1', 'packet.md'), 'utf8');
    expect(packet).toContain('### Fail-before');
    expect(packet).toMatch(/does not provide an export named 'mul'/);
    expect(packet).toMatch(/an assertion about AC-1, or only a load failure/);
  }, 240_000);

  it('issue #65 under required: a new test that passes on the base revision goes to repair, with the probe log in the brief', async () => {
    const l = lab('required');
    writeScenario(l, baseScenario({ implementer: [implementTautology(), implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const path = transitions(l, run.id);
    const first = path.indexOf('VERIFYING');
    expect(path.slice(first, first + 5)).toEqual(['VERIFYING', 'INQUISITION', 'DIAGNOSING', 'REPAIRING', 'VERIFYING']);
    const r1 = reportOf(l, run.id, 1);
    expect(r1.verdict).toBe('INCOMPLETE');
    const base = done.baseRevision!.slice(0, 12);
    expect(r1.acceptance_evidence[0]).toMatchObject({ status: 'unverified', note: `the new tests pass on the base revision: unit passed on ${base} with 1 test file overlaid (evidence/1/fail-before/unit.log), so they do not show the change, or unit does not run them` });
    const brief = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'briefs', 'attempt-2.json'), 'utf8')) as { brief: { evidence: string[] } };
    expect(brief.brief.evidence).toContain(`AC-1: the new tests pass on the base revision: unit passed on ${base} with 1 test file overlaid (evidence/1/fail-before/unit.log), so they do not show the change, or unit does not run them`);
    expect(reportOf(l, run.id, 2).acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'failed-before' } });
    expect(listDecisions(l.db(), run.id, { kind: 'verification.fail-before' }).map((d) => d.summary)).toEqual(['unit passed on the base revision with the new tests: AC-1', 'unit failed on the base revision with the new tests (exit 1, 2 attempts): AC-1']);
    expectProbesApart(l, run.id);
  }, 240_000);

  it('required: a production-only repair reuses the probe; when the attempts run out a person is asked, and an acceptance for the tree lets the run succeed', async () => {
    const l = lab('required');
    writeScenario(l, baseScenario({ implementer: [implementTautology(), PRODUCTION_ONLY] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/^AC-1: the new tests pass on the base revision: unit passed on [0-9a-f]{12} with 1 test file overlaid/);
    expect(blocked.outcomeReason).toMatch(/; the repair attempts ran out \(implementation attempt allowance spent \(2 of 2\) and no extension\)\. /);
    expect(blocked.outcomeReason).toMatch(/Accept it without fail-before for tree [0-9a-f]{12} \(a refactor, or a characterization test\), or not\. Answer it with orbit decide \S+ <question-id> accept\|decline, then orbit resume \S+\. Questions: q-fail-before-[0-9a-f]+: Accept AC-1 without fail-before evidence for candidate 2 \(tree [0-9a-f]{12}\)\?$/);
    expect(blocked.outcomeReason).not.toMatch(/[–—]/);
    // Two candidates, one probe: the repair changed production code only, so the probe tree is the same.
    const cands = listCandidates(l.db(), run.id);
    expect(cands.length).toBeGreaterThanOrEqual(2);
    const tree1 = reportOf(l, run.id, 1).acceptance_evidence[0]!.fail_before!.probe_tree;
    expect(reportOf(l, run.id, 2).acceptance_evidence[0]!.fail_before).toMatchObject({ outcome: 'passed-before', probe_tree: tree1 });
    expect(listDecisions(l.db(), run.id, { kind: 'verification.fail-before' })).toHaveLength(1);
    expect(new Set(listProbeAttempts(l.db(), run.id).map((p) => p.probeId)).size).toBe(1);
    expect(listCheckRuns(l.db(), { runId: run.id, candidateId: cands[1]!.id, checkId: 'unit' }).length).toBeGreaterThan(0);
    expectProbesApart(l, run.id);

    const [question] = listQuestions(l.db(), run.id, { status: 'open' });
    expect(question).toMatchObject({ question: expect.stringMatching(/^Accept AC-1 without fail-before evidence for candidate \d+ \(tree [0-9a-f]{12}\)\?$/), affected: ['AC-1'], material: true });
    expect(question!.options.map((o) => o.label)).toEqual(['accept', 'decline']);
    answerQuestion(l.db(), join(l.repo, '.orbit', 'runs', run.id), question!.id, 'accept', 'acme-dev', systemClock);
    expect(resumeTarget(l.db(), getRun(l.db(), run.id))).toBe('VERIFYING');
    resume(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const last = listEvidenceReports(l.db(), run.id).at(-1)!.report;
    expect(last.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'passed-before', accepted: { question_id: question!.id, by: 'acme-dev' } } });
    expect(last.unverified).toContain(`fail-before: AC-1 accepted without fail-before by acme-dev (question ${question!.id}): unit passed on the base revision with the new tests`);
    expect(listDecisions(l.db(), run.id, { kind: 'verification.fail-before-accepted' }).map((d) => d.summary)).toEqual([expect.stringMatching(/^acme-dev accepted AC-1 without fail-before for tree [0-9a-f]{12} only$/)]);
  }, 240_000);

  it('required: a probe that is not established blocks the run with one question per criterion, and the person\'s acceptance is bound to the tree', async () => {
    // A test that fails once on the base revision and then passes: a mixed result, which shows nothing.
    const flaky = [
      "import * as calc from '../apps/calc.mjs';",
      "import { existsSync, writeFileSync } from 'node:fs';",
      "if (typeof calc.mul !== 'function') {",
      "  const flag = new URL('../.probe-flag', import.meta.url);",
      "  if (!existsSync(flag)) { writeFileSync(flag, ''); console.error('mul is missing'); process.exit(1); }",
      '} else if (calc.mul(2, 3) !== 6) { console.error(\'mul(2, 3) expected 6\'); process.exit(1); }',
      '',
    ].join('\n');
    const l = lab('required', { files: { '.gitignore': '.orbit/\n.probe-flag\n' } });
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/mul.test.mjs', content: flaky }])] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/^fail-before evidence is required \(verification\.fail_before: required\), and for candidate 1 \(tree [0-9a-f]{12}\) it was not established: AC-1: unit gave mixed results on the probe tree \(FAILED, then PASSED\)/);
    expect(transitions(l, run.id)).not.toContain('INQUISITION');
    expect(reportOf(l, run.id, 1).acceptance_evidence[0]).toMatchObject({ status: 'blocked', fail_before: { outcome: 'not-established', cause: 'mixed' } });
    const open = listQuestions(l.db(), run.id, { status: 'open' });
    expect(open).toHaveLength(1);
    expect(JSON.parse(blocked.outcomeJson ?? '{}')).toMatchObject({ fail_before: { not_established: [{ criterion_id: 'AC-1', cause: 'mixed' }], questions: [open[0]!.id] } });

    answerQuestion(l.db(), join(l.repo, '.orbit', 'runs', run.id), open[0]!.id, 'accept', 'acme-dev', systemClock);
    resume(l, run.id);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listEvidenceReports(l.db(), run.id).at(-1)!.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'not-established', accepted: { by: 'acme-dev' } } });
    expectProbesApart(l, run.id);
  }, 240_000);

  it('a candidate that changes a dependency manifest outside test-owned paths is not probed, with that reason', async () => {
    const manifest = (deps: Record<string, string>) => `${JSON.stringify({ name: 'acme', version: '1.0.0', private: true, dependencies: deps }, null, 2)}\n`;
    const planner = { ...PLANNER_OUTPUT, allowed_paths: ['apps/**', 'tests/**', 'package.json'], expected_changed_files: [...PLANNER_OUTPUT.expected_changed_files, { path: 'package.json', change: 'modify', reason: 'a dependency' }] };
    const l = lab(null, {
      files: { 'package.json': manifest({}) },
      tweak: (c) => {
        c.scope.allowed_paths = ['apps/**', 'tests/**', 'package.json'];
        c.dependencies.add_packages = true;
      },
    });
    writeScenario(l, baseScenario({ planner: [{ structured: planner }], implementer: [implementMul('*', [{ op: 'write', path: 'package.json', content: manifest({ 'left-pad': '1.3.0' }) }])] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const report = reportOf(l, run.id, 1);
    expect(report.scope.dependency_manifest_changed).toEqual(['package.json']);
    expect(report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { mode: 'advisory', outcome: 'not-established', cause: 'manifest', probe_tree: null } });
    expect(report.acceptance_evidence[0]!.fail_before!.reason).toMatch(/^not probed: the candidate changes package\.json, a dependency manifest or lockfile outside test-owned paths/);
    expect(report.unverified.some((u) => u.startsWith('fail-before (advisory): AC-1 could not be probed (not probed: the candidate changes package.json'))).toBe(true);
    expect(listProbeAttempts(l.db(), run.id)).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'verification.fail-before' })).toEqual([]);
    expect(existsSync(join(l.repo, '.orbit', 'runs', run.id, 'evidence', '1', 'fail-before'))).toBe(false);
  }, 240_000);

  it('off: no probe runs, and unverified says so', async () => {
    const l = lab('off');
    writeScenario(l, baseScenario({ implementer: [implementTautology()] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const report = reportOf(l, run.id, 1);
    expect(report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { mode: 'off', outcome: 'not-run' } });
    expect(report.unverified).toContain('fail-before: the probe was not run (verification.fail_before: off), so no new test was shown to fail on the base revision: AC-1');
    expect(listProbeAttempts(l.db(), run.id)).toEqual([]);
  }, 240_000);
});
