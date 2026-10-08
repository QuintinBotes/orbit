/**
 * `orbit status [run-id]`: where a run is, what it has spent, who is working
 * on it and what it is waiting for. Everything comes from durable state, so
 * it is the same answer whether a controller is running or not.
 */
import { existsSync } from 'node:fs';
import { OrbitError } from '../../core/errors.ts';
import type { OrbitDb } from '../../storage/db.ts';
import { findController } from '../../storage/controllers.ts';
import { listWorkers, type WorkerRecord } from '../../storage/workers.ts';
import { listRuns, type RunRecord } from '../../controller/run-store.ts';
import { newRunNeeded } from '../../controller/resume.ts';
import { createdBranch, currentCandidateRef } from '../../controller/run-refs.ts';
import { isTerminal } from '../../controller/states.ts';
import { stateDbPath } from '../../controller/start.ts';
import { pruneDeadControllers } from '../../controller/service.ts';
import { verifySnapshot } from '../../policy/snapshot.ts';
import { BudgetLedger } from '../../scheduling/budget.ts';
import type { CostMeasurement, CounterState, ReserveState } from '../../scheduling/types.ts';
import { listQuestions } from '../../inquisition/store.ts';
import type { Args, OptionSpec } from '../args.ts';
import { controllers, findRunByPrefix, initialised, liveLease, resolveRepo, withState, type CliContext } from '../context.ts';
import { ago, flat, iso, json, line, oneLine, table } from '../io.ts';
import { EXIT } from '../exit.ts';

export const STATUS_OPTIONS: OptionSpec = {
  all: { type: 'boolean', description: 'list every run, not just the 10 most recent' },
};

/** Ended for good: a BLOCKED run is terminal for the controller but can still be cancelled, so a pending request there is real. */
function finished(state: string): boolean {
  return state !== 'BLOCKED' && isTerminal(state as Parameters<typeof isTerminal>[0]);
}

export interface RunStatus {
  id: string;
  goal: string;
  mode: string;
  state: string;
  /** The state, plus the stage an interruption will return to. */
  stage: string;
  paused: boolean;
  cancel_requested: boolean;
  outcome_reason: string | null;
  /** The task branch, once delivery created it; null before (the name PREFLIGHT chose is not a branch yet). */
  branch: string | null;
  /** The ref that pins the run's current candidate (refs/orbit/<run>/candidates/<seq>), once there is one. */
  candidate_ref: string | null;
  difficulty: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
  last_progress_at: number | null;
  last_event: { type: string; at: number; to_state: string | null } | null;
  owner: { owner_id: string; lease_expires_at: number } | null;
  heartbeat: { controller_id: string; mode: string; heartbeat_at: number; age_ms: number; live: boolean; last_progress_at: number | null } | null;
  budgets: {
    counters: CounterState[];
    sessions: CounterState[];
    reserve: ReserveState | null;
    cost_measurement: CostMeasurement | null;
    verified_policy: boolean;
  } | null;
  workers: { active: WorkerSummary[]; counts: Record<string, number> };
  questions: { open: { id: string; question: string; material: boolean; affected: string[] }[]; answered: number };
}

interface WorkerSummary {
  id: string;
  role: string;
  provider: string;
  model: string | null;
  state: string;
  spawned_at: number | null;
}

function workerSummary(w: WorkerRecord): WorkerSummary {
  return { id: w.id, role: w.role, provider: w.provider, model: w.model, state: w.state, spawned_at: w.spawnedAt };
}

/**
 * The state, plus the stage an interruption returns to. A BLOCKED run says so only where a resume can clear the block:
 * where it cannot (a frozen policy, an environment block with nothing to approve, every attempt used), "will return to
 * VERIFYING" read as an invitation to resume, and the way forward is a new run (issue #33).
 */
function stageOf(db: OrbitDb, run: RunRecord): string {
  if (!run.resumeState || !(run.state === 'INQUISITION' || run.state === 'BLOCKED' || run.state === 'RECOVERING')) return run.state;
  const fresh = run.state === 'BLOCKED' ? newRunNeeded(db, run) : null;
  return fresh !== null ? `${run.state} (a new run is needed: ${fresh})` : `${run.state} (will return to ${run.resumeState})`;
}

