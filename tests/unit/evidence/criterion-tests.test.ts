// Issue #200, FR-003 and FR-004: under `required`, each criterion is judged by its own mapped tests, each run alone by
// its check's tests_command on the base tree with the new tests and on the candidate. These are the rules that turn
// those runs into the criterion's fail-before entry, and how the evidence report reads it.
import { describe, expect, it } from 'vitest';
import { criterionProofEntry, criterionTestDefinition, criterionTests, unitIdFor, type CriterionProbes, type CriterionTests } from '../../../src/evidence/criterion-tests.ts';
import type { CheckProbe } from '../../../src/evidence/fail-before.ts';
import { evaluateEvidence } from '../../../src/evidence/report.ts';
import type { CriterionFailBefore } from '../../../src/evidence/types.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result } from './report-fixtures.ts';
import { checkDef } from './fixtures.ts';

const unit = checkDef('unit', { cwd: 'app', tests_command: ['node', '--test'] });
const snapshot = fakeSnapshot([unit, checkDef('lint', { category: 'lint' })]);
const owned = (p: string) => /\.test\.ts$/.test(p);

describe('criterionTests: each mapped test and the command that runs it alone (FR-004)', () => {
  it('maps a test to the cited test check whose tests_command can run it, with the path relative to its directory', () => {
    const [c] = criterionTests(contract({ acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: ['p'], mandatory: true, check_ids: ['lint', 'unit'], tests: ['app/tests/queue.test.ts'] }] }), snapshot, owned);
    expect(c).toEqual({ criterionId: 'AC-1', kind: 'change', tests: [{ path: 'app/tests/queue.test.ts', checkId: 'unit', unitId: unitIdFor('unit', 'app/tests/queue.test.ts'), problem: null }] });
    const def = criterionTestDefinition(unit, c!.tests[0]!.unitId!, 'app/tests/queue.test.ts');
    expect(def).toMatchObject({ id: c!.tests[0]!.unitId, command: ['node', '--test', 'tests/queue.test.ts'], cwd: 'app', shell: false });
  });

  it('says why a test cannot run alone: no tests_command, not a test file, outside the check, not a repository path', () => {
    const plain = fakeSnapshot([checkDef('unit', { cwd: 'app' })]);
    const tests = (s: typeof snapshot, paths: string[]) => criterionTests(contract({ acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: paths }] }), s, owned)[0]!.tests.map((t) => t.problem);
    expect(tests(plain, ['app/tests/a.test.ts'])).toEqual(['no check AC-1 cites has a tests_command that runs app/tests/a.test.ts alone']);
    expect(tests(snapshot, ['app/src/queue.ts', 'other/b.test.ts', '../x.test.ts', '-r.test.ts'])).toEqual([
      'app/src/queue.ts is not a test file, so it cannot prove AC-1 on its own',
      'no check AC-1 cites has a tests_command that runs other/b.test.ts alone',
      '../x.test.ts is not a repository-relative path',
      '-r.test.ts is not a repository-relative path',
    ]);
  });

  it('never hands a check a path that reads as an option once it is made relative to the check\'s directory', () => {
    const [c] = criterionTests(contract({ acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: ['app/--passWithNoTests.test.ts'] }] }), snapshot, owned);
    expect(c!.tests).toEqual([{ path: 'app/--passWithNoTests.test.ts', checkId: null, unitId: null, problem: 'app/--passWithNoTests.test.ts is "--passWithNoTests.test.ts" in check unit\'s directory, which its tests_command would read as an option' }]);
  });

  it('gives a person-checked criterion no test to run', () => {
    expect(criterionTests(contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'A person merges it', proof: ['p'], mandatory: true, kind: 'person', tests: ['app/tests/a.test.ts'] }] }), snapshot, owned)[0]).toEqual({ criterionId: 'AC-1', kind: 'person', tests: [] });
  });
});

