/**
 * `orbit repair <run-id | failure text | ->` ("-" reads either from stdin).
 *
 * With a run id: the run's latest evidence must say FAIL and the run must be
 * BLOCKED or paused. The CLI takes a short lease, moves the run to DIAGNOSING
 * (the controller then writes the repair brief and repairs), unpauses it, and
 * hands off exactly as `orbit resume` does. With anything else it is
 * `orbit run --goal "Repair: <text>"`. A run id that does not qualify is
 * refused with the reason; it is never turned into a goal by accident.
 */
import { resolve } from 'node:path';
import { OrbitError } from '../../core/errors.ts';
import { loadConfig } from '../../policy/index.ts';
import { appendEvent } from '../../storage/events.ts';
import { getRun, setPaused, transition, type RunRecord } from '../../controller/run-store.ts';
import { currentCandidate } from '../../controller/context.ts';
import { ATTEMPT_EVENT } from '../../controller/steps/implementing.ts';
import { canTransition, isTerminal } from '../../controller/states.ts';
import { currentEvidenceReport, listFailures } from '../../evidence/store.ts';
import { listQuestions } from '../../inquisition/store.ts';
import { parseCommand, type Args, type OptionSpec } from '../args.ts';
import { findRunByPrefix, liveServiceController, openState, resolveRepo, withCliLease, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, line, oneLine } from '../io.ts';
import { driveForeground } from './drive.ts';
import { RUN_OPTIONS, runCommand } from './run.ts';

// A repair does not pick a release environment, so repair has no --environment option.
const { goal: _goal, environment: _environment, ...RUN_OPTIONS_WITHOUT_GOAL } = RUN_OPTIONS;

export const REPAIR_OPTIONS: OptionSpec = {
  ...RUN_OPTIONS_WITHOUT_GOAL,
  foreground: { type: 'boolean', description: 'drive the repair in this terminal instead of leaving it to the service' },
  policy: { type: 'string', description: 'policy file for the foreground controller or the new run (default: .orbit/config.yaml)', valueName: 'path' },
};

const USAGE = 'orbit repair <run-id | failure description | -> [--foreground | --detach] [--mode <mode>] [--policy <path>]';
const RUN_ID = /^orb-[A-Za-z0-9-]+$/;

/** The options `repair` forwards to `orbit run` when it is given a description instead of a run. */
function runArgv(args: Args, goal: string): string[] {
  const argv = ['--goal', goal];
  for (const name of ['repo', 'mode', 'policy']) {
    const v = args.str(name);
    if (v !== undefined) argv.push(`--${name}`, v);
  }
  for (const name of ['foreground', 'detach', 'json']) if (args.bool(name)) argv.push(`--${name}`);
  return argv;
}

