/**
 * The live tier of `orbit bench`: goals pinned to a commit of one of the owner's repositories where a real failure
 * happened, each with an acceptance check the worker never sees (test files of the accepted fix, laid over the tree the
 * run ended with), run three times with real providers and, with --baseline, three times by one plain `claude -p` session.
 * It spends money, so it starts only with the owner's approval and an explicit budget, and never on its own.
 *
 * The catalog is a data file (data/bench/live-goals.json) checked by parseLiveCatalog; a goal whose check does not fail
 * on its commit and pass on the accepted fix is invalid and left out of every count.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseDocument } from 'yaml';
import { stateDbPath } from '../controller/start.ts';
import { listRuns } from '../controller/run-store.ts';
import type { FailureClass } from '../controller/failure-class.ts';
import { openDb } from '../storage/db.ts';
import type { ScenarioRow } from './scorecard.ts';

export const LIVE_CATALOG_SCHEMA_VERSION = 1;
export const RUNS_PER_GOAL = 3;
/** Live goals pin only these repositories (owner decision on #172): no third-party code. */
export const OWNER_REPOSITORIES: readonly string[] = ['QuintinBotes/orbit', 'QuintinBotes/claude-stack', 'QuintinBotes/proofmesh', 'QuintinBotes/review-voice'];

export interface LiveGoal {
  id: string;
  repository: string;
  /** The commit the failure happened at; the run starts here. */
  commit: string;
  /** The commit of the accepted fix: where the held-out check comes from, and where it must pass. */
  reference: string;
  /** The issue that reported the failure. */
  issue: string;
  /** What the run is asked to do. */
  goal: string;
  /** The held-out check: these paths from `reference` laid over the result, then `command` must exit 0. */
  acceptance: { paths: string[]; command: string[] };
  /** Run before the check in a fresh tree (such as npm ci); null for none. */
  setup: string[] | null;
}

const SHA = /^[0-9a-f]{40}$/;
const isStrings = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x !== '');
const relPath = (p: string): boolean => !p.startsWith('/') && !p.split('/').includes('..');

