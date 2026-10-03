/**
 * Orbit's learning layer: an evidence-backed knowledge graph.
 *
 * Hosted model weights never change. Orbit improves by
 *   1. retrieving lessons learned from verified run evidence into worker
 *      context (advisory, untrusted data; never authority),
 *   2. calibrating routing, allowances and difficulty from measured outcomes,
 *   3. distilling repeatedly confirmed lessons into versioned per-role prompt
 *      overlays, adopted automatically only when replay evals improve without
 *      regression, and rolled back automatically when live metrics regress.
 *
 * Nothing in this layer can change policy, hard caps, protected paths, checks,
 * tests or the base role prompts. Those are enforced outside prompts, so a bad
 * lesson can waste an attempt but cannot authorize anything.
 *
 * Storage: one graph per repository (.orbit/knowledge.sqlite) plus an opt-in
 * global graph (~/.orbit/knowledge.sqlite) that receives only code-free lessons
 * from repositories configured as shareable.
 *
 * Standard format: every node is a Lesson (schemas/lesson.schema.json); the
 * graph exports as JSON-LD using schema.org and W3C PROV-O terms.
 */

export const LESSON_KINDS = ['practice', 'failure-pattern', 'repair-recipe', 'convention', 'hazard'] as const;
export type LessonKind = (typeof LESSON_KINDS)[number];

export type LessonStatus = 'candidate' | 'validated' | 'deprecated' | 'rejected';
export type LessonScope = 'repo' | 'global';
/** Qualitative only: the spec forbids presenting invented scores as calibrated probabilities. */
export type Confidence = 'low' | 'medium' | 'high';

export interface Applicability {
  languages: string[];
  frameworks: string[];
  /** Repository path globs (repo scope only; stripped before global promotion). */
  paths: string[];
  check_ids: string[];
  /** Failure fingerprints this lesson is known to address. */
  fingerprints: string[];
  roles: string[];
  keywords: string[];
}

export interface EvidenceRef {
  run_id: string;
  /** Path relative to the run directory, or an artifact id. */
  artifact: string;
  sha256: string | null;
  relation: 'supports' | 'contradicts';
}

export interface Provenance {
  source: 'run' | 'ingest' | 'seed' | 'user';
  /** For ingest: file path, URL or PR reference. */
  uri: string | null;
  derived_from: string[];
  /** 'deterministic' or the exact model id of the curator. */
  generated_by: string;
  generated_at: string;
}

export interface Lesson {
  schema: 'orbit.lesson/1';
  id: string;
  kind: LessonKind;
  /** One imperative sentence. */
  statement: string;
  rationale: string;
  applicability: Applicability;
  /** How to check the lesson holds: a description, never an executable command. */
  verification: string;
  evidence: EvidenceRef[];
  provenance: Provenance;
  confidence: Confidence;
  status: LessonStatus;
  scope: LessonScope;
  /** Free of repository code, identifiers and paths; eligible for the global graph. */
  code_free: boolean;
  supersedes: string | null;
}

export const EDGE_TYPES = [
  'DERIVED_FROM',
  'SUPPORTED_BY',
  'CONTRADICTED_BY',
  'FIXED_BY',
  'CAUSED_BY',
  'APPLIES_TO',
  'SUPERSEDES',
  'INSTANCE_OF',
] as const;
export type EdgeType = (typeof EDGE_TYPES)[number];

export interface LessonStats {
  support: number;
  contradict: number;
  distinct_runs: number;
  retrieved: number;
  success_after_retrieval: number;
  failure_after_retrieval: number;
}

export interface RetrievalContext {
  runId: string;
  workerId: string | null;
  role: string;
  goal: string;
  paths: string[];
  checkIds: string[];
  fingerprints: string[];
  languages: string[];
  /** Hard ceiling on the advisory block's size. */
  maxTokens: number;
}

export interface RetrievedLesson {
  lesson: Lesson;
  stats: LessonStats;
  score: number;
  why: string[];
}

export type OverlayStatus = 'candidate' | 'evaluating' | 'active' | 'retired' | 'rolled_back' | 'rejected';

export interface PromptOverlay {
  id: string;
  role: string;
  scope: LessonScope;
  version: number;
  /** Guidance text appended after the base role prompt, inside an advisory fence. */
  content: string;
  lesson_ids: string[];
  status: OverlayStatus;
  parent_id: string | null;
  eval: OverlayEvaluation | null;
  created_at: string;
  activated_at: string | null;
}

export interface OverlayEvaluation {
  suite_id: string;
  cases: number;
  baseline: EvalMetrics;
  candidate: EvalMetrics;
  improved: boolean;
  regressions: string[];
  decided_at: string;
}

export interface EvalMetrics {
  verified_pass_rate: number;
  mean_attempts: number;
  mean_cost_usd: number | null;
  false_pass_rate: number;
}
