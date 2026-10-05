/**
 * Delivery (spec §15): commit the reviewed tree, push the task branch, and
 * open or adopt the run's single pull request.
 *
 * Every external action goes through the ActionLedger, and before each one
 * (and again before each retry) `authorize()` is consulted for that action and
 * the freshness gate re-checks that evidence and review still bind the exact
 * tree being delivered. `deliver` is safe to call again after any failure or
 * restart: receipts make finished steps no-ops, and an unfinished step is
 * reconciled against the remote before it is repeated.
 */
import type { Clock } from '../core/clock.ts';
import type { AuthorizationDecision, PolicySnapshot } from '../policy/types.ts';
import type { ActionLedger, ActionRecord } from './actions.ts';
import type { GitHubClient, PullRequestInfo } from './github.ts';
import type { DeliveryCandidate, DeliveryEvidence, DeliveryReview, DeliveryRun } from './gate.ts';
import type { GitIdentity, GitOptions, PushReceipt } from './git.ts';
import { OrbitError } from '../core/errors.ts';
import { sha256 } from '../core/hash.ts';
import { redact } from '../core/redact.ts';
import { authorize } from '../policy/authorize.ts';
import { assertDeliverable, assertRecordedBindings, verifyCandidateTree } from './gate.ts';
import { assertTaskBranch, createDeliveryCommit, deliveryRef, findDeliveryCommit, lsRemoteBranch, pushBranch, readControllerIdentity, reconcilePush, remoteHost, resolveRemoteUrl } from './git.ts';

export interface DeliveryReport {
  /** First line becomes the PR title. */
  title: string;
  /** The final report summary; becomes the PR body (after redaction). */
  summary: string;
}

export interface DeliverInput {
  run: DeliveryRun;
  candidate: DeliveryCandidate;
  evidence: DeliveryEvidence;
  review: DeliveryReview;
  snapshot: PolicySnapshot;
  ledger: ActionLedger;
  client: GitHubClient;
  clock: Clock;
  report: DeliveryReport;
  /** The worktree's tree as captured now, when the controller has just re-captured it. */
  currentTree?: string;
  expectedCheckConfigHash?: string;
  /** Overrides repository.remote (a name or URL). */
  remote?: string;
  /** Test seam; by default the controller's git configuration is read. Never a worker-supplied value. */
  identity?: GitIdentity;
  /** Scoped token handed to git's credential helper for HTTPS pushes. Defaults to none (ssh or local remotes). */
  token?: string;
  git?: GitOptions;
  /** Times to re-read the PR waiting for its head to show the pushed commit. Default 3. */
  verifyAttempts?: number;
}

export interface DeliveryResult {
  commit: string;
  tree: string;
  branch: string;
  push: PushReceipt;
  /** null when no PR is wanted or authorized (see `prSkipped`). */
  pr: PullRequestInfo | null;
  prSkipped: string | null;
  warnings: string[];
  actions: ActionRecord[];
}

const TITLE_MAX = 200;
const BODY_MAX = 60_000;

