/**
 * Issue #169: a verified candidate is always offered, even when the run stops. A run that would end EXHAUSTED while it
 * holds a candidate that passed verification ends BLOCKED instead and names that candidate (its commit and ref, the
 * checks it passed, every open finding with its status), with the command that delivers it as a draft pull request and
 * the one that discards it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { VERIFIED_CANDIDATE_BODY } from '../../../src/controller/verified-candidate.ts';
import { setCandidateStatus } from '../../../src/evidence/store.ts';
import type { FinalReport } from '../../../src/controller/report.ts';
import { addCandidate, addEvidence, addReview, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const TO_REVIEWING = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'] as const;
const finding = (id: string, severity: 'high' | 'medium' | 'low') => ({ externalId: id, severity, category: 'correctness' as const, location: 'apps/a.mjs:3', path: 'apps/a.mjs', line: 3, claim: `claim ${id}`, evidence: 'ev', suggestedValidation: null });
const PASSED = [
  { id: 'lint', status: 'PASSED' as const, exit_code: 0, flaky: false, log: 'evidence/1/lint.log' },
  { id: 'unit', status: 'PASSED' as const, exit_code: 0, flaky: false, log: 'evidence/1/unit.log' },
];

const outcomeOf = (): Record<string, unknown> => JSON.parse(getRun(lab.db, lab.runId).outcomeJson ?? '{}') as Record<string, unknown>;
const finalJson = (): FinalReport => JSON.parse(readFileSync(join(lab.ctx().runDir, 'final.json'), 'utf8')) as FinalReport;

describe('a run that runs out while it holds a verified candidate (issue #169)', () => {
  it('ends BLOCKED instead of EXHAUSTED and names the candidate: commit, ref, the checks it passed and each open finding with its status', async () => {
    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    const cand = addCandidate(lab, { commit: 'c1'.repeat(20), tree: 't1'.repeat(20) });
    addEvidence(lab, cand, { checks: PASSED });
    addReview(lab, cand, { verdict: 'REPAIR_REQUIRED', findings: [finding('COR-1', 'high'), finding('DOC-1', 'low')] });

    await finishRun(lab.ctx(), 'EXHAUSTED', 'review_rounds hard cap reached (3 of 3) with 1 open finding(s): COR-1 (review 1) (high): claim COR-1', { data: { counter: 'review_rounds', used: 3, hard_cap: 3 }, outcome: { open_findings: [{ id: 'f', external_id: 'COR-1' }] } });

    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    // Why it stopped is still the review dispute over its last round: the class is the one the EXHAUSTED end would have had.
    expect(run).toMatchObject({ failureClass: 'review-dispute', failureSecondary: 'budget' });
    const held = outcomeOf().verified_candidate as Record<string, unknown>;
    expect(outcomeOf()).toMatchObject({ state: 'BLOCKED', decided: 'EXHAUSTED' });
    expect(held).toMatchObject({ candidate_id: cand.id, seq: 1, commit: cand.commitSha, tree: cand.treeHash, ref: `refs/orbit/${lab.runId}/candidates/1`, checks_passed: ['lint', 'unit'], branch: `orbit/${lab.runId}` });
    expect(held.open_findings).toEqual([
      { id: 'COR-1', review_round: 1, severity: 'high', status: 'open', claim: 'claim COR-1' },
      { id: 'DOC-1', review_round: 1, severity: 'low', status: 'open', claim: 'claim DOC-1' },
    ]);
    // One command delivers it as a draft pull request whose body lists the open findings; one discards it.
    expect(held.deliver_command).toBe(
      `git push origin ${cand.commitSha}:refs/heads/orbit/${lab.runId} && gh pr create --draft --base main --head orbit/${lab.runId} --title "Orbit run ${lab.runId}: verified candidate 1" --body-file .orbit/runs/${lab.runId}/${VERIFIED_CANDIDATE_BODY}`,
    );
    expect(held.discard_command).toBe(`orbit cancel ${lab.runId}`);
    const body = readFileSync(join(lab.ctx().runDir, VERIFIED_CANDIDATE_BODY), 'utf8');
    expect(body).toContain(cand.commitSha);
    expect(body).toMatch(/Checks passed: lint, unit/);
    expect(body).toMatch(/- COR-1 \(review 1, high, open\): claim COR-1/);
    expect(body).toMatch(/- DOC-1 \(review 1, low, open\): claim DOC-1/);

    // The reason keeps why it stopped, names the candidate, and ends with the way forward; a resume is not it.
    expect(run.outcomeReason).toMatch(/^review_rounds hard cap reached \(3 of 3\)/);
    expect(run.outcomeReason).toContain(`candidate 1 (commit ${cand.commitSha.slice(0, 12)}, ref refs/orbit/${lab.runId}/candidates/1) passed verification (checks lint, unit)`);
    expect(run.outcomeReason).toContain('2 open review finding(s): COR-1 (review 1, high, open), DOC-1 (review 1, low, open)');
    expect(run.outcomeReason).toContain(held.deliver_command as string);
    expect(run.outcomeReason).toMatch(new RegExp(`orbit cancel ${lab.runId}\\. Resuming would stop again on the same limit\\.$`));

    // The report carries it, in JSON and in its own section, and its next action is to deliver or discard it.
    const report = finalJson();
    expect(report.outcome).toBe('BLOCKED');
    expect(report.verified_candidate).toMatchObject({ commit: cand.commitSha, checks_passed: ['lint', 'unit'] });
    expect(report.next_action).toContain(held.deliver_command as string);
    expect(report.next_action).toContain(`orbit cancel ${lab.runId}`);
    expect(report.next_action).not.toMatch(/then run `orbit resume/);
    const md = readFileSync(join(lab.ctx().runDir, 'final.md'), 'utf8');
    expect(md).toMatch(/## Verified candidate\n\nCandidate 1 \(commit c1c1/);
    expect(md).toMatch(/- open finding COR-1 \(review 1, high, open\): claim COR-1/);
  });

  it('a stop on money or time is classified budget', async () => {
    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    addEvidence(lab, addCandidate(lab), { checks: PASSED });
    await finishRun(lab.ctx(), 'EXHAUSTED', 'model cost hard cap reached (30.50 of 30)', { data: { counter: 'cost_usd', used: 30.5, hard_cap: 30 } });
    expect(getRun(lab.db, lab.runId)).toMatchObject({ state: 'BLOCKED', failureClass: 'budget', failureSecondary: null });
    expect((outcomeOf().verified_candidate as { open_findings: unknown[] }).open_findings).toEqual([]);
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('no open review finding');
  });

  it('several passing candidates: the newest that passed is offered, not a newer one that failed', async () => {
    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    addEvidence(lab, addCandidate(lab, { commit: 'a1'.repeat(20), tree: 'b1'.repeat(20) }), { checks: PASSED });
    const second = addCandidate(lab, { commit: 'a2'.repeat(20), tree: 'b2'.repeat(20), attempt: 2 });
    addEvidence(lab, second, { checks: PASSED });
    addEvidence(lab, addCandidate(lab, { commit: 'a3'.repeat(20), tree: 'b3'.repeat(20), attempt: 3 }), { verdict: 'FAIL', checks: [{ ...PASSED[1]!, status: 'FAILED', exit_code: 1 }] });
    await finishRun(lab.ctx(), 'EXHAUSTED', 'implementation attempts hard cap reached (3 of 3); the last failure was unit', { data: { counter: 'implementation_attempts' } });
    expect(outcomeOf().verified_candidate).toMatchObject({ seq: 2, commit: second.commitSha });
  });

  it('ends EXHAUSTED as before when no candidate passed, when the only PASS was invalidated, or when the candidate was already delivered', async () => {
    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    addEvidence(lab, addCandidate(lab), { verdict: 'FAIL', checks: [{ ...PASSED[1]!, status: 'FAILED', exit_code: 1 }] });
    await finishRun(lab.ctx(), 'EXHAUSTED', 'out of budget', { data: { counter: 'cost_usd' } });
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    expect(outcomeOf().verified_candidate).toBeUndefined();
    lab.cleanup();

    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    const ev = addEvidence(lab, addCandidate(lab), { checks: PASSED });
    lab.db.run('UPDATE evidence_reports SET invalidated_at = 1, invalidated_reason = ? WHERE id = ?', 'the contract changed', ev.id);
    await finishRun(lab.ctx(), 'EXHAUSTED', 'out of budget', { data: { counter: 'cost_usd' } });
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
    lab.cleanup();

    // Delivered: it is on a pull request already, and the CI that judged it there is what stopped the run.
    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    const cand = addCandidate(lab);
    addEvidence(lab, cand, { checks: PASSED });
    setCandidateStatus(lab.db, cand.id, 'DELIVERED');
    await finishRun(lab.ctx(), 'EXHAUSTED', 'CI failed and the CI repair budget is spent: 2 of 2', {});
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
  });

  it('a long reason gives way on the run row before the candidate and the way forward do, and many findings are counted, not all named', async () => {
    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    const cand = addCandidate(lab);
    addEvidence(lab, cand, { checks: PASSED });
    addReview(lab, cand, { verdict: 'REPAIR_REQUIRED', findings: ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((x) => finding(`COR-${x}`, 'medium')) });
    await finishRun(lab.ctx(), 'EXHAUSTED', `review_rounds hard cap reached (3 of 3) with 7 open finding(s): ${'a long finding text '.repeat(150)}`, { data: { counter: 'review_rounds' } });
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason!.length).toBeLessThanOrEqual(2000);
    expect(run.outcomeReason).toMatch(/^review_rounds hard cap reached/);
    expect(run.outcomeReason).toContain('7 open review finding(s): COR-A (review 1, medium, open), COR-B');
    expect(run.outcomeReason).toContain('COR-E (review 1, medium, open) and 2 more (orbit report lists every one)');
    expect(run.outcomeReason).toMatch(/Resuming would stop again on the same limit\.$/);
    expect((outcomeOf().verified_candidate as { open_findings: unknown[] }).open_findings).toHaveLength(7);
  });

  it('a recorded cancellation still wins', async () => {
    lab = makeUnitLab({ path: [...TO_REVIEWING] });
    addEvidence(lab, addCandidate(lab), { checks: PASSED });
    requestCancel(lab.db, lab.runId, 'person', lab.clock);
    await finishRun(lab.ctx(), 'EXHAUSTED', 'out of budget', { data: { counter: 'cost_usd' } });
    expect(getRun(lab.db, lab.runId)).toMatchObject({ state: 'CANCELLED', failureClass: 'cancelled' });
  });
});
