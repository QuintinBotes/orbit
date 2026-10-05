// Separable work units from the planner's file mapping (spec section 8; docs/gaps.md G14).
import { describe, expect, it } from 'vitest';
import { planWorkUnits } from '../../../src/scheduling/work-units.ts';
import { pathsOverlap } from '../../../src/scheduling/scheduler.ts';

describe('work units', () => {
  it('splits criteria with disjoint files into units that own pairwise disjoint paths', () => {
    const units = planWorkUnits([
      { id: 'AC-1', paths: ['apps/calc.mjs'] },
      { id: 'AC-2', paths: ['apps/strings.mjs'] },
      { id: 'AC-3', paths: ['apps/calc.mjs', 'apps/calc-helpers.mjs'] },
    ]);
    expect(units).toEqual([
      { id: 'u1', criteria: ['AC-1', 'AC-3'], ownedPaths: ['apps/calc-helpers.mjs', 'apps/calc.mjs'] },
      { id: 'u2', criteria: ['AC-2'], ownedPaths: ['apps/strings.mjs'] },
    ]);
    expect(pathsOverlap(units![0]!.ownedPaths, units![1]!.ownedPaths)).toBe(false);
  });

  it('keeps criteria whose paths may overlap together, through globs and chains', () => {
    const units = planWorkUnits([
      { id: 'AC-1', paths: ['apps/a/**'] },
      { id: 'AC-2', paths: ['apps/a/index.mjs', 'apps/b/x.mjs'] },
      { id: 'AC-3', paths: ['apps/b/*.mjs'] },
    ]);
    // AC-1 overlaps AC-2 (glob), AC-2 overlaps AC-3: one unit, so no split.
    expect(units).toBeNull();
  });

  it('does not split when a criterion has no mapped file or there is only one criterion', () => {
    expect(planWorkUnits([{ id: 'AC-1', paths: ['apps/a.mjs'] }, { id: 'AC-2', paths: [] }])).toBeNull();
    expect(planWorkUnits([{ id: 'AC-1', paths: ['apps/a.mjs'] }])).toBeNull();
  });
});
