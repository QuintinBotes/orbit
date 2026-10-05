import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { readDecisionsMirror, listDecisions } from '../../../src/storage/decisions.ts';
import { resolveFindings } from '../../../src/review/resolve.ts';
import {
  findingStoreId,
  getFinding,
  getReview,
  listBlockingFindings,
  listFindings,
  listReviews,
  loadResolverState,
  persistResolution,
  recordReview,
  updateFindingStatus,
} from '../../../src/review/store.ts';
import { FINDING_STATUSES, REVIEW_VERDICTS, TERMINAL_FINDING_STATUSES, UNRESOLVED_FINDING_STATUSES } from '../../../src/review/types.ts';
import { TREE_A, TREE_B, candidateOf, dbFixture, evidence, ingested, snapshotOf } from './fixtures.ts';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}

const review = (over: Partial<Parameters<typeof recordReview>[1]> = {}) => ({
  id: 'rev-1',
  runId: 'run-1',
  candidateId: candidateOf(over.treeHash),
  treeHash: TREE_A,
  round: 1,
  provider: 'codex',
  model: 'codex-alpha',
  workerId: null,
  verdict: 'REPAIR_REQUIRED' as const,
  packetSha256: 'a'.repeat(64),
  findings: [ingested()],
  ...over,
});

describe('status vocabulary', () => {
  it('exports runtime arrays the knowledge extractor can import', () => {
    expect(FINDING_STATUSES).toContain('resolved');
    expect(REVIEW_VERDICTS).toEqual(['APPROVE', 'REPAIR_REQUIRED', 'BLOCK']);
    expect(TERMINAL_FINDING_STATUSES).toEqual(['rejected', 'resolved']);
    expect(UNRESOLVED_FINDING_STATUSES).toEqual(['open', 'claim_pending', 'accepted']);
  });
});

describe('recordReview', () => {
  it('stores the review and its findings (open) with an event', () => {
    const { db, clock } = dbFixture();
    const r = recordReview(db, review(), clock);
    expect(r).toMatchObject({ id: 'rev-1', treeHash: TREE_A, provider: 'codex', verdict: 'REPAIR_REQUIRED', invalidatedAt: null, packetSha256: 'a'.repeat(64) });
    const f = getFinding(db, findingStoreId('rev-1', 'SEC-1'))!;
    expect(f).toMatchObject({ reviewId: 'rev-1', externalId: 'SEC-1', severity: 'high', status: 'open', claim: 'Export omits tenant scope.', resolution: null });
    const ev = db.all<{ type: string }>("SELECT type FROM events WHERE type = 'review.recorded'");
    expect(ev).toHaveLength(1);
  });

  it('is idempotent for the same id and content, and refuses different content under that id', () => {
    const { db, clock } = dbFixture();
    recordReview(db, review(), clock);
    expect(recordReview(db, review(), clock).id).toBe('rev-1');
    expect(listFindings(db, 'run-1')).toHaveLength(1);
    expect(code(() => recordReview(db, review({ verdict: 'APPROVE' }), clock))).toBe('CONCURRENT_UPDATE');
  });

  it('rejects a tree that differs from the candidate row as stale evidence', () => {
    const { db, clock } = dbFixture();
    // cand-1 is recorded with TREE_A, so a review of TREE_B filed against it is stale.
    expect(code(() => recordReview(db, review({ treeHash: TREE_B, candidateId: 'cand-1' }), clock))).toBe('STALE_EVIDENCE');
    expect(listReviews(db, 'run-1')).toEqual([]);
    expect(recordReview(db, review({ treeHash: TREE_B }), clock).treeHash).toBe(TREE_B);
  });

  it('refuses a candidate id that is not in the candidates table', () => {
    const { db, clock } = dbFixture();
    let err: unknown;
    try {
      recordReview(db, { ...review(), candidateId: 'cand-missing' }, clock);
    } catch (e) {
      err = e;
    }
    expect(isOrbitError(err, 'NOT_FOUND')).toBe(true);
    expect((err as Error).message).toContain('cand-missing');
    expect(listReviews(db, 'run-1')).toEqual([]);
    expect(listFindings(db, 'run-1')).toEqual([]);
    expect(db.all("SELECT 1 FROM events WHERE type = 'review.recorded'")).toEqual([]);
  });

  it('rejects an unknown run, a bad round and a missing tree', () => {
    const { db, clock } = dbFixture();
    expect(code(() => recordReview(db, review({ runId: 'nope' }), clock))).toBe('NOT_FOUND');
    expect(code(() => recordReview(db, review({ round: 0 }), clock))).toBe('SCHEMA_INVALID');
    expect(code(() => recordReview(db, review({ treeHash: '' }), clock))).toBe('SCHEMA_INVALID');
    expect(code(() => recordReview(db, review({ verdict: 'MAYBE' as never }), clock))).toBe('SCHEMA_INVALID');
  });

  it('rolls back the review when a finding cannot be stored', () => {
    const { db, clock } = dbFixture();
    expect(code(() => recordReview(db, review({ findings: [ingested(), ingested()] }), clock))).toBeDefined();
    expect(getReview(db, 'rev-1')).toBeNull();
  });
});

