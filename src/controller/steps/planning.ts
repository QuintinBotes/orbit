/**
 * PLANNING (spec sections 7 and 8): the planner's criterion-to-proof mapping
 * is recorded, difficulty is classified with every factor written down, the
 * budget counters are created from the frozen caps and the difficulty class,
 * spend from before the ledger existed is charged, and the first
 * implementation route is decided and recorded.
 */
import { join } from 'node:path';
import { readJsonIfExists } from '../../core/fsx.ts';
import { BASELINE_FILE, type BaselineReport } from '../../evidence/baseline.ts';
import { applyBaselineExceptionAnswers } from '../../inquisition/baseline-exception.ts';
import { listQuestions } from '../../inquisition/store.ts';
import { classifyDifficulty } from '../../scheduling/difficulty.ts';
import { BudgetLedger } from '../../scheduling/budget.ts';
import type { Coupling } from '../../scheduling/types.ts';
import type { RunContext } from '../context.ts';
import { routeFor, tokenEstimateFor } from '../workers.ts';
import { assertContract, decide, move, note, safePoint, type StepResult } from './common.ts';
import { storedPlan } from './contracting.ts';

const SECURITY_WORDS = /\b(secur\w*|auth\w*|permission\w*|privacy|secret\w*|credential\w*|token\w*|tenant\w*|injection|billing|payment\w*)\b/i;

export async function planningStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  // A person may have approved a baseline exception before the run had a contract (`orbit decide` during PREFLIGHT or
  // CONTRACTING); it is applied now, so planning, difficulty and every later step see the contract that carries it.
  const exceptions = applyBaselineExceptionAnswers({ db: ctx.db, clock: ctx.clock, runId: ctx.run.id, runDir: ctx.runDir }, { snapshot: ctx.snapshot });
  const contract = exceptions.contract ?? assertContract(ctx);
  const plan = storedPlan(ctx);
  const baseline = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));

  if (plan) {
    decide(ctx, {
      id: `dec-${ctx.run.id}-proof-map`,
      kind: 'planning.proof-map',
      summary: `criterion-to-proof mapping for ${contract.acceptance_criteria.length} criteria`,
      data: {
        criteria: contract.acceptance_criteria.map((c, i) => ({ id: c.id, proof: c.proof, check_ids: c.check_ids ?? [], changes: plan.criteria[i]?.changes ?? [] })),
        expected_changed_files: plan.expected_changed_files,
        risks: plan.risks,
      },
    });
  }

  // Spec section 5: the practices selected for this task and the reason for each omission are part of the durable record.
  if (contract.practices) {
    const omitted = contract.practices.filter((p) => !p.applicable);
    const selected = contract.practices.length - omitted.length;
    decide(ctx, {
      id: `dec-${ctx.run.id}-practices`,
      kind: 'planning.practices',
      summary: `engineering practices: ${selected} selected${omitted.length > 0 ? `, ${omitted.length} omitted with a reason (${omitted.map((p) => p.practice).join(', ')})` : ''}`,
      data: { practices: contract.practices },
    });
  }

  const expected = plan?.expected_changed_files.map((f) => f.path) ?? [];
  const areas = new Set(expected.map((p) => p.split('/').slice(0, 2).join('/')));
  const coupling: Coupling = areas.size >= 3 ? 'high' : areas.size === 2 ? 'medium' : 'low';
  const mandatory = contract.acceptance_criteria.filter((c) => c.mandatory);
  const assessment = classifyDifficulty({
    contract,
    baseline: { failingChecks: baseline?.failures.map((f) => f.checkId) ?? [] },
    openQuestions: listQuestions(ctx.db, ctx.run.id, { status: 'open' }).length,
    uiRequired: contract.acceptance_criteria.some((c) => c.ui === true),
    securitySensitive: SECURITY_WORDS.test([contract.objective, ...(plan?.risks.map((r) => r.risk) ?? [])].join(' ')),
    repoFamiliarity: 'medium',
    testAvailability: contract.required_check_ids.length === 0 ? 'none' : mandatory.every((c) => (c.check_ids ?? []).length > 0) ? 'good' : 'partial',
    coupling,
  });
  decide(ctx, { id: `dec-${ctx.run.id}-difficulty`, kind: 'planning.difficulty', summary: `difficulty ${assessment.class} (score ${assessment.score}/${assessment.max_score}): ${assessment.reasons.join('; ')}`.slice(0, 1000), data: assessment });

  // Idempotent: a restarted controller keeps the counters it finds, provided the caps still match the snapshot.
  ctx.ledger = new BudgetLedger(ctx.db, ctx.clock).init(ctx.run.id, ctx.snapshot, assessment);
  prechargeUsage(ctx);

  routeFor(ctx, 'implement:1', 'routine-code', { difficulty: assessment.class, attempt: 1, repeatedFingerprints: 0, coupled: coupling === 'high' });
  return move(ctx, 'IMPLEMENTING', `planned: difficulty ${assessment.class}`, { patch: { difficulty: assessment.class, difficultyJson: JSON.stringify(assessment) } });
}

/**
 * Charge spend recorded before the ledger existed (the contracting planner).
 * Marked by an event so it happens once; a crash between the charge and the
 * mark charges again, overstating spend rather than hiding it.
 */
function prechargeUsage(ctx: RunContext): void {
  const ledger = ctx.ledger;
  if (!ledger) return;
  if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'budget.precharged'", ctx.run.id)) return;
  const rows = ctx.db.all<{ worker_id: string | null; provider: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cache_read_tokens: number | null; cache_write_tokens: number | null; cost_usd: number | null; cost_source: string; role: string | null }>(
    'SELECT u.worker_id, u.provider, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_write_tokens, u.cost_usd, u.cost_source, w.role FROM usage u LEFT JOIN workers w ON w.id = u.worker_id WHERE u.run_id = ? ORDER BY u.id',
    ctx.run.id,
  );
  let total = 0;
  for (const r of rows) {
    // A session with tokens but no cost is charged what the tokens would cost, not the planner ceiling.
    const tokenEstimate = r.cost_usd === null ? tokenEstimateFor(ctx, r, { provider: r.provider, model: r.model, inputTokens: r.input_tokens, outputTokens: r.output_tokens, cacheReadTokens: r.cache_read_tokens, cacheWriteTokens: r.cache_write_tokens, costUsd: null, costSource: 'unavailable' }) : null;
    const charge = ledger.consumeCost({ costUsd: r.cost_usd, costSource: r.cost_source }, (r.role as 'planner' | null) ?? 'planner', { tokenEstimate });
    total += charge.charged;
  }
  note(ctx, 'budget.precharged', { usage_rows: rows.length, charged_usd: Math.round(total * 1e6) / 1e6 });
}