function probe(id: string, outcome: CheckProbe['outcome'], cause?: CheckProbe['cause']): CheckProbe {
  return { checkId: id, outcome, ...(cause ? { cause } : {}), reason: `${id} ${outcome}`, attempts: [{ attempt: 1, status: outcome === 'passed-before' ? 'PASSED' : 'FAILED', exitCode: outcome === 'passed-before' ? 0 : 1, signals: [], log: `evidence/1/criterion-probe/${id}.log` }] };
}
const T1 = 'app/tests/a.test.ts';
const T2 = 'app/tests/b.test.ts';
const U1 = unitIdFor('unit', T1);
const U2 = unitIdFor('unit', T2);
const tests = (kind: CriterionTests['kind'], paths = [T1, T2]): CriterionTests => ({ criterionId: 'AC-1', kind, tests: paths.map((path) => ({ path, checkId: 'unit', unitId: unitIdFor('unit', path), problem: null })) });
function probes(base: [string, CheckProbe['outcome'], CheckProbe['cause']?][], candidate: [string, CheckProbe['outcome']][]): CriterionProbes {
  return { mode: 'required', base: { tree: 'tree-p', checks: new Map(base.map(([id, o, c]) => [id, probe(id, o, c)])) }, candidate: new Map(candidate.map(([id, o]) => [id, probe(id, o)])), skipped: null, accepted: [] };
}

describe('criterionProofEntry: a criterion\'s own fail-before (FR-003)', () => {
  it('is failed-before only when every mapped test fails on the base tree and passes on the candidate, and lists each', () => {
    const e = criterionProofEntry(tests('change'), probes([[U1, 'failed-before'], [U2, 'failed-before']], [[U1, 'passed-before'], [U2, 'passed-before']]));
    expect(e.outcome).toBe('failed-before');
    expect(e.tests?.map((t) => [t.path, t.base, t.candidate])).toEqual([[T1, 'failed', 'passed'], [T2, 'failed', 'passed']]);
    expect(e.checks.map((c) => c.id)).toEqual([`unit:${T1}`, `unit:${T2}`]);
  });

  it('edge case: with several tests mapped, one that passes on the base tree leaves the criterion not shown, whatever the others did', () => {
    const e = criterionProofEntry(tests('change'), probes([[U1, 'failed-before'], [U2, 'passed-before']], [[U1, 'passed-before'], [U2, 'passed-before']]));
    expect(e.outcome).toBe('passed-before');
    expect(e.reason).toBe(`the mapped tests do not show AC-1: ${T2} passes on the base revision with the new tests, so it does not show the change`);
  });

  it('a mapped test that fails on the candidate when it runs alone does not show the criterion either', () => {
    const e = criterionProofEntry(tests('change', [T1]), probes([[U1, 'failed-before']], [[U1, 'failed-before']]));
    expect(e).toMatchObject({ outcome: 'passed-before', reason: `the mapped tests do not show AC-1: ${T1} fails on the candidate when it runs alone` });
  });

  it('edge case: a test that fails on the base tree only because it cannot load still counts as failing before (ADR 0014)', () => {
    // The probe judges by exit status alone: a load failure is a failing exit, so the run's outcome is failed-before.
    expect(criterionProofEntry(tests('change', [T1]), probes([[U1, 'failed-before']], [[U1, 'passed-before']])).outcome).toBe('failed-before');
  });

  it('is not established when a run was not, with its cause, and only an acceptable cause carries a person\'s acceptance', () => {
    const e = criterionProofEntry(tests('change', [T1]), { ...probes([[U1, 'not-established', 'environment']], [[U1, 'passed-before']]), accepted: [{ criterionId: 'AC-1', questionId: 'q', by: 'person:ana' }] });
    expect(e).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(e.accepted).toBeUndefined();
    const ok = criterionProofEntry(tests('change', [T1]), { ...probes([[U1, 'not-established', 'budget']], [[U1, 'passed-before']]), accepted: [{ criterionId: 'AC-1', questionId: 'q', by: 'person:ana' }] });
    expect(ok.accepted).toEqual({ question_id: 'q', by: 'person:ana' });
  });

  it('edge case: a keep criterion is kept when its tests pass on both trees, and not shown when one fails on the base tree', () => {
    expect(criterionProofEntry(tests('keep', [T1]), probes([[U1, 'passed-before']], [[U1, 'passed-before']])).outcome).toBe('kept');
    const e = criterionProofEntry(tests('keep', [T1]), probes([[U1, 'failed-before']], [[U1, 'passed-before']]));
    expect(e).toMatchObject({ outcome: 'passed-before', reason: `the mapped tests do not show AC-1: ${T1} fails on the base revision, so AC-1 is not behaviour that held before` });
  });

  it('a criterion with no mapped test, or a test that cannot run alone, is not established; a person-checked one is not probed', () => {
    expect(criterionProofEntry({ criterionId: 'AC-1', kind: 'change', tests: [] }, probes([], []))).toMatchObject({ outcome: 'not-established', cause: 'not-probed', reason: 'no test is mapped to AC-1, so nothing shows that it fails without the change' });
    expect(criterionProofEntry({ criterionId: 'AC-1', kind: 'change', tests: [{ path: T1, checkId: null, unitId: null, problem: 'no tests_command' }] }, probes([], []))).toMatchObject({ outcome: 'not-established', reason: 'no tests_command' });
    expect(criterionProofEntry({ criterionId: 'AC-1', kind: 'person', tests: [] }, probes([], []))).toMatchObject({ outcome: 'not-applicable' });
  });

  it('edge case: two criteria mapped to the same test each get an entry of their own from the same runs', () => {
    const p = probes([[U1, 'failed-before']], [[U1, 'passed-before']]);
    const a = criterionProofEntry({ ...tests('change', [T1]), criterionId: 'AC-1' }, p);
    const b = criterionProofEntry({ ...tests('change', [T1]), criterionId: 'AC-2' }, p);
    expect([a.outcome, b.outcome]).toEqual(['failed-before', 'failed-before']);
    expect(b.reason).toBe(a.reason);
  });
});

