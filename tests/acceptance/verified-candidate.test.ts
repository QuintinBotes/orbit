/**
 * Issue #169: a verified candidate is always offered, even when the run stops. In at least five reported runs a
 * candidate passed every check, the run then stopped on a limit or a review dispute, the report read "no delivery", and a
 * person cherry-picked the work by hand (#130, #144, #156, #157). A run that would end EXHAUSTED while it holds a
 * candidate that passed verification now ends BLOCKED, and its report names the candidate (commit, ref, the checks it
 * passed, each open finding with its status) with one command that delivers it as a draft pull request and one that
 * discards it. Orbit itself never delivers it: autonomous delivery stops at the block.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listCandidates, listEvidenceReports } from '../../src/evidence/store.ts';
import { drive, git, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, review, scenario, type Edit } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

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

const TEXT_ASSERTION = `    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n`;
/** A repair that changes the tree: one more assertion in the unit test the first attempt extended. */
function addAssertion(path: string): Edit {
  return { op: 'replace', path: 'tests/unit/server.test.ts', find: TEXT_ASSERTION, replace: `${TEXT_ASSERTION}    assert.equal(handle('${path}', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n` };
}

interface Offered {
  candidate_id: string;
  seq: number;
  commit: string;
  ref: string;
  branch: string;
  checks_passed: string[];
  open_findings: { id: string; review_round: number | null; severity: string; status: string; claim: string }[];
  deliver_command: string;
  discard_command: string;
}
interface Report {
  outcome: string;
  failure_class: string | null;
  verified_candidate?: Offered;
  next_action: string;
}
const finalReport = (l: Lab, runId: string): Report => JSON.parse(readFileSync(join(l.runDir(runId), 'final.json'), 'utf8')) as Report;

describe.skipIf(!READY)('acceptance: a verified candidate is always offered, even when the run stops (issue #169)', () => {
  it('scenario 1: a run whose candidate passed verification and that stops on its review round cap ends BLOCKED, and the report gives the candidate commit, the checks it passed and the open findings', async () => {
    const l = lab({ tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 1) });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [review('REPAIR_REQUIRED', [TEST_1, DOC_1])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    // The candidate passed verification; the one review round the policy allows asked for a repair nobody could review.
    const [cand] = listCandidates(db, run.id);
    expect(listEvidenceReports(db, run.id).map((e) => e.report.verdict)).toEqual(['PASS']);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(db, run.id).at(-1)).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/^review_rounds hard cap reached \(1 of 1\)/);
    // Why it stopped is unchanged: the review dispute over its last round, with the spent budget second.
    expect(done).toMatchObject({ failureClass: 'review-dispute', failureSecondary: 'budget' });

    const report = finalReport(l, run.id);
    expect(report.outcome).toBe('BLOCKED');
    expect(report.failure_class).toBe('review-dispute');
    const offered = report.verified_candidate!;
    expect(offered).toMatchObject({ candidate_id: cand!.id, seq: 1, commit: cand!.commitSha, ref: `refs/orbit/${run.id}/candidates/1`, checks_passed: ['lint', 'orbit-install', 'unit'] });
    expect(offered.open_findings.map((f) => [f.id, f.severity])).toEqual([
      ['TEST-1', 'high'],
      ['DOC-1', 'medium'],
    ]);
    for (const f of offered.open_findings) expect(['open', 'claim_pending', 'accepted', 'advisory']).toContain(f.status);
    const md = readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8');
    expect(md).toContain(`## Verified candidate\n\nCandidate 1 (commit ${cand!.commitSha}`);
    expect(md).toMatch(/- checks passed: lint, orbit-install, unit/);
    expect(md).toMatch(/- open finding TEST-1 \(review 1, high, \w+\): The assertions do not establish/);
    // The way forward is to deliver it or discard it; a resume would stop again on the same round cap.
    expect(report.next_action).toContain(offered.deliver_command);
    expect(report.next_action).toContain(`orbit cancel ${run.id}`);
    expect(report.next_action).not.toMatch(/then run `orbit resume/);

    // Autonomous delivery never delivers it without a person: no pull request, no delivery.
    expect(transitions(db, run.id)).not.toContain('DELIVERING');
    expect(l.github().state.prs).toEqual([]);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('scenario 2: the delivery command the report gives pushes that exact candidate, and the draft pull request body it names lists the open findings', async () => {
    const l = lab({ tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 1) });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [review('REPAIR_REQUIRED', [TEST_1, DOC_1])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    const offered = finalReport(l, run.id).verified_candidate!;

    // One command: push the candidate commit to the run's branch, then open a draft pull request from it with the body
    // Orbit wrote. The lab has no gh, so the push runs as the person would run it and the body is read as gh would send it.
    const [push, pr] = offered.deliver_command.split(' && ');
    expect(push).toBe(`git push -- origin ${offered.commit}:refs/heads/${offered.branch}`);
    expect(pr).toMatch(new RegExp(`^gh pr create --draft --base main --head ${offered.branch} --title "Orbit run ${run.id}: verified candidate 1" --body-file (\\S+)$`));
    execFileSync('sh', ['-c', push!], { cwd: l.repo, stdio: 'pipe' });
    expect(git(l.remote, 'rev-parse', `refs/heads/${offered.branch}`)).toBe(offered.commit);
    expect(git(l.remote, 'rev-parse', `${offered.commit}^{tree}`)).toBe(listCandidates(l.db(), run.id)[0]!.treeHash);

    const bodyFile = /--body-file (\S+)$/.exec(pr!)![1]!;
    const body = readFileSync(join(l.repo, bodyFile), 'utf8');
    expect(body).toContain(offered.commit);
    expect(body).toMatch(/Checks passed: lint, orbit-install, unit/);
    expect(body).toMatch(/Open review findings:\n- TEST-1 \(review 1, high, \w+\): The assertions do not establish[^\n]*\n- DOC-1 \(review 1, medium, \w+\): The README still describes/);
    // Nothing in the body is a local path or a secret: it is written for a pull request.
    expect(body).not.toContain(l.base);
    // Discarding it is the other command; until a person picks one, Orbit opened nothing.
    expect(offered.discard_command).toBe(`orbit cancel ${run.id}`);
    expect(l.github().state.prs).toEqual([]);
  }, 240_000);

  it('edge case, several passing candidates: the #156 replay ends BLOCKED and offers the newer of its two verified candidates (SC-001)', async () => {
    const l = lab();
    const asks = review('REPAIR_REQUIRED', [TEST_1, DOC_1]);
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')]), implementer([addAssertion('/nope/deepest')])], reviewer: [asks, asks, asks] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(listEvidenceReports(db, run.id).map((e) => e.report.verdict)).toEqual(['PASS', 'PASS']);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    // The third review answer is TEST-1's one re-review (still present), which spends the last review round.
    expect(done.outcomeReason).toMatch(/^review_rounds hard cap reached \(3 of 3\) with 2 open finding\(s\): TEST-1/);
    const [, newer] = listCandidates(db, run.id);
    expect(finalReport(l, run.id).verified_candidate).toMatchObject({ seq: 2, commit: newer!.commitSha });
    expect(l.github().state.prs).toEqual([]);
    assertRunInvariants(l, run.id);
  }, 300_000);
});
