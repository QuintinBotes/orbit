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

function finalReport(l: Lab, runId: string): { outcome: string; next_action: string } {
  return JSON.parse(readFileSync(join(l.runDir(runId), 'final.json'), 'utf8')) as { outcome: string; next_action: string };
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

  it('issue #156: every finding of a REPAIR_REQUIRED review is briefed, and a carried finding no repair names a test for ends the run with its findings named instead of a third brief', async () => {
    const l = lab();
    const asks = review('REPAIR_REQUIRED', [TEST_1, DOC_1]);
    writeScenario(
      l,
      scenario({
        // The repair adds assertions, as the reported run added 374 lines of tests, and its report names no test for the finding.
        implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')]), implementer([addAssertion('/nope/deepest')])],
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

    // Both candidates passed verification, and the same findings came back: the run does not brief them a third time.
    expect(listEvidenceReports(db, run.id).map((e) => e.report.verdict)).toEqual(['PASS', 'PASS']);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(listReviews(db, run.id, { includeInvalidated: true })).toHaveLength(2);
    // A terminal state that says why, not a stall: the findings are named by id and review round, with their text.
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/^non-progress: the review repair brief of attempt 2 was sent TEST-1, DOC-1, and no implementer report since names a test for any of them/);
    expect(done.outcomeReason).toMatch(/open findings: .*TEST-1 \(review 2\) \(high\): The assertions do not establish/);
    expect(done.outcomeReason).toMatch(/DOC-1 \(review 2\) \(medium\)/);
    expect(listDecisions(db, run.id, { kind: 'repair.non-progress' })).toHaveLength(1);
    expect(transitions(db, run.id).at(-1)).toBe('EXHAUSTED');
    const report = finalReport(l, run.id);
    expect(report.outcome).toBe('EXHAUSTED');
    expect(report.next_action.length).toBeGreaterThan(0);
    // The verified candidate is kept for a person; nothing was delivered on an unapproved tree.
    expect(listCandidates(db, run.id)).toHaveLength(2);
    expect(l.github().state.prs).toEqual([]);
    // Issue #166, SC-003, a known expected failure: the run ends EXHAUSTED holding verified candidate 2. The decided
    // behaviour is BLOCKED naming the candidate (issue #169), and User Story 3, scenario 2 follows this pull request.
    assertRunInvariants(l, run.id, { knownExhaustedWithVerifiedCandidate: '#169' });
  }, 300_000);
});
