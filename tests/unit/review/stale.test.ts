import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { resolveFindings } from '../../../src/review/resolve.ts';
import { getFinding, getReview, listFindings, listReviews, loadResolverState, persistResolution, recordReview, updateFindingStatus } from '../../../src/review/store.ts';
import { assertReviewGate, findStaleReviews, invalidateStaleReviews, isReviewCurrent, reviewGate } from '../../../src/review/stale.ts';
import { TREE_A, TREE_B, candidateOf, dbFixture, evidence, ingested, snapshotOf, snapshotWithSecurity } from './fixtures.ts';

const mk = (over: Partial<Parameters<typeof recordReview>[1]> = {}) => ({
  id: 'rev-1',
  runId: 'run-1',
  candidateId: candidateOf(over.treeHash),
  treeHash: TREE_A,
  round: 1,
  provider: 'codex',
  model: 'codex-alpha',
  workerId: null,
  verdict: 'APPROVE' as const,
  packetSha256: null,
  findings: [] as ReturnType<typeof ingested>[],
  ...over,
});

describe('isReviewCurrent', () => {
  it('holds only for the same tree and only while not invalidated', () => {
    expect(isReviewCurrent({ treeHash: TREE_A, invalidatedAt: null }, { treeHash: TREE_A })).toBe(true);
    expect(isReviewCurrent({ treeHash: TREE_A, invalidatedAt: null }, { treeHash: TREE_B })).toBe(false);
    expect(isReviewCurrent({ treeHash: TREE_A, invalidatedAt: 5 }, { treeHash: TREE_A })).toBe(false);
  });
});

describe('invalidateStaleReviews', () => {
  it('invalidates reviews bound to another tree, records why, and keeps the findings', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    recordReview(db, mk({ id: 'rev-2', treeHash: TREE_B, provider: 'claude' }), clock);
    expect(findStaleReviews(db, 'run-1', { treeHash: TREE_B }).map((r) => r.id)).toEqual(['rev-1']);

    clock.advance(1_000);
    const out = invalidateStaleReviews(db, { runId: 'run-1', runDir, current: { treeHash: TREE_B }, cause: 'repair candidate 2' }, clock);
    expect(out.map((r) => r.id)).toEqual(['rev-1']);
    expect(getReview(db, 'rev-1')!.invalidatedAt).toBe(clock.now());
    // The reason is a column of the row, not only an event payload.
    const reason = db.get<{ invalidated_reason: string | null }>("SELECT invalidated_reason FROM reviews WHERE id = 'rev-1'")!.invalidated_reason;
    expect(reason).toContain(`candidate tree is now ${TREE_B} (repair candidate 2)`);
    expect(getReview(db, 'rev-1')!.invalidatedReason).toBe(reason);
    expect(getReview(db, 'rev-2')!.invalidatedReason).toBeNull();
    expect(getReview(db, 'rev-2')!.invalidatedAt).toBeNull();
    expect(listReviews(db, 'run-1').map((r) => r.id)).toEqual(['rev-2']);
    expect(listReviews(db, 'run-1', { includeInvalidated: true }).map((r) => r.id)).toEqual(['rev-1', 'rev-2']);
    expect(listFindings(db, 'run-1', { reviewId: 'rev-1' })).toHaveLength(1);

    const ev = db.get<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'review.invalidated'")!;
    expect(JSON.parse(ev.data_json)).toMatchObject({ review_id: 'rev-1', tree_hash: TREE_A });
    expect(JSON.parse(ev.data_json).reason).toContain(`candidate tree is now ${TREE_B} (repair candidate 2)`);
    const dec = listDecisions(db, 'run-1', { kind: 'review.invalidated' });
    expect(dec).toHaveLength(1);
    expect(dec[0]!.data).toMatchObject({ current_tree: TREE_B, cause: 'repair candidate 2', reviews: [{ id: 'rev-1', tree_hash: TREE_A }] });
  });

  it('is idempotent and leaves current reviews alone', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk(), clock);
    expect(invalidateStaleReviews(db, { runId: 'run-1', runDir, current: { treeHash: TREE_A } }, clock)).toEqual([]);
    expect(listDecisions(db, 'run-1')).toEqual([]);
    expect(invalidateStaleReviews(db, { runId: 'run-1', runDir, current: { treeHash: TREE_B } }, clock)).toHaveLength(1);
    expect(invalidateStaleReviews(db, { runId: 'run-1', runDir, current: { treeHash: TREE_B } }, clock)).toEqual([]);
    expect(listDecisions(db, 'run-1', { kind: 'review.invalidated' })).toHaveLength(1);
  });
});

