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
 * Two kinds of operation are covered:
 *
 * - dependency changes the implementation-scope gate refuses (a lockfile
 *   change, added packages): the grant names the operation and the candidate
 *   tree;
 * - action-class operations denied inside a worker session (the guard hook's
 *   `actions.*` and `network.*` rules, recorded by controller/denials as
 *   `policy.deny`): a `chmod +x`, a host outside network.allowed_hosts. The
 *   grant names the operation and the implementation attempt. The retried
 *   session of that attempt runs under a grant policy: a copy of the frozen
 *   snapshot widened by exactly what the granted operations need (that host;
 *   that action), written read-only into the session's own directory and
 *   hashed, so the worker's guard hook and sandbox allow it. The run's own
 *   snapshot never changes, and after the session the controller re-reads its
 *   transcript and refuses the attempt as a policy violation if any command
 *   ran that the frozen policy denies and no grant names exactly
 *   (`ungrantedCommands`).
 *
 * Delivery actions do not arise in supervised mode: it delivers nothing
 * outside the repository (the reviewed candidate is left on a local branch),
 * so there is no delivery action to authorize there.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson, sha256 } from '../core/hash.ts';
import { atomicWrite } from '../core/fsx.ts';
import { authorize } from '../policy/authorize.ts';
import { snapshotHash } from '../policy/snapshot.ts';
import type { Operation, OrbitConfig, PolicySnapshot } from '../policy/types.ts';
import type { ScopeReport } from '../evidence/types.ts';
import { isHumanActor, persistQuestion } from '../inquisition/questions.ts';
import type { InquisitorQuestion } from '../inquisition/types.ts';
import { findQuestion, type QuestionRecord } from '../inquisition/store.ts';
import { getDecision, listDecisions } from '../storage/decisions.ts';
import type { WorkerRecord } from '../storage/workers.ts';
import { readLogLines } from '../adapters/supervise.ts';
import { LOG_FILE } from '../adapters/shim.ts';
import type { RunContext } from './context.ts';
import { decide } from './steps/common.ts';
import { denialTarget, denialsFromTranscript } from './denials.ts';

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
  /** The policy rule that refused it (worker denials: `actions.<name>` or `network.<...>`). */
  rule?: string;
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
  /** Dependency changes: the candidate tree the grant is for. */
  tree_hash?: string;
  /** What a grant is for: the tree hash, or `attempt:<n>` for an operation denied inside a worker session. */
  subject?: string;
  attempt?: number;
  operation: Operation;
}

function requests(ctx: RunContext): RequestData[] {
  return listDecisions(ctx.db, ctx.run.id, { kind: AUTHORIZATION_REQUEST_KIND }).map((d) => d.data as RequestData);
}

/** The grant subject of an operation denied inside a session of implementation attempt `n`. */
export function attemptSubject(n: number): string {
  return `attempt:${n}`;
}

/**
 * Where the person's authorization of one operation for one subject (a candidate tree, or an implementation
 * attempt from attemptSubject) stands. A grant counts only when the question was answered approve-once by a
 * human; any other answer, or an answer by a model or worker identity, is a denial.
 */
