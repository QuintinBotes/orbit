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
  // The adversarial verifier's bypasses of a keyword search: each defect clause carries a word about the probe ("base
  // revision", "on the base", "probe", "collects", "build error", "stub implementation", "mutant run", "NameError"), or
  // hides behind "It does not show", "not" or "rather than", and names no denylisted word.
  "The fail-before probe failed with an import error, not an assertion. The candidate's round_price still rounds 2.675 to 2.67 exactly as the base revision did so AC-2's half-up rule is unmet.",
  'The fail-before evidence is only an import error. On the candidate round_price(2.675) still gives 2.67 as on the base revision.',
  'The fail-before probe shows only an import error. apply_discount computes the tax on the base price instead of the discounted total.',
  'The fail-before log is only a load failure. checkout collects the delivery fee twice for orders over 100.',
  'The fail-before evidence is only an import error. round_price gives a NameError for negative prices on the candidate.',
  'The fail-before evidence is only an import error. The candidate ships a stub implementation of round_price that ignores the rounding mode.',
  'The fail-before log shows only an import error. It does not show that round_price rounds half-up which the candidate does not do since round_price(2.675) gives 2.67.',
  'The fail-before log shows only an import error. It does not show any tie case because the new tests have none for 2.675 or 0.125.',
  'The fail-before evidence is only an import error, rather than any half-up tie case since the new tests include none.',
  "The fail-before evidence is only a load failure. The new tests expect round_price(2.675) to equal 2.67 which is the base revision's half-down value instead of the required 2.68.",
  'The fail-before evidence shows only a load failure (and on the candidate round_price(2.675) still gives 2.67 as on the base revision).',
  'The fail-before evidence is only a load failure; the probe never ran the tie case; the base revision rounding of 2.675 to 2.67 survives in the candidate.',
  "The fail-before probe only hit an import error. The candidate applies the tenant filter on the base query only so other tenants' rows are visible to every caller.",
  'The fail-before probe only hit an import error since round_price is a stub implementation that gives 2.67 for 2.675.',
  'The fail-before evidence is only an import error while the candidate drops the last item of the collection when the cart has more than ten lines.',
  "The fail-before evidence is only a load failure. The candidate's build error page prints the database password to anonymous users.",
  'The fail-before outcome is a compile error, not an assertion. The new tests compare the output with a snapshot taken from the base build so they pin the old half-down result.',
  // The same, in a reviewer's natural wording. A surviving mutant is a test-adequacy defect, the very evidence the probe
  // exists to raise.
  'The fail-before evidence is only an import error, and the candidate still behaves like the base revision for ties.',
  'The fail-before probe only shows an import error; with a stub round_price that truncates, the new tests would still pass.',
  'The fail-before evidence is only a load failure. A mutant run of round_price that rounds half-down survives the new tests.',
  'The fail-before evidence is only an import error. Against a mutant that rounds half-down the new tests still pass.',
  'The fail-before log shows only a collection error. The candidate keeps the base revision behaviour for negative prices.',
  'Although the fail-before evidence is only an import error, the candidate leaves the base revision formula in place.',
  'The fail-before evidence is only an import error (the candidate is still a stub implementation).',
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

  it('a mixed high finding, also one in the security category, blocks and is tested: never advisory, never clear', () => {
    for (const f of [
      rfinding({ externalId: 'COR-7', severity: 'high', category: 'correctness', location: 'shop/pricing.py:12', claim: MIXED[10]! }),
      rfinding({ externalId: 'SEC-1', severity: 'critical', category: 'security', location: 'app/db.py:40', claim: MIXED.find((c) => c.includes('tenant filter'))! }),
    ]) {
      const r = resolveFindings(input({ findings: [f] }));
      expect(r.dispositions[0], f.claim).toMatchObject({ status: 'claim_pending', blocking: true });
      expect(r.dispositions[0]!.recordedClassification, f.claim).toBeUndefined();
      expect(r.claimsToTest.map((c) => c.findingId), f.claim).toEqual([f.id]);
      expect(r.clear, f.claim).toBe(false);
    }
  });

  // The claim may dispute only the outcome while the finding's evidence states a defect: that is not exclusive either.
  it('is not a note when the evidence names a defect, though the claim only disputes the outcome', () => {
    const f = rfinding({
      externalId: 'TEST-9',
      category: 'test-adequacy',
      location: 'tests/test_pricing.py:9',
      claim: 'The fail-before evidence for AC-1 shows only a load failure. It does not show that any assertion about the criterion failed.',
      evidence: 'Also, round_price(2.675) returns 2.67 on the candidate, and the new tests omit every tie case; AC-2 is not met.',
      suggestedValidation: 'Run round_price(2.675) on the candidate and assert 2.68.',
    });
    expect(recordedClassificationDispute({ claim: f.claim })).toMatch(/fail-before/);
    expect(recordedClassificationDispute(f)).toBeNull();
    for (const evidence of [
      'round_price(2.675) gives 2.67 on the candidate.',
      'A mutant that rounds half-down survives the new tests.',
      'The candidate keeps the half-down formula.',
    ]) {
      expect(recordedClassificationDispute({ claim: f.claim, evidence }), evidence).toBeNull();
    }
    const r = resolveFindings(input({ findings: [f] }));
    expect(r.dispositions[0]).toMatchObject({ status: 'claim_pending', blocking: true });
    expect(r.clear).toBe(false);
  });

  it('is not a note when another report of the same claim names a defect in its evidence', () => {
    const first = rfinding(DOTNET_TEST_1);
    const second = rfinding({ ...DOTNET_TEST_1, reviewId: 'rev-2', provider: 'claude', evidence: 'A mutant Clamp that never throws survives the new tests.' });
    const r = resolveFindings(input({ findings: [first, second], reviews: [rreview(), rreview({ id: 'rev-2', provider: 'claude' })] }));
    expect(r.dispositions).toHaveLength(1);
    expect(r.dispositions[0]!.status).not.toBe('advisory');
    expect(r.dispositions[0]!.blocking).toBe(true);
    expect(r.clear).toBe(false);
  });

  it('the retest reviewers\' evidence for a pure dispute keeps it a note', () => {
    for (const evidence of [
      DOTNET_TEST_1.evidence,
      'Because of the module-level import of bulk_price, collection fails on the base, so none of the nine new price tests ran there.',
      "In the fail-before log the only error is SyntaxError: The requested module '../apps/calc.mjs' does not provide an export named 'mul'. No assertion ran on the base revision.",
      null,
    ]) {
      expect(recordedClassificationDispute({ claim: DOTNET_TEST_1.claim, evidence }), String(evidence)).toMatch(/fail-before/);
    }
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
