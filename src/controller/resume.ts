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