describe('reviewGate: policy exceptions are judged at gate time', () => {
  const T0 = 1_700_000_000_000;
  const HOUR = 3_600_000;
  const exception = (over: Record<string, unknown> = {}) => ({ category: 'authorization', severities: ['high'], reason: 'tenant model is replaced next quarter', location: null, expires: null, ...over });

  /** A review whose one finding was waived by the first exception, persisted the way the resolver does it. */
  function waived(exceptions: unknown[]) {
    const snap = snapshotWithSecurity({ block_severities: ['critical', 'high'], exceptions });
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    const state = loadResolverState(db, 'run-1', TREE_A);
    persistResolution(db, runDir, 'run-1', resolveFindings({ ...state, snapshot: snap, treeHash: TREE_A, evidence: [], now: clock.now() }), clock);
    expect(getFinding(db, state.findings[0]!.id)!.status).toBe('excepted');
    const gateAt = (now: number) => reviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snap, implementerProvider: 'claude', now });
    return { db, clock, snap, findingId: state.findings[0]!.id, gateAt };
  }

  it('lets a waived finding through while its exception is current', () => {
    const { gateAt } = waived([exception({ expires: new Date(T0 + HOUR).toISOString() })]);
    expect(gateAt(T0).ok).toBe(true);
  });

  it('stops honouring an exception that has expired, though the finding is still persisted as excepted', () => {
    const { db, findingId, gateAt } = waived([exception({ expires: new Date(T0 + HOUR).toISOString() })]);
    const res = gateAt(T0 + 2 * HOUR);
    expect(res.ok).toBe(false);
    expect(getFinding(db, findingId)!.status).toBe('excepted');
    expect(res.reasons.join(' ')).toMatch(/SEC-1 \(high, open\) blocks delivery \(its policy exception has expired or no longer covers it\)/);
    expect(res.reasons.join(' ')).toMatch(/1 of its finding\(s\) are unresolved/);
  });

  it('re-checks the exception location glob against the finding at gate time', () => {
    // The finding is at src/export.ts; an exception that only covers docs/** cannot waive it, whatever the row says.
    const snap = snapshotWithSecurity({ block_severities: ['critical', 'high'], exceptions: [exception({ location: 'docs/**' })] });
    const { db, clock } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    const id = loadResolverState(db, 'run-1', TREE_A).findings[0]!.id;
    updateFindingStatus(db, id, { status: 'excepted', resolution: 'asserted by hand', resolutionJson: { exception: { index: 0, category: 'authorization', location: 'docs/**', reason: 'x' } } }, clock);
    const res = reviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snap, implementerProvider: 'claude', now: clock.now() });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(' ')).toContain('no longer covers it');
  });

  it('does not honour a recorded exception that the frozen policy does not list', () => {
    const { db, clock } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    const id = loadResolverState(db, 'run-1', TREE_A).findings[0]!.id;
    updateFindingStatus(db, id, { status: 'excepted', resolution: 'asserted by hand', resolutionJson: { exception: { index: 3, category: 'authorization', reason: 'x' } } }, clock);
    expect(reviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snapshotOf(), implementerProvider: 'claude', now: clock.now() }).ok).toBe(false);
  });
});

