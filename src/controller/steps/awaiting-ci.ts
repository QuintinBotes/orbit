/**
 * AWAITING_CI (docs/decisions/0001: a separate state so a restarted
 * controller knows delivery already happened). Each tick observes CI once
 * and returns; nothing blocks on a poll. A green CI on the delivered commit
 * goes through the completion gate; a red one becomes a CI repair brief
 * within ci_repair_cycles (and actions.repair_ci); "no checks reported" is
 * never a pass by itself.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, readJsonIfExists } from '../../core/fsx.ts';
import { OrbitError } from '../../core/errors.ts';
import { appendEvent } from '../../storage/events.ts';
import { recordFailure, type CandidateRecord } from '../../evidence/store.ts';
import { cleanupCandidateCheckout, materializeCandidate, snapshotCandidate, ORBIT_GIT_IDENTITY, type SnapshotResult } from '../../evidence/candidate.ts';
import { git } from '../../evidence/git.ts';
import { invalidateEvidence } from '../../evidence/freshness.ts';
import { invalidateStaleReviews } from '../../review/stale.ts';
import { authorize } from '../../policy/authorize.ts';
import { execCapture } from '../../core/exec.ts';
import { fetchBranchContaining, gitEnv, lsRemoteBranch, remoteHost, resolveRemoteUrl } from '../../delivery/git.ts';
import { ciRepairBrief, ciRepairDecision, observeCi } from '../../delivery/ci.ts';
import { CANDIDATE_EVENT, runWorktreeRoot, type RunContext } from '../context.ts';
import { decide, finishRun, move, safePoint, WAIT, type StepResult } from './common.ts';
import { complete, DELIVERY_FILE, githubClient, releaseDelivered } from './delivering.ts';
import { briefPath, currentAttempt, type StoredBrief } from './implementing.ts';

interface DeliveryFile {
  commit: string;
  tree: string;
  branch: string;
  pr: { number: number } | null;
  delivered_at: number;
}

const CI_CYCLE_EVENT = 'ci.repair-cycle';

export async function awaitingCiStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const d = readJsonIfExists<DeliveryFile>(join(ctx.runDir, DELIVERY_FILE));
  if (!d || !ctx.ledger) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is AWAITING_CI without a delivery record`);
  const config = ctx.snapshot.config;
  const client = await githubClient(ctx);
  const readLogs = authorize(ctx.snapshot, { kind: 'action', action: 'read_ci_logs' }).allowed;
  const obs = await observeCi({ client, ...(d.pr ? { pr: d.pr.number } : {}), sha: d.commit, timeoutMs: 0, clock: ctx.clock, readLogs });
  const elapsed = ctx.clock.now() - d.delivered_at;
  const base = { branch: d.branch, commit: d.commit, pr: d.pr?.number ?? null };

  if (obs.state === 'passed') {
    const moved = await handleMovedBase(ctx, d, base);
    if (moved) return moved;
    // Release mode merges and deploys the reviewed commit once its CI is green; other modes complete here.
    if (ctx.run.mode === 'release') return releaseDelivered(ctx, d, { ...base, ci: 'passed' });
    return complete(ctx, d.tree, { ...base, ci: 'passed' });
  }
  if (obs.state === 'cancelled') return finishRun(ctx, 'BLOCKED', `CI was cancelled on ${d.commit.slice(0, 12)}; re-run it and resume the run`, { outcome: base });
  if (obs.state === 'failed') {
    const brief = ciRepairBrief(obs.failures, { sha: d.commit, ...(d.pr ? { pr: d.pr.number } : {}) });
    const previous = ctx.db.all<{ fp: string | null }>("SELECT json_extract(data_json, '$.fingerprint') AS fp FROM events WHERE run_id = ? AND type = ?", ctx.run.id, CI_CYCLE_EVENT).map((r) => r.fp).filter((x): x is string => typeof x === 'string');
    const decision = ciRepairDecision({ snapshot: ctx.snapshot, cyclesUsed: ctx.ledger.state('ci_repair_cycles').used, fingerprint: brief.fingerprint, previousFingerprints: previous });
    decide(ctx, { id: `dec-${ctx.run.id}-ci-${d.commit}`, kind: 'ci.repair-decision', summary: `CI failed on ${d.commit.slice(0, 12)}: ${decision.reason}`, data: { decision, failures: brief.failures } });
    for (const f of obs.failures) recordFailure(ctx.db, { runId: ctx.run.id, candidateId: ctx.candidate?.id ?? null, source: 'ci', sourceId: `ci:${d.commit}:${f.name}`, fingerprint: f.fingerprint, excerpt: f.logExcerpt.slice(0, 2000) || null }, ctx.clock);
    if (!decision.allowed) {
      return decision.remaining === 0
        ? finishRun(ctx, 'EXHAUSTED', `CI failed and the CI repair budget is spent: ${decision.reason}`, { outcome: base })
        : finishRun(ctx, 'BLOCKED', `CI failed and repair is not authorized: ${decision.reason}`, { outcome: base });
    }
    const next = currentAttempt(ctx) + 1;
    // The cycle is counted with its record, so a crash cannot count it twice.
    ctx.db.tx(() => {
      if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.commit') = ?", ctx.run.id, CI_CYCLE_EVENT, d.commit)) return;
      ctx.ledger!.consume('ci_repair_cycles', 1);
      appendEvent(ctx.db, ctx.run.id, CI_CYCLE_EVENT, ctx.ownerId, { commit: d.commit, fingerprint: brief.fingerprint, attempt: next }, ctx.clock.now());
    });
    const stored: StoredBrief = { attempt: next, source: 'ci', fingerprint: brief.fingerprint, brief: { text: brief.text, evidence: brief.evidence, preserved_constraints: brief.preservedConstraints, post_fix_checks: brief.postFixChecks } };
    atomicWriteJson(briefPath(ctx, next), stored);
    return move(ctx, 'DIAGNOSING', `CI failed on ${d.commit.slice(0, 12)} (${obs.failures.map((f) => f.name).join(', ')}); CI repair brief for attempt ${next}`);
  }

  // Pending: nothing reported yet, or still running.
  const timeoutMs = config.delivery.ci_timeout_minutes * 60_000;
  if (obs.absent && elapsed >= ctx.timing.ciAbsentGraceMs) {
    if (config.delivery.require_ci) {
      if (elapsed >= timeoutMs) return finishRun(ctx, 'BLOCKED', `no CI checks were reported for ${d.commit.slice(0, 12)} within ${config.delivery.ci_timeout_minutes} minutes and delivery.require_ci is true`, { outcome: base });
      return WAIT('no CI checks reported yet');
    }
    const moved = await handleMovedBase(ctx, d, base);
    if (moved) return moved;
    if (ctx.run.mode === 'release') return releaseDelivered(ctx, d, { ...base, ci: 'none reported' }, ['no CI checks were reported for the delivered commit; CI is unverified']);
    return complete(ctx, d.tree, { ...base, ci: 'none reported' }, ['no CI checks were reported for the delivered commit; CI is unverified']);
  }
  if (elapsed >= timeoutMs) return finishRun(ctx, 'BLOCKED', `CI did not finish within ${config.delivery.ci_timeout_minutes} minutes (pending: ${obs.pending.join(', ') || 'unknown'})`, { outcome: base });
  return WAIT(`CI pending on ${d.commit.slice(0, 12)}${obs.pending.length ? ` (${obs.pending.join(', ')})` : ''}`);
}

// ---------------------------------------------------------------------------
// A moved base branch (spec section 14: conflicts and rebases)

export interface BaseConflict {
  baseBranch: string;
  /** The base revision the run started from. */
  from: string;
  /** Where the base branch is now. */
  to: string;
  /** Paths that no longer merge cleanly. */
  files: string[];
}

