// What a fail-before outcome does to the run under `required` (ADR 0014 section 4), step by step on recorded reports:
// an environment, ERROR or install cause blocks without a question; any other cause blocks with one question per
// criterion; new tests that pass on the base revision go to repair while an inquiry is left, and to a person when none
// is; a person's answer is bound to the tree; and a report goes stale when that answer or a resume could change it.
import { afterEach, describe, expect, it } from 'vitest';
import { acceptedWithoutFailBefore, askInsteadOfExhausting, failBeforeQuestionId, failBeforeStale, routeFailBefore } from '../../../src/controller/fail-before.ts';
import { resumeTarget } from '../../../src/controller/resume.ts';
import { getRun, transition } from '../../../src/controller/run-store.ts';
import { MOVED } from '../../../src/controller/steps/common.ts';
import type { CandidateRecord } from '../../../src/evidence/store.ts';
import type { CriterionEvidence, CriterionFailBefore } from '../../../src/evidence/types.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { findQuestion, listQuestions } from '../../../src/inquisition/store.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { addCandidate, addEvidence, makeUnitLab, OWNER, setContract, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

function setup(): { cand: CandidateRecord } {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'] });
  setContract(lab);
  return { cand: addCandidate(lab) };
}

const entry = (fb: Partial<CriterionFailBefore>, over: Partial<CriterionEvidence> = {}): CriterionEvidence => {
  const failBefore: CriterionFailBefore = { mode: 'required', outcome: 'not-established', checks: [], probe_tree: 'p'.repeat(40), test_paths: { paths: ['tests/mul.test.mjs'], count: 1 }, reason: 'unit timed out on the probe tree', cause: 'timeout', ...fb };
  const note = failBefore.outcome === 'passed-before' ? 'the new tests pass on the base revision: unit passed on aaaaaaaaaaaa with 1 test file overlaid (evidence/1/fail-before/unit.log), so they do not show the change, or unit does not run them' : `fail-before not established: ${failBefore.reason}`;
  return { criterion_id: 'AC-1', status: failBefore.outcome === 'passed-before' ? 'unverified' : 'blocked', artifacts: [], note, fail_before: failBefore, ...over };
};

const back = (): void => {
  transition(lab.db, { runId: lab.runId, to: 'VERIFYING', ownerId: OWNER, reason: 'resumed' }, lab.clock);
};
const noInquiry = async () => null;

describe('routeFailBefore', () => {
  it('blocks on an environment cause without a question: it is fixed, and a resume runs the probe again', async () => {
    const { cand } = setup();
    const ev = addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({ cause: 'environment', reason: 'unit could not run on the probe tree: its output shows an environment cause (socket-denied), not a test result' })] });
    const ctx = lab.ctx();
    expect(await routeFailBefore(ctx, cand, ev, noInquiry)).toMatchObject({ done: true });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toMatch(/AC-1: the cause is the environment's \(an environment signal, an ERROR or a failed install\), which is never accepted in place of the evidence; fix it, then orbit resume \S+ runs the probe again/);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    expect(resumeTarget(lab.db, run)).toBe('VERIFYING');
  });

  it('review finding 2: offers no acceptance when any probed check of the criterion shows a cause that is never accepted', async () => {
    const { cand } = setup();
    // A report whose criterion names the first check's cause only, as the branch once recorded it.
    const checks: CriterionFailBefore['checks'] = [
      { id: 'a', outcome: 'not-established', cause: 'timeout', attempts: [{ status: 'TIMEOUT', exit_code: null, log: 'evidence/1/fail-before/a.log' }] },
      { id: 'b', outcome: 'not-established', cause: 'error', attempts: [{ status: 'ERROR', exit_code: null, log: 'evidence/1/fail-before/b.log' }] },
    ];
    const ev = addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({ cause: 'timeout', checks })] });
    await routeFailBefore(lab.ctx(), cand, ev, noInquiry);
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/AC-1: the cause is the environment's/);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
  });

  it('asks one question per criterion for a cause a person may accept, and a decline stays a decline for the tree', async () => {
    const { cand } = setup();
    const ev = addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({})] });
    await routeFailBefore(lab.ctx(), cand, ev, noInquiry);
    const [q] = listQuestions(lab.db, lab.runId, { status: 'open' });
    expect(q?.id).toBe(failBeforeQuestionId(lab.runId, cand.treeHash, 'AC-1'));
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/it was not established: AC-1: unit timed out on the probe tree\. Answer it with orbit decide/);
    answerQuestion(lab.db, lab.ctx().runDir, q!.id, 'decline', 'acme-dev', lab.clock);
    back();
    await routeFailBefore(lab.ctx(), cand, ev, noInquiry);
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/AC-1: a person declined to accept it without fail-before for this tree/);
    expect(acceptedWithoutFailBefore(lab.ctx(), cand.treeHash)).toEqual([]);
  });

  it('sends new tests that pass on the base revision to the inquiry while there is one, and to a person when there is none', async () => {
    const { cand } = setup();
    const ev = addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({ outcome: 'passed-before', cause: undefined, reason: 'unit passed on the base revision with the new tests' })] });
    expect(await routeFailBefore(lab.ctx(), cand, ev, async () => MOVED)).toBe(MOVED);
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    await routeFailBefore(lab.ctx(), cand, ev, noInquiry);
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toMatch(/; the repair loop already went round on tree t{12}, and another repair would start from the same evidence\. Accept it without fail-before/);
    // Still waiting for the answer: the same question, not a repair.
    back();
    await routeFailBefore(lab.ctx(), cand, ev, async () => MOVED);
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/the person's answer is still needed/);
    expect(listQuestions(lab.db, lab.runId, { status: 'open' })).toHaveLength(1);
  });

  it('withdraws a question about another tree, and one the report no longer needs', async () => {
    const { cand } = setup();
    const ev = addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({})] });
    await routeFailBefore(lab.ctx(), cand, ev, noInquiry);
    const qid = failBeforeQuestionId(lab.runId, cand.treeHash, 'AC-1');
    back();
    const next = addCandidate(lab, { tree: 'u'.repeat(40), attempt: 2 });
    const passing = addEvidence(lab, next, { verdict: 'PASS', acceptance_evidence: [entry({ outcome: 'failed-before', cause: undefined, reason: 'unit failed on the base revision with the new tests (exit 1, 2 attempts)' }, { status: 'supported', note: undefined })] });
    expect(await routeFailBefore(lab.ctx(), next, passing, noInquiry)).toBeNull();
    expect(findQuestion(lab.db, qid)?.status).toBe('withdrawn');
  });
});

