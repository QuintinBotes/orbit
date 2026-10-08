/**
 * Resuming a BLOCKED run: where it goes back to, and whether its block came from the frozen policy (which a resume
 * cannot clear). Shared by `orbit resume` and the service, which resumes a run once remote answers (ADR 0008) leave
 * no material question open.
 */
import type { Clock } from '../core/clock.ts';
import { listQuestions } from '../inquisition/store.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { acquireLease, getRun, releaseLease, transition, type RunRecord } from './run-store.ts';
import { canTransition, type RunState } from './states.ts';

/** Where a blocked run goes back to: the stage it stopped in, or the earliest stage its durable state supports. */
export function resumeTarget(db: OrbitDb, run: RunRecord): RunState {
  const prior = run.resumeState;
  if (prior && canTransition('BLOCKED', prior)) {
    // Review and delivery act only on live evidence; a decision that changed the contract while the run was blocked
    // (an approved amendment) invalidated it, so the candidate is verified again first.
    if ((prior === 'REVIEWING' || prior === 'DELIVERING') && !liveEvidenceForLatestCandidate(db, run.id)) return 'VERIFYING';
    return prior;
  }
  if (db.get('SELECT 1 AS x FROM candidates WHERE run_id = ? LIMIT 1', run.id)) return 'VERIFYING';
  return run.contractJson ? 'PLANNING' : 'PREFLIGHT';
}

function liveEvidenceForLatestCandidate(db: OrbitDb, runId: string): boolean {
  const cand = db.get<{ id: string }>('SELECT id FROM candidates WHERE run_id = ? ORDER BY seq DESC LIMIT 1', runId);
  if (!cand) return false;
  return db.get('SELECT 1 AS x FROM evidence_reports WHERE run_id = ? AND candidate_id = ? AND invalidated_at IS NULL LIMIT 1', runId, cand.id) !== undefined;
}

/** The policy setting a block came from, when the controller recorded it as a frozen-policy block. */
export function frozenPolicySetting(run: Pick<RunRecord, 'outcomeJson'>): string | null {
  try {
    const o = run.outcomeJson ? (JSON.parse(run.outcomeJson) as { frozen_policy?: { setting?: unknown } }) : null;
    if (!o?.frozen_policy) return null;
    return typeof o.frozen_policy.setting === 'string' ? o.frozen_policy.setting : 'a policy setting';
  } catch {
    return null;
  }
}

/**
 * Whether a fix outside the policy can clear a block on `setting`, so that `orbit resume --force` is a way forward. Not
 * offered for a misconfigured check (`checks.<id>.command`): its command is the policy's, and a forced resume runs the
 * same command again (a PREFLIGHT block leaves the baseline incomplete, so the check runs again; at CONTRACTING the
 * recorded baseline is read and blocks again), so it blocks again unless the tool changed outside the policy. A new
 * run, which the advice names, clears the block whatever the cause (ADR 0010).
 */
export function frozenPolicyForceHelps(setting: string): boolean {
  return !/^checks\.[\w.-]+\.command(?:, checks\.[\w.-]+\.command)*$/.test(setting);
}

/**
 * The checks a candidate's verification could not run for an environment cause (verifying.ts blockOnEnvironment records
 * them with the candidate's id), as the outcome recorded them; null when the block is not one. A PREFLIGHT environment
 * block records the failures without a candidate, and a resume of it runs the baseline again (steps/preflight.ts), so it
 * is not this.
 */
export function candidateEnvironmentFailures(run: Pick<RunRecord, 'outcomeJson'>): { checkId: string; questionId: string | null }[] | null {
  try {
    const o = run.outcomeJson ? (JSON.parse(run.outcomeJson) as { candidate_id?: unknown; environment_failures?: unknown }) : null;
    if (typeof o?.candidate_id !== 'string' || !Array.isArray(o.environment_failures)) return null;
    return o.environment_failures.flatMap((f: unknown) => {
      const r = f !== null && typeof f === 'object' ? (f as { check_id?: unknown; question_id?: unknown }) : {};
      return typeof r.check_id === 'string' ? [{ checkId: r.check_id, questionId: typeof r.question_id === 'string' ? r.question_id : null }] : [];
    });
  } catch {
    return null;
  }
}

