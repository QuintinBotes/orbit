import { describe, expect, it } from 'vitest';
import { hashObject } from '../../../src/core/hash.ts';
import { aggregateCheckConfigHash, evaluateEvidence, type BuildReportInput, type UiResultInput } from '../../../src/evidence/report.ts';
import { checkDef } from './fixtures.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result, standardChecks } from './report-fixtures.ts';

describe('aggregateCheckConfigHash for a check the snapshot does not know', () => {
  it('hashes it as unknown, so adding a hash later changes the aggregate', () => {
    const snapshot = fakeSnapshot(standardChecks());
    expect(aggregateCheckConfigHash(snapshot, ['ghost'])).toBe(hashObject({ ghost: null }));
    expect(aggregateCheckConfigHash(snapshot, ['ghost', 'tests'])).not.toBe(aggregateCheckConfigHash(snapshot, ['tests']));
  });
});

describe('evaluateEvidence: journeys', () => {
  const journey = checkDef('journey', { kind: 'playwright', command: ['npx', 'playwright', 'test'] });
  const snapshot = fakeSnapshot([...standardChecks(), journey]);
  const uiContract = () =>
    contract({
      required_check_ids: ['tests', 'lint', 'journey'],
      acceptance_criteria: [{ id: 'AC-UI', statement: 'checkout works', proof: [], mandatory: true, ui: true, check_ids: ['journey'] }],
    });
  const run = (uiResults: UiResultInput[] | undefined, over: Partial<BuildReportInput> = {}) =>
    evaluateEvidence({ contract: uiContract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot, uiRequired: true, ...(uiResults ? { uiResults } : {}), ...over });

  it('ignores a journey that names no check when mapping criteria, but still lists it', () => {
    const e = run([{ journey: 'orphan', status: 'PASSED', artifacts: [] }]);
    expect(e.report.ui).toEqual([{ journey: 'orphan', status: 'PASSED', artifacts: [] }]);
    expect(e.report.acceptance_evidence[0]).toMatchObject({ criterion_id: 'AC-UI', status: 'unverified' });
    expect(e.incompleteReasons).toContain('check journey: mandatory but not executed for this candidate');
  });

  it('a timed out journey fails the check, and a cancelled or errored one leaves it without a result', () => {
    const timedOut = run([{ journey: 'checkout', status: 'TIMEOUT', artifacts: [], checkId: 'journey' }]);
    expect(timedOut.report.verdict).toBe('FAIL');
    expect(timedOut.failReasons).toEqual(expect.arrayContaining(['check journey: timed out', 'journey checkout: timed out']));
    expect(timedOut.report.acceptance_evidence[0]).toMatchObject({ status: 'unsupported', note: 'failing: journey' });

    const cancelled = run([{ journey: 'checkout', status: 'CANCELLED', artifacts: [], checkId: 'journey' }]);
    expect(cancelled.report.verdict).toBe('INCOMPLETE');
    expect(cancelled.incompleteReasons).toEqual(expect.arrayContaining(['check journey: was cancelled; no result', 'journey checkout: was cancelled']));
    expect(cancelled.report.acceptance_evidence[0]).toMatchObject({ status: 'blocked' });

    const errored = run([{ journey: 'checkout', status: 'ERROR', artifacts: [], checkId: 'journey' }]);
    expect(errored.incompleteReasons).toEqual(expect.arrayContaining(['check journey: could not be run; no result', 'journey checkout: could not be run']));
  });

  it('a failed journey is reported as failed, not timed out', () => {
    const e = run([{ journey: 'checkout', status: 'FAILED', artifacts: [], checkId: 'journey' }]);
    expect(e.failReasons).toEqual(expect.arrayContaining(['check journey: failed', 'journey checkout: failed']));
  });

  it('asks for UI evidence unless a mandatory journey check already says it is missing', () => {
    const none = run(undefined);
    expect(none.incompleteReasons).toContain('UI evidence is required for this candidate but no journey was executed');
    expect(run([]).incompleteReasons).toContain('UI evidence is required for this candidate but no journey was executed');

    const configured = fakeSnapshot([...standardChecks(), journey], (c) => {
      c.ui = { ...c.ui!, journey_check_ids: ['journey'] };
    });
    const covered = evaluateEvidence({ contract: uiContract(), candidate: CANDIDATE, checkResults: [result(configured, 'tests'), result(configured, 'lint')], scope: CLEAN_SCOPE, snapshot: configured, uiRequired: true });
    expect(covered.incompleteReasons).toContain('check journey: mandatory but not executed for this candidate');
    expect(covered.incompleteReasons).not.toContain('UI evidence is required for this candidate but no journey was executed');
  });
});

describe('evaluateEvidence: optional checks', () => {
  it('discloses an optional check that timed out, and one that failed, without letting either decide the verdict', () => {
    const snapshot = fakeSnapshot([...standardChecks(), checkDef('slow', { mandatory: false }), checkDef('flaky-extra', { mandatory: false })]);
    const e = evaluateEvidence({
      contract: contract(),
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint'), result(snapshot, 'slow', 'TIMEOUT'), result(snapshot, 'flaky-extra', 'FAILED')],
      scope: CLEAN_SCOPE,
      snapshot,
    });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.unverified).toEqual(expect.arrayContaining(['optional check slow timed out', 'optional check flaky-extra failed']));
  });
});
