/**
 * One-shot authorization in supervised mode (spec section 5: supervised runs
 * ask before acting on what the policy does not authorize). An operation the
 * frozen policy denies is not simply denied: the controller persists a
 * question for a person, with the options approve-once or deny and the
 * operation in its evidence, and the run blocks on it. An answer of
 * approve-once from a person (inquisition/questions.isHumanActor) authorizes
 * that one operation for that one candidate tree, recorded as a decision. The
 * snapshot is never widened: every later check calls policy.authorize first
 * and only then looks for a grant that names exactly this operation and tree.
 *
 * The operations covered are the dependency changes the implementation-scope
 * gate refuses (a lockfile change, added packages). Delivery actions do not
 * arise in supervised mode: it delivers nothing outside the repository (the
 * reviewed candidate is left on a local branch), so there is no delivery
 * action to authorize there.
 */
import { canonicalJson, sha256 } from '../core/hash.ts';
import { authorize } from '../policy/authorize.ts';
import type { Operation, PolicySnapshot } from '../policy/types.ts';
import type { ScopeReport } from '../evidence/types.ts';
import { isHumanActor, persistQuestion } from '../inquisition/questions.ts';
import { findQuestion, type QuestionRecord } from '../inquisition/store.ts';
import { getDecision, listDecisions } from '../storage/decisions.ts';
import type { RunContext } from './context.ts';
import { decide } from './steps/common.ts';

export const APPROVE_ONCE = 'approve-once';
export const DENY = 'deny';
export const AUTHORIZATION_REQUEST_KIND = 'authorization.request';
export const AUTHORIZATION_GRANT_KIND = 'authorization.grant';

export interface GuardedOperation {
  op: Operation;
  /** Stable identity of the operation, for matching a grant to exactly it. */
  key: string;
  summary: string;
  /** Why the policy refused it. */
  denial: string;
}

export function operationKey(op: Operation): string {
  return `op-${sha256(canonicalJson(op)).slice(0, 16)}`;
}

/** The dependency changes in a scope report that the frozen policy does not authorize. */
export function deniedDependencyOperations(scope: ScopeReport, snapshot: PolicySnapshot): GuardedOperation[] {
  const out: GuardedOperation[] = [];
  const consider = (op: Operation, summary: string): void => {
    const d = authorize(snapshot, op);
    if (!d.allowed) out.push({ op, key: operationKey(op), summary, denial: `${d.rule}: ${d.reason}` });
  };
  if (scope.lockfile_changed) consider({ kind: 'dependency', change: 'change_lockfile', detail: 'lockfile changed by the candidate' }, 'change the dependency lockfile');
  if (scope.dependency_manifest_changed.length > 0) {
    const files = [...scope.dependency_manifest_changed].sort();
    consider({ kind: 'dependency', change: 'add_package', detail: files.join(', ') }, `change dependencies in ${files.join(', ')}`);
  }
  return out;
}

export type GrantState =
  | { state: 'granted'; decisionId: string; approvedBy: string; questionId: string }
  | { state: 'denied'; questionId: string; by: string | null }
  | { state: 'pending'; questionId: string }
  | { state: 'none' };

interface RequestData {
  question_id: string;
  op_key: string;
  tree_hash: string;
  operation: Operation;
}

function requests(ctx: RunContext): RequestData[] {
  return listDecisions(ctx.db, ctx.run.id, { kind: AUTHORIZATION_REQUEST_KIND }).map((d) => d.data as RequestData);
}

/**
 * Where the person's authorization of one operation on one tree stands. A grant counts only when the question
 * was answered approve-once by a human; any other answer, or an answer by a model or worker identity, is a denial.
 */
