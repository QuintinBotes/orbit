/**
 * Spec section 17, scenarios 5 and 6: weak tests are rejected despite green
 * status (spec sections 10 and 11: green is not proof), and repeated
 * non-progress terminates (spec section 7 stop logic) instead of spending
 * the budget on equivalent attempts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listEvidenceReports, listFailures } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { drive, git, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { diagnosis, GOAL, implementer, NOT_FOUND_TEXT, scenario, SRC_REGRESSION, SRC_TEXT, TEST_TEXT, TEST_WEAKENED, type Edit } from './helpers/scenarios.ts';
import { assertRunInvariants, eventData, events, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

/** The second attempt restores the deleted assertions and asserts the new text. */
const TEST_RESTORED: Edit = {
  op: 'replace',
  path: 'tests/unit/server.test.ts',
  find: TEST_WEAKENED.replace!,
  replace: `    assert.equal(handle('/nope', new URLSearchParams()).status, 404);\n    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n    assert.equal(handle('/static/../server.ts', new URLSearchParams()).status, 404);\n`,
};

describe.skipIf(!READY)('acceptance: proof and progress', () => {
  it('scenario 5: green checks over weakened tests are rejected as proof; only the strengthened tree is reviewed and delivered', async () => {
    const l = lab();
    writeScenario(
      l,
      scenario({
        implementer: [implementer([SRC_TEXT, TEST_WEAKENED], { summary: 'Changed the text; simplified the 404 test.' }), implementer([TEST_RESTORED], { summary: 'Restored the 404 assertions and asserted the text.' })],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    const db = l.db();
    const reports = listEvidenceReports(db, run.id);
    // The weak candidate was green...
    expect(reports[0]!.report.checks.filter((c) => c.id === 'unit' || c.id === 'lint').map((c) => c.status)).toEqual(['PASSED', 'PASSED']);
    // ...and still not accepted: the weakening was seen in the diff and sent to the Inquisition, not to review.
    const signals = reports[0]!.report.scope?.weakening_signals ?? [];
    expect(signals).toEqual(expect.arrayContaining([expect.objectContaining({ path: 'tests/unit/server.test.ts', signal: 'assertion-removed' })]));
    const path = transitions(db, run.id);
    const firstVerify = path.indexOf('VERIFYING');
    expect(path[firstVerify + 1]).toBe('INQUISITION');
    const entered = events(db, run.id, 'state.transition').find((e) => e.to_state === 'INQUISITION')!;
    expect(eventData<{ data: { trigger: { kind: string; mode: string } } }>(entered).data.trigger).toMatchObject({ kind: 'oracle_weakening', mode: 'challenge' });
    const challenge = events(db, run.id, 'inquisition.completed').map((e) => eventData<{ reject_green: boolean }>(e));
    expect(challenge[0]?.reject_green).toBe(true);
    // The weak tree was never reviewed, delivered or pushed.
    const weakTree = reports[0]!.treeHash;
    expect(listReviews(db, run.id, { includeInvalidated: true }).map((r) => r.treeHash)).not.toContain(weakTree);
    // The strengthened attempt carries the assertions and is what completed.
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const final = reports.at(-1)!;
    expect(final.treeHash).not.toBe(weakTree);
    expect(final.report.scope?.weakening_signals ?? []).toEqual([]);
    const delivered = git(l.remote, 'show', `refs/heads/orbit/${run.id}:tests/unit/server.test.ts`);
    expect(delivered).toContain("assert.equal(handle('/nope', new URLSearchParams()).status, 404);");
    expect(delivered).toContain(NOT_FOUND_TEXT);
    const brief = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-2.json'), 'utf8')) as { fingerprint: string; brief: { preserved_constraints: string[] } };
    expect(brief.fingerprint).toMatch(/^proof:/);
    expect(brief.brief.preserved_constraints.join(' ')).toMatch(/Never remove assertions/);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('scenario 6: attempts that keep failing the same way without progress end the run EXHAUSTED before the hard cap, with artifacts preserved', async () => {
    const l = lab();
    // Every attempt touches a note but leaves the same regression in place. Each diagnosis offers a new
    // hypothesis, so only the absence of measurable progress can stop the loop.
    const causes = ['the not-found branch returns status 200 instead of 404', 'the router matches /nope as a static asset and answers 200', 'the response writer overrides the status with 200 for plain text', 'a default status of 200 is applied before the branch runs', 'the handler caches the first status it computed'];
    const diagnoses = causes.map((h, i) => diagnosis({ evidence: "tests/unit/server.test.ts 'answers 404 for anything else': expected 404, got 200", hypothesis: h, alternative: `cause ${i + 1} elsewhere in the request pipeline`, experiment: `Call handle('/nope') and inspect step ${i + 1} of the pipeline`, expected: `step ${i + 1} shows status 200`, fix: `Correct step ${i + 1} in src/server.ts` }));
    const stuck = (k: number): object => implementer([{ op: 'write', path: `tests/unit/attempt-${k}.txt`, content: `attempt ${k}\n` }], { summary: `attempt ${k}: adjusted the handler`, changed: [['src/server.ts', 'modify']] });
    writeScenario(
      l,
      scenario({
        implementer: [implementer([SRC_REGRESSION, TEST_TEXT]), stuck(2), stuck(3), stuck(4), stuck(5), stuck(6)],
        verifier: diagnoses,
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    const db = l.db();
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/no extension: no measurable progress/);
    // The repeated equivalent failure went to the Inquisition (diagnose mode) before the stop.
    const path = transitions(db, run.id);
    expect(path).toContain('INQUISITION');
    const inquiry = events(db, run.id, 'inquisition.completed').map((e) => eventData<{ trigger: string; mode: string }>(e));
    expect(inquiry).toEqual([expect.objectContaining({ trigger: 'repeated_failure', mode: 'diagnose' })]);
    // It stopped on evidence of non-progress, not by running into the hard cap.
    const attempts = db.get<{ used: number; hard_cap: number }>("SELECT used, hard_cap FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", run.id)!;
    expect(attempts.used).toBeLessThan(attempts.hard_cap);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' }).length).toBe(attempts.used);
    // Every attempt failed with the same fingerprint.
    const reports = listEvidenceReports(db, run.id);
    expect(reports.every((r) => r.verdict === 'FAIL')).toBe(true);
    const fps = new Set(listFailures(db, run.id).filter((f) => f.candidateId !== null && f.source !== 'baseline').map((f) => f.fingerprint));
    expect(fps.size).toBe(1);
    // The stop is a recorded decision with its reason; more tokens or a larger diff did not count as progress.
    const denied = listDecisions(db, run.id, { kind: 'allowance.deny' });
    expect(denied).toHaveLength(1);
    expect(denied[0]!.data).toMatchObject({ counter: 'implementation_attempts', decision: 'deny_extension', within_hard_limits: true });
    expect(listDecisions(db, run.id, { kind: 'allowance.extend' })).toEqual([]);
    // Nothing left the repository; the evidence and the worktree are preserved for a person.
    expect(l.github().state.prs).toEqual([]);
    expect(existsSync(reports.at(-1)!.reportPath!)).toBe(true);
    expect(existsSync(done.worktreePath!)).toBe(true);
    expect(readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8')).toMatch(/EXHAUSTED[\s\S]*preserved/);
    assertRunInvariants(l, run.id);
  }, 240_000);
});