export function buildRunStatus(ctx: Pick<CliContext, 'clock'>, db: OrbitDb, run: RunRecord): RunStatus {
  const now = ctx.clock.now();
  const lease = liveLease(db, run.id, now);
  const ownerRec = lease ? findController(db, lease.ownerId) : null;
  const live = controllers(db, now, { includeStopped: true, limit: 50 });
  const owning = ownerRec ? live.find((c) => c.record.id === ownerRec.id) : undefined;
  // The heartbeat of a run is its owner's. A run nobody owns, but that is still going, has the service that could pick it
  // up; a finished run has none, and another run's foreground controller is never this run's heartbeat.
  const hb = owning ?? (finished(run.state) ? null : (live.find((c) => c.live && c.record.mode === 'service') ?? null));

  let budgets: RunStatus['budgets'] = null;
  if (db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', run.id)) {
    try {
      const snap = new BudgetLedger(db, ctx.clock).attach(run.id, verifySnapshot(run.policyPath, run.policyHash)).snapshot();
      budgets = { counters: snap.counters, sessions: snap.sessions, reserve: snap.reserve, cost_measurement: snap.cost_measurement, verified_policy: true };
    } catch {
      // The snapshot no longer verifies (or is unreadable): show the stored counters and say they are unverified.
      const rows = db.all<{ counter: string; used: number; allowance: number; hard_cap: number }>('SELECT counter, used, allowance, hard_cap FROM budget_counters WHERE run_id = ? ORDER BY counter', run.id);
      const toState = (r: (typeof rows)[number]): CounterState => ({ counter: r.counter, used: r.used, allowance: r.allowance, hard_cap: r.hard_cap, remaining: Math.max(0, r.allowance - r.used) });
      budgets = { counters: rows.filter((r) => !r.counter.includes(':')).map(toState), sessions: rows.filter((r) => r.counter.includes(':')).map(toState), reserve: null, cost_measurement: null, verified_policy: false };
    }
  }

  const workers = listWorkers(db, { runId: run.id });
  const counts: Record<string, number> = {};
  for (const w of workers) counts[w.state] = (counts[w.state] ?? 0) + 1;
  const questions = listQuestions(db, run.id);
  const lastEvent = db.get<{ type: string; ts: number; to_state: string | null }>('SELECT type, ts, to_state FROM events WHERE run_id = ? ORDER BY id DESC LIMIT 1', run.id);

  return {
    id: run.id,
    goal: run.goal,
    mode: run.mode,
    state: run.state,
    stage: stageOf(db, run),
    paused: run.paused,
    cancel_requested: run.cancelRequested,
    outcome_reason: run.outcomeReason,
    branch: createdBranch(db, run),
    candidate_ref: currentCandidateRef(db, run.id),
    difficulty: run.difficulty,
    created_at: run.createdAt,
    started_at: run.startedAt,
    ended_at: run.endedAt,
    last_progress_at: run.lastProgressAt,
    last_event: lastEvent ? { type: lastEvent.type, at: lastEvent.ts, to_state: lastEvent.to_state } : null,
    owner: lease ? { owner_id: lease.ownerId, lease_expires_at: lease.expiresAt } : null,
    heartbeat: hb ? { controller_id: hb.record.id, mode: hb.record.mode, heartbeat_at: hb.record.heartbeatAt, age_ms: hb.age, live: hb.live, last_progress_at: hb.record.lastProgressAt } : null,
    budgets,
    workers: { active: workers.filter((w) => w.state === 'PLANNED' || w.state === 'RUNNING').map(workerSummary), counts },
    questions: {
      open: questions.filter((q) => q.status === 'open').map((q) => ({ id: q.id, question: q.question, material: q.material, affected: q.affected })),
      answered: questions.filter((q) => q.status === 'answered').length,
    },
  };
}

function fmtCounter(c: CounterState): string {
  const cost = c.counter === 'cost_usd';
  const wall = c.counter === 'wall_ms';
  const f = (n: number) => (cost ? `$${n.toFixed(2)}` : wall ? `${(n / 60_000).toFixed(1)}m` : String(n));
  return `${c.counter.padEnd(26)} ${f(c.used)} used / ${f(c.allowance)} allowed (hard cap ${f(c.hard_cap)})`;
}