export async function repairCommand(args: Args, ctx: CliContext): Promise<number> {
  let words = args.positionals;
  // "-": the run id or the description comes on stdin, so free text never passes through a shell (the plugin skills).
  if (words.length === 1 && words[0] === '-') {
    const text = (await ctx.io.readStdin()).trim();
    if (!text) throw new UsageError('a run id or a description of the failure is required on stdin', USAGE);
    words = [text];
  }
  if (words.length === 0) throw new UsageError('a run id or a description of the failure is required', USAGE);
  const first = words[0]!;
  if (!RUN_ID.test(first)) {
    const text = words.join(' ').trim();
    return runCommand(parseCommand(runArgv(args, `Repair: ${text}`), RUN_OPTIONS, USAGE), ctx);
  }
  if (words.length > 1) throw new UsageError('pass either one run id or a description of the failure, not both', USAGE);

  const repo = await resolveRepo(ctx, args.str('repo'));
  const db = openState(repo);
  try {
    const run = findRunByPrefix(db, first);
    if (run.cancelRequested) throw new OrbitError('TRANSITION_INVALID', `run ${run.id} has a durable cancellation request and will end CANCELLED; it cannot be repaired`);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} ended ${run.state}; a finished run cannot be repaired. Start a new one with: orbit repair "<description of the failure>"`);
    const blocked = run.state === 'BLOCKED';
    if (!blocked && !run.paused) throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is ${run.state} and running; a controller is already working on it. Pause it first with "orbit pause ${run.id}" to take it over`);

    const cand = currentCandidate(db, run.id);
    const evidence = cand ? currentEvidenceReport(db, run.id, cand.id) : null;
    if (!cand || !evidence) throw new OrbitError('TRANSITION_INVALID', `run ${run.id} has no verified candidate, so there is no failure to repair. Run "orbit verify ${run.id}" first`);
    if (evidence.verdict !== 'FAIL') throw new OrbitError('TRANSITION_INVALID', `the latest evidence for run ${run.id} (candidate ${cand.seq}) is ${evidence.verdict}, not FAIL, so there is no failure to repair. "orbit verify ${run.id}" shows what is unproven`);
    if (run.state !== 'DIAGNOSING' && !canTransition(run.state, 'DIAGNOSING')) throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is ${run.state}, which cannot move to DIAGNOSING`);
    const open = listQuestions(db, run.id, { status: 'open' }).filter((q) => q.material);
    if (open.length > 0) throw new OrbitError('TRANSITION_INVALID', `run ${run.id} still has ${open.length} material question(s) open (${open.map((q) => q.id).join(', ')}); answer them with "orbit decide ${run.id} <question-id> <answer>" before a repair, or use /orbit:inquisition`, { open: open.map((q) => q.id) });

    const failures = listFailures(db, run.id).filter((f) => f.candidateId === cand.id);
    const primary = failures.find((f) => f.source !== 'flaky_check') ?? failures[0] ?? null;
    const fingerprint = primary?.fingerprint ?? `verdict:${cand.id}`;

    const actor = `cli:${ctx.user}`;
    let after: RunRecord = run;
    if (run.state !== 'DIAGNOSING') {
      await withCliLease(ctx, db, run.id, (ownerId) => {
        db.tx(() => {
          after = transition(db, { runId: run.id, to: 'DIAGNOSING', ownerId, reason: `repair requested by ${ctx.user}: ${fingerprint}`, actor, expectedFrom: run.state }, ctx.clock);
          appendEvent(db, run.id, 'run.repair-requested', actor, { from: run.state, fingerprint, candidate_id: cand.id, report_id: evidence.id }, ctx.clock.now());
        });
      });
    }
    if (getRun(db, run.id).paused) setPaused(db, run.id, false, actor, ctx.clock);
    after = getRun(db, run.id);
    const attempt = nextAttempt(db, run.id);
    const brief = `.orbit/runs/${run.id}/briefs/attempt-${attempt}.json`;

    if (args.bool('foreground')) {
      if (!args.bool('json')) {
        line(ctx.io, `run ${after.id}: repairing failure ${fingerprint}; the controller writes the brief to ${brief}. Driving it in the foreground (Ctrl-C pauses it)`);
      }
      const policy = args.str('policy');
      const config = loadConfig(repo, policy ? resolve(ctx.cwd, policy) : undefined);
      const result = await driveForeground(ctx, { repoRoot: repo, config, db, runId: after.id, fromStart: false, json: args.bool('json') });
      return result.exitCode;
    }
    const service = liveServiceController(db, ctx.clock.now());
    if (args.bool('json')) json(ctx.io, { run_id: after.id, state: after.state, fingerprint, brief_path: brief, candidate_seq: cand.seq, service_running: service !== null });
    else {
      line(ctx.io, `run ${after.id}: moved to ${after.state} to repair ${oneLine(fingerprint, 160)} (candidate ${cand.seq}, evidence ${evidence.id})`);
      line(ctx.io, `The controller writes the repair brief to ${brief}.`);
      if (!service) line(ctx.io, `No controller is running. Start one with "orbit service run", or drive this run here with: orbit resume ${after.id} --foreground`);
    }
    return EXIT.OK;
  } finally {
    db.close();
  }
}

/** The attempt number the next repair brief carries: one past the highest attempt started. */
function nextAttempt(db: ReturnType<typeof openState>, runId: string): number {
  const row = db.get<{ n: number | null }>("SELECT MAX(CAST(json_extract(data_json, '$.attempt') AS INTEGER)) AS n FROM events WHERE run_id = ? AND type = ?", runId, ATTEMPT_EVENT);
  return Number(row?.n ?? 0) + 1;
}
