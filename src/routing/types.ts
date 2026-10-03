/**
 * Routing contracts (spec section 8): the model registry's view of a model,
 * eligibility requirements, route signals and the recorded route decision.
 * Decisions are plain JSON-ready objects so the controller can persist them
 * without this module touching the decisions store.
 */
import type { DifficultyClass } from '../scheduling/types.ts';

/** Execution surfaces Orbit drives. API availability does not imply CLI availability. */
export const SURFACES = ['claude-cli', 'codex-cli'] as const;
export type Surface = (typeof SURFACES)[number];

/** Where each registry value came from (see data/models.json provenance_legend). */
export type Provenance = 'stated' | 'derived' | 'unverified' | 'runtime' | 'observed';

/** USD per million tokens. */
export interface ModelPricing {
  input: number;
  output: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
}

export interface SurfaceState {
  surface: Surface;
  /** null until validated; never assumed from API availability. */
  available: boolean | null;
  detail: string | null;
  checkedAt: number | null;
}

export interface ModelCapabilities {
  tools: boolean | null;
  structuredOutput: boolean | null;
  vision: boolean | null;
  effortLevels: string[];
  defaultEffort: string | null;
}

export interface ModelLimits {
  contextTokens: number | null;
  /** The model's own output maximum. */
  maxOutputTokens: number | null;
  /** Claude Code's per-request max_tokens cap, observed in modelUsage; not the model maximum. */
  cliMaxOutputTokens: number | null;
  observedAt: number | null;
}

export interface ModelEligibility {
  aliases: string[];
  cliAlias: string | null;
  minCliVersion: string | null;
  /** Routed only when routing.allowed_models names it explicitly; a wildcard does not count. */
  requiresExplicitPolicy: boolean;
  /** The provider's own recommended model (codex catalog), one basis for review qualification. */
  providerDefault: boolean;
  notes: string[];
  provenance: Record<string, Provenance>;
}

export interface ObservedCost {
  samples: number;
  costUsd: number;
  /** The same usage priced at the registry's list pricing, when pricing is known. */
  listEstimateUsd: number | null;
  ratioToList: number | null;
  costBasis: string | null;
  lastAt: number;
}

export interface ModelEvaluation {
  observedCost: ObservedCost | null;
  /** Roles this model passed an evaluation for, e.g. 'safety-review'. */
  qualifiedFor: string[];
  /** Work kinds for which a recorded evaluation justified this model's added expense. */
  justifiedWorkKinds: string[];
}

export interface ModelEntry {
  modelId: string;
  provider: string;
  family: string | null;
  displayName: string | null;
  surfaces: SurfaceState[];
  capabilities: ModelCapabilities;
  limits: ModelLimits | null;
  pricing: ModelPricing | null;
  eligibility: ModelEligibility;
  evaluation: ModelEvaluation;
  latencyMs: number | null;
  available: boolean;
  refreshedAt: number | null;
}

export interface EligibilityRequirements {
  surface: Surface;
  /** policy routing.allowed_models: exact ids, aliases, family names, or `<provider>:*`. */
  allowedModels: readonly string[];
  provider?: string;
  minContext?: number;
  vision?: boolean;
  structuredOutput?: boolean;
}

export interface EligibilityAssessment {
  eligible: ModelEntry[];
  excluded: { model: ModelEntry; reasons: string[] }[];
}

/** A Claude result's `modelUsage[model]` (claude-headless-and-sandbox.md section 1.3). Parsed tolerantly. */
export interface ClaudeModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  thinkingTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  webSearchRequests?: number;
  costUSD?: number;
  contextWindow?: number;
  maxOutputTokens?: number;
  canonicalModel?: string;
  provider?: string;
  costBasis?: string;
}

// ---------------------------------------------------------------------------
// Routing

export const WORK_KINDS = [
  'extraction',
  'log-classification',
  'routine-code',
  'focused-tests',
  'architecture',
  'complex-diagnosis',
  'long-horizon',
  'screenshot',
  'safety-review',
  'curation',
] as const;
export type WorkKind = (typeof WORK_KINDS)[number];

