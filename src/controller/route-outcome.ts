/**
 * Route outcomes of implementation attempts (issue #168): one row in `route_outcomes` per attempt whose evidence
 * settles, the measured input `routing.learning` reads on later runs.
 *
 * An attempt settles when the candidate it produced is judged on its own merits:
 *  - `failed`: a trusted check ran on the candidate and failed, and the failure is not the environment's;
 *  - `rejected`: review sent the verified candidate back to repair;
 *  - `verified`: verification passed and review cleared the tree.
 *
 * Nothing is recorded for an attempt that never became a candidate (a provider that was unavailable, a lost or
 * refused session), for an environment failure, for a gate refusal that ran no check (scope, size, policy), or for a
 * run that stopped before its candidate was judged: none of those say how well the model did the work.
 *
 * The exclusion rests first on where the controller calls this, after its own environment classification. A run can
 * also find out later that a failed check was the environment's or misconfigured; it then ends with that failure class
 * (issue #167), and the readers of `route_outcomes` leave that run's failures out (ROUTE_OUTCOME_NOT_THE_ROUTES).
 */
import type { CandidateRecord } from '../evidence/store.ts';
import { getDecision } from '../storage/decisions.ts';
import { recordRouteOutcome } from '../routing/usage.ts';
import { roundUsd } from '../routing/pricing.ts';
import { WORK_KINDS, type RouteOutcome, type WorkKind } from '../routing/types.ts';
import type { RunContext } from './context.ts';

export interface RouteSettlement {
  outcome: Extract<RouteOutcome, 'verified' | 'failed' | 'rejected'>;
  /** The record that settled the attempt: an evidence report id, or the review gate of a tree. */
  evidenceRef: string;
  /** True when the result was caused by the environment or the harness, not the candidate: nothing is recorded. */
  environment?: boolean;
}

/** The route decision id of an implementation attempt (routeFor's purpose `implement:<n>`). */
export function implementRouteDecisionId(runId: string, attempt: number): string {
  return `dec-route-${runId}-implement_${attempt}`;
}

/**
 * Record the outcome of the attempt that produced `cand`, once. Returns the row id, or null when nothing was recorded
 * (an environment result, or no route decision with a provider and model for the attempt). Never throws on missing
 * measurements: a cost or token count that is not fully known is stored as null, never as zero.
 */
export function settleRouteOutcome(ctx: RunContext, cand: CandidateRecord, settlement: RouteSettlement): number | null {
  if (settlement.environment) return null;
  const decision = getDecision(ctx.db, implementRouteDecisionId(ctx.run.id, cand.attempt));
  const d = (decision?.data ?? null) as { provider?: unknown; model?: unknown; effort?: unknown; work_kind?: unknown } | null;
  if (!d || typeof d.provider !== 'string' || typeof d.model !== 'string' || !d.provider || !d.model) return null;
  const workKind = (WORK_KINDS as readonly string[]).includes(String(d.work_kind)) ? (d.work_kind as WorkKind) : 'routine-code';
  const spent = attemptSpend(ctx, cand.attempt);
  return recordRouteOutcome(
    ctx.db,
    {
      runId: ctx.run.id,
      workKind,
      provider: d.provider,
      modelId: d.model,
      outcome: settlement.outcome,
      costUsd: spent.costUsd,
      tokens: spent.tokens,
      role: 'implementer',
      effort: typeof d.effort === 'string' ? d.effort : null,
      difficulty: ctx.run.difficulty ?? null,
      attemptKey: cand.id,
      evidenceRef: settlement.evidenceRef,
    },
    ctx.clock,
  );
}

/**
 * What the implementer sessions of one attempt cost and produced. The cost is known only when every session of the
 * attempt has a usage record with a cost; one unmeasured session makes the whole attempt's cost unknown.
 */
function attemptSpend(ctx: RunContext, attempt: number): { costUsd: number | null; tokens: number | null } {
  const rows = ctx.db.all<{ worker_id: string; cost_usd: number | null; cost_source: string | null; input_tokens: number | null; output_tokens: number | null; has_usage: number }>(
    `SELECT w.id AS worker_id, u.cost_usd, u.cost_source, u.input_tokens, u.output_tokens, (u.id IS NOT NULL) AS has_usage
       FROM workers w LEFT JOIN usage u ON u.worker_id = w.id AND u.run_id = w.run_id
      WHERE w.run_id = ? AND w.role = 'implementer' AND w.attempt = ?`,
    ctx.run.id,
    attempt,
  );
  if (rows.length === 0) return { costUsd: null, tokens: null };
  const costKnown = rows.every((r) => r.has_usage === 1 && r.cost_usd !== null && r.cost_source !== 'unavailable');
  const tokensKnown = rows.every((r) => r.has_usage === 1 && r.input_tokens !== null && r.output_tokens !== null);
  return {
    costUsd: costKnown ? roundUsd(rows.reduce((a, r) => a + (r.cost_usd as number), 0)) : null,
    tokens: tokensKnown ? rows.reduce((a, r) => a + (r.input_tokens as number) + (r.output_tokens as number), 0) : null,
  };
}
