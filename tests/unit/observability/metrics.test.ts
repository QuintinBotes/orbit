import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { metricsFor } from '../../../src/observability/metrics.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { parseCommand } from '../../../src/cli/args.ts';
import { STATS_OPTIONS, STATS_USAGE, parseWhen, statsCommand } from '../../../src/cli/commands/stats.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { UsageError } from '../../../src/cli/exit.ts';

const T0 = 1_700_000_000_000;

/** Seeds rows directly: these tests pin what the metrics read, not how other modules write it. */
class Seed {
  readonly db: OrbitDb;
  private n = 0;
  constructor(db = openDb(':memory:')) {
    this.db = db;
  }
  run(id: string, state: string, createdAt = T0, startedAt: number | null = createdAt): void {
    this.db.run(
      'INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, '/repo/acme', 'goal', 'autonomous', state, 'sha256:x', '/p', createdAt, createdAt, startedAt,
    );
  }
  candidate(runId: string, id: string, attempt: number, seq: number): void {
    this.db.run("INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES (?, ?, ?, ?, 'c', 't', 'p', 'READY', ?)", id, runId, seq, attempt, T0);
  }
  evidence(runId: string, candidateId: string, verdict: 'PASS' | 'FAIL' | 'INCOMPLETE', at: number): void {
    this.db.run("INSERT INTO evidence_reports (id, run_id, candidate_id, tree_hash, check_config_hash, policy_hash, verdict, report_json, created_at) VALUES (?, ?, ?, 't', 'h', 'p', ?, '{}', ?)", `ev-${++this.n}`, runId, candidateId, verdict, at);
  }
  review(runId: string, candidateId: string, verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'BLOCK'): void {
    this.db.run("INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, verdict, created_at) VALUES (?, ?, ?, 't', 1, 'codex', ?, ?)", `rv-${++this.n}`, runId, candidateId, verdict, T0);
  }
  failure(runId: string, candidateId: string | null, fingerprint: string, source = 'check'): void {
    this.db.run('INSERT INTO failures (run_id, candidate_id, source, source_id, fingerprint, created_at) VALUES (?, ?, ?, NULL, ?, ?)', runId, candidateId, source, fingerprint, T0);
  }
  event(runId: string, type: string, data: unknown, ts = T0): void {
    appendEvent(this.db, runId, type, 'test', data, ts);
  }
  route(runId: string, id: string, data: object): void {
    this.db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES (?, ?, 'route', 's', ?, ?)", id, runId, JSON.stringify(data), T0);
  }
  usage(runId: string, p: { provider?: string; model?: string | null; input?: number | null; output?: number | null; read?: number | null; write?: number | null; cost?: number | null; source?: string }): void {
    this.db.run(
      'INSERT INTO usage (run_id, worker_id, provider, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, cost_source, ts) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      runId, p.provider ?? 'claude', p.model === undefined ? 'claude-sonnet-5-5' : p.model, p.input ?? null, p.output ?? null, p.read ?? null, p.write ?? null, p.cost ?? null, p.source ?? (p.cost == null ? 'unavailable' : 'reported'), T0,
    );
  }
  worker(runId: string, id: string, createdAt: number, spawnedAt: number | null, endedAt: number | null): void {
    this.db.run("INSERT INTO workers (id, run_id, role, provider, state, worker_dir, cwd, spawned_at, ended_at, created_at) VALUES (?, ?, 'implementer', 'claude', 'SUCCEEDED', '/w', '/c', ?, ?, ?)", id, runId, spawnedAt, endedAt, createdAt);
  }
}

describe('metricsFor on an empty database', () => {
  it('has null rates, zero counts, and says there were no runs', () => {
    const m = metricsFor(openDb(':memory:'));
    expect(m.runs).toEqual({ total: 0, finished: 0, accepted: 0, by_state: {} });
    expect(m.verified_pass_rate.rate).toBeNull();
    expect(m.false_pass_rate.rate).toBeNull();
    expect(m.escalation_quality.rate).toBeNull();
    expect(m.duplicate_failures.rate).toBeNull();
    expect(m.time_to_green_ms).toMatchObject({ samples: 0, median: null });
    expect(m.spend_per_accepted_task.per_accepted_usd).toBeNull();
    expect(m.token_usage.cache_hit_ratio).toBeNull();
    expect(m.concurrency_overhead.overhead_ratio).toBeNull();
    expect(m.missing).toContain('no runs were created in this window');
  });
});