export async function deliver(input: DeliverInput): Promise<DeliveryResult> {
  const { run, candidate, snapshot, ledger, client, clock } = input;
  const config = snapshot.config;
  const { branch_prefix: branchPrefix, base_branch: baseBranch } = config.repository;
  const branch = run.branch ?? `${branchPrefix}${run.id}`;
  const remote = input.remote ?? config.repository.remote;
  const tree = candidate.treeHash;
  const warnings: string[] = [];

  const gateInput = { run, candidate, evidence: input.evidence, review: input.review, snapshot, currentTree: input.currentTree, expectedCheckConfigHash: input.expectedCheckConfigHash };
  // The objects in hand, then the recorded rows as they are now (a later invalidation or cancellation
  // must stop the next action), then the one git read that proves the candidate commit carries the reviewed tree.
  const gate = async (): Promise<void> => {
    assertDeliverable(gateInput);
    assertRecordedBindings(ledger.db, gateInput);
    await verifyCandidateTree(run.repoRoot, candidate);
  };
  // Refuse before anything is persisted or contacted.
  await gate();

  // Defense in depth: the branch rules are also enforced by authorize() and by pushBranch itself.
  assertTaskBranch(branch, { branchPrefix, baseBranch });

  const requireAllowed = (d: AuthorizationDecision, what: string): AuthorizationDecision => {
    if (!d.allowed) throw new OrbitError('POLICY_DENIED', `${what} is not authorized: ${d.reason}`, { rule: d.rule, definitive: true });
    return d;
  };
  const networkAllowed = (host: string | null): AuthorizationDecision =>
    host ? authorize(snapshot, { kind: 'network', host }) : { allowed: true, rule: 'network.local', reason: 'no remote host to authorize' };

  // ---- commit -----------------------------------------------------------
  const commitAuth = requireAllowed(authorize(snapshot, { kind: 'action', action: 'commit' }), 'committing');
  // Chain onto the run's last delivered commit so every repair cycle pushes a fast-forward, never a forced update.
  // The parent is part of the commit's identity (key, pin ref): a repair that reproduces an earlier tree must
  // make a new commit on top of the remote's head, not hand back the old commit and fail the push as stale.
  const last = ledger.list(run.id, { kind: 'commit', state: 'SUCCEEDED' }).at(-1);
  // The last delivered commit already carries this tree: this is a retry or a repeat of that delivery, so
  // keep its parent and the commit action resolves to its existing receipt instead of adding an empty commit.
  const lastParent = (last?.target as { parent?: string } | null)?.parent;
  const parent = (last && last.treeHash === tree && lastParent) || (last?.receipt as { commit?: string } | null)?.commit || candidate.parentSha;
  const identity = input.identity ?? (await readControllerIdentity(run.repoRoot, input.git));
  const message = commitMessage(run, input.report);
  const timeMs = clock.now();
  const ref = deliveryRef(run.id, tree, parent);

  const commitResult = await ledger.performAction<{ commit: string; tree: string }>(
    { runId: run.id, kind: 'commit', idempotencyKey: `deliver:${run.id}:commit:${parent}:${tree}`, target: { branch, tree, parent }, candidateId: candidate.id, treeHash: tree },
    {
      execute: async () => {
        const commit = await createDeliveryCommit({ repoRoot: run.repoRoot, tree, parent, message, identity, timeMs, ref, ...input.git });
        return { commit, tree };
      },
      // A commit object is local and the pinned ref says whether we made it before the receipt was lost.
      reconcile: async () => {
        const commit = await findDeliveryCommit(run.repoRoot, run.id, tree, parent, input.git);
        return commit ? { commit, tree } : null;
      },
    },
    { authorization: commitAuth, precheck: gate },
  );
  const commit = commitResult.receipt.commit;

  // ---- push -------------------------------------------------------------
  const pushAuth = requireAllowed(authorize(snapshot, { kind: 'action', action: 'push_task_branch', target: branch }), 'pushing the task branch');
  // A remote name is resolved to the URL git will push to, so the name cannot hide the host from the policy.
  requireAllowed(networkAllowed(remoteHost(await resolveRemoteUrl(run.repoRoot, remote, input.git))), 'reaching the remote');
  const remoteOpts = { repoRoot: run.repoRoot, remote, token: input.token, ...input.git };
  const pushResult = await ledger.performAction<PushReceipt>(
    { runId: run.id, kind: 'push', idempotencyKey: `deliver:${run.id}:push:${branch}:${commit}`, target: { remote: redact(remote), ref: `refs/heads/${branch}`, commit }, candidateId: candidate.id, treeHash: tree, commitSha: commit },
    {
      execute: () => pushBranch({ ...remoteOpts, branchPrefix, baseBranch, commit, branch }),
      reconcile: () => reconcilePush({ ...remoteOpts, commit, branch }),
    },
    { authorization: pushAuth, precheck: gate },
  );
  // The remote must hold exactly the commit we mean to open a PR for.
  const remoteSha = await lsRemoteBranch({ ...remoteOpts, branch });
  if (remoteSha !== commit) {
    throw new OrbitError('DELIVERY_FAILED', `after the push, ${remote} has ${remoteSha ?? 'no such branch'} at refs/heads/${branch}, expected ${commit}`, { branch, commit, remoteSha });
  }

  // ---- pull request -----------------------------------------------------
  const prMode = config.delivery.pull_request;
  let pr: PullRequestInfo | null = null;
  let prSkipped: string | null = null;
  const prAuth = prMode === 'none' ? ({ allowed: false, rule: 'delivery.pull_request', reason: 'delivery.pull_request is "none"' } as AuthorizationDecision) : authorize(snapshot, { kind: 'action', action: 'open_pull_request' });
  const apiAuth = config.delivery.provider === 'github' ? networkAllowed('api.github.com') : networkAllowed(null);

  if (!prAuth.allowed) {
    prSkipped = prAuth.reason;
  } else {
    requireAllowed(apiAuth, 'reaching the pull request API');
    const title = redact(firstLine(input.report.title || run.goal || `Orbit run ${run.id}`)).slice(0, TITLE_MAX) || `Orbit run ${run.id}`;
    const body = pullRequestBody({ run, report: input.report, commit, tree, evidence: input.evidence });
    const draft = prMode === 'draft';

    // One PR per run: this action is keyed by the branch alone, so a repair cycle's new commit never makes a second one.
    // Find by head branch first, always: a PR that already exists is adopted, never duplicated.
    await ledger.performAction<PullRequestInfo>(
      { runId: run.id, kind: 'pr_create', idempotencyKey: `deliver:${run.id}:pr-create:${branch}`, target: { head: branch, base: baseBranch, draft } },
      {
        execute: async () => (await client.findPullRequest(branch)) ?? client.createPullRequest({ head: branch, base: baseBranch, title, body, draft }),
        reconcile: () => client.findPullRequest(branch),
      },
      { authorization: prAuth, precheck: gate },
    );

    pr = await readPrAtCommit(client, clock, branch, commit, input.verifyAttempts ?? 3);
    if (pr.state !== 'OPEN') {
      throw new OrbitError('DELIVERY_FAILED', `pull request #${pr.number} for ${branch} is ${pr.state}; Orbit does not reopen or replace it`, { number: pr.number, state: pr.state, definitive: true });
    }
    if (pr.baseRefName !== baseBranch) {
      throw new OrbitError('DELIVERY_FAILED', `pull request #${pr.number} targets ${pr.baseRefName}, not ${baseBranch}`, { number: pr.number, definitive: true });
    }
    if (pr.isDraft !== draft) warnings.push(`pull request #${pr.number} is ${pr.isDraft ? 'a draft' : 'ready for review'}; the configured mode is ${prMode}`);

    if (pr.title !== title || pr.body !== body) {
      const number = pr.number;
      const updated = await ledger.performAction<PullRequestInfo>(
        // Keyed by the content too: the same commit re-delivered with a newer report is a new update, not a key collision.
        { runId: run.id, kind: 'pr_update', idempotencyKey: `deliver:${run.id}:pr-update:${number}:${commit}:${sha256(`${title}\n${body}`).slice(0, 16)}`, target: { number, title, bodyLength: body.length }, candidateId: candidate.id, treeHash: tree, commitSha: commit },
        {
          execute: () => client.updatePullRequest(number, { title, body }),
          reconcile: async () => {
            const now = await client.findPullRequest(branch);
            return now && now.title === title && now.body === body ? now : null;
          },
        },
        { authorization: prAuth, precheck: gate },
      );
      pr = updated.receipt;
    }
  }

  ledger.event(run.id, 'delivery.completed', { branch, commit, tree, pr: pr?.number ?? null, pr_skipped: prSkipped });
  return { commit, tree, branch, push: pushResult.receipt, pr, prSkipped, warnings, actions: ledger.list(run.id) };
}

