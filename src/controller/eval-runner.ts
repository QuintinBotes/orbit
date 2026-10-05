/**
 * Replay evaluation of prompt overlays (ADR 0002). The knowledge module
 * defines the suite, the metrics and the adoption rule; this is the part
 * that owns workers, worktrees and checks: it replays one past task as a
 * complete Orbit run.
 *
 * Each ReplayCase runs in a throwaway clone of the repository checked out at
 * the case's base revision, with its own state database, under the same
 * policy and the same model registry as the live repository, once with the
 * baseline overlay and once with the candidate. The clone has no remote and
 * cannot deliver anything (its mode is never a delivery mode and the delivery
 * actions are off); it does not learn (curation and evaluation are off in the
 * clone) and it can spend at most what is left of knowledge.eval_budget_usd.
 *
 * "Verified" means the run reached SUCCEEDED with a fresh PASS evidence report
 * bound to the candidate's tree, every check the original contract required
 * passing. A "false pass" is a candidate that passed verification and was
 * then refused by independent review: the checks were satisfied and still
 * wrong. The same measurements over live runs are the window the rollback
 * check compares with the adoption baseline.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { redact } from '../core/redact.ts';
import { git } from '../evidence/git.ts';
import { currentEvidenceReport } from '../evidence/store.ts';
import { DELIVERY_ACTIONS, DELIVERY_MODES, RELEASE_ACTIONS } from '../policy/config.ts';
import type { OrbitConfig } from '../policy/types.ts';
import { stopWorker } from '../recovery/reconcile.ts';
import { listReviews } from '../review/store.ts';
import { ModelRegistry } from '../routing/registry.ts';
import { summarizeUsage } from '../routing/usage.ts';
import { openDb, type OrbitDb } from '../storage/db.ts';
import { listActiveWorkers, listWorkers } from '../storage/workers.ts';
import { buildReplaySuite, evaluateOverlay, type CaseResult, type EvalRunner, type ReplayCase, type ReplaySuite } from '../knowledge/evals.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { completeEvaluation, startEvaluation } from '../knowledge/overlays.ts';
import type { EvalMetrics, PromptOverlay } from '../knowledge/types.ts';
import { currentCandidate, repoKey, type ControllerDeps, type RunContext } from './context.ts';
import type { ControllerOptions } from './loop.ts';
import { getRun } from './run-store.ts';
import { isTerminal } from './states.ts';
import { defaultControllerDeps, stateDbPath, startRun, type DefaultDepsInput } from './start.ts';

// ---------------------------------------------------------------------------
// Measuring a run

export interface RunMeasurement {
  state: string;
  /** SUCCEEDED, with a fresh PASS evidence report bound to the candidate's tree and every required check passing. */
  verified: boolean;
  /** Implementation attempts (implementer workers). */
  attempts: number;
  /** Model cost, or null when any of it is unmeasured. */
  costUsd: number | null;
  /** What the run spent against its budget: measured cost, or the ceiling charged for what was not measured. */
  spentUsd: number;
  /** Verification passed on a tree that independent review then refused. */
  falsePass: boolean;
}

/**
 * Measure one run from its durable records. `requiredCheckIds` defaults to
 * the run's own contract; a replay passes the original run's, so the replay
 * is judged by what the original task required.
 */