export const ROUTE_OUTCOMES = ['verified', 'failed', 'rejected', 'error', 'cancelled'] as const;
/**
 * verified: the attempt's output passed verification (and review, for candidates).
 * failed: verification failed. rejected: review rejected it.
 * error, cancelled: infrastructure noise; excluded from success rates.
 */
export type RouteOutcome = (typeof ROUTE_OUTCOMES)[number];

/** Measured outcomes per route, the calibration input to expected-cost routing. */
export interface RouteStat {
  workKind: string;
  provider: string;
  modelId: string;
  samples: number;
  verified: number;
  failed: number;
  rejected: number;
  errors: number;
  /** verified / (verified + failed + rejected); null without such outcomes. */
  successRate: number | null;
  meanCostUsd: number | null;
  costSamples: number;
  meanTokens: number | null;
}

export interface PreviousRoute {
  provider: string;
  model: string;
  effort?: string | null;
  outcome?: RouteOutcome | null;
  /** References to recorded evidence about that attempt (failure ids, evidence report ids). */
  evidence?: string[];
}

export interface RouteSignals {
  difficulty: DifficultyClass;
  /** 1-based attempt number for this piece of work. */
  attempt: number;
  /**
   * Equivalent failures (same fingerprint) observed so far, counted from
   * durable failure records. Escalates only when `evidence` references those
   * records; a bare count is recorded as ignored, though it still blocks
   * routing back down.
   */
  repeatedFingerprints: number;
  previousRoute?: PreviousRoute | null;
  criticalSecurity?: boolean;
  /**
   * The hard diagnosis that caused an escalation is solved and no equivalent
   * failure has repeated since; routine follow-up work may route back down.
   */
  diagnosisSolved?: boolean;
  /** Unresolved ambiguity in the material being interpreted. */
  ambiguity?: boolean;
  /** The change couples several subsystems. */
  coupled?: boolean;
  visualComplexity?: 'low' | 'high';
  /** References to recorded evidence backing escalation. */
  evidence?: string[];
  /** For safety review: the provider that produced the candidate under review. */
  implementerProvider?: string;
  /** What a worker said about itself. Recorded and ignored: escalation follows observed difficulty only. */
  workerClaims?: { confidence?: string | number; requestedModel?: string; requestedEscalation?: boolean };
}

/** The subset of trusted configuration routing reads. OrbitConfig satisfies it. */
export interface RoutingPolicy {
  routing: { allowed_models: string[]; overrides: Record<string, string> };
  review: { independent_provider_required: boolean; preferred_provider: string; fallback_same_provider_allowed: boolean };
  providers: Record<string, { model: string | null; data_policy_eligible: boolean; reasoning_effort?: string | null }>;
  scheduler?: { repeated_failure_threshold: number };
}

export type CostBasis = 'measured' | 'blended' | 'prior' | 'unavailable';

export interface CostBreakdown {
  execution: number;
  likely_repairs: number;
  verification: number;
  review: number;
  coordination: number;
}

export interface RouteAlternative {
  provider: string;
  model: string;
  family: string | null;
  eligible: boolean;
  expected_cost_per_verified_task: number | null;
  cost_basis: CostBasis;
  rejected_because: string;
}

export interface RouteJustification {
  /** Observed-difficulty signals acted on. Every escalation has at least one; a signal that could not raise the tier raised effort instead. */
  signals: { signal: string; detail: string; evidence: string[] }[];
  evidence: string[];
  /** Inputs recorded but deliberately not acted on (worker confidence, superseded signals). */
  ignored: string[];
}

export interface RouteRef {
  provider: string;
  model: string;
  family: string | null;
}

export interface RouteDecision {
  kind: 'route';
  /** One line for the decisions table. */
  summary: string;
  work_kind: WorkKind;
  provider: string;
  model: string;
  surface: Surface;
  family: string | null;
  effort: string | null;
  reason: string;
  justification: RouteJustification;
  alternatives_considered: RouteAlternative[];
  expected_cost_per_verified_task: number | null;
  expected_cost_breakdown: CostBreakdown | null;
  cost_basis: CostBasis;
  success_probability: number;
  attempt: number;
  difficulty: DifficultyClass;
  escalated_from?: RouteRef;
  down_routed_from?: RouteRef;
}
