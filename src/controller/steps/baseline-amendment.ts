/**
 * A baseline amendment (docs/decisions/0012-contract-checks-and-judged-trees.md). PREFLIGHT runs the command checks the
 * policy marks mandatory on the base revision (ADR 0010). A contract may require more: a check the policy does not mark
 * mandatory that a criterion cites as evidence or that the planner names among the required checks (contract/draft.ts,
 * `check-added`), or one an approved amendment adds later. Such a check had no base-revision result, and without one the
 * candidate gate cannot tell an environment failure from a failure of the change (ADR 0010, "On a candidate, a new denial
 * goes to repair"): in issue #32 a dotnet format check the sandbox refuses its build host went to diagnosis and repair on
 * an identical tree, and the run ended EXHAUSTED.
 *
 * So before any candidate is judged against such a contract, the checks it requires that the baseline has no result for
 * are run on the base revision, in a fresh checkout of it, and added to the recorded baseline with the step that ran them.
 * PLANNING does it for the contract CONTRACTING accepted, before any attempt; VERIFYING does it for a contract amended
 * since. Each such check is classified as PREFLIGHT classifies a mandatory one, with the same outcome:
 *
 * - an environment failure or a misconfigured check blocks the run, with the reason PREFLIGHT gives and a sentence that
 *   says why the check ran on the base revision; a resume runs it there again;
 * - a missing target is settled against the contract: expected to flip when a criterion names the check, misconfigured
 *   when none does;
 * - a pre-existing failure of the code gets its baseline-exception question, withdrawn when the contract names the check
 *   as a proof (P18);
 * - a pass establishes a clean base: a failure on a candidate is the change's.
 */
import { join } from 'node:path';
import type { GoalContract } from '../../contract/types.ts';
import { faultPoint } from '../../core/faults.ts';
import { atomicWriteJson, readJsonIfExists } from '../../core/fsx.ts';
import { BASELINE_FILE, runBaseline, type BaselineAmendment, type BaselineReport } from '../../evidence/baseline.ts';
import { getDecision } from '../../storage/decisions.ts';
import { homeOf, runWorktreeRoot, toolchainCacheRootFor, type RunContext } from '../context.ts';
import type { AmendedCheck } from '../environment-block.ts';
import { baselineGate } from '../gates.ts';
import { blockOnMissingTargets, missingTargetsNotExpectedToFlip, settleExpectedFlips } from './baseline-questions.ts';
import { decide, finishRun, safePoint, type StepResult } from './common.ts';
import { askAboutBaseFailures, blockOnBaseline, classifyBaseline, recordGate } from './preflight.ts';

/** The decision a baseline amendment records: the checks it ran on the base revision, the step, and what each did there. */
export const BASELINE_AMENDED_KIND = 'baseline.amended';

/**
 * The id of the `baseline.amended` decision of the amendment recorded at `at`. The decision is recorded once the
 * amendment is judged (its block, or its questions and the expected flips), so an amendment without one was cut short
 * after its baseline was written, and checksToAmend amends for its checks again.
 */
function amendedDecisionId(runId: string, at: number): string {
  return `dec-${runId}-baseline-amended-${at}`;
}

/** The baseline PREFLIGHT recorded for this run's base revision and policy, or null. */
function baselineOf(ctx: RunContext): BaselineReport | null {
  const report = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
  if (!report || report.baseRevision !== ctx.run.baseRevision || report.policyHash !== ctx.run.policyHash) return null;
  return Array.isArray(report.checkIds) && Array.isArray(report.checks) && Array.isArray(report.failures) ? report : null;
}

/** The criteria of `contract` that cite `checkId` as evidence. */
function citedBy(contract: GoalContract, checkId: string): string[] {
  return contract.acceptance_criteria.filter((c) => (c.check_ids ?? []).includes(checkId)).map((c) => c.id);
}

/**
 * The command checks `contract` requires that the baseline has no decisive result for, those an earlier amendment
 * found could not run or were misconfigured there (that amendment blocked the run, and a resume runs them again), and
 * those whose latest amendment was never judged (`judged` says no: the step was cut short after the baseline was
 * written, before a question was asked or anything recorded about them, so their result is not taken as judged; a
 * recorded failure of the code is reused when they are amended again, evidence/baseline.ts).
 */
export function checksToAmend(ctx: Pick<RunContext, 'snapshot'>, contract: GoalContract, report: BaselineReport, judged: (a: BaselineAmendment) => boolean): string[] {
  const covered = new Set(report.checkIds);
  const latest = new Map<string, BaselineAmendment>();
  for (const a of report.amendments ?? []) for (const id of a.checkIds) latest.set(id, a);
  const blocked = new Set(report.failures.filter((f) => latest.has(f.checkId) && (f.classification === 'environment' || f.classification === 'misconfigured')).map((f) => f.checkId));
  const unjudged = new Set([...latest].filter(([, a]) => !judged(a)).map(([id]) => id));
  return [...new Set(contract.required_check_ids)].filter((id) => ctx.snapshot.config.checks[id]?.kind === 'command' && (!covered.has(id) || blocked.has(id) || unjudged.has(id))).sort();
}

/**
 * Run on the base revision the checks `contract` requires that the baseline has no result for, add them to it, and judge
 * them as PREFLIGHT judges a mandatory check. Returns the step result when the run stops here (a block, a cancellation),
 * null when it goes on, as it does at once when there is nothing to amend.
 */