export function measureRun(db: OrbitDb, runId: string, requiredCheckIds?: readonly string[]): RunMeasurement {
  const run = getRun(db, runId);
  let required = requiredCheckIds;
  if (!required) {
    try {
      required = (JSON.parse(run.contractJson ?? 'null') as { required_check_ids?: string[] } | null)?.required_check_ids ?? [];
    } catch {
      required = [];
    }
  }
  const attempts = listWorkers(db, { runId, role: 'implementer' }).length;
  const usage = summarizeUsage(db, runId);
  const counter = db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'cost_usd'", runId);
  const spentUsd = Math.max(usage.totals.costUsd, Number(counter?.used ?? 0));

  let verified = false;
  const cand = currentCandidate(db, runId);
  const report = cand ? currentEvidenceReport(db, runId, cand.id) : null;
  if (run.state === 'SUCCEEDED' && cand && report && report.verdict === 'PASS' && report.treeHash === cand.treeHash) {
    verified = required.every((id) => report.report.checks.some((c) => c.id === id && c.status === 'PASSED'));
  }
  const reviews = listReviews(db, runId);
  const passedTrees = new Set(
    (db.all<{ tree_hash: string }>("SELECT tree_hash FROM evidence_reports WHERE run_id = ? AND verdict = 'PASS'", runId)).map((r) => r.tree_hash),
  );
  const falsePass = reviews.some((r) => r.verdict !== 'APPROVE' && passedTrees.has(r.treeHash));
  return { state: run.state, verified, attempts, costUsd: usage.costComplete ? usage.totals.costUsd : null, spentUsd, falsePass };
}

/** Run states that settle a task: a verdict the run will not take back. BLOCKED waits for a person; CANCELLED says nothing about the prompt. */
const SETTLED_STATES = ['SUCCEEDED', 'EXHAUSTED', 'IMPOSSIBLE'] as const;

export interface LiveWindow extends EvalMetrics {
  /** Settled tasks in the window. */
  tasks: number;
}

/**
 * The live metrics of the runs settled since `sinceMs` (an overlay's
 * activation), in the same terms as the replay metrics, so they compare with
 * the baseline recorded at adoption. Null when nothing has settled yet.
 */
export function liveWindow(db: OrbitDb, sinceMs: number): LiveWindow | null {
  const rows = db.all<{ id: string }>(
    `SELECT id FROM runs WHERE state IN (${SETTLED_STATES.map(() => '?').join(', ')}) AND created_at >= ? ORDER BY created_at, id`,
    ...SETTLED_STATES,
    sinceMs,
  );
  if (rows.length === 0) return null;
  const ms = rows.map((r) => measureRun(db, r.id));
  const results: CaseResult[] = ms.map((m, i) => ({ case_id: rows[i]!.id, verified: m.verified, attempts: m.attempts, cost_usd: m.costUsd, false_pass: m.falsePass }));
  return { ...metricsOf(results), tasks: results.length };
}

function metricsOf(results: readonly CaseResult[]): EvalMetrics {
  const n = results.length;
  const verified = results.filter((r) => r.verified).length;
  const costs = results.map((r) => r.cost_usd);
  const total = costs.every((c): c is number => c !== null) ? costs.reduce((s: number, c) => s + (c as number), 0) : null;
  return {
    verified_pass_rate: verified / n,
    mean_attempts: results.reduce((s, r) => s + r.attempts, 0) / n,
    mean_cost_usd: total === null || verified === 0 ? null : total / verified,
    false_pass_rate: results.filter((r) => r.false_pass).length / n,
  };
}

// ---------------------------------------------------------------------------
// The runner

export interface ReplayEvalRunnerOptions {
  /** The repository whose tasks are replayed. */
  repoRoot: string;
  /** The repository's live policy; each replay runs under a copy with delivery and learning switched off. */
  config: OrbitConfig;
  clock: Clock;
  orbitHome: string;
  /** Spend ceiling for every case this runner runs (knowledge.eval_budget_usd). */
  budgetUsd: number;
  /**
   * Builds the controller's collaborators for a clone (adapters, registry).
   * The default is the production wiring; the CLI passes its seam and the
   * controller passes its own adapters.
   */
  deps?: (input: DefaultDepsInput) => Omit<ControllerDeps, 'ownerId'>;
  /** The live state database: its model registry is copied into each clone, so a replay routes to the same models. */
  registryDb?: OrbitDb;
  env?: Readonly<Record<string, string | undefined>>;
  /** Controller timing for the replayed runs. */
  controller?: Partial<Pick<ControllerOptions, 'leaseTtlMs' | 'leaseRenewMs' | 'heartbeatMs' | 'tickIntervalMs' | 'stepTimeoutMs' | 'shutdownGraceMs' | 'graceMs' | 'startGraceMs'>>;
  /** Wall-clock limit for one replayed run; defaults to the policy's wall_minutes plus a minute. */
  caseTimeoutMs?: number;
  /** Stops the evaluation: the running case ends unverified and no further case starts. */
  signal?: AbortSignal;
  /** Keep the clones (debugging); they are removed by default. */
  keepClones?: boolean;
}

