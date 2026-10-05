/**
 * The delivery freshness gate (architecture "Evidence binding", scenario 10).
 * Delivery is allowed only for the exact tree that evidence and review
 * covered, under the exact policy that was frozen at run start. Anything else
 * is stale and authorizes nothing, however green it looked when it was made.
 *
 * Inputs are structural so the controller can pass its own records without
 * this module importing the controller.
 */
import type { PolicySnapshot } from '../policy/types.ts';
import { OrbitError } from '../core/errors.ts';
import { snapshotHash } from '../policy/snapshot.ts';
import { execCapture } from '../core/exec.ts';
import type { OrbitDb } from '../storage/db.ts';
import { gitEnv, isObjectId } from './git.ts';

export interface DeliveryRun {
  id: string;
  repoRoot: string;
  /** The task branch chosen at run start; defaults to `<branch_prefix><run id>`. */
  branch: string | null;
  baseRevision: string | null;
  /** `runs.policy_hash`. */
  policyHash: string;
  cancelRequested?: boolean;
  goal?: string;
}

export interface DeliveryCandidate {
  id: string;
  commitSha: string;
  treeHash: string;
  parentSha: string;
}

export interface DeliveryEvidence {
  /** `evidence_reports.id`. Without it the newest recorded report for the candidate's tree is re-read. */
  id?: string;
  candidateId: string;
  treeHash: string;
  policyHash: string;
  checkConfigHash?: string;
  /** 'PASS' is the only verdict that can authorize delivery. */
  verdict: string;
  invalidatedAt?: number | null;
}

export interface DeliveryReview {
  /** `reviews.id`. Without it the newest live recorded review of the candidate's tree is re-read. */
  id?: string;
  candidateId: string;
  treeHash: string;
  /** 'APPROVE' is the only verdict that can authorize delivery. */
  verdict: string;
  invalidatedAt?: number | null;
}

export interface GateInput {
  run: DeliveryRun;
  candidate: DeliveryCandidate;
  evidence: DeliveryEvidence;
  review: DeliveryReview;
  snapshot: PolicySnapshot;
  /** The tree of the worktree as it is now, when the controller re-captured it; must equal the reviewed tree. */
  currentTree?: string;
  /** The check-configuration hash the controller computes now; must equal what the evidence recorded. */
  expectedCheckConfigHash?: string;
}

/** Throws STALE_EVIDENCE (or POLICY_TAMPERED / CANCELLED) unless every binding holds. Pure: no I/O. */
export function assertDeliverable(input: GateInput): void {
  const { run, candidate, evidence, review, snapshot } = input;
  if (run.cancelRequested) throw new OrbitError('CANCELLED', `run ${run.id} has a durable cancellation request; nothing is delivered`, { definitive: true });

  const live = snapshotHash(snapshot);
  if (live !== run.policyHash) {
    throw new OrbitError('POLICY_TAMPERED', 'the policy snapshot in hand does not match the hash recorded for the run', { definitive: true });
  }

  const problems: string[] = [];
  if (!isObjectId(candidate.treeHash)) problems.push('the candidate has no valid tree hash');
  if (evidence.verdict !== 'PASS') problems.push(`evidence verdict is ${evidence.verdict}, not PASS`);
  if (evidence.invalidatedAt) problems.push('evidence was invalidated');
  if (evidence.candidateId !== candidate.id) problems.push('evidence belongs to a different candidate');
  if (evidence.treeHash !== candidate.treeHash) problems.push(`evidence covers tree ${short(evidence.treeHash)}, the candidate is ${short(candidate.treeHash)}`);
  if (evidence.policyHash !== live) problems.push('evidence was produced under a different policy snapshot');
  if (input.expectedCheckConfigHash !== undefined && evidence.checkConfigHash !== input.expectedCheckConfigHash) {
    problems.push('evidence was produced with a different check configuration');
  }
  if (review.verdict !== 'APPROVE') problems.push(`review verdict is ${review.verdict}, not APPROVE`);
  if (review.invalidatedAt) problems.push('the review was invalidated');
  if (review.candidateId !== candidate.id) problems.push('the review belongs to a different candidate');
  if (review.treeHash !== candidate.treeHash) problems.push(`the review covers tree ${short(review.treeHash)}, the candidate is ${short(candidate.treeHash)}`);
  if (input.currentTree !== undefined && input.currentTree !== candidate.treeHash) {
    problems.push(`the worktree now has tree ${short(input.currentTree)}, not the reviewed ${short(candidate.treeHash)}`);
  }
  if (problems.length > 0) {
    throw new OrbitError('STALE_EVIDENCE', `delivery refused: ${problems.join('; ')}`, { problems, candidateId: candidate.id, definitive: true });
  }
}

interface EvidenceRow {
  id: string;
  candidate_id: string;
  tree_hash: string;
  policy_hash: string;
  check_config_hash: string;
  verdict: string;
  invalidated_at: number | null;
  invalidated_reason: string | null;
}

