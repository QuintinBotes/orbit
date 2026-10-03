import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { sha256 } from '../core/hash.ts';
import type { GoalContract } from '../contract/types.ts';
import type { EvalMetrics, PromptOverlay } from './types.ts';

/**
 * Replay evaluation of prompt overlays.
 *
 * A replay suite is built from past runs that succeeded: each case is the
 * goal, the frozen contract, the base revision it started from and the check
 * ids its contract required. The controller implements EvalRunner (it owns
 * workers, worktrees and checks); this module defines the shapes, aggregates
 * results into metrics and compares two sets of metrics.
 */

export interface ReplayCase {
  /** Stable: derived from the source run id. */
  id: string;
  run_id: string;
  goal: string;
  contract: GoalContract;
  contract_hash: string | null;
  base_revision: string;
  check_ids: string[];
}

export interface ReplaySuite {
  /** Stable: derived from the case ids, so the same runs give the same suite id. */
  id: string;
  /** The role whose overlay this suite evaluates, or null for any. */
  role: string | null;
  created_at: string;
  cases: ReplayCase[];
}

/** One replay of one case under one overlay, as the controller measured it. */
export interface CaseResult {
  case_id: string;
  /** Reached a fresh PASS on every required check, bound to the replayed tree. */
  verified: boolean;
  attempts: number;
  /** null when the provider reported no cost and none could be estimated. */
  cost_usd: number | null;
  /** Claimed to pass but failed independent verification or later review. */
  false_pass: boolean;
}

export interface EvalRunner {
  /** Replay one case from its base revision with `overlay` appended to the role prompt (null = no overlay). */
  runCase(suite: ReplaySuite, replayCase: ReplayCase, overlay: PromptOverlay | null): Promise<CaseResult>;
}

export interface ReplaySuiteOptions {
  /** Most recent successful runs to include. */
  limit?: number;
  role?: string | null;
}

interface RunRow {
  id: string;
  goal: string;
  contract_json: string;
  contract_hash: string | null;
  base_revision: string;
  created_at: number;
}

/**
 * Build a suite from the most recent SUCCEEDED runs that have a frozen
 * contract and a base revision. Runs whose contract no longer parses are
 * skipped rather than guessed at.
 */
export function buildReplaySuite(runDb: OrbitDb, options: ReplaySuiteOptions, clock: Clock): ReplaySuite {
  const limit = Math.max(1, Math.min(options.limit ?? 20, 500));
  const rows = runDb.all<RunRow>(
    `SELECT id, goal, contract_json, contract_hash, base_revision, created_at FROM runs
     WHERE state = 'SUCCEEDED' AND contract_json IS NOT NULL AND base_revision IS NOT NULL
     ORDER BY created_at DESC, id DESC`,
  );
  const cases: ReplayCase[] = [];
  for (const r of rows) {
    // The limit counts usable cases, so an unparsable contract does not shrink the suite.
    if (cases.length >= limit) break;
    let contract: GoalContract;
    try {
      contract = JSON.parse(r.contract_json) as GoalContract;
    } catch {
      continue;
    }
    if (!contract || typeof contract !== 'object' || !Array.isArray(contract.required_check_ids)) continue;
    cases.push({
      id: `case-${sha256(r.id).slice(0, 12)}`,
      run_id: r.id,
      goal: r.goal,
      contract,
      contract_hash: r.contract_hash,
      base_revision: r.base_revision,
      check_ids: [...new Set(contract.required_check_ids.filter((c): c is string => typeof c === 'string'))].sort(),
    });
  }
  cases.sort((a, b) => a.run_id.localeCompare(b.run_id));
  return {
    id: `suite-${sha256(cases.map((c) => c.id).join('\n')).slice(0, 12)}`,
    role: options.role ?? null,
    created_at: new Date(clock.now()).toISOString(),
    cases,
  };
}

/**
 * Metrics over a set of case results. mean_cost_usd is the cost per accepted
 * (verified) case, the figure ADR 0002 compares; it is null when any case's
 * cost is unknown or nothing was accepted, never a silent zero.
 */