/** The policy a replay runs under: the live one, minus anything that could reach outside the clone or start more learning. */
export function replayConfig(config: OrbitConfig, remainingUsd: number): OrbitConfig {
  const c = JSON.parse(JSON.stringify(config)) as OrbitConfig;
  if (DELIVERY_MODES.has(c.mode)) c.mode = 'autonomous';
  for (const a of [...DELIVERY_ACTIONS, ...RELEASE_ACTIONS]) c.actions[a] = false;
  // The overlay under test is read from the clone's knowledge graph, which needs learning on; nothing else in it may run.
  c.knowledge = { ...c.knowledge, enabled: true, share_globally: false, curator_budget_usd: 0, eval_budget_usd: 0, auto_adopt_overlays: false };
  c.scheduler.hard_limits.model_cost_usd = Math.max(0.01, Math.min(c.scheduler.hard_limits.model_cost_usd, remainingUsd));
  return c;
}

export class ReplayEvalRunner implements EvalRunner {
  private readonly o: ReplayEvalRunnerOptions;
  private spent = 0;

  constructor(options: ReplayEvalRunnerOptions) {
    this.o = options;
  }

  /** Spend so far across every case, in USD. */
  get spentUsd(): number {
    return this.spent;
  }

  async runCase(suite: ReplaySuite, c: ReplayCase, overlay: PromptOverlay | null): Promise<CaseResult> {
    const { budgetUsd } = this.o;
    if (this.o.signal?.aborted) throw new OrbitError('CANCELLED', 'the evaluation was stopped');
    if (this.spent >= budgetUsd) throw new OrbitError('BUDGET_EXHAUSTED', `the evaluation budget of $${budgetUsd.toFixed(2)} is spent after $${this.spent.toFixed(2)}; raise knowledge.eval_budget_usd to continue`);
    const dir = join(this.o.orbitHome, 'eval', repoKey(this.o.repoRoot), `${suite.id}-${c.id}-${newId('rpl')}`);
    const clone = join(dir, 'repo');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let cloneWorktrees: string | null = null;
    let db: OrbitDb | null = null;
    try {
      await cloneAt(this.o.repoRoot, clone, c.base_revision);
      cloneWorktrees = join(this.o.orbitHome, 'worktrees', repoKey(clone));
      this.seedOverlay(clone, overlay);
      const config = replayConfig(this.o.config, budgetUsd - this.spent);
      mkdirSync(join(clone, '.orbit'), { recursive: true });
      db = openDb(stateDbPath(clone));
      this.copyRegistry(db);
      const run = startRun({ db, repoRoot: clone, goal: c.goal, config, clock: this.o.clock, actor: 'eval' });
      await this.drive(db, clone, config, run.id);
      const m = measureRun(db, run.id, c.check_ids);
      this.spent += m.spentUsd;
      // A budget too small to admit a single attempt measures nothing: say so rather than record two identical failures.
      if (m.state === 'EXHAUSTED' && m.attempts === 0 && /not admitted/.test(getRun(db, run.id).outcomeReason ?? '')) {
        throw new OrbitError('BUDGET_EXHAUSTED', `the evaluation budget of $${budgetUsd.toFixed(2)} is too small to run one replayed task (the run's own admission refused its first attempt); raise knowledge.eval_budget_usd`);
      }
      return { case_id: c.id, verified: m.verified, attempts: m.attempts, cost_usd: m.costUsd, false_pass: m.falsePass };
    } finally {
      try {
        db?.close();
      } catch {
        /* closing a database that failed to open */
      }
      if (!this.o.keepClones) {
        rmSync(dir, { recursive: true, force: true });
        if (cloneWorktrees) rmSync(cloneWorktrees, { recursive: true, force: true });
      }
    }
  }

