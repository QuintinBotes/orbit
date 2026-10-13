// A review finding whose subject is Orbit's own recorded evidence classification (ADR 0014, 0.3.1 addendum, item 3). In
// the 0.3.0 retest a reviewer raised, on the base-revision fail-before outcome Orbit had already recorded, "the
// fail-before evidence shows only a load failure" as a high finding. Orbit made it claim_pending and blocking and sent it
// to repair (dotnet runs orb-20261013-083016-84a30d and orb-20261013-083337-df06a4) or to the Inquisition (python run
// orb-20261013-080355-6ac27f). A repair cannot change the base revision, so the repair reproduced the same tree and the
// run ended EXHAUSTED.
//
// Whether a finding is such a dispute is structure, not wording: the reviewer files it under the category
// evidence-classification, and a finding becomes a note if and only if it has that category and no check confirms it.
// The resolver never reads the claim to decide it. Three rounds of adversarial review showed that matching English,
// however tightened, can silence a real defect, so the claims below block in any other category.
import { describe, expect, it } from 'vitest';
import { resolveFindings, type ResolveInput } from '../../../src/review/resolve.ts';
import { EVIDENCE_CLASSIFICATION_CATEGORY } from '../../../src/review/types.ts';
import { TREE_A, evidence, rfinding, rreview, snapshotOf } from './fixtures.ts';

/** The dotnet run's TEST-1, verbatim, filed as the reviewer brief now asks. */
const DOTNET_TEST_1 = {
  externalId: 'TEST-1',
  severity: 'high' as const,
  category: 'evidence-classification',
  location: 'tests/Acme.Tests/CalculatorTests.cs:23',
  claim: 'The fail-before evidence for AC-1, AC-2 and AC-3 shows only a load failure. It does not show that any assertion about the criteria failed. The new tests depend on Clamp existing, but the probe does not prove that they check its behavior.',
  evidence: "In evidence/1/fail-before/unit-tests~1.log, the only errors are CS1061 at CalculatorTests.cs(23,49) and (27,68), saying 'Calculator' does not contain a definition for 'Clamp'. The test project did not compile, so no assertion ran on the base revision.",
  suggestedValidation: 'Rerun the fail-before probe on the base revision with a stub Clamp that compiles but behaves wrongly, for example one that returns value and never throws.',
};

/** Claims the retest reviewers wrote about the probe outcome (python, demo ui and dotnet runs). */
const DISPUTES = [
  DOTNET_TEST_1.claim,
  'The fail-before evidence for AC-1, AC-2 and AC-3 comes only from a load failure. It shows the new tests depend on Clamp existing, not that their assertions check the clamping or throwing behavior.',
  'The fail-before evidence for AC-1 to AC-4 only shows a load failure. It does not show any assertion about the criteria failing on the base.',
  'The only fail-before evidence for AC-1, AC-2 and AC-3 is a load failure. The base run fails while collecting the module, with an ImportError for round_price.',
  'The reported fail-before evidence for AC-1 through AC-7 and AC-9 demonstrates missing implementation imports rather than failing behavioral assertions.',
];

/** A dispute of the recorded outcome mixed with a defect a repair can fix: the one Codex's adversarial review of 0.3.1 found silenced. */
const MIXED = 'The fail-before log shows an import error, but the new price tests assert only the result type and omit the required half-up rounding cases.';

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return { findings: [], snapshot: snapshotOf(), evidence: [], treeHash: TREE_A, reviews: [rreview()], ...over };
}