export function renderRunStatus(s: RunStatus, now: number): string {
  const out: string[] = [];
  // A finished run is not still being cancelled, whatever the request flag says.
  const flags = [s.paused && !finished(s.state) ? 'paused' : '', s.cancel_requested && !finished(s.state) ? 'cancel requested' : ''].filter(Boolean);
  out.push(`run ${s.id}  ${s.state}${flags.length ? `  (${flags.join(', ')})` : ''}`);
  out.push(`goal:      ${flat(s.goal)}`);
  out.push(`mode:      ${s.mode}${s.difficulty ? `   difficulty: ${s.difficulty}` : ''}${s.branch ? `   branch: ${s.branch}` : ''}`);
  if (s.candidate_ref) out.push(`candidate: ${s.candidate_ref}`);
  out.push(`stage:     ${s.stage}`);
  if (s.outcome_reason) out.push(`outcome:   ${flat(s.outcome_reason)}`);
  out.push(`progress:  last progress ${ago(now, s.last_progress_at)}${s.last_event ? `; last event ${s.last_event.type}${s.last_event.to_state ? ` -> ${s.last_event.to_state}` : ''} ${ago(now, s.last_event.at)}` : ''}`);
  if (s.owner) out.push(`owner:     ${s.owner.owner_id} (lease until ${iso(s.owner.lease_expires_at)})`);
  else out.push('owner:     none (no controller currently owns this run)');
  if (s.heartbeat) out.push(`heartbeat: ${s.heartbeat.mode} controller ${s.heartbeat.controller_id} ${ago(now, s.heartbeat.heartbeat_at)} (${s.heartbeat.live ? 'live' : 'STALE'}), last progress ${ago(now, s.heartbeat.last_progress_at)}`);
  else if (!finished(s.state)) out.push('heartbeat: no controller is running (start one with "orbit service run" or "orbit resume <run-id> --foreground")');
  if (s.budgets) {
    out.push(`budgets${s.budgets.verified_policy ? '' : ' (policy snapshot did not verify; stored counters shown)'}:`);
    for (const c of s.budgets.counters) out.push(`  ${fmtCounter(c)}`);
    if (s.budgets.reserve) out.push(`  final reserve: $${s.budgets.reserve.cost_usd.toFixed(2)} and ${(s.budgets.reserve.wall_ms / 60_000).toFixed(1)}m held back`);
    if (s.budgets.cost_measurement) out.push(`  cost: ${s.budgets.cost_measurement.note}`);
  } else out.push('budgets:   not initialized yet (the run has not reached planning)');
  const counts = Object.entries(s.workers.counts).map(([k, v]) => `${v} ${k.toLowerCase()}`).join(', ');
  out.push(`workers:   ${s.workers.active.length} active${counts ? ` (all: ${counts})` : ''}`);
  for (const w of s.workers.active) out.push(`  ${w.id}  ${w.role}  ${w.provider}/${w.model ?? 'default'}  ${w.state}${w.spawned_at ? `  started ${ago(now, w.spawned_at)}` : ''}`);
  out.push(`questions: ${s.questions.open.length} open, ${s.questions.answered} answered`);
  for (const q of s.questions.open) out.push(`  ${q.id}${q.material ? '  [material]' : ''}  ${flat(q.question)}`);
  if (s.questions.open.length > 0) out.push(`  answer with: orbit decide ${s.id} <question-id> <answer>`);
  return `${out.join('\n')}\n`;
}

export async function statusCommand(args: Args, ctx: CliContext): Promise<number> {
  const repo = await resolveRepo(ctx, args.str('repo'));
  const [id] = args.expect(0, 1);
  // Right after "orbit init" there is no state database yet: that is "no runs", not "not initialised".
  if (id === undefined && !existsSync(stateDbPath(repo)) && initialised(repo)) {
    if (args.bool('json')) json(ctx.io, { runs: [], controllers: [] });
    else line(ctx.io, 'no runs yet; start one with: orbit run --goal "..."');
    return EXIT.OK;
  }
  return withState(repo, (db) => {
    // A controller that died without a stop record (Ctrl-C twice, kill -9) is gone, not "stale" for ever.
    pruneDeadControllers(db, ctx.clock);
    const now = ctx.clock.now();
    if (id) {
      const status = buildRunStatus(ctx, db, findRunByPrefix(db, id));
      if (args.bool('json')) json(ctx.io, status);
      else ctx.io.out(renderRunStatus(status, now));
      return EXIT.OK;
    }
    const runs = listRuns(db, { limit: args.bool('all') ? 1000 : 10 });
    const ctrl = controllers(db, now, { includeStopped: false, limit: 10 });
    if (args.bool('json')) {
      json(ctx.io, {
        runs: runs.map((r) => ({ id: r.id, state: r.state, paused: r.paused, cancel_requested: r.cancelRequested, mode: r.mode, goal: r.goal, created_at: r.createdAt, last_progress_at: r.lastProgressAt })),
        controllers: ctrl.map((c) => ({ id: c.record.id, mode: c.record.mode, pid: c.record.pid, heartbeat_at: c.record.heartbeatAt, age_ms: c.age, live: c.live, last_progress_at: c.record.lastProgressAt })),
      });
      return EXIT.OK;
    }
    if (runs.length === 0) line(ctx.io, 'no runs yet; start one with: orbit run --goal "..."');
    else ctx.io.out(table(runs.map((r) => [r.id, r.state + (r.paused && !finished(r.state) ? ' (paused)' : '') + (r.cancelRequested && !finished(r.state) ? ' (cancelling)' : ''), r.mode, ago(now, r.lastProgressAt ?? r.createdAt), oneLine(r.goal, 70)]), ['RUN', 'STATE', 'MODE', 'LAST PROGRESS', 'GOAL']));
    const live = ctrl.filter((c) => c.live);
    line(ctx.io, live.length ? `controllers: ${live.map((c) => `${c.record.mode} pid ${c.record.pid} (heartbeat ${ago(now, c.record.heartbeatAt)})`).join('; ')}` : 'controllers: none running');
    return EXIT.OK;
  });
}

/** Throws unless the run exists; for commands that need only the record. */
export function requireRun(db: OrbitDb, id: string | undefined): RunRecord {
  if (!id) throw new OrbitError('NOT_FOUND', 'a run id is required');
  return findRunByPrefix(db, id);
}
