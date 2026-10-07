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
 *   grant names the operation and the implementation attempt. A grant never
 *   widens the worker's sandbox, hook policy or action flags: the controller
 *   runs exactly the approved command itself, once, in isolation, records it
 *   as an action (`approved_command` in the action ledger) and hands the
 *   retried session its output as an artifact (`runApprovedOperation`). The
 *   retried session runs under the run's frozen snapshot, and afterwards the
 *   controller re-reads its transcript and refuses the attempt as a policy
 *   violation if any command ran that the frozen policy denies
 *   (`ungrantedCommands`).
 *
 * Delivery actions do not arise in supervised mode: it delivers nothing
 * outside the repository (the reviewed candidate is left on a local branch),
 * so there is no delivery action to authorize there.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { canonicalJson, sha256 } from '../core/hash.ts';
import { atomicWrite, readJsonIfExists } from '../core/fsx.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';
import { redact } from '../core/redact.ts';
import { authorize } from '../policy/authorize.ts';
import type { CheckDefinition, Operation, PolicySnapshot } from '../policy/types.ts';
import { prepareWorkerTmpDir, profileForCheck } from '../isolation/profiles.ts';
import { commandToolchains, detectToolchains, prepareToolchainLayout, removeScratch, TOOLCHAIN_PROFILES, type ToolchainId } from '../isolation/toolchains.ts';
import { classifyBash } from '../policy/bash.ts';
import { msbuildNodeDenialNote, msbuildNodeFix, nodeDenialSubject, runStoppingRefusedNodes } from '../evidence/msbuild.ts';
import { privateHomeDotnetEnv } from '../evidence/runner.ts';
import { ActionLedger } from '../delivery/actions.ts';
import type { ScopeReport } from '../evidence/types.ts';
import { isHumanActor, persistQuestion } from '../inquisition/questions.ts';
import type { InquisitorQuestion } from '../inquisition/types.ts';
import { findQuestion, type QuestionRecord } from '../inquisition/store.ts';
import { getDecision, listDecisions } from '../storage/decisions.ts';
import type { WorkerRecord } from '../storage/workers.ts';
import { readLogLines } from '../adapters/supervise.ts';
import { LOG_FILE } from '../adapters/shim.ts';
import { homeOf, toolchainCacheRootFor, type RunContext } from './context.ts';
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
  /** A network operation of a fetch tool: the exact URL it was denied, which is what an approval lets the controller fetch. */
  target?: string;
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
    if (!out.has(key)) out.set(key, { op, key, summary, denial: `${rule}: ${data.reason ?? now.reason}`, rule, ...(op.kind === 'network' ? { target: data.target } : {}) });
  }
  return [...out.values()];
}

// ---------------------------------------------------------------------------
// Approved operations, run by the controller

/** The action-ledger kind of an approved command the controller ran on a worker's behalf. */
export const APPROVED_COMMAND_ACTION = 'approved_command';
const APPROVED_TIMEOUT_S = 300;
const APPROVED_MAX_OUTPUT_BYTES = 1024 * 1024;
const APPROVED_EXCERPT_CHARS = 4_000;
const OUTPUT_FILE = 'output.txt';
const RECEIPT_FILE = 'receipt.json';

/** What became of one approved operation: the controller ran it (once) and where its output is. */
export interface ApprovedRun {
  key: string;
  /** The exact command that ran, as the person approved it; null when nothing could be run. */
  command: string | null;
  state: 'SUCCEEDED' | 'UNKNOWN' | 'NOT_RUN';
  exit_code: number | null;
  timed_out: boolean;
  /** The output artifact, relative to the run directory. */
  path: string | null;
  sha256: string | null;
  /** The tail of the (redacted) output. Untrusted: it is command output. */
  excerpt: string | null;
  note: string | null;
}

interface ApprovedReceipt {
  exit_code: number | null;
  timed_out: boolean;
  path: string;
  sha256: string;
  excerpt: string;
}

/** The exact argv an approval covers, with the one host it may reach; null when the operation names no command. */
function approvedPlan(op: GuardedOperation): { argv: string[]; shown: string; host: string | null } | null {
  const network = (op.rule ?? '').startsWith('network.');
  if (op.op.kind === 'bash') return { argv: ['/bin/sh', '-c', op.op.command], shown: op.op.command, host: network ? (URL_HOST.exec(op.op.command)?.[1]?.toLowerCase() ?? null) : null };
  if (op.op.kind === 'network' && op.target && URL_HOST.exec(op.target)?.[1]?.toLowerCase() === op.op.host) {
    return { argv: ['curl', '-sS', '--proto', '=http,https', '--max-time', String(APPROVED_TIMEOUT_S), '--', op.target], shown: `fetch ${op.target}`, host: op.op.host };
  }
  return null;
}

