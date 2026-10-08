/**
 * The git refs a run has actually left in the repository, for `orbit status` and the final report to name.
 *
 * PREFLIGHT chooses the task branch name (`orbit/<run>`) and records it on the run, but the branch only exists once the
 * reviewed candidate is delivered: a local mode points it at the candidate at DELIVERING, a delivery mode pushes it. A
 * run that ended before then has no such branch, and naming it sent a person to look for something that was never made
 * (issue #33). What it does have, once a candidate was snapshotted, is that candidate, pinned under
 * `refs/orbit/<run>/candidates/<seq>` (evidence/candidate.ts), which outlives the run's checkout.
 */
import { candidateRef } from '../evidence/candidate.ts';
import { listDecisions } from '../storage/decisions.ts';
import type { OrbitDb } from '../storage/db.ts';
import { currentCandidate } from './context.ts';
import type { RunRecord } from './run-store.ts';

/**
 * The branch a run created, or null when delivery has not created one: from the outcome of a local delivery, the branch a
 * successful push recorded (a delivery can fail after the push, at the pull request or the gate, before it records the
 * delivery), or the run's own branch once the run succeeded (which only happens after the branch was made) or a delivery
 * was recorded. A local delivery makes the branch only after its gate passed, so a refused one leaves none.
 */
export function createdBranch(db: OrbitDb, run: Pick<RunRecord, 'id' | 'state' | 'branch' | 'outcomeJson'>): string | null {
  try {
    const outcome = run.outcomeJson ? (JSON.parse(run.outcomeJson) as { branch?: unknown }) : null;
    if (typeof outcome?.branch === 'string' && outcome.branch !== '') return outcome.branch;
  } catch {
    /* an unreadable outcome says nothing about a branch */
  }
  const pushed = pushedBranch(db, run.id);
  if (pushed !== null) return pushed;
  if (run.branch === null) return null;
  return run.state === 'SUCCEEDED' || listDecisions(db, run.id, { kind: 'delivery.completed' }).length > 0 ? run.branch : null;
}

/** The branch the run's latest successful push (delivery/deliver.ts records its ref) left on the remote, or null. */
function pushedBranch(db: OrbitDb, runId: string): string | null {
  const row = db.get<{ target_json: string }>("SELECT target_json FROM actions WHERE run_id = ? AND kind = 'push' AND state = 'SUCCEEDED' ORDER BY created_at DESC, id DESC LIMIT 1", runId);
  if (!row) return null;
  try {
    const ref = (JSON.parse(row.target_json) as { ref?: unknown }).ref;
    return typeof ref === 'string' && ref.startsWith('refs/heads/') && ref.length > 'refs/heads/'.length ? ref.slice('refs/heads/'.length) : null;
  } catch {
    return null;
  }
}

/** The ref that pins the run's current candidate, or null before one was snapshotted. */
export function currentCandidateRef(db: OrbitDb, runId: string): string | null {
  const cand = currentCandidate(db, runId);
  return cand === null ? null : candidateRef(runId, cand.seq);
}
