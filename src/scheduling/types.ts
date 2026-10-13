/**
 * Scheduling contracts (spec sections 7 and 8): difficulty classes, budget
 * counters and the units of work the agent scheduler admits. Plain data only,
 * so the controller can persist and replay any of it.
 */
import type { WorkerRole } from '../adapters/types.ts';

export const DIFFICULTY_CLASSES = ['simple', 'medium', 'complex'] as const;
export type DifficultyClass = (typeof DIFFICULTY_CLASSES)[number];

export type Familiarity = 'high' | 'medium' | 'low';
export type TestAvailability = 'good' | 'partial' | 'none';
export type Coupling = 'low' | 'medium' | 'high';

/** One scored factor. Every factor is recorded, including those that scored zero. */
export interface DifficultyFactor {
  factor: string;
  value: string | number | boolean;
  points: number;
  max: number;
  note: string;
}

export interface DifficultyAssessment {
  class: DifficultyClass;
  score: number;
  max_score: number;
  reasons: string[];
  factors: DifficultyFactor[];
}

/**
 * Discrete counters are consumed before the work they count starts; measured
 * counters (wall time, cost) are recorded after the fact, because spend that
 * already happened cannot be refused.
 */
export const DISCRETE_COUNTERS = [
  'implementation_attempts',
  'diagnostic_experiments',
  'review_rounds',
  'ci_repair_cycles',
  'infrastructure_retries',
  'recovery_attempts',
] as const;
export const MEASURED_COUNTERS = ['wall_ms', 'cost_usd'] as const;
export const SESSION_COUNTER = 'worker_turns_per_session' as const;
export const BUDGET_COUNTERS = [...DISCRETE_COUNTERS, SESSION_COUNTER, ...MEASURED_COUNTERS] as const;

export type DiscreteCounter = (typeof DISCRETE_COUNTERS)[number];
export type MeasuredCounter = (typeof MEASURED_COUNTERS)[number];
export type BudgetCounter = (typeof BUDGET_COUNTERS)[number];

export interface CounterState {
  counter: string;
  used: number;
  allowance: number;
  hard_cap: number;
  remaining: number;
}

/** Spec section 7 progress kinds. Anything else a caller sends is ignored and reported as such. */
export interface ProgressReport {
  newly_supported_criteria?: string[];
  fixed_checks?: string[];
  eliminated_hypotheses?: string[];
  localized_fault?: string | null;
  resolved_ambiguity?: string[];
  [other: string]: unknown;
}

export interface ExtensionRequest {
  counter: DiscreteCounter;
  progress: ProgressReport;
  hypothesisIsNew: boolean;
  withinScope: boolean;
  /** Spec: grant only while a specific failure remains. Defaults to true. */
  failureRemains?: boolean;
  reason?: string;
  nextExperiment?: string;
  /** Expected cost and wall time of the extra attempt; derived from spend so far when absent. */
  estimatedCostUsd?: number | null;
  estimatedWallMs?: number | null;
  role?: BudgetRole;
}

/** The spec section 7 decision object, extended with every check that was applied. */
export interface ExtensionDecision {
  decision: 'extend_attempt_allowance' | 'extend_allowance' | 'deny_extension';
  counter: DiscreteCounter;
  previous_allowance: number;
  new_allowance: number;
  hard_cap: number;
  reason: string;
  progress: ProgressReport;
  ignored_progress: string[];
  hypothesis_is_new: boolean;
  within_scope: boolean;
  next_experiment: string | null;
  within_hard_limits: boolean;
  reserve_preserved: boolean;
  denied_because: string[];
}

export type BudgetRole = WorkerRole | 'curator';
export type BudgetPhase = 'work' | 'final';

export interface ReserveState {
  fraction: number;
  cost_usd: number;
  wall_ms: number;
  /** How the reserve is apportioned across the closing phases, for reporting. */
  shares: { final_verification: number; review: number; reporting: number };
}

export type CostMeasurementState = 'no_usage' | 'measured' | 'estimated' | 'partially_unmeasured' | 'unmeasured';

export interface CostMeasurement {
  state: CostMeasurementState;
  reported_records: number;
  estimated_records: number;
  unavailable_records: number;
  /** Charged to cost_usd at conservative per-role ceilings because the provider reported no cost. */
  ceiling_charged_usd: number;
  ceiling_charges: number;
  note: string;
}

/**
 * What the cost budget charged and what that charge is made of, so the report, the timeline and status explain one
 * figure instead of showing several. `charged_usd` is the figure the cost cap is checked against.
 */
