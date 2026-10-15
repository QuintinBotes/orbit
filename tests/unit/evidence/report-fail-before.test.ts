// Fail-before in the evidence report (ADR 0014 sections 4 and 5). Test evidence is per check in every mode: a criterion
// is supported through new tests only by a check it cites whose run includes a test change (the change lies under the
// check's directory). Each criterion gains a `fail_before` entry. advisory reports only; required decides: failed-before
// supports, passed-before leaves the criterion unverified with the note naming the base and the log, and not established
// blocks it, unless a person accepted the criterion without fail-before for this tree.
import { describe, expect, it } from 'vitest';
import { contractAssumptionsHash, evaluateEvidence, type BuildReportInput } from '../../../src/evidence/report.ts';
import { otherwiseAcceptable, type CheckProbe, type FailBeforeEvidence, type ProbeResult } from '../../../src/evidence/fail-before.ts';
import { statesCheckRunsTests, statesFailBefore, unknownNamedChecks } from '../../../src/evidence/fail-before-statements.ts';
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

// ADR 0016, item 1: wording only selects the statements the probe decides, and can only make Orbit stricter.
describe('fail-before statement wording', () => {
  it('statesFailBefore matches tests failing on the base revision and not near misses', () => {
    for (const statement of [
      'The new tests import round_price and so fail on the base revision',
      'The new tests fail on the base revision (ImportError for round_price)',
      'Its tests fail against the base revision',
      "The change's tests are failing before the change",
      'The new test fails before the fix',
      'Without the change, the new tests fail',
      'On the base revision, the new tests fail',
      'The new tests on the base revision fail',
      'Prices round up. The new tests fail on the base revision.',
    ]) {
      expect(statesFailBefore(statement), statement).toBe(true);
    }
    for (const statement of [
      'the function raises ValueError',
      'tests pass',
      'The tests pass on the base revision',
      'The tests fail on invalid input',
      'The function fails on the base revision',
      'The tests fail. The base revision is unchanged.',
      'The new tests fail to import on Tuesdays',
      'round_price fails before the change and tests cover it',
      'The tests pass before the change and fail afterwards',
      'The new tests pass on the base revision and fail after the change',
      'The new tests on the base revision pass and fail on other input',
      'The new tests do not fail on the base revision',
      'The new tests never fail on the base revision',
      'The new tests on the base revision are not failing',
      "The new tests on the base revision aren't failing",
      'The new tests were not failing before the change',
    ]) {
      expect(statesFailBefore(statement), statement).toBe(false);
    }
  });

  it('statesCheckRunsTests returns the named whole-word check ids, or null for other assumptions', () => {
    const ids = ['unit-tests', 'lint'];
    expect(statesCheckRunsTests('The unit-tests check runs pytest over tests/ with src on the path', ids)).toEqual(['unit-tests']);
    // The third 0.3.1 retest's audit: the passive form slipped past the rule ("The pytest suite is run by the unit-tests
    // check with src on the path" stayed unverified with no probe-derived reason).
    expect(statesCheckRunsTests('The pytest suite is run by the unit-tests check with src on the path', ids)).toEqual(['unit-tests']);
    expect(statesCheckRunsTests('The new tests are run by the unit-tests check', ids)).toEqual(['unit-tests']);
    expect(statesCheckRunsTests('The new tests are collected by the test runner', ids)).toEqual([]);
    // A negated passive, and tests run by something that is no check, are not this statement.
    expect(statesCheckRunsTests('The new tests are not run by the lint check', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests are run by CI every night', ids)).toBeNull();
    // A review of the passive form: a negation before a compound auxiliary, and a check in a later clause, are not it.
    expect(statesCheckRunsTests('The new tests will not be run by the lint check', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests have not been collected by the lint check', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests cannot be executed by the lint check', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests are run by CI after the lint check passes', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests are run by CI, and the lint check runs eslint', ids)).toBeNull();
    // Two agents joined in one clause: the check is one of the agents.
    expect(statesCheckRunsTests('The new tests are run by CI and the unit-tests check', ids)).toEqual(['unit-tests']);
    expect(statesCheckRunsTests('The new tests are run by the unit-tests check or the test runner', ids)).toEqual(['unit-tests']);
    // A check after "and" with a verb of its own starts a new clause, comma or not.
    expect(statesCheckRunsTests('The new tests are run by CI and the lint check runs eslint', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests are run by CI and the lint check passes', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests are run by CI and the unit-tests check with coverage', ids)).toEqual(['unit-tests']);
    // Only nothing, or a preposition, may follow a joined agent's name; any verb, with or without an adverb, starts a clause.
    expect(statesCheckRunsTests('The new tests are run by CI and the lint check only runs eslint', ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests are run by CI and the lint check validates formatting', ids)).toBeNull();
    // Contracted negations, straight or curly.
    expect(statesCheckRunsTests("The new tests couldn't be run by the lint check", ids)).toBeNull();
    expect(statesCheckRunsTests('The new tests wouldn’t be run by the lint check', ids)).toBeNull();
    expect(statesCheckRunsTests('The unit-tests check discovers tests/test_pricing.py and can import shop from src', ids)).toEqual(['unit-tests']);
    expect(statesCheckRunsTests('The check runs the new tests', ids)).toEqual([]);
    expect(statesCheckRunsTests('The test runner collects the new tests', ids)).toEqual([]);
    expect(statesCheckRunsTests('The test command executes tests/test_pricing.py', ids)).toEqual([]);
    expect(statesCheckRunsTests('The unit-tests check and the lint check run the new tests', ids)).toEqual(['unit-tests', 'lint']);
    // A longer id that only contains a configured one does not name it, although the check still selects the assumption.
    expect(statesCheckRunsTests('The unit-tests-extra check runs the new tests', ids)).toEqual([]);
    // A check named as such that is not configured is an unknown named check, not no check at all.
    expect(statesCheckRunsTests('The integration check runs the new tests', ids)).toEqual([]);
    expect(unknownNamedChecks('The integration check runs the new tests', ids)).toEqual(['integration']);
    expect(unknownNamedChecks('The unit-tests-extra check runs the new tests', ids)).toEqual(['unit-tests-extra']);
    expect(unknownNamedChecks('The check named integration runs the new tests', ids)).toEqual(['integration']);
    // Quoted names and the whole check id grammar (dots included).
    expect(unknownNamedChecks('The `integration` check runs the new tests', ids)).toEqual(['integration']);
    expect(unknownNamedChecks('The "integration" check runs the new tests', ids)).toEqual(['integration']);
    expect(unknownNamedChecks('The unit.api check runs the new tests', [...ids, 'unit.api'])).toEqual([]);
    expect(unknownNamedChecks('The unit.web check runs the new tests', [...ids, 'unit.api'])).toEqual(['unit.web']);
    expect(statesCheckRunsTests('The unit.api check runs the new tests', [...ids, 'unit.api'])).toEqual(['unit.api']);
    // A check described in general is no check's name: no unknown check, so the fallback to every probed check applies.
    expect(unknownNamedChecks('The required test check runs the new tests', ids)).toEqual([]);
    expect(unknownNamedChecks('The configured mandatory check runs the new tests', ids)).toEqual([]);
    expect(unknownNamedChecks('The check runs the new tests', ids)).toEqual([]);
    expect(unknownNamedChecks('The unit-tests check runs pytest over tests/ with src on the path', ids)).toEqual([]);
    expect(unknownNamedChecks('The test runner collects the new tests', ids)).toEqual([]);
    for (const statement of [
      'Prices are in euros',
      'The unit-tests check passes',
      'The application runs the new tests',
      'The test runner is fast',
      'Tests run quickly',
      'The unit-tests check can import shop from src',
      'The check runs in euros',
      'The lint check does not run tests',
      "The lint check doesn't run the new tests",
      'The check never runs the new tests',
    ]) {
      expect(statesCheckRunsTests(statement, ids), statement).toBeNull();
    }
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

  // ADR 0016, item 1: a flagged criterion's passing candidate log never supports it; the probe alone does.
  const flaggedCriterion = contract({
    acceptance_criteria: [{ id: 'AC-1', statement: 'The new tests import mul and so fail on the base revision', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] }],
    required_check_ids: ['unit'],
  });
  const flaggedNote = /^it states that its tests fail on the base revision, which only the fail-before probe establishes: /;
  const baseFlipped: Partial<BuildReportInput> = { base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'FAILED' }], changedPaths: ['apps/calc.mjs', 'tests/mul.test.mjs'] } };

  it('a criterion that states fail-before is supported only by failed-before, and is a residual risk under advisory or off', () => {
    const supported = judge('advisory', { probe: probe({}), skipped: null, accepted: [] }, { contract: flaggedCriterion });
    expect(supported.report.acceptance_evidence[0]!.status).toBe('supported');
    expect(supported.report.verdict).toBe('PASS');

    for (const [name, fb] of [
      ['passed-before', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] }],
      ['not-established', { probe: probe(TIMED_OUT), skipped: null, accepted: [] }],
      ['no probe result', { probe: null, skipped: null, accepted: [] }],
    ] as const) {
      const e = judge('advisory', fb, { contract: flaggedCriterion });
      const entry = e.report.acceptance_evidence[0]!;
      expect(entry.status, name).toBe('unverified');
      expect(entry.note, name).toMatch(flaggedNote);
      expect(e.report.verdict, name).toBe('PASS');
      expect(e.incompleteReasons, name).toEqual([]);
      expect(e.report.unverified, name).toContain(`criterion AC-1: unverified (${entry.note})`);
    }

    // not-applicable: its check failed on the base revision, so the entry says its support does not rest on new tests.
    const notApplicable = judge('advisory', { probe: null, skipped: null, accepted: [] }, { contract: flaggedCriterion, ...baseFlipped });
    expect(notApplicable.report.acceptance_evidence[0]).toMatchObject({ status: 'unverified', fail_before: { outcome: 'not-applicable' } });
    expect(notApplicable.report.acceptance_evidence[0]!.note).toBe('it states that its tests fail on the base revision, which only the fail-before probe establishes: its support does not rest on new tests: unit failed on the base revision');
    expect(notApplicable.report.verdict).toBe('PASS');

    // not-run under off, and no entry at all when no fail-before input was given.
    const off = judge('off', { probe: null, skipped: null, accepted: [] }, { contract: flaggedCriterion });
    expect(off.report.acceptance_evidence[0]).toMatchObject({ status: 'unverified', fail_before: { outcome: 'not-run' } });
    expect(off.report.verdict).toBe('PASS');
    expect(off.incompleteReasons).toEqual([]);
    const noEntry = judge('advisory', null, { contract: flaggedCriterion });
    expect(noEntry.report.acceptance_evidence[0]!.fail_before).toBeUndefined();
    expect(noEntry.report.acceptance_evidence[0]).toMatchObject({ status: 'unverified', note: 'it states that its tests fail on the base revision, which only the fail-before probe establishes: no probe ran for it' });
    expect(noEntry.report.verdict).toBe('PASS');
  });

  it('under required a flagged criterion blocks the PASS unless failed-before or a person accepted it', () => {
    expect(judge('required', { probe: probe({}), skipped: null, accepted: [] }, { contract: flaggedCriterion }).report).toMatchObject({ verdict: 'PASS' });
    const accepted = judge('required', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [{ criterionId: 'AC-1', questionId: 'q-fb-1', by: 'acme-dev' }] }, { contract: flaggedCriterion });
    expect(accepted.report.acceptance_evidence[0]!.status).toBe('supported');
    expect(accepted.report.verdict).toBe('PASS');

    const notApplicable = judge('required', { probe: null, skipped: null, accepted: [] }, { contract: flaggedCriterion, ...baseFlipped });
    const entry = notApplicable.report.acceptance_evidence[0]!;
    expect(entry).toMatchObject({ status: 'unverified', fail_before: { outcome: 'not-applicable' } });
    expect(entry.note).toMatch(flaggedNote);
    expect(notApplicable.report.verdict).toBe('INCOMPLETE');
    expect(notApplicable.incompleteReasons).toContain(`criterion AC-1: unverified (${entry.note})`);

    const noEntry = judge('required', null, { contract: flaggedCriterion });
    expect(noEntry.report.acceptance_evidence[0]).toMatchObject({ status: 'unverified', note: 'it states that its tests fail on the base revision, which only the fail-before probe establishes: no probe ran for it' });
    expect(noEntry.report.verdict).toBe('INCOMPLETE');

    // A status judgeFailBefore already left unverified stands with its own note, and still blocks.
    const passed = judge('required', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] }, { contract: flaggedCriterion });
    expect(passed.report.acceptance_evidence[0]!.status).toBe('unverified');
    expect(passed.report.acceptance_evidence[0]!.note).toMatch(/^the new tests pass on the base revision: /);
    expect(passed.report.verdict).toBe('INCOMPLETE');
  });

  it('a criterion that does not state fail-before keeps the status its checks give it', () => {
    // The same evidence that leaves a flagged criterion unverified (a base flip, no probe entry) supports an unflagged one.
    const unflagged = judge('required', { probe: null, skipped: null, accepted: [] }, baseFlipped);
    expect(unflagged.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'not-applicable' } });
    expect(unflagged.report.verdict).toBe('PASS');
    const flagged = judge('required', { probe: null, skipped: null, accepted: [] }, { contract: flaggedCriterion, ...baseFlipped });
    expect(flagged.report.acceptance_evidence[0]!.status).toBe('unverified');
    const advisoryPassed = judge('advisory', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] });
    expect(advisoryPassed.report.acceptance_evidence[0]!.status).toBe('supported');
    expect(advisoryPassed.report.verdict).toBe('PASS');
  });

  // An assumption that a check runs the new tests takes its status from the probe too. An assumption about behaviour
  // (AS-2 here) is never evaluated, so only the flagged one reaches the report's assumptions.
  const withAssumptions = (...assumptions: { id: string; statement: string; status: 'unverified' }[]) =>
    contract({ acceptance_criteria: oneCriterion.acceptance_criteria, required_check_ids: ['unit'], assumptions });
  const FLAGGED_ASSUMPTION = { id: 'AS-1', statement: 'The unit check runs pytest over tests/ with src on the path', status: 'unverified' as const };
  const BEHAVIOUR_ASSUMPTION = { id: 'AS-2', statement: 'Prices are in euros', status: 'unverified' as const };

  it('a flagged assumption is supported only when its named check failed before', () => {
    const inputs = withAssumptions(FLAGGED_ASSUMPTION, BEHAVIOUR_ASSUMPTION);
    const supported = judge('advisory', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(supported.report.assumptions).toEqual([
      { assumption_id: 'AS-1', statement: FLAGGED_ASSUMPTION.statement, status: 'supported', reason: 'unit: failed-before (unit failed on the base revision with the new tests (exit 1, 2 attempts))', checks: ['unit'] },
    ]);
    expect(supported.report.verdict).toBe('PASS');

    const passed = judge('advisory', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] }, { contract: inputs });
    expect(passed.report.assumptions).toEqual([
      { assumption_id: 'AS-1', statement: FLAGGED_ASSUMPTION.statement, status: 'unverified', reason: 'unit: passed-before (unit passed on the base revision with the new tests)', checks: ['unit'] },
    ]);
    expect(passed.report.verdict).toBe('PASS');
    expect(passed.incompleteReasons).toEqual([]);
    expect(passed.report.unverified).toContain('assumption AS-1: unverified (unit: passed-before (unit passed on the base revision with the new tests))');

    const timedOut = judge('advisory', { probe: probe(TIMED_OUT), skipped: null, accepted: [] }, { contract: inputs });
    expect(timedOut.report.assumptions).toEqual([
      { assumption_id: 'AS-1', statement: FLAGGED_ASSUMPTION.statement, status: 'unverified', reason: 'unit: not-established (unit timed out on the probe tree)', checks: ['unit'] },
    ]);

    const noProbe = judge('advisory', { probe: null, skipped: null, accepted: [] }, { contract: inputs });
    expect(noProbe.report.assumptions).toEqual([{ assumption_id: 'AS-1', statement: FLAGGED_ASSUMPTION.statement, status: 'unverified', reason: 'no probe ran for unit', checks: ['unit'] }]);
    const noInput = judge('advisory', null, { contract: inputs });
    expect(noInput.report.assumptions).toEqual([{ assumption_id: 'AS-1', statement: FLAGGED_ASSUMPTION.statement, status: 'unverified', reason: 'no probe ran for unit', checks: ['unit'] }]);
    expect(noInput.report.verdict).toBe('PASS');
  });

  it('a passive assumption that a check runs the new tests is decided by the probe as an active one is', () => {
    const passive = { id: 'AS-1', statement: 'The pytest suite is run by the unit check with src on the path', status: 'unverified' as const };
    const inputs = withAssumptions(passive);
    const supported = judge('advisory', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(supported.report.assumptions).toEqual([expect.objectContaining({ assumption_id: 'AS-1', status: 'supported', checks: ['unit'] })]);
    const passed = judge('advisory', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] }, { contract: inputs });
    expect(passed.report.assumptions).toEqual([expect.objectContaining({ assumption_id: 'AS-1', status: 'unverified' })]);
    expect(passed.report.verdict).toBe('PASS');
    expect(passed.report.unverified).toContain('assumption AS-1: unverified (unit: passed-before (unit passed on the base revision with the new tests))');
    const required = judge('required', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] }, { contract: inputs });
    expect(required.report.verdict).not.toBe('PASS');
  });

  it('an ordinary assumption that only mentions a check is not flagged, so a required run with passing evidence stays PASS', () => {
    for (const statement of ['The new tests will not be run by the lint check', 'The new tests are run by CI after the lint check passes']) {
      const inputs = withAssumptions({ id: 'AS-1', statement, status: 'unverified' as const });
      const e = judge('required', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
      expect(e.report.assumptions, statement).toBeUndefined();
      expect(e.report.verdict, statement).toBe('PASS');
    }
  });

  it('a flagged assumption that names no check uses every check the probe ran', () => {
    const inputs = withAssumptions({ id: 'AS-1', statement: 'The check runs the new tests', status: 'unverified' });
    const lintPassed: CheckProbe = { checkId: 'lint', outcome: 'passed-before', reason: 'lint passed on the base revision with the new tests', attempts: [{ attempt: 1, status: 'PASSED', exitCode: 0, signals: [], log: 'evidence/1/fail-before/lint.log' }] };
    const twoChecks: ProbeResult = { ...probe({}), checks: [...probe({}).checks, lintPassed] };
    const mixed = judge('advisory', { probe: twoChecks, skipped: null, accepted: [] }, { contract: inputs });
    expect(mixed.report.assumptions).toEqual([
      {
        assumption_id: 'AS-1',
        statement: 'The check runs the new tests',
        status: 'unverified',
        reason: 'unit: failed-before (unit failed on the base revision with the new tests (exit 1, 2 attempts)); lint: passed-before (lint passed on the base revision with the new tests)',
        checks: ['unit', 'lint'],
      },
    ]);

    const lintFailed: CheckProbe = { ...lintPassed, outcome: 'failed-before', reason: 'lint failed on the base revision with the new tests (exit 1, 2 attempts)', attempts: [{ attempt: 1, status: 'FAILED', exitCode: 1, signals: [], log: 'evidence/1/fail-before/lint.log' }] };
    const both = judge('advisory', { probe: { ...twoChecks, checks: [...probe({}).checks, lintFailed] }, skipped: null, accepted: [] }, { contract: inputs });
    expect(both.report.assumptions![0]).toMatchObject({ status: 'supported', checks: ['unit', 'lint'] });

    const none = judge('advisory', { probe: null, skipped: null, accepted: [] }, { contract: inputs });
    expect(none.report.assumptions).toEqual([{ assumption_id: 'AS-1', statement: 'The check runs the new tests', status: 'unverified', reason: 'no probe ran', checks: [] }]);
  });

  it('under required an unverified flagged assumption blocks the PASS; under advisory it does not', () => {
    // The criterion is supported by unit failed-before, so only the assumption (which names lint, a check the probe
    // never ran) can keep the verdict from PASS.
    const inputs = withAssumptions({ id: 'AS-1', statement: 'The lint check discovers tests/mul.test.mjs', status: 'unverified' });
    const required = judge('required', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(required.report.acceptance_evidence[0]!.status).toBe('supported');
    expect(required.report.assumptions).toEqual([{ assumption_id: 'AS-1', statement: 'The lint check discovers tests/mul.test.mjs', status: 'unverified', reason: 'lint: no probe result', checks: ['lint'] }]);
    expect(required.report.verdict).toBe('INCOMPLETE');
    expect(required.incompleteReasons).toEqual(['assumption AS-1: unverified (lint: no probe result)']);

    const advisory = judge('advisory', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(advisory.report.verdict).toBe('PASS');
    expect(advisory.incompleteReasons).toEqual([]);
    expect(advisory.report.unverified).toContain('assumption AS-1: unverified (lint: no probe result)');

    const off = judge('off', { probe: null, skipped: null, accepted: [] }, { contract: inputs });
    expect(off.report.assumptions).toEqual([{ assumption_id: 'AS-1', statement: 'The lint check discovers tests/mul.test.mjs', status: 'unverified', reason: 'no probe ran for lint', checks: ['lint'] }]);
    expect(off.report.verdict).toBe('PASS');
  });

  it('an assumption naming a check that is not configured is unverified and no other probe supports it', () => {
    const inputs = withAssumptions({ id: 'AS-1', statement: 'The integration check runs the new tests', status: 'unverified' });
    // The unit probe failed before, which would support a statement naming no check: it must not stand in here.
    const advisory = judge('advisory', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(advisory.report.assumptions).toEqual([
      { assumption_id: 'AS-1', statement: 'The integration check runs the new tests', status: 'unverified', reason: 'integration: not a configured check', checks: ['integration'] },
    ]);
    const required = judge('required', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(required.report.acceptance_evidence[0]!.status).toBe('supported');
    expect(required.report.assumptions![0]).toMatchObject({ status: 'unverified', reason: 'integration: not a configured check' });
    expect(required.report.verdict).toBe('INCOMPLETE');
    expect(required.incompleteReasons).toContain('assumption AS-1: unverified (integration: not a configured check)');
  });

  it('a negated assumption is not flagged, so a required report with the other evidence passing stays PASS', () => {
    const inputs = withAssumptions({ id: 'AS-1', statement: 'The lint check does not run tests', status: 'unverified' });
    const e = judge('required', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(e.report.assumptions).toBeUndefined();
    expect(e.report.assumptions_hash).toBeUndefined();
    expect(e.report.verdict).toBe('PASS');
    // The same for a criterion: a negated fail-before statement keeps the status its checks give it.
    const negated = contract({
      acceptance_criteria: [{ id: 'AC-1', statement: 'The new tests do not fail on the base revision', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] }],
      required_check_ids: ['unit'],
    });
    const c = judge('required', { probe: null, skipped: null, accepted: [] }, { contract: negated, ...baseFlipped });
    expect(c.report.acceptance_evidence[0]).toMatchObject({ status: 'supported', fail_before: { outcome: 'not-applicable' } });
    expect(c.report.verdict).toBe('PASS');
    // A plural negation in the tests-locus-fail order too.
    const plural = contract({
      acceptance_criteria: [{ id: 'AC-1', statement: 'The new tests on the base revision are not failing', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] }],
      required_check_ids: ['unit'],
    });
    expect(judge('required', { probe: null, skipped: null, accepted: [] }, { contract: plural, ...baseFlipped }).report.verdict).toBe('PASS');
  });

  it('a criterion in tests-locus-fail order is flagged and unverified with a passed-before probe', () => {
    const inOrder = contract({
      acceptance_criteria: [{ id: 'AC-1', statement: 'The new tests on the base revision fail', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] }],
      required_check_ids: ['unit'],
    });
    const e = judge('advisory', { probe: probe(PASSED_BEFORE), skipped: null, accepted: [] }, { contract: inOrder });
    const entry = e.report.acceptance_evidence[0]!;
    expect(entry.status).toBe('unverified');
    expect(entry.note).toMatch(flaggedNote);
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.unverified).toContain(`criterion AC-1: unverified (${entry.note})`);
  });

  it('a report that evaluated an assumption records its statement and a hash of the contract assumptions', () => {
    const inputs = withAssumptions(FLAGGED_ASSUMPTION, BEHAVIOUR_ASSUMPTION);
    const e = judge('advisory', { probe: probe({}), skipped: null, accepted: [] }, { contract: inputs });
    expect(e.report.assumptions![0]!.statement).toBe(FLAGGED_ASSUMPTION.statement);
    expect(e.report.assumptions_hash).toBe(contractAssumptionsHash(inputs.assumptions));
    expect(e.report.assumptions_hash).not.toBe(contractAssumptionsHash(inputs.assumptions.map((a) => (a.id === 'AS-1' ? { ...a, statement: 'The lint check runs the new tests' } : a))));
    // A report that evaluated nothing records neither field.
    const none = judge('advisory', { probe: probe({}), skipped: null, accepted: [] }, { contract: withAssumptions(BEHAVIOUR_ASSUMPTION) });
    expect(none.report.assumptions).toBeUndefined();
    expect(none.report.assumptions_hash).toBeUndefined();
  });
});

