import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { snapshotCandidate } from '../../../src/evidence/candidate.ts';
import { assertDeliverable, invalidateEvidence, isFresh, staleReasons } from '../../../src/evidence/freshness.ts';
import { buildEvidenceReport, saveEvidenceReport } from '../../../src/evidence/report.ts';
import { runChecks } from '../../../src/evidence/runner.ts';
import { currentEvidenceReport } from '../../../src/evidence/store.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { snapshotHash } from '../../../src/policy/snapshot.ts';
import { contract, CLEAN_SCOPE } from '../../unit/evidence/report-fixtures.ts';
import { checkDef, nodeCheck, sh, write } from '../../unit/evidence/fixtures.ts';
import { runnerEnv, type RunnerEnv } from './harness.ts';

const envs: RunnerEnv[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

/** Trusted checks, a real candidate, a persisted report, then a single byte changes. */
describe('evidence bound to the exact tree', () => {
  async function verified() {
    const e = await runnerEnv([
      // The tests check reads a file of the candidate, so its result depends on the tree.
      nodeCheck('tests', 'const s=require("fs").readFileSync("src/a.txt","utf8");if(!s.startsWith("one")){console.error("Error: unexpected content "+s);process.exit(1)}'),
      checkDef('lint', { command: ['node', '-e', 'process.exit(0)'] }),
    ]);
    envs.push(e);
    const c = contract({ task_id: 'ORB-007', policy_hash: e.run.policyHash, baseline_revision: e.r.base });
    const results = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['tests', 'lint'], parallelism: 2 });
    const report = buildEvidenceReport({ contract: c, candidate: e.candidate, checkResults: results, scope: CLEAN_SCOPE, snapshot: e.run.snapshot });
    const saved = saveEvidenceReport({ db: e.run.db, runDir: e.run.runDir, candidate: e.candidate, report, clock: systemClock });
    return { e, c, results, report, saved };
  }

  it('produces a PASS report, persisted in the database and in report.json', async () => {
    const { e, report, saved } = await verified();
    expect(report.verdict).toBe('PASS');
    expect(saved.reportPath).toBe(join(e.run.runDir, 'evidence', '1', 'report.json'));
    expect(JSON.parse(readFileSync(saved.reportPath!, 'utf8'))).toEqual(report);
    expect(currentEvidenceReport(e.run.db, e.run.runId, e.candidate.id)?.report).toEqual(report);
    expect(isFresh(report, { candidate: e.candidate, snapshot: e.run.snapshot })).toBe(true);
    expect(report.policy_hash).toBe(snapshotHash(e.run.snapshot));
  });

  it('turns stale when a single byte of the worktree changes, and the old evidence cannot deliver', async () => {
    const { e, report } = await verified();
    const wt = join(e.t.root, 'wt', 'w1');
    write(join(wt, 'src', 'a.txt'), 'one \n'); // one extra space
    const next = await snapshotCandidate({ db: e.run.db, clock: systemClock, repoRoot: e.r.repo, worktree: wt, runId: e.run.runId, baseRev: e.r.base, attempt: 2, workerId: 'w1' });
    expect(next.treeHash).not.toBe(e.candidate.treeHash);
    expect(isFresh(report, { candidate: next, snapshot: e.run.snapshot })).toBe(false);
    expect(staleReasons(report, { candidate: next, snapshot: e.run.snapshot })[0]).toContain('candidate tree changed');

    expect(invalidateEvidence(e.run.db, e.run.runId, `candidate ${next.id} replaced ${e.candidate.id}`, systemClock)).toBe(1);
    const rec = e.run.db.get<{ invalidated_reason: string }>('SELECT invalidated_reason FROM evidence_reports')!;
    expect(rec.invalidated_reason).toContain('replaced');
    expect(currentEvidenceReport(e.run.db, e.run.runId, e.candidate.id)).toBeNull();
    expect(() => assertDeliverable({ report, review: { treeHash: report.tree_hash, verdict: 'APPROVE' }, deliveryCommitTree: next.treeHash, invalidatedReason: rec.invalidated_reason })).toThrowError(expect.objectContaining({ code: 'STALE_EVIDENCE' }));
  });

  it('rejects results from the old tree when the report is rebuilt for the new candidate', async () => {
    const { e, c, results } = await verified();
    const wt = join(e.t.root, 'wt', 'w1');
    write(join(wt, 'src', 'a.txt'), 'one!\n');
    const next = await snapshotCandidate({ db: e.run.db, clock: systemClock, repoRoot: e.r.repo, worktree: wt, runId: e.run.runId, baseRev: e.r.base, attempt: 2, workerId: 'w1' });
    const rebuilt = buildEvidenceReport({ contract: c, candidate: next, checkResults: results, scope: CLEAN_SCOPE, snapshot: e.run.snapshot });
    expect(rebuilt.verdict).toBe('INCOMPLETE');
    expect(rebuilt.unverified).toContain('check tests: result is bound to a different candidate and was ignored');
  });

  it('delivers only when the delivery commit has exactly the tested tree', async () => {
    const { e, report } = await verified();
    const review = { treeHash: report.tree_hash, verdict: 'APPROVE' };
    // Delivery commits the reviewed tree with commit-tree: same tree, different commit.
    const delivery = sh(e.r.repo, 'commit-tree', e.candidate.treeHash, '-p', e.r.base, '-m', 'feat: acme change').trim();
    const deliveryTree = sh(e.r.repo, 'rev-parse', `${delivery}^{tree}`).trim();
    expect(() => assertDeliverable({ report, review, deliveryCommitTree: deliveryTree, current: { candidate: e.candidate, snapshot: e.run.snapshot } })).not.toThrow();
    // A hook, rebase or formatter that touches a file changes the tree.
    const wt = join(e.t.root, 'wt', 'w1');
    write(join(wt, 'src', 'a.txt'), 'one\n\n');
    const other = await snapshotCandidate({ db: e.run.db, clock: systemClock, repoRoot: e.r.repo, worktree: wt, runId: e.run.runId, baseRev: e.r.base, attempt: 2, workerId: 'w1' });
    expect(() => assertDeliverable({ report, review, deliveryCommitTree: other.treeHash })).toThrowError(/delivery commit has tree/);
  });

  it('records a failing test as FAIL with the failure fingerprint stored for non-progress detection', async () => {
    const { e, c } = await verified();
    const wt = join(e.t.root, 'wt', 'w1');
    write(join(wt, 'src', 'a.txt'), 'broken\n');
    const bad = await snapshotCandidate({ db: e.run.db, clock: systemClock, repoRoot: e.r.repo, worktree: wt, runId: e.run.runId, baseRev: e.r.base, attempt: 2, workerId: 'w1' });
    const { materializeCandidate, cleanupCandidateCheckout } = await import('../../../src/evidence/candidate.ts');
    const dir = await materializeCandidate(e.r.repo, bad.commitSha, join(e.t.root, 'checkout2'), { readOnly: false });
    try {
      const results = await runChecks({ ...e.ctx, checkoutDir: dir, candidate: bad, checkIds: ['tests', 'lint'] });
      const report = buildEvidenceReport({ contract: c, candidate: bad, checkResults: results, scope: CLEAN_SCOPE, snapshot: e.run.snapshot });
      expect(report.verdict).toBe('FAIL');
      expect(report.checks.find((x) => x.id === 'tests')).toMatchObject({ status: 'FAILED', exit_code: 1 });
      expect(results.find((r) => r.checkId === 'tests')!.fingerprint).toMatch(/^fp:/);
    } finally {
      await cleanupCandidateCheckout(e.r.repo, dir);
    }
  });
});
