// Fail-before in the evidence report (ADR 0014 sections 4 and 5). Test evidence is per check in every mode: a criterion
// is supported through new tests only by a check it cites whose run includes a test change (the change lies under the
// check's directory). Each criterion gains a `fail_before` entry. advisory reports only; required decides: failed-before
// supports, passed-before leaves the criterion unverified with the note naming the base and the log, and not established
// blocks it, unless a person accepted the criterion without fail-before for this tree.
import { describe, expect, it } from 'vitest';
import { evaluateEvidence, type BuildReportInput } from '../../../src/evidence/report.ts';
import type { CheckProbe, FailBeforeEvidence, ProbeResult } from '../../../src/evidence/fail-before.ts';
import type { FailBeforeMode } from '../../../src/policy/types.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result } from './report-fixtures.ts';
import { checkDef } from './fixtures.ts';

const BASE_REV = 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0';

describe('test evidence is per check', () => {
  // Two packages, each with its own test check: a test added under b/ says nothing about a's criterion.
  const snapshot = fakeSnapshot([checkDef('unit-a', { cwd: 'a' }), checkDef('unit-b', { cwd: 'b' })]);
  const twoPackages = contract({
    acceptance_criteria: [
      { id: 'AC-1', statement: 'a exports mul', proof: ['a test'], mandatory: true, check_ids: ['unit-a'] },
      { id: 'AC-2', statement: 'b exports div', proof: ['b test'], mandatory: true, check_ids: ['unit-b'] },
    ],
    required_check_ids: ['unit-a', 'unit-b'],
  });
  const judge = (changedPaths: string[]) =>
    evaluateEvidence({
      contract: twoPackages,
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'unit-a'), result(snapshot, 'unit-b')],
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'unit-a', status: 'PASSED' }, { checkId: 'unit-b', status: 'PASSED' }], changedPaths },
    });

  it('a test change under another criterion\'s check no longer supports a criterion', () => {
    const e = judge(['a/src/mul.mjs', 'b/src/div.mjs', 'b/tests/div.test.mjs']);
    expect(e.report.acceptance_evidence.map((a) => [a.criterion_id, a.status])).toEqual([
      ['AC-1', 'unverified'],
      ['AC-2', 'supported'],
    ]);
    expect(e.report.acceptance_evidence[0]!.note).toBe('no new evidence: unit-a already passed on the base revision and no test the candidate adds or changes lies under its directory (a)');
    expect(e.report.verdict).toBe('INCOMPLETE');
  });

  it('supports each criterion through the tests under its own check', () => {
    const e = judge(['a/src/mul.mjs', 'a/tests/mul.test.mjs', 'b/src/div.mjs', 'b/tests/div.test.mjs']);
    expect(e.report.acceptance_evidence.map((a) => a.status)).toEqual(['supported', 'supported']);
    expect(e.report.verdict).toBe('PASS');
  });

  it('keeps the old wording when the candidate changes no test at all', () => {
    expect(judge(['a/src/mul.mjs']).report.acceptance_evidence[0]!.note).toBe('no new evidence: unit-a already passed on the base revision and the candidate adds or changes no test');
  });
});