describe('a finding in the category evidence-classification', () => {
  it('names the category the reviewer brief and the review output schema name', () => {
    expect(EVIDENCE_CLASSIFICATION_CATEGORY).toBe('evidence-classification');
  });

  it('is a note when no check confirms it: advisory, never claim_pending, never a claim to test or a repair brief (the dotnet stall shape)', () => {
    const f = rfinding(DOTNET_TEST_1);
    const info = rfinding({ externalId: 'COR-1', severity: 'info', category: 'correctness', claim: 'The implementation appears to meet AC-1 and AC-2.' });
    const r = resolveFindings(input({ findings: [f, info] }));
    const d = r.dispositions.find((x) => x.findingId === f.id)!;
    expect(d.status).toBe('advisory');
    expect(d.blocking).toBe(false);
    expect(d.recordedClassification).toMatch(/fail-before/);
    expect(d.reason).toMatch(/evidence-classification/);
    expect(d.reason).toMatch(/Orbit recorded/);
    expect(d.reason).toMatch(/no repair can change/);
    expect(r.claimsToTest).toEqual([]);
    expect(r.repairBriefs).toEqual([]);
    expect(r.blocking).toEqual([]);
    expect(r.clear).toBe(true);
  });

  it('is a note whatever its claim says: the resolver does not read the wording to decide it', () => {
    for (const claim of [...DISPUTES, MIXED]) {
      const r = resolveFindings(input({ findings: [rfinding({ ...DOTNET_TEST_1, claim })] }));
      expect(r.dispositions[0], claim).toMatchObject({ status: 'advisory', blocking: false });
      expect(r.clear, claim).toBe(true);
    }
  });

  it('matches the category, not its case or the space around it', () => {
    const r = resolveFindings(input({ findings: [rfinding({ ...DOTNET_TEST_1, category: ' Evidence-Classification ' })] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'advisory', blocking: false });
  });

  it('stays a note whatever the severity and whether or not it is carried from an earlier round', () => {
    const earlier = rfinding({ ...DOTNET_TEST_1, id: 'rev-0:TEST-1', reviewId: 'rev-0', severity: 'critical', status: 'claim_pending' });
    const r = resolveFindings(input({ findings: [], previousFindings: [earlier] }));
    expect(r.dispositions.map((d) => [d.status, d.blocking])).toEqual([['advisory', false]]);
  });

  it('is not a note once a check confirms it: a mixed claim with FAILED evidence blocks and goes to repair', () => {
    const f = rfinding({ ...DOTNET_TEST_1, externalId: 'TEST-3', location: 'tests/test_pricing.py:9', claim: MIXED });
    const r = resolveFindings(input({ findings: [f], evidence: [evidence({ findingId: f.id, verdict: 'confirms', status: 'FAILED', checkId: 'half-up', ref: 'evidence/1/half-up.log' })] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'accepted', blocking: true });
    expect(r.dispositions[0]!.recordedClassification).toBeUndefined();
    expect(r.repairBriefs).toHaveLength(1);
    expect(r.clear).toBe(false);
  });

  it('is not a note once a check confirmed it on an earlier tree', () => {
    const earlier = rfinding({ ...DOTNET_TEST_1, id: 'rev-0:TEST-1', reviewId: 'rev-0', status: 'accepted' });
    const current = rfinding({ ...DOTNET_TEST_1, id: 'rev-1:TEST-1' });
    const r = resolveFindings(input({ findings: [current], previousFindings: [earlier] }));
    expect(r.dispositions).toHaveLength(1);
    expect(r.dispositions[0]).toMatchObject({ status: 'accepted', blocking: true });
    expect(r.dispositions[0]!.recordedClassification).toBeUndefined();
    expect(r.clear).toBe(false);
  });

  it('is never a note when its id says security: a SEC- finding follows the security rule and blocks, whatever its category says', () => {
    // An id that says security and a category that says "asks for nothing the candidate can change" contradict each other;
    // the structure resolves it toward blocking, as every other security rule here fails closed.
    const f = rfinding({ externalId: 'SEC-1', severity: 'critical', category: 'evidence-classification', location: 'apps/reports/export.ts:42', claim: 'Export omits the tenant scope; cross-tenant reads succeed.' });
    const r = resolveFindings(input({ findings: [f] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'claim_pending', blocking: true, security: true });
    expect(r.dispositions[0]!.recordedClassification).toBeUndefined();
    expect(r.claimsToTest.map((c) => c.findingId)).toEqual([f.id]);
    expect(r.clear).toBe(false);
  });

  it('is never a note when another report of the same claim has a security id', () => {
    const noted = rfinding(DOTNET_TEST_1);
    const sec = rfinding({ ...DOTNET_TEST_1, externalId: 'SEC-2', reviewId: 'rev-2', provider: 'claude' });
    const r = resolveFindings(input({ findings: [noted, sec], reviews: [rreview(), rreview({ id: 'rev-2', provider: 'claude' })] }));
    for (const d of r.dispositions) {
      expect(d.status).toBe('claim_pending');
      expect(d.recordedClassification).toBeUndefined();
    }
    expect(r.clear).toBe(false);
  });

  it('a FAILED check that does not count (another tree, not exercising the claim) does not end the note', () => {
    const f = rfinding(DOTNET_TEST_1);
    const r = resolveFindings(input({ findings: [f], evidence: [evidence({ findingId: f.id, verdict: 'confirms', status: 'FAILED', treeHash: 'b'.repeat(40) }), evidence({ findingId: f.id, verdict: 'confirms', status: 'FAILED', exercisesClaim: false, ref: 'evidence/1/other.log' })] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'advisory', blocking: false });
    expect(r.ignoredEvidence).toHaveLength(2);
  });
});

describe('a finding in any other category', () => {
  it('wording alone never makes a note: the retest\'s claims in category test-adequacy block and are claims to test', () => {
    for (const claim of [...DISPUTES, MIXED]) {
      const f = rfinding({ ...DOTNET_TEST_1, category: 'test-adequacy', claim });
      const r = resolveFindings(input({ findings: [f] }));
      expect(r.dispositions[0], claim).toMatchObject({ status: 'claim_pending', blocking: true });
      expect(r.dispositions[0]!.recordedClassification, claim).toBeUndefined();
      expect(r.claimsToTest.map((c) => c.findingId), claim).toEqual([f.id]);
      expect(r.clear, claim).toBe(false);
    }
  });

  it('an unknown category, as an older reviewer writes one, is an ordinary finding', () => {
    for (const category of ['fail-before', 'evidence classification', 'evidence-classifications', 'recorded-classification', 'evidence', 'note', '', null]) {
      const r = resolveFindings(input({ findings: [rfinding({ ...DOTNET_TEST_1, category })] }));
      expect(r.dispositions[0], String(category)).toMatchObject({ status: 'claim_pending', blocking: true });
      expect(r.dispositions[0]!.recordedClassification, String(category)).toBeUndefined();
      expect(r.clear, String(category)).toBe(false);
    }
  });

  it('a second report of the same claim in its normal category blocks, whatever the first report\'s category', () => {
    const noted = rfinding(DOTNET_TEST_1);
    const other = rfinding({ ...DOTNET_TEST_1, reviewId: 'rev-2', provider: 'claude', category: 'test-adequacy' });
    const r = resolveFindings(input({ findings: [noted, other], reviews: [rreview(), rreview({ id: 'rev-2', provider: 'claude' })] }));
    expect(r.dispositions.find((d) => d.findingId === other.id)).toMatchObject({ status: 'claim_pending', blocking: true });
    expect(r.clear).toBe(false);
  });

  it('a finding about the tests themselves still blocks and is still tested', () => {
    const f = rfinding({ externalId: 'TEST-2', category: 'test-adequacy', claim: 'test_round_price_ties compares round_price(2.675) with itself, a tautology that cannot fail.' });
    const r = resolveFindings(input({ findings: [f] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'claim_pending', blocking: true });
    expect(r.claimsToTest.map((c) => c.findingId)).toEqual([f.id]);
  });
});
