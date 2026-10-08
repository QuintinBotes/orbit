/**
 * Running a controller in the foreground for one run: `orbit run --foreground`
 * and `orbit resume --foreground`. It streams the run's durable events as
 * they appear, and treats Ctrl-C as a pause rather than a cancellation: the
 * run's workers are detached and keep going, the run is marked paused so no
 * controller restarts work on it, and `orbit resume` continues it.
 */
import { OrbitError } from '../../core/errors.ts';
import type { OrbitDb } from '../../storage/db.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import { Controller, buildFinalReport, defaultControllerDeps } from '../../controller/index.ts';
import { getRun, setPaused, type RunRecord } from '../../controller/run-store.ts';
import { missingTargetChecks, newRunNeeded } from '../../controller/resume.ts';
import { isTerminal } from '../../controller/states.ts';
import { listQuestions } from '../../inquisition/store.ts';
import { continueCommand, expireLeaseOfDeadOwner, liveLease, type CliContext } from '../context.ts';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hostname } from 'node:os';
import { isAlive } from '../../core/proc.ts';
import { findController } from '../../storage/controllers.ts';
import type { Lease } from '../../controller/run-store.ts';
import { EXIT, exitCodeForState } from '../exit.ts';
import { flat, json, line, clockTime, holdThroughClosedPipe } from '../io.ts';

interface EventRow {
  id: number;
  ts: number;
  type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string;
  data_json: string | null;
}

/** Events that say nothing a person watching a run needs. */
const QUIET = /^(lease\.|budget\.)/;

export function formatEvent(e: EventRow): string {
  const at = clockTime(e.ts);
  let data: Record<string, unknown> = {};
  try {
    // An event recorded without data is stored as the JSON text "null".
    const parsed: unknown = e.data_json ? JSON.parse(e.data_json) : null;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    data = {};
  }
  const reason = typeof data.reason === 'string' ? data.reason : '';
  switch (e.type) {
    case 'state.transition':
      return `[${at}] ${e.from_state ?? '-'} -> ${e.to_state ?? '-'}${reason ? `  ${flat(reason)}` : ''}`;
    case 'progress':
      return `[${at}] progress: ${typeof data.kind === 'string' ? data.kind : 'recorded'}`;
    case 'decision.recorded':
      return `[${at}] decision recorded: ${typeof data.kind === 'string' ? data.kind : ''}`;
    default:
      return `[${at}] ${e.type}${reason ? `: ${flat(reason)}` : ''}`;
  }
}

export { expireLeaseOfDeadOwner };

export interface DriveOptions {
  repoRoot: string;
  config: OrbitConfig;
  db: OrbitDb;
  runId: string;
  /** One JSON object per line instead of text. */
  json: boolean;
  /** Print events from the beginning of the run (a new run) or only what happens from now on (a resume). */
  fromStart: boolean;
}

export interface DriveResult {
  run: RunRecord;
  interrupted: boolean;
  exitCode: number;
}

