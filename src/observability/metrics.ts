/**
 * Spec section 16 metrics, computed from the durable records of the runs
 * created inside a time window: verified pass rate, false-pass rate from
 * subsequent review, escalation quality, duplicate failures, time-to-green,
 * spend per accepted task, token and cache usage, concurrency overhead,
 * stale-evidence prevention and UI defects discovered.
 *
 * Rules that hold everywhere:
 *  - A rate with an empty denominator is null, never zero.
 *  - A measurement the records do not carry is listed in `missing`, never
 *    filled in: unreported cost and tokens, wait events the controller did
 *    not persist, and so on ("make missing usage measurements explicit").
 *  - Nothing here reads artifact contents, prompts or logs, so nothing
 *    sensitive can reach the output.
 */
import type { OrbitDb } from '../storage/db.ts';
import { inputIncludesCacheRead } from '../routing/pricing.ts';
import { roundUsd } from '../routing/pricing.ts';

export interface MetricsWindow {
  /** Inclusive lower bound on runs.created_at (epoch ms); null or absent for no lower bound. */
  from?: number | null;
  /** Exclusive upper bound on runs.created_at; null or absent for no upper bound. */
  to?: number | null;
}

/** Run states a run does not leave without a person (BLOCKED) or at all. */
const FINISHED_STATES = ['SUCCEEDED', 'EXHAUSTED', 'IMPOSSIBLE', 'BLOCKED'] as const;
const TERMINAL = ['SUCCEEDED', 'BLOCKED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED'] as const;
/** Failure sources that describe the candidate, not the base or a rerun that passed. */
const CANDIDATE_FAILURE_SOURCES = ['check', 'worker', 'ci'] as const;

export interface Rate {
  numerator: number;
  denominator: number;
  /** numerator / denominator, or null when the denominator is zero. */
  rate: number | null;
}

export interface Distribution {
  samples: number;
  mean: number | null;
  median: number | null;
  max: number | null;
}

export interface TokenTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  /** Cached prompt tokens over all prompt tokens; null when no prompt tokens were reported. */
  cache_hit_ratio: number | null;
}

export interface Metrics {
  window: { from: number | null; to: number | null };
  runs: { total: number; finished: number; accepted: number; by_state: Record<string, number> };
  /** Accepted runs over finished runs, and the share of evidence reports that were PASS. */
  verified_pass_rate: Rate & { evidence_reports: Rate };
  /** Candidates with PASS evidence that a review then refused, over PASS-evidence candidates that were reviewed. */
  false_pass_rate: Rate;
  /** Implementer attempts routed to a stronger model that cleared every failure fingerprint of the attempt before. */
  escalation_quality: Rate & { escalations: number; fixed: number; not_fixed: number; pending: number; unmeasured: number; other_escalations: number };
  /** Failure fingerprints seen again on a later candidate of the same run. */
  duplicate_failures: Rate & { distinct_fingerprints: number; duplicates: number };
  /** Milliseconds from a run's start to its first PASS evidence report. */
  time_to_green_ms: Distribution & { runs_without_green: number };
  spend_per_accepted_task: {
    accepted: number;
    spend_usd: number;
    per_accepted_usd: number | null;
    usage_records: number;
    unmeasured_records: number;
    cost_complete: boolean;
  };
  token_usage: TokenTotals & {
    records: number;
    records_without_tokens: number;
    by_model: ({ provider: string; model: string | null; records: number } & TokenTotals)[];
    output_budget_overruns: number;
  };
  concurrency_overhead: {
    /** Time workers waited between being planned and being started, from the workers table. */
    worker_queue_ms: number;
    workers_measured: number;
    worker_active_ms: number;
    /** Time runs spent in WAIT steps, from `step.wait` events; zero when none were persisted. */
    step_wait_ms: number;
    step_wait_events: number;
    /** (queue + step wait) over (queue + step wait + active worker time); null with no measurement. */
    overhead_ratio: number | null;
  };
  stale_evidence_prevented: { evidence_invalidated: number; reviews_invalidated: number; deliveries_refused: number; total: number };
  ui_defects: { discovered: number; runs_with_ui_defects: number };
  /** Measurements these records could not provide, in words. */
  missing: string[];
}

