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
import { appendEvent } from '../../storage/events.ts';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { git, treeOf } from '../../evidence/git.ts';
import { isFresh } from '../../evidence/freshness.ts';
import { currentEvidenceReport, setCandidateStatus, type EvidenceReportRecord } from '../../evidence/store.ts';
import { listReviews } from '../../review/store.ts';
import type { ReviewRecord } from '../../review/types.ts';
import { DELIVERY_MODES } from '../../policy/config.ts';
import { ActionLedger } from '../../delivery/actions.ts';
import { deliver, type DeliveryResult } from '../../delivery/deliver.ts';
import { performRelease, resolveDeploy, type ReleaseResult } from '../../delivery/release.ts';
import { FakeGitHub, GhCliClient, type GitHubClient } from '../../delivery/github.ts';
import { resolveRemoteUrl } from '../../delivery/git.ts';
import { homeOf, type RunContext } from '../context.ts';
import { completionGate, deliveryGate } from '../gates.ts';
import { assertContract, blockOnOpenQuestions, decide, finishRun, move, safePoint, WAIT, type StepResult } from './common.ts';
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
  // Nothing is delivered while a criterion waits for a person's decision.
  const waiting = await blockOnOpenQuestions(ctx, 'delivery');
  if (waiting) return waiting;

  if (!DELIVERY_MODES.has(ctx.run.mode)) {
    const branch = ctx.run.branch ?? `${ctx.snapshot.config.repository.branch_prefix}${ctx.run.id}`;
    // Local only: a ref in the user's repository pointing at the reviewed candidate commit. No push, no pull request.
    await git(ctx.run.repoRoot, ['update-ref', '-m', `orbit: reviewed candidate of ${ctx.run.id}`, `refs/heads/${branch}`, cand.commitSha]);
    const tree = await treeOf(ctx.run.repoRoot, `refs/heads/${branch}`);
    const refused = await deliveryGateOrBlock(ctx, ev, review, tree);
    if (refused) return refused;
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
  // delivery/deliver checked freshness before each external action; the gate trail records the delivered tree.
  const refused = await deliveryGateOrBlock(ctx, ev, review, result.tree);
  if (refused) return refused;
  atomicWriteJson(join(ctx.runDir, DELIVERY_FILE), { commit: result.commit, tree: result.tree, branch: result.branch, pr: result.pr ? { number: result.pr.number, url: result.pr.url, state: result.pr.state, isDraft: result.pr.isDraft } : null, pr_skipped: result.prSkipped, warnings: result.warnings, delivered_at: ctx.clock.now() });
  setCandidateStatus(ctx.db, cand.id, 'DELIVERED');
  decide(ctx, { id: `dec-${ctx.run.id}-delivered-${result.commit}`, kind: 'delivery.completed', summary: `delivered ${result.commit.slice(0, 12)} (tree ${result.tree.slice(0, 12)}) to ${result.branch}${result.pr ? `, PR #${result.pr.number}` : ''}`, data: { commit: result.commit, tree: result.tree, branch: result.branch, pr: result.pr?.number ?? null, pr_skipped: result.prSkipped } });
  return move(ctx, 'AWAITING_CI', `delivered ${result.commit.slice(0, 12)} to ${result.branch}`, { patch: { branch: result.branch }, data: { commit: result.commit, pr: result.pr?.number ?? null } });
}

export const RELEASE_FILE = 'release.json';

/** What delivery recorded (delivery.json), as the release reads it. */
export interface DeliveredRecord {
  commit: string;
  tree: string;
  branch: string;
  pr: { number: number } | null;
}

/**
 * Release mode (spec sections 5 and 15): after delivery and green CI, merge the exact reviewed commit and deploy
 * it through the release profile (delivery/release.performRelease, which re-checks the freshness gate, the head
 * commit, the branch checks and open blockers before every action and reconciles lost responses). The
 * controller's readiness gate is the completion gate on the delivered tree. Returns the step result: WAIT while
 * checks are pending, BLOCKED on a refusal, SUCCEEDED through the completion gate once released.
 */
export async function releaseDelivered(ctx: RunContext, d: DeliveredRecord, outcome: Record<string, unknown>, notes: string[] = []): Promise<StepResult> {
  const contract = assertContract(ctx);
  const cand = ctx.candidate;
  if (!cand) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is releasing without a candidate`);
  const ev = currentEvidenceReport(ctx.db, ctx.run.id, cand.id);
  const review = listReviews(ctx.db, ctx.run.id, { treeHash: cand.treeHash }).filter((r) => r.verdict === 'APPROVE').at(-1) ?? null;
  if (!ev || !review) return finishRun(ctx, 'BLOCKED', `release refused: ${!ev ? 'no live evidence' : 'no approving review'} for the delivered tree ${d.tree}`, { outcome });
  const release = ctx.snapshot.config.release ?? null;
  const envs = release ? Object.keys(release.environments) : [];
  const deliveryRun = { id: ctx.run.id, repoRoot: ctx.run.repoRoot, branch: ctx.run.branch, baseRevision: ctx.run.baseRevision, policyHash: ctx.run.policyHash, cancelRequested: ctx.run.cancelRequested, goal: ctx.run.goal };
  const ledger = new ActionLedger(ctx.db, ctx.clock, { runDir: ctx.runDir, actor: ctx.ownerId });
  const client = await githubClient(ctx);
  const runRelease = (): Promise<ReleaseResult> =>
    performRelease({
      run: deliveryRun,
      candidate: { id: cand.id, commitSha: cand.commitSha, treeHash: cand.treeHash, parentSha: cand.parentSha },
      evidence: { id: ev.id, candidateId: cand.id, treeHash: ev.treeHash, policyHash: ev.policyHash, checkConfigHash: ev.checkConfigHash, verdict: ev.verdict, invalidatedAt: ev.invalidatedAt },
      review: { id: review.id, candidateId: review.candidateId, treeHash: review.treeHash, verdict: review.verdict, invalidatedAt: review.invalidatedAt },
      snapshot: ctx.snapshot,
      ledger,
      client,
      clock: ctx.clock,
      commit: d.commit,
      pr: d.pr?.number ?? null,
      contractMerge: contract.delivery.merge,
      // Every environment the release profile defines that the deployed ref is allowed for, in profile order.
      environments: 'all',
      readiness: () => {
        const gate = completionGate(ctx.db, { run: ctx.run, snapshot: ctx.snapshot, candidate: cand, implementerProvider: implementerProvider(ctx), deliveredTree: d.tree, now: ctx.clock.now() });
        return { ok: gate.passed, reasons: gate.reasons };
      },
      isolation: ctx.isolation(),
      workDir: ctx.runDir,
      homeDir: homeOf(ctx.deps),
    });

  // A deploy with an unknown outcome is first settled by the environment's verify_command and the release is then
  // tried again (once per environment at most); only an outcome that stays unknown goes to a person.
  let result: ReleaseResult | null = null;
  for (let settled = 0; result === null; settled++) {
    try {
      result = await runRelease();
    } catch (err) {
      if (isOrbitError(err, 'CANCELLED')) {
        const s = await safePoint(ctx);
        if (s) return s;
      }
      const unknownEnv = isOrbitError(err) && err.details?.outcomeUnknown === true && typeof err.details.environment === 'string' ? err.details.environment : null;
      if (unknownEnv !== null && settled <= envs.length) {
        const auto = await settleUnknownDeploy(ctx, ledger, deliveryRun, unknownEnv);
        if (auto.settled) continue;
        const how = `Find out whether it took effect, then run: orbit release resolve ${ctx.run.id} --deployed (or --not-deployed), and orbit resume ${ctx.run.id}`;
        return finishRun(ctx, 'BLOCKED', `release refused: ${(err as Error).message}${auto.detail ? ` (automatic check: ${auto.detail})` : ''}. ${how}`, { outcome: { ...outcome, release_error: { code: 'DELIVERY_FAILED', outcome_unknown: true, environment: unknownEnv } } });
      }
      if (isOrbitError(err) && (err.details?.definitive === true || err.code === 'POLICY_DENIED')) {
        return finishRun(ctx, 'BLOCKED', `release refused: ${err.message}`, { outcome: { ...outcome, release_error: { code: err.code, rule: err.details?.rule ?? null } } });
      }
      throw err;
    }
  }
  if (result.status === 'pending') return releasePending(ctx, result, d, outcome);
  const summary = {
    merge: result.merge ? { pr: result.merge.number, head: result.merge.headSha, merge_commit: result.merge.mergeCommitSha, method: result.merge.method } : null,
    merge_skipped: result.mergeSkipped,
    deploy: result.deploy ? { environment: result.deploy.environment, sha: result.deploy.sha, branch: result.deploy.branch } : null,
    deploys: result.deploys.map((x) => ({ environment: x.environment, sha: x.sha, branch: x.branch })),
    deploy_skipped: result.deploySkipped,
  };
  atomicWriteJson(join(ctx.runDir, RELEASE_FILE), { ...summary, released_at: ctx.clock.now() });
  const deployed = summary.deploys.length > 0 ? `deployed to ${summary.deploys.map((x) => x.environment).join(', ')}${summary.deploy_skipped ? ` (not: ${summary.deploy_skipped})` : ''}` : `no deploy (${summary.deploy_skipped})`;
  decide(ctx, { id: `dec-${ctx.run.id}-released-${d.commit}`, kind: 'release.completed', summary: `release of ${d.commit.slice(0, 12)}: ${summary.merge ? `merged PR #${summary.merge.pr}` : `no merge (${summary.merge_skipped})`}; ${deployed}`, data: summary });
  return complete(ctx, d.tree, { ...outcome, release: summary }, notes);
}

/**
 * Before asking a person about a deploy whose outcome is unknown, ask the environment (its trusted verify_command).
 * Settled means the ledger now says what happened (deployed, or not deployed and safe to run again).
 */
async function settleUnknownDeploy(ctx: RunContext, ledger: ActionLedger, run: Parameters<typeof resolveDeploy>[0]['run'], environment: string): Promise<{ settled: boolean; detail: string | null }> {
  try {
    const r = await resolveDeploy({ run, snapshot: ctx.snapshot, ledger, clock: ctx.clock, workDir: ctx.runDir, environment, resolution: 'verify', by: 'controller', isolation: ctx.isolation(), homeDir: homeOf(ctx.deps) });
    return { settled: r.verdict !== 'unknown', detail: r.detail };
  } catch (err) {
    return { settled: false, detail: err instanceof Error ? err.message.slice(0, 300) : String(err) };
  }
}

const RELEASE_WAIT_EVENT = 'release.waiting';

/**
 * A release waiting for checks (branch checks before the merge, CI on the deployed commit before the deploy) waits
 * at most delivery.ci_timeout_minutes per phase, counted from the first time it was seen waiting; a required check
 * that never reports would otherwise keep the run in AWAITING_CI forever. Nothing has been merged or deployed for
 * the phase that timed out, so the run blocks for a person.
 */
function releasePending(ctx: RunContext, result: ReleaseResult, d: DeliveredRecord, outcome: Record<string, unknown>): Promise<StepResult> | StepResult {
  const phase = result.merge ? `deploy:${result.merge.mergeCommitSha ?? 'none'}` : `merge:${d.commit}`;
  const now = ctx.clock.now();
  const first = ctx.db.get<{ ts: number | null }>("SELECT MIN(ts) AS ts FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.phase') = ?", ctx.run.id, RELEASE_WAIT_EVENT, phase)?.ts ?? null;
  if (first === null) ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, RELEASE_WAIT_EVENT, ctx.ownerId, { phase, reason: result.pending }, now));
  const timeoutMinutes = ctx.snapshot.config.delivery.ci_timeout_minutes;
  if (first !== null && now - first >= timeoutMinutes * 60_000) {
    return finishRun(ctx, 'BLOCKED', `release did not become ready within ${timeoutMinutes} minutes: ${result.pending ?? 'still waiting'}`, { outcome: { ...outcome, release_pending: { phase, reason: result.pending } } });
  }
  return WAIT(`release: ${result.pending ?? 'waiting'}`);
}

/**
 * The spec section 5 delivery gate over what was delivered: live, fresh evidence and an approving review of the
 * same tree, and the delivered commit's tree equal to it. Recorded in the gate trail; a failure blocks.
 */
async function deliveryGateOrBlock(ctx: RunContext, ev: EvidenceReportRecord, review: ReviewRecord, deliveredTree: string): Promise<StepResult | null> {
  const gate = deliveryGate({ snapshot: ctx.snapshot, candidate: ctx.candidate!, evidence: ev, review: { treeHash: review.treeHash, verdict: review.verdict }, deliveryCommitTree: deliveredTree });
  recordGate(ctx, gate);
  if (gate.passed) return null;
  return finishRun(ctx, 'BLOCKED', `delivery gate: ${gate.reasons.join('; ')}`, { outcome: { gate: gate.reasons, code: gate.details.code } });
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
