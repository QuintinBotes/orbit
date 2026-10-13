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

function input(criteria: PlannerCriterion[]): DraftContractInput {
  return { goal: 'Add round_price to shop.pricing, with unit tests that fail before the change and pass after.', plannerOutput: planner({ criteria }), snapshot: snapshot(), baselineRevision: BASELINE, taskId: 'ORB-001' };
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
      'Tests under tests/ fail before the change and pass after it.',
      'The added tests fail without the change.',
      'On the base revision the new tests fail; with the change they pass.',
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

  it('never drops the last mandatory criterion', () => {
    const { contract } = draftContract(input([criterion('only', 'The new tests fail on the base revision and pass with the change.'), criterion('opt', 'Docs mention round_price.', false)]));
    expect(contract.acceptance_criteria.map((c) => c.id)).toEqual(['AC-1', 'AC-2']);
  });
});