export function metricsFor(db: OrbitDb, window: MetricsWindow = {}): Metrics {
  const from = window.from ?? null;
  const to = window.to ?? null;
  const where = `created_at >= ${from === null ? '0' : '?'} AND created_at < ${to === null ? '9223372036854775807' : '?'}`;
  const params: number[] = [...(from === null ? [] : [from]), ...(to === null ? [] : [to])];
  /** Rows of `table` whose run_id is a run created inside the window. */
  const inWindow = `run_id IN (SELECT id FROM runs WHERE ${where})`;
  const missing: string[] = [];

  const runRows = db.all<{ id: string; state: string; created_at: number; started_at: number | null }>(`SELECT id, state, created_at, started_at FROM runs WHERE ${where} ORDER BY created_at`, ...params);
  const byState: Record<string, number> = {};
  for (const r of runRows) byState[r.state] = (byState[r.state] ?? 0) + 1;
  const finished = runRows.filter((r) => (FINISHED_STATES as readonly string[]).includes(r.state));
  const accepted = runRows.filter((r) => r.state === 'SUCCEEDED');
  if (runRows.length === 0) missing.push('no runs were created in this window');

  const evidence = db.get<{ total: number; pass: number }>(`SELECT COUNT(*) AS total, COALESCE(SUM(verdict = 'PASS'), 0) AS pass FROM evidence_reports WHERE ${inWindow}`, ...params)!;

  // False-pass: PASS evidence that independent review later refused.
  const passCandidates = db.get<{ reviewed: number; refused: number }>(
    `SELECT COUNT(*) AS reviewed, COALESCE(SUM(refused), 0) AS refused FROM (
       SELECT e.candidate_id AS candidate_id,
              EXISTS (SELECT 1 FROM reviews r WHERE r.candidate_id = e.candidate_id AND r.verdict IN ('REPAIR_REQUIRED', 'BLOCK')) AS refused
         FROM evidence_reports e
        WHERE e.verdict = 'PASS' AND e.${inWindow}
          AND EXISTS (SELECT 1 FROM reviews r WHERE r.candidate_id = e.candidate_id)
        GROUP BY e.candidate_id
     )`,
    ...params,
  )!;

  const escalation = escalationQuality(db, inWindow, params);
  const duplicates = duplicateFailures(db, inWindow, params);
  const green = timeToGreen(db, runRows);
  const spend = spendPerAccepted(db, where, params, accepted.length, missing);
  const tokens = tokenUsage(db, inWindow, params, missing);
  const overhead = concurrencyOverhead(db, inWindow, params, missing);

  const evidenceInvalidated = count(db, `SELECT COUNT(*) AS n FROM events WHERE type = 'evidence.invalidated' AND ${inWindow}`, params);
  const reviewsInvalidated = count(db, `SELECT COUNT(*) AS n FROM events WHERE type = 'review.invalidated' AND ${inWindow}`, params);
  const deliveriesRefused = count(
    db,
    `SELECT COUNT(*) AS n FROM events WHERE type = 'action.failed' AND ${inWindow}
        AND (json_extract(data_json, '$.error') LIKE '%delivery refused%' OR json_extract(data_json, '$.error') LIKE '%release refused%' OR json_extract(data_json, '$.error') LIKE '%stale%')`,
    params,
  );

  const ui = db.get<{ discovered: number; runs: number }>(
    `SELECT COUNT(*) AS discovered, COUNT(DISTINCT run_id) AS runs FROM (
       SELECT DISTINCT run_id, check_id, COALESCE(fingerprint, id) AS defect
         FROM check_runs
        WHERE kind = 'playwright' AND status = 'FAILED' AND candidate_id IS NOT NULL AND ${inWindow}
     )`,
    ...params,
  )!;

  return {
    window: { from, to },
    runs: { total: runRows.length, finished: finished.length, accepted: accepted.length, by_state: byState },
    verified_pass_rate: { ...rate(accepted.length, finished.length), evidence_reports: rate(evidence.pass, evidence.total) },
    false_pass_rate: rate(passCandidates.refused, passCandidates.reviewed),
    escalation_quality: escalation,
    duplicate_failures: duplicates,
    time_to_green_ms: green,
    spend_per_accepted_task: spend,
    token_usage: tokens,
    concurrency_overhead: overhead,
    stale_evidence_prevented: { evidence_invalidated: evidenceInvalidated, reviews_invalidated: reviewsInvalidated, deliveries_refused: deliveriesRefused, total: evidenceInvalidated + reviewsInvalidated + deliveriesRefused },
    ui_defects: { discovered: ui.discovered, runs_with_ui_defects: ui.runs },
    missing,
  };
}

