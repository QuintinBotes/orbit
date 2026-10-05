/**
 * DELIVERING (spec section 15) and the completion gate.
 *
 * Delivery modes hand the reviewed tree to delivery/deliver, which commits
 * exactly that tree, pushes the task branch and opens the run's one pull
 * request, with intent persisted before every external action and the
 * freshness gate re-checked before each. Autonomous and supervised runs take
 * no external action: the reviewed candidate commit is left on a local
 * `orbit/<run>` branch and the run succeeds once the completion gate holds.
 */
import { join } from 'node:path';
import { atomicWriteJson } from '../../core/fsx.ts';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { git, treeOf } from '../../evidence/git.ts';
import { isFresh } from '../../evidence/freshness.ts';
import { currentEvidenceReport, setCandidateStatus } from '../../evidence/store.ts';
import { listReviews } from '../../review/store.ts';
import { DELIVERY_MODES } from '../../policy/config.ts';
import { ActionLedger } from '../../delivery/actions.ts';
import { deliver, type DeliveryResult } from '../../delivery/deliver.ts';
import { FakeGitHub, GhCliClient, type GitHubClient } from '../../delivery/github.ts';
import { resolveRemoteUrl } from '../../delivery/git.ts';
import type { RunContext } from '../context.ts';
import { completionGate } from '../gates.ts';
import { assertContract, decide, finishRun, move, safePoint, type StepResult } from './common.ts';
import { implementerProvider } from './reviewing.ts';
import { recordGate } from './preflight.ts';

export const DELIVERY_FILE = 'delivery.json';

