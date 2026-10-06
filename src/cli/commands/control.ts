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
import { sharedCatalogPath } from '../../routing/shared-catalog.ts';
import { createLogger } from '../../core/log.ts';
import { join, resolve } from 'node:path';
import { defaultControllerDeps, orbitInstallDir } from '../../controller/index.ts';
import { lenientContext, loadRunContext, type ControllerDeps } from '../../controller/context.ts';
import { finishRun, frozenPolicyForceHelps } from '../../controller/steps/common.ts';
import { getRun, requestCancel, setPaused, transition, type RunRecord } from '../../controller/run-store.ts';
import { isTerminal } from '../../controller/states.ts';
import { missingTargetAdvice } from '../../controller/environment-block.ts';
import { frozenPolicySetting, missingTargetChecks, resumeTarget } from '../../controller/resume.ts';
import { listQuestions } from '../../inquisition/store.ts';
import type { Args, OptionSpec } from '../args.ts';
import { continueCommand, findRunByPrefix, liveControllerFor, expireLeaseOfDeadOwner, liveLease, liveServiceController, openState, resolveRepo, withCliLease, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, line } from '../io.ts';
import { driveForeground } from './drive.ts';
import { readRemoteAnswers } from './notify.ts';

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
      line(ctx.io, `Continue with: ${continueCommand(db, after.id, ctx.clock.now())}`);
    }
    return EXIT.OK;
  });
}

export const RESUME_OPTIONS: OptionSpec = {
  foreground: { type: 'boolean', description: 'drive the run in this terminal instead of leaving it to the service' },
  detach: { type: 'boolean', description: 'leave the run to the service (the default; it says so when no service is running)' },
  force: { type: 'boolean', description: 'resume a BLOCKED run even though material questions are still open' },
  policy: { type: 'string', description: 'policy file for the foreground controller (default: .orbit/config.yaml)', valueName: 'path' },
};

