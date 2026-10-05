/**
 * Everything one controller step needs, assembled from durable state. A step
 * never trusts memory from an earlier tick: the run row, the frozen policy
 * (re-verified against the hash recorded at run start), the validated
 * contract, the current candidate and the bound budget ledger are read again
 * every time, so a restarted controller sees exactly what the crashed one
 * would have seen.
 */
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, realpathSync } from 'node:fs';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { sha256 } from '../core/hash.ts';
import { nullLogger, type Logger } from '../core/log.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { ProviderAdapter } from '../adapters/types.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import { getIsolation } from '../isolation/index.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { verifySnapshot } from '../policy/snapshot.ts';
import type { GoalContract } from '../contract/types.ts';
import { validateContract } from '../contract/validate.ts';
import { listCandidates, type CandidateRecord } from '../evidence/store.ts';
import { BudgetLedger } from '../scheduling/budget.ts';
import type { ModelRegistry } from '../routing/registry.ts';
import type { GitHubClient } from '../delivery/github.ts';
import { getRun, type RunRecord } from './run-store.ts';

/** Timing knobs. Defaults suit a real service; tests shrink them. */
export interface ControllerTiming {
  /** Poll interval of the check runner. */
  checkPollMs: number;
  /** Grace between signals when stopping a check or worker group. */
  killGraceMs: number;
  /** How long "no CI checks reported" may last after delivery before it counts as absent. */
  ciAbsentGraceMs: number;
  /** Worker wall-clock limit when the budget gives none tighter. */
  workerTimeoutMs: number;
}

export const DEFAULT_TIMING: Readonly<ControllerTiming> = Object.freeze({
  checkPollMs: 200,
  killGraceMs: 2_000,
  ciAbsentGraceMs: 60_000,
  workerTimeoutMs: 30 * 60_000,
});

/** Long-lived collaborators shared by every run a controller owns. */
export interface ControllerDeps {
  db: OrbitDb;
  clock: Clock;
  logger?: Logger;
  /** This controller incarnation (core/ids.newOwnerId); the lease holder for every transition it makes. */
  ownerId: string;
  /** Provider adapters by provider id (the keys of config.providers). */
  adapters: Readonly<Record<string, ProviderAdapter>>;
  registry: ModelRegistry;
  /** ~/.orbit: worktrees, logs and the global knowledge graph live here, never in the repository. */
  orbitHome: string;
  /** The real home directory, used only to compute what sandboxes must hide. */
  homeDir?: string;
  /** Orbit's own environment; worker environments are built from a scrubbed copy of it by the adapters. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** Orbit's installation directory (agents/, bundled tools). */
  orbitInstallDir: string;
  /** Overrides isolation construction (tests); defaults to isolation/getIsolation over the snapshot. */
  isolationFor?: (snapshot: PolicySnapshot, run: RunRecord) => IsolationProvider;
  /** The delivery client for a run; defaults to delivery/defaultGitHubClient. */
  github?: (ctx: RunContext) => GitHubClient;
  agentsDir?: string;
  /** Path of gitleaks; null forces the built-in secret patterns; undefined searches PATH. */
  gitleaksPath?: string | null;
  timing?: Partial<ControllerTiming>;
}

export interface RunContext {
  deps: ControllerDeps;
  db: OrbitDb;
  clock: Clock;
  log: Logger;
  ownerId: string;
  run: RunRecord;
  /** Verified against runs.policy_hash on load. */
  snapshot: PolicySnapshot;
  /** Validated against the snapshot on load; null before CONTRACTING finishes. */
  contract: GoalContract | null;
  /** The newest finished candidate, or null before the first one. */
  candidate: CandidateRecord | null;
  /** Bound to the run once PLANNING has initialized the counters; null before. */
  ledger: BudgetLedger | null;
  /** .orbit/runs/<run-id> */
  runDir: string;
  /** Aborted when the lease is lost, the step times out or the controller stops. */
  signal: AbortSignal;
  timing: ControllerTiming;
  /** False only for the lenient context used to record why a run with an unverifiable policy blocked. */
  policyVerified: boolean;
  /** Constructed lazily: the environment gate decides whether it may exist at all. */
  isolation(): IsolationProvider;
  /** Re-read the run row (after a transition or before a decision that must see a fresh cancellation). */
  refresh(): RunRecord;
}

/**
 * Load a run's context. A snapshot whose hash no longer matches is
 * POLICY_TAMPERED and a stored contract that no longer validates is
 * CONTRACT_INVALID; the step runner turns both into BLOCKED rather than
 * acting on authority it cannot verify.
 */
