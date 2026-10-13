// A criterion that the new tests fail on the base revision (ADR 0014, 0.3.1 addendum, item 4). Orbit checks that itself
// (verification.fail_before), so it is not the planner's to promise. In the 0.3.0 retest's required run
// (orb-20261013-081148-e86c15) the planner wrote AC-4 "The new tests fail on the base revision (ImportError for
// round_price) and pass with the change; existing apply_discount tests still pass". The candidate's passing log was then
// cited to support it, the Inquisition told the implementer to keep the ImportError "as the contract states", and AC-4
// was amended to require mutant runs no check produces.
//
// The planner brief tells the planner not to write such a criterion, and the inquisitor brief tells the Inquisition never
// to require fail-before mechanics. The draft itself never removes a criterion: an earlier version dropped one by its
// wording, and three rounds of adversarial review showed that matching English, however tightened, can delete a real
// requirement (Codex's authentication example below was one).
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

/** The retest's AC-4, verbatim. */
const RETEST_AC_4 = 'The new tests fail on the base revision (ImportError for round_price) and pass with the change; existing apply_discount tests still pass.';
/** Codex's adversarial review of 0.3.1: the second clause was dropped with the first because it contains "pass". */
const CODEX_AUTHENTICATION = 'The new tests fail on the base revision and authentication rejects cross-tenant requests while valid requests pass.';

describe('a planner criterion about the new tests failing on the base revision', () => {
  it('the draft keeps every criterion, the retest\'s AC-4 and Codex\'s mixed authentication example included, with the planner\'s ids', () => {
    const { contract, adjustments } = draftContract(input([...BEHAVIOUR, criterion('fail-before', RETEST_AC_4), criterion('auth', CODEX_AUTHENTICATION)]));
    expect(contract.acceptance_criteria.map((c) => [c.id, c.statement])).toEqual([
      ['AC-1', BEHAVIOUR[0]!.statement],
      ['AC-2', BEHAVIOUR[1]!.statement],
      ['AC-3', BEHAVIOUR[2]!.statement],
      ['AC-4', RETEST_AC_4],
      ['AC-5', CODEX_AUTHENTICATION],
    ]);
    expect(adjustments.map((a) => a.kind)).not.toContain('criterion-dropped');
    expect(adjustments.filter((a) => /criteri/.test(a.kind))).toEqual([]);
  });

  it('keeps a criterion whatever it says, also one that says only that the new tests fail on the base revision', () => {
    for (const statement of [
      'The new tests fail on the base revision (ImportError for round_price).',
      'The new unit tests fail on the base revision and pass on the candidate.',
      'Tests added under tests/ fail before the change and pass after it.',
      'On the base revision the new tests fail; with the change they pass.',
      'The new tests fail on the base revision while valid requests pass.',
      'The existing test test_parse_empty, which fails on the base revision, passes after the change.',
    ]) {
      const { contract } = draftContract(input([...BEHAVIOUR, criterion('x', statement)]));
      expect(contract.acceptance_criteria.map((c) => c.statement), statement).toEqual([...BEHAVIOUR.map((c) => c.statement), statement]);
    }
  });

  it('keeps it when it is the only mandatory criterion', () => {
    const { contract } = draftContract(input([criterion('only', 'The new tests fail on the base revision and pass with the change.'), criterion('opt', 'Docs mention round_price.', false)]));
    expect(contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
  });
});