interface ReviewRow {
  id: string;
  candidate_id: string;
  tree_hash: string;
  verdict: string;
  invalidated_at: number | null;
}

/**
 * The same bindings, re-read from the recorded state rather than taken from
 * the objects the caller holds. Those objects were read when delivery began;
 * a check run, a review or a cancellation recorded since then (while a retry
 * waited, say) must stop the next external action. A report or review that
 * has no row at all authorizes nothing.
 */
export function assertRecordedBindings(db: OrbitDb, input: Pick<GateInput, 'run' | 'candidate' | 'evidence' | 'review' | 'snapshot'>): void {
  const { run, candidate, evidence, review } = input;
  const runRow = db.get<{ policy_hash: string; cancel_requested: number }>('SELECT policy_hash, cancel_requested FROM runs WHERE id = ?', run.id);
  if (!runRow) throw new OrbitError('NOT_FOUND', `no run ${run.id} is recorded`, { definitive: true });
  if (runRow.cancel_requested) throw new OrbitError('CANCELLED', `run ${run.id} has a durable cancellation request; nothing is delivered`, { definitive: true });
  const live = snapshotHash(input.snapshot);
  if (runRow.policy_hash !== live) throw new OrbitError('POLICY_TAMPERED', 'the policy snapshot in hand does not match the hash recorded for the run', { definitive: true });

  const problems: string[] = [];
  const ev = evidence.id
    ? db.get<EvidenceRow>('SELECT * FROM evidence_reports WHERE id = ? AND run_id = ?', evidence.id, run.id)
    : db.get<EvidenceRow>('SELECT * FROM evidence_reports WHERE run_id = ? AND candidate_id = ? AND tree_hash = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', run.id, candidate.id, candidate.treeHash);
  if (!ev) problems.push(`no recorded evidence ${evidence.id ?? `for candidate ${candidate.id}`}`);
  else {
    if (ev.invalidated_at !== null) problems.push(`recorded evidence ${ev.id} was invalidated${ev.invalidated_reason ? `: ${ev.invalidated_reason}` : ''}`);
    if (ev.verdict !== 'PASS') problems.push(`recorded evidence ${ev.id} has verdict ${ev.verdict}, not PASS`);
    if (ev.candidate_id !== candidate.id || ev.tree_hash !== candidate.treeHash) problems.push(`recorded evidence ${ev.id} covers another candidate or tree`);
    if (ev.policy_hash !== live) problems.push(`recorded evidence ${ev.id} was produced under a different policy snapshot`);
    if (evidence.checkConfigHash !== undefined && ev.check_config_hash !== evidence.checkConfigHash) problems.push(`recorded evidence ${ev.id} has a different check configuration`);
  }
  const rv = review.id
    ? db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ? AND run_id = ?', review.id, run.id)
    : db.get<ReviewRow>('SELECT * FROM reviews WHERE run_id = ? AND candidate_id = ? AND tree_hash = ? AND invalidated_at IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1', run.id, candidate.id, candidate.treeHash);
  if (!rv) problems.push(`no recorded review ${review.id ?? `of candidate ${candidate.id}`}`);
  else {
    if (rv.invalidated_at !== null) problems.push(`recorded review ${rv.id} was invalidated`);
    if (rv.verdict !== 'APPROVE') problems.push(`recorded review ${rv.id} has verdict ${rv.verdict}, not APPROVE`);
    if (rv.candidate_id !== candidate.id || rv.tree_hash !== candidate.treeHash) problems.push(`recorded review ${rv.id} covers another candidate or tree`);
  }
  if (problems.length > 0) {
    throw new OrbitError('STALE_EVIDENCE', `delivery refused: ${problems.join('; ')}`, { problems, candidateId: candidate.id, definitive: true });
  }
}

/** The candidate commit really carries the reviewed tree (a commit's tree cannot change, but the record could be wrong). */
export async function verifyCandidateTree(repoRoot: string, candidate: DeliveryCandidate): Promise<void> {
  if (!isObjectId(candidate.commitSha)) throw new OrbitError('STALE_EVIDENCE', 'the candidate has no valid commit', { definitive: true });
  const res = await execCapture(['git', 'rev-parse', `${candidate.commitSha}^{tree}`], { cwd: repoRoot, env: gitEnv(), timeoutMs: 30_000 });
  const tree = res.stdout.trim();
  if (res.exitCode !== 0 || tree !== candidate.treeHash) {
    throw new OrbitError('STALE_EVIDENCE', `delivery refused: candidate commit ${short(candidate.commitSha)} has tree ${short(tree)}, the reviewed tree is ${short(candidate.treeHash)}`, {
      definitive: true,
      candidateId: candidate.id,
    });
  }
}

function short(s: string): string {
  return typeof s === 'string' ? s.slice(0, 12) : String(s);
}
