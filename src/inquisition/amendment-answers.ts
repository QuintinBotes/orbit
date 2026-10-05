/**
 * The answer to a contract amendment's approval question (`q-amd-<amendment id>`) applied to the run. The
 * Inquisition stores an amendment only a person may approve as `pending-approval` with that question; a recorded
 * human "Approve" applies it to the run's contract (through `applyApprovedAmendment`, the one path that passes an
 * approval) and "Reject", or any answer that does not approve, closes it with the contract unchanged. `orbit
 * decide` calls this while the person answers; the controller calls it again at its next safe point, so an answer
 * whose application failed or was interrupted is still applied before any step reasons about the contract.
 */
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { isOrbitError, OrbitError } from '../core/errors.ts';
import { atomicWriteJson } from '../core/fsx.ts';
import { hashObject } from '../core/hash.ts';
import { redact } from '../core/redact.ts';
import { invalidateEvidence } from '../evidence/freshness.ts';
import type { GoalContract } from '../contract/types.ts';
import { verifySnapshot } from '../policy/snapshot.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { getDecision } from '../storage/decisions.ts';
import { appendEvent } from '../storage/events.ts';
import { answerDecisionId, ANSWER_DECISION_KIND, isHumanActor } from './actors.ts';
import { applyApprovedAmendment } from './engine.ts';
import { findQuestion, getAmendment, listAmendments, resolveAmendment } from './store.ts';

export const AMENDMENT_QUESTION_PREFIX = 'q-amd-';

export interface AmendmentAnswerScope {
  db: OrbitDb;
  clock: Clock;
  runId: string;
  runDir: string;
}

export type AmendmentAnswerStatus = 'applied' | 'rejected' | 'unanswered' | 'declined' | 'deferred' | 'refused';

export interface AmendmentAnswerOutcome {
  amendmentId: string;
  questionId: string;
  status: AmendmentAnswerStatus;
  detail: string | null;
}

export interface AppliedAmendmentAnswers {
  /** The run's contract after the answers were applied; null when the run has none yet. */
  contract: GoalContract | null;
  outcomes: AmendmentAnswerOutcome[];
  /** True when the run's contract changed. */
  changed: boolean;
}

interface RunRow {
  contract_json: string | null;
  policy_path: string;
  policy_hash: string;
}

const MAX_CAS_ATTEMPTS = 4;

/** The amendment a question approves, when it is an amendment approval question. */
export function amendmentIdOfQuestion(questionId: string): string | null {
  return questionId.startsWith(AMENDMENT_QUESTION_PREFIX) ? questionId.slice(AMENDMENT_QUESTION_PREFIX.length) : null;
}

/**
 * Apply every answered approval question of the run's pending amendments (or only `questionId`). Idempotent: an
 * amendment that is no longer pending is left alone. The amendment row and the run's contract change in one
 * transaction, guarded against a concurrent contract change; every report of the run is invalidated because the
 * verdicts were reached under the old contract.
 */
