import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { assertDeliverable, invalidateEvidence, isFresh, staleReasons } from '../../../src/evidence/freshness.ts';
import { buildEvidenceReport } from '../../../src/evidence/report.ts';
import { currentEvidenceReport, insertEvidenceReport, listEvidenceReports } from '../../../src/evidence/store.ts';
import { snapshotHash } from '../../../src/policy/snapshot.ts';
import { openDb } from '../../../src/storage/db.ts';
import { checkDef } from './fixtures.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result, standardChecks } from './report-fixtures.ts';

const snapshot = fakeSnapshot(standardChecks());
const report = () => buildEvidenceReport({ contract: contract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot });
const ctx = { candidate: CANDIDATE, snapshot };

describe('isFresh and staleReasons', () => {
  it('is fresh when tree, check configuration and policy all match', () => {
    expect(isFresh(report(), ctx)).toBe(true);
    expect(staleReasons(report(), ctx)).toEqual([]);
  });

  it('is stale, with a precise reason, when a single byte of the tree changes', () => {
    const changed = { ...ctx, candidate: { ...CANDIDATE, treeHash: 'tree-b' } };
    expect(isFresh(report(), changed)).toBe(false);
    expect(staleReasons(report(), changed)).toEqual(['candidate tree changed: evidence is for tree-a, current tree is tree-b']);
  });

  it('is stale when a check definition changes', () => {
    const edited = fakeSnapshot([checkDef('tests', { timeout_seconds: 5 }), checkDef('lint')]);
    const reasons = staleReasons(report(), { ...ctx, snapshot: edited });
    expect(reasons).toContain('check configuration changed since the checks ran');
    expect(reasons.some((r) => r.startsWith('policy snapshot changed'))).toBe(true);
  });

  it('is stale when only the policy changed, and names both hashes', () => {
    const other = fakeSnapshot(standardChecks(), (c) => {
      c.scope.allowed_paths = ['everything/**'];
    });
    const reasons = staleReasons(report(), { ...ctx, snapshot: other });
    expect(reasons).toEqual([`policy snapshot changed: evidence used ${snapshotHash(snapshot)}, current is ${snapshotHash(other)}`]);
  });

  it('is stale for a report of another run, and reports every reason at once', () => {
    const r = { ...report(), run_id: 'orb-other' };
    expect(staleReasons(r, { candidate: { ...CANDIDATE, treeHash: 'tree-z' }, snapshot })).toHaveLength(2);
  });
});

describe('invalidateEvidence', () => {
  function setup() {
    const clock = new ManualClock();
    const db = openDb(':memory:');
    createRun(db, { id: CANDIDATE.runId, repoRoot: '/repo', goal: 'g', mode: 'autonomous', policyHash: snapshotHash(snapshot), policyPath: '/p' }, clock);
    return { db, clock };
  }

  it('marks every live report stale with the reason and logs one event, leaving earlier reasons alone', () => {
    const { db, clock } = setup();
    const a = insertEvidenceReport(db, { candidateId: 'cand-1', report: report(), reportPath: null }, clock);
    clock.advance(10);
    expect(invalidateEvidence(db, CANDIDATE.runId, 'candidate changed', clock)).toBe(1);
    const b = insertEvidenceReport(db, { candidateId: 'cand-2', report: { ...report(), tree_hash: 'tree-b' }, reportPath: null }, clock);
    expect(currentEvidenceReport(db, CANDIDATE.runId, 'cand-1')).toBeNull();
    clock.advance(10);
    expect(invalidateEvidence(db, CANDIDATE.runId, 'config changed', clock)).toBe(1);
    const rows = listEvidenceReports(db, CANDIDATE.runId);
    expect(rows.map((r) => [r.id, r.invalidatedReason])).toEqual([[a.id, 'candidate changed'], [b.id, 'config changed']]);
    expect(rows[0]!.invalidatedAt).toBeLessThan(rows[1]!.invalidatedAt!);
    expect(db.all("SELECT type FROM events WHERE type = 'evidence.invalidated'")).toHaveLength(2);
    expect(invalidateEvidence(db, CANDIDATE.runId, 'again', clock)).toBe(0);
    expect(db.all("SELECT type FROM events WHERE type = 'evidence.invalidated'")).toHaveLength(2);
  });

  it('can spare the report for the tree that is still current', () => {
    const { db, clock } = setup();
    insertEvidenceReport(db, { candidateId: 'cand-1', report: report(), reportPath: null }, clock);
    insertEvidenceReport(db, { candidateId: 'cand-2', report: { ...report(), tree_hash: 'tree-b' }, reportPath: null }, clock);
    expect(invalidateEvidence(db, CANDIDATE.runId, 'superseded', clock, { exceptTreeHash: 'tree-b' })).toBe(1);
    expect(currentEvidenceReport(db, CANDIDATE.runId, 'cand-2')).not.toBeNull();
  });

  it('can spare a PASS, which a change to what is excused cannot alter, and stale only the verdicts it could', () => {
    const { db, clock } = setup();
    insertEvidenceReport(db, { candidateId: 'cand-1', report: { ...report(), verdict: 'FAIL' }, reportPath: null }, clock);
    insertEvidenceReport(db, { candidateId: 'cand-2', report: { ...report(), tree_hash: 'tree-b', verdict: 'INCOMPLETE' }, reportPath: null }, clock);
    insertEvidenceReport(db, { candidateId: 'cand-3', report: { ...report(), tree_hash: 'tree-c', verdict: 'PASS' }, reportPath: null }, clock);
    expect(invalidateEvidence(db, CANDIDATE.runId, 'the contract now excuses a failure', clock, { exceptVerdict: 'PASS' })).toBe(2);
    expect(currentEvidenceReport(db, CANDIDATE.runId, 'cand-1')).toBeNull();
    expect(currentEvidenceReport(db, CANDIDATE.runId, 'cand-2')).toBeNull();
    expect(currentEvidenceReport(db, CANDIDATE.runId, 'cand-3')?.verdict).toBe('PASS');
  });
});

