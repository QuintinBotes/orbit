/**
 * Baseline exception questions, settled against the goal (P18). PREFLIGHT asks a person about every mandatory check
 * that already fails on the base revision (inquisition/baseline-exception.ts). That question is wrong when the goal
 * itself is to make that check pass: the contract's criteria name the check as their proof, so the failure is expected
 * to flip, and excepting it would contradict the goal. Such a question is withdrawn once the contract exists, with a
 * `baseline.expected-to-flip` decision saying why, and any question still open when the run SUCCEEDS is moot (the
 * check passes, or was excepted and so answered) and is withdrawn too, so a green run does not list it as open.
 * A pre-existing failure whose output shows the sandbox or the host refusing an operation (EPERM, "operation not permitted",
 * an srt violation line) is not the goal's to fix either, so its question stays. One PREFLIGHT classified as an environment
 * failure never gets here: that blocks the run before a question is raised (ADR 0010).
 * A question a person already answered is never touched.
 *
 * A check whose command names something the base revision does not have (a missing target: npm's missing script,
 * pytest's missing test file, no project for MSBuild; docs/decisions/0010-base-failure-classification.md) is settled here
 * too. When the contract names the check, the goal is to create what it names, so it is expected to flip like any other
 * failure. When the contract does not, nothing in the run will create it: the check is misconfigured, and the run blocks
 * here, classified and evidenced as PREFLIGHT classifies a check whose command line its tool rejected, but with advice of
 * its own by cause (missingTargetAdvice): a new run in every case, since this step reads the baseline PREFLIGHT recorded.
 * It is never a baseline exception either way.
 */
import { join } from 'node:path';
import type { GoalContract } from '../../contract/types.ts';
import { readJsonIfExists } from '../../core/fsx.ts';
import { BASELINE_FILE, type BaselineReport } from '../../evidence/baseline.ts';
import { classifyEnvironmentFailure } from '../../evidence/environment-failure.ts';
import { BASELINE_EXCEPTION_REQUEST_KIND, type BaselineExceptionRequest } from '../../inquisition/baseline-exception.ts';
import { findQuestion, withdrawQuestion } from '../../inquisition/store.ts';
import { listDecisions } from '../../storage/decisions.ts';
import type { RunContext } from '../context.ts';
import { baselineMisconfiguredChecks, misconfiguredRecord, missingTargetAdvice, missingTargetBlockReason, type MisconfiguredBlock } from '../environment-block.ts';
import { decide, finishRun, type StepResult } from './common.ts';

export const EXPECTED_TO_FLIP_KIND = 'baseline.expected-to-flip';
/** PREFLIGHT's record of the checks whose command names something the base revision does not have. */
export const MISSING_TARGET_KIND = 'baseline.missing-target';

function baselineRequests(ctx: RunContext): BaselineExceptionRequest[] {
  return listDecisions(ctx.db, ctx.run.id, { kind: BASELINE_EXCEPTION_REQUEST_KIND }).map((d) => d.data as BaselineExceptionRequest);
}

function openBaselineRequests(ctx: RunContext): BaselineExceptionRequest[] {
  return baselineRequests(ctx).filter((req) => findQuestion(ctx.db, req.question_id)?.status === 'open');
}

function baselineOf(ctx: RunContext): BaselineReport | null {
  const report = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE));
  return report && report.baseRevision === ctx.run.baseRevision && Array.isArray(report.failures) ? report : null;
}

/** The checks PREFLIGHT found name something the base revision does not have. */
function missingTargetChecks(ctx: RunContext): Set<string> {
  return new Set((baselineOf(ctx)?.failures ?? []).filter((f) => f.classification === 'missing-target').map((f) => f.checkId));
}

/**
 * A pre-existing baseline failure whose output shows the sandbox or the host refusing an operation (the reading of
 * classifyEnvironmentFailure, wider than PREFLIGHT's classification of ADR 0010, which blocks the run first): making
 * the goal's check pass cannot fix it, so the exception question stays (it is the way forward the run offers when the
 * same refusal blocks the candidate, controller/environment-block.ts).
 */
function showsSandboxRefusal(ctx: RunContext, req: BaselineExceptionRequest): boolean {
  const failure = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE))?.failures.find((f) => f.checkId === req.check_id);
  return classifyEnvironmentFailure({ checkId: req.check_id, fingerprint: req.fingerprint, baselineFingerprint: req.fingerprint, output: failure?.excerpt ?? '', insideRoots: [] }) !== null;
}

/** The criteria whose proof is `checkId`. */
function criteriaProvedBy(contract: GoalContract, checkId: string): string[] {
  return contract.acceptance_criteria.filter((c) => (c.check_ids ?? []).includes(checkId)).map((c) => c.id);
}

