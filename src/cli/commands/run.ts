/** `orbit run`: freeze the policy, create the run, then drive it here or hand it to the service. */
import { releaseEnvironmentProblem } from '../../contract/validate.ts';
import { loadConfig, RUN_MODES } from '../../policy/index.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import { startRun } from '../../controller/index.ts';
import { resolve } from 'node:path';
import type { Args, OptionSpec } from '../args.ts';
import { liveServiceController, openState, resolveRepo, type CliContext } from '../context.ts';
import { UsageError } from '../exit.ts';
import { json, line } from '../io.ts';
import { driveForeground } from './drive.ts';

export const RUN_OPTIONS: OptionSpec = {
  goal: { type: 'string', description: 'the goal (or "-" to read it from stdin); the remaining arguments are appended', valueName: 'text' },
  mode: { type: 'string', description: 'supervised, autonomous, autonomous-delivery or release; validated exactly as if the policy file said it', valueName: 'mode' },
  policy: { type: 'string', description: 'policy file (default: .orbit/config.yaml)', valueName: 'path' },
  environment: { type: 'string', description: 'release mode: deploy only to this environment of the release profile (refused when it is not defined or not allowed for the branch); default: every environment the branch is allowed for', valueName: 'name' },
  foreground: { type: 'boolean', description: 'drive the run in this terminal (the default when no service is running); Ctrl-C pauses it' },
  detach: { type: 'boolean', description: 'create the run and leave it to the service' },
};

export async function runCommand(args: Args, ctx: CliContext): Promise<number> {
  const usage = 'orbit run --goal "<goal>" [--mode <mode>] [--environment <name>] [--policy <path>] [--foreground | --detach]';
  if (args.bool('foreground') && args.bool('detach')) throw new UsageError('--foreground and --detach cannot be combined', usage);
  const mode = args.oneOf('mode', RUN_MODES);
  let goal = args.str('goal') ?? '';
  if (goal === '-') goal = (await ctx.io.readStdin()).trim();
  const extra = args.positionals.join(' ').trim();
  goal = [goal, extra].filter(Boolean).join(' ').trim();
  if (!goal) throw new UsageError('a goal is required: orbit run --goal "..."', usage);

  const repo = await resolveRepo(ctx, args.str('repo'));
  const policy = args.str('policy');
  // Every problem in the policy is reported at once, before any state exists.
  const config: OrbitConfig = loadConfig(repo, policy ? resolve(ctx.cwd, policy) : undefined, mode ? { mode } : {});

  // A named environment is checked against the policy before any state exists, as the intake gate checks it again.
  const environment = args.str('environment');
  if (environment !== undefined) {
    const why = releaseEnvironmentProblem(config, environment);
    if (why) throw new UsageError(`--environment ${environment}: ${why}`, usage);
  }

  const db = openState(repo, { create: true });
  try {
    const service = liveServiceController(db, ctx.clock.now());
    const foreground = args.bool('foreground') ? true : args.bool('detach') ? false : service === null;
    // The policy is frozen (snapshot, hash, read-only) before the run row that names it exists.
    const run = startRun({ db, repoRoot: repo, goal, config, clock: ctx.clock, actor: `cli:${ctx.user}`, ...(environment !== undefined ? { environment } : {}) });
    const asJson = args.bool('json');
    if (!foreground) {
      if (asJson) json(ctx.io, { run_id: run.id, state: run.state, mode: run.mode, ...(run.environment ? { environment: run.environment } : {}), detached: true, service_running: service !== null });
      else {
        line(ctx.io, `run ${run.id} created (${run.mode}${run.environment ? `, environment ${run.environment}` : ''}), handed to the service`);
        if (!service) ctx.io.err('warning: no service is running, so nothing is working on this run yet. Start one with "orbit service install" (or "orbit service run"), or drive the run here with "orbit resume ' + run.id + ' --foreground".\n');
        line(ctx.io, `follow it with: orbit status ${run.id}`);
      }
      return 0;
    }
    if (!asJson) line(ctx.io, `run ${run.id} started (${run.mode}${run.environment ? `, environment ${run.environment}` : ''}, foreground; Ctrl-C pauses it, it does not cancel)`);
    else ctx.io.out(`${JSON.stringify({ type: 'started', run_id: run.id, mode: run.mode, ...(run.environment ? { environment: run.environment } : {}) })}\n`);
    const result = await driveForeground(ctx, { repoRoot: repo, config, db, runId: run.id, fromStart: true, json: asJson });
    return result.exitCode;
  } finally {
    db.close();
  }
}
