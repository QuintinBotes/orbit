// Issue #261: a criterion mapped to a test that is not a file in the candidate is not established for a cause no person
// may accept. With several mapped tests, each absent one is named and the present ones are still run and listed.
import { describe, expect, it } from 'vitest';
import { criterionProofEntry, criterionTests, unitIdFor, type CriterionProbes } from '../../../src/evidence/criterion-tests.ts';
import { acceptableCause, type CheckProbe } from '../../../src/evidence/fail-before.ts';
import { evaluateEvidence } from '../../../src/evidence/report.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result } from './report-fixtures.ts';
import { checkDef } from './fixtures.ts';

const snapshot = fakeSnapshot([checkDef('unit', { tests_command: ['node', '--test'] })]);
const HERE = 'tests/here.test.ts';
const GONE = 'tests/gone.test.ts';
const ALSO_GONE = 'tests/also-gone.test.ts';
const mapped = contract({
  acceptance_criteria: [{ id: 'AC-1', statement: 'caps the cost', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: [GONE, HERE, ALSO_GONE] }],
  required_check_ids: ['unit'],
});
const units = (present: string[]) => criterionTests(mapped, snapshot, () => true, (p) => present.includes(p))[0]!;

function run(outcome: CheckProbe['outcome']): Map<string, CheckProbe> {
  const id = unitIdFor('unit', HERE);
  return new Map([[id, { checkId: id, outcome, reason: `${id} ${outcome}`, attempts: [{ attempt: 1, status: outcome === 'passed-before' ? 'PASSED' : 'FAILED', exitCode: outcome === 'passed-before' ? 0 : 1, signals: [], log: `evidence/1/criterion-probe/${id}.log` }] }]]);
}

const probes = (base: CheckProbe['outcome']): CriterionProbes => ({
  mode: 'required',
  base: { tree: 'tree-p', checks: run(base) },
  candidate: run('passed-before'),
  skipped: null,
  accepted: [{ criterionId: 'AC-1', questionId: 'q-1', by: 'acme-dev' }],
});

const BOTH = `AC-1's tests ${GONE}, ${ALSO_GONE} are not in the candidate`;

describe('a mapped test that is not in the candidate (issue #261)', () => {
  it('has no run of its own, while the present ones keep theirs', () => {
    expect(units([HERE]).tests.map((t) => [t.path, t.unitId, t.missing ?? false])).toEqual([
      [GONE, null, true],
      [HERE, unitIdFor('unit', HERE), false],
      [ALSO_GONE, null, true],
    ]);
  });

  it.each(['failed-before', 'passed-before'] as const)('leaves the criterion not established, naming each absent file, when the present test is %s', (base) => {
    const e = criterionProofEntry(units([HERE]), probes(base));
    expect(e).toMatchObject({ outcome: 'not-established', cause: 'missing', reason: BOTH });
    expect(e.accepted).toBeUndefined();
    expect(acceptableCause('missing')).toBe(false);
    expect(e.tests?.map((t) => [t.path, t.base, t.candidate])).toEqual([
      [GONE, 'not-established', 'not-established'],
      [HERE, base === 'failed-before' ? 'failed' : 'passed', 'passed'],
      [ALSO_GONE, 'not-established', 'not-established'],
    ]);
    expect(e.checks.map((c) => c.id)).toEqual([`unit:${HERE}`]);

    const report = evaluateEvidence({
      contract: mapped,
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'unit')],
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }], changedPaths: ['src/cap.ts', HERE] },
      failBefore: { mode: 'required', probe: null, skipped: null, accepted: [], criteria: new Map([['AC-1', e]]), missing: new Map([['AC-1', [GONE, ALSO_GONE]]]) },
    }).report;
    expect(report.acceptance_evidence[0]).toMatchObject({ status: 'unverified', note: BOTH });
    expect(report.verdict).toBe('INCOMPLETE');
  });

  it('names every file when none is present and nothing ran', () => {
    const e = criterionProofEntry(units([]), { mode: 'required', base: null, candidate: null, skipped: { cause: 'not-probed', reason: 'no mapped test can run alone' }, accepted: [] });
    expect(e).toMatchObject({ outcome: 'not-established', cause: 'missing', checks: [], reason: `AC-1's tests ${GONE}, ${HERE}, ${ALSO_GONE} are not in the candidate` });
  });
});
