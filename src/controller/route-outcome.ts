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
 * The exclusion rests first on where the controller calls this, after its own environment classification. When a run
 * ends with failure class `environment` or `check-misconfigured` (issue #167) on the evidence of an attempt that was
 * recorded, the readers of `route_outcomes` leave that one attempt out (ROUTE_OUTCOME_NOT_THE_ROUTES).
 *
 * An outcome belongs to an implementation attempt, not to a candidate: an attempt that reproduces an earlier tree gets
 * the earlier candidate back (same tree, same candidate, still naming the earlier attempt), and is still an attempt of
 * its own, with its own route and its own cost.
 */
import type { CandidateRecord } from '../evidence/store.ts';
import { getDecision, listDecisions, recordDecision } from '../storage/decisions.ts';
import { providerFamily } from '../policy/config.ts';
import { recordRouteOutcome } from '../routing/usage.ts';
import { roundUsd } from '../routing/pricing.ts';
import { WORK_KINDS, type RouteOutcome, type WorkKind } from '../routing/types.ts';
import { CANDIDATE_EVENT, type RunContext } from './context.ts';

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

/** A partner implementer skipped for the rest of a run (issue #176): out of quota, a failed login, or no writable tier. */
export const PARTNER_SKIPPED_KIND = 'routing.partner-skipped';

/** Partners skipped for the rest of this run, with why. */
export function skippedPartners(ctx: Pick<RunContext, 'db' | 'run'>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const d of listDecisions(ctx.db, ctx.run.id, { kind: PARTNER_SKIPPED_KIND })) {
    const data = d.data as { provider?: unknown; reason?: unknown };
    if (typeof data.provider === 'string' && !(data.provider in out)) out[data.provider] = typeof data.reason === 'string' ? data.reason : 'skipped';
  }
  return out;
}

/**
 * Skip a partner for the rest of the run: its quota or login failed (FR-005), so the failure is classed `credentials`
 * and charged to no candidate; the attempt it held goes on with the next route. False for Claude, which is never skipped.
 */
export function skipPartner(ctx: RunContext, provider: string, attempt: number | null, reason: string): boolean {
  const family = providerFamily(provider);
  if (family !== 'codex' && family !== 'muse') return false;
  const id = `dec-${ctx.run.id}-partner-skipped-${provider}`;
  if (getDecision(ctx.db, id)) return true;
  recordDecision(
    ctx.db,
    ctx.runDir,
    { id, runId: ctx.run.id, kind: PARTNER_SKIPPED_KIND, summary: `partner implementer ${provider} skipped for the rest of the run${attempt === null ? '' : ` (attempt ${attempt} goes on without it)`}: ${reason}`.slice(0, 1000), data: { provider, attempt, reason, failure_class: 'credentials' } },
    ctx.clock,
    { actor: ctx.ownerId },
  );
  return true;
}

/** How many candidates of each partner failed verification or review in this run (issue #176, US1 scenario 2). */
export function partnerFailures(ctx: Pick<RunContext, 'db' | 'run'>): Record<string, number> {
  const rows = ctx.db.all<{ provider: string; n: number }>("SELECT provider, COUNT(*) AS n FROM route_outcomes WHERE run_id = ? AND role = 'implementer' AND outcome IN ('failed', 'rejected') GROUP BY provider", ctx.run.id);
  return Object.fromEntries(rows.filter((r) => providerFamily(r.provider) === 'codex' || providerFamily(r.provider) === 'muse').map((r) => [r.provider, r.n]));
}

/**
 * The route attempt `n` really ran on: its own decision, or, when that named a partner skipped part way, the decision
 * that replaced it (purpose `implement:<n>~<partner>`, then `~<next partner>`), followed for as many as were skipped.
 */
export function attemptRouteDecision(ctx: Pick<RunContext, 'db' | 'run'>, attempt: number): ReturnType<typeof getDecision> {
  const skipped = skippedPartners(ctx);
  let id = implementRouteDecisionId(ctx.run.id, attempt);
  let d = getDecision(ctx.db, id);
  for (let hop = 0; d && hop < 8; hop++) {
    const provider = (d.data as { provider?: unknown } | null)?.provider;
    if (typeof provider !== 'string' || !(provider in skipped)) break;
    id = `${id}_${provider.replace(/[^A-Za-z0-9_-]/g, '_')}`;
    const next = getDecision(ctx.db, id);
    if (!next) break;
    d = next;
  }
  return d;
}

/**
 * The implementation attempt whose result `cand` is now: the newest attempt the implementing step recorded as producing
 * it. The candidate's own `attempt` is the first attempt that produced its tree, used only when no event names it.
 */
function attemptOf(ctx: RunContext, cand: CandidateRecord): number {
  const row = ctx.db.get<{ n: number | null }>(
    "SELECT CAST(json_extract(data_json, '$.attempt') AS INTEGER) AS n FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.candidate_id') = ? ORDER BY id DESC LIMIT 1",
    ctx.run.id,
    CANDIDATE_EVENT,
    cand.id,
  );
  return typeof row?.n === 'number' && row.n > 0 ? row.n : cand.attempt;
}

/**
 * Record the outcome of the attempt whose result `cand` is, once per attempt. Returns the row id, or null when nothing
 * was recorded (an environment result, or no route decision with a provider and model for the attempt). Never throws
 * on missing measurements: a cost or token count that is not fully known is stored as null, never as zero.
 */
export function settleRouteOutcome(ctx: RunContext, cand: CandidateRecord, settlement: RouteSettlement): number | null {
  if (settlement.environment) return null;
  const attempt = attemptOf(ctx, cand);
  const decision = attemptRouteDecision(ctx, attempt);
  const d = (decision?.data ?? null) as { provider?: unknown; model?: unknown; effort?: unknown; work_kind?: unknown } | null;
  if (!d || typeof d.provider !== 'string' || typeof d.model !== 'string' || !d.provider || !d.model) return null;
  const workKind = (WORK_KINDS as readonly string[]).includes(String(d.work_kind)) ? (d.work_kind as WorkKind) : 'routine-code';
  const spent = attemptSpend(ctx, attempt);
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
      attemptKey: `attempt:${attempt}`,
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