/** Re-read the PR until its head shows the pushed commit; the host can lag a push by a moment. */
async function readPrAtCommit(client: GitHubClient, clock: Clock, branch: string, commit: string, attempts: number): Promise<PullRequestInfo> {
  let last: PullRequestInfo | null = null;
  for (let i = 0; i < Math.max(1, attempts); i++) {
    last = await client.findPullRequest(branch);
    if (!last) throw new OrbitError('DELIVERY_FAILED', `no pull request is listed for ${branch} after creating it`, { branch });
    if (last.headRefOid === commit) return last;
    if (i + 1 < attempts) await clock.sleep(1000 * (i + 1));
  }
  throw new OrbitError('DELIVERY_FAILED', `pull request #${last!.number} points at ${last!.headRefOid || 'an unknown commit'}, not the delivered ${commit}`, { number: last!.number, expected: commit, actual: last!.headRefOid, definitive: true });
}

function firstLine(s: string): string {
  return s.split('\n')[0]!.trim();
}

function commitMessage(run: DeliveryRun, report: DeliveryReport): string {
  const subject = redact(firstLine(report.title || run.goal || `Orbit run ${run.id}`)).slice(0, 72);
  return `${subject || `Orbit run ${run.id}`}\n\nOrbit run: ${run.id}\n`;
}

function pullRequestBody(i: { run: DeliveryRun; report: DeliveryReport; commit: string; tree: string; evidence: DeliveryEvidence }): string {
  // The target is the run's own repository, so only secrets are removed (no publication-guard terms apply).
  const summary = redact(i.report.summary.trim());
  const body = [
    summary,
    '',
    '---',
    `Orbit run: ${i.run.id}`,
    `Delivered commit: ${i.commit}`,
    `Tree: ${i.tree}`,
    `Evidence verdict: ${i.evidence.verdict} (bound to this tree)`,
  ].join('\n');
  return body.length > BODY_MAX ? `${body.slice(0, BODY_MAX)}\n[truncated]` : body;
}
