import { describe, expect, it } from 'vitest';
import { buildFinalReport } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { findingStoreId, recordReview, updateFindingStatus } from '../../../src/review/store.ts';
import { TREE_A, candidateOf, dbFixture, ingested, snapshotWithSecurity } from '../review/fixtures.ts';

function setup() {
  const fx = dbFixture();
  recordReview(
    fx.db,
    {
      id: 'rev-1',
      runId: 'run-1',
      candidateId: candidateOf(TREE_A),
      treeHash: TREE_A,
      round: 1,
      provider: 'codex',
      model: 'codex-alpha',
      workerId: null,
      verdict: 'REPAIR_REQUIRED',
      packetSha256: null,
      findings: [ingested({ externalId: 'ACC-1', claim: 'Export omits tenant scope.' }), ingested({ externalId: 'EXC-1', claim: 'Weak hash in legacy path.', category: 'security' })],
    },
    fx.clock,
  );
  return fx;
}

describe('final report residual risks for review findings', () => {
  it('lists unresolved accepted findings as blocking', () => {
    const { db, clock, runDir } = setup();
    updateFindingStatus(db, findingStoreId('rev-1', 'ACC-1'), { status: 'accepted', resolution: 'confirmed', resolutionJson: { evidence_refs: ['ev-1'] } }, clock);
    const r = buildFinalReport(db, getRun(db, 'run-1'), { runDir, clock });
    expect(r.residual_risks.some((x) => x.includes('ACC-1') && x.includes('accepted') && x.includes('blocking'))).toBe(true);
  });

  it('lists excepted findings with the exception reason and expiry', () => {
    const { db, clock, runDir } = setup();
    const snapshot = snapshotWithSecurity({ exceptions: [{ category: 'security', severities: ['high'], reason: 'legacy path is being removed', expires: '2027-01-31' }] });
    updateFindingStatus(
      db,
      findingStoreId('rev-1', 'EXC-1'),
      { status: 'excepted', resolution: 'waived', resolutionJson: { exception: { index: 0, category: 'security', location: null, reason: 'legacy path is being removed' } } },
      clock,
    );
    const r = buildFinalReport(db, getRun(db, 'run-1'), { runDir, clock, snapshot });
    const line = r.residual_risks.find((x) => x.includes('EXC-1'));
    expect(line).toContain('excepted');
    expect(line).toContain('legacy path is being removed');
    expect(line).toContain('expires: 2027-01-31');
  });
});
