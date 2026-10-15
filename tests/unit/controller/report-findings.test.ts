import { describe, expect, it } from 'vitest';
import { buildFinalReport, renderMarkdown } from '../../../src/controller/report.ts';
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

describe('final report text for a long review finding', () => {
  const long = 'The fail-before evidence for AC-1, AC-2 and AC-3 shows only a load failure. It does not show that any assertion about the criteria failed. The new tests depend on the missing method and nothing else, so a stub that compiles would make them fail differently.';

  it('cuts the residual risk line at a word with an ellipsis and keeps the whole claim in the report', () => {
    const { db, clock, runDir } = setup();
    recordReview(
      db,
      { id: 'rev-2', runId: 'run-1', candidateId: candidateOf(TREE_A), treeHash: TREE_A, round: 2, provider: 'codex', model: 'codex-alpha', workerId: null, verdict: 'REPAIR_REQUIRED', packetSha256: null, findings: [ingested({ externalId: 'TEST-1', claim: long })] },
      clock,
    );
    const r = buildFinalReport(db, getRun(db, 'run-1'), { runDir, clock });
    const line = r.residual_risks.find((x) => x.includes('TEST-1'))!;
    expect(line).not.toMatch(/about th(\.\.\.)?$/);
    expect(line.endsWith('...')).toBe(true);
    const kept = line.slice(line.indexOf('The fail-before'), -3);
    expect(long.startsWith(kept)).toBe(true);
    expect(/[\s,;:]/.test(long[kept.length]!)).toBe(true);
    expect(r.review_findings?.find((f) => f.id === 'TEST-1')?.claim).toBe(long);
    expect(renderMarkdown(r)).toContain(`TEST-1 (high, open): ${long}`);
  });
});