  /** The overlay under test becomes the clone's active overlay for its role (repo scope, where the controller reads it); null leaves the base prompt. */
  private seedOverlay(clone: string, overlay: PromptOverlay | null): void {
    const store = KnowledgeStore.open(join(clone, '.orbit', 'knowledge.sqlite'), { clock: this.o.clock });
    try {
      if (overlay) store.insertOverlay({ ...overlay, scope: 'repo', status: 'active', parent_id: null, eval: null, activated_at: new Date(this.o.clock.now()).toISOString() });
    } finally {
      store.close();
    }
  }

  /** Same models: the clone's registry is the live one (availability, limits and pricing as validated), not a fresh seed. */
  private copyRegistry(db: OrbitDb): void {
    const from = this.o.registryDb;
    if (!from) return;
    const rows = from.all<Record<string, string | number | null>>('SELECT * FROM model_registry');
    db.tx(() => {
      for (const r of rows) {
        const cols = Object.keys(r);
        db.run(`INSERT OR REPLACE INTO model_registry (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...cols.map((k) => r[k] as string | number | null));
      }
    });
  }

  private async drive(db: OrbitDb, clone: string, config: OrbitConfig, runId: string): Promise<void> {
    // Imported here: the controller loop imports the report module, which imports this one.
    const { Controller } = await import('./loop.ts');
    const factory = this.o.deps ?? defaultControllerDeps;
    const deps = factory({ repoRoot: clone, db, clock: this.o.clock, config, orbitHome: this.o.orbitHome, ...(this.o.env ? { env: this.o.env } : {}) });
    const controller = new Controller({ deps, mode: 'foreground', runId, handleSignals: false, ...(this.o.controller ?? {}) });
    const limitMs = this.o.caseTimeoutMs ?? config.scheduler.hard_limits.wall_minutes * 60_000 + 60_000;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void controller.stop('replay case timed out');
    }, limitMs);
    const onAbort = (): void => void controller.stop('evaluation stopped');
    this.o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      await controller.start();
    } finally {
      clearTimeout(timer);
      this.o.signal?.removeEventListener('abort', onAbort);
    }
    // A run that did not end (timeout, stop) must not leave workers running in a clone that is about to be removed.
    if (!isTerminal(getRun(db, runId).state)) {
      for (const w of listActiveWorkers(db, runId)) {
        try {
          await stopWorker({ db, clock: this.o.clock, ownerId: controller.ownerId, adapters: deps.adapters, graceMs: 500 }, w, timedOut ? 'replay case timed out' : 'evaluation stopped');
        } catch {
          /* its files go with the clone; the process is not ours to hunt */
        }
      }
    }
  }
}

/** A throwaway clone at `revision` with no remote: nothing in it can push, fetch or open a pull request. */
async function cloneAt(source: string, dest: string, revision: string): Promise<void> {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  try {
    // A local clone copies the object store as it is, so a base revision that is no longer on any branch is still there.
    await git(join(dest, '..'), ['clone', '--local', '--no-checkout', '--quiet', source, dest]);
    await git(dest, ['cat-file', '-e', `${revision}^{commit}`]);
    await git(dest, ['checkout', '--quiet', '--detach', revision]);
    await git(dest, ['remote', 'remove', 'origin']);
  } catch (err) {
    if (isOrbitError(err, 'GIT_FAILED')) throw new OrbitError('NOT_FOUND', `cannot replay at ${revision}: ${redact(err.message).slice(0, 300)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Deciding

export interface EvaluationOutcome {
  overlay: PromptOverlay;
  adopted: boolean;
  reason: string;
  cases: number;
  spentUsd?: number;
}

/**
 * Replay `overlay` against the role's active overlay (or the base prompt) and
 * let the knowledge module decide. Evaluates again, up to `maxAttempts`, when
 * the active overlay changes during the replay: a candidate is never adopted
 * over something it was not compared with.
 */
export async function evaluateAndDecide(input: { store: KnowledgeStore; overlay: PromptOverlay; runner: EvalRunner; suite: ReplaySuite; maxAttempts?: number; onRetry?: (attempt: number, max: number) => void }): Promise<EvaluationOutcome> {
  const max = input.maxAttempts ?? 3;
  let overlay = input.overlay;
  if (overlay.status === 'candidate') overlay = startEvaluation(input.store, overlay.id);
  for (let attempt = 1; attempt <= max; attempt++) {
    const baseline = input.store.activeOverlay(overlay.role, overlay.scope);
    const r = await evaluateOverlay(input.runner, input.suite, baseline, overlay);
    try {
      const out = completeEvaluation(input.store, overlay.id, { cases: r.cases, suite_id: r.suite_id, baseline: r.baseline, candidate: r.candidate, baseline_overlay_id: baseline?.id ?? null });
      return { overlay: out.overlay, adopted: out.decision.adopt, reason: out.decision.reason, cases: r.cases };
    } catch (err) {
      if (!isOrbitError(err, 'CONCURRENT_UPDATE') || attempt === max) throw err;
      input.onRetry?.(attempt, max);
    }
  }
  throw new OrbitError('CONCURRENT_UPDATE', 'the active overlay kept changing; evaluate again later');
}

/** Past runs a controller-triggered evaluation replays at most: the budget bounds spend, this bounds how long the controller stays on one finished run. */
const AUTO_EVAL_CASES = 5;

/**
 * At the end of a run: when ADR 0002's automatic adoption is on, an overlay
 * waits as a candidate (or an interrupted evaluation) and the evaluation
 * budget is positive, replay it. One overlay per finished run. Never throws:
 * learning cannot change a run's outcome.
 */
export async function autoEvaluateOverlays(ctx: RunContext, store: KnowledgeStore): Promise<{ skipped: string | null; overlay?: string; adopted?: boolean; reason?: string; spent_usd?: number; error?: string }> {
  const k = ctx.snapshot.config.knowledge;
  if (!k.auto_adopt_overlays) return { skipped: 'knowledge.auto_adopt_overlays is off' };
  if (!(k.eval_budget_usd > 0)) return { skipped: 'knowledge.eval_budget_usd is 0' };
  const waiting = store.listOverlays({ scope: 'repo' }).filter((o) => o.status === 'candidate' || o.status === 'evaluating');
  const overlay = waiting[0];
  if (!overlay) return { skipped: 'no candidate overlay' };
  try {
    const suite = buildReplaySuite(ctx.db, { limit: AUTO_EVAL_CASES, role: overlay.role }, ctx.clock);
    if (suite.cases.length === 0) return { skipped: 'no successful runs to replay', overlay: overlay.id };
    const runner = new ReplayEvalRunner({
      repoRoot: ctx.run.repoRoot,
      config: ctx.snapshot.config,
      clock: ctx.clock,
      orbitHome: ctx.deps.orbitHome,
      budgetUsd: k.eval_budget_usd,
      registryDb: ctx.db,
      signal: ctx.signal,
      ...(ctx.deps.hostEnv ? { env: ctx.deps.hostEnv } : {}),
      deps: (input) => {
        const { ownerId: _owner, ...rest } = ctx.deps;
        return { ...rest, db: input.db ?? ctx.db, registry: new ModelRegistry(input.db ?? ctx.db, ctx.clock) };
      },
    });
    const out = await evaluateAndDecide({ store, overlay, runner, suite });
    return { skipped: null, overlay: out.overlay.id, adopted: out.adopted, reason: out.reason, spent_usd: runner.spentUsd };
  } catch (err) {
    return { skipped: null, overlay: overlay.id, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}