function rate(numerator: number, denominator: number): Rate {
  return { numerator, denominator, rate: denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 10_000 : null };
}

function count(db: OrbitDb, sql: string, params: number[]): number {
  return Number(db.get<{ n: number }>(sql, ...params)?.n ?? 0);
}

function distribution(values: number[]): Distribution {
  if (values.length === 0) return { samples: 0, mean: null, median: null, max: null };
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
  return { samples: values.length, mean: Math.round(values.reduce((a, b) => a + b, 0) / values.length), median: Math.round(median), max: sorted[sorted.length - 1] as number };
}

function timeToGreen(db: OrbitDb, runs: { id: string; created_at: number; started_at: number | null }[]): Metrics['time_to_green_ms'] {
  const samples: number[] = [];
  let without = 0;
  for (const r of runs) {
    const first = db.get<{ at: number | null }>("SELECT MIN(created_at) AS at FROM evidence_reports WHERE run_id = ? AND verdict = 'PASS'", r.id)?.at ?? null;
    if (first === null) {
      without += 1;
      continue;
    }
    samples.push(Math.max(0, first - (r.started_at ?? r.created_at)));
  }
  return { ...distribution(samples), runs_without_green: without };
}

/**
 * An escalation is an implementer attempt whose route decision records
 * `escalated_from`. It fixed the fingerprint when its candidate carries none
 * of the failure fingerprints the attempt before it ended with.
 */
function escalationQuality(db: OrbitDb, inWindow: string, params: number[]): Metrics['escalation_quality'] {
  const decisions = db.all<{ id: string; run_id: string }>(`SELECT id, run_id FROM decisions WHERE kind = 'route' AND json_extract(data_json, '$.escalated_from') IS NOT NULL AND ${inWindow}`, ...params);
  let fixed = 0;
  let notFixed = 0;
  let pending = 0;
  let unmeasured = 0;
  let other = 0;
  for (const d of decisions) {
    const attemptRow = db.get<{ attempt: number | null }>(
      "SELECT CAST(json_extract(data_json, '$.attempt') AS INTEGER) AS attempt FROM events WHERE run_id = ? AND type = 'implementation.attempt' AND json_extract(data_json, '$.route') = ? ORDER BY id LIMIT 1",
      d.run_id,
      d.id,
    );
    const attempt = attemptRow?.attempt ?? null;
    if (attempt === null) {
      other += 1;
      continue;
    }
    const run = db.get<{ state: string }>('SELECT state FROM runs WHERE id = ?', d.run_id);
    const settled = run !== undefined && (TERMINAL as readonly string[]).includes(run.state);
    const before = db.get<{ id: string }>('SELECT id FROM candidates WHERE run_id = ? AND attempt < ? ORDER BY attempt DESC, seq DESC LIMIT 1', d.run_id, attempt);
    const prior = before ? fingerprintsOf(db, before.id) : new Set<string>();
    if (prior.size === 0) {
      unmeasured += 1;
      continue;
    }
    const after = db.get<{ id: string }>('SELECT id FROM candidates WHERE run_id = ? AND attempt = ? ORDER BY seq DESC LIMIT 1', d.run_id, attempt);
    const judged = after !== undefined && db.get('SELECT 1 AS x FROM evidence_reports WHERE candidate_id = ? LIMIT 1', after.id) !== undefined;
    if (!after || !judged) {
      if (settled) notFixed += 1;
      else pending += 1;
      continue;
    }
    const now = fingerprintsOf(db, after.id);
    if ([...prior].some((fp) => now.has(fp))) notFixed += 1;
    else fixed += 1;
  }
  return { ...rate(fixed, fixed + notFixed), escalations: decisions.length - other, fixed, not_fixed: notFixed, pending, unmeasured, other_escalations: other };
}