/** The goals of a catalog file. Every problem of every goal is reported at once, and none is skipped. */
export function parseLiveCatalog(text: string): LiveGoal[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`the live catalog is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const doc = (data ?? {}) as { schema_version?: unknown; goals?: unknown };
  if (doc.schema_version !== LIVE_CATALOG_SCHEMA_VERSION) throw new Error(`the live catalog must have schema_version ${LIVE_CATALOG_SCHEMA_VERSION}`);
  if (!Array.isArray(doc.goals) || doc.goals.length === 0) throw new Error('the live catalog must have a non-empty "goals" list');
  const problems: string[] = [];
  const ids = new Set<string>();
  const goals = doc.goals.map((item: unknown, i: number): LiveGoal => {
    const g = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const at = `goal ${i + 1}${typeof g.id === 'string' ? ` (${g.id})` : ''}`;
    const bad = (what: string): void => void problems.push(`${at}: ${what}`);
    if (typeof g.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(g.id)) bad('id must be lower-case words joined by hyphens');
    else if (ids.has(g.id)) bad('id is used by an earlier goal');
    else ids.add(g.id);
    if (typeof g.repository !== 'string' || !OWNER_REPOSITORIES.includes(g.repository)) bad(`repository must be one of ${OWNER_REPOSITORIES.join(', ')}`);
    if (typeof g.commit !== 'string' || !SHA.test(g.commit)) bad('commit must be a full 40-character commit id');
    if (typeof g.reference !== 'string' || !SHA.test(g.reference)) bad('reference must be a full 40-character commit id');
    else if (g.reference === g.commit) bad('reference must differ from commit');
    if (typeof g.issue !== 'string' || !(typeof g.repository === 'string' && new RegExp(`^https://github\\.com/${g.repository.replace('.', '\\.')}/issues/\\d+$`).test(g.issue))) bad("issue must be the URL of an issue of the goal's repository");
    if (typeof g.goal !== 'string' || g.goal.trim() === '') bad('goal must be the text the run is given');
    const a = (g.acceptance && typeof g.acceptance === 'object' ? g.acceptance : {}) as Record<string, unknown>;
    if (!isStrings(a.paths) || !a.paths.every(relPath)) bad('acceptance.paths must list the held-out files as paths inside the repository');
    if (!isStrings(a.command)) bad('acceptance.command must be the check as a list of arguments');
    if (g.setup !== undefined && g.setup !== null && !isStrings(g.setup)) bad('setup must be null or a list of arguments');
    return { id: g.id as string, repository: g.repository as string, commit: g.commit as string, reference: g.reference as string, issue: g.issue as string, goal: g.goal as string, acceptance: { paths: a.paths as string[], command: a.command as string[] }, setup: (g.setup as string[] | undefined) ?? null };
  });
  if (problems.length > 0) throw new Error(`the live catalog has ${problems.length} problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  return goals;
}

/** One session's outcome on one goal. */
export interface LiveTrial {
  end_state: string | null;
  failure_class: FailureClass | null;
  attempts: number;
  spend_usd: number;
  wall_ms: number;
  /** The session reported the goal done (an Orbit run SUCCEEDED; a plain session always hands back its tree). */
  delivered: boolean;
  /** The held-out check passed on what was delivered. */
  accepted: boolean;
  problems: string[];
}

/** What runs the goals: the real one starts Orbit and claude; tests pass a fake that never calls a model. */
export interface LiveExecutor {
  /** Why the goal's held-out check cannot judge it (it does not fail on the commit, or does not pass on the fix); empty when it can. */
  validate(goal: LiveGoal): Promise<string[]>;
  orbit(goal: LiveGoal, capUsd: number): Promise<LiveTrial>;
  plain(goal: LiveGoal, capUsd: number): Promise<LiveTrial>;
}

export interface LiveTierOptions {
  goals: readonly LiveGoal[];
  /** The most the whole tier may spend; every session gets an equal share as its own cap. */
  budgetUsd: number;
  baseline: boolean;
  executor: LiveExecutor;
  onRow?: (row: ScenarioRow) => void;
}

/** The budget a live run states, or why it may not start: there is no default (owner decision on #172). */
export function liveBudget(text: string | undefined): number {
  if (text === undefined) throw new Error('the live tier spends money and needs an explicit budget: --budget <usd>');
  const usd = Number(text);
  if (!/^\d+(\.\d+)?$/.test(text.trim()) || !Number.isFinite(usd) || usd <= 0) throw new Error(`--budget must be a positive amount in US dollars, got ${JSON.stringify(text)}`);
  return usd;
}

/** Sessions a live run plans: three per goal, twice that with the baseline. */
export function plannedSessions(goals: number, baseline: boolean): number {
  return goals * RUNS_PER_GOAL * (baseline ? 2 : 1);
}

const title = (g: LiveGoal): string => (g.goal.split('\n')[0] ?? '').slice(0, 120);

function rowOf(g: LiveGoal, n: number, t: LiveTrial): ScenarioRow {
  return { id: `${g.id}#${n}`, issue: g.issue, title: title(g), result: t.accepted ? 'pass' : 'fail', failure_class: t.failure_class, end_state: t.end_state, attempts: t.attempts, spend_usd: t.spend_usd, wall_ms: t.wall_ms, delivered: t.delivered, problems: [...t.problems] };
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * A session that threw: kept as a failed row, so the tier goes on and the sessions already paid for still reach the
 * scorecard. Its spend is unknown, not free, so it is charged its cap.
 */
const crashed = (err: unknown, cap: number): LiveTrial => ({ end_state: null, failure_class: null, attempts: 0, spend_usd: cap, wall_ms: 0, delivered: false, accepted: false, problems: [`the session failed; its spend is unknown, so it is charged its cap of $${cap.toFixed(4)}: ${messageOf(err)}`.slice(0, 1000)] });

const skipped = (g: LiveGoal, id: string, why: string): ScenarioRow => ({ id, issue: g.issue, title: title(g), result: 'invalid', failure_class: null, end_state: null, attempts: 0, spend_usd: 0, wall_ms: null, delivered: false, problems: [why] });

/** Every goal, three times by Orbit and (with the baseline) three times by a plain session; every result is kept. */
export async function runLiveTier(o: LiveTierOptions): Promise<{ rows: ScenarioRow[]; baseline: ScenarioRow[] | null }> {
  const cap = o.budgetUsd / plannedSessions(o.goals.length, o.baseline);
  let spent = 0;
  const rows: ScenarioRow[] = [];
  const plain: ScenarioRow[] = [];
  const session = async (g: LiveGoal, n: number, run: (g: LiveGoal, cap: number) => Promise<LiveTrial>, into: ScenarioRow[]): Promise<void> => {
    // Each session is held to its cap, so this only trips when sessions overran theirs.
    const row = spent + cap > o.budgetUsd + 1e-9 ? skipped(g, `${g.id}#${n}`, `not run: $${(o.budgetUsd - spent).toFixed(4)} of the budget is left, less than one session's cap of $${cap.toFixed(4)}`) : rowOf(g, n, await run(g, cap).catch((err: unknown) => crashed(err, cap)));
    spent += row.spend_usd;
    into.push(row);
    o.onRow?.(row);
  };
  for (const g of o.goals) {
    const invalid = await o.executor.validate(g).catch((err: unknown) => [`could not check the goal: ${messageOf(err)}`]);
    if (invalid.length > 0) {
      const row = { ...skipped(g, g.id, ''), problems: invalid };
      rows.push(row);
      if (o.baseline) plain.push({ ...row, problems: [...invalid] });
      o.onRow?.(row);
      continue;
    }
    for (let n = 1; n <= RUNS_PER_GOAL; n++) {
      await session(g, n, (x, c) => o.executor.orbit(x, c), rows);
      if (o.baseline) await session(g, n, (x, c) => o.executor.plain(x, c), plain);
    }
  }
  return { rows, baseline: o.baseline ? plain : null };
}

// ---------------------------------------------------------------------------
// The real executor. Nothing above calls it; `orbit bench --tier live` does, after the approval and budget checks.

function sh(cmd: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env, timeoutMs = 3_600_000): { status: number; out: string; stdout: string } {
  const r = spawnSync(cmd[0]!, cmd.slice(1), { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? String(r.error) : ''}`, stdout: r.stdout ?? '' };
}

function must(cmd: readonly string[], cwd: string, env: NodeJS.ProcessEnv = process.env): void {
  const r = sh(cmd, cwd, env);
  if (r.status !== 0) throw new Error(`${cmd.join(' ')} failed (exit ${r.status}): ${r.out.slice(-1000)}`);
}

/**
 * A fresh repository at `rev`, in its own temp directory: `rev` and its history only, fetched by commit id, with no
 * remote. A full clone would hold the accepted fix and its held-out tests (FR-003); they are fetched only to grade.
 */
function cloneAt(url: string, g: LiveGoal, rev: string): string {
  const base = mkdtempSync(join(tmpdir(), `orbit-bench-live-${g.id}-`));
  const repo = join(base, 'repo');
  must(['git', 'init', '--quiet', repo], base);
  must(['git', 'fetch', '--quiet', url, rev], repo);
  must(['git', 'checkout', '--quiet', '-B', 'orbit-bench', rev], repo);
  return repo;
}

const cleanup = (repo: string): void => {
  spawnSync('chmod', ['-R', 'u+w', dirname(repo)]);
  rmSync(dirname(repo), { recursive: true, force: true });
};

/** Lay the held-out files of the accepted fix over `tree`, set it up, and run the check. */
function heldOut(g: LiveGoal, tree: string, from: string): { passed: boolean; out: string; setupFailed?: boolean } {
  for (const p of g.acceptance.paths) {
    const r = sh(['git', '-C', from, 'show', `${g.reference}:${p}`], from);
    if (r.status !== 0) return { passed: false, out: `held-out file ${p} is not in ${g.reference}: ${r.out}` };
    mkdirSync(dirname(join(tree, p)), { recursive: true });
    writeFileSync(join(tree, p), r.stdout);
  }
  if (g.setup) {
    const s = sh(g.setup, tree);
    if (s.status !== 0) return { passed: false, out: `setup failed: ${s.out.slice(-1000)}`, setupFailed: true };
  }
  const c = sh(g.acceptance.command, tree);
  return { passed: c.status === 0, out: c.out.slice(-1000) };
}

/**
 * Runs goals for real: Orbit from this process's own entry point with the policy `orbit init` writes for the clone, in
 * autonomous mode (it commits in its worktree and pushes nothing), and the baseline as one `claude -p` session. Each
 * session is capped at its share of the budget: Orbit through scheduler.hard_limits.model_cost_usd, claude through
 * --max-budget-usd.
 */
export function localExecutor(opts: { orbitCommand?: readonly string[]; remote?: (repository: string) => string } = {}): LiveExecutor {
  const orbitCommand = opts.orbitCommand ?? [process.execPath, ...process.execArgv, process.argv[1]!];
  const remote = opts.remote ?? ((r: string): string => `https://github.com/${r}.git`);
  const clone = (g: LiveGoal, rev: string): string => cloneAt(remote(g.repository), g, rev);
  /** The accepted fix, brought into the clone once the session in it has ended. */
  const fetchReference = (g: LiveGoal, repo: string): void => must(['git', 'fetch', '--quiet', remote(g.repository), g.reference], repo);
  /** Grade `repo` (at `commit` when given) after its session: a grading error fails the check and keeps what the session spent. */
  const grade = (g: LiveGoal, repo: string, commit?: string): { passed: boolean; out: string } => {
    try {
      if (commit) must(['git', 'checkout', '--quiet', '--force', commit], repo);
      fetchReference(g, repo);
      return heldOut(g, repo, repo);
    } catch (err) {
      return { passed: false, out: `could not grade: ${messageOf(err)}` };
    }
  };
  return {
    async validate(g) {
      const repo = clone(g, g.commit);
      try {
        fetchReference(g, repo);
        // The check judges the goal only when it fails before the fix and passes with it; a setup that fails says nothing.
        const before = heldOut(g, repo, repo);
        if (before.passed) return [`the held-out check already passes on ${g.commit}, so it cannot tell a fix from none`];
        if (before.setupFailed) return [`the setup fails on ${g.commit}, so the check cannot tell a fix from none: ${before.out}`];
        must(['git', 'checkout', '--quiet', '--force', g.reference], repo);
        const fixed = heldOut(g, repo, repo);
        return fixed.passed ? [] : [`the held-out check does not pass on the accepted fix ${g.reference}: ${fixed.out}`];
      } catch (err) {
        return [`could not check the goal: ${messageOf(err)}`];
      } finally {
        cleanup(repo);
      }
    },
    async orbit(g, cap) {
      const repo = clone(g, g.commit);
      const env = { ...process.env, ORBIT_HOME: join(dirname(repo), 'orbit-home') };
      try {
        must([...orbitCommand, 'init'], repo, env);
        const policy = join(repo, '.orbit', 'config.yaml');
        const doc = parseDocument(readFileSync(policy, 'utf8'));
        doc.setIn(['scheduler', 'hard_limits', 'model_cost_usd'], Number(cap.toFixed(4)));
        writeFileSync(policy, doc.toString());
        // Orbit stops itself at its wall limit. A kill before that is a SIGTERM, which detaches its workers (a shutdown is
        // not a cancel), and they would go on spending after the clone is removed; so the timeout only backs that limit up.
        const wallMinutes = Number(doc.getIn(['scheduler', 'hard_limits', 'wall_minutes']));
        const timeoutMs = ((Number.isFinite(wallMinutes) && wallMinutes > 0 ? wallMinutes : 120) + 30) * 60_000;
        const t0 = Date.now();
        const r = sh([...orbitCommand, 'run', '--foreground', '--mode', 'autonomous', '--goal', g.goal], repo, env, timeoutMs);
        const wall = Date.now() - t0;
        const db = openDb(stateDbPath(repo));
        try {
          const run = listRuns(db, { limit: 1 })[0];
          if (!run) return { end_state: null, failure_class: null, attempts: 0, spend_usd: 0, wall_ms: wall, delivered: false, accepted: false, problems: [`orbit run started no run: ${r.out.slice(-1000)}`] };
          const used = (c: string): number => db.get<{ used: number }>('SELECT used FROM budget_counters WHERE run_id = ? AND counter = ?', run.id, c)?.used ?? 0;
          // SUCCEEDED releases the run's checkouts (finishRun), so the delivered tree is graded from the commit the outcome
          // names (autonomous mode delivers a local branch at it), checked out in the clone.
          const commit = run.state === 'SUCCEEDED' ? (JSON.parse(run.outcomeJson ?? '{}') as { commit?: unknown }).commit : undefined;
          const delivered = typeof commit === 'string';
          const check = delivered ? grade(g, repo, commit) : null;
          const problems = check ? (check.passed ? [] : [`held-out check failed: ${check.out}`]) : [`${run.state}: ${run.state === 'SUCCEEDED' ? 'the outcome names no delivered commit' : (run.outcomeReason ?? '')}`.slice(0, 500)];
          return { end_state: run.state, failure_class: run.failureClass, attempts: used('implementation_attempts'), spend_usd: used('cost_usd'), wall_ms: wall, delivered, accepted: check?.passed ?? false, problems };
        } finally {
          db.close();
        }
      } finally {
        cleanup(repo);
      }
    },
    async plain(g, cap) {
      const repo = clone(g, g.commit);
      try {
        const t0 = Date.now();
        const r = sh(['claude', '-p', g.goal, '--output-format', 'json', '--max-budget-usd', cap.toFixed(4), '--permission-mode', 'acceptEdits'], repo);
        const wall = Date.now() - t0;
        let reported: unknown;
        try {
          reported = (JSON.parse(r.stdout.trim().split('\n').at(-1) ?? '{}') as { total_cost_usd?: unknown }).total_cost_usd;
        } catch {
          // An unreadable result still keeps the run.
        }
        // A spend the session did not report is unknown, not free: it is charged the session's cap, and the problem says so.
        const spend = typeof reported === 'number' && Number.isFinite(reported) ? reported : cap;
        const check = grade(g, repo);
        return { end_state: r.status === 0 ? 'DONE' : 'FAILED', failure_class: null, attempts: 1, spend_usd: spend, wall_ms: wall, delivered: true, accepted: check.passed, problems: [...(spend === reported ? [] : [`the session reported no cost; it is charged its cap of $${cap.toFixed(4)}`]), ...(check.passed ? [] : [`held-out check failed: ${check.out}`])] };
      } finally {
        cleanup(repo);
      }
    },
  };
}