export function grantFor(ctx: RunContext, op: GuardedOperation, treeHash: string): GrantState {
  const req = requests(ctx).filter((r) => r.op_key === op.key && r.tree_hash === treeHash).at(-1);
  if (!req) return { state: 'none' };
  const q = findQuestion(ctx.db, req.question_id);
  if (!q || q.status === 'withdrawn') return { state: 'none' };
  if (q.status === 'open') return { state: 'pending', questionId: q.id };
  const by = q.answeredBy;
  if (q.answer !== APPROVE_ONCE || !by || !isHumanActor(by)) return { state: 'denied', questionId: q.id, by };
  const id = `dec-${ctx.run.id}-grant-${q.id}`;
  if (!getDecision(ctx.db, id)) {
    decide(ctx, { id, kind: AUTHORIZATION_GRANT_KIND, summary: `${by} authorized once: ${op.summary} (candidate tree ${treeHash.slice(0, 12)} only)`, data: { question_id: q.id, op_key: op.key, operation: op.op, tree_hash: treeHash, approved_by: by, policy_denial: op.denial } });
  }
  return { state: 'granted', decisionId: id, approvedBy: by, questionId: q.id };
}

/**
 * Is the operation allowed for this tree: by the frozen policy, or by a person's one-shot grant for exactly this
 * operation and tree. The policy is always asked first; a grant never applies to any other tree or operation.
 */
export function authorizedOnce(ctx: RunContext, op: GuardedOperation, treeHash: string): boolean {
  if (authorize(ctx.snapshot, op.op).allowed) return true;
  return grantFor(ctx, op, treeHash).state === 'granted';
}

/** Persist the authorization question for an operation on a tree (once) and record the request. */
export function requestAuthorization(ctx: RunContext, op: GuardedOperation, cand: { id: string; seq: number; treeHash: string }): QuestionRecord {
  const q = persistQuestion(
    ctx.db,
    ctx.run.id,
    'risk-review',
    {
      question: `May this run ${op.summary} for candidate ${cand.seq} (tree ${cand.treeHash.slice(0, 12)}), which the policy does not authorize?`,
      changes: ['authority'],
      evidence: [`the policy denies it: ${op.denial}`, `operation ${op.key}: ${JSON.stringify(op.op)}`, `the implementation-scope gate found this change in candidate ${cand.seq}; supervised mode asks instead of repairing it away`],
      options: [
        { label: APPROVE_ONCE, description: `Authorize this one operation for candidate ${cand.seq} only`, consequences: 'verification continues with the change; any other candidate or operation is asked about again' },
        { label: DENY, description: 'Keep the policy as it is and refuse the change', consequences: 'the change goes back to the implementer as a scope repair, or the run stops if no attempt is left' },
      ],
      recommendation: DENY,
      recommendation_reason: 'the frozen policy does not allow it; approve only when the dependency change is intended',
      safe_default: { exists: true, option: DENY, reason: 'denying keeps the authority the run started with' },
      material: true,
      affected_work: [`authorization ${op.key} for tree ${cand.treeHash.slice(0, 12)}`],
      unblocked_work: [],
    },
    ctx.clock,
    { actor: ctx.ownerId },
  ).question;
  const existing = requests(ctx).some((r) => r.question_id === q.id && r.tree_hash === cand.treeHash);
  if (!existing) {
    decide(ctx, { id: `dec-${ctx.run.id}-authreq-${op.key}-${cand.treeHash.slice(0, 12)}`, kind: AUTHORIZATION_REQUEST_KIND, summary: `asked a person to authorize once: ${op.summary} (candidate ${cand.seq})`, data: { question_id: q.id, op_key: op.key, tree_hash: cand.treeHash, candidate_id: cand.id, operation: op.op, policy_denial: op.denial } satisfies RequestData & Record<string, unknown> });
  }
  return q;
}

/** The scope report with the dependency changes a grant covers marked as authorized (the facts stay in `granted`). */
export function scopeWithGrants(scope: ScopeReport, granted: readonly GuardedOperation[]): ScopeReport {
  const lockfile = granted.some((g) => g.op.kind === 'dependency' && g.op.change === 'change_lockfile');
  const manifests = granted.some((g) => g.op.kind === 'dependency' && g.op.change === 'add_package');
  return { ...scope, lockfile_changed: lockfile ? false : scope.lockfile_changed, dependency_manifest_changed: manifests ? [] : scope.dependency_manifest_changed };
}