export function aggregateMetrics(results: readonly CaseResult[]): EvalMetrics {
  const n = results.length;
  if (n === 0) return { verified_pass_rate: 0, mean_attempts: 0, mean_cost_usd: null, false_pass_rate: 0 };
  const verified = results.filter((r) => r.verified).length;
  const attempts = results.reduce((s, r) => s + r.attempts, 0);
  const costs = results.map((r) => r.cost_usd);
  const totalCost = costs.every((c): c is number => c !== null) ? costs.reduce((s: number, c) => s + (c as number), 0) : null;
  return {
    verified_pass_rate: verified / n,
    mean_attempts: attempts / n,
    mean_cost_usd: totalCost === null || verified === 0 ? null : totalCost / verified,
    false_pass_rate: results.filter((r) => r.false_pass).length / n,
  };
}

export type MetricName = keyof EvalMetrics;

export interface MetricComparison {
  improvements: MetricName[];
  regressions: MetricName[];
  ties: MetricName[];
  /** Neither better nor worse can be claimed (cost unmeasured on both sides, or on the baseline only). */
  unmeasured: MetricName[];
}

/** Differences smaller than this are float noise, and count as ties. */
export const METRIC_EPSILON = 1e-9;

const HIGHER_IS_BETTER: Record<MetricName, boolean> = {
  verified_pass_rate: true,
  mean_attempts: false,
  mean_cost_usd: false,
  false_pass_rate: false,
};

/**
 * Compare candidate against baseline metric by metric. A tie is not an
 * improvement. A candidate whose cost is unmeasured while the baseline's was
 * measured counts as a regression: no regression must be shown, not assumed.
 */
export function compareMetrics(baseline: EvalMetrics, candidate: EvalMetrics): MetricComparison {
  const out: MetricComparison = { improvements: [], regressions: [], ties: [], unmeasured: [] };
  for (const name of Object.keys(HIGHER_IS_BETTER) as MetricName[]) {
    const b = baseline[name];
    const c = candidate[name];
    if (b === null || c === null) {
      if (b !== null && c === null) out.regressions.push(name);
      else out.unmeasured.push(name);
      continue;
    }
    const delta = HIGHER_IS_BETTER[name] ? c - b : b - c;
    if (delta > METRIC_EPSILON) out.improvements.push(name);
    else if (delta < -METRIC_EPSILON) out.regressions.push(name);
    else out.ties.push(name);
  }
  return out;
}

function checkResult(result: CaseResult, expectedId: string): CaseResult {
  const ok =
    result &&
    result.case_id === expectedId &&
    typeof result.verified === 'boolean' &&
    typeof result.false_pass === 'boolean' &&
    Number.isFinite(result.attempts) &&
    result.attempts >= 0 &&
    (result.cost_usd === null || (Number.isFinite(result.cost_usd) && result.cost_usd >= 0));
  if (!ok) throw new OrbitError('MALFORMED_OUTPUT', `eval runner returned an invalid result for ${expectedId}`);
  return result;
}

export interface OverlayReplayResult {
  suite_id: string;
  cases: number;
  baseline: EvalMetrics;
  candidate: EvalMetrics;
  results: { baseline: CaseResult[]; candidate: CaseResult[] };
}

/**
 * Replay every case under the baseline overlay (the active one, or none) and
 * under the candidate, sequentially and in suite order, so two evaluations of
 * the same suite are comparable run for run.
 */
export async function evaluateOverlay(runner: EvalRunner, suite: ReplaySuite, baseline: PromptOverlay | null, candidate: PromptOverlay): Promise<OverlayReplayResult> {
  const baseResults: CaseResult[] = [];
  const candResults: CaseResult[] = [];
  for (const c of suite.cases) {
    baseResults.push(checkResult(await runner.runCase(suite, c, baseline), c.id));
    candResults.push(checkResult(await runner.runCase(suite, c, candidate), c.id));
  }
  return {
    suite_id: suite.id,
    cases: suite.cases.length,
    baseline: aggregateMetrics(baseResults),
    candidate: aggregateMetrics(candResults),
    results: { baseline: baseResults, candidate: candResults },
  };
}