/**
 * Run one operation a person approved once for attempt `n`, as the controller, never through the worker. Exactly
 * the approved command runs, once, in the run's worktree under the configured isolation: the frozen policy's
 * hosts plus only the approved host, a private home and temp directory, and the check profile's read denials.
 * It is an action in the ledger (kind `approved_command`, one attempt): a restarted controller finds the recorded
 * receipt, and a run whose outcome was lost is reported as unknown and never repeated. The output is redacted
 * and stored as an artifact under the run directory for the retried session.
 */
export async function runApprovedOperation(ctx: RunContext, n: number, op: GuardedOperation, grant: { decisionId: string; approvedBy: string }): Promise<ApprovedRun> {
  const plan = approvedPlan(op);
  const none: Omit<ApprovedRun, 'state' | 'note'> = { key: op.key, command: plan?.shown ?? null, exit_code: null, timed_out: false, path: null, sha256: null, excerpt: null };
  if (!plan) return { ...none, state: 'NOT_RUN', note: 'the approval names a host but no exact command or address, so the controller had nothing exact to run' };
  const rel = join('authorization', `attempt-${n}`, op.key);
  const dir = join(ctx.runDir, rel);
  const ledger = new ActionLedger(ctx.db, ctx.clock, { runDir: ctx.runDir, maxAttempts: 1, actor: ctx.ownerId });
  const recorded = (): ApprovedReceipt | null => readJsonIfExists<ApprovedReceipt>(join(dir, RECEIPT_FILE));
  try {
    const done = await ledger.performAction<ApprovedReceipt>(
      { runId: ctx.run.id, kind: APPROVED_COMMAND_ACTION, idempotencyKey: `${ctx.run.id}:approved:${n}:${op.key}`, target: { command: plan.shown, attempt: n, op_key: op.key, grant: grant.decisionId } },
      {
        execute: () => executeApproved(ctx, plan, dir, rel),
        // Only the receipt written after the command finished proves it ran; without it the command is not run again.
        reconcile: async () => {
          const r = recorded();
          if (r) return r;
          throw new OrbitError('INTERNAL', 'the approved command may have started before the controller stopped; it is not run a second time', { definitive: true });
        },
      },
      { authorization: { allowed: true, rule: 'authorization.grant', reason: `approved once by ${grant.approvedBy} (${grant.decisionId}) for attempt ${n}` } },
    );
    const r = done.receipt;
    return { ...none, state: 'SUCCEEDED', exit_code: r.exit_code, timed_out: r.timed_out, path: r.path, sha256: r.sha256, excerpt: r.excerpt, note: null };
  } catch (err) {
    if (isOrbitError(err, 'CANCELLED') || isOrbitError(err, 'LEASE_LOST') || isOrbitError(err, 'CONCURRENT_UPDATE')) throw err;
    return { ...none, state: 'UNKNOWN', note: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

/**
 * The toolchains an approved command installs packages with (`dotnet add package`, `cargo fetch`, `pip install`, `go
 * get`), of those it uses: for them the approved operation is the install, and may write the repository's dependency
 * cache as Orbit's install step does (docs/decisions/0009-toolchain-profiles.md, addendum, items 14 and 16). Only theirs:
 * a review of #26 found that an approved `pip install` in a repository with a go.mod made the Go module cache writable
 * too, for every later run of the repository.
 */
function installingToolchains(command: string, worktree: string, toolchains: readonly ToolchainId[]): ToolchainId[] {
  const installs = classifyBash(command, { cwd: worktree, root: worktree }).commands.filter((c) => c.category === 'package-install');
  return toolchains.filter((id) => installs.some((c) => TOOLCHAIN_PROFILES[id].executables.test(basename(c.argv[0] ?? ''))));
}

/** What an approved command's output says of its toolchains' caches, or nothing for a command that uses none. */
function cachesLine(toolchains: readonly ToolchainId[], installs: readonly ToolchainId[]): string {
  if (toolchains.length === 0) return '';
  const own = "the repository's read-only, caches of the command's own writable";
  if (installs.length === 0) return `[toolchains ${toolchains.join(', ')}: ${own}]\n`;
  const many = installs.length > 1;
  const others = toolchains.length > installs.length ? `; for the others ${own}` : '';
  return `[toolchains ${toolchains.join(', ')}: the repository's dependency cache${many ? 's' : ''} of ${installs.join(' and ')} writable, since the command installs ${many ? 'their' : 'its'} packages${others}]\n`;
}

async function executeApproved(ctx: RunContext, plan: { argv: string[]; shown: string; host: string | null }, dir: string, rel: string): Promise<ApprovedReceipt> {
  const worktree = ctx.run.worktreePath!;
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const tmp = prepareWorkerTmpDir(dir);
  const hosts = [...new Set([...ctx.snapshot.config.network.allowed_hosts, ...(plan.host ? [plan.host] : [])])];
  const isolation = ctx.isolation();
  // The toolchain profile (ADR 0009, addendum, items 14 and 16): caches of its own, which it fills on its hosts as it did
  // with the private HOME it had before, the repository's read-only beneath them where the tool reads a second cache,
  // and writable only for a toolchain the approved command installs packages with; build state private to this command;
  // and for .NET the NIS domain name rule, a home prepared as a check's and the runner's early stop for a refused MSBuild
  // worker node. Its network is exactly the frozen policy's hosts and the approved one, which decides NuGet's audit.
  const ids = detectToolchains({ command: plan.argv, roots: [worktree] });
  const installs = plan.argv[0] === '/bin/sh' ? installingToolchains(plan.shown, worktree, ids) : [];
  const scratch = join(dir, 'toolchains');
  const toolchains = commandToolchains({ command: plan.argv, roots: [worktree], mode: 'fetch', installs, cacheRoot: toolchainCacheRootFor(ctx), scratchRoot: scratch, tmpDir: tmp, isolation: isolation.kind, networkHosts: hosts, hostHome: homeOf(ctx.deps), hostEnv: ctx.deps.hostEnv ?? process.env });
  prepareToolchainLayout(toolchains);
  const def: CheckDefinition = { id: `approved-${rel.split('/').at(-1)}`, command: plan.argv, shell: false, cwd: '.', timeout_seconds: APPROVED_TIMEOUT_S, network_hosts: hosts, local_binding: false, env: {}, mandatory: false, flaky_reruns: 0, kind: 'command' };
  const profile = profileForCheck({ worktree, check: def, snapshot: ctx.snapshot, extraWritable: [home, tmp, ...toolchains.writable], readablePaths: toolchains.readOnly, nisDomainName: toolchains.nisDomainName, homeDir: homeOf(ctx.deps) });
  const env: Record<string, string> = {
    ...toolchains.env,
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: tmp,
    ...privateHomeDotnetEnv(home),
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  let r: Awaited<ReturnType<typeof execCapture>>;
  let note: string | null = null;
  let stopped = false;
  try {
    const wrapped = isolation.wrap(plan.argv, profile, { cwd: worktree, env });
    try {
      const ran = await runStoppingRefusedNodes(tmp, (signal) => execCapture(wrapped.argv, { cwd: worktree, env: wrapped.env, timeoutMs: APPROVED_TIMEOUT_S * 1000, maxOutputBytes: APPROVED_MAX_OUTPUT_BYTES, abortSignal: signal }), ctx.signal);
      r = ran.result;
      stopped = ran.stopped;
      if (ran.denial) note = msbuildNodeDenialNote(ran.denial, msbuildNodeFix({ id: def.id, command: plan.argv, shell: false }, { command: 'the command to approve', env: null }), ran.stopped, nodeDenialSubject('the approved command'));
    } catch (err) {
      throw new OrbitError('INTERNAL', `the approved command could not start: ${err instanceof Error ? err.message : String(err)}`, { definitive: true }, { cause: err });
    } finally {
      wrapped.cleanup();
    }
  } finally {
    removeScratch(scratch);
  }
  // Stopped, for a refused MSBuild node, the run's cancellation or the time limit, it has no exit code of its own: srt
  // exits 0 when it is stopped (measured), which must not read as a command that succeeded.
  const exitCode = stopped || r.cancelled || r.timedOut ? null : r.exitCode;
  const ended = stopped
    ? 'stopped by Orbit: the sandbox refused an MSBuild worker node'
    : r.cancelled
      ? 'stopped: the run was cancelled'
      : r.timedOut
        ? `stopped: timed out after ${APPROVED_TIMEOUT_S}s`
        : `exit ${r.exitCode ?? `signal ${r.signal ?? 'unknown'}`}`;
  const caches = cachesLine(toolchains.toolchains, installs);
  const text = redact(`$ ${plan.shown}\n${caches}[${ended}]\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}\n${note ? `--- orbit ---\n${note}\n` : ''}`);
  atomicWrite(join(dir, OUTPUT_FILE), text, 0o600);
  const receipt: ApprovedReceipt = { exit_code: exitCode, timed_out: r.timedOut, path: join(rel, OUTPUT_FILE), sha256: sha256(text), excerpt: text.slice(-APPROVED_EXCERPT_CHARS) };
  // Last: its presence is what tells a restarted controller the command ran.
  atomicWrite(join(dir, RECEIPT_FILE), `${JSON.stringify(receipt)}\n`, 0o600);
  return receipt;
}

/**
 * Commands a session ran (the guard did not deny them) that the frozen policy denies under an action-class rule
 * and no grant in `granted` names exactly. A retried session runs under the frozen policy, so anything of this
 * kind it did is a policy violation. Returned redacted, as the denials record them.
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
