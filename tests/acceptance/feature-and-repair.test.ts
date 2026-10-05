/**
 * Spec section 17, scenarios 1 and 2: a scoped feature passes with behaviour
 * tests, and a reproducible regression is repaired. The real controller
 * drives examples/demo-app with fake providers and delivers to FakeGitHub.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listCheckRuns, listEvidenceReports, listFailures } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { drive, git, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, REGRESSION_DIAGNOSIS, scenario, SRC_FIX_REGRESSION, SRC_REGRESSION, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

describe.skipIf(!READY)('acceptance: features and repairs', () => {
  it('scenario 1: a scoped feature passes with behaviour tests and is delivered as one draft PR of the reviewed tree', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const db = l.db();
    expect(transitions(db, run.id)).toEqual(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING', 'AWAITING_CI', 'SUCCEEDED']);
    // Behaviour tests: the trusted checks ran in a clean checkout of the candidate and passed.
    const [ev] = listEvidenceReports(db, run.id);
    expect(ev?.verdict).toBe('PASS');
    expect(ev!.report.checks.map((c) => [c.id, c.status])).toEqual(expect.arrayContaining([['lint', 'PASSED'], ['unit', 'PASSED']]));
    expect(ev!.report.acceptance_evidence).toEqual([expect.objectContaining({ criterion_id: 'AC-1', status: 'supported' })]);
    // Scope held: nothing outside the allowed paths, no weakening.
    expect(ev!.report.scope?.forbidden_paths_changed ?? []).toEqual([]);
    expect(ev!.report.scope?.weakening_signals ?? []).toEqual([]);
    // Independent review by the other provider, of exactly this tree.
    const reviews = listReviews(db, run.id);
    expect(reviews.map((r) => [r.provider, r.verdict, r.treeHash])).toEqual([['codex', 'APPROVE', ev!.treeHash]]);
    // One draft PR whose head carries the reviewed tree; the user's checkout is untouched.
    const gh = l.github().state;
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]).toMatchObject({ isDraft: true, headRefName: `orbit/${run.id}`, state: 'OPEN' });
    expect(git(l.remote, 'rev-parse', `refs/heads/orbit/${run.id}^{tree}`)).toBe(ev!.treeHash);
    expect(readFileSync(join(l.repo, 'src/server.ts'), 'utf8')).not.toContain(NOT_FOUND_TEXT);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(listDecisions(db, run.id).map((d) => d.kind)).toEqual(expect.arrayContaining(['route', 'planning.difficulty', 'planning.proof-map', 'gate.environment', 'gate.implementation', 'review.select', 'delivery.completed', 'gate.completion']));
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('scenario 2: a reproducible regression is diagnosed from the failing check and repaired in the next attempt', async () => {
    const l = lab();
    writeScenario(
      l,
      scenario({
        implementer: [implementer([SRC_REGRESSION, TEST_TEXT]), implementer([SRC_FIX_REGRESSION], { summary: 'Restored status 404; kept the new text.', changed: [['src/server.ts', 'modify']] })],
        verifier: [REGRESSION_DIAGNOSIS],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const db = l.db();
    const path = transitions(db, run.id);
    const firstVerify = path.indexOf('VERIFYING');
    expect(path.slice(firstVerify, firstVerify + 4)).toEqual(['VERIFYING', 'DIAGNOSING', 'REPAIRING', 'VERIFYING']);
    // Reproduced: the regression fails the trusted unit check on candidate 1, with a fingerprint and a preserved log.
    const reports = listEvidenceReports(db, run.id);
    expect(reports.map((r) => r.verdict)).toEqual(['FAIL', 'PASS']);
    const failed = listCheckRuns(db, { runId: run.id, checkId: 'unit' }).find((c) => c.candidateId === reports[0]!.candidateId && c.status === 'FAILED');
    expect(failed?.fingerprint).toBeTruthy();
    expect(existsSync(failed!.logPath!)).toBe(true);
    const failures = listFailures(db, run.id).filter((f) => f.candidateId === reports[0]!.candidateId);
    expect(failures.length).toBeGreaterThan(0);
    // Diagnosed: a read-only verifier wrote a brief for exactly that fingerprint, and the hypothesis is recorded.
    const brief = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-2.json'), 'utf8')) as { source: string; fingerprint: string; brief: { fingerprint: string; scoped_fix: string } };
    expect(brief.source).toBe('diagnosis');
    expect(brief.brief.fingerprint).toBe(brief.fingerprint);
    expect(failures.map((f) => f.fingerprint)).toContain(brief.fingerprint);
    expect(listDecisions(db, run.id).map((d) => d.kind)).toEqual(expect.arrayContaining(['repair.hypothesis', 'repair.brief']));
    // Repaired and reverified: the second tree passes, and only that tree was reviewed and delivered.
    expect(reports[1]!.treeHash).not.toBe(reports[0]!.treeHash);
    expect(listReviews(db, run.id, { includeInvalidated: true }).map((r) => r.treeHash)).toEqual([reports[1]!.treeHash]);
    expect(l.github().state.prs).toHaveLength(1);
    expect(git(l.remote, 'rev-parse', `refs/heads/orbit/${run.id}^{tree}`)).toBe(reports[1]!.treeHash);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    assertRunInvariants(l, run.id);
  }, 180_000);
});