describe('reviewGate', () => {
  const snap = snapshotOf();
  const gate = (db: Parameters<typeof reviewGate>[0], tree = TREE_A, implementerProvider = 'claude') => reviewGate(db, { runId: 'run-1', treeHash: tree, snapshot: snap, implementerProvider, now: 0 });

  it('fails with no review at all', () => {
    const { db } = dbFixture();
    expect(gate(db)).toMatchObject({ ok: false, reasons: [`no review of tree ${TREE_A}`] });
  });

  it('passes on a current independent APPROVE', () => {
    const { db, clock } = dbFixture();
    recordReview(db, mk(), clock);
    expect(gate(db)).toMatchObject({ ok: true, reasons: [] });
  });

  it('does not let a review of another tree authorize this one', () => {
    const { db, clock } = dbFixture();
    recordReview(db, mk(), clock);
    const res = gate(db, TREE_B);
    expect(res.ok).toBe(false);
    expect(res.reasons[0]).toContain('exist only for other trees and authorize nothing');
  });

  it('does not count an invalidated approval, even for its own tree', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk(), clock);
    invalidateStaleReviews(db, { runId: 'run-1', runDir, current: { treeHash: TREE_B } }, clock);
    expect(gate(db, TREE_A).ok).toBe(false);
  });

  it('is not cleared by a second reviewer approving over a first reviewer open claim', () => {
    const { db, clock } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    recordReview(db, mk({ id: 'rev-2', provider: 'claude' }), clock);
    const res = gate(db, TREE_A, 'someone-else');
    expect(res.ok).toBe(false);
    expect(res.reasons.join(' ')).toContain('1 of its finding(s) are unresolved (SEC-1 open)');
  });

  it('clears a REPAIR_REQUIRED review once every finding is closed by recorded evidence', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    const state = loadResolverState(db, 'run-1', TREE_A);
    const f = state.findings[0]!;
    persistResolution(db, runDir, 'run-1', resolveFindings({ ...state, snapshot: snap, treeHash: TREE_A, evidence: [evidence({ findingId: f.id })] }), clock);
    expect(getFinding(db, f.id)!.status).toBe('rejected');
    expect(gate(db)).toMatchObject({ ok: true });
  });

  it('does not clear a BLOCK review with only advisory findings, or with none', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk({ verdict: 'BLOCK', findings: [ingested({ severity: 'low', category: 'style', claim: 'Naming.' })] }), clock);
    const state = loadResolverState(db, 'run-1', TREE_A);
    persistResolution(db, runDir, 'run-1', resolveFindings({ ...state, snapshot: snap, treeHash: TREE_A, evidence: [] }), clock);
    expect(gate(db).ok).toBe(false);

    const other = dbFixture();
    recordReview(other.db, mk({ verdict: 'BLOCK' }), other.clock);
    expect(gate(other.db).reasons[0]).toContain('BLOCK with no findings to resolve');
  });

  it('is stopped by an unresolved blocking finding carried from an older tree', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    const s1 = loadResolverState(db, 'run-1', TREE_A);
    persistResolution(db, runDir, 'run-1', resolveFindings({ ...s1, snapshot: snap, treeHash: TREE_A, evidence: [evidence({ findingId: s1.findings[0]!.id, verdict: 'confirms', status: 'FAILED' })] }), clock);
    invalidateStaleReviews(db, { runId: 'run-1', runDir, current: { treeHash: TREE_B } }, clock);
    recordReview(db, mk({ id: 'rev-2', treeHash: TREE_B, provider: 'claude' }), clock);
    const res = gate(db, TREE_B, 'claude-impl');
    expect(res.ok).toBe(false);
    expect(res.reasons.join(' ')).toContain('SEC-1 (high, accepted) blocks delivery');

    // Evidence on the new tree that the claim no longer holds resolves it, and the tree clears.
    const s2 = loadResolverState(db, 'run-1', TREE_B);
    persistResolution(db, runDir, 'run-1', resolveFindings({ ...s2, snapshot: snap, treeHash: TREE_B, evidence: [evidence({ findingId: s1.findings[0]!.id, treeHash: TREE_B })] }), clock);
    expect(getFinding(db, s1.findings[0]!.id)!.status).toBe('resolved');
    expect(gate(db, TREE_B, 'claude-impl').ok).toBe(true);
  });

  it('requires an independent review when policy says so', () => {
    const { db, clock } = dbFixture();
    recordReview(db, mk({ provider: 'claude' }), clock);
    // review.when_unavailable: block, the default before decision 0007 (#6, #8) made it claude.
    const res = reviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snapshotOf((c) => void (c.review.when_unavailable = 'block')), implementerProvider: 'claude', now: 0 });
    expect(res.ok).toBe(false);
    expect(res.reasons[0]).toContain('independent review is required but every clearing review is from "claude"');
    // ask: a same-provider review clears only after a person's recorded yes.
    const asked = reviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snapshotOf((c) => void (c.review.when_unavailable = 'ask')), implementerProvider: 'claude', now: 0 });
    expect(asked.ok).toBe(false);
    expect(asked.reasons.join(' ')).toContain('no person approved a same-provider review (review.when_unavailable: ask)');
    expect(gate(db, TREE_A, 'claude').ok).toBe(true);
    expect(reviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snapshotOf((c) => { c.review.independent_provider_required = false; }), implementerProvider: 'claude', now: 0 }).ok).toBe(true);
  });

  it('assertReviewGate throws STALE_EVIDENCE with the reasons', () => {
    const { db } = dbFixture();
    try {
      assertReviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snap, now: 0 });
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'STALE_EVIDENCE')).toBe(true);
      expect((err as { details?: { reasons?: string[] } }).details?.reasons).toHaveLength(1);
    }
  });
});