/**
 * Why resuming a BLOCKED run cannot clear its block, so that only a new run helps; null when a resume may. Two causes:
 *   - the block comes from the run's frozen policy (a check's definition, an isolation setting): a run keeps the policy
 *     it started with, and a resume is refused for it;
 *   - a candidate's check could not run for an environment cause, with no baseline exception to approve: the candidate's
 *     evidence and the check configuration it was judged by are recorded with the run, so a resume reads the same
 *     evidence and blocks again, whatever is repaired outside (issue #33). A failure that has a baseline-exception
 *     question is answered instead, and the run resumes.
 * A spent implementation-attempt counter is not a cause. It is charged when an attempt starts, so a run blocked in the
 * middle of its last attempt (a supervised authorization question, an expired login, transient provider failures) has it
 * full, and a resume continues that attempt and spends nothing new (steps/implementing.ts continueAttempt). A run that
 * is out of attempts where another would start ends EXHAUSTED there (the counter refuses the charge, and diagnosing and
 * reviewing check it first) instead of blocking, so there is no block that a full counter would describe.
 * Shared by the CLI's closing line, `orbit status` and the report, so they say the same thing.
 */
export function newRunNeeded(db: OrbitDb, run: RunRecord): string | null {
  if (run.state !== 'BLOCKED') return null;
  const frozen = frozenPolicySetting(run);
  // Where a fix outside the policy clears it (a refreshed model catalog), the outcome reason offers a forced resume as well:
  // the stage line must not say a new run is the only way (issue #33).
  if (frozen !== null) return `its frozen policy (${frozen}) causes the block${frozenPolicyForceHelps(frozen) ? '; if what you fixed is outside the policy, "orbit resume --force" is the other way forward' : ''}`;
  const failures = candidateEnvironmentFailures(run);
  if (failures !== null && failures.every((f) => f.questionId === null || listQuestions(db, run.id).every((q) => q.id !== f.questionId))) {
    return "the block comes from the environment or a check's definition, which a resume does not change: the run's policy and the check results recorded for its candidate are frozen";
  }
  return null;
}

/**
 * The checks a run was blocked on at CONTRACTING because each names a target the base revision does not have and the
 * contract does not name as a proof (steps/baseline-questions.ts blockOnMissingTargets), as the outcome recorded them
 * (kind `missing-target`). Empty for every other block: a PREFLIGHT block records only argument errors, whose cause is
 * the command and so the config. Such a block is a frozen-policy block too, but a fix of the config is one of three
 * causes of it, so the surfaces that print the way forward give the advice by cause (environment-block.ts
 * missingTargetAdvice) instead of the generic one.
 */
export function missingTargetChecks(run: Pick<RunRecord, 'outcomeJson'>): { checkId: string; configKey: string }[] {
  try {
    const o = run.outcomeJson ? (JSON.parse(run.outcomeJson) as { misconfigured_checks?: unknown }) : null;
    if (!Array.isArray(o?.misconfigured_checks)) return [];
    return o.misconfigured_checks.flatMap((m: unknown) => {
      const r = m !== null && typeof m === 'object' ? (m as { check_id?: unknown; kind?: unknown; config_key?: unknown }) : {};
      if (r.kind !== 'missing-target' || typeof r.check_id !== 'string') return [];
      return [{ checkId: r.check_id, configKey: typeof r.config_key === 'string' ? r.config_key : `checks.${r.check_id}.command` }];
    });
  } catch {
    return [];
  }
}

/**
 * Resume a BLOCKED run whose material questions are all answered, under a short lease of `ownerId`, as `orbit resume`
 * would without --force. Returns the stage it went back to, or null when it may not be resumed this way (not BLOCKED,
 * cancellation requested, a frozen-policy block, a material question still open, or another owner holds it).
 */
export function resumeAnsweredRun(db: OrbitDb, clock: Clock, runId: string, ownerId: string, actor: string, reason: string): RunState | null {
  const run = getRun(db, runId);
  if (run.state !== 'BLOCKED' || run.cancelRequested || frozenPolicySetting(run) !== null) return null;
  if (listQuestions(db, run.id, { status: 'open' }).some((q) => q.material)) return null;
  if (!acquireLease(db, run.id, ownerId, 60_000, clock)) return null;
  try {
    const target = resumeTarget(db, run);
    db.tx(() => {
      transition(db, { runId: run.id, to: target, ownerId, reason, actor, expectedFrom: 'BLOCKED' }, clock);
      appendEvent(db, run.id, 'run.resumed', actor, { from: 'BLOCKED', to: target, forced: false, by: 'remote-answer' }, clock.now());
    });
    return target;
  } finally {
    releaseLease(db, run.id, ownerId);
  }
}
