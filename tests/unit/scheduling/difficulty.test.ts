import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { classifyDifficulty, type DifficultyInput } from '../../../src/scheduling/difficulty.ts';
import type { AcceptanceCriterion } from '../../../src/contract/types.ts';

function criteria(n: number, ui = 0): AcceptanceCriterion[] {
  return Array.from({ length: n }, (_, i) => ({ id: `AC-${i + 1}`, statement: `criterion ${i + 1}`, proof: ['test'], mandatory: true, ui: i < ui }));
}

function input(patch: Partial<DifficultyInput> = {}): DifficultyInput {
  return {
    contract: { acceptance_criteria: criteria(1), assumptions: [] },
    baseline: { failingChecks: [] },
    openQuestions: 0,
    uiRequired: false,
    securitySensitive: false,
    repoFamiliarity: 'high',
    testAvailability: 'good',
    coupling: 'low',
    ...patch,
  };
}

const FACTORS = [
  'acceptance_criteria',
  'coupling',
  'external_integrations',
  'baseline_health',
  'ambiguity',
  'security_impact',
  'ui_complexity',
  'repo_familiarity',
  'test_availability',
];

describe('classifyDifficulty', () => {
  it('classes a small, healthy, well-tested change as simple and records every factor', () => {
    const r = classifyDifficulty(input());
    expect(r.class).toBe('simple');
    expect(r.score).toBe(0);
    expect(r.max_score).toBe(20);
    expect(r.factors.map((f) => f.factor)).toEqual(FACTORS);
    expect(r.factors.every((f) => f.points === 0 && f.note.length > 0)).toBe(true);
    expect(r.reasons[0]).toBe('class simple');
    expect(r.reasons[1]).toMatch(/score 0 of 20/);
  });

  it('scores each spec section 7 factor', () => {
    const r = classifyDifficulty(
      input({
        contract: {
          acceptance_criteria: criteria(8, 3),
          assumptions: [
            { id: 'A1', statement: 's', status: 'unverified' },
            { id: 'A2', statement: 's', status: 'needs-decision' },
            { id: 'A3', statement: 's', status: 'supported' },
          ],
        },
        baseline: { failingChecks: 3 },
        openQuestions: 1,
        securitySensitive: true,
        repoFamiliarity: 'low',
        testAvailability: 'none',
        coupling: 'high',
        externalIntegrations: 2,
      }),
    );
    const points = Object.fromEntries(r.factors.map((f) => [f.factor, f.points]));
    expect(points).toEqual({
      acceptance_criteria: 3,
      coupling: 3,
      external_integrations: 2,
      baseline_health: 2,
      ambiguity: 2,
      security_impact: 2,
      ui_complexity: 2,
      repo_familiarity: 2,
      test_availability: 2,
    });
    expect(r.score).toBe(20);
    expect(r.class).toBe('complex');
    expect(r.reasons.some((x) => x.startsWith('ambiguity +2: 1 open question(s), 2 unresolved assumption(s)'))).toBe(true);
  });

  it('uses inclusive class boundaries at 3 and 8', () => {
    // coupling high (3) = 3 -> simple
    expect(classifyDifficulty(input({ coupling: 'high' }))).toMatchObject({ score: 3, class: 'simple' });
    // + familiarity medium (1) = 4 -> medium
    expect(classifyDifficulty(input({ coupling: 'high', repoFamiliarity: 'medium' }))).toMatchObject({ score: 4, class: 'medium' });
    // 3 + 2 + 2 + 1 = 8 -> medium
    const eight = input({ coupling: 'high', repoFamiliarity: 'low', baseline: { failingChecks: ['lint', 'types', 'unit'] }, uiRequired: true });
    expect(classifyDifficulty(eight)).toMatchObject({ score: 8, class: 'medium' });
    // one more point -> complex
    expect(classifyDifficulty({ ...eight, openQuestions: 1 })).toMatchObject({ score: 9, class: 'complex' });
  });

  it('never classes security-sensitive or untested work as simple', () => {
    const sec = classifyDifficulty(input({ securitySensitive: true }));
    expect(sec).toMatchObject({ score: 2, class: 'medium' });
    expect(sec.reasons).toContain('raised to medium: security-sensitive work is never classed simple');
    const untested = classifyDifficulty(input({ testAvailability: 'none' }));
    expect(untested.class).toBe('medium');
    expect(untested.reasons.join(' ')).toMatch(/without tests/);
    const both = classifyDifficulty(input({ securitySensitive: true, coupling: 'high' }));
    expect(both.score).toBe(5);
    expect(both.class).toBe('complex');
    expect(both.reasons).toContain('raised to complex: security-sensitive and highly coupled');
  });

  it('treats UI criteria in the contract as UI work even without the flag', () => {
    const r = classifyDifficulty(input({ contract: { acceptance_criteria: criteria(2, 1) } }));
    expect(r.factors.find((f) => f.factor === 'ui_complexity')).toMatchObject({ points: 1, value: 1 });
  });

  it('counts optional criteria in the note but scores mandatory ones', () => {
    const list = [...criteria(2), { id: 'AC-9', statement: 'nice to have', proof: [], mandatory: false }];
    const r = classifyDifficulty(input({ contract: { acceptance_criteria: list } }));
    expect(r.factors[0]).toMatchObject({ value: 2, points: 0, note: '2 mandatory criteria (3 total)' });
  });

  it('is deterministic', () => {
    const i = input({ coupling: 'medium', openQuestions: 2, externalIntegrations: 1 });
    expect(classifyDifficulty(i)).toEqual(classifyDifficulty(structuredClone(i)));
  });

  it('rejects malformed input instead of guessing', () => {
    const bad: Partial<DifficultyInput>[] = [
      { coupling: 'toString' as never },
      { repoFamiliarity: 'great' as never },
      { testAvailability: undefined as never },
      { openQuestions: -1 },
      { openQuestions: 1.5 },
      { baseline: { failingChecks: -2 } },
      { externalIntegrations: -1 },
      { uiRequired: 'yes' as never },
      { contract: {} as never },
    ];
    for (const patch of bad) {
      let caught: unknown;
      try {
        classifyDifficulty(input(patch));
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'SCHEMA_INVALID'), JSON.stringify(patch)).toBe(true);
    }
  });
});
