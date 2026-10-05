import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import type { UsageReport } from '../adapters/types.ts';
import { appendEvent } from '../storage/events.ts';
import { ModelRegistry } from './registry.ts';
import { estimateCost, inputIncludesCacheRead, roundUsd } from './pricing.ts';
import { ROUTE_OUTCOMES, WORK_KINDS, type ModelPricing, type RouteOutcome, type RouteStat, type WorkKind } from './types.ts';

export { estimateCost } from './pricing.ts';

/**
 * Token and cost accounting (spec sections 8 and 16). Every worker session
 * gets one usage row. Cost is 'reported' when the provider gave it,
 * 'estimated' from tokens and registry pricing otherwise, and 'unavailable'
 * when neither is possible: missing measurements stay visible and are never
 * recorded as zero.
 */

export interface RecordUsageInput {
  runId: string;
  workerId: string | null;
  /** Defaults to usage.provider. */
  provider?: string;
  /** Defaults to usage.model. */
  model?: string | null;
  /** null when the provider reported nothing (codex turn.failed, cancellation). */
  usage: UsageReport | null;
  durationMs: number | null;
  /** Pricing to estimate with; looked up in the registry when omitted, null to forbid estimation. */
  pricing?: ModelPricing | null;
  /**
   * Time from spawn to the first line of provider output, from the worker
   * log. Defaults to usage.timeToFirstEventMs. Fed into the model's rolling
   * median latency (model_registry.latency_ms).
   */
  timeToFirstEventMs?: number | null;
  /**
   * Output token budget the worker ran under (routing.output_budgets). When
   * the reported output exceeds it, the overrun is recorded as a
   * usage.output-budget-exceeded event and listed in `notes`.
   */
  outputBudgetTokens?: number | null;
  /** The worker's role, recorded with an overrun. */
  role?: string | null;
}

export interface RecordedUsage {
  id: number;
  provider: string;
  model: string | null;
  costUsd: number | null;
  costSource: 'reported' | 'estimated' | 'unavailable';
  /** Why an estimate is partial or impossible. */
  notes: string[];
  /** The reported output exceeded the role's output budget. */
  outputBudgetExceeded: boolean;
}

