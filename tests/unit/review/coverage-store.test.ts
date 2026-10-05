import { describe, expect, it } from 'vitest';
import { getFinding, getReview, listFindings, listReviews, markReviewInvalidated, persistResolution, recordReview, updateFindingStatus, findingStoreId } from '../../../src/review/store.ts';
import type { Disposition, Resolution } from '../../../src/review/resolve.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { TREE_A, candidateOf, dbFixture, ingested } from './fixtures.ts';

const base = { runId: 'run-1', candidateId: candidateOf(TREE_A), treeHash: TREE_A, round: 1, provider: 'codex', model: 'codex-alpha', workerId: null, verdict: 'REPAIR_REQUIRED' as const, packetSha256: 'a'.repeat(64) };

describe('recordReview', () => {
  it('invents an id when none is given', () => {
    const { db, clock } = dbFixture();
    const r = recordReview(db, { ...base, findings: [ingested()] }, clock);
    expect(r.id).toMatch(/^rev-/);
    expect(getReview(db, r.id)).toEqual(r);
  });
});

describe('rows that do not read back', () => {
  it('a review with an unknown verdict, and findings with an unknown severity or status, are refused with INTERNAL', () => {
    const { db, clock } = dbFixture();
    const r = recordReview(db, { ...base, id: 'rev-1', findings: [ingested({ externalId: 'F-1' }), ingested({ externalId: 'F-2' })] }, clock);
    db.run("UPDATE findings SET severity = 'catastrophic' WHERE id = ?", findingStoreId(r.id, 'F-1'));
    db.run("UPDATE findings SET status = 'pondering' WHERE id = ?", findingStoreId(r.id, 'F-2'));
    expect(() => getFinding(db, findingStoreId(r.id, 'F-1'))).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('unknown severity catastrophic') }));
    expect(() => getFinding(db, findingStoreId(r.id, 'F-2'))).toThrow(expect.objectContaining({ code: 'INTERNAL', message: expect.stringContaining('unknown status pondering') }));
    db.run("UPDATE reviews SET verdict = 'MAYBE' WHERE id = ?", r.id);
    expect(() => getReview(db, r.id)).toThrow(expect.objectContaining({ code: 'INTERNAL', message: 'review rev-1 has unknown verdict MAYBE' }));
  });

  it('getFinding answers null for an id that does not exist', () => {
    const { db } = dbFixture();
    expect(getFinding(db, 'rev-x:nope')).toBeNull();
  });
});

describe('listReviews and markReviewInvalidated', () => {
  it('filters reviews by provider', () => {
    const { db, clock } = dbFixture();
    recordReview(db, { ...base, id: 'rev-codex', findings: [] }, clock);
    recordReview(db, { ...base, id: 'rev-claude', provider: 'claude', findings: [] }, clock);
    expect(listReviews(db, 'run-1', { provider: 'claude' }).map((r) => r.id)).toEqual(['rev-claude']);
    expect(listReviews(db, 'run-1', { provider: 'gemini' })).toEqual([]);
    expect(listReviews(db, 'run-1').map((r) => r.id)).toEqual(['rev-codex', 'rev-claude']);
  });

  it('refuses an unknown review, invalidates once with its reason, and answers false the second time', () => {
    const { db, clock } = dbFixture();
    recordReview(db, { ...base, id: 'rev-1', findings: [] }, clock);
    expect(() => markReviewInvalidated(db, 'rev-nope', 'x', clock)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    expect(markReviewInvalidated(db, 'rev-1', 'tree changed', clock)).toBe(true);
    expect(markReviewInvalidated(db, 'rev-1', 'again', clock)).toBe(false);
    expect(getReview(db, 'rev-1')).toMatchObject({ invalidatedReason: 'tree changed' });
    expect(db.all("SELECT 1 AS x FROM events WHERE type = 'review.invalidated'")).toHaveLength(1);
  });
});

describe('listFindings filters', () => {
  it('answers nothing for an empty status or severity list, and filters by severity', () => {
    const { db, clock } = dbFixture();
    recordReview(db, { ...base, id: 'rev-1', findings: [ingested({ externalId: 'H', severity: 'high' }), ingested({ externalId: 'L', severity: 'low' })] }, clock);
    expect(listFindings(db, 'run-1', { statuses: [] })).toEqual([]);
    expect(listFindings(db, 'run-1', { severities: [] })).toEqual([]);
    expect(listFindings(db, 'run-1', { severities: ['high'] }).map((f) => f.externalId)).toEqual(['H']);
    expect(listFindings(db, 'run-1', { severities: ['high', 'low'], statuses: ['open'], reviewId: 'rev-1' }).map((f) => f.externalId)).toEqual(['H', 'L']);
  });
});

describe('persistResolution', () => {
  const disposition = (over: Partial<Disposition>): Disposition => ({
    findingId: 'rev-1:A',
    memberIds: ['rev-1:A'],
    externalId: 'A',
    fingerprint: 'fp-1',
    severity: 'high',
    category: 'authorization',
    location: 'src/a.ts:1',
    claim: 'claim',
    status: 'accepted',
    blocking: true,
    reason: 'confirmed by a failing test',
    evidenceRefs: ['evidence/1/t.log'],
    security: false,
    exception: null,
    disagreement: null,
    carried: false,
    recurrenceOf: [],
    ...over,
  });
  const resolution = (dispositions: Disposition[]): Resolution => ({ treeHash: TREE_A, dispositions, blocking: [], repairBriefs: [], claims: [], claimsToTest: [], accepted: [], rejected: [], excepted: [], advisory: [] } as unknown as Resolution);

  it('leaves a finding that is already terminal as it is when the group ends up elsewhere, and names a finding without an external id by its store id', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, { ...base, id: 'rev-1', findings: [ingested({ externalId: 'A' }), ingested({ externalId: 'B' })] }, clock);
    updateFindingStatus(db, 'rev-1:B', { status: 'rejected', resolution: 'refuted', resolutionJson: { evidence_refs: ['evidence/1/refute.log'] } }, clock);
    db.run('UPDATE findings SET external_id = NULL WHERE id = ?', 'rev-1:A');
    const out = persistResolution(db, runDir, 'run-1', resolution([disposition({ externalId: null, memberIds: ['rev-1:A', 'rev-1:B'], status: 'accepted' })]), clock);
    expect(out.updated).toEqual(['rev-1:A']);
    expect(getFinding(db, 'rev-1:B')).toMatchObject({ status: 'rejected', resolution: 'refuted' });
    expect(getFinding(db, 'rev-1:A')).toMatchObject({ status: 'accepted', resolution: 'confirmed by a failing test' });
    const decisions = listDecisions(db, 'run-1');
    expect(decisions.map((d) => d.summary)).toEqual(['rev-1:A (high) accepted: confirmed by a failing test']);
  });

  it('refuses a disposition naming a finding that is not in the run', () => {
    const { db, clock, runDir } = dbFixture();
    recordReview(db, { ...base, id: 'rev-1', findings: [ingested({ externalId: 'A' })] }, clock);
    expect(() => persistResolution(db, runDir, 'run-1', resolution([disposition({ memberIds: ['rev-9:Z'] })]), clock)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
  });
});