describe('verified pass rate and the window', () => {
  it('is accepted over finished runs, counts only runs created in the window, and keeps in-flight runs out', () => {
    const s = new Seed();
    s.run('r-old', 'SUCCEEDED', T0 - 10_000);
    s.run('r1', 'SUCCEEDED', T0);
    s.run('r2', 'EXHAUSTED', T0 + 1);
    s.run('r3', 'BLOCKED', T0 + 2);
    s.run('r4', 'IMPLEMENTING', T0 + 3);
    s.run('r5', 'CANCELLED', T0 + 4);
    const all = metricsFor(s.db);
    expect(all.runs).toMatchObject({ total: 6, finished: 4, accepted: 2 });
    const inWindow = metricsFor(s.db, { from: T0 });
    expect(inWindow.runs).toMatchObject({ total: 5, finished: 3, accepted: 1, by_state: { SUCCEEDED: 1, EXHAUSTED: 1, BLOCKED: 1, IMPLEMENTING: 1, CANCELLED: 1 } });
    expect(inWindow.verified_pass_rate).toMatchObject({ numerator: 1, denominator: 3, rate: 0.3333 });
    expect(metricsFor(s.db, { from: T0, to: T0 + 2 }).runs.total).toBe(2);
    s.candidate('r1', 'c1', 1, 1);
    s.evidence('r1', 'c1', 'FAIL', T0);
    s.evidence('r1', 'c1', 'PASS', T0 + 5);
    expect(metricsFor(s.db, { from: T0 }).verified_pass_rate.evidence_reports).toMatchObject({ numerator: 1, denominator: 2, rate: 0.5 });
    expect(metricsFor(s.db, { from: T0 + 100 }).verified_pass_rate.evidence_reports.denominator).toBe(0);
  });
});

describe('false-pass rate', () => {
  it('counts PASS-evidence candidates that a review refused, over those that were reviewed', () => {
    const s = new Seed();
    s.run('r1', 'SUCCEEDED');
    for (const [id, seq] of [['c1', 1], ['c2', 2], ['c3', 3], ['c4', 4]] as const) s.candidate('r1', id, seq, seq);
    for (const id of ['c1', 'c2', 'c3']) s.evidence('r1', id, 'PASS', T0 + 1);
    s.evidence('r1', 'c4', 'FAIL', T0 + 1);
    s.review('r1', 'c1', 'APPROVE');
    s.review('r1', 'c2', 'REPAIR_REQUIRED');
    s.review('r1', 'c2', 'APPROVE');
    s.review('r1', 'c4', 'BLOCK'); // failing evidence is not a false pass
    // c3 has PASS evidence but was never reviewed: outside the denominator.
    expect(metricsFor(s.db).false_pass_rate).toEqual({ numerator: 1, denominator: 2, rate: 0.5 });
  });
});

describe('escalation quality', () => {
  function escalated(s: Seed, run: string, opts: { next: string[] | null; judged?: boolean; prior?: string[]; state?: string }): void {
    s.run(run, opts.state ?? 'SUCCEEDED');
    s.candidate(run, `${run}-c1`, 1, 1);
    for (const fp of opts.prior ?? ['fp-a']) s.failure(run, `${run}-c1`, fp);
    s.event(run, 'implementation.attempt', { attempt: 2, route: `dec-${run}` });
    s.route(run, `dec-${run}`, { kind: 'route', purpose: 'implement:2', escalated_from: { provider: 'claude', model: 'claude-sonnet-5-5', family: 'sonnet' } });
    if (opts.next !== null) {
      s.candidate(run, `${run}-c2`, 2, 2);
      for (const fp of opts.next) s.failure(run, `${run}-c2`, fp);
      if (opts.judged !== false) s.evidence(run, `${run}-c2`, opts.next.length ? 'FAIL' : 'PASS', T0 + 5);
    }
  }

  it('is the share of escalated attempts whose candidate cleared the previous fingerprints', () => {
    const s = new Seed();
    escalated(s, 'fixed', { next: [] });
    escalated(s, 'fixed-other', { next: ['fp-new'] }); // a different failure: the fingerprint is gone
    escalated(s, 'same', { next: ['fp-a', 'fp-z'] });
    escalated(s, 'nocand', { next: null }); // settled run, escalated attempt never produced a candidate
    escalated(s, 'live', { next: null, state: 'IMPLEMENTING' });
    escalated(s, 'unjudged', { next: ['fp-q'], judged: false, state: 'VERIFYING' });
    escalated(s, 'nofp', { next: [], prior: [] });
    // An escalated route that is not an implementer attempt (a diagnosis, say) is counted apart.
    s.run('diag', 'SUCCEEDED');
    s.route('diag', 'dec-diag', { kind: 'route', escalated_from: { provider: 'claude', model: 'm', family: null } });
    // A route that was not escalated is not an escalation.
    s.route('fixed', 'dec-plain', { kind: 'route' });
    const q = metricsFor(s.db).escalation_quality;
    expect(q).toMatchObject({ fixed: 2, not_fixed: 2, pending: 2, unmeasured: 1, escalations: 7, other_escalations: 1, numerator: 2, denominator: 4, rate: 0.5 });
  });
});

