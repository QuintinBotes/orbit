// The final report (orbit report, orbit report --json and final.json) carries each criterion's fail-before outcome as
// the evidence report does (ADR 0014 section 5): its mode, outcome, cause and reason, and whether the check it comes
// from is shared with other criteria. Before, only evidence/<seq>/report.json had it, and the report said "[supported]".
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { CriterionEvidence } from '../../../src/evidence/types.ts';
import { buildFinalReport, renderMarkdown } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { addCandidate, addEvidence, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const CHECK_WIDE = 'check-wide: the tests unit runs, shared by AC-1, AC-2';

function contractOf(): GoalContract {
  return {
    version: '1.0',
    task_id: 'orb-unit',
    original_goal: 'Add bulk_price.',
    objective: 'Add a bulk_price function.',
    acceptance_criteria: [
      { id: 'AC-1', statement: 'bulk_price discounts every price', proof: ['tests/test_pricing.py'], mandatory: true, check_ids: ['unit'] },
      { id: 'AC-2', statement: 'existing behaviour is unchanged', proof: ['the whole suite passes'], mandatory: true, check_ids: ['unit'] },
      { id: 'AC-3', statement: 'the export journey downloads a file', proof: ['the export journey'], mandatory: false, check_ids: ['ui'] },
    ],
    non_goals: [],
    allowed_paths: ['src/**', 'tests/**'],
    required_check_ids: ['unit'],
    assumptions: [],
    delivery: { draft_pr: false, merge: false },
    policy_hash: 'sha256:x',
    baseline_revision: 'a'.repeat(40),
    escalation: { material_topics: [] },
  };
}

const failedBefore = { mode: 'advisory' as const, outcome: 'failed-before' as const, checks: [{ id: 'unit', outcome: 'failed-before' as const, attempts: [{ status: 'FAILED' as const, exit_code: 1, log: 'evidence/1/fail-before/unit.log' }] }], probe_tree: 'tree-probe', test_paths: { paths: ['tests/test_pricing.py'], count: 1 }, reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)' };
const evidence: CriterionEvidence[] = [
  { criterion_id: 'AC-1', status: 'supported', artifacts: ['evidence/1/unit.log'], check_wide: CHECK_WIDE, fail_before: { ...failedBefore, check_wide: CHECK_WIDE } },
  { criterion_id: 'AC-2', status: 'supported', artifacts: ['evidence/1/unit.log'], check_wide: CHECK_WIDE, fail_before: { ...failedBefore, check_wide: CHECK_WIDE } },
  { criterion_id: 'AC-3', status: 'supported', artifacts: ['ui/export.png'], fail_before: { mode: 'advisory', outcome: 'not-established', cause: 'not-probed', checks: [], probe_tree: 'tree-probe', test_paths: { paths: ['tests/e2e/export.spec.ts'], count: 1 }, reason: 'ui is not probed: only a command check of category test that passed on the base revision, or a browser check, is' } },
];

function build() {
  lab = makeUnitLab({ path: ['PREFLIGHT'] });
  const cand = addCandidate(lab);
  lab.db.run('UPDATE runs SET contract_json = ?, base_revision = ? WHERE id = ?', JSON.stringify(contractOf()), 'b'.repeat(40), lab.runId);
  addEvidence(lab, cand, { acceptance_evidence: evidence });
  const run = getRun(lab.db, lab.runId);
  return buildFinalReport(lab.db, run, { runDir: join(lab.repo, '.orbit', 'runs', lab.runId), clock: lab.clock, snapshot: verifySnapshot(run.policyPath, run.policyHash) });
}

describe('the final report carries each criterion\'s fail-before outcome', () => {
  it('in final.json and orbit report --json: mode, outcome, cause and reason, and whether the check is shared', () => {
    const r = build();
    expect(r.criteria[0]).toEqual({
      id: 'AC-1',
      statement: 'bulk_price discounts every price',
      mandatory: true,
      status: 'supported',
      artifacts: ['evidence/1/unit.log'],
      check_wide: CHECK_WIDE,
      fail_before: { mode: 'advisory', outcome: 'failed-before', reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)', check_wide: CHECK_WIDE },
    });
    expect(r.criteria[2]!.fail_before).toEqual({ mode: 'advisory', outcome: 'not-established', cause: 'not-probed', reason: 'ui is not probed: only a command check of category test that passed on the base revision, or a browser check, is' });
    expect(r.criteria[2]).not.toHaveProperty('check_wide');
  });

  it('in orbit report: each Criterion evidence line shows the outcome, its cause, and that it is check-wide', () => {
    const md = renderMarkdown(build());
    const section = md.slice(md.indexOf('## Criterion evidence'), md.indexOf('## Checks'));
    expect(section).toContain('- AC-1 [supported]: bulk_price discounts every price (evidence: evidence/1/unit.log); fail-before (advisory): failed-before: unit failed on the base revision with the new tests (exit 1, 2 attempts); check-wide: the tests unit runs, shared by AC-1, AC-2');
    expect(section).toContain('- AC-2 [supported]: existing behaviour is unchanged (evidence: evidence/1/unit.log); fail-before (advisory): failed-before: unit failed on the base revision with the new tests (exit 1, 2 attempts); check-wide: the tests unit runs, shared by AC-1, AC-2');
    expect(section).toContain('- AC-3 (optional) [supported]: the export journey downloads a file (evidence: ui/export.png); fail-before (advisory): not-established (cause not-probed): ui is not probed: only a command check of category test that passed on the base revision, or a browser check, is');
  });

  it('shows the evaluated status and reason for a flagged assumption, and the contract status for the others', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const cand = addCandidate(lab);
    const withAssumptions: GoalContract = {
      ...contractOf(),
      assumptions: [
        { id: 'AS-1', statement: 'The unit check runs pytest over tests/ with src on the path', status: 'unverified' },
        { id: 'AS-2', statement: 'Prices are in euros', status: 'unverified' },
        { id: 'AS-3', statement: 'The unit check discovers tests/test_pricing.py', status: 'supported' },
      ],
    };
    lab.db.run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(withAssumptions), lab.runId);
    addEvidence(lab, cand, {
      acceptance_evidence: evidence,
      assumptions: [
        { assumption_id: 'AS-1', status: 'supported', reason: 'unit: failed-before (unit failed on the base revision with the new tests)', checks: ['unit'] },
        { assumption_id: 'AS-3', status: 'unverified', reason: 'unit: passed-before (unit passed on the base revision with the new tests)', checks: ['unit'] },
      ],
    });
    const run = getRun(lab.db, lab.runId);
    const r = buildFinalReport(lab.db, run, { runDir: join(lab.repo, '.orbit', 'runs', lab.runId), clock: lab.clock, snapshot: verifySnapshot(run.policyPath, run.policyHash) });
    expect(r.assumptions).toEqual([
      { id: 'AS-1', statement: 'The unit check runs pytest over tests/ with src on the path', status: 'supported', reason: 'unit: failed-before (unit failed on the base revision with the new tests)' },
      { id: 'AS-2', statement: 'Prices are in euros', status: 'unverified' },
      { id: 'AS-3', statement: 'The unit check discovers tests/test_pricing.py', status: 'unverified', reason: 'unit: passed-before (unit passed on the base revision with the new tests)' },
    ]);
    const md = renderMarkdown(r);
    expect(md).toContain('- AS-1 [supported]: The unit check runs pytest over tests/ with src on the path (unit: failed-before (unit failed on the base revision with the new tests))');
    expect(md).toContain('- AS-2 [unverified]: Prices are in euros\n');
  });

  it('a criterion with no fail-before entry reads as before', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const cand = addCandidate(lab);
    lab.db.run('UPDATE runs SET contract_json = ? WHERE id = ?', JSON.stringify(contractOf()), lab.runId);
    addEvidence(lab, cand, { acceptance_evidence: [{ criterion_id: 'AC-1', status: 'supported', artifacts: ['unit.log'] }] });
    const run = getRun(lab.db, lab.runId);
    const r = buildFinalReport(lab.db, run, { runDir: join(lab.repo, '.orbit', 'runs', lab.runId), clock: lab.clock, snapshot: verifySnapshot(run.policyPath, run.policyHash) });
    expect(r.criteria[0]).toEqual({ id: 'AC-1', statement: 'bulk_price discounts every price', mandatory: true, status: 'supported', artifacts: ['unit.log'] });
    expect(renderMarkdown(r)).toContain('- AC-1 [supported]: bulk_price discounts every price (evidence: unit.log)\n');
  });
});