export interface SpendBreakdown {
  /**
   * `current` for a run started on 0.3.1 or later, whose every charge names the usage record it covers. `legacy` for a
   * run started before, accounted under the rules of the version that started it: its session figures are its usage
   * records as recorded, its stand-in charges are in `legacy_charges`, and nothing is matched between them.
   */
  accounting: 'current' | 'legacy';
  /** cost_usd as the budget charged it; null before PLANNING creates the budget. */
  charged_usd: number | null;
  /** Spend the providers reported. */
  reported_usd: number;
  reported_sessions: number;
  /** Priced from tokens and list pricing, for sessions that reported no cost. */
  estimated_usd: number;
  estimated_sessions: number;
  /** Conservative stand-ins charged for sessions that reported no cost and could not be priced. */
  ceiling_usd: number;
  ceiling_sessions: number;
  /** Sessions with no reported cost that nothing priced or charged. */
  unpriced_sessions: number;
  /**
   * Every session whose spend no provider measured, oldest first: those charged at a ceiling (`charged_usd`, what was
   * charged) and those with no reported cost that no charge names (`charged_usd` null).
   */
  unmeasured_sessions: { usage_id: number; worker_id: string | null; role: string | null; charged_usd: number | null }[];
  /** The part of the charge spent before PLANNING and charged when the budget was created. */
  precharged_usd: number;
  /** Charged beyond every recorded session: a session charged again after a controller restart. Null for a `legacy` run with a budget, whose charges name no session. */
  unmatched_usd: number | null;
  /** Recorded spend the budget has not charged; all of it before PLANNING creates the budget. Null for a `legacy` run with a budget. */
  uncharged_usd: number | null;
  /** For a `legacy` run only: the stand-in charges for sessions that reported no cost, as its budget recorded them. */
  legacy_charges?: { ceiling_usd: number; ceiling_charges: number; token_estimated_usd: number; token_estimated_charges: number };
  /** Why nothing is charged while the run has no budget (blocked or ended before PLANNING created it, or not there yet); null once it has one. */
  uncharged_reason: string | null;
  /** Which figure is the charge and what it adds to the reported spend, in one sentence. */
  explanation: string;
}

/** Work admitted earlier whose cost has not been charged yet. */
export interface CommittedWork {
  estimatedCostUsd?: number | null;
  /** 'check' runs no model, so its unknown cost is zero; any other role's unknown cost is its ceiling. */
  role?: BudgetRole | 'check';
}

export interface AdmissionRequest {
  estimatedCostUsd?: number | null;
  estimatedWallMs?: number | null;
  role?: BudgetRole;
  phase?: BudgetPhase;
  /**
   * Running sessions and units admitted earlier in the same plan. Cost is
   * charged when a session ends, so without these, parallel workers would
   * each be admitted against the same remaining budget. Wall time is not
   * summed: parallel work overlaps on the clock.
   */
  committed?: CommittedWork[];
}

export interface AdmissionDecision {
  admitted: boolean;
  phase: BudgetPhase;
  reasons: string[];
  cost: { used: number; committed: number; estimate: number; basis: 'estimate' | 'ceiling'; limit: number; remaining_after: number };
  wall: { used: number; estimate: number; basis: 'estimate' | 'ceiling'; limit: number; remaining_after: number };
  reserve: ReserveState;
  cost_measurement: CostMeasurement;
}

// ---------------------------------------------------------------------------
// Agent scheduling

export type WorkUnitStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';
export type CancelCondition = 'revision-changed' | 'dependency-failed';

/** Spec section 8: every task has ownership, inputs, dependencies, revision, cancellation conditions and a budget. */
export interface WorkUnit {
  id: string;
  role: BudgetRole | 'check';
  /** Writers edit a worktree; readers (planning, review, checks) do not. */
  writer: boolean;
  /** Repository-relative globs this unit may write. A writer with none is treated as owning everything. */
  ownedPaths: string[];
  dependsOn: string[];
  /** Candidate revision (tree hash) the unit works against; null when not revision-bound. */
  revision: string | null;
  cancelWhen: CancelCondition[];
  budget: { costUsd?: number | null; wallMs?: number | null; maxTurns?: number | null };
  /** Provider adapter id, for rate-limit backoff. Null for deterministic work such as checks. */
  provider?: string | null;
  /** Worktree path when known. Writers never share one with any other active unit. */
  worktree?: string | null;
  status?: WorkUnitStatus;
  /** Drives a browser (Playwright): limited to one per core pair, whatever the other slots allow. */
  browser?: boolean;
}

export interface Capacity {
  /** Hard ceiling on concurrently active units. Never below one, so a run can always progress. */
  slots: number;
  default_parallelism: number;
  limited_by: string[];
  parts: { parallel_workers: number; cpu: number; memory: number };
  memory: { free_mb: number; per_worker_mb: number; headroom_mb: number };
  backoff: Record<string, { until: number; consecutive: number }>;
  notes: string[];
  /** Concurrent browser units: one Playwright run per core pair (at least one). */
  browser_slots: number;
}

export interface SchedulePlan {
  start: WorkUnit[];
  deferred: { id: string; reason: string }[];
  limit: number;
  running: number;
  capacity: Capacity;
  /**
   * Units admitted beside another active unit on the same revision: each re-reads the shared context (diff,
   * evidence, packet), and that duplicated reading was charged to admission as `usd`.
   */
  context_duplication: { id: string; shared_with: string; usd: number }[];
  /**
   * Writers admitted while other writers were active: each must later be integrated serially with them, and that
   * merge overhead was charged to admission as `usd`.
   */
  merge_overhead: { id: string; alongside: string[]; usd: number }[];
}

export interface ObsoleteUnit {
  unit: WorkUnit;
  reason: string;
}
