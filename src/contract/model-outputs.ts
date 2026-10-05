/**
 * Structured outputs of model workers. The JSON Schemas in schemas/ are the
 * authority: they are what Claude (`--json-schema`) and Codex
 * (`--output-schema`) constrain generation with, and what the controller
 * validates every result against before using any field. The interfaces
 * below mirror them for type-safe access after validation.
 *
 * Everything a model returns is untrusted. Validation establishes shape, not
 * truth: paths, check ids, commands and scope named here are re-authorized
 * by the controller, and nothing in an output can declare the goal complete.
 */
import plannerSchema from '../../schemas/planner-output.schema.json' with { type: 'json' };
import implementerSchema from '../../schemas/implementer-output.schema.json' with { type: 'json' };
import diagnosisSchema from '../../schemas/diagnosis-output.schema.json' with { type: 'json' };
import reviewSchema from '../../schemas/review-output.schema.json' with { type: 'json' };
import inquisitorSchema from '../../schemas/inquisitor-output.schema.json' with { type: 'json' };
import curatorSchema from '../../schemas/curator-output.schema.json' with { type: 'json' };
import explorerSchema from '../../schemas/explorer-output.schema.json' with { type: 'json' };
import { OrbitError } from '../core/errors.ts';
import { validateAgainst } from './json-schema.ts';
import type { AmendmentProposal, AssumptionStatusValue } from './amendment-types.ts';
import { practiceProblems, type PracticeSelection } from './practices.ts';

export type { AmendmentChange, AmendmentProposal, AssumptionStatusValue } from './amendment-types.ts';
export type { EngineeringPractice, PracticeSelection } from './practices.ts';

export const MODEL_OUTPUT_SCHEMAS = {
  planner: plannerSchema as object,
  implementer: implementerSchema as object,
  diagnosis: diagnosisSchema as object,
  review: reviewSchema as object,
  inquisitor: inquisitorSchema as object,
  curator: curatorSchema as object,
  explorer: explorerSchema as object,
} as const;

export type ModelOutputKind = keyof typeof MODEL_OUTPUT_SCHEMAS;

/** Schema file name per kind, relative to schemas/, for adapters that pass a path. */
export const MODEL_OUTPUT_SCHEMA_FILES: Readonly<Record<ModelOutputKind, string>> = {
  planner: 'planner-output.schema.json',
  implementer: 'implementer-output.schema.json',
  diagnosis: 'diagnosis-output.schema.json',
  review: 'review-output.schema.json',
  inquisitor: 'inquisitor-output.schema.json',
  curator: 'curator-output.schema.json',
  explorer: 'explorer-output.schema.json',
};

export interface ModelOutputs {
  planner: PlannerOutput;
  implementer: ImplementerOutput;
  diagnosis: DiagnosisOutput;
  review: ReviewOutput;
  inquisitor: InquisitorOutput;
  curator: CuratorOutput;
  explorer: ExplorerOutput;
}

/** schemas/explorer-output.schema.json: candidate UI findings, unproven until reproduced as a failing test. */
export interface ExplorerOutput {
  observations: string[];
  candidate_findings: {
    id: string;
    summary: string;
    steps: string[];
    expected: string;
    observed: string;
    severity: 'critical' | 'high' | 'medium' | 'low';
    proposed_test: string;
  }[];
  coverage_notes: string;
}

/**
 * Validate a parsed model result. A failure is MALFORMED_OUTPUT (spec section
 * 14: bounded regeneration), never "empty result": a review that fails
 * validation is not a review with no findings.
 */
export function validateModelOutput<K extends ModelOutputKind>(kind: K, value: unknown): ModelOutputs[K] {
  const res = validateAgainst<ModelOutputs[K]>(MODEL_OUTPUT_SCHEMAS[kind], value);
  if (!res.ok) {
    throw new OrbitError('MALFORMED_OUTPUT', `${kind} output does not match ${MODEL_OUTPUT_SCHEMA_FILES[kind]}: ${res.errors.slice(0, 5).join('; ')}`, {
      kind,
      errors: res.errors,
    });
  }
  // The strict schema cannot say "each practice exactly once, with a reason", so that is checked here: a plan that
  // leaves a practice unaccounted for is malformed output (bounded regeneration), not a plan with fewer practices.
  if (kind === 'planner') {
    const problems = practiceProblems((res.value as PlannerOutput).practices);
    if (problems.length > 0) {
      throw new OrbitError('MALFORMED_OUTPUT', `planner output does not account for the engineering practices: ${problems.slice(0, 5).join('; ')}`, { kind, errors: problems });
    }
  }
  return res.value;
}

// ---------------------------------------------------------------------------
// Mirrors of the schemas. Keep in step with schemas/*-output.schema.json.

export type ChangeKind = 'add' | 'modify' | 'delete' | 'rename';
export type Level = 'low' | 'medium' | 'high';
export type Reversibility = 'reversible' | 'costly-to-reverse' | 'irreversible';

export interface PlannerCriterion {
  /** Planner-local key; the controller assigns AC ids. */
  key: string;
  statement: string;
  mandatory: boolean;
  ui: boolean;
  proof: string[];
  check_ids: string[];
  changes: { path: string; summary: string }[];
}

