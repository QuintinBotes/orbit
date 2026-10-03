import { OrbitError } from '../core/errors.ts';
import type { GoalContract } from '../contract/types.ts';
import type { Coupling, DifficultyAssessment, DifficultyClass, DifficultyFactor, Familiarity, TestAvailability } from './types.ts';

/**
 * Deterministic difficulty classification (spec section 7): acceptance
 * criterion count, subsystem coupling, external integrations, baseline
 * health, ambiguity, security impact, UI complexity, repository familiarity
 * and test availability. Every factor is scored and recorded, including the
 * ones that scored zero, so the allowance chosen from the class can always be
 * explained and replayed.
 */

export interface DifficultyInput {
  contract: Pick<GoalContract, 'acceptance_criteria'> & Partial<Pick<GoalContract, 'assumptions'>>;
  baseline: { failingChecks: readonly string[] | number };
  /** Open questions that are not yet resolved. */
  openQuestions: number;
  uiRequired: boolean;
  securitySensitive: boolean;
  repoFamiliarity: Familiarity;
  testAvailability: TestAvailability;
  coupling: Coupling;
  /** External services or APIs the change integrates with. */
  externalIntegrations?: number;
}

/** Inclusive upper bounds of the score for each class. */
export const CLASS_THRESHOLDS = { simple: 3, medium: 8 } as const;

const FAMILIARITY_POINTS: Readonly<Record<Familiarity, number>> = { high: 0, medium: 1, low: 2 };
const TEST_POINTS: Readonly<Record<TestAvailability, number>> = { good: 0, partial: 1, none: 2 };
const COUPLING_POINTS: Readonly<Record<Coupling, number>> = { low: 0, medium: 1, high: 3 };

export function classifyDifficulty(input: DifficultyInput): DifficultyAssessment {
  validate(input);
  const criteria = input.contract.acceptance_criteria;
  const mandatory = criteria.filter((c) => c.mandatory !== false).length;
  const uiCriteria = criteria.filter((c) => c.ui === true).length;
  const failing = typeof input.baseline.failingChecks === 'number' ? input.baseline.failingChecks : input.baseline.failingChecks.length;
  const unresolvedAssumptions = (input.contract.assumptions ?? []).filter((a) => a.status === 'unverified' || a.status === 'needs-decision').length;
  const ambiguity = input.openQuestions + unresolvedAssumptions;
  const integrations = input.externalIntegrations ?? 0;
  const uiNeeded = input.uiRequired || uiCriteria > 0;

  const factors: DifficultyFactor[] = [
    {
      factor: 'acceptance_criteria',
      value: mandatory,
      points: band(mandatory, [2, 4, 7]),
      max: 3,
      note: `${mandatory} mandatory criteria (${criteria.length} total)`,
    },
    {
      factor: 'coupling',
      value: input.coupling,
      points: COUPLING_POINTS[input.coupling],
      max: 3,
      note: `subsystem coupling is ${input.coupling}`,
    },
    {
      factor: 'external_integrations',
      value: integrations,
      points: band(integrations, [0, 1]),
      max: 2,
      note: integrations === 0 ? 'no external integrations' : `${integrations} external integration(s)`,
    },
    {
      factor: 'baseline_health',
      value: failing,
      points: band(failing, [0, 2]),
      max: 2,
      note: failing === 0 ? 'baseline checks pass' : `${failing} baseline check(s) already failing`,
    },
    {
      factor: 'ambiguity',
      value: ambiguity,
      points: band(ambiguity, [0, 2]),
      max: 2,
      note: `${input.openQuestions} open question(s), ${unresolvedAssumptions} unresolved assumption(s)`,
    },
    {
      factor: 'security_impact',
      value: input.securitySensitive,
      points: input.securitySensitive ? 2 : 0,
      max: 2,
      note: input.securitySensitive ? 'security-sensitive change' : 'no security impact identified',
    },
    {
      factor: 'ui_complexity',
      value: uiNeeded ? uiCriteria : 0,
      points: !uiNeeded ? 0 : uiCriteria >= 3 ? 2 : 1,
      max: 2,
      note: !uiNeeded ? 'no UI verification needed' : `UI verification needed (${uiCriteria} UI criteria)`,
    },
    {
      factor: 'repo_familiarity',
      value: input.repoFamiliarity,
      points: FAMILIARITY_POINTS[input.repoFamiliarity],
      max: 2,
      note: `repository familiarity is ${input.repoFamiliarity}`,
    },
    {
      factor: 'test_availability',
      value: input.testAvailability,
      points: TEST_POINTS[input.testAvailability],
      max: 2,
      note: `test availability is ${input.testAvailability}`,
    },
  ];

  const score = factors.reduce((n, f) => n + f.points, 0);
  const maxScore = factors.reduce((n, f) => n + f.max, 0);
  let cls: DifficultyClass = score <= CLASS_THRESHOLDS.simple ? 'simple' : score <= CLASS_THRESHOLDS.medium ? 'medium' : 'complex';
  const reasons: string[] = [`score ${score} of ${maxScore}: simple up to ${CLASS_THRESHOLDS.simple}, medium up to ${CLASS_THRESHOLDS.medium}, complex above`];

  // Floors: a low score must not hide a risk that makes cheap attempts unsafe
  // or unprovable. Security work and work without tests are never 'simple',
  // and highly coupled security work is always 'complex'.
  if (cls === 'simple' && input.securitySensitive) {
    cls = 'medium';
    reasons.push('raised to medium: security-sensitive work is never classed simple');
  }
  if (cls === 'simple' && input.testAvailability === 'none') {
    cls = 'medium';
    reasons.push('raised to medium: without tests, proof needs extra attempts');
  }
  if (cls !== 'complex' && input.securitySensitive && input.coupling === 'high') {
    cls = 'complex';
    reasons.push('raised to complex: security-sensitive and highly coupled');
  }
  for (const f of factors) if (f.points > 0) reasons.push(`${f.factor} +${f.points}: ${f.note}`);
  reasons.unshift(`class ${cls}`);
  return { class: cls, score, max_score: maxScore, reasons, factors };
}

