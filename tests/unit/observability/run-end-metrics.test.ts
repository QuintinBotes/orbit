// Issue #167: `orbit stats` counts runs per failure class (US1) and separates them by the Orbit version that
// started them (US2), so a release is shown to be better instead of assumed.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseCommand } from '../../../src/cli/args.ts';
import { STATS_OPTIONS, STATS_USAGE, renderStats, statsCommand } from '../../../src/cli/commands/stats.ts';
import { createContext } from '../../../src/cli/context.ts';
import { UsageError } from '../../../src/cli/exit.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { acquireLease, createRun, transition } from '../../../src/controller/run-store.ts';
import type { RunState } from '../../../src/core/run-states.ts';
import { metricsFor } from '../../../src/observability/metrics.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { MIGRATIONS } from '../../../src/storage/schema.ts';

const T0 = 1_700_000_000_000;
const TO_REVIEWING: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'];

/** A run recorded by `version` that ends in `state` through the run store, as a controller ends it. */
function finish(db: OrbitDb, clock: ManualClock, id: string, version: string, state: RunState, end: { outcome?: Record<string, unknown>; data?: Record<string, unknown> } = {}): void {
  createRun(db, { id, repoRoot: '/repo/acme', goal: 'goal', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p', orbitVersion: version }, clock);
  acquireLease(db, id, 'o', 60_000, clock);
  for (const to of state === 'SUCCEEDED' ? TO_REVIEWING : (['PREFLIGHT'] as RunState[])) transition(db, { runId: id, to, ownerId: 'o', reason: 'test' }, clock);
  transition(db, { runId: id, to: state, ownerId: 'o', reason: 'ended', ...(end.data ? { data: end.data } : {}), ...(end.outcome ? { patch: { outcomeReason: 'ended', outcomeJson: JSON.stringify(end.outcome) } } : {}) }, clock);
}

function usage(db: OrbitDb, runId: string, cost: number | null): void {
  db.run("INSERT INTO usage (run_id, worker_id, provider, model, input_tokens, output_tokens, cost_usd, cost_source, ts) VALUES (?, NULL, 'claude', 'claude-sonnet-5-5', 10, 5, ?, ?, ?)", runId, cost, cost === null ? 'unavailable' : 'reported', T0);
}

/** One lab run per class, as the independent test of user story 1 asks. */
function oneRunPerClass(db: OrbitDb, clock: ManualClock, version = '0.4.0'): void {
  finish(db, clock, 'ok', version, 'SUCCEEDED');
  finish(db, clock, 'env', version, 'BLOCKED', { outcome: { environment_failures: [{ check_id: 'unit' }] } });
  finish(db, clock, 'misconfigured', version, 'BLOCKED', { outcome: { misconfigured_checks: [{ check_id: 'e2e' }] } });
  finish(db, clock, 'deadlock', version, 'BLOCKED', { outcome: { review_gate: ['no approving review'], open_findings: [] } });
  finish(db, clock, 'scope', version, 'BLOCKED', { outcome: { scope: { within_scope: false } } });
  finish(db, clock, 'budget', version, 'EXHAUSTED', { data: { counter: 'cost_usd' } });
  finish(db, clock, 'dispute', version, 'EXHAUSTED', { outcome: { open_findings: [{ id: 'f1' }] }, data: { counter: 'review_rounds' } });
  finish(db, clock, 'model', version, 'IMPOSSIBLE', { outcome: { hypotheses: ['a'] } });
  finish(db, clock, 'credentials', version, 'BLOCKED', { outcome: { blocker: { kind: 'authentication', provider: 'claude' } } });
  finish(db, clock, 'cancelled', version, 'CANCELLED');
  // turn-cap: the sessions ended at their cap before the attempts ran out.
  createRun(db, { id: 'turns', repoRoot: '/repo/acme', goal: 'goal', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p', orbitVersion: version }, clock);
  acquireLease(db, 'turns', 'o', 60_000, clock);
  transition(db, { runId: 'turns', to: 'PREFLIGHT', ownerId: 'o', reason: 'test' }, clock);
  db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES ('turns', ?, 'implementation.worker-ended', 'o', ?)", T0, JSON.stringify({ attempt: 1, status: 'max_turns' }));
  transition(db, { runId: 'turns', to: 'EXHAUSTED', ownerId: 'o', reason: 'attempts spent', data: { counter: 'implementation_attempts' } }, clock);
}

describe('failure classes as counts (US1)', () => {
  it('reports each finished run under its class, and success under none', () => {
    const db = openDb(':memory:');
    oneRunPerClass(db, new ManualClock(T0));
    const m = metricsFor(db);
    expect(m.failure_classes.by_class).toEqual({
      environment: 1,
      'check-misconfigured': 1,
      'gate-deadlock': 1,
      scope: 1,
      budget: 1,
      'turn-cap': 1,
      model: 1,
      'review-dispute': 1,
      credentials: 1,
      cancelled: 1,
    });
    expect(m.failure_classes.secondary).toEqual({ budget: 2 });
    expect(m.failure_classes).toMatchObject({ ended: 11, without_class: 1, unclassified: 0 });
  });

  it('lists every class of the fixed list, with zero for one no run ended in', () => {
    const db = openDb(':memory:');
    finish(db, new ManualClock(T0), 'env', '0.4.0', 'BLOCKED', { outcome: { environment_failures: [{ check_id: 'unit' }] } });
    const m = metricsFor(db);
    expect(Object.keys(m.failure_classes.by_class)).toEqual(['environment', 'check-misconfigured', 'gate-deadlock', 'scope', 'budget', 'turn-cap', 'model', 'review-dispute', 'credentials', 'cancelled']);
    expect(m.failure_classes.by_class.environment).toBe(1);
    expect(m.failure_classes.by_class.model).toBe(0);
  });

  it('counts a run that has not ended nowhere, and an ended run from before the migration as unclassified', () => {
    const db = openDb(':memory:');
    const clock = new ManualClock(T0);
    createRun(db, { id: 'live', repoRoot: '/repo/acme', goal: 'goal', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
    db.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('old', '/repo/acme', 'g', 'autonomous', 'BLOCKED', 'sha256:x', '/p', ?, ?)", T0, T0);
    db.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('old-ok', '/repo/acme', 'g', 'autonomous', 'SUCCEEDED', 'sha256:x', '/p', ?, ?)", T0, T0);
    const m = metricsFor(db);
    expect(m.failure_classes).toMatchObject({ ended: 2, without_class: 1, unclassified: 1 });
    expect(Object.values(m.failure_classes.by_class).reduce((a, b) => a + b, 0)).toBe(0);
    expect(m.missing).toContain('1 ended run(s) carry no failure class: they ended before Orbit recorded one');
  });

  it('prints the classes that have runs, in the table', () => {
    const db = openDb(':memory:');
    oneRunPerClass(db, new ManualClock(T0));
    const text = renderStats(metricsFor(db));
    expect(text).toMatch(/FAILURE CLASS\s+RUNS\s+SECONDARY/);
    expect(text).toMatch(/environment\s+1\s+0/);
    expect(text).toMatch(/budget\s+1\s+2/);
    expect(text).toMatch(/cancelled\s+1\s+0/);
    expect(text).toMatch(/\(none\)\s+1/);
  });
});

describe('runs that stopped holding a verified candidate (issue #169, FR-004)', () => {
  it('are counted on their own, apart from the other blocked and failed runs', () => {
    const db = openDb(':memory:');
    const clock = new ManualClock(T0);
    finish(db, clock, 'ok', '0.4.0', 'SUCCEEDED');
    finish(db, clock, 'held', '0.4.0', 'BLOCKED', { outcome: { decided: 'EXHAUSTED', verified_candidate: { candidate_id: 'c1', seq: 1 } }, data: { counter: 'cost_usd' } });
    finish(db, clock, 'env', '0.4.0', 'BLOCKED', { outcome: { environment_failures: [{ check_id: 'unit' }] } });
    finish(db, clock, 'spent', '0.4.0', 'EXHAUSTED', { data: { counter: 'cost_usd' } });
    const m = metricsFor(db);
    expect(m.runs).toMatchObject({ total: 4, finished: 4, accepted: 1, verified_undelivered: 1, by_state: { SUCCEEDED: 1, BLOCKED: 2, EXHAUSTED: 1 } });
    // Why it stopped is still a class: it ran out of budget, as the plain EXHAUSTED run did.
    expect(m.failure_classes.by_class.budget).toBe(2);
    expect(renderStats(m)).toMatch(/\(4 finished, 1 accepted, 1 stopped holding a verified candidate\)/);
  });
});

describe('statistics by Orbit version (US2)', () => {
  function twoVersions(db: OrbitDb): void {
    const clock = new ManualClock(T0);
    // 0.3.2: one accepted of three finished, 0.90 spent.
    finish(db, clock, 'a1', '0.3.2', 'SUCCEEDED');
    finish(db, clock, 'a2', '0.3.2', 'BLOCKED', { outcome: { environment_failures: [{ check_id: 'unit' }] } });
    finish(db, clock, 'a3', '0.3.2', 'EXHAUSTED', { data: { counter: 'cost_usd' } });
    usage(db, 'a1', 0.3);
    usage(db, 'a2', 0.2);
    usage(db, 'a3', 0.4);
    // 0.4.0: two accepted of two finished, 0.50 spent; a cancelled run is not a finished one.
    finish(db, clock, 'b1', '0.4.0', 'SUCCEEDED');
    finish(db, clock, 'b2', '0.4.0', 'SUCCEEDED');
    finish(db, clock, 'b3', '0.4.0', 'CANCELLED');
    usage(db, 'b1', 0.25);
    usage(db, 'b2', 0.25);
  }

  it('shows pass rate and spend per accepted task per version (scenario 1)', () => {
    const db = openDb(':memory:');
    twoVersions(db);
    const m = metricsFor(db);
    expect(m.by_version).toEqual([
      { orbit_version: '0.3.2', runs: 3, finished: 3, accepted: 1, pass_rate: 0.3333, spend_usd: 0.9, per_accepted_usd: 0.9, cost_complete: true, failure_classes: { environment: 1, budget: 1 } },
      { orbit_version: '0.4.0', runs: 3, finished: 2, accepted: 2, pass_rate: 1, spend_usd: 0.5, per_accepted_usd: 0.25, cost_complete: true, failure_classes: { cancelled: 1 } },
    ]);
    const text = renderStats(m);
    expect(text).toMatch(/ORBIT VERSION\s+RUNS\s+PASS RATE\s+SPEND PER ACCEPTED/);
    expect(text).toMatch(/0\.3\.2\s+3\s+33\.3%\s+\$0\.9000/);
    expect(text).toMatch(/0\.4\.0\s+3\s+100\.0%\s+\$0\.2500/);
  });

  it('a version with nothing accepted or finished has a null rate and spend, never zero', () => {
    const db = openDb(':memory:');
    const clock = new ManualClock(T0);
    finish(db, clock, 'c1', '0.5.0', 'CANCELLED');
    usage(db, 'c1', null);
    expect(metricsFor(db).by_version).toEqual([{ orbit_version: '0.5.0', runs: 1, finished: 0, accepted: 0, pass_rate: null, spend_usd: 0, per_accepted_usd: null, cost_complete: false, failure_classes: { cancelled: 1 } }]);
  });

  it('a filter by version limits every metric to the runs that version started', () => {
    const db = openDb(':memory:');
    twoVersions(db);
    const old = metricsFor(db, { orbitVersion: '0.3.2' });
    expect(old.window.orbit_version).toBe('0.3.2');
    expect(old.runs).toMatchObject({ total: 3, finished: 3, accepted: 1 });
    expect(old.verified_pass_rate.rate).toBe(0.3333);
    expect(old.spend_per_accepted_task).toMatchObject({ spend_usd: 0.9, per_accepted_usd: 0.9 });
    expect(old.token_usage.records).toBe(3);
    expect(old.by_version.map((v) => v.orbit_version)).toEqual(['0.3.2']);
    expect(old.failure_classes.by_class).toMatchObject({ environment: 1, budget: 1, cancelled: 0 });
    const next = metricsFor(db, { orbitVersion: '0.4.0' });
    expect(next.runs).toMatchObject({ total: 3, finished: 2, accepted: 2 });
    expect(next.spend_per_accepted_task.per_accepted_usd).toBe(0.25);
    expect(metricsFor(db).window.orbit_version).toBeNull();
    expect(metricsFor(db, { orbitVersion: '9.9.9' }).runs.total).toBe(0);
  });

  it('runs written before the migration are version unknown, and can be asked for by that name (edge case 2)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-167-metrics-'));
    try {
      const path = join(dir, 'state.sqlite');
      const old = openDb(path, { migrations: MIGRATIONS.slice(0, 6) });
      old.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('old', '/repo/acme', 'g', 'autonomous', 'SUCCEEDED', 'sha256:x', '/p', ?, ?)", T0, T0);
      old.close();
      const db = openDb(path);
      finish(db, new ManualClock(T0 + 1), 'new', '0.4.0', 'SUCCEEDED');
      const m = metricsFor(db);
      expect(m.by_version.map((v) => [v.orbit_version, v.runs])).toEqual([['0.4.0', 1], ['unknown', 1]]);
      expect(metricsFor(db, { orbitVersion: 'unknown' }).runs.total).toBe(1);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('orbit stats --orbit-version', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function repoWithRuns(): string {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-stats-167-')));
    dirs.push(repo);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    mkdirSync(join(repo, '.orbit'), { recursive: true });
    const db = openDb(join(repo, '.orbit', 'state.sqlite'));
    const clock = new ManualClock(T0);
    finish(db, clock, 'a1', '0.3.2', 'BLOCKED', { outcome: { environment_failures: [{ check_id: 'unit' }] } });
    finish(db, clock, 'b1', '0.4.0', 'SUCCEEDED');
    finish(db, clock, 'b2', '0.4.0', 'EXHAUSTED', { data: { counter: 'cost_usd' } });
    db.close();
    return repo;
  }

  async function stats(repo: string, argv: string[]) {
    const io = memoryIo();
    const code = await statsCommand(parseCommand(argv, STATS_OPTIONS, STATS_USAGE), createContext({ cwd: repo, io, clock: new ManualClock(T0 + 86_400_000) }));
    return { code, out: io.stdout };
  }

  it('prints both fields as JSON for every run, and for one version when asked', async () => {
    const repo = repoWithRuns();
    const all = JSON.parse((await stats(repo, ['--json'])).out) as { failure_classes: { by_class: Record<string, number> }; by_version: { orbit_version: string; runs: number }[] };
    expect(all.failure_classes.by_class).toMatchObject({ environment: 1, budget: 1 });
    expect(all.by_version.map((v) => [v.orbit_version, v.runs])).toEqual([['0.3.2', 1], ['0.4.0', 2]]);

    const one = JSON.parse((await stats(repo, ['--json', '--orbit-version', '0.4.0'])).out) as { window: { orbit_version: string }; runs: { total: number }; failure_classes: { by_class: Record<string, number> }; by_version: { orbit_version: string }[] };
    expect(one.window.orbit_version).toBe('0.4.0');
    expect(one.runs.total).toBe(2);
    expect(one.failure_classes.by_class).toMatchObject({ environment: 0, budget: 1 });
    expect(one.by_version.map((v) => v.orbit_version)).toEqual(['0.4.0']);
  });

  it('says which version the table is for', async () => {
    const repo = repoWithRuns();
    const text = (await stats(repo, ['--orbit-version', '0.3.2'])).out;
    expect(text).toMatch(/^Orbit stats for 1 run\(s\) started by Orbit 0\.3\.2, created from/);
    expect(text).toMatch(/environment\s+1/);
  });

  it('refuses a value that is not a version', async () => {
    const repo = repoWithRuns();
    await expect(stats(repo, ['--orbit-version', "0.4.0' OR 1=1 --"])).rejects.toThrow(UsageError);
    await expect(stats(repo, ['--orbit-version', ''])).rejects.toThrow(UsageError);
  });

  it('documents the option in its usage line', () => {
    expect(STATS_USAGE).toContain('--orbit-version <version>');
  });
});
