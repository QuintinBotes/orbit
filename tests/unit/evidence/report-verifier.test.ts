import { describe, expect, it } from 'vitest';
import { buildEvidenceReport, type BuildReportInput } from '../../../src/evidence/report.ts';
import { checkDef } from './fixtures.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result } from './report-fixtures.ts';

/**
 * Verdict holes found by adversarial review: each case below once produced a
 * PASS (or a supported criterion) that the evidence did not justify.
 */

const snapshot = fakeSnapshot([checkDef('tests'), checkDef('lint'), checkDef('e2e', { kind: 'playwright', mandatory: false })], (c) => {
  if (c.ui) c.ui.journey_check_ids = ['e2e'];
});

function build(over: Partial<BuildReportInput> = {}) {
  return buildEvidenceReport({
    contract: contract(),
    candidate: CANDIDATE,
    checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')],
    scope: CLEAN_SCOPE,
    snapshot,
    ...over,
  });
}

describe('UI criteria need browser evidence', () => {
  const uiContract = (checkIds: string[]) =>
    contract({ acceptance_criteria: [{ id: 'AC-UI', statement: 'the export button downloads a file', proof: ['journey'], mandatory: true, ui: true, check_ids: checkIds }] });

  it('does not support a UI criterion mapped only to passing command checks', () => {
    const r = build({ contract: uiContract(['tests']) });
    expect(r.acceptance_evidence[0]).toMatchObject({ criterion_id: 'AC-UI', status: 'unverified' });
    expect(r.acceptance_evidence[0]!.note).toContain('browser');
    expect(r.verdict).toBe('INCOMPLETE');
  });

  it('supports it once a mapped browser journey passed, alongside the command check', () => {
    const r = build({ contract: uiContract(['tests', 'e2e']), uiResults: [{ journey: 'export', status: 'PASSED', artifacts: ['trace.zip'], checkId: 'e2e' }] });
    expect(r.acceptance_evidence[0]).toMatchObject({ status: 'supported' });
    expect(r.verdict).toBe('PASS');
  });

  it('leaves it unverified when the mapped browser check is defined but never ran', () => {
    const r = build({ contract: uiContract(['tests', 'e2e']) });
    expect(r.acceptance_evidence[0]).toMatchObject({ status: 'unverified' });
    expect(r.verdict).toBe('INCOMPLETE');
  });
});

describe('a pass after a failure on the same tree', () => {
  it('is a flaky pass even when the two results come from separate executions', () => {
    const failed = result(snapshot, 'tests', 'FAILED', { endedAt: 1000, id: 'first' });
    const passed = result(snapshot, 'tests', 'PASSED', { endedAt: 5000, id: 'second' });
    const r = build({ checkResults: [passed, failed, result(snapshot, 'lint')] });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.checks.find((c) => c.id === 'tests')).toMatchObject({ status: 'PASSED', flaky: true });
    expect(r.unverified.join('\n')).toMatch(/tests: passed only after a rerun/);
  });

  it('is clean when the earlier execution only errored or was cancelled', () => {
    const errored = result(snapshot, 'tests', 'ERROR', { endedAt: 1000, id: 'first' });
    const passed = result(snapshot, 'tests', 'PASSED', { endedAt: 5000, id: 'second' });
    expect(build({ checkResults: [errored, passed, result(snapshot, 'lint')] }).verdict).toBe('PASS');
  });
});

describe('nothing executed', () => {
  it('is never PASS, even when nothing is mandatory', () => {
    const optionalOnly = fakeSnapshot([checkDef('tests', { mandatory: false })]);
    const c = contract({ required_check_ids: [], acceptance_criteria: [{ id: 'AC-1', statement: 'docs read well', proof: ['reading'], mandatory: false }] });
    const r = buildEvidenceReport({ contract: c, candidate: CANDIDATE, checkResults: [], scope: CLEAN_SCOPE, snapshot: optionalOnly });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.unverified.join('\n')).toContain('no check was executed');
  });
});