export function loadRunContext(deps: ControllerDeps, runId: string, signal: AbortSignal): RunContext {
  const { db } = deps;
  const run = getRun(db, runId);
  const snapshot = verifySnapshot(run.policyPath, run.policyHash);
  let contract: GoalContract | null = null;
  if (run.contractJson) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(run.contractJson);
    } catch (err) {
      throw new OrbitError('CONTRACT_INVALID', `run ${runId} holds an unreadable contract`, undefined, { cause: err });
    }
    // Contract fields (allowed_paths above all) feed matchers only after validation accepts them.
    contract = validateContract(parsed, snapshot, { policyHash: run.policyHash });
  }
  const candidate = currentCandidate(db, runId);
  let ledger: BudgetLedger | null = null;
  if (db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', runId)) ledger = new BudgetLedger(db, deps.clock).attach(runId, snapshot);
  const runDir = dirname(run.policyPath);
  const log = (deps.logger ?? nullLogger).child({ run_id: runId });
  let isolation: IsolationProvider | null = null;
  const ctx: RunContext = {
    deps,
    db,
    clock: deps.clock,
    log,
    ownerId: deps.ownerId,
    run,
    snapshot,
    contract,
    candidate,
    ledger,
    runDir,
    signal,
    timing: { ...DEFAULT_TIMING, ...(deps.timing ?? {}) },
    policyVerified: true,
    isolation() {
      isolation ??= deps.isolationFor ? deps.isolationFor(snapshot, ctx.run) : getIsolation(snapshot.config.isolation, { orbitInstallDir: deps.orbitInstallDir, mode: ctx.run.mode, labels: { 'orbit.run': runId } });
      return isolation;
    },
    refresh() {
      ctx.run = getRun(db, runId);
      return ctx.run;
    },
  };
  return ctx;
}

/** The event the implementation steps append when an attempt's tree becomes a candidate. */
export const CANDIDATE_EVENT = 'implementation.candidate';

/**
 * The candidate the newest attempt produced. Not simply the highest seq: an
 * attempt that reproduces an earlier tree gets that earlier candidate back
 * (same tree, same candidate), and it is still the current one.
 */
export function currentCandidate(db: OrbitDb, runId: string): CandidateRecord | null {
  const ev = db.get<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id DESC LIMIT 1', runId, CANDIDATE_EVENT);
  const id = ev?.data_json ? (JSON.parse(ev.data_json) as { candidate_id?: string }).candidate_id : undefined;
  const all = listCandidates(db, runId);
  if (id) {
    const hit = all.find((c) => c.id === id);
    if (hit) return hit;
  }
  return all.filter((c) => c.status === 'READY' || c.status === 'DELIVERED').at(-1) ?? null;
}

/**
 * A context for a run whose policy or contract fails verification: the
 * snapshot is read without trusting it, only so the run can be stopped and
 * reported. It authorizes nothing (no isolation, no contract, no ledger).
 */
export function lenientContext(deps: ControllerDeps, runId: string, signal: AbortSignal): RunContext {
  const run = getRun(deps.db, runId);
  let snapshot: PolicySnapshot;
  try {
    snapshot = JSON.parse(readFileSync(run.policyPath, 'utf8')) as PolicySnapshot;
  } catch {
    snapshot = { schema: 'orbit.policy/1', run_id: run.id, created_at: '', repo_root: run.repoRoot, config: {} as PolicySnapshot['config'], effective_protected_paths: [], check_config_hashes: {} };
  }
  const ctx: RunContext = {
    deps,
    db: deps.db,
    clock: deps.clock,
    log: (deps.logger ?? nullLogger).child({ run_id: runId }),
    ownerId: deps.ownerId,
    run,
    snapshot,
    contract: null,
    candidate: currentCandidate(deps.db, runId),
    ledger: null,
    runDir: dirname(run.policyPath),
    signal,
    timing: { ...DEFAULT_TIMING, ...(deps.timing ?? {}) },
    policyVerified: false,
    isolation() {
      throw new OrbitError('POLICY_TAMPERED', `run ${runId} has no verified policy; nothing may run under it`);
    },
    refresh() {
      ctx.run = getRun(deps.db, runId);
      return ctx.run;
    },
  };
  return ctx;
}

export function homeOf(deps: ControllerDeps): string {
  return deps.homeDir ?? homedir();
}

/** Short stable id of a repository, for paths under ~/.orbit. */
export function repoKey(repoRoot: string): string {
  let real = repoRoot;
  try {
    real = realpathSync(repoRoot);
  } catch {
    /* a missing repository is reported by preflight */
  }
  return sha256(real).slice(0, 12);
}

/** ~/.orbit/worktrees/<repo-hash>/<run-id>: worker worktrees and candidate checkouts, outside the repository. */
export function runWorktreeRoot(ctx: Pick<RunContext, 'deps' | 'run'>): string {
  return join(ctx.deps.orbitHome, 'worktrees', repoKey(ctx.run.repoRoot), ctx.run.id);
}
