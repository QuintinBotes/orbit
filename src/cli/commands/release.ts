/**
 * `orbit release resolve <run-id>`: settle a deploy whose outcome is unknown (a crash or a timeout while the
 * deploy command ran). Without a flag it runs the environment's trusted `verify_command` (exit 0: the deploy took
 * effect, exit 1: it did not, anything else: still unknown). `--deployed` and `--not-deployed` record what a
 * person found out. Deployed adopts the deploy, so it is never run again; not deployed lets the run's next
 * release attempt run it. Neither continues the run: `orbit resume <run-id>` does.
 */
import { OrbitError } from '../../core/errors.ts';
import { isTerminal } from '../../controller/states.ts';
import { homeOf, loadRunContext } from '../../controller/context.ts';
import { renewLease } from '../../controller/run-store.ts';
import { ActionLedger } from '../../delivery/actions.ts';
import { resolveDeploy, type DeployResolutionKind } from '../../delivery/release.ts';
import type { Args, OptionSpec } from '../args.ts';
import { findRunByPrefix, openState, resolveRepo, withCliLease, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, line } from '../io.ts';
import { cliLeaseDeps } from './control.ts';

const LEASE_TTL_MS = 10 * 60_000;
const LEASE_RENEW_MS = 20_000;

export const RELEASE_RESOLVE_OPTIONS: OptionSpec = {
  deployed: { type: 'boolean', description: 'record that the deploy took effect (adopt it; it is never run again)' },
  'not-deployed': { type: 'boolean', description: 'record that the deploy did not take effect (the next release attempt may run it)' },
  environment: { type: 'string', description: 'which environment, when more than one deploy is unresolved', valueName: 'name' },
  by: { type: 'string', description: 'who is resolving it (default: your user name); recorded with the decision', valueName: 'name' },
};

export const RELEASE_RESOLVE_USAGE = 'orbit release resolve <run-id> [--deployed | --not-deployed] [--environment name] [--by name] [--json]';

export async function releaseResolveCommand(args: Args, ctx: CliContext): Promise<number> {
  const [ref] = args.expect(1);
  if (args.bool('deployed') && args.bool('not-deployed')) throw new UsageError('--deployed and --not-deployed are exclusive', RELEASE_RESOLVE_USAGE);
  const resolution: DeployResolutionKind = args.bool('deployed') ? 'deployed' : args.bool('not-deployed') ? 'not-deployed' : 'verify';
  const environment = args.str('environment');
  const by = (args.str('by') ?? ctx.user).trim() || ctx.user;
  const repo = await resolveRepo(ctx, args.str('repo'));
  const db = openState(repo);
  try {
    const run = findRunByPrefix(db, ref!);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is ${run.state}; there is no deploy left to resolve`);
    const outcome = await withCliLease(
      ctx,
      db,
      run.id,
      async (ownerId) => {
        const renew = setInterval(() => {
          try {
            renewLease(db, run.id, ownerId, LEASE_TTL_MS, ctx.clock);
          } catch {
            /* the lease simply expires if the database stays busy */
          }
        }, LEASE_RENEW_MS);
        renew.unref();
        try {
          const rc = loadRunContext(cliLeaseDeps(ctx, repo, db, ownerId), run.id, new AbortController().signal);
          const ledger = new ActionLedger(db, ctx.clock, { runDir: rc.runDir, actor: by });
          const result = await resolveDeploy({
            run: { id: rc.run.id, repoRoot: rc.run.repoRoot, branch: rc.run.branch, baseRevision: rc.run.baseRevision, policyHash: rc.run.policyHash, cancelRequested: rc.run.cancelRequested, goal: rc.run.goal },
            snapshot: rc.snapshot,
            ledger,
            clock: ctx.clock,
            workDir: rc.runDir,
            ...(environment === undefined ? {} : { environment }),
            resolution,
            by,
            ...(resolution === 'verify' ? { isolation: rc.isolation(), homeDir: homeOf(rc.deps) } : {}),
          });
          return { result };
        } finally {
          clearInterval(renew);
        }
      },
      LEASE_TTL_MS,
    );
    const { result } = outcome;
    if (args.bool('json')) {
      json(ctx.io, { run_id: run.id, environment: result.environment, sha: result.sha, verdict: result.verdict, via: result.via, detail: result.detail, action_id: result.actionId, run_state: run.state });
      return result.verdict === 'unknown' ? EXIT.FAILURE : EXIT.OK;
    }
    if (result.verdict === 'unknown') {
      line(ctx.io, `the deploy of ${result.sha.slice(0, 12)} to ${result.environment} is still unknown: ${result.detail}`);
      line(ctx.io, `Find out whether it took effect, then run: orbit release resolve ${run.id} --deployed   (or --not-deployed)`);
      return EXIT.FAILURE;
    }
    line(ctx.io, `${result.environment}: the deploy of ${result.sha.slice(0, 12)} is recorded as ${result.verdict === 'deployed' ? 'DEPLOYED (it will not run again)' : 'NOT DEPLOYED (the next release attempt may run it)'}; ${result.detail}`);
    line(ctx.io, run.state === 'BLOCKED' ? `Continue the run with: orbit resume ${run.id}` : 'The controller picks this up at the run\'s next release attempt.');
    return EXIT.OK;
  } finally {
    db.close();
  }
}
