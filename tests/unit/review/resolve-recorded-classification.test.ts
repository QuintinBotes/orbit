// A review finding whose subject is Orbit's own recorded evidence classification (ADR 0014, 0.3.1 addendum). In the 0.3.0
// retest a reviewer raised, on the base-revision fail-before outcome Orbit had already recorded, "the fail-before evidence
// shows only a load failure" as a high finding. Orbit made it claim_pending and blocking and sent it to repair (dotnet runs
// orb-20261013-083016-84a30d and orb-20261013-083337-df06a4) or to the Inquisition (python run orb-20261013-080355-6ac27f).
// A repair cannot change the base revision, so the repair reproduced the same tree and the run ended EXHAUSTED. Such a
// finding is reported as a note: it never blocks, never becomes a claim to test, and never goes to repair.
import { describe, expect, it } from 'vitest';
import { recordedClassificationDispute, resolveFindings, type ResolveInput } from '../../../src/review/resolve.ts';
import { TREE_A, evidence, rfinding, rreview, snapshotOf } from './fixtures.ts';

/** The dotnet run's TEST-1, verbatim. */
const DOTNET_TEST_1 = {
  externalId: 'TEST-1',
  severity: 'high' as const,
  category: 'test-adequacy',
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
  'The fail-before for AC-1, AC-2, AC-3 and AC-4 is a load failure only. The local round_price wrapper turns the missing symbol into an AssertionError.',
  'The reported fail-before evidence for AC-1 through AC-7 and AC-9 demonstrates missing implementation imports rather than failing behavioral assertions.',
  'The fail-before evidence attributed to AC-7 is a load failure, not an assertion demonstrating incorrect local-date naming on the base revision.',
  // The fresh-review lab's TEST-1 (tests/integration/controller/fresh-review.test.ts) and the python advisory run's
  // (tests/unit/controller/review-recorded-classification.test.ts).
  'The fail-before evidence for AC-1 shows only a load failure. It does not show that any assertion about the criterion failed. The new test depends on mul existing, but the probe does not prove that it checks its behavior.',
  'The fail-before evidence for AC-1 to AC-4 only shows a load failure. It does not show any assertion about the bulk_price discount criteria failing on the base.',
];

/**
 * Claims that dispute the recorded outcome and also say something else: a gap in the tests, what their assertions check,
 * or how the code behaves. Each is a defect a repair can fix, so it is not a note. The first is the one Codex's
 * adversarial review of 0.3.1 found silenced.
 */
const MIXED = [
  'The fail-before log shows an import error, but the new price tests assert only the result type and omit the required half-up rounding cases.',
  // A dispute and a coverage gap, in two sentences.
  'The fail-before evidence for AC-1 and AC-2 is only a load failure. The new tests do not cover the invalid range at all.',
  'The fail-before evidence for AC-1 is only a load failure. AC-2 has no test with min greater than max.',
  // A behavioural clause joined by "while".
  'The fail-before outcome is only an import error for round_price while round_price(2.675) returns 2.67 on the candidate.',
  // Behaviour in parentheses.
  'The fail-before evidence shows only a load failure (round_price still rounds 0.125 down to 0.12).',
  // Joined by "however", "although" and "and also".
  'The fail-before evidence is a compile failure; however, the clamp tests never check the upper bound.',
  'Although the fail-before evidence is only a missing symbol error, the tests replace round_price with a local copy.',
  'The fail-before evidence only shows an import error and also the new tests leave out the negative quantities.',
  // A clause that refers back to the evidence and names a gap.
  'The fail-before log is a load failure only. It also shows that no test exercises a quantity of zero.',
  // One sentence, joined by a bare "and".
  'The fail-before evidence is only an import error and the new tests use the wrong rounding mode.',
];

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return { findings: [], snapshot: snapshotOf(), evidence: [], treeHash: TREE_A, reviews: [rreview()], ...over };
}