export function grantFor(ctx: RunContext, op: GuardedOperation, subject: string): GrantState {
  const req = requests(ctx).filter((r) => r.op_key === op.key && (r.subject ?? r.tree_hash) === subject).at(-1);
  if (!req) return { state: 'none' };
  const q = findQuestion(ctx.db, req.question_id);
  if (!q || q.status === 'withdrawn') return { state: 'none' };
  if (q.status === 'open') return { state: 'pending', questionId: q.id };
  const by = q.answeredBy;
  if (q.answer !== APPROVE_ONCE || !by || !isHumanActor(by)) return { state: 'denied', questionId: q.id, by };
  const id = `dec-${ctx.run.id}-grant-${q.id}`;
  if (!getDecision(ctx.db, id)) {
    const forAttempt = req.attempt !== undefined;
    const what = forAttempt ? `implementation attempt ${req.attempt} only` : `candidate tree ${subject.slice(0, 12)} only`;
    const where = forAttempt ? { attempt: req.attempt, subject } : { tree_hash: subject };
    decide(ctx, { id, kind: AUTHORIZATION_GRANT_KIND, summary: `${by} authorized once: ${op.summary} (${what})`, data: { question_id: q.id, op_key: op.key, operation: op.op, ...where, approved_by: by, policy_denial: op.denial } });
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
  return ask(
    ctx,
    op,
    {
      question: `May this run ${op.summary} for candidate ${cand.seq} (tree ${cand.treeHash.slice(0, 12)}), which the policy does not authorize?`,
      evidence: [`the policy denies it: ${op.denial}`, `operation ${op.key}: ${JSON.stringify(op.op)}`, `the implementation-scope gate found this change in candidate ${cand.seq}; supervised mode asks instead of repairing it away`],
      approve: { description: `Authorize this one operation for candidate ${cand.seq} only`, consequences: 'verification continues with the change; any other candidate or operation is asked about again' },
      deny: 'the change goes back to the implementer as a scope repair, or the run stops if no attempt is left',
      recommendationReason: 'the frozen policy does not allow it; approve only when the dependency change is intended',
      affected: `authorization ${op.key} for tree ${cand.treeHash.slice(0, 12)}`,
    },
    { id: `dec-${ctx.run.id}-authreq-${op.key}-${cand.treeHash.slice(0, 12)}`, summary: `asked a person to authorize once: ${op.summary} (candidate ${cand.seq})`, data: { tree_hash: cand.treeHash, subject: cand.treeHash, candidate_id: cand.id } },
  );
}

/** Persist the authorization question for an operation a worker session of attempt `n` was denied (once) and record the request. */
export function requestAttemptAuthorization(ctx: RunContext, op: GuardedOperation, n: number, worker: Pick<WorkerRecord, 'id' | 'role'>): QuestionRecord {
  const subject = attemptSubject(n);
  return ask(
    ctx,
    op,
    {
      question: `May the ${worker.role} of implementation attempt ${n} ${op.summary}, which the policy does not authorize?`,
      evidence: [`the policy denies it: ${op.denial}`, `operation ${op.key}: ${JSON.stringify(op.op)}`, `the guard refused it inside worker ${worker.id} (attempt ${n}); supervised mode asks instead of only denying it`],
      approve: { description: `Authorize this one operation for implementation attempt ${n} only`, consequences: 'the attempt is retried with exactly this operation allowed; any other operation or attempt is asked about again' },
      deny: 'the attempt is retried as a scope repair: the implementer finishes the work without the operation',
      recommendationReason: 'the frozen policy does not allow it; approve only when the operation is intended and needed',
      affected: `authorization ${op.key} for attempt ${n}`,
    },
    { id: `dec-${ctx.run.id}-authreq-${op.key}-a${n}`, summary: `asked a person to authorize once: ${op.summary} (attempt ${n})`, data: { subject, attempt: n, worker_id: worker.id } },
  );
}

interface AskText {
  question: string;
  evidence: string[];
  approve: { description: string; consequences: string };
  deny: string;
  recommendationReason: string;
  affected: string;
}

function ask(ctx: RunContext, op: GuardedOperation, text: AskText, request: { id: string; summary: string; data: Omit<RequestData, 'question_id' | 'op_key' | 'operation'> & Record<string, unknown> }): QuestionRecord {
  const q: InquisitorQuestion = {
    question: text.question,
    changes: ['authority'],
    evidence: text.evidence,
    options: [
      { label: APPROVE_ONCE, description: text.approve.description, consequences: text.approve.consequences },
      { label: DENY, description: 'Keep the policy as it is and refuse the operation', consequences: text.deny },
    ],
    recommendation: DENY,
    recommendation_reason: text.recommendationReason,
    safe_default: { exists: true, option: DENY, reason: 'denying keeps the authority the run started with' },
    material: true,
    affected_work: [text.affected],
    unblocked_work: [],
  };
  const question = persistQuestion(ctx.db, ctx.run.id, 'risk-review', q, ctx.clock, { actor: ctx.ownerId }).question;
  const subject = request.data.subject ?? request.data.tree_hash;
  const existing = requests(ctx).some((r) => r.question_id === question.id && (r.subject ?? r.tree_hash) === subject);
  if (!existing) {
    decide(ctx, { id: request.id, kind: AUTHORIZATION_REQUEST_KIND, summary: request.summary, data: { question_id: question.id, op_key: op.key, operation: op.op, policy_denial: op.denial, ...request.data } });
  }
  return question;
}

/** The scope report with the dependency changes a grant covers marked as authorized (the facts stay in `granted`). */
export function scopeWithGrants(scope: ScopeReport, granted: readonly GuardedOperation[]): ScopeReport {
  const lockfile = granted.some((g) => g.op.kind === 'dependency' && g.op.change === 'change_lockfile');
  const manifests = granted.some((g) => g.op.kind === 'dependency' && g.op.change === 'add_package');
  return { ...scope, lockfile_changed: lockfile ? false : scope.lockfile_changed, dependency_manifest_changed: manifests ? [] : scope.dependency_manifest_changed };
}

// ---------------------------------------------------------------------------
// Operations denied inside a worker session

/** Action-class rules a person may authorize once; everything else the guard denies stays denied. */
const ASKABLE_RULE = /^(?:actions|network)\./;
/** Never grantable: the policy type itself pins it off. */
const NEVER_GRANTED = new Set(['actions.change_secrets']);
const URL_HOST = /\bhttps?:\/\/([A-Za-z0-9.-]+)/;

interface DenyData {
  source?: string;
  worker_id?: string;
  tool?: string;
  rule?: string;
  target?: string | null;
  reason?: string | null;
}

/**
 * The action-class operations the guard denied inside one worker session (recorded as `policy.deny` by
 * controller/denials), as operations a person can be asked about. Each is checked against the frozen policy
 * again: one the policy allows after all is not asked about. An operation whose target the transcript does not
 * show, or a network denial with no recognizable host, cannot be named exactly and is left denied.
 */
export function deniedWorkerOperations(ctx: RunContext, worker: Pick<WorkerRecord, 'id' | 'cwd'>): GuardedOperation[] {
  const out = new Map<string, GuardedOperation>();
  for (const d of listDecisions(ctx.db, ctx.run.id, { kind: 'policy.deny' })) {
    const data = (d.data ?? {}) as DenyData;
    if (data.worker_id !== worker.id || data.source !== 'guard-hook') continue;
    const rule = data.rule ?? '';
    if (!ASKABLE_RULE.test(rule) || NEVER_GRANTED.has(rule) || !data.target) continue;
    const host = URL_HOST.exec(data.target)?.[1]?.toLowerCase() ?? null;
    let op: Operation;
    let summary: string;
    if (data.tool === 'Bash') {
      if (rule.startsWith('network.') && !host) continue;
      op = { kind: 'bash', command: data.target };
      summary = `run \`${data.target}\``;
    } else if (rule.startsWith('network.') && host) {
      op = { kind: 'network', host };
      summary = `reach ${host}`;
    } else continue;
    const now = authorize(ctx.snapshot, op, { worktreeRoot: worker.cwd });
    if (now.allowed) continue;
    const key = operationKey(op);
    if (!out.has(key)) out.set(key, { op, key, summary, denial: `${rule}: ${data.reason ?? now.reason}`, rule });
  }
  return [...out.values()];
}

export const GRANT_POLICY_FILE = 'policy-grant.json';

/**
 * The policy a session runs under when a person authorized operations once for its attempt: the frozen snapshot
 * widened by exactly what each granted operation needs (`actions.<name>` for an action rule, the one host for a
 * network rule), written read-only into the session's directory. The run's snapshot is not touched.
 */
export function grantPolicy(ctx: RunContext, granted: readonly GuardedOperation[], dir: string): { path: string; hash: string; snapshot: PolicySnapshot } {
  const snapshot = JSON.parse(JSON.stringify(ctx.snapshot)) as PolicySnapshot;
  const config = snapshot.config as OrbitConfig;
  for (const g of granted) {
    const rule = g.rule ?? '';
    if (rule.startsWith('actions.') && !NEVER_GRANTED.has(rule)) {
      const name = rule.slice('actions.'.length).split('.')[0] as keyof OrbitConfig['actions'];
      if (name !== 'change_secrets' && Object.hasOwn(config.actions, name)) (config.actions as Record<string, boolean>)[name] = true;
    } else if (rule.startsWith('network.')) {
      const host = g.op.kind === 'network' ? g.op.host : g.op.kind === 'bash' ? (URL_HOST.exec(g.op.command)?.[1]?.toLowerCase() ?? null) : null;
      if (host && !config.network.allowed_hosts.includes(host)) config.network.allowed_hosts = [...config.network.allowed_hosts, host];
    }
  }
  const path = join(dir, GRANT_POLICY_FILE);
  const hash = snapshotHash(snapshot);
  if (!existsSync(path)) atomicWrite(path, `${JSON.stringify(snapshot, null, 2)}\n`, 0o444);
  return { path, hash, snapshot };
}

/**
 * Commands a session ran (the guard did not deny them) that the frozen policy denies under an action-class rule
 * and no grant names exactly. A session under a grant policy may only do what the person authorized; anything
 * else it did with the widened policy is a policy violation. Returned redacted, as the denials record them.
 */
export function ungrantedCommands(events: readonly Record<string, unknown>[], snapshot: PolicySnapshot, worktreeRoot: string, granted: readonly GuardedOperation[]): string[] {
  const denied = new Set(denialsFromTranscript(events).map((d) => d.toolUseId));
  const out: string[] = [];
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const message = e.message as { content?: unknown } | undefined;
    const content = Array.isArray(message?.content) ? (message.content as Record<string, unknown>[]) : [];
    for (const b of content) {
      if (!b || b.type !== 'tool_use' || typeof b.id !== 'string' || denied.has(b.id)) continue;
      const input = (b.input ?? {}) as Record<string, unknown>;
      let op: Operation | null = null;
      if (b.name === 'Bash' && typeof input.command === 'string') op = { kind: 'bash', command: input.command };
      else if (typeof input.url === 'string') {
        const host = URL_HOST.exec(input.url)?.[1]?.toLowerCase();
        if (host) op = { kind: 'network', host };
      }
      if (!op) continue;
      const d = authorize(snapshot, op, { worktreeRoot });
      if (d.allowed || !ASKABLE_RULE.test(d.rule)) continue;
      const shown = op.kind === 'bash' ? denialTarget(op.command) : op.host;
      const named = granted.some((g) => (op.kind === 'bash' && g.op.kind === 'bash' && g.op.command === shown) || (op.kind === 'network' && g.op.kind === 'network' && g.op.host === op.host));
      if (!named) out.push(shown);
    }
  }
  return out;
}

/** The transcript events of a finished session, for ungrantedCommands. */
export function sessionEvents(worker: Pick<WorkerRecord, 'workerDir'>): Record<string, unknown>[] {
  const path = join(worker.workerDir, LOG_FILE);
  return existsSync(path) ? readLogLines(path).events : [];
}