export async function resumeCommand(args: Args, ctx: CliContext): Promise<number> {
  if (args.bool('foreground') && args.bool('detach')) throw new UsageError('--foreground and --detach cannot be combined', 'orbit resume <run-id> [--foreground | --detach] [--force]');
  const [id] = args.expect(1);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const db = openState(repo);
  try {
    const run = findRunByPrefix(db, id!);
    if (run.cancelRequested && run.state !== 'CANCELLED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} has a durable cancellation request and will end CANCELLED; it cannot be resumed`);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is ${run.state}; nothing to resume. ${nextStepAfter(run)}`);

    const notes: string[] = [];
    if (run.state === 'BLOCKED') {
      // Answers given as pull request or issue comments are taken first, by the rules of ADR 0008.
      await readRemoteAnswers(ctx, db, run, (text) => {
        if (!args.bool('json')) line(ctx.io, text);
      });
      const frozen = frozenPolicySetting(run);
      if (frozen !== null && !args.bool('force')) {
        // A missing target the contract does not name is a frozen-policy block whose cause is often not the config (the goal
        // should create the target, or a tool is not installed yet): it brings its advice by cause, and a new run in every case.
        const missing = missingTargetChecks(run);
        throw new OrbitError(
          'TRANSITION_INVALID',
          missing.length > 0
            ? `run ${run.id} is BLOCKED on a missing target the contract does not name (${frozen}). ${missingTargetAdvice({ runId: run.id, checks: missing })}`
            : `run ${run.id} is BLOCKED by its frozen policy (${frozen}); a run keeps the policy it started with, so resuming would block again. Fix .orbit/config.yaml, cancel this run (orbit cancel ${run.id}) and start a new run with orbit run${frozenPolicyForceHelps(frozen) ? '. If what you fixed is outside the policy (for example orbit models refresh), pass --force' : ''}`,
          { frozen_policy: frozen },
        );
      }
      const open = listQuestions(db, run.id, { status: 'open' }).filter((q) => q.material);
      if (open.length > 0 && !args.bool('force')) {
        throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is BLOCKED with ${open.length} material question(s) still open (${open.map((q) => q.id).join(', ')}); answer them with "orbit decide ${run.id} <question-id> <answer>", or pass --force to resume without an answer`, { open: open.map((q) => q.id) });
      }
    }

    // Resuming only clears a flag or a block: a controller has to carry the run on, and without one the run would sit
    // idle behind a success message. Decided before anything is changed, so a refusal leaves the run exactly as it was.
    let foreground = args.bool('foreground');
    const note = (text: string): void => {
      if (!args.bool('json')) line(ctx.io, text);
    };
    if (!foreground && !args.bool('detach') && liveControllerFor(db, run.id, ctx.clock.now()) === null) {
      if (!ctx.io.stdoutIsTty) {
        throw new OrbitError(
          'PROVIDER_UNAVAILABLE',
          `no controller is running, so resuming run ${run.id} would only clear its ${run.state === 'BLOCKED' ? 'block' : 'pause'} and leave it idle. Drive it in this terminal with: orbit resume ${run.id} --foreground. Or start a service ("orbit service install"), then resume. With --detach the run is released to a service you start later`,
          { runId: run.id },
        );
      }
      foreground = true;
      note('no service is running, so driving it here ("orbit service install" keeps runs going in the background)');
    }

    if (run.state === 'BLOCKED') {
      const target = resumeTarget(db, run);
      const open = listQuestions(db, run.id, { status: 'open' }).filter((q) => q.material);
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
    // A run that was never started is not "already running": say what it is waiting for.
    if (notes.length === 0) notes.push(after.state === 'CREATED' ? 'created but not started; a controller picks it up' : 'already running; nothing to change');

    if (foreground) {
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
      if (!service) line(ctx.io, `No service is running, so nothing continues this run until one is started ("orbit service install"). To drive it here instead: orbit resume ${after.id} --foreground`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

/** What to do about a run that cannot be resumed because it has ended, by the way it ended. */
function nextStepAfter(run: RunRecord): string {
  const report = `See what happened with "orbit report ${run.id}"`;
  switch (run.state) {
    case 'SUCCEEDED':
      return `${report}; the work is done. For more, start a new run with: orbit run --goal "..."`;
    case 'CANCELLED':
      return `A cancelled run stays cancelled. ${report}, or start a new run with: orbit run --goal "..."`;
    default:
      return `${report}, fix what stopped it, then start a new run with: orbit run --goal "..." (orbit repair "<failure>" starts one for a failure)`;
  }
}

export const CANCEL_OPTIONS: OptionSpec = {
  wait: { type: 'string', description: 'seconds to wait for a live controller to finish the cancellation', valueName: 'seconds' },
};

/**
 * Collaborators for a command that works on a run this process owns under a CLI lease (cancel, verify, repair): the configured
 * adapters when the policy loads, otherwise none (enough for a BLOCKED run, whose workers are already stopped).
 */
export function cliLeaseDeps(ctx: CliContext, repo: string, db: OrbitDb, ownerId: string): ControllerDeps {
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
      registry: new ModelRegistry(db, ctx.clock).useSharedCatalog(sharedCatalogPath(ctx.orbitHome)),
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
      // The state in brackets, unless the words already say it ("cancelled", "already SUCCEEDED").
      else line(ctx.io, `run ${r.id}: ${new RegExp(`\\b${r.state}\\b`, 'i').test(how) ? how : `${how} (${r.state})`}`);
      return EXIT.OK;
    };
    if (isTerminal(found.state) && found.state !== 'BLOCKED') return emit(found, `already ${found.state}; nothing to cancel`);

    // The request is durable first: from here no controller can move this run anywhere but CANCELLED.
    const requested = requestCancel(db, found.id, actorOf(ctx), ctx.clock);
    // A controller killed on this host leaves a lease that has not expired; its process is gone, so nobody owns the run.
    let owned = liveLease(db, found.id, ctx.clock.now());
    if (owned && expireLeaseOfDeadOwner(db, owned, ctx.clock.now())) owned = null;
    if (owned) {
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
        const deps = cliLeaseDeps(ctx, repo, db, ownerId);
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