describe('the evidence report reads each criterion\'s own entry under required (FR-003, FR-011)', () => {
  const two = contract({
    acceptance_criteria: [
      { id: 'AC-1', statement: 'stops after two failed runs', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: [T1] },
      { id: 'AC-2', statement: 'logs the stop', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: [T2] },
    ],
    required_check_ids: ['unit'],
  });
  const judge = (c: typeof two, criteria: Map<string, CriterionFailBefore>, changedPaths = ['app/src/queue.ts', T1, T2]) =>
    evaluateEvidence({
      contract: c,
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'unit'), result(snapshot, 'lint')],
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }, { checkId: 'lint', status: 'PASSED' }], changedPaths },
      failBefore: { mode: 'required', probe: null, skipped: null, accepted: [], criteria },
    });

  it('US1.2: a criterion whose mapped test passes on the base tree is unproven, whatever the other criteria\'s probes showed', () => {
    const shown = criterionProofEntry({ ...tests('change', [T1]), criterionId: 'AC-1' }, probes([[U1, 'failed-before']], [[U1, 'passed-before']]));
    const notShown = criterionProofEntry({ ...tests('change', [T2]), criterionId: 'AC-2' }, probes([[U2, 'passed-before']], [[U2, 'passed-before']]));
    const e = judge(two, new Map([['AC-1', shown], ['AC-2', notShown]]));
    expect(e.report.acceptance_evidence.map((a) => [a.criterion_id, a.status])).toEqual([
      ['AC-1', 'supported'],
      ['AC-2', 'unverified'],
    ]);
    expect(e.report.acceptance_evidence[1]!.note).toBe(notShown.reason);
    expect(e.report.acceptance_evidence[1]!.fail_before?.tests?.[0]).toMatchObject({ path: T2, base: 'passed', candidate: 'passed' });
    expect(e.report.verdict).toBe('INCOMPLETE');
  });

  it('a keep criterion is supported by passing on both trees, though no test it cites changed', () => {
    const keep = contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'exports still work', proof: ['p'], mandatory: true, check_ids: ['unit'], kind: 'keep', tests: [T1] }], required_check_ids: ['unit'] });
    const kept = criterionProofEntry(tests('keep', [T1]), probes([[U1, 'passed-before']], [[U1, 'passed-before']]));
    const e = judge(keep, new Map([['AC-1', kept]]), ['app/src/queue.ts']);
    expect(e.report.acceptance_evidence[0]!.status).toBe('supported');
    expect(e.report.verdict).toBe('PASS');
  });

  it('FR-011: a person-checked criterion is listed as waiting on that person and never as supported, and does not hold up the verdict', () => {
    const withPerson = contract({
      acceptance_criteria: [
        { id: 'AC-1', statement: 'stops after two failed runs', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: [T1] },
        { id: 'AC-2', statement: 'A maintainer merges the pull request', proof: ['the maintainer merges it'], mandatory: true, kind: 'person', tests: [] },
      ],
      required_check_ids: ['unit'],
    });
    const shown = criterionProofEntry(tests('change', [T1]), probes([[U1, 'failed-before']], [[U1, 'passed-before']]));
    const e = judge(withPerson, new Map([['AC-1', shown]]));
    expect(e.report.acceptance_evidence[1]).toMatchObject({ criterion_id: 'AC-2', status: 'unverified', note: 'AC-2 is person-checked: no test proves it, and it waits on a person' });
    expect(e.report.unverified).toContain('criterion AC-2 is person-checked: no test proves it, and it waits on a person');
    expect(e.report.verdict).toBe('PASS');
  });
});
