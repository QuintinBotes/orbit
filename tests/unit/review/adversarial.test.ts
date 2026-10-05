import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { resolveFindings } from '../../../src/review/resolve.ts';
import { recordReview, updateFindingStatus, listFindings } from '../../../src/review/store.ts';
import { invalidateStaleReviews, reviewGate } from '../../../src/review/stale.ts';
import { TREE_A, TREE_B, candidateOf, dbFixture, ingested, rfinding, snapshotOf, snapshotWithSecurity } from './fixtures.ts';

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : `non-orbit: ${String(err)}`;
  }
  return undefined;
}
const mk = (over: Partial<Parameters<typeof recordReview>[1]> = {}) => ({ id: 'rev-1', runId: 'run-1', candidateId: candidateOf(over.treeHash), treeHash: TREE_A, round: 1, provider: 'claude', model: 'm', workerId: null, verdict: 'APPROVE' as const, packetSha256: null, findings: [] as ReturnType<typeof ingested>[], ...over });

describe('adversarial: security exception expiry fails closed', () => {
  it('does not honour a dated exception when no clock reading is supplied', () => {
    const snap = snapshotWithSecurity({ exceptions: [{ category: 'authorization', severities: ['high'], reason: 'known', expires: '2020-01-01' }] });
    const r = resolveFindings({ findings: [rfinding({ category: 'authorization', severity: 'high' })], snapshot: snap, evidence: [], treeHash: TREE_A });
    expect(r.excepted).toHaveLength(0);
    expect(r.blocking).toHaveLength(1);
  });
});

describe('adversarial: the review gate cannot show independence it does not know', () => {
  it('fails when independent review is required and the implementer provider is not supplied', () => {
    const { db, clock } = dbFixture();
    recordReview(db, mk(), clock);
    const res = reviewGate(db, { runId: 'run-1', treeHash: TREE_A, snapshot: snapshotOf(), now: clock.now() });
    expect(res.ok).toBe(false);
    expect(res.reasons.join(' ')).toMatch(/implementer provider was not supplied/);
  });
});

describe('adversarial: findings are closed only by recorded evidence', () => {
  it('refuses to reject, resolve or except a finding by assertion', () => {
    const { db, clock } = dbFixture();
    recordReview(db, mk({ verdict: 'REPAIR_REQUIRED', findings: [ingested()] }), clock);
    const id = listFindings(db, 'run-1')[0]!.id;
    for (const status of ['rejected', 'resolved', 'excepted'] as const) {
      expect(code(() => updateFindingStatus(db, id, { status, resolution: 'trust me' }, clock))).toBe('SCHEMA_INVALID');
      expect(code(() => updateFindingStatus(db, id, { status, resolution: 'trust me', resolutionJson: { evidence_refs: [] } }, clock))).toBe('SCHEMA_INVALID');
    }
    expect(listFindings(db, 'run-1')[0]!.status).toBe('open');
  });
});

describe('adversarial: recordReview validates findings before they are stored', () => {
  it('rejects an unknown severity, which would make every later read throw', () => {
    const { db, clock } = dbFixture();
    expect(code(() => recordReview(db, mk({ findings: [ingested({ severity: 'severe' as never })] }), clock))).toBe('SCHEMA_INVALID');
    expect(listFindings(db, 'run-1')).toEqual([]);
  });
  it('rejects a repeated finding id within one review with a typed error', () => {
    const { db, clock } = dbFixture();
    expect(code(() => recordReview(db, mk({ findings: [ingested(), ingested()] }), clock))).toBe('SCHEMA_INVALID');
  });
});

describe('adversarial: invalidation records its decision before it acts', () => {
  it('finishes the invalidation and keeps one decision when replayed after the decision was written', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, mk(), clock);
    const input = { runId: 'run-1', runDir, current: { treeHash: TREE_B } };
    // The crash state: decision on record, review not yet invalidated.
    invalidateStaleReviews(db, input, clock);
    db.run('UPDATE reviews SET invalidated_at = NULL');
    const again = invalidateStaleReviews(db, input, clock);
    expect(again).toHaveLength(1);
    expect(listDecisions(db, 'run-1').filter((d) => d.kind === 'review.invalidated')).toHaveLength(1);
  });
});