describe('fail_before per criterion, by mode', () => {
  const withMode = (mode: FailBeforeMode) => fakeSnapshot([checkDef('unit'), checkDef('lint', { category: 'lint', mandatory: false })], (c) => (c.verification.fail_before = mode));
  const oneCriterion = contract({
    acceptance_criteria: [{ id: 'AC-1', statement: 'mul multiplies', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] }],
    required_check_ids: ['unit'],
  });
  const probe = (check: Partial<CheckProbe>): ProbeResult => ({
    probeId: 'probe-1',
    probeTree: 'tree-probe',
    baseRevision: BASE_REV,
    testPaths: ['tests/mul.test.mjs', 'tests/helpers.mjs'],
    reused: false,
    checks: [{ checkId: 'unit', outcome: 'failed-before', reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)', attempts: [{ attempt: 1, status: 'FAILED', exitCode: 1, signals: [], log: 'evidence/1/fail-before/unit.log' }, { attempt: 2, status: 'FAILED', exitCode: 1, signals: [], log: 'evidence/1/fail-before/unit~1.log' }], ...check }],
  });
  const PASSED_BEFORE: Partial<CheckProbe> = { outcome: 'passed-before', reason: 'unit passed on the base revision with the new tests', attempts: [{ attempt: 1, status: 'PASSED', exitCode: 0, signals: [], log: 'evidence/1/fail-before/unit.log' }] };
  const TIMED_OUT: Partial<CheckProbe> = { outcome: 'not-established', cause: 'timeout', reason: 'unit timed out on the probe tree', attempts: [{ attempt: 1, status: 'TIMEOUT', exitCode: null, signals: [], log: 'evidence/1/fail-before/unit.log' }] };
  const judge = (mode: FailBeforeMode, failBefore: Omit<FailBeforeEvidence, 'mode'> | null, over: Partial<BuildReportInput> = {}) => {
    const snapshot = withMode(mode);
    return evaluateEvidence({
      contract: oneCriterion,
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'unit')],
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }], changedPaths: ['apps/calc.mjs', 'tests/mul.test.mjs'] },
      ...(failBefore ? { failBefore: { mode, ...failBefore } } : {}),
      ...over,
    });
  };

  it('off: today\'s rule, and unverified says the probe was not run', () => {
    const e = judge('off', { probe: null, skipped: null, accepted: [] });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { mode: 'off', outcome: 'not-run', checks: [], probe_tree: null, test_paths: { paths: ['tests/mul.test.mjs'], count: 1 } } });
    expect(e.report.unverified).toEqual(['fail-before: the probe was not run (verification.fail_before: off), so no new test was shown to fail on the base revision: AC-1']);
  });

  it('advisory: a failed-before probe is reported and changes nothing', () => {
    const e = judge('advisory', { probe: probe({}), skipped: null, accepted: [] });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.unverified).toEqual([]);
    expect(e.report.acceptance_evidence[0]).toMatchObject({
      status: 'supported',
      fail_before: {
        mode: 'advisory',
        outcome: 'failed-before',
        probe_tree: 'tree-probe',
        reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)',
        checks: [{ id: 'unit', outcome: 'failed-before', attempts: [{ status: 'FAILED', exit_code: 1, log: 'evidence/1/fail-before/unit.log' }, { status: 'FAILED', exit_code: 1, log: 'evidence/1/fail-before/unit~1.log' }] }],
      },
    });
  });

  it('advisory: new tests that pass on the base revision, or could not be probed, add one unverified line and nothing else', () => {
    const passed = judge('advisory', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] });
    expect(passed.report.verdict).toBe('PASS');
    expect(passed.report.acceptance_evidence[0]!.status).toBe('supported');
    expect(passed.report.unverified).toEqual(['fail-before (advisory): the new tests of AC-1 pass on the base revision (unit passed on the base revision with the new tests)']);
    const open = judge('advisory', { probe: probe(TIMED_OUT), skipped: null, accepted: [] });
    expect(open.report.verdict).toBe('PASS');
    expect(open.report.unverified).toEqual(['fail-before (advisory): AC-1 could not be probed (unit timed out on the probe tree)']);
  });

  it('required: failed-before supports the criterion', () => {
    const e = judge('required', { probe: probe({}), skipped: null, accepted: [] });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { mode: 'required', outcome: 'failed-before' } });
  });

  it('required: passed-before leaves the criterion unverified, naming the base, the files overlaid and the log', () => {
    const e = judge('required', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] });
    expect(e.report.verdict).toBe('INCOMPLETE');
    const entry = e.report.acceptance_evidence[0]!;
    expect(entry.status).toBe('unverified');
    expect(entry.note).toBe('the new tests pass on the base revision: unit passed on b0b0b0b0b0b0 with 2 test files overlaid (evidence/1/fail-before/unit.log), so they do not show the change, or unit does not run them');
    expect(e.incompleteReasons).toContain(`criterion AC-1: unverified (${entry.note})`);
  });

  it('required: not established blocks the criterion with the cause', () => {
    const e = judge('required', { probe: probe(TIMED_OUT), skipped: null, accepted: [] });
    expect(e.report.verdict).toBe('INCOMPLETE');
    expect(e.report.acceptance_evidence[0]).toMatchObject({ status: 'blocked', note: 'fail-before not established: unit timed out on the probe tree', fail_before: { outcome: 'not-established', cause: 'timeout' } });
    const skipped = judge('required', { probe: null, skipped: { cause: 'manifest', reason: 'the candidate changes package.json, a dependency manifest outside test-owned paths' }, accepted: [] });
    expect(skipped.report.acceptance_evidence[0]).toMatchObject({ status: 'blocked', fail_before: { outcome: 'not-established', cause: 'manifest', reason: 'the candidate changes package.json, a dependency manifest outside test-owned paths' } });
  });

  it('required: a person\'s acceptance for this tree supports the criterion, and unverified says who accepted it', () => {
    const e = judge('required', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [{ criterionId: 'AC-1', questionId: 'q-fb-1', by: 'acme-dev' }] });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'passed-before', accepted: { question_id: 'q-fb-1', by: 'acme-dev' } } });
    expect(e.report.unverified).toEqual(['fail-before: AC-1 accepted without fail-before by acme-dev (question q-fb-1): unit passed on the base revision with the new tests']);
  });

  it('a criterion whose check failed on the base revision does not rest on new tests', () => {
    const e = judge('required', { probe: null, skipped: null, accepted: [] }, { base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'FAILED' }], changedPaths: ['apps/calc.mjs', 'tests/mul.test.mjs'] } });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'not-applicable', reason: 'its support does not rest on new tests: unit failed on the base revision' } });
  });

  it('a candidate that is not otherwise acceptable was not probed, and that changes nothing: its verdict is not PASS already', () => {
    const snapshot = withMode('required');
    const lintToo = contract({ acceptance_criteria: oneCriterion.acceptance_criteria, required_check_ids: ['unit', 'lint'] });
    const e = evaluateEvidence({ contract: lintToo, candidate: CANDIDATE, checkResults: [result(snapshot, 'unit'), result(snapshot, 'lint', 'FAILED')], scope: CLEAN_SCOPE, snapshot, base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }, { checkId: 'lint', status: 'PASSED' }], changedPaths: ['tests/mul.test.mjs'] }, failBefore: { mode: 'required', probe: null, skipped: { cause: 'not-acceptable', reason: 'the probe did not run: the candidate is not otherwise acceptable' }, accepted: [] } });
    expect(e.report.verdict).toBe('FAIL');
    expect(e.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'not-established', cause: 'not-acceptable' } });
    expect(e.report.unverified.some((u) => u.startsWith('fail-before'))).toBe(false);
  });

  it('a criterion supported only through a check the probe does not run is not established', () => {
    const lintOnly = contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'style', proof: ['lint'], mandatory: true, check_ids: ['lint'] }], required_check_ids: ['lint'] });
    const snapshot = withMode('required');
    const e = evaluateEvidence({ contract: lintOnly, candidate: CANDIDATE, checkResults: [result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot, base: { treeHash: 'tree-base', checks: [{ checkId: 'lint', status: 'PASSED' }], changedPaths: ['tests/mul.test.mjs'] }, failBefore: { mode: 'required', probe: null, skipped: null, accepted: [] } });
    expect(e.report.acceptance_evidence[0]).toMatchObject({ status: 'blocked', fail_before: { outcome: 'not-established', cause: 'not-probed' } });
  });

  it('without the fail-before input (a caller with no probe) the report has no fail_before entries', () => {
    const e = judge('required', null);
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence[0]!.fail_before).toBeUndefined();
  });
});