export function applyAmendmentAnswers(ctx: AmendmentAnswerScope, opts: { questionId?: string; snapshot?: PolicySnapshot } = {}): AppliedAmendmentAnswers {
  const only = opts.questionId === undefined ? null : amendmentIdOfQuestion(opts.questionId);
  const load = (): RunRow => {
    const row = ctx.db.get<RunRow>('SELECT contract_json, policy_path, policy_hash FROM runs WHERE id = ?', ctx.runId);
    if (!row) throw new OrbitError('NOT_FOUND', `no run ${ctx.runId}`);
    return row;
  };
  const outcomes: AmendmentAnswerOutcome[] = [];
  let changed = false;
  if (opts.questionId !== undefined && only === null) return { contract: parsed(load()), outcomes, changed };

  for (const rec of listAmendments(ctx.db, ctx.runId, { status: 'pending-approval' })) {
    if (only !== null && rec.id !== only) continue;
    const questionId = `${AMENDMENT_QUESTION_PREFIX}${rec.id}`;
    const outcome = (status: AmendmentAnswerStatus, detail: string | null = null): void => {
      outcomes.push({ amendmentId: rec.id, questionId, status, detail });
    };
    const q = findQuestion(ctx.db, questionId);
    if (!q || q.status !== 'answered') {
      outcome('unanswered');
      continue;
    }
    const decisionId = answerDecisionId(questionId);
    const d = getDecision(ctx.db, decisionId);
    const data = (d?.data ?? {}) as { chosen_option?: string | null; answered_by?: unknown };
    if (!d || d.kind !== ANSWER_DECISION_KIND || d.runId !== ctx.runId || typeof data.answered_by !== 'string' || !isHumanActor(data.answered_by)) {
      outcome('declined', 'the answer is not a recorded decision by a person');
      continue;
    }
    if (data.chosen_option !== 'Approve') {
      // Rejecting is the question's safe default: anything but "Approve" keeps the contract as the person approved it.
      ctx.db.tx(() => {
        resolveAmendment(ctx.db, rec.id, 'rejected', decisionId, ctx.clock);
      });
      outcome('rejected', data.chosen_option === 'Reject' ? null : 'the answer does not choose "Approve", so the contract is unchanged');
      continue;
    }

    let done = false;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS && !done; attempt++) {
      const row = load();
      if (row.contract_json === null) {
        outcome('deferred', 'the run has no contract yet');
        done = true;
        break;
      }
      let snapshot: PolicySnapshot;
      try {
        snapshot = opts.snapshot ?? verifySnapshot(row.policy_path, row.policy_hash);
      } catch (err) {
        outcome('refused', `the policy snapshot could not be verified: ${err instanceof Error ? err.message : String(err)}`);
        done = true;
        break;
      }
      const current = JSON.parse(row.contract_json) as GoalContract;
      try {
        const wrote = ctx.db.tx((): boolean => {
          const res = applyApprovedAmendment({ db: ctx.db, clock: ctx.clock, runId: ctx.runId, snapshot, contract: current }, rec.id, decisionId);
          const json = JSON.stringify(res.contract);
          if (json === row.contract_json) return true;
          const upd = ctx.db.run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ? AND contract_json = ?', json, hashObject(res.contract), ctx.runId, row.contract_json);
          // Thrown, not returned: the amendment row must roll back with the contract it did not reach.
          if (upd.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `the contract of run ${ctx.runId} changed while amendment ${rec.id} was applied`);
          invalidateEvidence(ctx.db, ctx.runId, `the contract changed: amendment ${rec.id} (${res.amendment.record.field}) was approved in ${decisionId}`, ctx.clock);
          appendEvent(ctx.db, ctx.runId, 'contract.amended', 'controller', { field: res.amendment.record.field, amendment_id: rec.id, approved_by: decisionId }, ctx.clock.now());
          changed = true;
          return true;
        });
        if (wrote) {
          outcome('applied');
          done = true;
        }
      } catch (err) {
        if (isOrbitError(err, 'CONCURRENT_UPDATE')) continue;
        if (!isOrbitError(err)) throw err;
        // The amendment no longer fits the contract (or the policy): it is closed, not left pending forever.
        const why = redact(err.message).slice(0, 500);
        if (getAmendment(ctx.db, rec.id).status === 'pending-approval') {
          ctx.db.tx(() => {
            resolveAmendment(ctx.db, rec.id, 'rejected', decisionId, ctx.clock);
            appendEvent(ctx.db, ctx.runId, 'amendment.apply-refused', 'controller', { amendment_id: rec.id, approved_by: decisionId, error: why }, ctx.clock.now());
          });
        }
        outcome('refused', why);
        done = true;
      }
    }
    if (!done) throw new OrbitError('CONCURRENT_UPDATE', `the contract of run ${ctx.runId} kept changing while amendment ${rec.id} was applied`, { amendmentId: rec.id });
  }

  const contract = parsed(load());
  // contract.json mirrors the row.
  if (contract && changed) atomicWriteJson(join(ctx.runDir, 'contract.json'), contract);
  return { contract, outcomes, changed };
}

function parsed(row: RunRow): GoalContract | null {
  return row.contract_json === null ? null : (JSON.parse(row.contract_json) as GoalContract);
}