export async function amendBaseline(ctx: RunContext, contract: GoalContract): Promise<StepResult | null> {
  const prior = baselineOf(ctx);
  if (!prior || !ctx.run.baseRevision) return null;
  const ids = checksToAmend(ctx, contract, prior, (a) => getDecision(ctx.db, amendedDecisionId(ctx.run.id, a.recordedAt)) !== null);
  if (ids.length > 0) {
    const stop = await runAmendment(ctx, contract, ids, ctx.run.baseRevision);
    if (stop) return stop;
  }
  // A missing target an amendment found of a check the contract requires and no criterion names: nothing in the run
  // creates it, so the check is misconfigured. Judged on every pass, as CONTRACTING judges PREFLIGHT's, so a forced resume
  // blocks on it again; a check the contract stopped requiring is never run on a candidate and judges nothing.
  const amended = new Set((baselineOf(ctx)?.amendments ?? []).flatMap((a) => a.checkIds));
  if (amended.size === 0) return null;
  const unexpected = missingTargetsNotExpectedToFlip(ctx, contract).filter((m) => amended.has(m.checkId));
  return unexpected.length > 0 ? blockOnMissingTargets(ctx, unexpected) : null;
}

/** Run `ids` on the base revision as an amendment of its baseline, record them, and block on what PREFLIGHT blocks on. */
async function runAmendment(ctx: RunContext, contract: GoalContract, ids: readonly string[], baseRevision: string): Promise<StepResult | null> {
  const stage = ctx.run.state;
  const checkoutDir = join(runWorktreeRoot(ctx), 'baseline');
  const outcome = await runBaseline({
    db: ctx.db,
    run: { id: ctx.run.id, policyHash: ctx.run.policyHash },
    repoRoot: ctx.run.repoRoot,
    baseRev: baseRevision,
    snapshot: ctx.snapshot,
    isolation: ctx.isolation(),
    runDir: ctx.runDir,
    clock: ctx.clock,
    signal: ctx.signal,
    pollMs: ctx.timing.checkPollMs,
    killGraceMs: ctx.timing.killGraceMs,
    homeDir: homeOf(ctx.deps),
    checkoutDir,
    toolchainCacheRoot: toolchainCacheRootFor(ctx),
    checkIds: [...ids],
    amend: { stage },
  });
  const after = await safePoint(ctx);
  if (after) return after;

  const only = new Set(ids);
  const found = classifyBaseline(ctx, outcome.report, checkoutDir, only);
  const classified = found.report;
  atomicWriteJson(join(ctx.runDir, BASELINE_FILE), classified);
  faultPoint('controller.baseline-amendment.after-write');
  const at = classified.amendments?.at(-1)?.recordedAt ?? ctx.clock.now();
  const amended: AmendedCheck[] = ids.map((id) => ({ checkId: id, citedBy: citedBy(contract, id), mandatory: ctx.snapshot.config.checks[id]?.mandatory === true }));
  const records = amended.map((a) => {
    const entry = classified.checks.find((c) => c.checkId === a.checkId);
    const failure = classified.failures.find((f) => f.checkId === a.checkId);
    return {
      check_id: a.checkId,
      status: entry?.status ?? 'NOT_RUN',
      ...(failure ? { classification: failure.classification ?? 'pre-existing' } : {}),
      ...(failure?.signals ? { signals: failure.signals } : {}),
      cited_by: [...a.citedBy],
      mandatory: a.mandatory,
      ...(entry?.log ? { log_path: entry.log } : {}),
    };
  });
  const said = records.map((r) => `${r.check_id} ${r.status}${r.classification ? ` (${r.classification})` : ''}`).join(', ');
  // Recorded once the amendment is judged, so that one cut short before this point is amended again (checksToAmend).
  const judged = (): void =>
    void decide(ctx, {
      id: amendedDecisionId(ctx.run.id, at),
      kind: BASELINE_AMENDED_KIND,
      summary: `the contract requires ${ids.length > 1 ? 'checks' : 'check'} ${ids.join(', ')}, which the base revision ${classified.baseRevision.slice(0, 12)} had no result for, so ${stage} ran ${ids.length > 1 ? 'them' : 'it'} there before any change was judged: ${said}`,
      data: { base_revision: classified.baseRevision, stage, checks: records },
    });

  // The amendment's own checkout needed the locked install too; without it nothing of the base revision was checked.
  if (!classified.install.skipped && !classified.install.ok) {
    judged();
    const bg = baselineGate(classified);
    recordGate(ctx, bg);
    return finishRun(ctx, 'BLOCKED', `baseline gate: ${bg.reasons.join('; ')}, so ${ids.length > 1 ? 'checks' : 'check'} ${ids.join(', ')}, which the contract requires, could not be run there`, { outcome: { gate: bg, stage } });
  }
  const { misconfigured, environment } = found;
  if (misconfigured.length > 0 || environment.length > 0) {
    judged();
    return blockOnBaseline(ctx, classified, { environment, misconfigured }, { at, stage, checks: amended });
  }
  askAboutBaseFailures(ctx, found, { baseRevision, key: `amended-${at}`, only });
  settleExpectedFlips(ctx, contract);
  // The gate as the run goes on with it: PREFLIGHT's record says nothing of the checks the amendment ran (with no
  // mandatory check it said "not applicable").
  recordGate(ctx, baselineGate(classified));
  judged();
  return null;
}
