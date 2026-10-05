/**
 * `orbit stats`: the spec section 16 metrics for the runs in this repository,
 * optionally limited to a time window (--since, --until, by run creation
 * time). Read-only; --json prints exactly what metricsFor computed.
 */
import { metricsFor, type Metrics } from '../../observability/metrics.ts';
import type { Args, OptionSpec } from '../args.ts';
import { resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, table } from '../io.ts';

export const STATS_USAGE = 'orbit stats [--since <when>] [--until <when>] [--json]';

export const STATS_OPTIONS: OptionSpec = {
  since: { type: 'string', valueName: 'when', description: 'only runs created at or after this time: an ISO date or time, or a span back from now such as 90m, 24h, 7d, 2w' },
  until: { type: 'string', valueName: 'when', description: 'only runs created before this time (same forms as --since)' },
};

const SPAN_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

/** A point in time from a span back from `now` (90m, 24h, 7d, 2w) or an ISO date or time. */
export function parseWhen(text: string, now: number, flag: string): number {
  const span = /^(\d+)([mhdw])$/.exec(text.trim());
  if (span) return now - Number(span[1]) * (SPAN_MS[span[2]!] as number);
  if (/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(text.trim())) {
    const at = Date.parse(text.trim());
    if (Number.isFinite(at)) return at;
  }
  throw new UsageError(`--${flag} must be an ISO date or time or a span such as 90m, 24h, 7d or 2w, got ${JSON.stringify(text)}`, STATS_USAGE);
}

export async function statsCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const now = ctx.clock.now();
  const sinceText = args.str('since');
  const untilText = args.str('until');
  const from = sinceText === undefined ? null : parseWhen(sinceText, now, 'since');
  const to = untilText === undefined ? null : parseWhen(untilText, now, 'until');
  if (from !== null && to !== null && from >= to) throw new UsageError('--since must be earlier than --until', STATS_USAGE);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const m = await withState(repo, (db) => metricsFor(db, { from, to }));
  if (args.bool('json')) {
    json(ctx.io, m);
    return EXIT.OK;
  }
  ctx.io.out(renderStats(m));
  return EXIT.OK;
}

const pct = (r: number | null): string => (r === null ? '-' : `${(r * 100).toFixed(1)}%`);
const usd = (n: number | null): string => (n === null ? '-' : `$${n.toFixed(4)}`);
const dur = (ms: number | null): string => {
  if (ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  const m = s / 60;
  return m < 90 ? `${m.toFixed(1)}m` : `${(m / 60).toFixed(1)}h`;
};
const n = (v: number): string => v.toLocaleString('en-US');

export function renderStats(m: Metrics): string {
  const rows: string[][] = [
    ['verified pass rate', pct(m.verified_pass_rate.rate), `${m.verified_pass_rate.numerator} accepted of ${m.verified_pass_rate.denominator} finished runs; evidence PASS ${m.verified_pass_rate.evidence_reports.numerator} of ${m.verified_pass_rate.evidence_reports.denominator}`],
    ['false-pass rate', pct(m.false_pass_rate.rate), `${m.false_pass_rate.numerator} of ${m.false_pass_rate.denominator} reviewed PASS candidates refused by review`],
    ['escalation quality', pct(m.escalation_quality.rate), `${m.escalation_quality.fixed} fixed, ${m.escalation_quality.not_fixed} not fixed, ${m.escalation_quality.pending} pending, ${m.escalation_quality.unmeasured} unmeasured (${m.escalation_quality.escalations} escalated attempts)`],
    ['duplicate failures', pct(m.duplicate_failures.rate), `${m.duplicate_failures.duplicates} repeats across ${m.duplicate_failures.distinct_fingerprints} fingerprints`],
    ['time to green', dur(m.time_to_green_ms.median), `median of ${m.time_to_green_ms.samples} run(s), mean ${dur(m.time_to_green_ms.mean)}, max ${dur(m.time_to_green_ms.max)}; ${m.time_to_green_ms.runs_without_green} run(s) never green`],
    ['spend per accepted task', usd(m.spend_per_accepted_task.per_accepted_usd), `${usd(m.spend_per_accepted_task.spend_usd)} over ${m.spend_per_accepted_task.accepted} accepted${m.spend_per_accepted_task.cost_complete ? '' : ` (partial: ${m.spend_per_accepted_task.unmeasured_records} record(s) unmeasured)`}`],
    ['tokens', `${n(m.token_usage.input)} in / ${n(m.token_usage.output)} out`, `cache read ${n(m.token_usage.cache_read)}, write ${n(m.token_usage.cache_write)}, hit ratio ${pct(m.token_usage.cache_hit_ratio)}; ${m.token_usage.output_budget_overruns} output budget overrun(s)`],
    ['concurrency overhead', pct(m.concurrency_overhead.overhead_ratio), `queue ${dur(m.concurrency_overhead.worker_queue_ms)} over ${m.concurrency_overhead.workers_measured} worker(s), step waits ${dur(m.concurrency_overhead.step_wait_ms)} (${m.concurrency_overhead.step_wait_events} events), active ${dur(m.concurrency_overhead.worker_active_ms)}`],
    ['stale evidence prevented', String(m.stale_evidence_prevented.total), `${m.stale_evidence_prevented.evidence_invalidated} evidence and ${m.stale_evidence_prevented.reviews_invalidated} reviews invalidated, ${m.stale_evidence_prevented.deliveries_refused} deliveries refused`],
    ['UI defects found', String(m.ui_defects.discovered), `in ${m.ui_defects.runs_with_ui_defects} run(s)`],
  ];
  const span = `${m.window.from === null ? 'the beginning' : new Date(m.window.from).toISOString()} to ${m.window.to === null ? 'now' : new Date(m.window.to).toISOString()}`;
  const out = [`Orbit stats for ${m.runs.total} run(s) created from ${span} (${m.runs.finished} finished, ${m.runs.accepted} accepted)`, '', table(rows, ['METRIC', 'VALUE', 'DETAIL']).trimEnd()];
  if (m.token_usage.by_model.length > 0) {
    out.push('', table(m.token_usage.by_model.map((b) => [b.model ?? '(unknown model)', b.provider, String(b.records), n(b.input), n(b.output), pct(b.cache_hit_ratio)]), ['MODEL', 'PROVIDER', 'RECORDS', 'INPUT', 'OUTPUT', 'CACHE HIT']).trimEnd());
  }
  if (m.missing.length > 0) out.push('', 'Not measured:', ...m.missing.map((x) => `  - ${x}`));
  out.push('', 'A dash means no data in the window, not zero.');
  return `${out.join('\n')}\n`;
}