export async function driveForeground(ctx: CliContext, opts: DriveOptions): Promise<DriveResult> {
  const { db, runId } = opts;
  const lease = liveLease(db, runId, ctx.clock.now());
  if (lease) {
    // A controller killed on this host (kill -9) leaves a lease that has not expired yet; its process is gone, so the
    // lease is stale and is expired here for the new controller to take over (recorded as a lease takeover).
    if (!expireLeaseOfDeadOwner(db, lease, ctx.clock.now())) {
      throw new OrbitError('CONCURRENT_UPDATE', `run ${runId} is owned by a live controller (${lease.ownerId}); it is already being worked on. Use "orbit status ${runId}"`, { runId });
    }
  }
  const before = getRun(db, runId);
  if (before.paused) throw new OrbitError('TRANSITION_INVALID', `run ${runId} is paused; run "orbit resume ${runId}" first`);

  const factory = ctx.seams.controllerDeps ?? defaultControllerDeps;
  const deps = factory({ repoRoot: opts.repoRoot, db, clock: ctx.clock, config: opts.config, env: ctx.env, orbitHome: ctx.orbitHome });
  const controller = new Controller({
    deps,
    mode: 'foreground',
    runId,
    handleSignals: false,
    ...(ctx.seams.controller ?? {}),
  });

  const wantJson = opts.json;
  const pollMs = ctx.seams.pollMs ?? 500;
  let cursor = opts.fromStart ? 0 : (db.get<{ id: number | null }>('SELECT MAX(id) AS id FROM events WHERE run_id = ?', runId)?.id ?? 0);
  const emit = (): void => {
    for (;;) {
      const rows = db.all<EventRow>('SELECT id, ts, type, from_state, to_state, actor, data_json FROM events WHERE run_id = ? AND id > ? ORDER BY id LIMIT 200', runId, cursor);
      if (rows.length === 0) return;
      for (const e of rows) {
        cursor = e.id;
        if (QUIET.test(e.type)) continue;
        if (wantJson) json1(ctx, { type: 'event', event: e.type, at: e.ts, from_state: e.from_state, to_state: e.to_state });
        else line(ctx.io, formatEvent(e));
      }
    }
  };

  let interrupted = false;
  let stoppedForPause = false;
  const signals = ctx.seams.signals ?? process;
  const onInterrupt = (): void => {
    if (interrupted) {
      ctx.io.err('second interrupt: exiting now; the run stays paused\n');
      (ctx.seams.exit ?? process.exit)(EXIT.PAUSED);
      return;
    }
    interrupted = true;
    ctx.io.err(`\ninterrupt: pausing the run (not cancelling it). Workers keep running; continue with: ${safeContinue(db, runId, ctx)}\n`);
    try {
      setPaused(db, runId, true, `cli:${ctx.user}`, ctx.clock);
    } catch (err) {
      ctx.io.err(`could not record the pause: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    void controller.stop('paused by Ctrl-C');
  };
  const onTerm = (): void => {
    void controller.stop('received SIGTERM');
  };
  signals.on('SIGINT', onInterrupt);
  signals.on('SIGTERM', onTerm);

  const timer = setInterval(() => {
    try {
      emit();
      const r = getRun(db, runId);
      // Paused from another terminal: the controller drops the run and would idle forever, so end the foreground session.
      if (r.paused && !isTerminal(r.state) && !stoppedForPause) {
        stoppedForPause = true;
        void controller.stop('run paused');
      }
    } catch {
      /* the database is busy; the next poll catches up */
    }
  }, pollMs);

  // A reader that goes away (`| head -2`) must not end the process that is driving the run.
  const releasePipeHold = holdThroughClosedPipe();
  try {
    await controller.start();
  } finally {
    releasePipeHold();
    clearInterval(timer);
    signals.off('SIGINT', onInterrupt);
    signals.off('SIGTERM', onTerm);
  }
  emit();
  const run = getRun(db, runId);
  let exitCode: number;
  if (isTerminal(run.state)) exitCode = exitCodeForState(run.state);
  else if (run.paused || interrupted) exitCode = EXIT.PAUSED;
  else exitCode = EXIT.FAILURE;
  announceEnd(ctx, db, run, exitCode, wantJson);
  return { run, interrupted: interrupted || run.paused, exitCode };
}

/** The command that continues the run, as it is right now: with no service a plain resume would leave the run idle. */
function safeContinue(db: OrbitDb, runId: string, ctx: CliContext): string {
  try {
    return continueCommand(db, runId, ctx.clock.now());
  } catch {
    return `orbit resume ${runId} --foreground`;
  }
}

/** Why a resume cannot clear the run's block (controller/resume.ts newRunNeeded), or null; never throws, since this ends a command that already ran. */
function safeNewRunNeeded(db: OrbitDb, run: RunRecord): string | null {
  try {
    return newRunNeeded(db, run);
  } catch {
    return null;
  }
}

interface RunResult {
  branch: string | null;
  candidate_commit: string | null;
  delivered_commit: string | null;
  pull_request: { number: number; url: string | null } | null;
}

/** What the run left behind (the final report's revision section), or null when it cannot be read. */
function resultOf(ctx: CliContext, db: OrbitDb, run: RunRecord): RunResult | null {
  try {
    const finalJson = join(dirname(run.policyPath), 'final.json');
    const report = existsSync(finalJson) ? (JSON.parse(readFileSync(finalJson, 'utf8')) as { revision?: Record<string, unknown> }) : buildFinalReport(db, run, { runDir: dirname(run.policyPath), clock: ctx.clock, snapshot: null });
    const rv = (report as { revision?: { branch?: string | null; candidate?: string | null; delivered_commit?: string | null; pull_request?: { number: number; url: string | null } | null } }).revision;
    if (!rv) return null;
    return { branch: rv.branch ?? null, candidate_commit: rv.candidate ?? null, delivered_commit: rv.delivered_commit ?? null, pull_request: rv.pull_request ?? null };
  } catch {
    return null;
  }
}

/** The footer line that says where the work is: a pull request, a delivered commit, or a local branch (never called "delivered"). */
function resultLine(r: RunResult): string | null {
  const sha = (c: string | null): string => (c ?? '').slice(0, 12);
  const branch = r.branch ? `branch ${r.branch}` : 'no branch';
  if (r.pull_request) return `result: pull request #${r.pull_request.number}${r.pull_request.url ? ` ${r.pull_request.url}` : ''} (${branch}${r.delivered_commit ? ` at ${sha(r.delivered_commit)}` : ''})`;
  if (r.delivered_commit) return `result: ${branch} at ${sha(r.delivered_commit)} (delivered)`;
  if (r.candidate_commit) return `result: ${branch} at ${sha(r.candidate_commit)} (local, not delivered)`;
  return null;
}

function json1(ctx: CliContext, value: unknown): void {
  ctx.io.out(`${JSON.stringify(value)}\n`);
}

function announceEnd(ctx: CliContext, db: OrbitDb, run: RunRecord, exitCode: number, wantJson: boolean): void {
  const open = listQuestions(db, run.id, { status: 'open' });
  if (wantJson) {
    json1(ctx, { type: 'result', run_id: run.id, state: run.state, paused: run.paused, exit_code: exitCode, outcome_reason: run.outcomeReason, open_questions: open.map((q) => q.id), ...(run.state === 'SUCCEEDED' ? { result: resultOf(ctx, db, run) } : {}) });
    return;
  }
  if (isTerminal(run.state)) {
    line(ctx.io, `run ${run.id} ended ${run.state}${run.outcomeReason ? `: ${flat(run.outcomeReason)}` : ''}`);
    // Only an accepted run has a result: a candidate of a blocked or exhausted run was not accepted.
    const left = run.state === 'SUCCEEDED' ? resultOf(ctx, db, run) : null;
    const where = left ? resultLine(left) : null;
    if (where) line(ctx.io, where);
    line(ctx.io, `report: orbit report ${run.id}`);
    if (run.state === 'BLOCKED') {
      for (const q of open) line(ctx.io, `  open question ${q.id}: ${flat(q.question)}`);
      const frozen = /"frozen_policy"/.test(run.outcomeJson ?? '');
      const next = safeContinue(db, run.id, ctx);
      // Where a resume cannot clear the block (a frozen policy, an environment block with nothing to approve, every
      // implementation attempt used), no answer to an open question makes "then resume" the way forward (issue #33).
      const fresh = safeNewRunNeeded(db, run);
      if (open.length > 0 && fresh === null) line(ctx.io, `answer with "orbit decide ${run.id} <question-id> <answer>", then "${next}"`);
      // A missing target the contract does not name has three causes and a fix of the config is only one of them: the reason above ends with the advice by cause.
      else if (frozen && missingTargetChecks(run).length > 0) line(ctx.io, `the advice above says what to do by cause; resuming would only block again, so "orbit cancel ${run.id}" and start a new run with "orbit run"`);
      else if (frozen) line(ctx.io, `this block comes from the run's frozen policy: fix .orbit/config.yaml, then "orbit cancel ${run.id}" and start a new run with "orbit run"`);
      else if (fresh !== null) line(ctx.io, `resuming would only block again (${fresh}): fix it, then "orbit cancel ${run.id}" and start a new run with "orbit run"`);
      else line(ctx.io, `resolve the reason above, then "${next}"`);
    }
  } else {
    line(ctx.io, `run ${run.id} is ${run.state}${run.paused ? ' and paused' : ''}; continue with "${safeContinue(db, run.id, ctx)}"`);
  }
}