describe('duplicate failures', () => {
  it('counts a fingerprint seen again on a later candidate of the same run, not base failures or reruns', () => {
    const s = new Seed();
    s.run('r1', 'EXHAUSTED');
    s.run('r2', 'EXHAUSTED');
    for (const [r, c, seq, att] of [['r1', 'a1', 1, 1], ['r1', 'a2', 2, 2], ['r1', 'a3', 3, 3], ['r2', 'b1', 1, 1]] as const) s.candidate(r, c, seq, att);
    s.failure('r1', 'a1', 'fp-1');
    s.failure('r1', 'a1', 'fp-1'); // the same candidate twice is not a repeat
    s.failure('r1', 'a2', 'fp-1');
    s.failure('r1', 'a3', 'fp-1');
    s.failure('r1', 'a2', 'fp-2');
    s.failure('r1', 'a1', 'fp-flaky', 'flaky_check');
    s.failure('r1', 'a2', 'fp-flaky', 'flaky_check');
    s.failure('r1', null, 'fp-base', 'baseline');
    s.failure('r2', 'b1', 'fp-1'); // another run: not a duplicate of r1's
    const d = metricsFor(s.db).duplicate_failures;
    expect(d).toMatchObject({ duplicates: 2, distinct_fingerprints: 3 });
    expect(d).toMatchObject({ numerator: 2, denominator: 5, rate: 0.4 });
  });
});

describe('time to green', () => {
  it('is the run start to its first PASS evidence, and counts runs that never went green', () => {
    const s = new Seed();
    s.run('r1', 'SUCCEEDED', T0, T0);
    s.run('r2', 'SUCCEEDED', T0, T0 + 1_000);
    s.run('r3', 'EXHAUSTED', T0, T0);
    s.run('r4', 'SUCCEEDED', T0, null); // never started: measured from creation
    for (const [r, c] of [['r1', 'c1'], ['r2', 'c2'], ['r3', 'c3'], ['r4', 'c4']] as const) s.candidate(r, c, 1, 1);
    s.evidence('r1', 'c1', 'FAIL', T0 + 1_000);
    s.evidence('r1', 'c1', 'PASS', T0 + 60_000);
    s.evidence('r1', 'c1', 'PASS', T0 + 90_000); // only the first counts
    s.evidence('r2', 'c2', 'PASS', T0 + 31_000);
    s.evidence('r3', 'c3', 'FAIL', T0 + 5_000);
    s.evidence('r4', 'c4', 'PASS', T0 + 9_000);
    expect(metricsFor(s.db).time_to_green_ms).toEqual({ samples: 3, mean: 33_000, median: 30_000, max: 60_000, runs_without_green: 1 });
  });
});

