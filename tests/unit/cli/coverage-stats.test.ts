/** `orbit stats`: time windows and the metrics table, including every "no data" and "partial" wording. */
import { afterEach, describe, expect, it } from 'vitest';
import { parseWhen, renderStats, STATS_USAGE } from '../../../src/cli/commands/stats.ts';
import { UsageError } from '../../../src/cli/exit.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import type { Metrics } from '../../../src/observability/metrics.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = () => {
  const l = makeLab();
  labs.push(l);
  return l;
};
afterEach(() => labs.splice(0).forEach((l) => l.close()));

const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);

describe('parseWhen', () => {
  it('reads a span back from now in minutes, hours, days or weeks, and zero as now', () => {
    expect(parseWhen('90m', NOW, 'since')).toBe(NOW - 90 * 60_000);
    expect(parseWhen('24h', NOW, 'since')).toBe(NOW - 24 * 3_600_000);
    expect(parseWhen('7d', NOW, 'since')).toBe(NOW - 7 * 86_400_000);
    expect(parseWhen('2w', NOW, 'since')).toBe(NOW - 14 * 86_400_000);
    expect(parseWhen('0d', NOW, 'since')).toBe(NOW);
    expect(parseWhen('  3h  ', NOW, 'since')).toBe(NOW - 3 * 3_600_000);
  });

  it('reads an ISO date or time, with or without zone', () => {
    expect(parseWhen('2026-03-01', NOW, 'since')).toBe(Date.UTC(2026, 2, 1));
    expect(parseWhen('2026-03-01T10:20:30Z', NOW, 'since')).toBe(Date.UTC(2026, 2, 1, 10, 20, 30));
    expect(parseWhen('2026-03-01T10:20:30.250+02:00', NOW, 'since')).toBe(Date.UTC(2026, 2, 1, 8, 20, 30, 250));
    expect(parseWhen('2026-03-01 10:20:30Z', NOW, 'since')).toBe(Date.UTC(2026, 2, 1, 10, 20, 30));
    expect(parseWhen('2026-03-01T10:20', NOW, 'since')).toBe(new Date('2026-03-01T10:20').getTime());
  });

  it.each(['soon', '7', 'd', '1y', '-3d', '2026-13-45', '2026-03-01T', '2026/03/01', '', '3 d'])('rejects %j naming the flag and the accepted forms', (text) => {
    try {
      parseWhen(text, NOW, 'until');
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(UsageError);
      expect((e as UsageError).message).toBe(`--until must be an ISO date or time or a span such as 90m, 24h, 7d or 2w, got ${JSON.stringify(text)}`);
      expect((e as UsageError).usage).toBe(STATS_USAGE);
    }
  });
});

describe('orbit stats', () => {
  it('limits the runs to a window and says which window in words', async () => {
    const l = lab();
    const old = l.newRun('old');
    const recent = l.newRun('recent');
    const clock = new ManualClock(Date.UTC(2026, 9, 5, 12, 0, 0));
    l.db().run('UPDATE runs SET created_at = ? WHERE id = ?', clock.now() - 10 * 86_400_000, old.id);
    l.db().run('UPDATE runs SET created_at = ? WHERE id = ?', clock.now() - 1 * 86_400_000, recent.id);
    const r = await l.cli(['stats', '--since', '5d', '--until', '1h'], { clock });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/^Orbit stats for 1 run\(s\) created from 2026-09-30T12:00:00\.000Z to 2026-10-05T11:00:00\.000Z \(0 finished, 0 accepted\)\n/);
    const all = await l.cli(['stats', '--json'], { clock });
    expect(JSON.parse(all.out)).toMatchObject({ window: { from: null, to: null }, runs: { total: 2 } });
    const sinceOnly = await l.cli(['stats', '--since', '2026-10-01'], { clock });
    expect(sinceOnly.out).toContain('from 2026-10-01T00:00:00.000Z to now');
    const untilOnly = await l.cli(['stats', '--until', '1d'], { clock });
    expect(untilOnly.out).toContain('from the beginning to 2026-10-04T12:00:00.000Z');
  });

  it('refuses a window that is empty or backwards, and bad values, before reading anything', async () => {
    const l = lab();
    const backwards = await l.cli(['stats', '--since', '1d', '--until', '2d']);
    expect(backwards.code).toBe(2);
    expect(backwards.err).toContain('--since must be earlier than --until');
    const same = await l.cli(['stats', '--since', '2026-01-01', '--until', '2026-01-01']);
    expect(same.err).toContain('--since must be earlier than --until');
    const bad = await l.cli(['stats', '--since', 'yesterday']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('--since must be an ISO date or time');
    expect(bad.err).not.toContain('no Orbit state');
  });
});

