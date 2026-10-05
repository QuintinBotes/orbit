import { describe, expect, it } from 'vitest';
import { formatDeliverySummary } from '../../../src/controller/steps/delivering.ts';

// The pull request body is what a reviewer reads first: every kind of evidence the run gathered must be on it.
describe('formatDeliverySummary', () => {
  const contract = { objective: 'Fix the acme totals', acceptance_criteria: [{ id: 'AC-1', statement: 'Totals match' }] };
  const report = {
    acceptance_evidence: [{ criterion_id: 'AC-1', status: 'supported' }],
    checks: [{ id: 'lint', status: 'PASSED' }, { id: 'unit', status: 'PASSED', flaky: true }],
    ui: [
      { journey: 'desktop/reports.spec.ts#reports-totals', status: 'PASSED', artifacts: [] },
      { journey: 'mobile/reports.spec.ts#reports-totals', status: 'FAILED', artifacts: [] },
    ],
    unverified: ['static analysis (SAST) is unverified'],
  };

  it('lists the browser journeys next to the checks', () => {
    const body = formatDeliverySummary('orb-1', contract as never, report as never);
    expect(body).toContain('- AC-1 (supported): Totals match');
    expect(body).toContain('- lint: PASSED');
    expect(body).toContain('- unit: PASSED (flaky)');
    expect(body).toMatch(/Browser journeys:\n- desktop\/reports\.spec\.ts#reports-totals: PASSED\n- mobile\/reports\.spec\.ts#reports-totals: FAILED/);
    expect(body).toContain('- static analysis (SAST) is unverified');
  });

  it('says nothing about journeys when the run had none, and marks criteria unverified without evidence', () => {
    const body = formatDeliverySummary('orb-1', contract as never, { ...report, ui: [] } as never);
    expect(body).not.toContain('Browser journeys');
    expect(formatDeliverySummary('orb-1', contract as never, null)).toContain('- AC-1 (unverified): Totals match');
  });
});
