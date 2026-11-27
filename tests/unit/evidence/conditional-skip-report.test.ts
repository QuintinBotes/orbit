// Issue #285: a conditional skip in a test file the candidate adds is not read as weakening when the guarded tests ran
// on both trees in the fail-before probe; one that did not run, and every other skip, still needs review.
import { describe, expect, it } from 'vitest';
import { evaluateEvidence } from '../../../src/evidence/report.ts';
import type { CriterionFailBefore } from '../../../src/evidence/types.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result } from './report-fixtures.ts';
import { checkDef } from './fixtures.ts';

const snapshot = fakeSnapshot([checkDef('unit', { tests_command: ['node', '--test'] })]);
const FILE = 'tests/acceptance/spend-file.test.ts';
const guard = { path: FILE, signal: 'test-skipped', detail: "describe.skipIf(!READY)('acceptance', () => {", conditional_in_new_file: true as const };
const mapped = contract({ acceptance_criteria: [{ id: 'AC-1', statement: 'writes the file', proof: ['p'], mandatory: true, check_ids: ['unit'], tests: [FILE] }], required_check_ids: ['unit'] });

const entry = (base: 'failed' | 'passed' | 'not-established', candidate: 'failed' | 'passed' | 'not-established'): CriterionFailBefore =>
  ({ mode: 'required', outcome: 'failed-before', checks: [], tests: [{ path: FILE, check_id: 'unit', base, candidate, reason: '' }], reason: '' }) as unknown as CriterionFailBefore;

const evaluate = (signal: typeof guard | Omit<typeof guard, 'conditional_in_new_file'>, e: CriterionFailBefore) =>
  evaluateEvidence({
    contract: mapped,
    candidate: CANDIDATE,
    checkResults: [result(snapshot, 'unit')],
    scope: { ...CLEAN_SCOPE, weakening_signals: [signal] },
    snapshot,
    base: { treeHash: 'tree-base', checks: [{ checkId: 'unit', status: 'PASSED' }], changedPaths: ['src/a.ts', FILE] },
    failBefore: { mode: 'required', probe: null, skipped: null, accepted: [], criteria: new Map([['AC-1', e]]) },
  }).report;

describe('a conditional skip in a new test file (issue #285)', () => {
  it('whose tests ran on both trees is not weakening', () => {
    const r = evaluate(guard, entry('failed', 'passed'));
    expect(r.scope.weakening_signals).toEqual([]);
    expect(r.unverified.join('\n')).not.toContain('possible test weakening');
  });

  it('whose tests did not run on one of the trees still needs review', () => {
    for (const [b, c] of [['not-established', 'passed'], ['failed', 'not-established']] as const) {
      const r = evaluate(guard, entry(b, c));
      expect(r.scope.weakening_signals).toEqual([guard]);
      expect(r.unverified.join('\n')).toContain(`possible test weakening in ${FILE}`);
    }
  });

  it('a skip not marked as a guard in a new file still needs review, even when its tests ran', () => {
    const { conditional_in_new_file: _, ...plain } = guard;
    const r = evaluate(plain, entry('failed', 'passed'));
    expect(r.scope.weakening_signals).toEqual([plain]);
    expect(r.unverified.join('\n')).toContain(`possible test weakening in ${FILE}`);
  });
});