export interface BaseMovement {
  baseBranch: string;
  from: string;
  to: string;
  /** Paths that no longer merge cleanly; empty when the delivered commit still merges into the new base. */
  conflicts: string[];
}

/**
 * Whether the base branch moved on the remote since the run began, and whether the delivered commit still merges
 * cleanly into it. The base tip is read with ls-remote; when it moved, it is fetched into a private ref and a
 * three-way merge is computed without touching any worktree (git merge-tree). Null when the base did not move or
 * the remote cannot be read (an unreadable remote is not a conflict; CI and review still stand).
 */
export async function baseMovement(ctx: RunContext, d: { commit: string }): Promise<BaseMovement | null> {
  const config = ctx.snapshot.config;
  const remote = config.repository.remote;
  const baseBranch = config.repository.base_branch;
  const from = ctx.run.baseRevision;
  if (!from) return null;
  const env = ctx.deps.hostEnv ?? process.env;
  try {
    const url = await resolveRemoteUrl(ctx.run.repoRoot, remote);
    const host = remoteHost(url);
    if (host !== null && !authorize(ctx.snapshot, { kind: 'network', host }).allowed) return null;
    const tip = await lsRemoteBranch({ repoRoot: ctx.run.repoRoot, remote, branch: baseBranch, env: gitEnv({}, env) });
    if (!tip || tip === from) return null;
    const ref = `refs/orbit/${ctx.run.id}/base`;
    await fetchBranchContaining({ repoRoot: ctx.run.repoRoot, remote, branch: baseBranch, commit: from, ref, env: gitEnv({}, env) });
    const merged = await execCapture(['git', 'merge-tree', '--write-tree', '--name-only', '--no-messages', tip, d.commit], { cwd: ctx.run.repoRoot, env: gitEnv({}, env), timeoutMs: 60_000 });
    if (merged.exitCode === 0) return { baseBranch, from, to: tip, conflicts: [] };
    if (merged.exitCode !== 1) {
      ctx.log.warn('could not compute the merge with the moved base branch', { exit: merged.exitCode, stderr: merged.stderr.slice(0, 300) });
      return null;
    }
    const files = merged.stdout.split('\n').slice(1).map((l) => l.trim()).filter((l) => l.length > 0);
    return { baseBranch, from, to: tip, conflicts: files.length > 0 ? files : ['(unknown paths)'] };
  } catch (err) {
    ctx.log.warn('could not read the base branch on the remote', { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
    return null;
  }
}

/** The delivered commit's conflict with the moved base branch, or null when the base did not move or the merge is clean. */
export async function baseConflict(ctx: RunContext, d: { commit: string }): Promise<BaseConflict | null> {
  const m = await baseMovement(ctx, d);
  return m && m.conflicts.length > 0 ? { baseBranch: m.baseBranch, from: m.from, to: m.to, files: m.conflicts[0] === '(unknown paths)' ? [] : m.conflicts } : null;
}

/** A rebase restarts verification and review, so a base branch that keeps moving cannot keep one run busy forever. */
const MAX_REBASES = 3;
const REBASE_EVENT = 'delivery.rebased';

/**
 * A moved base branch (spec section 14). With `actions.rebase_task_branch` the reviewed candidate is rebased onto
 * the new base in an isolated checkout, which makes a new candidate: evidence and reviews of the old tree are
 * invalidated, the run's worktree and base revision follow, and the run goes back to VERIFYING (then review and
 * delivery push it as a fast-forward of the task branch). A rebase that conflicts blocks with the conflicting
 * paths. Without the permission, a delivered commit that no longer merges blocks naming the key that would allow
 * the rebase; a base that moved without a conflict is no obstacle. Null: carry on to completion or release.
 */
async function handleMovedBase(ctx: RunContext, d: DeliveryFile, base: Record<string, unknown>): Promise<StepResult | null> {
  const m = await baseMovement(ctx, d);
  if (!m) return null;
  const decision = authorize(ctx.snapshot, { kind: 'action', action: 'rebase_task_branch' });
  const conflict = m.conflicts.length > 0;
  const short = (sha: string): string => sha.slice(0, 12);
  const where = `${m.baseBranch} moved (${short(m.from)} to ${short(m.to)})`;
  const paths = m.conflicts.slice(0, 10).join(', ');

  if (!decision.allowed) {
    if (!conflict) return null;
    return blockOnConflict(ctx, d, base, m, `the base branch ${where} and the delivered commit ${short(d.commit)} no longer merges cleanly: conflicts in ${m.conflicts[0] === '(unknown paths)' ? 'unknown paths' : paths}. Rebasing the task branch is not authorized (actions.rebase_task_branch: ${decision.reason}); rebase it yourself or close the pull request, then start a new run`);
  }
  if (conflict) {
    return blockOnConflict(ctx, d, base, m, `the base branch ${where} and rebasing the task branch onto it conflicts in ${m.conflicts[0] === '(unknown paths)' ? 'unknown paths' : paths}; resolve the conflict by hand or close the pull request, then start a new run`);
  }

  const done = ctx.db.all<{ to: string | null }>("SELECT json_extract(data_json, '$.to') AS \"to\" FROM events WHERE run_id = ? AND type = ?", ctx.run.id, REBASE_EVENT).map((r) => r.to);
  if (done.length >= MAX_REBASES && !done.includes(m.to)) {
    return blockOnConflict(ctx, d, base, m, `the base branch ${where} and this run already rebased onto a moved base ${done.length} times; it will not rebase again. Merge or close the pull request, or start a new run`);
  }
  const cand = ctx.candidate;
  if (!cand) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is AWAITING_CI without a candidate`);
  const rebased = await rebaseCandidate(ctx, cand, m.to);
  if (rebased.kind === 'conflict') {
    return blockOnConflict(ctx, d, base, { ...m, conflicts: rebased.files }, `the base branch ${where} and rebasing the task branch onto it conflicts in ${rebased.files.join(', ') || 'unknown paths'}; resolve the conflict by hand or close the pull request, then start a new run`);
  }
  const next = rebased.candidate;
  const reason = `rebased candidate ${cand.seq} onto ${m.baseBranch} ${short(m.to)}: new candidate ${next.seq} (tree ${next.treeHash})`;
  invalidateEvidence(ctx.db, ctx.run.id, reason, ctx.clock, { exceptTreeHash: next.treeHash });
  invalidateStaleReviews(ctx.db, { runId: ctx.run.id, runDir: ctx.runDir, current: { candidateId: next.id, treeHash: next.treeHash }, cause: 'rebase onto the moved base branch' }, ctx.clock);
  ctx.db.tx(() => {
    appendEvent(ctx.db, ctx.run.id, REBASE_EVENT, ctx.ownerId, { from: m.from, to: m.to, old_candidate_id: cand.id, candidate_id: next.id, tree_hash: next.treeHash }, ctx.clock.now());
    appendEvent(ctx.db, ctx.run.id, CANDIDATE_EVENT, ctx.ownerId, { attempt: currentAttempt(ctx), candidate_id: next.id, seq: next.seq, tree_hash: next.treeHash, reused: !next.created, rebase: true }, ctx.clock.now());
  });
  ctx.candidate = next;
  decide(ctx, { id: `dec-${ctx.run.id}-rebase-${m.to}`, kind: 'delivery.rebased', summary: `${m.baseBranch} moved from ${short(m.from)} to ${short(m.to)}; rebased the reviewed candidate (${short(cand.commitSha)}) onto it as ${short(next.commitSha)}, evidence and reviews invalidated`, data: { from: m.from, to: m.to, old_commit: cand.commitSha, commit: next.commitSha, tree: next.treeHash } });
  const baseTree = (await execCapture(['git', 'rev-parse', `${m.to}^{tree}`], { cwd: ctx.run.repoRoot, env: gitEnv({}, ctx.deps.hostEnv ?? process.env), timeoutMs: 30_000 })).stdout.trim();
  return move(ctx, 'VERIFYING', `${reason}; verifying again`, { patch: { baseRevision: m.to, ...(baseTree ? { baseTree } : {}) }, data: { rebase: { from: m.from, to: m.to } } });
}

async function blockOnConflict(ctx: RunContext, d: DeliveryFile, base: Record<string, unknown>, m: BaseMovement, reason: string): Promise<StepResult> {
  const files = m.conflicts[0] === '(unknown paths)' ? [] : m.conflicts;
  decide(ctx, { id: `dec-${ctx.run.id}-base-conflict-${d.commit}-${m.to}`, kind: 'delivery.base-conflict', summary: `${m.baseBranch} moved from ${m.from.slice(0, 12)} to ${m.to.slice(0, 12)}; ${reason.slice(0, 300)}`, data: { baseBranch: m.baseBranch, from: m.from, to: m.to, files, commit: d.commit } });
  return finishRun(ctx, 'BLOCKED', reason, { outcome: { ...base, base_conflict: { baseBranch: m.baseBranch, from: m.from, to: m.to, files } } });
}

type RebaseResult = { kind: 'rebased'; candidate: SnapshotResult } | { kind: 'conflict'; files: string[] };

/**
 * Rebase a candidate commit onto `tip` in a throwaway checkout (hooks off, a fixed identity), then snapshot the
 * result as a new candidate whose parent is the new base. The run's own worktree is moved to it so that a later
 * repair works on the new base and not on the old one. A conflict aborts the rebase and names its paths.
 */
async function rebaseCandidate(ctx: RunContext, cand: CandidateRecord, tip: string): Promise<RebaseResult> {
  const checkoutDir = join(runWorktreeRoot(ctx), `rebase-${tip.slice(0, 12)}`);
  const env = { ...gitEnv({}, ctx.deps.hostEnv ?? process.env), GIT_AUTHOR_NAME: ORBIT_GIT_IDENTITY.name, GIT_AUTHOR_EMAIL: ORBIT_GIT_IDENTITY.email, GIT_COMMITTER_NAME: ORBIT_GIT_IDENTITY.name, GIT_COMMITTER_EMAIL: ORBIT_GIT_IDENTITY.email };
  await cleanupCandidateCheckout(ctx.run.repoRoot, checkoutDir).catch(() => {});
  await materializeCandidate(ctx.run.repoRoot, cand.commitSha, checkoutDir, { readOnly: false });
  try {
    const res = await execCapture(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'rebase', '--onto', tip, cand.parentSha, 'HEAD'], { cwd: checkoutDir, env, timeoutMs: 120_000 });
    if (res.exitCode !== 0) {
      const unmerged = await execCapture(['git', 'diff', '--name-only', '--diff-filter=U'], { cwd: checkoutDir, env, timeoutMs: 30_000 });
      await execCapture(['git', 'rebase', '--abort'], { cwd: checkoutDir, env, timeoutMs: 30_000 }).catch(() => null);
      const files = unmerged.stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
      if (files.length === 0) throw new OrbitError('GIT_FAILED', `git rebase onto ${tip.slice(0, 12)} failed: ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
      return { kind: 'conflict', files };
    }
    const attempt = currentAttempt(ctx);
    const next = await snapshotCandidate({ db: ctx.db, clock: ctx.clock, repoRoot: ctx.run.repoRoot, worktree: checkoutDir, runId: ctx.run.id, baseRev: tip, attempt, workerId: null });
    // The run's worktree follows the rebase; with workers stopped (the run is awaiting CI) nothing else writes to it.
    if (ctx.run.worktreePath && existsSync(ctx.run.worktreePath)) {
      try {
        await git(ctx.run.worktreePath, ['reset', '--hard', next.commitSha]);
      } catch (err) {
        ctx.log.warn('could not move the run worktree onto the rebased candidate', { error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      }
    }
    return { kind: 'rebased', candidate: next };
  } finally {
    await cleanupCandidateCheckout(ctx.run.repoRoot, checkoutDir).catch(() => {});
  }
}
