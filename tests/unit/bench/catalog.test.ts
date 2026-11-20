import { describe, expect, it } from 'vitest';
import { LAB_SCENARIOS, labCatalogProblems, labScenarioProblems, type LabScenario } from '../../../src/bench/scenarios.ts';
import { BENCH_STAGES, FIXED_GATES, stageOff } from '../../../src/bench/stages.ts';

describe('lab catalog (#172 SC-001, FR-002)', () => {
  it('has at least twenty scenarios, each valid, each replaying a numbered Orbit issue, with unique ids', () => {
    expect(LAB_SCENARIOS.length).toBeGreaterThanOrEqual(20);
    expect(labCatalogProblems(LAB_SCENARIOS)).toEqual([]);
    for (const s of LAB_SCENARIOS) expect(labScenarioProblems(s), s.id).toEqual([]);
  });

  it('marks a scenario whose expectation cannot be judged invalid, and refuses a catalog with a duplicate id', () => {
    const s: LabScenario = { id: 'broken', issue: 0, title: 'x', roles: {}, expect: { state: 'IMPLEMENTING', failureClass: 'bad-luck' as never } };
    expect(labScenarioProblems(s)).toEqual(['issue is not an issue number', 'expected state IMPLEMENTING is not a terminal state', 'expected failure class bad-luck is not one of the failure classes', 'no provider steps']);
    expect(labCatalogProblems([LAB_SCENARIOS[0]!, LAB_SCENARIOS[0]!])).toEqual([`duplicate scenario ids: ${LAB_SCENARIOS[0]!.id}`]);
  });
});

describe('stages a bench may turn off (#172 FR-006)', () => {
  it('lists the stages that can be turned off and keeps scope, secrets and verification out of them', () => {
    expect(Object.keys(BENCH_STAGES)).toEqual(['diagnosis', 'fail-before']);
    expect(Object.keys(FIXED_GATES)).toEqual(['scope', 'secrets', 'verification']);
    for (const gate of Object.keys(FIXED_GATES)) {
      expect(BENCH_STAGES[gate]).toBeUndefined();
      expect(() => stageOff(gate)).toThrow(new RegExp(`^${gate} is a gate no bench may turn off .*; stages that can be turned off: diagnosis, fail-before$`));
    }
    expect(() => stageOff('review')).toThrow(/^unknown stage "review"/);
  });

  it('turns the diagnosis stage off through the controller and fail-before through the policy', () => {
    expect(stageOff('diagnosis').deps).toEqual({ withoutDiagnosis: true });
    const c = { verification: { allow_flaky_pass: false, fail_before: 'advisory' } } as never as Parameters<NonNullable<ReturnType<typeof stageOff>['tweak']>>[0];
    stageOff('fail-before').tweak!(c);
    expect(c.verification.fail_before).toBe('off');
  });
});
