/**
 * pause, resume and cancel. All three are durable requests in the state
 * database, so they hold across terminal closes and controller restarts, and
 * they work from any process. Where a run has no owner (BLOCKED runs above
 * all) the CLI takes a short lease itself to make the change.
 */
import { OrbitError } from '../../core/errors.ts';
import { loadConfig } from '../../policy/index.ts';
import { appendEvent } from '../../storage/events.ts';
import type { OrbitDb } from '../../storage/db.ts';
import { ModelRegistry } from '../../routing/registry.ts';
import { createLogger } from '../../core/log.ts';
import { join, resolve } from 'node:path';
import { defaultControllerDeps, orbitInstallDir } from '../../controller/index.ts';
import { lenientContext, loadRunContext, type ControllerDeps } from '../../controller/context.ts';
import { finishRun } from '../../controller/steps/common.ts';
import { getRun, requestCancel, setPaused, transition, type RunRecord } from '../../controller/run-store.ts';
import { canTransition, isTerminal, type RunState } from '../../controller/states.ts';
import { listQuestions } from '../../inquisition/store.ts';
import type { Args, OptionSpec } from '../args.ts';
import { findRunByPrefix, liveLease, liveServiceController, openState, resolveRepo, withCliLease, withState, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { json, line } from '../io.ts';
import { driveForeground } from './drive.ts';

const actorOf = (ctx: CliContext) => `cli:${ctx.user}`;

export async function pauseCommand(args: Args, ctx: CliContext): Promise<number> {
  const [id] = args.expect(1);
  const repo = await resolveRepo(ctx, args.str('repo'));
  return withState(repo, (db) => {
    const run = findRunByPrefix(db, id!);
    const after = setPaused(db, run.id, true, actorOf(ctx), ctx.clock);
    if (args.bool('json')) json(ctx.io, { run_id: after.id, state: after.state, paused: after.paused });
    else {
      line(ctx.io, `run ${after.id} paused at ${after.state}`);
      line(ctx.io, 'The controller stops working on it at its next safe point; running workers are not killed and are collected on resume.');
      line(ctx.io, `Continue with: orbit resume ${after.id}`);
    }
    return EXIT.OK;
  });
}

export const RESUME_OPTIONS: OptionSpec = {
  foreground: { type: 'boolean', description: 'drive the run in this terminal instead of leaving it to the service' },
  force: { type: 'boolean', description: 'resume a BLOCKED run even though material questions are still open' },
  policy: { type: 'string', description: 'policy file for the foreground controller (default: .orbit/config.yaml)', valueName: 'path' },
};

/** Where a blocked run goes back to: the stage it stopped in, or the earliest stage its durable state supports. */
function resumeTarget(db: OrbitDb, run: RunRecord): RunState {
  const prior = run.resumeState;
  if (prior && canTransition('BLOCKED', prior)) return prior;
  if (db.get('SELECT 1 AS x FROM candidates WHERE run_id = ? LIMIT 1', run.id)) return 'VERIFYING';
  return run.contractJson ? 'PLANNING' : 'PREFLIGHT';
}

export async function resumeCommand(args: Args, ctx: CliContext): Promise<number> {
  const [id] = args.expect(1);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const db = openState(repo);
  try {
    const run = findRunByPrefix(db, id!);
    if (run.cancelRequested && run.state !== 'CANCELLED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} has a durable cancellation request and will end CANCELLED; it cannot be resumed`);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is ${run.state}; nothing to resume`);

    const notes: string[] = [];
    if (run.state === 'BLOCKED') {
      const open = listQuestions(db, run.id, { status: 'open' }).filter((q) => q.material);
      if (open.length > 0 && !args.bool('force')) {
        throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is BLOCKED with ${open.length} material question(s) still open (${open.map((q) => q.id).join(', ')}); answer them with "orbit decide ${run.id} <question-id> <answer>", or pass --force to resume without an answer`, { open: open.map((q) => q.id) });
      }
      const target = resumeTarget(db, run);
      await withCliLease(ctx, db, run.id, (ownerId) => {
        db.tx(() => {
          transition(db, { runId: run.id, to: target, ownerId, reason: `resumed by ${ctx.user} after a decision or environment repair`, actor: actorOf(ctx), expectedFrom: 'BLOCKED' }, ctx.clock);
          appendEvent(db, run.id, 'run.resumed', actorOf(ctx), { from: 'BLOCKED', to: target, forced: open.length > 0 }, ctx.clock.now());
        });
      });
      notes.push(`resumed BLOCKED run at ${target}`);
    }
    if (getRun(db, run.id).paused) {
      setPaused(db, run.id, false, actorOf(ctx), ctx.clock);
      notes.push('unpaused');
    }
    const after = getRun(db, run.id);
    if (notes.length === 0) notes.push('already running; nothing to change');

    if (args.bool('foreground')) {
      if (!args.bool('json')) line(ctx.io, `run ${after.id}: ${notes.join(', ')}; driving it in the foreground (Ctrl-C pauses it)`);
      const policy = args.str('policy');
      const config = loadConfig(repo, policy ? resolve(ctx.cwd, policy) : undefined);
      const result = await driveForeground(ctx, { repoRoot: repo, config, db, runId: after.id, fromStart: false, json: args.bool('json') });
      return result.exitCode;
    }
    const service = liveServiceController(db, ctx.clock.now());
    if (args.bool('json')) json(ctx.io, { run_id: after.id, state: after.state, paused: after.paused, actions: notes, service_running: service !== null });
    else {
      line(ctx.io, `run ${after.id}: ${notes.join(', ')} (${after.state})`);
      if (!service) line(ctx.io, `No controller is running. Start one with "orbit service run", or drive this run here with: orbit resume ${after.id} --foreground`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

export const CANCEL_OPTIONS: OptionSpec = {
  wait: { type: 'string', description: 'seconds to wait for a live controller to finish the cancellation', valueName: 'seconds' },
};

/** Collaborators for ending a run this process owns: the configured adapters when the policy loads, otherwise none (enough for a BLOCKED run, whose workers are already stopped). */
function cancelDeps(ctx: CliContext, repo: string, db: OrbitDb, ownerId: string): ControllerDeps {
  try {
    const factory = ctx.seams.controllerDeps ?? defaultControllerDeps;
    return { ...factory({ repoRoot: repo, db, clock: ctx.clock, config: loadConfig(repo), env: ctx.env, orbitHome: ctx.orbitHome }), ownerId };
  } catch {
    return {
      db,
      clock: ctx.clock,
      ownerId,
      logger: createLogger({ file: join(ctx.orbitHome, 'logs', 'controller.jsonl'), clock: ctx.clock }),
      adapters: {},
      registry: new ModelRegistry(db, ctx.clock),
      orbitHome: ctx.orbitHome,
      hostEnv: ctx.env,
      orbitInstallDir: orbitInstallDir(),
    };
  }
}

export async function cancelCommand(args: Args, ctx: CliContext): Promise<number> {
  const [id] = args.expect(1);
  const waitS = args.int('wait') ?? 0;
  const repo = await resolveRepo(ctx, args.str('repo'));
  const db = openState(repo);
  try {
    const found = findRunByPrefix(db, id!);
    const emit = (r: RunRecord, how: string): number => {
      if (args.bool('json')) json(ctx.io, { run_id: r.id, state: r.state, cancel_requested: r.cancelRequested, how });
      else line(ctx.io, `run ${r.id}: ${how} (${r.state})`);
      return EXIT.OK;
    };
    if (isTerminal(found.state) && found.state !== 'BLOCKED') return emit(found, `already ${found.state}; nothing to cancel`);

    // The request is durable first: from here no controller can move this run anywhere but CANCELLED.
    const requested = requestCancel(db, found.id, actorOf(ctx), ctx.clock);
    if (liveLease(db, found.id, ctx.clock.now())) {
      if (waitS > 0) {
        const deadline = ctx.clock.now() + waitS * 1000;
        while (ctx.clock.now() < deadline && !isTerminal(getRun(db, found.id).state)) await new Promise((r) => setTimeout(r, ctx.seams.pollMs ?? 250));
      }
      const now = getRun(db, found.id);
      return emit(now, isTerminal(now.state) ? 'cancelled' : 'cancellation recorded; the controller that owns the run ends it at its next safe point');
    }

    // Nobody owns it (a BLOCKED run, or a run whose controller is gone): take a short lease and finish the job here.
    try {
      await withCliLease(ctx, db, found.id, async (ownerId) => {
        const deps = cancelDeps(ctx, repo, db, ownerId);
        const ac = new AbortController();
        let rc;
        try {
          rc = loadRunContext(deps, found.id, ac.signal);
        } catch {
          // A policy or contract that no longer verifies authorizes nothing, but the run can still be ended.
          rc = lenientContext(deps, found.id, ac.signal);
        }
        await finishRun(rc, 'CANCELLED', `cancelled by ${ctx.user} (orbit cancel)`);
      });
    } catch (err) {
      if (err instanceof OrbitError && err.code === 'CONCURRENT_UPDATE') return emit(getRun(db, found.id), 'cancellation recorded; a controller took the run just now and will end it');
      throw err;
    }
    const done = getRun(db, found.id);
    return emit(done, requested.state === 'BLOCKED' ? 'cancelled (the run was blocked and unowned)' : 'cancelled');
  } finally {
    db.close();
  }
}