function fingerprintsOf(db: OrbitDb, candidateId: string): Set<string> {
  const marks = CANDIDATE_FAILURE_SOURCES.map(() => '?').join(', ');
  return new Set(db.all<{ fingerprint: string }>(`SELECT DISTINCT fingerprint FROM failures WHERE candidate_id = ? AND source IN (${marks})`, candidateId, ...CANDIDATE_FAILURE_SOURCES).map((r) => r.fingerprint));
}

function duplicateFailures(db: OrbitDb, inWindow: string, params: number[]): Metrics['duplicate_failures'] {
  const marks = CANDIDATE_FAILURE_SOURCES.map(() => '?').join(', ');
  const rows = db.all<{ run_id: string; fingerprint: string; candidates: number }>(
    `SELECT run_id, fingerprint, COUNT(DISTINCT candidate_id) AS candidates FROM failures
      WHERE candidate_id IS NOT NULL AND source IN (${marks}) AND ${inWindow}
      GROUP BY run_id, fingerprint`,
    ...CANDIDATE_FAILURE_SOURCES,
    ...params,
  );
  const total = rows.reduce((a, r) => a + r.candidates, 0);
  const dups = rows.reduce((a, r) => a + (r.candidates - 1), 0);
  return { ...rate(dups, total), distinct_fingerprints: rows.length, duplicates: dups };
}

function spendPerAccepted(db: OrbitDb, where: string, params: number[], accepted: number, missing: string[]): Metrics['spend_per_accepted_task'] {
  // Spend of every settled run counts against the tasks that were accepted: failed attempts are part of the price.
  const marks = TERMINAL.map(() => '?').join(', ');
  const rows = db.all<{ cost_usd: number | null; cost_source: string }>(
    `SELECT cost_usd, cost_source FROM usage WHERE run_id IN (SELECT id FROM runs WHERE ${where} AND state IN (${marks}))`,
    ...params,
    ...TERMINAL,
  );
  let spend = 0;
  let unmeasured = 0;
  for (const r of rows) {
    if (r.cost_usd === null || r.cost_source === 'unavailable') unmeasured += 1;
    else spend += r.cost_usd;
  }
  if (unmeasured > 0) missing.push(`cost is unavailable for ${unmeasured} of ${rows.length} usage record(s); spend covers measured records only`);
  const spendUsd = roundUsd(spend);
  return {
    accepted,
    spend_usd: spendUsd,
    per_accepted_usd: accepted > 0 ? roundUsd(spendUsd / accepted) : null,
    usage_records: rows.length,
    unmeasured_records: unmeasured,
    cost_complete: unmeasured === 0,
  };
}

