/**
 * `orbit gc`: apply artifact retention (spec section 3, `retention.keep_runs_days`).
 * Finished runs older than the retention period lose their run directory and
 * worktrees; their database rows stay. BLOCKED runs are never touched. The
 * work is storage/retention.ts:pruneExpiredRuns; this command only supplies
 * the policy's period and prints what happened.
 */
import { loadConfig } from '../../policy/index.ts';
import { pruneExpiredRuns } from '../../storage/retention.ts';
import type { Args, OptionSpec } from '../args.ts';
import { resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { iso, json, line, oneLine } from '../io.ts';

export const GC_USAGE = 'orbit gc [--keep-days <n>] [--dry-run] [--json]';

export const GC_OPTIONS: OptionSpec = {
  'keep-days': { type: 'string', valueName: 'n', description: 'prune runs that ended more than this many days ago (default: retention.keep_runs_days from the policy)' },
  'dry-run': { type: 'boolean', description: 'list what would be pruned without removing anything' },
};

export async function gcCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const flag = args.int('keep-days');
  if (flag !== undefined && flag < 1) throw new UsageError('--keep-days must be at least 1', GC_USAGE);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const keepDays = flag ?? loadConfig(repo).retention.keep_runs_days;
  const dryRun = args.bool('dry-run');
  const result = await withState(repo, (db) => pruneExpiredRuns(db, { repoRoot: repo, keepDays, clock: ctx.clock, orbitHome: ctx.orbitHome, dryRun }));
  if (args.bool('json')) {
    json(ctx.io, { keep_days: keepDays, dry_run: dryRun, cutoff: result.cutoff, pruned: result.pruned, skipped: result.skipped });
    return EXIT.OK;
  }
  line(ctx.io, `retention: runs that ended before ${iso(result.cutoff)} (${keepDays} day${keepDays === 1 ? '' : 's'})${dryRun ? '; dry run, nothing removed' : ''}`);
  for (const p of result.pruned) line(ctx.io, `${dryRun ? 'would prune' : 'pruned'} ${p.runId} (${p.state}, ended ${iso(p.endedAt)}): ${p.removed.length} location(s)`);
  for (const s of result.skipped) line(ctx.io, `skipped ${s.runId}: ${oneLine(s.reason, 200)}`);
  if (result.pruned.length === 0 && result.skipped.length === 0) line(ctx.io, 'nothing to prune');
  return EXIT.OK;
}
