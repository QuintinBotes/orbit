/**
 * `orbit bench`: score this Orbit version on a fixed set of goals (#172). The lab tier replays Orbit's own fixed issues
 * with the fake providers (no model, deterministic) and exits non-zero naming every scenario whose fixed failure came
 * back; the live tier runs pinned goals with real providers, only with the owner's approval and an explicit budget.
 * Both write a scorecard per version and tier (docs/scorecards/orbit-<version>-<tier>.json) whose headline is the
 * false-done rate read from the person-kept false-done file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OrbitError } from '../../core/errors.ts';
import { orbitCheckoutRoot } from '../../bench/lab.ts';
import { LAB_SCENARIOS, runLabTier } from '../../bench/scenarios.ts';
import { localExecutor, liveBudget, parseLiveCatalog, plannedSessions, RUNS_PER_GOAL, runLiveTier } from '../../bench/live.ts';
import { buildScorecard, parseFalseDones, renderScorecard, SCORECARD_DIR, scorecardFile, stableJson, type ScenarioRow, type Scorecard, type Tier } from '../../bench/scorecard.ts';
import { BENCH_STAGES, FIXED_GATES, stageOff } from '../../bench/stages.ts';
import type { Args, OptionSpec } from '../args.ts';
import type { CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json } from '../io.ts';
import { ORBIT_VERSION } from '../version.ts';

export const BENCH_USAGE = 'orbit bench --tier lab [--without <stage>] | --tier live --budget <usd> --approved-by <name> [--baseline] [--catalog <file>]   [--only <ids>] [--false-dones <file>] [--out <dir>] [--json]';

export const BENCH_OPTIONS: OptionSpec = {
  tier: { type: 'string', valueName: 'tier', description: 'lab (fake providers, no model, deterministic) or live (real providers; spends money)' },
  without: { type: 'string', valueName: 'stage', description: `lab: run the suite again with one stage off and compare: ${Object.keys(BENCH_STAGES).join(', ')} (${Object.keys(FIXED_GATES).join(', ')} are gates and cannot be turned off)` },
  budget: { type: 'string', valueName: 'usd', description: `live: the most the whole tier may spend, in US dollars; required, no default. Each of the ${RUNS_PER_GOAL} runs per goal gets an equal share as its cap` },
  'approved-by': { type: 'string', valueName: 'name', description: 'live: the owner who approved this run and its budget; recorded in the scorecard' },
  baseline: { type: 'boolean', description: 'live: also attempt every goal with one plain claude -p session per run and report the difference' },
  catalog: { type: 'string', valueName: 'file', description: 'live: the goal catalog (default data/bench/live-goals.json in the Orbit checkout)' },
  only: { type: 'string', valueName: 'ids', description: 'run only these scenario or goal ids, comma separated; writes no scorecard unless --out is given' },
  'false-dones': { type: 'string', valueName: 'file', description: 'the false-done file the headline reads (default docs/scorecards/false-dones.json in the Orbit checkout)' },
  out: { type: 'string', valueName: 'dir', description: 'where the scorecard is written (default docs/scorecards in the Orbit checkout)' },
};

/** The entries `--only` names, in catalog order; every id must name one. */
function pick<T extends { id: string }>(all: readonly T[], only: string | undefined): readonly T[] {
  if (only === undefined) return all;
  const ids = only.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = ids.filter((id) => !all.some((x) => x.id === id));
  if (ids.length === 0 || unknown.length > 0) throw new UsageError(`--only names no known id: ${unknown.join(', ') || '(empty)'}; known: ${all.map((x) => x.id).join(', ')}`, BENCH_USAGE);
  return all.filter((x) => ids.includes(x.id));
}