function metrics(over: Partial<Metrics> = {}): Metrics {
  return {
    window: { from: null, to: null },
    runs: { total: 4, finished: 3, accepted: 2, by_state: { SUCCEEDED: 2, BLOCKED: 1, CREATED: 1 } },
    verified_pass_rate: { numerator: 2, denominator: 3, rate: 2 / 3, evidence_reports: { numerator: 5, denominator: 6, rate: 5 / 6 } },
    false_pass_rate: { numerator: 1, denominator: 4, rate: 0.25 },
    escalation_quality: { numerator: 1, denominator: 2, rate: 0.5, escalations: 3, fixed: 1, not_fixed: 1, pending: 1, unmeasured: 0, other_escalations: 0 },
    duplicate_failures: { numerator: 2, denominator: 5, rate: 0.4, distinct_fingerprints: 3, duplicates: 2 },
    time_to_green_ms: { samples: 2, mean: 125_000, median: 120_000, max: 200_000, runs_without_green: 1 },
    spend_per_accepted_task: { accepted: 2, spend_usd: 1.23456, per_accepted_usd: 0.61728, usage_records: 9, unmeasured_records: 0, cost_complete: true },
    token_usage: {
      input: 1_234_567,
      output: 89_000,
      cache_read: 500_000,
      cache_write: 20_000,
      cache_hit_ratio: 0.4,
      records: 9,
      records_without_tokens: 0,
      by_model: [
        { provider: 'claude', model: 'claude-sonnet-5-5', records: 6, input: 1_000_000, output: 70_000, cache_read: 400_000, cache_write: 10_000, cache_hit_ratio: 0.4 },
        { provider: 'codex', model: null, records: 3, input: 234_567, output: 19_000, cache_read: 0, cache_write: 0, cache_hit_ratio: null },
      ],
      output_budget_overruns: 2,
    },
    concurrency_overhead: { worker_queue_ms: 800, workers_measured: 5, worker_active_ms: 45_000, step_wait_ms: 100_000, step_wait_events: 4, overhead_ratio: 0.1 },
    stale_evidence_prevented: { evidence_invalidated: 2, reviews_invalidated: 1, deliveries_refused: 1, total: 4 },
    ui_defects: { discovered: 3, runs_with_ui_defects: 2 },
    missing: [],
    ...over,
  };
}

