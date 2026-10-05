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
import { Controller, defaultControllerDeps } from '../../controller/index.ts';
import { getRun, setPaused, type RunRecord } from '../../controller/run-store.ts';
import { isTerminal } from '../../controller/states.ts';
import { listQuestions } from '../../inquisition/store.ts';
import { liveLease, type CliContext } from '../context.ts';
import { EXIT, exitCodeForState } from '../exit.ts';
import { json, line, oneLine } from '../io.ts';

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
  const at = new Date(e.ts).toISOString().slice(11, 19);
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
      return `[${at}] ${e.from_state ?? '-'} -> ${e.to_state ?? '-'}${reason ? `  ${oneLine(reason, 140)}` : ''}`;
    case 'progress':
      return `[${at}] progress: ${typeof data.kind === 'string' ? data.kind : 'recorded'}`;
    case 'decision.recorded':
      return `[${at}] decision recorded: ${typeof data.kind === 'string' ? data.kind : ''}`;
    default:
      return `[${at}] ${e.type}${reason ? `: ${oneLine(reason, 140)}` : ''}`;
  }
}

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
  if (lease) throw new OrbitError('CONCURRENT_UPDATE', `run ${runId} is owned by a live controller (${lease.ownerId}); it is already being worked on. Use "orbit status ${runId}"`, { runId });
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
    ctx.io.err('\ninterrupt: pausing the run (not cancelling it). Workers keep running; continue with: orbit resume ' + runId + '\n');
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

  try {
    await controller.start();
  } finally {
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

function json1(ctx: CliContext, value: unknown): void {
  ctx.io.out(`${JSON.stringify(value)}\n`);
}

function announceEnd(ctx: CliContext, db: OrbitDb, run: RunRecord, exitCode: number, wantJson: boolean): void {
  const open = listQuestions(db, run.id, { status: 'open' });
  if (wantJson) {
    json1(ctx, { type: 'result', run_id: run.id, state: run.state, paused: run.paused, exit_code: exitCode, outcome_reason: run.outcomeReason, open_questions: open.map((q) => q.id) });
    return;
  }
  if (isTerminal(run.state)) {
    line(ctx.io, `run ${run.id} ended ${run.state}${run.outcomeReason ? `: ${oneLine(run.outcomeReason, 300)}` : ''}`);
    line(ctx.io, `report: orbit report ${run.id}`);
    if (run.state === 'BLOCKED') {
      for (const q of open) line(ctx.io, `  open question ${q.id}: ${oneLine(q.question, 140)}`);
      line(ctx.io, open.length > 0 ? `answer with "orbit decide ${run.id} <question-id> <answer>", then "orbit resume ${run.id}"` : `resolve the reason above, then "orbit resume ${run.id}"`);
    }
  } else {
    line(ctx.io, `run ${run.id} is ${run.state}${run.paused ? ' and paused' : ''}; continue with "orbit resume ${run.id}"`);
  }
}