export async function benchCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const tier = args.oneOf('tier', ['lab', 'live'] as const) as Tier | undefined;
  if (!tier) throw new UsageError('--tier is required: lab or live', BENCH_USAGE);
  const root = ctx.seams.bench?.root ?? orbitCheckoutRoot();
  const only = args.str('only');
  const lab = tier === 'lab';
  for (const [flag, onTier] of [['without', 'lab'], ['budget', 'live'], ['approved-by', 'live'], ['catalog', 'live'], ['baseline', 'live']] as const) {
    if ((args.str(flag) !== undefined || args.bool(flag)) && onTier !== tier) throw new UsageError(`--${flag} is for the ${onTier} tier`, BENCH_USAGE);
  }
  const falseDonesPath = resolve(ctx.cwd, args.str('false-dones') ?? join(root, 'docs', 'scorecards', 'false-dones.json'));
  if (!existsSync(falseDonesPath)) throw new OrbitError('NOT_FOUND', `no false-done file at ${falseDonesPath}`);
  let falseDones;
  try {
    falseDones = parseFalseDones(readFileSync(falseDonesPath, 'utf8'));
  } catch (err) {
    throw new OrbitError('CONFIG_INVALID', `${falseDonesPath}: ${(err as Error).message}`);
  }
  const progress = (r: ScenarioRow): void => ctx.io.err(`${r.result.toUpperCase().padEnd(7)} ${r.id}${r.problems.length > 0 && r.result !== 'pass' ? `: ${r.problems[0]}` : ''}\n`);
  let card: Scorecard;
  let stage: string | null = null;

  if (lab) {
    const scenarios = pick(ctx.seams.bench?.labScenarios ?? LAB_SCENARIOS, only);
    stage = args.str('without') ?? null;
    let off;
    try {
      off = stage === null ? null : stageOff(stage);
    } catch (err) {
      throw new UsageError(`--without: ${(err as Error).message}`, BENCH_USAGE);
    }
    const rows = await runLabTier({ scenarios, root, onRow: progress });
    const without = off ? { stage: stage!, rows: await runLabTier({ scenarios, root, deps: off.deps ?? {}, ...(off.tweak ? { tweak: off.tweak } : {}), onRow: progress }) } : undefined;
    card = buildScorecard({ tier, orbitVersion: ORBIT_VERSION, generatedAt: new Date(ctx.clock.now()).toISOString(), rows, falseDones, ...(without ? { without } : {}) });
  } else {
    // Refused before anything is read or cloned: no budget, no approval, no run.
    let budget: number;
    try {
      budget = liveBudget(args.str('budget'));
    } catch (err) {
      throw new UsageError((err as Error).message, BENCH_USAGE);
    }
    const approvedBy = args.str('approved-by')?.trim();
    if (!approvedBy) throw new UsageError('every live run needs the owner\'s approval: --approved-by <name>, after reading the goals and the budget', BENCH_USAGE);
    const catalogPath = resolve(ctx.cwd, args.str('catalog') ?? join(root, 'data', 'bench', 'live-goals.json'));
    if (!existsSync(catalogPath)) throw new OrbitError('NOT_FOUND', `no live catalog at ${catalogPath}`);
    let goals;
    try {
      goals = pick(parseLiveCatalog(readFileSync(catalogPath, 'utf8')), only);
    } catch (err) {
      if (err instanceof UsageError) throw err;
      throw new OrbitError('CONFIG_INVALID', (err as Error).message);
    }
    const baseline = args.bool('baseline');
    ctx.io.err(`live tier: ${goals.length} goal(s) x ${RUNS_PER_GOAL} runs${baseline ? ' and the plain-session baseline' : ''}, ${plannedSessions(goals.length, baseline)} sessions, budget $${budget.toFixed(2)}, approved by ${approvedBy}\n`);
    const out = await runLiveTier({ goals, budgetUsd: budget, baseline, executor: ctx.seams.bench?.liveExecutor ?? localExecutor(), onRow: progress });
    card = buildScorecard({ tier, orbitVersion: ORBIT_VERSION, generatedAt: new Date(ctx.clock.now()).toISOString(), rows: out.rows, falseDones, ...(out.baseline ? { baseline: out.baseline } : {}), approval: { by: approvedBy, budget_usd: budget } });
  }

  // A partial run (--only) must not overwrite the version's scorecard.
  const outDir = args.str('out');
  let written: string | null = null;
  if (outDir !== undefined || only === undefined) {
    written = join(outDir === undefined ? join(root, SCORECARD_DIR) : resolve(ctx.cwd, outDir), scorecardFile(ORBIT_VERSION, tier, stage));
    mkdirSync(dirname(written), { recursive: true });
    writeFileSync(written, stableJson(card));
  }
  if (args.bool('json')) json(ctx.io, { scorecard: card, written });
  else ctx.io.out(`${renderScorecard(card)}${written ? `\nScorecard written to ${written}\n` : ''}`);

  // The lab is the regression suite: a scenario that no longer holds fails the command, and CI with it.
  const failed = card.scenarios.filter((r) => r.result === 'fail');
  if (lab && failed.length > 0) {
    ctx.io.err(`orbit bench: ${failed.length} lab scenario(s) failed: ${failed.map((r) => `${r.id} (issue ${r.issue})`).join(', ')}\n`);
    return EXIT.FAILURE;
  }
  return EXIT.OK;
}