describe('a finding that disputes a classification Orbit recorded', () => {
  it('recognises the retest reviewers\' wording about the fail-before outcome', () => {
    for (const claim of DISPUTES) expect(recordedClassificationDispute({ claim }), claim).toMatch(/fail-before/);
  });

  it('leaves findings about the candidate alone, also ones that mention the probe while naming a defect in a test', () => {
    for (const claim of [
      'Export omits tenant scope.',
      'mul accepts non-numeric arguments and returns NaN instead of throwing',
      'The in-file mutant tests are independent of the product code. They pass for any round_price implementation.',
      'test_round_price_ties compares round_price(2.675) with itself, a tautology that cannot fail; its fail-before failure is only the import error.',
      'The parser can fail before it reads the header, which loses the import error the caller needs.',
      'AC-2 has no test of the invalid range: the fail-before log does not show any test with min greater than max.',
    ]) {
      expect(recordedClassificationDispute({ claim }), claim).toBeNull();
    }
  });

  it('is a note only when every clause is about the probe or its outcome: a claim that also names a defect is not one', () => {
    for (const claim of MIXED) expect(recordedClassificationDispute({ claim }), claim).toBeNull();
  });

  it('a mixed finding blocks and goes to repair when a check confirms it, so a later approval cannot clear it unseen', () => {
    const f = rfinding({ externalId: 'TEST-3', category: 'test-adequacy', location: 'tests/test_pricing.py:9', claim: MIXED[0]! });
    const r = resolveFindings(input({ findings: [f], evidence: [evidence({ findingId: f.id, verdict: 'confirms', status: 'FAILED', checkId: 'half-up', ref: 'evidence/1/half-up.log' })] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'accepted', blocking: true });
    expect(r.dispositions[0]!.recordedClassification).toBeUndefined();
    expect(r.repairBriefs).toHaveLength(1);
    expect(r.clear).toBe(false);
  });

  it('a mixed finding without evidence is a claim to test, never a note', () => {
    const f = rfinding({ externalId: 'TEST-3', category: 'test-adequacy', claim: MIXED[0]! });
    const r = resolveFindings(input({ findings: [f] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'claim_pending', blocking: true });
    expect(r.claimsToTest.map((c) => c.findingId)).toEqual([f.id]);
  });

  it('even an exclusive dispute is not a note once a check confirms it: the evidence governs', () => {
    const f = rfinding(DOTNET_TEST_1);
    const r = resolveFindings(input({ findings: [f], evidence: [evidence({ findingId: f.id, verdict: 'confirms', status: 'FAILED', checkId: 'stub-clamp', ref: 'evidence/1/stub-clamp.log' })] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'accepted', blocking: true });
    expect(r.repairBriefs).toHaveLength(1);
  });

  it('is a note, not a blocking claim: advisory, never claim_pending, never a claim to test or a repair brief (the dotnet stall shape)', () => {
    const f = rfinding(DOTNET_TEST_1);
    const info = rfinding({ externalId: 'COR-1', severity: 'info', category: 'correctness', claim: 'The implementation appears to meet AC-1 and AC-2.' });
    const r = resolveFindings(input({ findings: [f, info] }));
    const d = r.dispositions.find((x) => x.findingId === f.id)!;
    expect(d.status).toBe('advisory');
    expect(d.blocking).toBe(false);
    expect(d.reason).toMatch(/Orbit recorded/);
    expect(d.reason).toMatch(/no repair can change/);
    expect(r.claimsToTest).toEqual([]);
    expect(r.repairBriefs).toEqual([]);
    expect(r.blocking).toEqual([]);
    expect(r.clear).toBe(true);
  });

  it('stays a note whatever the severity and whether or not it is carried from an earlier round', () => {
    const earlier = rfinding({ ...DOTNET_TEST_1, id: 'rev-0:TEST-1', reviewId: 'rev-0', severity: 'critical', status: 'claim_pending' });
    const r = resolveFindings(input({ findings: [], previousFindings: [earlier] }));
    expect(r.dispositions.map((d) => [d.status, d.blocking])).toEqual([['advisory', false]]);
  });

  it('a finding about the tests themselves still blocks and is still tested', () => {
    const f = rfinding({ externalId: 'TEST-2', category: 'test-adequacy', claim: 'test_round_price_ties compares round_price(2.675) with itself, a tautology that cannot fail.' });
    const r = resolveFindings(input({ findings: [f] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'claim_pending', blocking: true });
    expect(r.claimsToTest.map((c) => c.findingId)).toEqual([f.id]);
  });
});
