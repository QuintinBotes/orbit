/**
 * Issue #166, User Story 3 ("the review gate always has a way forward"), replayed in the lab from the two reports
 * behind it: #130 (a review that withheld approval over one low finding left a verified candidate BLOCKED with no
 * command that moved it) and #156 (a carried finding was briefed again and again, a medium finding was never briefed,
 * and the run ended only when its attempts ran out).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCandidates, listEvidenceReports } from '../../src/evidence/store.ts';
import { listFindings, listReviews } from '../../src/review/store.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { APPROVE, GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, review, scenario, type Edit } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

const TEXT_ASSERTION = `    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n`;

/** A repair that changes the tree: one more assertion in the unit test the first attempt extended. */
function addAssertion(path: string): Edit {
  return { op: 'replace', path: 'tests/unit/server.test.ts', find: TEXT_ASSERTION, replace: `${TEXT_ASSERTION}    assert.equal(handle('${path}', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n` };
}

const LOW = {
  id: 'COR-1',
  severity: 'low',
  category: 'correctness',
  location: 'tests/unit/server.test.ts:20',
  claim: 'The new text is asserted for one unknown path only; a nested unknown path is not covered.',
  evidence: "The unit test calls handle('/nope') and no other unknown path.",
  suggested_validation: "Assert the text for handle('/nope/deeper') as well.",
};

const TEST_1 = {
  id: 'TEST-1',
  severity: 'high',
  category: 'test-adequacy',
  location: 'tests/unit/server.test.ts:20',
  claim: 'The assertions do not establish that every unknown path answers the new text.',
  evidence: 'Only literal paths are asserted; nothing asserts the property for an arbitrary unknown path.',
  suggested_validation: 'Add a test that establishes the property for unknown paths in general.',
};
const DOC_1 = {
  id: 'DOC-1',
  severity: 'medium',
  category: 'documentation',
  location: 'README.md:1',
  claim: 'The README still describes the old not-found text.',
  evidence: 'README.md mentions "not found" as the body of unknown paths.',
  suggested_validation: 'Update the README sentence about unknown paths.',
};

interface Report {
  outcome: string;
  next_action: string;
  verified_candidate?: { seq: number; commit: string; open_findings: { id: string }[]; deliver_command: string };
}
function finalReport(l: Lab, runId: string): Report {
  return JSON.parse(readFileSync(join(l.runDir(runId), 'final.json'), 'utf8')) as Report;
}