describe('assertDeliverable', () => {
  const approve = { treeHash: 'tree-a', verdict: 'APPROVE' };
  const reason = (fn: () => void): string | undefined => {
    try {
      fn();
    } catch (err) {
      expect(err).toMatchObject({ code: 'STALE_EVIDENCE' });
      return (err as Error).message;
    }
    return undefined;
  };

  it('accepts a fresh PASS whose review and delivery commit have exactly the evidence tree', () => {
    expect(reason(() => assertDeliverable({ report: report(), review: approve, deliveryCommitTree: 'tree-a', current: ctx }))).toBeUndefined();
  });

  it('refuses when the delivery commit has a different tree, saying why', () => {
    const msg = reason(() => assertDeliverable({ report: report(), review: approve, deliveryCommitTree: 'tree-x' }));
    expect(msg).toContain('delivery commit has tree tree-x');
    expect(msg).toContain('tree-a');
    expect(msg).toContain('hooks, rebases or generated files');
  });

  it('refuses a review of another tree, a missing review and a non-approving review', () => {
    expect(reason(() => assertDeliverable({ report: report(), review: { ...approve, treeHash: 'tree-old' }, deliveryCommitTree: 'tree-a' }))).toContain('review covered tree tree-old');
    expect(reason(() => assertDeliverable({ report: report(), review: null, deliveryCommitTree: 'tree-a' }))).toContain('no review');
    expect(reason(() => assertDeliverable({ report: report(), review: { ...approve, verdict: 'REQUEST_CHANGES' }, deliveryCommitTree: 'tree-a' }))).toContain('REQUEST_CHANGES');
  });

  it('refuses evidence that is not PASS or was invalidated', () => {
    expect(reason(() => assertDeliverable({ report: { ...report(), verdict: 'INCOMPLETE' }, review: approve, deliveryCommitTree: 'tree-a' }))).toContain('INCOMPLETE');
    expect(reason(() => assertDeliverable({ report: report(), review: approve, deliveryCommitTree: 'tree-a', invalidatedReason: 'candidate changed' }))).toContain('invalidated: candidate changed');
  });

  it('refuses stale evidence when the current state is supplied', () => {
    const msg = reason(() => assertDeliverable({ report: report(), review: approve, deliveryCommitTree: 'tree-a', current: { candidate: { ...CANDIDATE, treeHash: 'tree-b' }, snapshot } }));
    expect(msg).toContain('evidence is stale');
    expect(msg).toContain('candidate tree changed');
  });
});