export interface PlannerOutput {
  objective: string;
  current_behavior: { statement: string; evidence: string[] }[];
  criteria: PlannerCriterion[];
  expected_changed_files: { path: string; change: ChangeKind; reason: string }[];
  allowed_paths: string[];
  required_check_ids: string[];
  non_goals: string[];
  risks: { risk: string; impact: Level; mitigation: string }[];
  /** One entry per engineering practice (spec section 5): selected, or omitted with a reason. */
  practices: PracticeSelection[];
  assumptions: { statement: string; basis: string; status: 'unverified' | 'supported' | 'needs-decision' }[];
  unresolved_decisions: { question: string; options: string[]; recommendation: string | null; material: boolean; affected_criteria: string[] }[];
  material_topics: string[];
}

export interface ImplementerOutput {
  summary: string;
  changed_paths: { path: string; change: ChangeKind; purpose: string }[];
  tests_added: { path: string; name: string; kind: 'unit' | 'integration' | 'e2e' | 'ui' | 'other'; criterion_ids: string[] }[];
  /** Claims only: the controller never runs `command` and reruns trusted checks itself. */
  checks_run: { check_id: string | null; command: string | null; claimed_result: 'passed' | 'failed' | 'error' | 'not-run'; note: string }[];
  evidence_refs: { criterion_id: string | null; ref: string; note: string }[];
  remaining_issues: { description: string; blocking: boolean; criterion_id: string | null }[];
  next_action: { kind: 'request-verification' | 'continue-implementation' | 'diagnose-failure' | 'needs-decision' | 'blocked'; detail: string };
}

export interface DiagnosisOutput {
  /** RepairBrief with `refuting: null` standing for an absent refutation. */
  repair_brief: {
    fingerprint: string;
    evidence: string[];
    hypotheses: { statement: string; supporting: string; refuting: string | null }[];
    experiment: string;
    expected_observation: string;
    scoped_fix: string;
    post_fix_checks: string[];
    preserved_constraints: string[];
  };
  fingerprint_comparison: {
    current: string;
    previous: string[];
    relation: 'first-occurrence' | 'repeated' | 'changed';
    progress: 'progress' | 'no-progress' | 'regression' | 'unknown';
    explanation: string;
  };
  competing_hypotheses: {
    id: string;
    statement: string;
    supporting_evidence: string[];
    refuting_evidence: string[];
    discriminating_experiment: string;
    expected_if_true: string;
    status: 'leading' | 'alternative' | 'ruled-out';
    previously_tested: boolean;
  }[];
  chosen_hypothesis_id: string;
  confidence: Level;
}

export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface ReviewFinding {
  id: string;
  severity: FindingSeverity;
  category: string;
  location: string | null;
  claim: string;
  evidence: string;
  suggested_validation: string | null;
}

export interface ReviewOutput {
  verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK';
  candidate_revision: string;
  findings: ReviewFinding[];
}

export type InquisitionMode = 'clarify' | 'challenge' | 'reconcile' | 'diagnose' | 'risk-review' | 'decision-record';

export interface InquisitorQuestion {
  question: string;
  changes: ('implementation' | 'proof' | 'authority' | 'scope')[];
  evidence: string[];
  options: { label: string; description: string; consequences: string }[];
  recommendation: string;
  recommendation_reason: string;
  safe_default: { exists: boolean; option: string | null; reason: string };
  material: boolean;
  affected_work: string[];
  unblocked_work: string[];
}

export interface InquisitorOutput {
  mode: InquisitionMode;
  trigger: string;
  facts: { statement: string; source: string }[];
  assumptions: { statement: string; basis: string }[];
  unknowns: { statement: string; material: boolean; blocks: string[] }[];
  ledger: {
    claim: string;
    source: string;
    confidence: Level;
    consequence_if_wrong: string;
    reversibility: Reversibility;
    validation_experiment: string | null;
    status: AssumptionStatusValue;
  }[];
  interpretations: { id: string; statement: string; impact: Level; reversibility: Reversibility; rank: number; evidence: string[] }[];
  chosen_experiment: {
    description: string;
    discriminates: string[];
    expected_observations: { interpretation_id: string; observation: string }[];
    authorization: string;
    cost: Level;
  } | null;
  autonomous_decisions: {
    decision: string;
    category: 'convention' | 'implementation-detail' | 'technical-hypothesis';
    rationale: string;
    evidence: string[];
    reversibility: Reversibility;
  }[];
  questions: InquisitorQuestion[];
  amendments: AmendmentProposal[];
}

/** A lesson as the curator proposes it: orbit.lesson/1 without id, status, scope and evidence sha256. */
export interface CuratedLesson {
  schema: 'orbit.lesson/1';
  kind: 'practice' | 'failure-pattern' | 'repair-recipe' | 'convention' | 'hazard';
  statement: string;
  rationale: string;
  applicability: {
    languages: string[];
    frameworks: string[];
    paths: string[];
    check_ids: string[];
    fingerprints: string[];
    roles: ('planner' | 'implementer' | 'verifier' | 'reviewer' | 'inquisitor')[];
    keywords: string[];
  };
  verification: string;
  evidence: { run_id: string; artifact: string; relation: 'supports' | 'contradicts' }[];
  provenance: {
    source: 'run' | 'ingest' | 'seed' | 'user';
    uri: string | null;
    derived_from: string[];
    generated_by: string;
    generated_at: string;
  };
  confidence: Level;
  code_free: boolean;
  supersedes: string | null;
}

export interface CuratorOutput {
  lessons: CuratedLesson[];
  discarded: { source: string; reason: string }[];
}
