/**
 * Engineering practices (spec section 5, "Engineering best practices"):
 * "Select applicable requirements per task and justify omissions."
 *
 * The planner returns one entry per practice below, saying whether it applies
 * to this task and why. An entry that does not apply carries the reason it
 * can be left out; the reviewer is asked to reject an omission that is not
 * sound (review/packet.ts). The selection is stored on the contract
 * (`GoalContract.practices`), recorded as a `planning.practices` decision and
 * listed in the final report.
 *
 * The enum is mirrored in schemas/planner-output.schema.json and
 * schemas/contract.schema.json; the schema tests hold the three in step.
 * A strict structured-output schema cannot say "each value exactly once", so
 * `practiceProblems` checks that, and the justification, after the schema.
 */
import { wordTokens } from './wording.ts';

export const ENGINEERING_PRACTICES = [
  'behavior-tests',
  'empty-and-loading-states',
  'input-validation-and-authorization',
  'sensitive-data-handling',
  'compatibility-and-public-interfaces',
  'performance-hotspots',
  'accessibility',
  'documentation',
  'rollback-and-migration',
] as const;

export type EngineeringPractice = (typeof ENGINEERING_PRACTICES)[number];

/** What each practice asks for, in the spec's words; shown to the planner and the reviewer. */
export const PRACTICE_DESCRIPTIONS: Readonly<Record<EngineeringPractice, string>> = {
  'behavior-tests': 'Positive, negative, boundary, and error-path tests.',
  'empty-and-loading-states': 'Empty and loading states.',
  'input-validation-and-authorization': 'Input validation and authorization.',
  'sensitive-data-handling': 'Sensitive-data handling.',
  'compatibility-and-public-interfaces': 'Compatibility and public-interface behavior.',
  'performance-hotspots': 'Performance checks for material hotspots.',
  accessibility: 'Accessibility for UI work.',
  documentation: 'Documentation for public behavior changes.',
  'rollback-and-migration': 'Explicit rollback/migration plans when those actions are authorized.',
};

/** One planner decision about one practice (schemas/planner-output.schema.json `practices`). */
export interface PracticeSelection {
  practice: EngineeringPractice;
  /** True when the task needs the practice; false is an omission and must be justified. */
  applicable: boolean;
  /** Applicable: how the plan satisfies it. Omitted: why the task does not need it. */
  justification: string;
}

/** Answers that name no reason. */
const EMPTY_REASON = /^(?:n\/?a|none|nothing|no|not applicable|not needed|not relevant|irrelevant|skip(?:ped)?|tbd|todo|-+|\.+)$/i;
const MIN_OMISSION_WORDS = 3;

/**
 * Why a selection cannot be accepted; empty when it names every practice
 * once, with a reason for each, and an omission's reason says something.
 */
export function practiceProblems(selection: readonly PracticeSelection[]): string[] {
  const problems: string[] = [];
  const counts = new Map<string, number>();
  for (const s of selection) counts.set(s.practice, (counts.get(s.practice) ?? 0) + 1);
  for (const p of ENGINEERING_PRACTICES) {
    const n = counts.get(p) ?? 0;
    if (n === 0) problems.push(`practice "${p}" is neither selected nor justified as omitted`);
    else if (n > 1) problems.push(`practice "${p}" is listed ${n} times`);
  }
  for (const s of selection) {
    const reason = s.justification.trim();
    if (reason === '') problems.push(`practice "${s.practice}" has no justification`);
    else if (!s.applicable && (EMPTY_REASON.test(reason) || wordTokens(reason).length < MIN_OMISSION_WORDS)) {
      problems.push(`the omission of practice "${s.practice}" gives no reason (say why the task does not need it)`);
    }
  }
  return problems;
}

/** A justification is a sentence or two; this keeps one inside the contract schema's bound once the controller adds to it. */
const MAX_JUSTIFICATION_CHARS = 1000;

/** The selection in the canonical practice order, justifications trimmed and bounded. Assumes `practiceProblems` found nothing. */
export function normalizePractices(selection: readonly PracticeSelection[]): PracticeSelection[] {
  const out: PracticeSelection[] = [];
  for (const p of ENGINEERING_PRACTICES) {
    const s = selection.find((x) => x.practice === p);
    if (s) out.push({ practice: p, applicable: s.applicable, justification: s.justification.trim().slice(0, MAX_JUSTIFICATION_CHARS) });
  }
  return out;
}