// Adversarial review of the branch (finding 1): a required check whose failure the contract excepts made the candidate
// "not otherwise acceptable", so the probe was skipped, the criterion stayed supported, and the report, which accepts the
// excepted failure, said PASS under required with no probe at all.
describe('review finding 1: a baseline exception does not let a required run pass unprobed', () => {
  const snapshot = fakeSnapshot([checkDef('unit'), checkDef('legacy')], (c) => (c.verification.fail_before = 'required'));
  const excepted = contract({
    acceptance_criteria: [{ id: 'AC-1', statement: 'mul multiplies', proof: ['tests/mul.test.mjs'], mandatory: true, check_ids: ['unit'] }],
    required_check_ids: ['unit', 'legacy'],
    baseline_exceptions: [{ check_id: 'legacy', fingerprint: 'fp:legacy', reason: 'legacy fails on the base revision too' }],
  });
  const results = [result(snapshot, 'unit'), result(snapshot, 'legacy', 'FAILED')];

  it('a required check failing exactly as its baseline exception records keeps the candidate otherwise acceptable', () => {
    expect(otherwiseAcceptable(results, ['unit', 'legacy'], false, new Map([['legacy', 'fp:legacy']]))).toBe(true);
    expect(otherwiseAcceptable(results, ['unit', 'legacy'], false, new Map([['legacy', 'fp:other']]))).toBe(false);
    expect(otherwiseAcceptable(results, ['unit', 'legacy'], false, new Map())).toBe(false);
  });

  it('under required, a criterion resting on new tests that were not probed never lets the verdict be PASS', () => {
    const e = evaluateEvidence({
      contract: excepted,
      candidate: CANDIDATE,
      checkResults: results,
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }, { checkId: 'legacy', status: 'FAILED' }], changedPaths: ['apps/calc.mjs', 'tests/mul.test.mjs'] },
      failBefore: { mode: 'required', probe: null, skipped: { cause: 'not-acceptable', reason: 'the probe did not run: the candidate is not otherwise acceptable (a required check or the dependency install did not pass)' }, accepted: [] },
    });
    expect(e.report.verdict).not.toBe('PASS');
    expect(e.incompleteReasons.join('\n')).toMatch(/criterion AC-1: fail-before was not established: the probe did not run/);
  });
});