export async function deliveringStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const contract = assertContract(ctx);
  const cand = ctx.candidate;
  if (!cand) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is DELIVERING without a candidate`);
  const ev = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  const review = listReviews(ctx.db, ctx.run.id, { treeHash: cand.treeHash }).filter((r) => r.verdict === 'APPROVE').at(-1) ?? null;
  if (!ev || !review || !isFresh(ev.report, { candidate: cand, snapshot: ctx.snapshot })) {
    // Evidence or review went stale since review (a policy or tree change): verify again rather than deliver.
    return move(ctx, 'VERIFYING', `delivery refused: ${!ev ? 'no live evidence' : !review ? 'no approving review of this tree' : 'the evidence is stale'}; verifying again`);
  }

  if (!DELIVERY_MODES.has(ctx.run.mode)) {
    const branch = ctx.run.branch ?? `${ctx.snapshot.config.repository.branch_prefix}${ctx.run.id}`;
    // Local only: a ref in the user's repository pointing at the reviewed candidate commit. No push, no pull request.
    await git(ctx.run.repoRoot, ['update-ref', '-m', `orbit: reviewed candidate of ${ctx.run.id}`, `refs/heads/${branch}`, cand.commitSha]);
    const tree = await treeOf(ctx.run.repoRoot, `refs/heads/${branch}`);
    return complete(ctx, tree, { branch, commit: cand.commitSha, delivery: 'local branch; no external action in this mode' });
  }

  const client = await githubClient(ctx);
  const ledger = new ActionLedger(ctx.db, ctx.clock, { runDir: ctx.runDir, actor: ctx.ownerId });
  let result: DeliveryResult;
  try {
    result = await deliver({
      run: { id: ctx.run.id, repoRoot: ctx.run.repoRoot, branch: ctx.run.branch, baseRevision: ctx.run.baseRevision, policyHash: ctx.run.policyHash, cancelRequested: ctx.run.cancelRequested, goal: ctx.run.goal },
      candidate: { id: cand.id, commitSha: cand.commitSha, treeHash: cand.treeHash, parentSha: cand.parentSha },
      evidence: { id: ev.id, candidateId: cand.id, treeHash: ev.treeHash, policyHash: ev.policyHash, checkConfigHash: ev.checkConfigHash, verdict: ev.verdict, invalidatedAt: ev.invalidatedAt },
      review: { id: review.id, candidateId: review.candidateId, treeHash: review.treeHash, verdict: review.verdict, invalidatedAt: review.invalidatedAt },
      snapshot: ctx.snapshot,
      ledger,
      client,
      clock: ctx.clock,
      report: { title: contract.objective, summary: deliverySummary(ctx) },
    });
  } catch (err) {
    if (isOrbitError(err, 'STALE_EVIDENCE')) return move(ctx, 'VERIFYING', `delivery refused by the freshness gate: ${err.message}`);
    if (isOrbitError(err, 'CANCELLED')) {
      const s = await safePoint(ctx);
      if (s) return s;
    }
    if (isOrbitError(err, 'DELIVERY_FAILED') && err.details?.definitive === true) return finishRun(ctx, 'BLOCKED', `delivery failed: ${err.message}`);
    throw err;
  }
  atomicWriteJson(join(ctx.runDir, DELIVERY_FILE), { commit: result.commit, tree: result.tree, branch: result.branch, pr: result.pr ? { number: result.pr.number, url: result.pr.url, state: result.pr.state, isDraft: result.pr.isDraft } : null, pr_skipped: result.prSkipped, warnings: result.warnings, delivered_at: ctx.clock.now() });
  setCandidateStatus(ctx.db, cand.id, 'DELIVERED');
  decide(ctx, { id: `dec-${ctx.run.id}-delivered-${result.commit}`, kind: 'delivery.completed', summary: `delivered ${result.commit.slice(0, 12)} (tree ${result.tree.slice(0, 12)}) to ${result.branch}${result.pr ? `, PR #${result.pr.number}` : ''}`, data: { commit: result.commit, tree: result.tree, branch: result.branch, pr: result.pr?.number ?? null, pr_skipped: result.prSkipped } });
  return move(ctx, 'AWAITING_CI', `delivered ${result.commit.slice(0, 12)} to ${result.branch}`, { patch: { branch: result.branch }, data: { commit: result.commit, pr: result.pr?.number ?? null } });
}

/** The completion gate, then SUCCEEDED; anything short of it is not success. */
export async function complete(ctx: RunContext, deliveredTree: string, outcome: Record<string, unknown>, notes: string[] = []): Promise<StepResult> {
  const gate = completionGate(ctx.db, { run: ctx.run, snapshot: ctx.snapshot, candidate: ctx.candidate, implementerProvider: implementerProvider(ctx), deliveredTree, now: ctx.clock.now() });
  recordGate(ctx, gate);
  if (!gate.passed) return finishRun(ctx, 'BLOCKED', `completion gate: ${gate.reasons.join('; ')}`, { outcome: { ...outcome, gate: gate.reasons } });
  return finishRun(ctx, 'SUCCEEDED', `all mandatory requirements hold for tree ${deliveredTree}${notes.length ? ` (${notes.join('; ')})` : ''}`, { outcome: { ...outcome, tree: deliveredTree, evidence_id: gate.details.evidenceId, review_id: gate.details.reviewId, notes } });
}

function deliverySummary(ctx: RunContext): string {
  const contract = assertContract(ctx);
  const ev = ctx.candidate ? currentEvidenceReport(ctx.db, ctx.run.id, ctx.candidate.id) : null;
  const lines = [`Orbit run ${ctx.run.id}: ${contract.objective}`, '', 'Acceptance criteria:'];
  for (const c of contract.acceptance_criteria) {
    const e = ev?.report.acceptance_evidence.find((a) => a.criterion_id === c.id);
    lines.push(`- ${c.id} (${e?.status ?? 'unverified'}): ${c.statement}`);
  }
  if (ev) {
    lines.push('', 'Checks:');
    for (const ch of ev.report.checks) lines.push(`- ${ch.id}: ${ch.status}${ch.flaky ? ' (flaky)' : ''}`);
    if (ev.report.unverified.length > 0) lines.push('', 'Not verified:', ...ev.report.unverified.map((u) => `- ${u}`));
  }
  return lines.join('\n');
}

/** The run's GitHub client: the configured fake for tests and demos, else the gh CLI with a scoped token. */
export async function githubClient(ctx: RunContext): Promise<GitHubClient> {
  if (ctx.deps.github) return ctx.deps.github(ctx);
  const config = ctx.snapshot.config;
  const remote = config.repository.remote;
  if (config.delivery.provider === 'fake') {
    const url = await resolveRemoteUrl(ctx.run.repoRoot, remote).catch(() => null);
    // A local bare remote lets the fake report real PR heads, as the hosted service would.
    const local = url !== null && !/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && !/^[^/]+@[^:]+:/.test(url) ? url : undefined;
    return new FakeGitHub({ statePath: join(ctx.run.repoRoot, '.orbit', 'fake-github.json'), ...(local ? { remoteGitDir: local } : {}) });
  }
  return githubClientFor(ctx.run.repoRoot, remote, ctx.deps.hostEnv ?? process.env);
}

/** A gh CLI client for the repository's remote (OWNER/REPO from its push URL). */
export async function githubClientFor(repoRoot: string, remote: string, env: Readonly<Record<string, string | undefined>> = process.env): Promise<GitHubClient> {
  const url = await resolveRemoteUrl(repoRoot, remote);
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new OrbitError('CONFIG_INVALID', `remote ${remote} is not a GitHub repository; set delivery.provider or supply a client`, { remote });
  return new GhCliClient({ repo: `${m[1]}/${m[2]}`, env, cwd: repoRoot });
}