interface UsageRow {
  provider: string;
  model: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

function tokenUsage(db: OrbitDb, inWindow: string, params: number[], missing: string[]): Metrics['token_usage'] {
  const rows = db.all<UsageRow>(`SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens FROM usage WHERE ${inWindow}`, ...params);
  const total: Acc = newAcc();
  const groups = new Map<string, { provider: string; model: string | null; records: number; acc: Acc }>();
  let without = 0;
  for (const r of rows) {
    const key = `${r.provider}\u0000${r.model ?? ''}`;
    let g = groups.get(key);
    if (!g) {
      g = { provider: r.provider, model: r.model, records: 0, acc: newAcc() };
      groups.set(key, g);
    }
    g.records += 1;
    if (r.input_tokens === null && r.output_tokens === null) without += 1;
    for (const a of [total, g.acc]) {
      a.input += r.input_tokens ?? 0;
      a.output += r.output_tokens ?? 0;
      a.cache_read += r.cache_read_tokens ?? 0;
      a.cache_write += r.cache_write_tokens ?? 0;
      if (r.input_tokens !== null) {
        a.prompt += promptOf(r);
        a.cached += r.cache_read_tokens ?? 0;
      }
    }
  }
  if (without > 0) missing.push(`${without} of ${rows.length} usage record(s) carry no token counts`);
  return {
    ...tokens(total),
    records: rows.length,
    records_without_tokens: without,
    by_model: [...groups.values()].map((g) => ({ provider: g.provider, model: g.model, records: g.records, ...tokens(g.acc) })),
    output_budget_overruns: count(db, `SELECT COUNT(*) AS n FROM events WHERE type = 'usage.output-budget-exceeded' AND ${inWindow}`, params),
  };
}

interface Acc {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  prompt: number;
  cached: number;
}

function newAcc(): Acc {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, prompt: 0, cached: 0 };
}

function tokens(a: Acc): TokenTotals {
  return { input: a.input, output: a.output, cache_read: a.cache_read, cache_write: a.cache_write, cache_hit_ratio: ratioOf(a.cached, a.prompt) };
}

/** All prompt tokens of a record, normalising providers whose input count already includes cached tokens. */
function promptOf(r: UsageRow): number {
  const input = r.input_tokens ?? 0;
  const write = r.cache_write_tokens ?? 0;
  return inputIncludesCacheRead(r.provider) ? input + write : input + (r.cache_read_tokens ?? 0) + write;
}

function ratioOf(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 10_000) / 10_000 : null;
}

function concurrencyOverhead(db: OrbitDb, inWindow: string, params: number[], missing: string[]): Metrics['concurrency_overhead'] {
  const w = db.get<{ queue: number | null; n: number; active: number | null }>(
    `SELECT SUM(MAX(0, spawned_at - created_at)) AS queue, COUNT(*) AS n,
            SUM(CASE WHEN ended_at IS NOT NULL THEN MAX(0, ended_at - spawned_at) ELSE 0 END) AS active
       FROM workers WHERE spawned_at IS NOT NULL AND ${inWindow}`,
    ...params,
  )!;
  const waits = db.all<{ data_json: string | null }>(`SELECT data_json FROM events WHERE type = 'step.wait' AND ${inWindow}`, ...params);
  let stepWait = 0;
  for (const e of waits) {
    try {
      const ms = (JSON.parse(e.data_json ?? 'null') as { wait_ms?: unknown } | null)?.wait_ms;
      if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) stepWait += ms;
    } catch {
      /* an unreadable event adds nothing */
    }
  }
  if (waits.length === 0) missing.push('no step.wait events are recorded: concurrency overhead counts worker queue time (planned to started) only');
  const queue = Number(w.queue ?? 0);
  const active = Number(w.active ?? 0);
  const waited = queue + stepWait;
  return {
    worker_queue_ms: queue,
    workers_measured: w.n,
    worker_active_ms: active,
    step_wait_ms: stepWait,
    step_wait_events: waits.length,
    overhead_ratio: w.n === 0 && waits.length === 0 ? null : ratioOf(waited, waited + active),
  };
}
