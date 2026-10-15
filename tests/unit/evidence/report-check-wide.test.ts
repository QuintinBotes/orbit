// Evidence granularity is the check (ADR 0014 section 4): a criterion is supported, and its fail-before outcome decided,
// by the whole run of each check it cites, whatever other criteria that run also serves. Where a check is cited by more
// than one criterion the report says so, so that a preservation criterion that inherits failed-before from its check
// ("existing behaviour unchanged" citing the unit suite the new tests run in) is not read as having a failing test of its
// own, and a UI criterion citing every journey's artifacts is not read as having journeys of its own (the 0.3.0 retest).
import { describe, expect, it } from 'vitest';
import { evaluateEvidence } from '../../../src/evidence/report.ts';
import type { FailBeforeEvidence } from '../../../src/evidence/fail-before.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result } from './report-fixtures.ts';
import { checkDef } from './fixtures.ts';

const snapshot = fakeSnapshot([checkDef('unit'), checkDef('lint', { category: 'lint' }), checkDef('ui', { kind: 'playwright', category: 'ui', mandatory: false })], (c) => (c.verification.fail_before = 'advisory'));
const criteria = contract({
  acceptance_criteria: [
    { id: 'AC-1', statement: 'the not-found page names the path', proof: ['tests/unit/not-found.test.ts'], mandatory: true, check_ids: ['unit'] },
    { id: 'AC-2', statement: 'passes lint and the whole unit suite', proof: ['lint and unit pass'], mandatory: true, check_ids: ['lint', 'unit'] },
    { id: 'AC-3', statement: 'the export link downloads a file', proof: ['the export journey passes'], mandatory: true, check_ids: ['ui'], ui: true },
    { id: 'AC-4', statement: 'existing journeys still pass', proof: ['every journey passes'], mandatory: true, check_ids: ['ui'], ui: true },
  ],
  required_check_ids: ['unit', 'lint'],
});
const failBefore: FailBeforeEvidence = {
  mode: 'advisory',
  skipped: null,
  accepted: [],
  probe: {
    probeId: 'probe-1',
    probeTree: 'tree-probe',
    baseRevision: 'b'.repeat(40),
    testPaths: ['tests/unit/not-found.test.ts'],
    reused: false,
    checks: [{ checkId: 'unit', outcome: 'failed-before', reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)', attempts: [{ attempt: 1, status: 'FAILED', exitCode: 1, signals: [], log: 'evidence/1/fail-before/unit.log' }, { attempt: 2, status: 'FAILED', exitCode: 1, signals: [], log: 'evidence/1/fail-before/unit~1.log' }] }],
  },
};

const judge = () =>
  evaluateEvidence({
    contract: criteria,
    candidate: CANDIDATE,
    checkResults: [result(snapshot, 'unit'), result(snapshot, 'lint')],
    uiResults: ['reports-export', 'reports-filter', 'reports-pagination'].map((journey) => ({ journey, status: 'PASSED' as const, artifacts: [`ui/${journey}.png`], checkId: 'ui' })),
    uiRequired: true,
    scope: CLEAN_SCOPE,
    snapshot,
    base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }, { checkId: 'lint', status: 'PASSED' }], changedPaths: ['src/views/not-found.ts', 'tests/unit/not-found.test.ts', 'tests/e2e/export.spec.ts'] },
    failBefore,
  }).report.acceptance_evidence;

describe('a criterion whose evidence comes from a check other criteria cite', () => {
  it('says its support is check-wide and names every criterion sharing the check', () => {
    const [ac1, ac2, ac3, ac4] = judge();
    expect(ac1!.check_wide).toBe('check-wide: the tests unit runs, shared by AC-1, AC-2');
    // lint is cited by AC-2 alone: only the shared check is named.
    expect(ac2!.check_wide).toBe('check-wide: the tests unit runs, shared by AC-1, AC-2');
    expect(ac3!.check_wide).toBe('check-wide: the journeys ui runs, shared by AC-3, AC-4');
    expect(ac4!.check_wide).toBe('check-wide: the journeys ui runs, shared by AC-3, AC-4');
  });

  it('says its fail-before outcome is check-wide, so a preservation criterion that inherits failed-before is not misread', () => {
    const [ac1, ac2] = judge();
    expect(ac2!.fail_before).toMatchObject({ outcome: 'failed-before', check_wide: 'check-wide: the tests unit runs, shared by AC-1, AC-2' });
    expect(ac1!.fail_before).toMatchObject({ outcome: 'failed-before', check_wide: 'check-wide: the tests unit runs, shared by AC-1, AC-2' });
  });

  it('says nothing for a check no other criterion cites', () => {
    const alone = contract({ acceptance_criteria: [criteria.acceptance_criteria[0]!], required_check_ids: ['unit'] });
    const [ac1] = evaluateEvidence({
      contract: alone,
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'unit')],
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }], changedPaths: ['tests/unit/not-found.test.ts'] },
      failBefore,
    }).report.acceptance_evidence;
    expect(ac1).not.toHaveProperty('check_wide');
    expect(ac1!.fail_before).toMatchObject({ outcome: 'failed-before' });
    expect(ac1!.fail_before).not.toHaveProperty('check_wide');
  });

  it('names a shared check that is not a test suite by what it checks', () => {
    const lintTwice = contract({
      acceptance_criteria: [
        { id: 'AC-1', statement: 'the module is typed', proof: ['lint passes'], mandatory: true, check_ids: ['lint'] },
        { id: 'AC-2', statement: 'no unused exports', proof: ['lint passes'], mandatory: true, check_ids: ['lint'] },
      ],
      required_check_ids: ['lint'],
    });
    const [ac1] = evaluateEvidence({ contract: lintTwice, candidate: CANDIDATE, checkResults: [result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot }).report.acceptance_evidence;
    expect(ac1!.check_wide).toBe('check-wide: what lint checks, shared by AC-1, AC-2');
  });
});
