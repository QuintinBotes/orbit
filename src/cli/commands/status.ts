/**
 * `orbit status [run-id]`: where a run is, what it has spent, who is working
 * on it and what it is waiting for. Everything comes from durable state, so
 * it is the same answer whether a controller is running or not.
 */
import { OrbitError } from '../../core/errors.ts';
import type { OrbitDb } from '../../storage/db.ts';
import { findController } from '../../storage/controllers.ts';
import { listWorkers, type WorkerRecord } from '../../storage/workers.ts';
import { listRuns, type RunRecord } from '../../controller/run-store.ts';
import { verifySnapshot } from '../../policy/snapshot.ts';
import { BudgetLedger } from '../../scheduling/budget.ts';
import type { CostMeasurement, CounterState, ReserveState } from '../../scheduling/types.ts';
import { listQuestions } from '../../inquisition/store.ts';
import type { Args, OptionSpec } from '../args.ts';
import { controllers, findRunByPrefix, liveLease, resolveRepo, withState, type CliContext } from '../context.ts';
import { ago, iso, json, line, oneLine, table } from '../io.ts';
import { EXIT } from '../exit.ts';

export const STATUS_OPTIONS: OptionSpec = {
  all: { type: 'boolean', description: 'list every run, not just the 10 most recent' },
};

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
  branch: string | null;
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

export function buildRunStatus(ctx: Pick<CliContext, 'clock'>, db: OrbitDb, run: RunRecord): RunStatus {
  const now = ctx.clock.now();
  const lease = liveLease(db, run.id, now);
  const ownerRec = lease ? findController(db, lease.ownerId) : null;
  const live = controllers(db, now, { includeStopped: true, limit: 50 });
  const owning = ownerRec ? live.find((c) => c.record.id === ownerRec.id) : undefined;
  // A run nobody owns still has a heartbeat worth showing: the controller that could pick it up.
  const hb = owning ?? live.find((c) => c.live) ?? null;

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
    stage: run.resumeState && (run.state === 'INQUISITION' || run.state === 'BLOCKED' || run.state === 'RECOVERING') ? `${run.state} (will return to ${run.resumeState})` : run.state,
    paused: run.paused,
    cancel_requested: run.cancelRequested,
    outcome_reason: run.outcomeReason,
    branch: run.branch,
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
  const flags = [s.paused ? 'paused' : '', s.cancel_requested ? 'cancel requested' : ''].filter(Boolean);
  out.push(`run ${s.id}  ${s.state}${flags.length ? `  (${flags.join(', ')})` : ''}`);
  out.push(`goal:      ${oneLine(s.goal, 200)}`);
  out.push(`mode:      ${s.mode}${s.difficulty ? `   difficulty: ${s.difficulty}` : ''}${s.branch ? `   branch: ${s.branch}` : ''}`);
  out.push(`stage:     ${s.stage}`);
  if (s.outcome_reason) out.push(`outcome:   ${oneLine(s.outcome_reason, 300)}`);
  out.push(`progress:  last progress ${ago(now, s.last_progress_at)}${s.last_event ? `; last event ${s.last_event.type}${s.last_event.to_state ? ` -> ${s.last_event.to_state}` : ''} ${ago(now, s.last_event.at)}` : ''}`);
  if (s.owner) out.push(`owner:     ${s.owner.owner_id} (lease until ${iso(s.owner.lease_expires_at)})`);
  else out.push('owner:     none (no controller currently owns this run)');
  if (s.heartbeat) out.push(`heartbeat: ${s.heartbeat.mode} controller ${s.heartbeat.controller_id} ${ago(now, s.heartbeat.heartbeat_at)} (${s.heartbeat.live ? 'live' : 'STALE'}), last progress ${ago(now, s.heartbeat.last_progress_at)}`);
  else out.push('heartbeat: no controller is running (start one with "orbit service run" or "orbit resume <run-id> --foreground")');
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
  for (const q of s.questions.open) out.push(`  ${q.id}${q.material ? '  [material]' : ''}  ${oneLine(q.question, 140)}`);
  if (s.questions.open.length > 0) out.push(`  answer with: orbit decide ${s.id} <question-id> <answer>`);
  return `${out.join('\n')}\n`;
}

export async function statusCommand(args: Args, ctx: CliContext): Promise<number> {
  const repo = await resolveRepo(ctx, args.str('repo'));
  const [id] = args.expect(0, 1);
  return withState(repo, (db) => {
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
    else ctx.io.out(table(runs.map((r) => [r.id, r.state + (r.paused ? ' (paused)' : '') + (r.cancelRequested ? ' (cancelling)' : ''), r.mode, ago(now, r.lastProgressAt ?? r.createdAt), oneLine(r.goal, 70)]), ['RUN', 'STATE', 'MODE', 'LAST PROGRESS', 'GOAL']));
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
