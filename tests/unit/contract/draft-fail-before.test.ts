// A criterion that the new tests fail on the base revision (ADR 0014, 0.3.1 addendum). Orbit checks that itself
// (verification.fail_before), so it is not the planner's to promise. In the 0.3.0 retest's required run
// (orb-20261013-081148-e86c15) the planner wrote AC-4 "The new tests fail on the base revision (ImportError for
// round_price) and pass with the change; existing apply_discount tests still pass". The candidate's passing log was then
// cited to support it, the Inquisition told the implementer to keep the ImportError "as the contract states", and AC-4
// was amended to require mutant runs no check produces. The draft drops such a criterion, with a recorded reason, when
// everything it says is about tests failing on the base revision or passing; a criterion that also states behaviour is
// kept.
import { describe, expect, it } from 'vitest';
import { draftContract, type DraftContractInput } from '../../../src/contract/draft.ts';
import type { PlannerOutput } from '../../../src/contract/model-outputs.ts';
import { BASELINE, planner, snapshot } from './fixtures.ts';

type PlannerCriterion = PlannerOutput['criteria'][number];

const criterion = (key: string, statement: string, mandatory = true): PlannerCriterion => ({ key, statement, mandatory, ui: false, proof: ['unit tests'], check_ids: ['reports-tests'], changes: [] });

function input(criteria: PlannerCriterion[], goal = 'Add round_price to shop.pricing, with unit tests that fail before the change and pass after.'): DraftContractInput {
  return { goal, plannerOutput: planner({ criteria }), snapshot: snapshot(), baselineRevision: BASELINE, taskId: 'ORB-001' };
}

const BEHAVIOUR = [criterion('ties', 'round_price(2.675) returns 2.68 and round_price(0.125) returns 0.13.'), criterion('finite', 'Non-finite input raises ValueError.'), criterion('boundaries', 'Values below the half round down.')];