describe('updateFindingStatus', () => {
  it('records the status with its reason and an event, and is a no-op on replay', () => {
    const { db, clock } = dbFixture();
    recordReview(db, review(), clock);
    const id = findingStoreId('rev-1', 'SEC-1');
    const a = updateFindingStatus(db, id, { status: 'claim_pending', resolution: 'awaiting a test', resolutionJson: { blocking: true } }, clock);
    expect(a).toMatchObject({ status: 'claim_pending', resolution: 'awaiting a test', resolutionJson: { blocking: true } });
    const n = db.all("SELECT 1 FROM events WHERE type = 'finding.status'").length;
    updateFindingStatus(db, id, { status: 'claim_pending', resolution: 'awaiting a test', resolutionJson: { blocking: true } }, clock);
    expect(db.all("SELECT 1 FROM events WHERE type = 'finding.status'")).toHaveLength(n);
  });

  it('requires a reason and a known status', () => {
    const { db, clock } = dbFixture();
    recordReview(db, review(), clock);
    const id = findingStoreId('rev-1', 'SEC-1');
    expect(code(() => updateFindingStatus(db, id, { status: 'rejected', resolution: ' ' }, clock))).toBe('SCHEMA_INVALID');
    expect(code(() => updateFindingStatus(db, id, { status: 'done' as never, resolution: 'x' }, clock))).toBe('SCHEMA_INVALID');
    expect(code(() => updateFindingStatus(db, 'missing', { status: 'claim_pending', resolution: 'x' }, clock))).toBe('NOT_FOUND');
  });

  it('never reopens a rejected or resolved finding', () => {
    const { db, clock } = dbFixture();
    recordReview(db, review(), clock);
    const id = findingStoreId('rev-1', 'SEC-1');
    updateFindingStatus(db, id, { status: 'rejected', resolution: 'refuted', resolutionJson: { evidence_refs: ['new_test t1 PASSED on tree aaa (log:1)'] } }, clock);
    expect(code(() => updateFindingStatus(db, id, { status: 'accepted', resolution: 'changed my mind' }, clock))).toBe('TRANSITION_INVALID');
    expect(getFinding(db, id)!.status).toBe('rejected');
  });
});