describe('askInsteadOfExhausting', () => {
  it('asks a person when the repair attempts run out on new tests that pass on the base revision, and not once they declined', async () => {
    const { cand } = setup();
    expect(await askInsteadOfExhausting(lab.ctx(), cand, 'non-progress')).toBeNull();
    addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({ outcome: 'passed-before', cause: undefined, reason: 'unit passed on the base revision with the new tests' })] });
    await askInsteadOfExhausting(lab.ctx(), cand, 'non-progress: 3 consecutive attempts made no progress');
    const run = getRun(lab.db, lab.runId);
    expect(run.outcomeReason).toMatch(/the repair attempts ran out \(non-progress: 3 consecutive attempts made no progress\)/);
    expect(JSON.parse(run.outcomeJson ?? '{}')).toMatchObject({ fail_before: { passed_before: ['AC-1'] } });
    const [q] = listQuestions(lab.db, lab.runId, { status: 'open' });
    answerQuestion(lab.db, lab.ctx().runDir, q!.id, 'decline', 'acme-dev', lab.clock);
    back();
    expect(await askInsteadOfExhausting(lab.ctx(), cand, 'non-progress')).toBeNull();
  });

  it('leaves a criterion with no fail-before gap alone', async () => {
    const { cand } = setup();
    addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({ mode: 'advisory', outcome: 'passed-before', cause: undefined }, { status: 'supported', note: undefined })] });
    expect(await askInsteadOfExhausting(lab.ctx(), cand, 'non-progress')).toBeNull();
  });
});

describe('failBeforeStale', () => {
  it('is stale after a resume that follows a probe not established', () => {
    const { cand } = setup();
    const ev = addEvidence(lab, cand, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({})] });
    expect(failBeforeStale(lab.ctx(), cand, ev)).toBe(false);
    lab.clock.advance(1_000);
    lab.db.tx(() => appendEvent(lab.db, lab.runId, 'run.resumed', 'acme-dev', { from: 'BLOCKED', to: 'VERIFYING' }, lab.clock.now()));
    expect(failBeforeStale(lab.ctx(), cand, ev)).toBe(true);
  });

  it('is stale after a person accepted a criterion for the tree', async () => {
    const { cand: other } = setup();
    const passed = addEvidence(lab, other, { verdict: 'INCOMPLETE', acceptance_evidence: [entry({ outcome: 'passed-before', cause: undefined, reason: 'unit passed on the base revision with the new tests' })] });
    await routeFailBefore(lab.ctx(), other, passed, noInquiry);
    expect(failBeforeStale(lab.ctx(), other, passed)).toBe(false);
    const [q] = listQuestions(lab.db, lab.runId, { status: 'open' });
    answerQuestion(lab.db, lab.ctx().runDir, q!.id, 'accept', 'acme-dev', lab.clock);
    expect(failBeforeStale(lab.ctx(), other, passed)).toBe(true);
    expect(acceptedWithoutFailBefore(lab.ctx(), other.treeHash)).toEqual([{ criterionId: 'AC-1', questionId: q!.id, by: 'acme-dev' }]);
  });
});