/** Points for a count: 0 up to the first bound, then one more per bound exceeded. */
function band(n: number, bounds: number[]): number {
  let points = 0;
  for (const b of bounds) if (n > b) points++;
  return points;
}

function validate(input: DifficultyInput): void {
  const fail = (msg: string): never => {
    throw new OrbitError('SCHEMA_INVALID', `classifyDifficulty: ${msg}`);
  };
  if (!input.contract || !Array.isArray(input.contract.acceptance_criteria)) fail('contract.acceptance_criteria must be an array');
  const failing = input.baseline?.failingChecks;
  if (!(Array.isArray(failing) || (typeof failing === 'number' && Number.isInteger(failing) && failing >= 0))) fail('baseline.failingChecks must be a list or a non-negative integer');
  if (!Number.isInteger(input.openQuestions) || input.openQuestions < 0) fail('openQuestions must be a non-negative integer');
  if (input.externalIntegrations !== undefined && (!Number.isInteger(input.externalIntegrations) || input.externalIntegrations < 0)) fail('externalIntegrations must be a non-negative integer');
  if (typeof input.uiRequired !== 'boolean') fail('uiRequired must be a boolean');
  if (typeof input.securitySensitive !== 'boolean') fail('securitySensitive must be a boolean');
  if (!Object.hasOwn(FAMILIARITY_POINTS, input.repoFamiliarity)) fail(`unknown repoFamiliarity ${String(input.repoFamiliarity)}`);
  if (!Object.hasOwn(TEST_POINTS, input.testAvailability)) fail(`unknown testAvailability ${String(input.testAvailability)}`);
  if (!Object.hasOwn(COUPLING_POINTS, input.coupling)) fail(`unknown coupling ${String(input.coupling)}`);
}