describe('renderStats', () => {
  it('prints the headline, one row per metric, the per-model table and the closing note', () => {
    const out = renderStats(metrics({ window: { from: Date.UTC(2026, 0, 1), to: Date.UTC(2026, 1, 1) } }));
    expect(out.split('\n')[0]).toBe('Orbit stats for 4 run(s) created from 2026-01-01T00:00:00.000Z to 2026-02-01T00:00:00.000Z (3 finished, 2 accepted)');
    expect(out).toMatch(/verified pass rate\s+66\.7%\s+2 accepted of 3 finished runs; evidence PASS 5 of 6\n/);
    expect(out).toMatch(/false-pass rate\s+25\.0%\s+1 of 4 reviewed PASS candidates refused by review\n/);
    expect(out).toMatch(/escalation quality\s+50\.0%\s+1 fixed, 1 not fixed, 1 pending, 0 unmeasured \(3 escalated attempts\)\n/);
    expect(out).toMatch(/duplicate failures\s+40\.0%\s+2 repeats across 3 fingerprints\n/);
    expect(out).toMatch(/time to green\s+2\.0m\s+median of 2 run\(s\), mean 2\.1m, max 3\.3m; 1 run\(s\) never green\n/);
    expect(out).toMatch(/spend per accepted task\s+\$0\.6173\s+\$1\.2346 over 2 accepted\n/);
    expect(out).toMatch(/tokens\s+1,234,567 in \/ 89,000 out\s+cache read 500,000, write 20,000, hit ratio 40\.0%; 2 output budget overrun\(s\)\n/);
    expect(out).toMatch(/concurrency overhead\s+10\.0%\s+queue 800ms over 5 worker\(s\), step waits 1\.7m \(4 events\), active 45\.0s\n/);
    expect(out).toMatch(/stale evidence prevented\s+4\s+2 evidence and 1 reviews invalidated, 1 deliveries refused\n/);
    expect(out).toMatch(/UI defects found\s+3\s+in 2 run\(s\)\n/);
    expect(out).toMatch(/MODEL\s+PROVIDER\s+RECORDS\s+INPUT\s+OUTPUT\s+CACHE HIT\n/);
    expect(out).toMatch(/claude-sonnet-5-5\s+claude\s+6\s+1,000,000\s+70,000\s+40\.0%\n/);
    expect(out).toMatch(/\(unknown model\)\s+codex\s+3\s+234,567\s+19,000\s+-\n/);
    expect(out).not.toContain('Not measured');
    expect(out.endsWith('\nA dash means no data in the window, not zero.\n')).toBe(true);
  });

  it('shows a dash for every metric with no data, flags partial spend, lists what could not be measured, and omits an empty model table', () => {
    const empty = metrics({
      runs: { total: 0, finished: 0, accepted: 0, by_state: {} },
      verified_pass_rate: { numerator: 0, denominator: 0, rate: null, evidence_reports: { numerator: 0, denominator: 0, rate: null } },
      false_pass_rate: { numerator: 0, denominator: 0, rate: null },
      escalation_quality: { numerator: 0, denominator: 0, rate: null, escalations: 0, fixed: 0, not_fixed: 0, pending: 0, unmeasured: 0, other_escalations: 0 },
      duplicate_failures: { numerator: 0, denominator: 0, rate: null, distinct_fingerprints: 0, duplicates: 0 },
      time_to_green_ms: { samples: 0, mean: null, median: null, max: null, runs_without_green: 0 },
      spend_per_accepted_task: { accepted: 0, spend_usd: 0, per_accepted_usd: null, usage_records: 3, unmeasured_records: 3, cost_complete: false },
      token_usage: { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_hit_ratio: null, records: 0, records_without_tokens: 0, by_model: [], output_budget_overruns: 0 },
      concurrency_overhead: { worker_queue_ms: 0, workers_measured: 0, worker_active_ms: 0, step_wait_ms: 0, step_wait_events: 0, overhead_ratio: null },
      missing: ['no runs were created in this window', 'no usage records'],
    });
    const out = renderStats(empty);
    expect(out).toContain('created from the beginning to now (0 finished, 0 accepted)');
    expect(out).toMatch(/verified pass rate\s+-\s+/);
    expect(out).toMatch(/time to green\s+-\s+median of 0 run\(s\), mean -, max -;/);
    expect(out).toMatch(/spend per accepted task\s+-\s+\$0\.0000 over 0 accepted \(partial: 3 record\(s\) unmeasured\)/);
    expect(out).toMatch(/concurrency overhead\s+-\s+queue 0ms /);
    expect(out).not.toContain('MODEL');
    expect(out).toContain('\n\nNot measured:\n  - no runs were created in this window\n  - no usage records\n\n');
  });

  it('writes durations in milliseconds, seconds, minutes and hours', () => {
    const at = (ms: number) => renderStats(metrics({ time_to_green_ms: { samples: 1, mean: ms, median: ms, max: ms, runs_without_green: 0 } })).match(/time to green\s+(\S+)/)![1];
    expect(at(999)).toBe('999ms');
    expect(at(1000)).toBe('1.0s');
    expect(at(89_900)).toBe('89.9s');
    expect(at(90_000)).toBe('1.5m');
    expect(at(5_399_000)).toBe('90.0m');
    expect(at(5_400_000)).toBe('1.5h');
    expect(at(36_000_000)).toBe('10.0h');
    expect(at(0)).toBe('0ms');
  });
});