describe('a planner criterion about the new tests failing on the base revision', () => {
  it('the retest\'s AC-4 is dropped, with a recorded reason, and the other criteria keep their ids', () => {
    const ac4 = 'The new tests fail on the base revision (ImportError for round_price) and pass with the change; existing apply_discount tests still pass.';
    const { contract, adjustments } = draftContract(input([...BEHAVIOUR, criterion('fail-before', ac4)]));
    expect(contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2', 'AC-3']);
    expect(contract.acceptance_criteria.map((c) => c.statement)).not.toContain(ac4);
    const dropped = adjustments.filter((a) => a.kind === 'criterion-dropped');
    expect(dropped).toEqual([{ kind: 'criterion-dropped', subject: 'AC-4', reason: expect.stringMatching(/verification\.fail_before/) }]);
    expect(dropped[0]!.reason).toContain(ac4);
  });

  it('a dropped criterion in the middle leaves its id unused, so the planner\'s keys still name the same criteria', () => {
    const { contract } = draftContract(input([BEHAVIOUR[0]!, criterion('red-first', 'New tests fail before the change and pass after it.'), BEHAVIOUR[1]!]));
    expect(contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-3']);
  });

  it('recognises the usual wordings', () => {
    for (const statement of [
      'The new unit tests fail on the base revision and pass on the candidate.',
      'Tests added under tests/ fail before the change and pass after it.',
      'The added tests fail without the change.',
      'On the base revision the new tests fail; with the change they pass.',
      'The tests the change adds fail on the base revision and pass with it.',
      'Newly added specs fail against the base commit and pass on the candidate.',
    ]) {
      const { contract } = draftContract(input([...BEHAVIOUR, criterion('fb', statement)]));
      expect(contract.acceptance_criteria, statement).toHaveLength(3);
    }
  });

  it('keeps a criterion that also states behaviour, and one that is not about failing on the base revision', () => {
    for (const statement of [
      'round_price(2.675) returns 2.68, and the new tests fail on the base revision.',
      'The existing apply_discount tests still pass.',
      'Requests made before the change keep working after it.',
      'The importer fails on a file without a header.',
    ]) {
      const { contract, adjustments } = draftContract(input([...BEHAVIOUR, criterion('x', statement)]));
      expect(contract.acceptance_criteria, statement).toHaveLength(4);
      expect(adjustments.filter((a) => a.kind === 'criterion-dropped'), statement).toEqual([]);
    }
  });

  // A bug fix's criterion may be about tests that exist and fail on the base revision: the fail-before probe runs only
  // the tests the change adds, so it establishes nothing about them, and the drop's reason ("new tests") would be false.
  it('keeps a criterion about existing or unnamed tests failing on the base revision, as a bug fix states one', () => {
    const parse = criterion('empty', 'parse("") returns an empty list.');
    for (const statement of [
      'The existing test test_parse_empty, which fails on the base revision, passes after the change.',
      'The date tests that fail on the base revision pass after the change.',
      'tests/date.test.ts fails on the base revision and passes with the fix.',
      'Tests under tests/ fail before the change and pass after it.',
      'The currently failing tests in tests/date.test.ts fail on the base revision and pass with the fix.',
      'The new regression test, like the existing failing ones, fails on the base revision and passes after the fix.',
    ]) {
      const { contract, adjustments } = draftContract(input([parse, criterion('x', statement)], 'Fix the failing date tests.'));
      expect(contract.acceptance_criteria.map((c) => c.statement), statement).toContain(statement);
      expect(adjustments.filter((a) => a.kind === 'criterion-dropped'), statement).toEqual([]);
    }
  });

  it('drops the retest\'s AC-4 wording on its own: the aside names the failure, it states no behaviour', () => {
    for (const statement of [
      'The new tests fail on the base revision (ImportError for round_price).',
      'The new tests fail on the base revision (an import error for round_price) and pass with the change.',
      'The new tests fail on the base revision and pass with the change (ModuleNotFoundError on the base revision).',
    ]) {
      const { contract, adjustments } = draftContract(input([...BEHAVIOUR, criterion('fb', statement)]));
      expect(contract.acceptance_criteria.map((c) => c.statement), statement).not.toContain(statement);
      const dropped = adjustments.filter((a) => a.kind === 'criterion-dropped');
      expect(dropped.map((a) => a.subject), statement).toEqual(['AC-4']);
      // The decision carries the whole statement, aside included, so a person sees what was removed.
      expect(dropped[0]!.reason, statement).toContain(`"${statement}"`);
    }
  });

  // Every clause must say only that the new tests fail on the base revision or that tests pass. A clause with behaviour,
  // wherever it is (after "and" or "while", in parentheses, in another sentence), keeps the criterion whole and unchanged.
  it('keeps a mixed criterion whole: behaviour after "and" or "while", in parentheses, or in a second sentence', () => {
    for (const statement of [
      // Codex's adversarial review of 0.3.1: the second clause passed only because it contains "pass".
      'The new tests fail on the base revision and authentication rejects cross-tenant requests while valid requests pass.',
      'The new tests fail on the base revision while valid requests pass.',
      'The new tests fail on the base revision, while round_price(2.675) returns 2.68.',
      'The new tests fail on the base revision (round_price(2.675) returns 2.68 after the change).',
      'The new tests fail on the base revision and pass with the change (half-up rounding of ties).',
      'The new tests fail on the base revision (ImportError for round_price) and round_price rejects NaN.',
      'The new tests fail on the base revision. Non-finite input raises ValueError.',
      'The new tests fail on the base revision; the importer passes malformed rows through unchanged.',
      'The new tests fail on the base revision and the export passes the tenant filter to the query.',
      'The new tests fail on the base revision and pass, and the API returns 404 for an unknown id.',
      'The new tests fail on the base revision and requests pass validation.',
      'The new tests (which cover ties and negative prices) fail on the base revision.',
    ]) {
      const { contract, adjustments } = draftContract(input([...BEHAVIOUR, criterion('x', statement)]));
      expect(contract.acceptance_criteria.map((c) => c.statement), statement).toContain(statement);
      expect(adjustments.filter((a) => a.kind === 'criterion-dropped'), statement).toEqual([]);
    }
  });

  it('never drops the last mandatory criterion', () => {
    const { contract } = draftContract(input([criterion('only', 'The new tests fail on the base revision and pass with the change.'), criterion('opt', 'Docs mention round_price.', false)]));
    expect(contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
  });
});