describe('persistResolution', () => {
  function setupResolved() {
    const fx = dbFixture();
    recordReview(fx.db, review({ findings: [ingested(), ingested({ externalId: 'COR-1', severity: 'low', category: 'style', location: 'src/a.ts:3', claim: 'Naming is inconsistent.', suggestedValidation: null })] }), fx.clock);
    return fx;
  }

  it('writes statuses with reasons and blocking flags, then one decision per decided claim', () => {
    const { db, clock, runDir } = setupResolved();
    const state = loadResolverState(db, 'run-1', TREE_A);
    expect(state.findings).toHaveLength(2);
    const sec = state.findings.find((f) => f.externalId === 'SEC-1')!;
    const res = resolveFindings({ ...state, snapshot: snapshotOf(), treeHash: TREE_A, evidence: [evidence({ findingId: sec.id })] });
    const { updated } = persistResolution(db, runDir, 'run-1', res, clock);
    expect(updated).toHaveLength(2);

    expect(getFinding(db, sec.id)).toMatchObject({ status: 'rejected' });
    expect(getFinding(db, sec.id)!.resolution).toContain('refuted by recorded evidence');
    expect(getFinding(db, sec.id)!.resolutionJson).toMatchObject({ blocking: false, tree_hash: TREE_A, evidence_refs: [expect.stringContaining('cross-tenant')] });
    expect(getFinding(db, findingStoreId('rev-1', 'COR-1'))).toMatchObject({ status: 'advisory' });

    const decisions = listDecisions(db, 'run-1', { kind: 'review.finding.rejected' });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.data).toMatchObject({ status: 'rejected', tree_hash: TREE_A, finding_ids: [sec.id] });
    expect(readDecisionsMirror(runDir).filter((d) => d.kind === 'review.finding.rejected')).toHaveLength(1);
    // Advisory findings are recorded on the finding, not as decisions.
    expect(listDecisions(db, 'run-1').map((d) => d.kind)).toEqual(['review.finding.rejected']);
  });

  it('is idempotent when replayed', () => {
    const { db, clock, runDir } = setupResolved();
    const state = loadResolverState(db, 'run-1', TREE_A);
    const res = resolveFindings({ ...state, snapshot: snapshotOf(), treeHash: TREE_A, evidence: [] });
    persistResolution(db, runDir, 'run-1', res, clock);
    const again = persistResolution(db, runDir, 'run-1', resolveFindings({ ...loadResolverState(db, 'run-1', TREE_A), snapshot: snapshotOf(), treeHash: TREE_A, evidence: [] }), clock);
    expect(again.updated).toEqual([]);
    expect(listDecisions(db, 'run-1')).toHaveLength(0);
  });

  it('lists unresolved blocking findings from the persisted flag', () => {
    const { db, clock, runDir } = setupResolved();
    // Never analysed: the severity rule applies.
    expect(listBlockingFindings(db, 'run-1').map((f) => f.externalId)).toEqual(['SEC-1']);
    const state = loadResolverState(db, 'run-1', TREE_A);
    const sec = state.findings.find((f) => f.externalId === 'SEC-1')!;
    // SEC-1 is a security finding, so review.security.block_severities decides whether a high one blocks.
    const snap = snapshotOf((c) => {
      c.review.block_unresolved_high_impact_findings = false;
      c.review.security.block_severities = ['critical'];
    });
    persistResolution(db, runDir, 'run-1', resolveFindings({ ...state, snapshot: snap, treeHash: TREE_A, evidence: [] }), clock);
    expect(getFinding(db, sec.id)!.status).toBe('claim_pending');
    expect(listBlockingFindings(db, 'run-1')).toEqual([]);
  });

  it('records an accepted finding as a decision and keeps it blocking', () => {
    const { db, clock, runDir } = setupResolved();
    const state = loadResolverState(db, 'run-1', TREE_A);
    const sec = state.findings.find((f) => f.externalId === 'SEC-1')!;
    persistResolution(db, runDir, 'run-1', resolveFindings({ ...state, snapshot: snapshotOf(), treeHash: TREE_A, evidence: [evidence({ findingId: sec.id, verdict: 'confirms', status: 'FAILED' })] }), clock);
    expect(getFinding(db, sec.id)).toMatchObject({ status: 'accepted' });
    expect(listBlockingFindings(db, 'run-1')).toHaveLength(1);
    expect(listDecisions(db, 'run-1', { kind: 'review.finding.accepted' })).toHaveLength(1);
  });

  it('refuses an unknown finding without partial writes', () => {
    const { db, clock, runDir } = setupResolved();
    const state = loadResolverState(db, 'run-1', TREE_A);
    const res = resolveFindings({ ...state, snapshot: snapshotOf(), treeHash: TREE_A, evidence: [] });
    res.dispositions[0]!.memberIds.push('ghost');
    expect(code(() => persistResolution(db, runDir, 'run-1', res, clock))).toBe('NOT_FOUND');
    expect(listFindings(db, 'run-1').every((f) => f.status === 'open')).toBe(true);
  });
});

describe('loadResolverState', () => {
  it('splits current-tree findings from earlier ones and excludes invalidated reviews from current', () => {
    const { db, clock } = dbFixture();
    recordReview(db, review(), clock);
    recordReview(db, review({ id: 'rev-2', treeHash: TREE_B, provider: 'claude', verdict: 'APPROVE', findings: [] }), clock);
    const s = loadResolverState(db, 'run-1', TREE_B);
    expect(s.reviews).toEqual([{ id: 'rev-2', provider: 'claude', verdict: 'APPROVE', treeHash: TREE_B }]);
    expect(s.findings).toEqual([]);
    expect(s.previousFindings).toHaveLength(1);
    expect(s.previousFindings[0]).toMatchObject({ provider: 'codex', treeHash: TREE_A, status: 'open' });
  });
});