describe('spend per accepted task, tokens and cache', () => {
  it('charges the spend of every settled run to the accepted ones and lists what is unmeasured', () => {
    const s = new Seed();
    s.run('ok', 'SUCCEEDED');
    s.run('bad', 'EXHAUSTED');
    s.run('live', 'IMPLEMENTING');
    s.usage('ok', { cost: 0.5, input: 1000, output: 100, read: 4000, write: 500 });
    s.usage('bad', { cost: 0.25, input: 2000, output: 300, read: 0, write: 0 });
    s.usage('bad', { cost: null, input: null, output: null });
    s.usage('live', { cost: 9, input: 10, output: 10 }); // in flight: not part of settled spend
    s.usage('ok', { provider: 'codex', model: 'gpt-x', cost: null, input: 3000, output: 50, read: 2000, write: 0 });
    const m = metricsFor(s.db);
    expect(m.spend_per_accepted_task).toEqual({ accepted: 1, spend_usd: 0.75, per_accepted_usd: 0.75, usage_records: 4, unmeasured_records: 2, cost_complete: false });
    expect(m.missing).toEqual(expect.arrayContaining(['cost is unavailable for 2 of 4 usage record(s); spend covers measured records only', '1 of 5 usage record(s) carry no token counts']));
    expect(m.token_usage).toMatchObject({ input: 6010, output: 460, cache_read: 6000, cache_write: 500, records: 5, records_without_tokens: 1 });
    // Claude: prompt = input + cache read + cache write; codex counts cached tokens inside input.
    const claude = m.token_usage.by_model.find((b) => b.provider === 'claude' && b.model === 'claude-sonnet-5-5')!;
    expect(claude).toMatchObject({ records: 4, input: 3010, cache_read: 4000, cache_write: 500 });
    expect(claude.cache_hit_ratio).toBe(Math.round((4000 / (3010 + 4000 + 500)) * 10_000) / 10_000);
    const codex = m.token_usage.by_model.find((b) => b.provider === 'codex')!;
    expect(codex.cache_hit_ratio).toBeCloseTo(2000 / 3000, 3);
  });

  it('has no per-task figure without an accepted run', () => {
    const s = new Seed();
    s.run('bad', 'EXHAUSTED');
    s.usage('bad', { cost: 1 });
    expect(metricsFor(s.db).spend_per_accepted_task).toMatchObject({ accepted: 0, spend_usd: 1, per_accepted_usd: null });
  });

  it('counts output budget overruns recorded by recordUsage', () => {
    const s = new Seed();
    s.run('ok', 'SUCCEEDED');
    const clock = new ManualClock(T0);
    recordUsage(s.db, { runId: 'ok', workerId: null, role: 'verifier', usage: { provider: 'claude', model: 'm', inputTokens: 1, outputTokens: 5000, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1, costSource: 'reported', outputBudgetTokens: 3000 }, durationMs: 1 }, clock);
    expect(metricsFor(s.db).token_usage.output_budget_overruns).toBe(1);
  });
});

describe('concurrency overhead', () => {
  it('is worker queue time plus recorded step waits over that plus active worker time', () => {
    const s = new Seed();
    s.run('r1', 'SUCCEEDED');
    s.worker('r1', 'w1', T0, T0 + 2_000, T0 + 12_000);
    s.worker('r1', 'w2', T0, T0 + 1_000, T0 + 9_000);
    s.event('r1', 'step.wait', { state: 'IMPLEMENTING', reason: 'capacity', wait_ms: 3_000 });
    s.event('r1', 'step.wait', { state: 'IMPLEMENTING', reason: 'capacity', wait_ms: 'soon' });
    const o = metricsFor(s.db).concurrency_overhead;
    expect(o).toMatchObject({ worker_queue_ms: 3_000, workers_measured: 2, worker_active_ms: 18_000, step_wait_ms: 3_000, step_wait_events: 2 });
    expect(o.overhead_ratio).toBe(0.25);
  });

  it('says so when no wait events were persisted', () => {
    const s = new Seed();
    s.run('r1', 'SUCCEEDED');
    s.worker('r1', 'w1', T0, T0, T0 + 1000);
    const m = metricsFor(s.db);
    expect(m.concurrency_overhead).toMatchObject({ step_wait_events: 0, overhead_ratio: 0 });
    expect(m.missing.join(' ')).toMatch(/no step\.wait events are recorded/);
  });
});

describe('stale-evidence prevention and UI defects', () => {
  it('counts invalidations and refused deliveries', () => {
    const s = new Seed();
    s.run('r1', 'SUCCEEDED');
    s.event('r1', 'evidence.invalidated', { reason: 'tree changed' });
    s.event('r1', 'evidence.invalidated', { reason: 'policy changed' });
    s.event('r1', 'review.invalidated', { reason: 'tree changed' });
    s.event('r1', 'action.failed', { error: 'delivery refused: evidence is stale: tree changed' });
    s.event('r1', 'action.failed', { error: 'push rejected by the remote' });
    s.event('r1', 'action.failed', { error: 'release refused: head is not the reviewed commit' });
    expect(metricsFor(s.db).stale_evidence_prevented).toEqual({ evidence_invalidated: 2, reviews_invalidated: 1, deliveries_refused: 2, total: 5 });
  });

  it('counts distinct failing UI checks on candidates, once per fingerprint', () => {
    const s = new Seed();
    s.run('r1', 'SUCCEEDED');
    s.run('r2', 'SUCCEEDED');
    s.candidate('r1', 'c1', 1, 1);
    s.candidate('r1', 'c2', 2, 2);
    const check = (id: string, run: string, cand: string | null, kind: string, status: string, fp: string | null) =>
      s.db.run(
        "INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, fingerprint, started_at) VALUES (?, ?, ?, 'ui-checkout', ?, 't', 'h', 'p', '[]', '/c', 'none', ?, ?, ?)",
        id, run, cand, kind, status, fp, T0,
      );
    check('k1', 'r1', 'c1', 'playwright', 'FAILED', 'fp-ui-1');
    check('k2', 'r1', 'c2', 'playwright', 'FAILED', 'fp-ui-1'); // the same defect on the next candidate
    check('k3', 'r1', 'c2', 'playwright', 'FAILED', 'fp-ui-2');
    check('k4', 'r1', 'c2', 'playwright', 'PASSED', null);
    check('k5', 'r1', 'c2', 'command', 'FAILED', 'fp-cmd');
    check('k6', 'r1', null, 'playwright', 'FAILED', 'fp-base'); // base, not a candidate
    expect(metricsFor(s.db).ui_defects).toEqual({ discovered: 2, runs_with_ui_defects: 1 });
  });
});