// Adversarial review (finding 2): a criterion took the cause of its first unresolved check only, so a timeout on one
// check hid an environment signal or an ERROR on another, a person was offered an acceptance the ADR forbids, and the
// order of check_ids changed the outcome.
describe('review finding 2: every unresolved check\'s cause counts, in any order', () => {
  const snapshot = fakeSnapshot([checkDef('a'), checkDef('b')], (c) => (c.verification.fail_before = 'required'));
  const both = (ids: string[]) => contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'mul multiplies', proof: ['tests'], mandatory: true, check_ids: ids }], required_check_ids: ['a', 'b'] });
  const probe = (checks: CheckProbe[]): ProbeResult => ({ probeId: 'probe-1', probeTree: 'tree-probe', baseRevision: BASE_REV, testPaths: ['tests/mul.test.mjs'], reused: false, checks });
  const timedOut: CheckProbe = { checkId: 'a', outcome: 'not-established', cause: 'timeout', reason: 'a timed out on the probe tree', attempts: [{ attempt: 1, status: 'TIMEOUT', exitCode: null, signals: [], log: 'evidence/1/fail-before/a.log' }] };
  const denied: CheckProbe = { checkId: 'b', outcome: 'not-established', cause: 'environment', reason: 'b could not run on the probe tree: its output shows an environment cause (socket-denied), not a test result', attempts: [{ attempt: 1, status: 'FAILED', exitCode: 1, signals: ['socket-denied'], log: 'evidence/1/fail-before/b.log' }] };
  const judge = (ids: string[], accepted: FailBeforeEvidence['accepted'] = []) =>
    evaluateEvidence({
      contract: both(ids),
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'a'), result(snapshot, 'b')],
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'a', status: 'PASSED' }, { checkId: 'b', status: 'PASSED' }], changedPaths: ['tests/mul.test.mjs'] },
      failBefore: { mode: 'required', probe: probe([timedOut, denied]), skipped: null, accepted },
    }).report.acceptance_evidence[0]!;

  it('takes the cause a person may never accept, whichever check comes first', () => {
    for (const ids of [['a', 'b'], ['b', 'a']]) {
      const e = judge(ids);
      expect(e.status, ids.join(',')).toBe('blocked');
      expect(e.fail_before, ids.join(',')).toMatchObject({ outcome: 'not-established', cause: 'environment' });
      expect(e.fail_before!.reason, ids.join(',')).toBe('a timed out on the probe tree; b could not run on the probe tree: its output shows an environment cause (socket-denied), not a test result');
    }
  });

  it('rejects a recorded acceptance while the probe shows a cause that is never accepted', () => {
    const e = judge(['a', 'b'], [{ criterionId: 'AC-1', questionId: 'q-fb-1', by: 'acme-dev' }]);
    expect(e.status).toBe('blocked');
    expect(e.fail_before!.accepted).toBeUndefined();
  });
});
