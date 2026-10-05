/**
 * Baseline exception questions, settled against the goal (P18). PREFLIGHT asks a person about every mandatory check
 * that already fails on the base revision (inquisition/baseline-exception.ts). That question is wrong when the goal
 * itself is to make that check pass: the contract's criteria name the check as their proof, so the failure is expected
 * to flip, and excepting it would contradict the goal. Such a question is withdrawn once the contract exists, with a
 * `baseline.expected-to-flip` decision saying why, and any question still open when the run SUCCEEDS is moot (the
 * check passes, or was excepted and so answered) and is withdrawn too, so a green run does not list it as open.
 * A failure that is the environment's (the sandbox refusing an operation) is not the goal's to fix, so its question stays.
 * A question a person already answered is never touched.
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
import { decide } from './common.ts';

export const EXPECTED_TO_FLIP_KIND = 'baseline.expected-to-flip';

function openBaselineRequests(ctx: RunContext): BaselineExceptionRequest[] {
  const out: BaselineExceptionRequest[] = [];
  for (const d of listDecisions(ctx.db, ctx.run.id, { kind: BASELINE_EXCEPTION_REQUEST_KIND })) {
    const req = d.data as BaselineExceptionRequest;
    if (findQuestion(ctx.db, req.question_id)?.status === 'open') out.push(req);
  }
  return out;
}

/**
 * A baseline failure whose output shows the sandbox or the host refusing an operation is an environment failure:
 * making the goal's check pass cannot fix it, so the exception question stays (it is the way forward the run offers
 * when the same refusal blocks the candidate, controller/environment-block.ts).
 */
function isEnvironmentFailure(ctx: RunContext, req: BaselineExceptionRequest): boolean {
  const failure = readJsonIfExists<BaselineReport>(join(ctx.runDir, BASELINE_FILE))?.failures.find((f) => f.checkId === req.check_id);
  return classifyEnvironmentFailure({ checkId: req.check_id, fingerprint: req.fingerprint, baselineFingerprint: req.fingerprint, output: failure?.excerpt ?? '', insideRoots: [] }) !== null;
}

/** Withdraw the exception question of every failing check the contract's criteria target, and record that it is expected to flip. */
export function settleExpectedFlips(ctx: RunContext, contract: GoalContract): string[] {
  const flipped: string[] = [];
  for (const req of openBaselineRequests(ctx)) {
    const criteria = contract.acceptance_criteria.filter((c) => (c.check_ids ?? []).includes(req.check_id)).map((c) => c.id);
    if (criteria.length === 0 || isEnvironmentFailure(ctx, req)) continue;
    withdrawQuestion(ctx.db, req.question_id, `check ${req.check_id} is the proof of ${criteria.join(', ')}: it is expected to flip to passing, not to be excepted`, ctx.clock);
    decide(ctx, {
      id: `dec-${ctx.run.id}-baseline-flip-${req.question_id}`,
      kind: EXPECTED_TO_FLIP_KIND,
      summary: `check ${req.check_id} fails on the base revision and is the proof of ${criteria.join(', ')}: expected to flip to passing, so no baseline exception is asked about`,
      data: { check_id: req.check_id, fingerprint: req.fingerprint, base_revision: req.base_revision, criteria, question_id: req.question_id },
    });
    flipped.push(req.check_id);
  }
  return flipped;
}

/** On SUCCEEDED, withdraw baseline exception questions nobody answered: with the run green they ask about nothing. */
export function closeMootBaselineQuestions(ctx: RunContext): void {
  for (const req of openBaselineRequests(ctx)) {
    withdrawQuestion(ctx.db, req.question_id, `the run succeeded without a baseline exception for check ${req.check_id}: the question is moot`, ctx.clock);
  }
}