describe.skipIf(!READY)('acceptance: the review gate always has a way forward (issue #166, User Story 3)', () => {
  it('issue #130: a review that asks for repair through an advisory finding only is repaired, and the repaired tree is delivered on an APPROVE', async () => {
    const l = lab();
    writeScenario(
      l,
      scenario({
        implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')], { refs: [{ criterion_id: null, ref: 'tests/unit/server.test.ts', note: 'validation for finding COR-1' }] })],
        reviewer: [review('REPAIR_REQUIRED', [LOW]), APPROVE],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    // Before the fix the gate passed, nobody approved, and the run ended BLOCKED with nothing for orbit decide or
    // orbit repair to act on. Now the finding goes to a repair, and only the second review's APPROVE delivers.
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const path = transitions(db, run.id);
    const firstReview = path.indexOf('REVIEWING');
    expect(path.slice(firstReview, firstReview + 5)).toEqual(['REVIEWING', 'REPAIRING', 'VERIFYING', 'REVIEWING', 'DELIVERING']);
    expect(path).not.toContain('BLOCKED');
    expect(listReviews(db, run.id, { includeInvalidated: true }).map((r) => r.verdict)).toEqual(['REPAIR_REQUIRED', 'APPROVE']);
    expect(listFindings(db, run.id).map((f) => [f.externalId, f.severity])).toEqual([['COR-1', 'low']]);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('issue #156, User Story 3.2: every finding of a REPAIR_REQUIRED review is briefed; the carried high finding no test settles gets one re-review, which finds it still present, and with no review round left for a repair the run ends BLOCKED naming it and offering the verified candidate', async () => {
    const l = lab();
    const asks = review('REPAIR_REQUIRED', [TEST_1, DOC_1]);
    writeScenario(
      l,
      scenario({
        // The repair adds assertions, as the reported run added 374 lines of tests, and its report names no test for the finding.
        implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')]), implementer([addAssertion('/nope/deepest')])],
        // The third answer is the re-reviewer's: the defect is still present.
        reviewer: [asks, asks, asks],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    // The medium finding rides along with the high one: left out, it kept every later review REPAIR_REQUIRED.
    const stored = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-2.json'), 'utf8')) as { brief: { briefs?: { finding_ids: string[] }[]; finding_ids?: string[] } };
    const briefed = (stored.brief.briefs ?? [stored.brief]).flatMap((b) => b.finding_ids ?? []);
    const first = listReviews(db, run.id, { includeInvalidated: true })[0]!;
    const raised = listFindings(db, run.id).filter((f) => f.reviewId === first.id);
    expect(raised.filter((f) => briefed.includes(f.id)).map((f) => f.externalId).sort()).toEqual(['DOC-1', 'TEST-1']);

    // Both candidates passed verification and the same findings came back. Before the third round, the high finding,
    // carried across both and settled by no test, got its one re-review: a fresh reviewer session told TEST-1 by id.
    expect(listEvidenceReports(db, run.id).map((e) => e.report.verdict)).toEqual(['PASS', 'PASS']);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    // The re-review is no review of the tree: the tree keeps its own two reviews, and the answer is recorded with the finding.
    expect(listReviews(db, run.id, { includeInvalidated: true })).toHaveLength(2);
    expect(listDecisions(db, run.id, { kind: 'review.finding-rereview.answer' }).map((d) => d.summary)).toEqual([expect.stringMatching(/^re-review of finding TEST-1 by codex: REPAIR_REQUIRED$/)]);
    const asked = listDecisions(db, run.id, { kind: 'review.finding-rereview' });
    expect(asked).toHaveLength(1);
    expect(asked[0]!.summary).toMatch(/^one re-review of finding TEST-1 \(review 2\) \(high\) on tree \w+: it was sent to repair from an earlier tree and no test or check settles it/);
    const reReviewer = listWorkers(db, { runId: run.id, role: 'reviewer' }).find((w) => w.purpose?.startsWith('review-finding:'))!;
    const prompt = readFileSync(join(reReviewer.workerDir, 'prompt.md'), 'utf8');
    expect(prompt).toContain('This is a re-review of one finding, TEST-1 (high)');
    expect(prompt).toContain('TEST-1 (high): The assertions do not establish that every unknown path answers the new text.');
    expect(listFindings(db, run.id).find((f) => f.externalId === 'TEST-1')!.resolution).toMatch(/its one re-review \S+ by codex of tree \w+ found it still present/);

    // Still present, and every review round is spent: no repair can be reviewed, so the run stops naming the finding. It
    // holds verified candidate 2, so it ends BLOCKED offering it (issue #169), not EXHAUSTED.
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/^review_rounds hard cap reached \(3 of 3\) with 2 open finding\(s\): TEST-1 \(review \d\) \(high\): The assertions do not establish/);
    expect(done.outcomeReason).toMatch(/DOC-1 \(review \d\) \(medium\)/);
    expect(transitions(db, run.id).at(-1)).toBe('BLOCKED');
    const report = finalReport(l, run.id);
    expect(report.outcome).toBe('BLOCKED');
    expect(report.verified_candidate).toMatchObject({ seq: 2, commit: listCandidates(db, run.id)[1]!.commitSha });
    expect(report.verified_candidate!.open_findings.map((f) => f.id)).toContain('TEST-1');
    expect(report.next_action).toContain(report.verified_candidate!.deliver_command);
    // The verified candidate is kept for a person; nothing was delivered on an unapproved tree.
    expect(listCandidates(db, run.id)).toHaveLength(2);
    expect(l.github().state.prs).toEqual([]);
    assertRunInvariants(l, run.id);
  }, 300_000);

  it("User Story 3.2: a carried high finding no test settles, which its one re-review finds gone, is dropped with the re-reviewer's evidence; the tree is then judged on its own review, whose low finding is repaired, and the run delivers on the next review's APPROVE", async () => {
    const l = lab({
      tweak: (c) => {
        c.scheduler.hard_limits.review_rounds = 4;
        c.scheduler.initial_allowances = { simple_attempts: 4, medium_attempts: 4, complex_attempts: 6 };
      },
    });
    const gone = review('APPROVE', [{ ...TEST_1, severity: 'info', claim: 'TEST-1 no longer holds.', evidence: 'tests/unit/server.test.ts:22 asserts the text for a nested unknown path as well.', suggested_validation: null }]);
    writeScenario(
      l,
      scenario({
        implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')]), implementer([addAssertion('/nope/deeper/still')])],
        // Candidate 1's review, candidate 2's (TEST-1 again and a low finding), TEST-1's re-review (gone), candidate 3's.
        reviewer: [review('REPAIR_REQUIRED', [TEST_1]), review('REPAIR_REQUIRED', [TEST_1, LOW]), gone, APPROVE],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    // Before the change the run stopped on candidate 2 as non-progress. Now the one re-review answers, and TEST-1 is
    // dropped on its evidence.
    expect(listDecisions(db, run.id, { kind: 'review.finding-rereview' })).toHaveLength(1);
    // The lab has one independent reviewer, codex, which raised the finding: it re-reviews in a fresh session.
    expect(listDecisions(db, run.id, { kind: 'review.finding-rereview.select' })[0]!.summary).toMatch(/^re-reviewer of finding TEST-1: codex\/\S+ \(independent\), which raised it: no other reviewer is eligible$/);
    const test1 = listFindings(db, run.id).filter((f) => f.externalId === 'TEST-1');
    expect(test1).toHaveLength(2);
    for (const f of test1) {
      expect(f.status).toBe('rejected');
      expect(f.resolution).toMatch(/^dropped: its one re-review \S+ by codex of tree \w+, told it by id with the candidate's diff and evidence, found the defect gone: tests\/unit\/server\.test\.ts:22 asserts the text/);
    }
    expect(listDecisions(db, run.id).some((d) => d.kind === 'review.finding.rejected' && /found the defect gone/.test(d.summary))).toBe(true);
    // The re-review approves nothing: candidate 2 is judged on its own review as if TEST-1 had not been raised, so its
    // low finding goes to repair (#130), and only candidate 3's own review delivers.
    expect(listReviews(db, run.id, { includeInvalidated: true }).map((r) => r.verdict)).toEqual(['REPAIR_REQUIRED', 'REPAIR_REQUIRED', 'APPROVE']);
    const stored = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-3.json'), 'utf8')) as { refs: string[] };
    expect(stored.refs).toEqual(listFindings(db, run.id).filter((f) => f.externalId === 'COR-1').map((f) => f.id));
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const path = transitions(db, run.id);
    expect(path.filter((s) => s === 'REPAIRING')).toHaveLength(2);
    expect(path[path.lastIndexOf('REVIEWING') + 1]).toBe('DELIVERING');
    expect(path).not.toContain('BLOCKED');
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(3);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 300_000);

  it('User Story 3.2: a finding gets one re-review per run; carried again after the repair it allowed, it stops the run as before', async () => {
    const l = lab({
      tweak: (c) => {
        c.scheduler.hard_limits.review_rounds = 6;
        c.scheduler.initial_allowances = { simple_attempts: 4, medium_attempts: 4, complex_attempts: 6 };
      },
    });
    const asks = review('REPAIR_REQUIRED', [TEST_1, DOC_1]);
    writeScenario(
      l,
      scenario({
        implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')]), implementer([addAssertion('/nope/deepest')]), implementer([addAssertion('/nope/deepest/still')])],
        // Reviews of candidates 1 and 2, the re-review (still present), the review of candidate 3, and one more that a
        // second re-review would take.
        reviewer: [asks, asks, asks, asks, APPROVE],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    // The re-review found it still present and a repair went on (attempt 3). Carried again on candidate 3, it gets no
    // second re-review: the run stops on the same brief as before the change.
    expect(listDecisions(db, run.id, { kind: 'review.finding-rereview' })).toHaveLength(1);
    expect(listWorkers(db, { runId: run.id, role: 'reviewer' }).filter((w) => w.purpose?.startsWith('review-finding:'))).toHaveLength(1);
    expect(listEvidenceReports(db, run.id).map((e) => e.report.verdict)).toEqual(['PASS', 'PASS', 'PASS']);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(3);
    expect(listReviews(db, run.id, { includeInvalidated: true })).toHaveLength(3);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/^non-progress: the review repair brief of attempt 3 was sent TEST-1, DOC-1, and no implementer report since names a test for any of them/);
    expect(finalReport(l, run.id).verified_candidate).toMatchObject({ seq: 3 });
    expect(l.github().state.prs).toEqual([]);
    assertRunInvariants(l, run.id);
  }, 300_000);
});