export function recordUsage(db: OrbitDb, input: RecordUsageInput, clock: Clock): RecordedUsage {
  const provider = input.provider ?? input.usage?.provider;
  if (!provider) throw new OrbitError('SCHEMA_INVALID', 'recordUsage needs a provider');
  const model = input.model !== undefined ? input.model : (input.usage?.model ?? null);
  const u = input.usage;
  const tokens = {
    inputTokens: count(u?.inputTokens),
    outputTokens: count(u?.outputTokens),
    cacheReadTokens: count(u?.cacheReadTokens),
    cacheWriteTokens: count(u?.cacheWriteTokens),
  };
  const notes: string[] = [];
  let costUsd: number | null = null;
  let costSource: RecordedUsage['costSource'] = 'unavailable';
  const given = count(u?.costUsd);
  if (given !== null && (u?.costSource === 'reported' || u?.costSource === 'estimated')) {
    costUsd = given;
    costSource = u.costSource;
  } else {
    if (u && u.costSource !== 'unavailable' && given === null) notes.push(`usage claimed cost source '${u.costSource}' without a cost`);
    const pricing = input.pricing !== undefined ? input.pricing : model ? (new ModelRegistry(db, clock).get(model)?.pricing ?? null) : null;
    if (!u) {
      notes.push('provider reported no usage');
    } else {
      const est = estimateCost(tokens, pricing, { inputIncludesCacheRead: inputIncludesCacheRead(provider) });
      if (est.costUsd !== null) {
        costUsd = est.costUsd;
        costSource = 'estimated';
        if (est.missing.length) notes.push(`estimate counts unknown ${est.missing.join(', ')} as zero`);
        notes.push(...est.assumptions);
      } else {
        notes.push(`cost unavailable: no ${est.missing.join(', ')}`);
      }
    }
  }
  const durationMs = count(input.durationMs);
  const ts = clock.now();
  const id = db.tx(
    () =>
      db.run(
        `INSERT INTO usage (run_id, worker_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source, duration_ms, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        input.runId,
        input.workerId,
        provider,
        model,
        tokens.inputTokens,
        tokens.outputTokens,
        tokens.cacheReadTokens,
        tokens.cacheWriteTokens,
        costUsd,
        costSource,
        durationMs,
        ts,
      ).lastInsertRowid,
  );

  const budget = count(input.outputBudgetTokens !== undefined ? input.outputBudgetTokens : u?.outputBudgetTokens);
  const role = input.role ?? (input.workerId ? (db.get<{ role: string }>('SELECT role FROM workers WHERE id = ?', input.workerId)?.role ?? null) : null);
  const outputTokens = tokens.outputTokens;
  let overrun = false;
  if (budget !== null && budget > 0 && outputTokens !== null && outputTokens > budget) {
    overrun = true;
    notes.push(`output ${outputTokens} tokens exceeded the ${budget} token budget${role ? ` for ${role}` : ''}`);
    appendEvent(db, input.runId, 'usage.output-budget-exceeded', 'usage', { worker_id: input.workerId, role, provider, model, output_tokens: outputTokens, budget_tokens: budget, over_by: outputTokens - budget }, ts);
  }

  const latency = input.timeToFirstEventMs !== undefined ? input.timeToFirstEventMs : (u?.timeToFirstEventMs ?? null);
  if (model && latency !== null && latency !== undefined) new ModelRegistry(db, clock).recordLatency(model, latency);
  return { id, provider, model, costUsd, costSource, notes, outputBudgetExceeded: overrun };
}

export interface UsageTotals {
  records: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Sum of known costs only; see unavailableCost for what it leaves out. */
  costUsd: number;
  reportedCostUsd: number;
  estimatedCostUsd: number;
  bySource: { reported: number; estimated: number; unavailable: number };
  durationMs: number;
  /** Cached prompt tokens over all prompt tokens; null when no prompt tokens were reported. */
  cacheHitRatio: number | null;
}

export interface UsageSummary {
  runId: string;
  totals: UsageTotals;
  byProviderModel: ({ provider: string; model: string | null } & UsageTotals)[];
  /** Every usage record whose cost is unknown, listed rather than silently omitted. */
  unavailableCost: { id: number; workerId: string | null; provider: string; model: string | null; ts: number }[];
  costComplete: boolean;
  note: string;
}

interface UsageRow {
  id: number;
  worker_id: string | null;
  provider: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  cost_usd: number | null;
  cost_source: string;
  duration_ms: number | null;
  ts: number;
}

export function summarizeUsage(db: OrbitDb, runId: string): UsageSummary {
  const rows = db.all<UsageRow>('SELECT * FROM usage WHERE run_id = ? ORDER BY id', runId);
  const totals = emptyTotals();
  const groups = new Map<string, { provider: string; model: string | null } & UsageTotals & { promptTokens: number; cachedTokens: number }>();
  let promptTokens = 0;
  let cachedTokens = 0;
  const unavailableCost: UsageSummary['unavailableCost'] = [];
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.model ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { provider: r.provider, model: r.model, ...emptyTotals(), promptTokens: 0, cachedTokens: 0 };
      groups.set(key, g);
    }
    const prompt = promptOf(r);
    for (const t of [totals, g]) addRow(t, r);
    if (prompt !== null) {
      promptTokens += prompt;
      cachedTokens += r.cache_read_tokens ?? 0;
      g.promptTokens += prompt;
      g.cachedTokens += r.cache_read_tokens ?? 0;
    }
    if (r.cost_usd === null || r.cost_source === 'unavailable') {
      unavailableCost.push({ id: r.id, workerId: r.worker_id, provider: r.provider, model: r.model, ts: r.ts });
    }
  }
  totals.cacheHitRatio = ratio(cachedTokens, promptTokens);
  const byProviderModel = [...groups.values()].map(({ promptTokens: p, cachedTokens: c, ...rest }) => ({ ...rest, cacheHitRatio: ratio(c, p) }));
  const costComplete = unavailableCost.length === 0;
  const note =
    rows.length === 0
      ? 'no usage recorded'
      : costComplete
        ? totals.bySource.estimated > 0
          ? `cost includes ${totals.bySource.estimated} estimated record(s) priced from tokens and registry pricing`
          : 'cost reported by providers for every record'
        : `cost unavailable for ${unavailableCost.length} of ${rows.length} record(s); the total covers measured records only`;
  return { runId, totals, byProviderModel, unavailableCost, costComplete, note };
}

function emptyTotals(): UsageTotals {
  return {
    records: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
    reportedCostUsd: 0,
    estimatedCostUsd: 0,
    bySource: { reported: 0, estimated: 0, unavailable: 0 },
    durationMs: 0,
    cacheHitRatio: null,
  };
}

function addRow(t: UsageTotals, r: UsageRow): void {
  t.records += 1;
  t.inputTokens += r.input_tokens ?? 0;
  t.outputTokens += r.output_tokens ?? 0;
  t.cacheReadTokens += r.cache_read_tokens ?? 0;
  t.cacheWriteTokens += r.cache_write_tokens ?? 0;
  t.durationMs += r.duration_ms ?? 0;
  const source = r.cost_usd === null ? 'unavailable' : r.cost_source;
  if (source === 'reported' || source === 'estimated') {
    t.bySource[source] += 1;
    t.costUsd = roundUsd(t.costUsd + (r.cost_usd as number));
    if (source === 'reported') t.reportedCostUsd = roundUsd(t.reportedCostUsd + (r.cost_usd as number));
    else t.estimatedCostUsd = roundUsd(t.estimatedCostUsd + (r.cost_usd as number));
  } else {
    t.bySource.unavailable += 1;
  }
}

/** All prompt tokens of a record, normalising providers whose input count already includes cached tokens. */
function promptOf(r: UsageRow): number | null {
  if (r.input_tokens === null) return null;
  const cacheWrite = r.cache_write_tokens ?? 0;
  if (inputIncludesCacheRead(r.provider)) return r.input_tokens + cacheWrite;
  return r.input_tokens + (r.cache_read_tokens ?? 0) + cacheWrite;
}

function ratio(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;
}

function count(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

// ---------------------------------------------------------------------------
// Route outcomes, the calibration input to expected-cost routing.

export interface RouteOutcomeInput {
  runId: string;
  workKind: WorkKind;
  provider: string;
  modelId: string;
  outcome: RouteOutcome;
  costUsd?: number | null;
  tokens?: number | null;
}

export function recordRouteOutcome(db: OrbitDb, input: RouteOutcomeInput, clock: Clock): number {
  if (!(WORK_KINDS as readonly string[]).includes(input.workKind)) throw new OrbitError('SCHEMA_INVALID', `unknown work kind ${input.workKind}`);
  if (!(ROUTE_OUTCOMES as readonly string[]).includes(input.outcome)) throw new OrbitError('SCHEMA_INVALID', `unknown route outcome ${input.outcome}`);
  if (!input.provider || !input.modelId) throw new OrbitError('SCHEMA_INVALID', 'route outcome needs a provider and a model');
  const ts = clock.now();
  return db.tx(
    () =>
      db.run(
        'INSERT INTO route_outcomes (run_id, work_kind, provider, model_id, outcome, cost_usd, tokens, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        input.runId,
        input.workKind,
        input.provider,
        input.modelId,
        input.outcome,
        count(input.costUsd),
        count(input.tokens),
        ts,
      ).lastInsertRowid,
  );
}

export function routeStats(db: OrbitDb, filter: { workKind?: WorkKind; provider?: string; modelId?: string; sinceMs?: number } = {}): RouteStat[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (filter.workKind) {
    where.push('work_kind = ?');
    params.push(filter.workKind);
  }
  if (filter.provider) {
    where.push('provider = ?');
    params.push(filter.provider);
  }
  if (filter.modelId) {
    where.push('model_id = ?');
    params.push(filter.modelId);
  }
  if (filter.sinceMs !== undefined) {
    where.push('ts >= ?');
    params.push(filter.sinceMs);
  }
  const rows = db.all<{
    work_kind: string;
    provider: string;
    model_id: string;
    samples: number;
    verified: number;
    failed: number;
    rejected: number;
    errors: number;
    mean_cost: number | null;
    cost_samples: number;
    mean_tokens: number | null;
  }>(
    `SELECT work_kind, provider, model_id, COUNT(*) AS samples,
            SUM(CASE WHEN outcome = 'verified' THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN outcome = 'rejected' THEN 1 ELSE 0 END) AS rejected,
            SUM(CASE WHEN outcome IN ('error', 'cancelled') THEN 1 ELSE 0 END) AS errors,
            AVG(cost_usd) AS mean_cost, COUNT(cost_usd) AS cost_samples, AVG(tokens) AS mean_tokens
       FROM route_outcomes ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY work_kind, provider, model_id
      ORDER BY work_kind, provider, model_id`,
    ...params,
  );
  return rows.map((r) => {
    const judged = r.verified + r.failed + r.rejected;
    return {
      workKind: r.work_kind,
      provider: r.provider,
      modelId: r.model_id,
      samples: r.samples,
      verified: r.verified,
      failed: r.failed,
      rejected: r.rejected,
      errors: r.errors,
      successRate: judged > 0 ? r.verified / judged : null,
      meanCostUsd: r.mean_cost === null ? null : roundUsd(r.mean_cost),
      costSamples: r.cost_samples,
      meanTokens: r.mean_tokens === null ? null : Math.round(r.mean_tokens),
    };
  });
}