describe('orbit stats', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repoWithState(seed: (s: Seed) => void): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-stats-')));
    dirs.push(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, '.orbit'), { recursive: true });
    const db = openDb(join(repo, '.orbit', 'state.sqlite'));
    seed(new Seed(db));
    db.close();
    return repo;
  }

  async function stats(repo: string, argv: string[], now = T0 + 86_400_000) {
    const io = memoryIo();
    const ctx = createContext({ cwd: repo, io, clock: new ManualClock(now) });
    const code = await statsCommand(parseCommand(argv, STATS_OPTIONS, STATS_USAGE), ctx);
    return { code, out: io.stdout };
  }

  it('prints every spec 16 metric as JSON, limited by --since, and as a table', async () => {
    const repo = repoWithState((s) => {
      s.run('old', 'EXHAUSTED', T0 - 10 * 86_400_000);
      s.run('r1', 'SUCCEEDED', T0);
      s.candidate('r1', 'c1', 1, 1);
      s.evidence('r1', 'c1', 'PASS', T0 + 20_000);
      s.usage('r1', { cost: 0.4, input: 10, output: 5 });
    });
    const all = await stats(repo, ['--json']);
    expect(all.code).toBe(0);
    const j = JSON.parse(all.out) as Record<string, unknown>;
    for (const key of ['verified_pass_rate', 'false_pass_rate', 'escalation_quality', 'duplicate_failures', 'time_to_green_ms', 'spend_per_accepted_task', 'token_usage', 'concurrency_overhead', 'stale_evidence_prevented', 'ui_defects', 'missing']) expect(j).toHaveProperty(key);
    expect((j.runs as { total: number }).total).toBe(2);

    const recent = JSON.parse((await stats(repo, ['--json', '--since', '2d'])).out) as { runs: { total: number }; spend_per_accepted_task: { per_accepted_usd: number }; time_to_green_ms: { median: number } };
    expect(recent.runs.total).toBe(1);
    expect(recent.spend_per_accepted_task.per_accepted_usd).toBe(0.4);
    expect(recent.time_to_green_ms.median).toBe(20_000);

    const text = (await stats(repo, [])).out;
    expect(text).toMatch(/verified pass rate\s+50\.0%/);
    expect(text).toMatch(/spend per accepted task/);
    expect(text).toMatch(/Not measured:/);
    expect(text).toMatch(/A dash means no data in the window, not zero\./);
  });

  it('refuses a bad window and a missing state database', async () => {
    const repo = repoWithState(() => {});
    await expect(stats(repo, ['--since', 'yesterday-ish'])).rejects.toThrow(UsageError);
    await expect(stats(repo, ['--since', '1d', '--until', '2d'])).rejects.toThrow(/earlier than/);
    const empty = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-stats-')));
    dirs.push(empty);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
    await expect(stats(empty, [])).rejects.toThrow(/no Orbit state/);
  });

  it('reads spans and ISO dates', () => {
    expect(parseWhen('90m', 10_000_000, 'since')).toBe(10_000_000 - 90 * 60_000);
    expect(parseWhen('2w', 1_000_000_000, 'since')).toBe(1_000_000_000 - 14 * 86_400_000);
    expect(parseWhen('2026-09-01', 0, 'since')).toBe(Date.parse('2026-09-01'));
    expect(parseWhen('2026-09-01T10:00:00Z', 0, 'since')).toBe(Date.parse('2026-09-01T10:00:00Z'));
    expect(() => parseWhen('last week', 0, 'since')).toThrow(UsageError);
  });
});