/** Withdraw the exception question of every failing check the contract's criteria target, and record that it is expected to flip. */
export function settleExpectedFlips(ctx: RunContext, contract: GoalContract): string[] {
  const flipped: string[] = [];
  const missing = missingTargetChecks(ctx);
  for (const req of openBaselineRequests(ctx)) {
    const criteria = criteriaProvedBy(contract, req.check_id);
    if (criteria.length === 0 || (!missing.has(req.check_id) && showsSandboxRefusal(ctx, req))) continue;
    const what = missing.has(req.check_id) ? 'names something the base revision does not have, which the goal is to create,' : 'fails on the base revision';
    withdrawQuestion(ctx.db, req.question_id, `check ${req.check_id} is the proof of ${criteria.join(', ')}: it is expected to flip to passing, not to be excepted`, ctx.clock);
    decide(ctx, {
      id: `dec-${ctx.run.id}-baseline-flip-${req.question_id}`,
      kind: EXPECTED_TO_FLIP_KIND,
      summary: `check ${req.check_id} ${what} and is the proof of ${criteria.join(', ')}: expected to flip to passing, so no baseline exception is asked about`,
      data: { check_id: req.check_id, fingerprint: req.fingerprint, base_revision: req.base_revision, criteria, question_id: req.question_id, ...(missing.has(req.check_id) ? { missing_target: true } : {}) },
    });
    flipped.push(req.check_id);
  }
  return flipped;
}

/**
 * The checks whose command names something the base revision does not have and that the contract does not name as the
 * proof of any criterion: nothing in the run is expected to create what they name, so they are misconfigured. Read
 * again from their recorded output, with the evidence PREFLIGHT read.
 */
export function missingTargetsNotExpectedToFlip(ctx: RunContext, contract: GoalContract): MisconfiguredBlock[] {
  const report = baselineOf(ctx);
  if (!report) return [];
  const missing = report.failures.filter((f) => f.classification === 'missing-target' && criteriaProvedBy(contract, f.checkId).length === 0);
  if (missing.length === 0) return [];
  const found = baselineMisconfiguredChecks(ctx, { ...report, failures: missing });
  // A log that is gone still leaves the classification PREFLIGHT recorded.
  return missing.map(
    (f) =>
      found.find((m) => m.checkId === f.checkId) ?? {
        checkId: f.checkId,
        kind: 'missing-target',
        signature: 'unknown',
        tool: 'the tool',
        cause: 'the check\'s command names something that does not exist on the base revision',
        lines: f.excerpt ? [f.excerpt.split('\n')[0]!.slice(0, 200)] : [],
        configKey: `checks.${f.checkId}.command`,
      },
  );
}

/**
 * End the run BLOCKED at CONTRACTING on missing targets the contract does not expect to flip: they are misconfigured
 * checks, a frozen-policy block (the reason starts "Check X is misconfigured", steps/common.ts frozenPolicyCause), but
 * with the advice of its own that finishRun adds in place of the generic one (environment-block.ts missingTargetAdvice):
 * a goal meant to create the target must say so in a new run, and a target a tool provides that is not installed or
 * restored yet (a cargo plugin, a dotnet local tool) needs a new run once it is, because CONTRACTING reads the baseline
 * PREFLIGHT recorded. Their open exception questions are withdrawn: the block answers them.
 */
export async function blockOnMissingTargets(ctx: RunContext, checks: readonly MisconfiguredBlock[]): Promise<StepResult> {
  const baseRevision = ctx.run.baseRevision ?? '';
  const reason = missingTargetBlockReason({ baseRevision, checks });
  const advice = missingTargetAdvice({ runId: ctx.run.id, checks });
  const ids = new Set(checks.map((m) => m.checkId));
  for (const req of openBaselineRequests(ctx)) {
    if (ids.has(req.check_id)) withdrawQuestion(ctx.db, req.question_id, `check ${req.check_id} is misconfigured: its command names something that does not exist on the base revision, and the contract does not expect the goal to create it`, ctx.clock);
  }
  const records = checks.map((m) => misconfiguredRecord(m, 'misconfigured'));
  decide(ctx, { id: `dec-${ctx.run.id}-contract-missing-target-${ctx.clock.now()}`, kind: 'baseline.check-misconfigured', summary: `${reason} ${advice}`, data: { base_revision: baseRevision, stage: 'CONTRACTING', checks: records } });
  return finishRun(ctx, 'BLOCKED', reason, { frozenAdvice: advice, outcome: { base_revision: baseRevision, misconfigured_checks: records } });
}

/** On SUCCEEDED, withdraw baseline exception questions nobody answered: with the run green they ask about nothing. */
export function closeMootBaselineQuestions(ctx: RunContext): void {
  for (const req of openBaselineRequests(ctx)) {
    withdrawQuestion(ctx.db, req.question_id, `the run succeeded without a baseline exception for check ${req.check_id}: the question is moot`, ctx.clock);
  }
}
