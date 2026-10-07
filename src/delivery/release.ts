/**
 * Release mode (spec section 5 Execution modes, section 15): the opt-in merge
 * of the exact reviewed candidate, then a deployment through a configured
 * release environment. Nothing here runs in any other mode.
 *
 * Merge. Only when the run contract asks for it (`delivery.merge`), the policy
 * authorizes `merge`, and, checked again before every attempt:
 *  - the freshness gate holds (evidence and review bind the candidate tree,
 *    under the run's policy, and nothing was invalidated or cancelled);
 *  - the commit being merged is the one delivery pushed for that tree, and
 *    the pull request's head is still exactly that commit (the host enforces
 *    it too, through `--match-head-commit`);
 *  - the branch checks are green on that commit, every
 *    `release.merge.require_checks` entry among them;
 *  - the controller's readiness callback (completion gate, review policy)
 *    passes and no material question is open.
 * The merge action is keyed by PR and head commit, so a candidate change is a
 * new action that is validated from the start; a lost merge response is
 * reconciled by reading the PR's merge state, never by merging again.
 *
 * A draft pull request cannot be merged, so with `release.merge.mark_ready`
 * (default true) the merge is preceded by a ledgered `pr_ready` action keyed by
 * PR and head commit; with it off, a draft refuses the merge with that reason.
 *
 * Deploy. Only to an environment the caller names and the release profile
 * defines (or, with `environments: 'all'`, to every defined environment the
 * deployed ref is allowed for, in profile order), with `deploy_production` authorized. The deployed ref must match
 * the environment's `allowed_branches` (the base branch after a merge, the
 * task branch without one), CI must be green on the deployed commit when the
 * environment requires it, and every host the command may reach must be in
 * `network.allowed_hosts`. The command comes from the frozen policy snapshot
 * (trusted configuration, never a worker), runs in a clean checkout of the
 * deployed commit under the configured isolation provider, and goes through
 * the action ledger like every external action. Its outcome is written to a
 * file the moment it exits, which is what reconciles a lost receipt. A deploy
 * that may have started but left no outcome, or that failed, is never re-run
 * automatically: it is reported as a blocker. An environment's trusted
 * `verify_command` (resolveDeploy) or a person (`orbit release resolve`) settles
 * an UNKNOWN deploy: deployed adopts it, not deployed lets the next call run it.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import picomatch from 'picomatch';
import type { Clock } from '../core/clock.ts';
import type { AuthorizationDecision, CheckDefinition, PolicySnapshot, ReleaseConfig, ReleaseEnvironment } from '../policy/types.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import { DEFAULT_ACTION_DEADLINE_MS, type ActionLedger, type ActionRecord } from './actions.ts';
import type { ChecksResult, GitHubClient, MergeMethod, MergeState, PullRequestInfo } from './github.ts';
import type { DeliveryCandidate, DeliveryEvidence, DeliveryReview, DeliveryRun } from './gate.ts';
import type { GitOptions } from './git.ts';
import { execCapture } from '../core/exec.ts';
import { OrbitError } from '../core/errors.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { recordDecision } from '../storage/decisions.ts';
import { redact } from '../core/redact.ts';
import { authorize } from '../policy/authorize.ts';
import { prepareFreshTmpDir, profileForCheck } from '../isolation/profiles.ts';
import { commandToolchains, prepareToolchainLayout, removeScratch, type ToolchainLayout } from '../isolation/toolchains.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../evidence/candidate.ts';
import { msbuildNodeDenialNote, msbuildNodeFix, nodeDenialSubject, runStoppingRefusedNodes } from '../evidence/msbuild.ts';
import { privateHomeDotnetEnv } from '../evidence/runner.ts';
import { assertDeliverable, assertRecordedBindings, verifyCandidateTree } from './gate.ts';
import { fetchBranchContaining, gitEnv, hasCommit, isObjectId, remoteHost, resolveRemoteUrl } from './git.ts';

export interface ReleaseReadiness {
  ok: boolean;
  /** Why not, for the blocker. */
  reasons: string[];
}

export interface ReleaseInput {
  run: DeliveryRun;
  candidate: DeliveryCandidate;
  evidence: DeliveryEvidence;
  review: DeliveryReview;
  snapshot: PolicySnapshot;
  ledger: ActionLedger;
  client: GitHubClient;
  clock: Clock;
  /** The commit delivery pushed for the candidate tree (DeliveryResult.commit). */
  commit: string;
  /** The run's pull request (DeliveryResult.pr.number); a merge needs one. */
  pr: number | null;
  /** The run contract's `delivery.merge`: the goal itself asks for a merge. Without it nothing is merged. */
  contractMerge: boolean;
  /** A key of `release.environments` to deploy to; null or omitted deploys nothing. Refused when the ref is not allowed. */
  environment?: string | null;
  /**
   * Several keys, or 'all' for every defined environment, deployed in order. Named keys are strict like `environment`;
   * with 'all' an environment whose allowed_branches do not cover the deployed ref is skipped with a reason, and
   * so is every environment when deploy_production is not authorized.
   */
  environments?: readonly string[] | 'all';
  /**
   * The controller's own release gate, evaluated now: the completion gate and
   * the review policy (blocking findings). Called before every release action
   * and before every retry. Open material questions are checked here as well.
   */
  readiness: () => ReleaseReadiness | Promise<ReleaseReadiness>;
  /** Isolation for the deploy command (getIsolation for the snapshot's isolation config). Required to deploy. */
  isolation?: IsolationProvider;
  /** Directory for deploy checkouts and outcome files, normally the run directory. Required to deploy. */
  workDir?: string;
  /** Controller-supplied environment for the deploy command (its deploy credentials). Never a worker-supplied value. */
  deployEnv?: Record<string, string>;
  /** Real home directory, used only to compute what the sandbox must hide (and to find a rustup installation). */
  homeDir?: string;
  /**
   * The repository's toolchain dependency caches (isolation/toolchains.ts toolchainCacheRoot), read-only for the deploy
   * command, beneath caches of its own where its tool reads a second cache. Absent: its caches are its own alone.
   */
  toolchainCacheRoot?: string | null;
  /** Overrides repository.remote (a name or URL). */
  remote?: string;
  /** Scoped token for HTTPS fetches of the merge commit. */
  token?: string;
  git?: GitOptions;
}

export interface MergeReceipt {
  number: number;
  /** The reviewed commit that was merged. */
  headSha: string;
  /** The commit the merge produced on the base branch. */
  mergeCommitSha: string | null;
  baseBranch: string;
  method: MergeMethod;
  mergedAt: string | null;
}

export interface DeployReceipt {
  environment: string;
  branch: string;
  sha: string;
  tree: string;
  exitCode: number;
  durationMs: number;
  isolation: string;
  limitations: string[];
  /** Redacted tail of the command's output. */
  output: string;
}

export interface ReleaseResult {
  /** released: every requested release action is done (or skipped with a reason); pending: waiting for checks, call again later. */
  status: 'released' | 'pending';
  pending: string | null;
  merge: MergeReceipt | null;
  mergeSkipped: string | null;
  /** The first deployment, or null; see `deploys` for all of them. */
  deploy: DeployReceipt | null;
  deploys: DeployReceipt[];
  deploySkipped: string | null;
  actions: ActionRecord[];
}

const OUTPUT_TAIL = 4000;
const ENV_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

/** The release profile in force, or null. */
export function releaseConfig(snapshot: PolicySnapshot): ReleaseConfig | null {
  return snapshot.config.release ?? null;
}

/**
 * Merge the reviewed candidate and deploy it, as far as the request and the
 * policy allow. Safe to call again after any failure, restart or `pending`
 * result: finished actions are no-ops by receipt and unfinished ones are
 * reconciled before anything is repeated.
 *
 * Throws, with `details.definitive: true` for anything a retry cannot fix:
 *  - POLICY_DENIED: not release mode, no release profile, an action or host
 *    not authorized, an environment not defined, a branch not allowed, the
 *    readiness gate failed or a material question is open;
 *  - STALE_EVIDENCE / POLICY_TAMPERED / CANCELLED from the freshness gate;
 *  - DELIVERY_FAILED: checks failed, the PR is not mergeable at the reviewed
 *    commit, a deploy failed or its outcome is unknown.
 */
export async function performRelease(input: ReleaseInput): Promise<ReleaseResult> {
  const { run, candidate, snapshot, ledger, client, commit } = input;
  const config = snapshot.config;
  const deny = (rule: string, reason: string, extra: Record<string, unknown> = {}): never => {
    throw new OrbitError('POLICY_DENIED', reason, { rule, definitive: true, ...extra });
  };
  // Mode first, before anything is read or contacted: release actions never exist outside release mode.
  if (config.mode !== 'release') deny('mode.release-required', `release actions need mode release; this run is ${config.mode}`);
  const release = releaseConfig(snapshot);
  if (!release) return deny('release.profile-missing', 'mode release needs a release profile (release: in the configuration)');

  const { base_branch: baseBranch, branch_prefix: branchPrefix } = config.repository;
  const branch = run.branch ?? `${branchPrefix}${run.id}`;
  const tree = candidate.treeHash;
  const remote = input.remote ?? config.repository.remote;
  const requireAllowed = (d: AuthorizationDecision, what: string): AuthorizationDecision => {
    if (!d.allowed) deny(d.rule, `${what} is not authorized: ${d.reason}`);
    return d;
  };

  const gateInput = { run, candidate, evidence: input.evidence, review: input.review, snapshot };
  // The objects in hand, the recorded rows as they are now, the candidate commit's tree, the pushed commit, then the controller's gate.
  const baseGate = async (): Promise<void> => {
    assertDeliverable(gateInput);
    assertRecordedBindings(ledger.db, gateInput);
    await verifyCandidateTree(run.repoRoot, candidate);
    assertDeliveredCommit(ledger, run.id, commit, tree);
    await verifyCommitTree(run.repoRoot, commit, tree, input.git);
    const blockers = openMaterialQuestions(ledger, run.id);
    if (blockers.length > 0) deny('release.open-blockers', `release refused: ${blockers.length} material question(s) are open (${blockers.join(', ')})`, { questions: blockers });
    const r = await input.readiness();
    if (!r.ok) deny('release.readiness', `release refused: ${r.reasons.join('; ') || 'the release gate did not pass'}`, { reasons: r.reasons });
  };
  await baseGate();

  const apiAllowed = (): void => {
    if (config.delivery.provider === 'github') requireAllowed(authorize(snapshot, { kind: 'network', host: 'api.github.com' }), 'reaching the pull request API');
  };

  const requested = requestedEnvironments(input, release);
  const definedEnvironment = (envName: string): ReleaseEnvironment => {
    if (!ENV_NAME.test(envName) || !Object.hasOwn(release.environments, envName)) {
      deny('release.environment', `release environment ${JSON.stringify(envName)} is not defined in the release profile (defined: ${Object.keys(release.environments).join(', ') || 'none'})`);
    }
    return release.environments[envName]!;
  };
  const allowedOn = (env: ReleaseEnvironment, onBranch: string): boolean => env.allowed_branches.length > 0 && picomatch(env.allowed_branches, { dot: true })(onBranch);
  const notAllowed = (envName: string, env: ReleaseEnvironment, onBranch: string): string => `environment ${envName} may not be deployed from ${onBranch} (allowed: ${env.allowed_branches.join(', ') || 'none'})`;

  // A named environment is refused before anything is merged: one that is not defined, or that the branch the deploy
  // would come from is not allowed for, must not leave a merged pull request behind a refused release.
  if (requested.strict && requested.names.length > 0) {
    requireAllowed(authorize(snapshot, { kind: 'action', action: 'deploy_production' }), 'deploying');
    const planned = input.contractMerge ? baseBranch : branch;
    for (const envName of requested.names) {
      if (!allowedOn(definedEnvironment(envName), planned)) deny('release.allowed_branches', notAllowed(envName, release.environments[envName]!, planned));
    }
  }

  // ---- merge ------------------------------------------------------------
  let merge: MergeReceipt | null = null;
  let mergeSkipped: string | null = null;
  if (!input.contractMerge) {
    mergeSkipped = 'the run contract does not ask for a merge (delivery.merge is false)';
  } else {
    const mergeAuth = requireAllowed(authorize(snapshot, { kind: 'action', action: 'merge' }), 'merging');
    if (input.pr === null) throw new OrbitError('DELIVERY_FAILED', 'the run has no pull request to merge', { definitive: true });
    apiAllowed();
    const number = input.pr;
    const { method, require_checks: requireChecks, delete_branch: deleteBranch } = release.merge;
    const key = `release:${run.id}:merge:${number}:${commit}`;
    const done = ledger.find(key);
    if (done?.state === 'SUCCEEDED') merge = done.receipt as MergeReceipt;
    else {
      const prGate = async (): Promise<MergeState> => {
        const s = await client.getMergeState(number);
        if (s.baseRefName !== baseBranch) throw new OrbitError('DELIVERY_FAILED', `pull request #${number} targets ${s.baseRefName}, not ${baseBranch}`, { definitive: true });
        if (s.state === 'CLOSED') throw new OrbitError('DELIVERY_FAILED', `pull request #${number} is closed; Orbit does not reopen it`, { definitive: true });
        // A merged PR is fine only at the reviewed commit: that is this action's own earlier attempt, which reconciliation adopts.
        if (s.headRefOid !== commit) {
          throw new OrbitError('STALE_EVIDENCE', `release refused: pull request #${number} head is ${s.headRefOid.slice(0, 12) || 'unknown'}, not the reviewed ${commit.slice(0, 12)}`, { definitive: true, expected: commit, actual: s.headRefOid });
        }
        return s;
      };
      const checksGate = async (): Promise<CheckVerdict> => verdictOf(await client.listChecks({ pr: number, sha: commit }), commit, requireChecks, config.delivery.require_ci);

      const state = await prGate();
      if (state.state === 'OPEN') {
        const v = await checksGate();
        if (v.state === 'pending') return pendingResult(ledger, run.id, `waiting for branch checks on ${commit.slice(0, 12)}: ${v.detail}`, null, mergeSkipped);
        if (v.state === 'failed') throw new OrbitError('DELIVERY_FAILED', `merge refused: branch checks on ${commit.slice(0, 12)} are not green: ${v.detail}`, { definitive: true, checks: v.detail });
        await markReadyIfDraft({ number, commit, branch, tree, markReady: release.merge.mark_ready, run, candidate, client, ledger, mergeAuth, precheck: async () => { await baseGate(); await prGate(); } });
      }

      const receiptOf = (s: MergeState): MergeReceipt => ({ number, headSha: s.headRefOid, mergeCommitSha: s.mergeCommitSha, baseBranch: s.baseRefName, method, mergedAt: s.mergedAt });
      const result = await ledger.performAction<MergeReceipt>(
        { runId: run.id, kind: 'merge', idempotencyKey: key, target: { pr: number, head: commit, base: baseBranch, method, delete_branch: deleteBranch, require_checks: requireChecks }, candidateId: candidate.id, treeHash: tree, commitSha: commit },
        {
          execute: async () => {
            const s = await client.mergePullRequest({ number, headSha: commit, method, deleteBranch });
            if (s.state !== 'MERGED' || s.headRefOid !== commit) {
              throw new OrbitError('DELIVERY_FAILED', `after the merge, pull request #${number} is ${s.state} at ${s.headRefOid.slice(0, 12)}, not merged at ${commit.slice(0, 12)}`, { definitive: true });
            }
            return receiptOf(s);
          },
          reconcile: async () => {
            const s = await client.getMergeState(number);
            if (s.state === 'OPEN') return null;
            if (s.state === 'MERGED' && s.headRefOid === commit) return receiptOf(s);
            throw new OrbitError('DELIVERY_FAILED', `pull request #${number} is ${s.state} at ${s.headRefOid.slice(0, 12)}; the reviewed ${commit.slice(0, 12)} was not merged by Orbit`, { definitive: true });
          },
        },
        {
          authorization: mergeAuth,
          // Everything again before each attempt: a candidate, review, check or blocker change since the first read stops the merge.
          precheck: async () => {
            requireAllowed(authorize(snapshot, { kind: 'action', action: 'merge' }), 'merging');
            await baseGate();
            const s = await prGate();
            if (s.state === 'MERGED') return;
            const v = await checksGate();
            if (v.state !== 'passed') throw new OrbitError('DELIVERY_FAILED', `merge refused: branch checks on ${commit.slice(0, 12)} are ${v.state}: ${v.detail}`, { definitive: v.state === 'failed', checks: v.detail });
          },
        },
      );
      merge = result.receipt;
    }
  }

  // ---- deploy -----------------------------------------------------------
  const deploys: DeployReceipt[] = [];
  const skipped: string[] = [];
  if (requested.names.length === 0) {
    skipped.push(requested.none);
  } else {
    // Named environments are strict: a refusal is an error. 'all' only skips what this release is not for.
    const deployAuthDecision = authorize(snapshot, { kind: 'action', action: 'deploy_production' });
    if (!requested.strict && !deployAuthDecision.allowed) {
      skipped.push(`deploying is not authorized: ${deployAuthDecision.reason}`);
    } else {
      const deployAuth = requireAllowed(deployAuthDecision, 'deploying');
      // After a merge the base branch carries the release; without one, the task branch at the delivered commit.
      const target = merge ? { branch: merge.baseBranch, sha: merge.mergeCommitSha } : { branch, sha: commit };
      for (const envName of requested.names) {
        const env = definedEnvironment(envName);
        if (!allowedOn(env, target.branch)) {
          if (requested.strict) deny('release.allowed_branches', notAllowed(envName, env, target.branch));
          skipped.push(`environment ${envName} is not deployed from ${target.branch} (allowed: ${env.allowed_branches.join(', ') || 'none'})`);
          continue;
        }
        if (!target.sha || !isObjectId(target.sha)) throw new OrbitError('DELIVERY_FAILED', `the merge of pull request #${merge?.number} reported no merge commit to deploy`, { definitive: true });
        const sha = target.sha;
        for (const host of env.network_hosts) requireAllowed(authorize(snapshot, { kind: 'network', host }), `deploy network access to ${host}`);
        if (!Array.isArray(env.deploy_command) || env.deploy_command.length === 0 || env.deploy_command.some((a) => typeof a !== 'string' || a.length === 0)) {
          throw new OrbitError('CONFIG_INVALID', `release environment ${envName} has no usable deploy_command`, { definitive: true });
        }
        if (!input.isolation || !input.workDir) throw new OrbitError('INTERNAL', 'deploying needs an isolation provider and a work directory');
        const isolation = input.isolation;
        const files = deployFiles(input.workDir, envName, sha);

        const key = `release:${run.id}:deploy:${envName}:${sha}`;
        const prior = ledger.find(key);
        if (prior?.state === 'SUCCEEDED') {
          deploys.push(prior.receipt as DeployReceipt);
          continue;
        }
        if (prior?.state === 'FAILED') {
          const unknown = deployTimedOut(files, sha);
          throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} to ${envName} failed earlier (${prior.error ?? 'no detail'}); a failed deploy is not retried automatically${unknown ? '; it timed out, so run "orbit release resolve <run-id>" to settle whether it took effect' : ''}`, { definitive: true, actionId: prior.id, ...(unknown ? unknownDetails(envName, sha) : {}) });
        }
        const ciGate = async (): Promise<CheckVerdict> => verdictOf(await client.listChecks({ sha }), sha, [], true);
        if (env.require_ci_green) {
          apiAllowed();
          const v = await ciGate();
          if (v.state === 'pending') return pendingResult(ledger, run.id, `waiting for CI on ${sha.slice(0, 12)} before deploying to ${envName}: ${v.detail}`, merge, mergeSkipped, deploys);
          if (v.state === 'failed') throw new OrbitError('DELIVERY_FAILED', `deploy refused: CI on ${sha.slice(0, 12)} is not green: ${v.detail}`, { definitive: true, checks: v.detail });
        }

        const result = await ledger.performAction<DeployReceipt>(
          { runId: run.id, kind: 'deploy', idempotencyKey: key, target: { environment: envName, branch: target.branch, sha, command: env.deploy_command.map((a) => redact(a)) }, candidateId: candidate.id, treeHash: tree, commitSha: sha },
          {
            execute: (ctx) => runDeploy({ input, env, envName, branch: target.branch, sha, isolation, files, attempt: ctx.attempt, remote, viaBaseBranch: merge !== null }),
            reconcile: async () => readDeployOutcome(files, sha, envName),
          },
          {
            authorization: deployAuth,
            // The deploy command may run for its whole timeout, plus the fetch and checkout before it.
            deadlineMs: env.timeout_seconds * 1000 + DEFAULT_ACTION_DEADLINE_MS,
            precheck: async () => {
              requireAllowed(authorize(snapshot, { kind: 'action', action: 'deploy_production' }), 'deploying');
              await baseGate();
              if (env.require_ci_green) {
                const v = await ciGate();
                if (v.state !== 'passed') throw new OrbitError('DELIVERY_FAILED', `deploy refused: CI on ${sha.slice(0, 12)} is ${v.state}: ${v.detail}`, { definitive: v.state === 'failed', checks: v.detail });
              }
            },
          },
        );
        deploys.push(result.receipt);
      }
    }
  }
  const deploySkipped = skipped.length > 0 ? skipped.join('; ') : null;

  ledger.event(run.id, 'release.completed', { merge: merge ? { pr: merge.number, head: merge.headSha, merge_commit: merge.mergeCommitSha } : null, merge_skipped: mergeSkipped, deploy: deploys[0] ? { environment: deploys[0].environment, sha: deploys[0].sha } : null, deploys: deploys.map((d) => ({ environment: d.environment, sha: d.sha })), deploy_skipped: deploySkipped });
  return { status: 'released', pending: null, merge, mergeSkipped, deploy: deploys[0] ?? null, deploys, deploySkipped, actions: ledger.list(run.id) };
}

/** Which environments this call deploys to: the named ones (strict), or every defined one. */
function requestedEnvironments(input: ReleaseInput, release: ReleaseConfig): { names: string[]; strict: boolean; none: string } {
  const all = Object.keys(release.environments);
  if (input.environments === 'all') return { names: all, strict: false, none: 'no release environment is defined in the release profile' };
  const names = input.environments ? [...input.environments] : input.environment ? [input.environment] : [];
  return { names, strict: true, none: 'no release environment was requested' };
}

/**
 * A draft pull request cannot be merged. With mark_ready (default) it is marked ready first, as its own
 * ledgered action keyed by PR and head commit (a lost response is reconciled by reading the PR); without it
 * the merge is refused for that reason, and nothing is changed on the host.
 */
async function markReadyIfDraft(a: {
  number: number;
  commit: string;
  branch: string;
  tree: string;
  markReady: boolean | undefined;
  run: DeliveryRun;
  candidate: DeliveryCandidate;
  client: GitHubClient;
  ledger: ActionLedger;
  mergeAuth: AuthorizationDecision;
  precheck: () => Promise<void>;
}): Promise<void> {
  const { number, commit, client } = a;
  const key = `release:${a.run.id}:pr-ready:${number}:${commit}`;
  const done = a.ledger.find(key);
  if (done?.state === 'SUCCEEDED') return;
  const pr = await client.findPullRequest(a.branch);
  if (!pr || pr.number !== number || !pr.isDraft) return;
  if (a.markReady === false) {
    throw new OrbitError('DELIVERY_FAILED', `merge refused: pull request #${number} is a draft and release.merge.mark_ready is false; mark it ready for review or turn mark_ready on`, { definitive: true, draft: true });
  }
  await a.ledger.performAction<PullRequestInfo>(
    { runId: a.run.id, kind: 'pr_ready', idempotencyKey: key, target: { pr: number, head: commit }, candidateId: a.candidate.id, treeHash: a.tree, commitSha: commit },
    {
      execute: async () => {
        const r = await client.markPullRequestReady(number);
        if (r.isDraft) throw new OrbitError('DELIVERY_FAILED', `pull request #${number} is still a draft after it was marked ready`, { definitive: true });
        return r;
      },
      reconcile: async () => {
        const now = await client.findPullRequest(a.branch);
        return now && now.number === number && !now.isDraft ? now : null;
      },
    },
    { authorization: a.mergeAuth, precheck: a.precheck },
  );
}

function pendingResult(ledger: ActionLedger, runId: string, reason: string, merge: MergeReceipt | null, mergeSkipped: string | null, deploys: DeployReceipt[] = []): ReleaseResult {
  return { status: 'pending', pending: reason, merge, mergeSkipped, deploy: deploys[0] ?? null, deploys, deploySkipped: null, actions: ledger.list(runId) };
}

// ---------------------------------------------------------------------------
// gates

/** The commit must be the one delivery pushed for this tree, as the ledger recorded it. */
function assertDeliveredCommit(ledger: ActionLedger, runId: string, commit: string, tree: string): void {
  const pushed = ledger.list(runId, { kind: 'push', state: 'SUCCEEDED' }).filter((a) => a.commitSha === commit && a.treeHash === tree);
  if (pushed.length === 0) {
    throw new OrbitError('STALE_EVIDENCE', `release refused: ${commit.slice(0, 12)} is not a commit delivery pushed for the reviewed tree ${tree.slice(0, 12)}`, { definitive: true, commit, tree });
  }
}

async function verifyCommitTree(repoRoot: string, commit: string, tree: string, opts: GitOptions = {}): Promise<void> {
  const res = await execCapture(['git', 'rev-parse', '--verify', '--quiet', `${commit}^{tree}`], { cwd: repoRoot, env: opts.env ?? gitEnv(), timeoutMs: 30_000 });
  if (res.exitCode !== 0 || res.stdout.trim() !== tree) {
    throw new OrbitError('STALE_EVIDENCE', `release refused: commit ${commit.slice(0, 12)} does not carry the reviewed tree ${tree.slice(0, 12)}`, { definitive: true });
  }
}

function openMaterialQuestions(ledger: ActionLedger, runId: string): string[] {
  return ledger.db.all<{ id: string }>("SELECT id FROM questions WHERE run_id = ? AND status = 'open' AND material = 1 ORDER BY created_at, rowid", runId).map((r) => r.id);
}

export interface CheckVerdict {
  state: 'passed' | 'pending' | 'failed';
  detail: string;
}

/**
 * Judge a checks listing for `sha`. Required names must be present and pass;
 * any failing or cancelled check fails; anything still running is pending;
 * checks reported for another commit are pending (the host has not caught up);
 * no checks at all is pending when checks are required, else a pass.
 */
export function verdictOf(result: ChecksResult, sha: string, required: readonly string[], requireAny: boolean): CheckVerdict {
  if (result.headSha && result.headSha !== sha) return { state: 'pending', detail: `checks are reported for ${result.headSha.slice(0, 12)}, not ${sha.slice(0, 12)}` };
  const failed = result.checks.filter((c) => c.bucket === 'fail' || c.bucket === 'cancel').map((c) => `${c.name} (${c.bucket})`);
  if (failed.length > 0) return { state: 'failed', detail: `failing: ${failed.join(', ')}` };
  const missing: string[] = [];
  const notPassed: string[] = [];
  for (const name of required) {
    const runs = result.checks.filter((c) => c.name === name);
    if (runs.length === 0) missing.push(name);
    else if (!runs.every((c) => c.bucket === 'pass')) notPassed.push(name);
  }
  const pending = result.checks.filter((c) => c.bucket === 'pending').map((c) => c.name);
  if (pending.length > 0 || missing.length > 0 || notPassed.length > 0) {
    const parts = [pending.length ? `running: ${pending.join(', ')}` : '', missing.length ? `not reported yet: ${missing.join(', ')}` : '', notPassed.length ? `not passed: ${notPassed.join(', ')}` : ''].filter(Boolean);
    return { state: 'pending', detail: parts.join('; ') };
  }
  if (result.absent || result.checks.length === 0) {
    return requireAny || required.length > 0 ? { state: 'pending', detail: 'no checks reported yet' } : { state: 'passed', detail: 'no checks are configured or required' };
  }
  return { state: 'passed', detail: `${result.checks.length} check(s) green` };
}

// ---------------------------------------------------------------------------
// deploy execution

interface DeployFiles {
  dir: string;
  checkout: string;
  home: string;
  started: string;
  outcome: string;
}

interface DeployOutcome {
  environment: string;
  branch: string;
  sha: string;
  tree: string;
  attempt: number;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  isolation: string;
  limitations: string[];
  output: string;
}

function deployFiles(workDir: string, envName: string, sha: string): DeployFiles {
  const dir = join(workDir, 'release', `deploy-${envName}-${sha.slice(0, 12)}`);
  return { dir, checkout: join(dir, 'checkout'), home: join(dir, 'home'), started: join(dir, 'started.json'), outcome: join(dir, 'outcome.json') };
}

/**
 * What the outcome file says: the receipt for a clean exit; a definitive
 * failure for any other recorded exit (a failed deploy is not re-run); a
 * definitive "unknown" when the command started and left no outcome; null
 * only when it never started, which makes executing it safe.
 */
function readDeployOutcome(files: DeployFiles, sha: string, envName: string): DeployReceipt | null {
  const outcome = readJsonIfExists<DeployOutcome>(files.outcome);
  if (outcome && outcome.sha === sha) {
    if (outcome.exitCode === 0 && !outcome.timedOut) return receiptOf(outcome);
    throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} to ${outcome.environment} ${outcome.timedOut ? 'timed out, so whether it took effect is unknown' : `exited ${outcome.exitCode ?? 'by signal'}`}; it is not retried automatically`, { definitive: true, ...(outcome.timedOut ? unknownDetails(envName, sha) : {}) });
  }
  if (existsSync(files.started)) {
    throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} started but recorded no outcome (the controller stopped while it ran); check the environment, then run "orbit release resolve <run-id>" (the environment's verify_command) or pass --deployed or --not-deployed`, { definitive: true, outcomeUnknown: true, environment: envName, sha });
  }
  return null;
}

function unknownDetails(environment: string, sha: string): Record<string, unknown> {
  return { outcomeUnknown: true, environment, sha };
}

/** A deploy that timed out may still have taken effect: that is an unknown outcome, not a plain failure. */
function deployTimedOut(files: DeployFiles, sha: string): boolean {
  const o = readJsonIfExists<DeployOutcome>(files.outcome);
  return o !== null && o.sha === sha && o.timedOut === true;
}

function receiptOf(o: DeployOutcome): DeployReceipt {
  return { environment: o.environment, branch: o.branch, sha: o.sha, tree: o.tree, exitCode: o.exitCode ?? -1, durationMs: o.durationMs, isolation: o.isolation, limitations: o.limitations, output: o.output };
}

async function runDeploy(a: {
  input: ReleaseInput;
  env: ReleaseEnvironment;
  envName: string;
  branch: string;
  sha: string;
  isolation: IsolationProvider;
  files: DeployFiles;
  attempt: number;
  remote: string;
  viaBaseBranch: boolean;
}): Promise<DeployReceipt> {
  const { input, env, envName, branch, sha, files } = a;
  const { run, snapshot } = input;
  const repoRoot = run.repoRoot;

  // The deployed commit locally: the delivered commit is already here; a merge commit is fetched from the base branch.
  if (!(await hasCommit(repoRoot, sha, input.git))) {
    if (!a.viaBaseBranch) throw new OrbitError('DELIVERY_FAILED', `commit ${sha.slice(0, 12)} is not in the repository`, { definitive: true });
    const host = remoteHost(await resolveRemoteUrl(repoRoot, a.remote, input.git));
    if (host) {
      const d = authorize(snapshot, { kind: 'network', host });
      if (!d.allowed) throw new OrbitError('POLICY_DENIED', `fetching the merge commit is not authorized: ${d.reason}`, { rule: d.rule, definitive: true });
    }
    await fetchBranchContaining({ repoRoot, remote: a.remote, token: input.token, ...input.git, branch, commit: sha, ref: `refs/orbit/release/${run.id}` });
  }

  mkdirSync(files.dir, { recursive: true, mode: 0o700 });
  if (existsSync(files.checkout)) await cleanupCandidateCheckout(repoRoot, files.checkout);
  const checkout = await materializeCandidate(repoRoot, sha, files.checkout, { readOnly: false });
  try {
    const tree = (await execCapture(['git', 'rev-parse', `${sha}^{tree}`], { cwd: repoRoot, env: gitEnv(), timeoutMs: 30_000 })).stdout.trim();
    mkdirSync(files.home, { recursive: true, mode: 0o700 });
    const tmp = prepareFreshTmpDir(files.dir);
    const def: CheckDefinition = {
      id: `release:${envName}`,
      command: [...env.deploy_command],
      shell: false,
      cwd: '.',
      timeout_seconds: env.timeout_seconds,
      network_hosts: [...env.network_hosts],
      local_binding: false,
      env: {},
      mandatory: true,
      flaky_reruns: 0,
      kind: 'command',
      category: 'other',
    };
    const field = `release.environments.${envName}.deploy_command`;
    const scratch = join(files.dir, 'toolchains');
    const toolchains = releaseToolchains({ command: env.deploy_command, checkout, cacheRoot: input.toolchainCacheRoot ?? null, scratch, tmp, isolation: a.isolation.kind, networkHosts: env.network_hosts, ...(input.homeDir ? { homeDir: input.homeDir } : {}) });
    const profile = profileForCheck({ worktree: checkout, check: def, snapshot, extraWritable: [files.home, tmp, ...toolchains.writable], readablePaths: toolchains.readOnly, nisDomainName: toolchains.nisDomainName, ...(input.homeDir ? { homeDir: input.homeDir } : {}) });
    const cmdEnv = releaseCommandEnv({ home: files.home, tmp, toolchainEnv: toolchains.env, deployEnv: input.deployEnv, runId: run.id, envName, branch, sha });
    let outcome: DeployOutcome;
    let stopped: string | null = null;
    try {
      const wrapped = a.isolation.wrap([...env.deploy_command], profile, { cwd: checkout, env: cmdEnv });
      // The marker goes down before the command starts: from here on, a missing outcome means "unknown", never "not run".
      atomicWriteJson(files.started, { environment: envName, sha, attempt: a.attempt, started_at: input.clock.now() }, 0o600);
      try {
        const ran = await runReleaseCommand({ argv: wrapped.argv, checkout, env: wrapped.env, timeoutMs: env.timeout_seconds * 1000, tmp, command: env.deploy_command, field, what: 'the deploy command' });
        const res = ran.result;
        stopped = ran.stopped ? ran.note : null;
        const output = redact(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}${ran.note ? `\n[orbit] ${ran.note}` : ''}`).slice(-OUTPUT_TAIL);
        // Stopped, it has no exit code of its own: srt exits 0 on SIGTERM (measured), which must never read as deployed.
        outcome = { environment: envName, branch, sha, tree, attempt: a.attempt, exitCode: ran.stopped ? null : res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, isolation: a.isolation.kind, limitations: wrapped.limitations, output };
      } finally {
        wrapped.cleanup();
      }
    } finally {
      removeScratch(scratch);
    }
    atomicWriteJson(files.outcome, outcome, 0o600);
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      // Stopped for a refused MSBuild node, its build could not succeed: a failure like any other exit, with the note whole.
      const ended = outcome.timedOut ? `timed out after ${env.timeout_seconds}s, so whether it took effect is unknown` : stopped ? 'was stopped' : `exited ${outcome.exitCode ?? 'by signal'}`;
      throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} to ${envName} ${ended}: ${redact(stopped ?? '') || outcome.output.slice(-500)}`, { definitive: true, ...(outcome.timedOut ? unknownDetails(envName, sha) : {}) });
    }
    return receiptOf(outcome);
  } finally {
    await cleanupCandidateCheckout(repoRoot, files.checkout).catch(() => {});
  }
}

/**
 * The toolchain layout of a deploy or verify command (docs/decisions/0009-toolchain-profiles.md, addendum, items 14 and
 * 16), found as a check's is from its command and the deployed checkout's marker files: dependency caches of its own,
 * which it fills on the environment's hosts as it did with the private HOME it had before, the repository's read-only
 * beneath them where its tool reads a second cache (only Orbit's install step writes those), build state private to the
 * command, and for .NET the NIS rule. With the check's read-only caches it could fetch nothing: a deploy `go run .`
 * that fetched one module failed with "go: writing go.mod cache: mkdir <orbit home>/toolchains/<key>/gomod/cache:
 * operation not permitted" under srt, where it had exited 0.
 */
function releaseToolchains(a: { command: readonly string[]; checkout: string; cacheRoot: string | null; scratch: string; tmp: string; isolation: IsolationProvider['kind']; networkHosts: readonly string[]; homeDir?: string }): ToolchainLayout {
  const layout = commandToolchains({ command: a.command, roots: [a.checkout], mode: 'fetch', cacheRoot: a.cacheRoot, scratchRoot: a.scratch, tmpDir: a.tmp, isolation: a.isolation, networkHosts: a.networkHosts, ...(a.homeDir ? { hostHome: a.homeDir } : {}), hostEnv: process.env });
  prepareToolchainLayout(layout);
  return layout;
}

/**
 * Run a wrapped release command, stopped as soon as MSBuild records a worker node the sandbox refused (it would wait 30 s
 * for each of ten node starts, past many a command's timeout, which leaves a deploy UNKNOWN). `note`: that denial with
 * the command's field fixed, or null.
 */
async function runReleaseCommand(a: { argv: string[]; checkout: string; env: Record<string, string>; timeoutMs: number; tmp: string; command: readonly string[]; field: string; what: string }) {
  const ran = await runStoppingRefusedNodes(a.tmp, (signal) => execCapture(a.argv, { cwd: a.checkout, env: a.env, timeoutMs: a.timeoutMs, maxOutputBytes: 1024 * 1024, abortSignal: signal }));
  const note = ran.denial ? msbuildNodeDenialNote(ran.denial, msbuildNodeFix({ id: a.field, command: [...a.command], shell: false }, { command: a.field, env: null }), ran.stopped, nodeDenialSubject(a.what)) : null;
  return { result: ran.result, stopped: ran.stopped, note };
}

/**
 * The scrubbed environment of a deploy or verify command: the controller's deploy credentials, never a worker's. Its
 * toolchains' variables first (they cannot replace what is fixed here), and the .NET settings of a check's private home,
 * the home prepared as a check's: with a new, empty home every dotnet command is the SDK's first run, which the sandbox
 * refuses (issue #26).
 */
function releaseCommandEnv(a: { home: string; tmp: string; toolchainEnv?: Record<string, string>; deployEnv: Record<string, string> | undefined; runId: string; envName: string; branch: string; sha: string; extra?: Record<string, string> }): Record<string, string> {
  return {
    ...(a.toolchainEnv ?? {}),
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: a.home,
    TMPDIR: a.tmp,
    LANG: platform() === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    NO_COLOR: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...privateHomeDotnetEnv(a.home),
    ...(a.deployEnv ?? {}),
    ORBIT_RUN_ID: a.runId,
    ORBIT_RELEASE_ENVIRONMENT: a.envName,
    ORBIT_RELEASE_BRANCH: a.branch,
    ORBIT_RELEASE_SHA: a.sha,
    ...(a.extra ?? {}),
  };
}

// ---------------------------------------------------------------------------
// settling an UNKNOWN deploy

export type DeployResolutionKind = 'verify' | 'deployed' | 'not-deployed';

export interface ResolveDeployInput {
  run: DeliveryRun;
  snapshot: PolicySnapshot;
  ledger: ActionLedger;
  clock: Clock;
  /** Normally the run directory (the same one performRelease deployed from). */
  workDir: string;
  /** The environment key; required only when more than one deploy awaits resolution. */
  environment?: string;
  /**
   * verify: run the environment's trusted verify_command. Exit 0 means the deploy took effect, exit 1 that it did
   * not, anything else (another exit, a timeout, no verify_command) that this cannot tell, and nothing changes.
   * deployed | not-deployed: record what a person found out.
   */
  resolution: DeployResolutionKind;
  /** Who resolved it, for the record. */
  by: string;
  /** Required to run a verify_command. */
  isolation?: IsolationProvider;
  deployEnv?: Record<string, string>;
  homeDir?: string;
  /** The repository's toolchain dependency caches, read-only for the verify_command (ReleaseInput.toolchainCacheRoot). */
  toolchainCacheRoot?: string | null;
  git?: GitOptions;
}

export interface DeployResolution {
  actionId: string;
  environment: string;
  branch: string;
  sha: string;
  verdict: 'deployed' | 'not-deployed' | 'unknown';
  via: 'verify_command' | 'person';
  detail: string;
}

/** Deploy actions whose outcome nobody knows: started with no receipt (EXECUTING, UNKNOWN), or timed out. */
export function unresolvedDeploys(ledger: ActionLedger, runId: string, workDir: string): ActionRecord[] {
  return ledger.list(runId, { kind: 'deploy' }).filter((a) => {
    if (a.state === 'EXECUTING' || a.state === 'UNKNOWN') return true;
    if (a.state !== 'FAILED') return false;
    const t = a.target as { environment?: string; sha?: string } | null;
    return typeof t?.environment === 'string' && typeof t.sha === 'string' && deployTimedOut(deployFiles(workDir, t.environment, t.sha), t.sha);
  });
}

/**
 * Settle a deploy left UNKNOWN (a crash mid-deploy, a lost outcome, a timeout). A deploy that took effect is
 * recorded as the action's receipt, so nothing runs again; one that did not has its started marker removed, so the
 * next performRelease may run it, within the ledger's attempt budget. Everything is recorded as a decision.
 */
export async function resolveDeploy(input: ResolveDeployInput): Promise<DeployResolution> {
  const { run, snapshot, ledger } = input;
  if (snapshot.config.mode !== 'release') throw new OrbitError('POLICY_DENIED', `resolving a deploy needs mode release; this run is ${snapshot.config.mode}`, { rule: 'mode.release-required' });
  const release = releaseConfig(snapshot);
  if (!release) throw new OrbitError('POLICY_DENIED', 'mode release needs a release profile (release: in the configuration)', { rule: 'release.profile-missing' });
  const pending = unresolvedDeploys(ledger, run.id, input.workDir).filter((a) => input.environment === undefined || (a.target as { environment?: string }).environment === input.environment);
  if (pending.length === 0) throw new OrbitError('NOT_FOUND', `run ${run.id} has no deploy with an unknown outcome${input.environment ? ` to ${input.environment}` : ''}`);
  if (pending.length > 1) {
    throw new OrbitError('TRANSITION_INVALID', `run ${run.id} has ${pending.length} deploys with an unknown outcome (${pending.map((a) => (a.target as { environment: string }).environment).join(', ')}); name one with --environment`);
  }
  const action = pending[0]!;
  const t = action.target as { environment: string; branch: string; sha: string };
  const files = deployFiles(input.workDir, t.environment, t.sha);
  const done = (verdict: DeployResolution['verdict'], via: DeployResolution['via'], detail: string): DeployResolution => ({ actionId: action.id, environment: t.environment, branch: t.branch, sha: t.sha, verdict, via, detail });

  let verdict: DeployResolution['verdict'];
  let via: DeployResolution['via'] = 'person';
  let detail: string;
  if (input.resolution === 'verify') {
    via = 'verify_command';
    const env = Object.hasOwn(release.environments, t.environment) ? release.environments[t.environment]! : null;
    if (!env) throw new OrbitError('CONFIG_INVALID', `release environment ${t.environment} is no longer defined in the release profile`, { definitive: true });
    if (!Array.isArray(env.verify_command) || env.verify_command.length === 0 || env.verify_command.some((a) => typeof a !== 'string' || a.length === 0)) {
      return done('unknown', via, `environment ${t.environment} has no verify_command`);
    }
    if (!input.isolation) throw new OrbitError('INTERNAL', 'running a verify_command needs an isolation provider');
    const res = await runVerifyCommand({ input, env, envName: t.environment, branch: t.branch, sha: t.sha, files, isolation: input.isolation, command: env.verify_command });
    verdict = res.verdict;
    detail = res.detail;
  } else {
    verdict = input.resolution;
    detail = `${input.by} reports the deploy of ${t.sha.slice(0, 12)} to ${t.environment} ${input.resolution === 'deployed' ? 'took effect' : 'did not take effect'}`;
  }

  ledger.event(run.id, 'release.deploy-resolution', { action_id: action.id, environment: t.environment, sha: t.sha, via, verdict, by: input.by });
  if (verdict === 'unknown') return done(verdict, via, detail);

  if (verdict === 'deployed') {
    const receipt: DeployReceipt = { environment: t.environment, branch: t.branch, sha: t.sha, tree: action.treeHash ?? '', exitCode: 0, durationMs: 0, isolation: via === 'verify_command' ? 'verify_command' : 'person', limitations: [`resolved after an unknown outcome: ${detail}`], output: redact(detail).slice(-OUTPUT_TAIL) };
    mkdirSync(files.dir, { recursive: true, mode: 0o700 });
    // The outcome file is what reconciles a deploy, so it says the same thing as the ledger.
    atomicWriteJson(files.outcome, { environment: t.environment, branch: t.branch, sha: t.sha, tree: receipt.tree, attempt: action.attempts, exitCode: 0, timedOut: false, durationMs: 0, isolation: receipt.isolation, limitations: receipt.limitations, output: receipt.output } satisfies DeployOutcome, 0o600);
    ledger.recordReceipt(action, receipt, 'reconcile');
  } else {
    // Nothing took effect: forget that it started, and leave the action reconcilable so the next call may execute it.
    rmSync(files.started, { force: true });
    rmSync(files.outcome, { force: true });
    ledger.markUnknown(action, `resolved: the deploy did not take effect (${detail})`);
  }
  recordDecision(
    ledger.db,
    input.workDir,
    { id: `dec-${action.id}-resolved-${verdict}-${ledger.get(action.id).updatedAt}`, runId: run.id, kind: 'release.deploy-resolved', summary: `deploy of ${t.sha.slice(0, 12)} to ${t.environment} resolved as ${verdict} by ${via === 'verify_command' ? 'verify_command' : input.by}: ${detail}`, data: { action_id: action.id, environment: t.environment, sha: t.sha, verdict, via, by: input.by } },
    input.clock,
    { actor: input.by },
  );
  return done(verdict, via, detail);
}

async function runVerifyCommand(a: {
  input: ResolveDeployInput;
  env: ReleaseEnvironment;
  envName: string;
  branch: string;
  sha: string;
  files: DeployFiles;
  isolation: IsolationProvider;
  command: readonly string[];
}): Promise<{ verdict: DeployResolution['verdict']; detail: string }> {
  const { input, env, envName, branch, sha, files } = a;
  const { run, snapshot } = input;
  for (const host of env.network_hosts) {
    const d = authorize(snapshot, { kind: 'network', host });
    if (!d.allowed) throw new OrbitError('POLICY_DENIED', `verifying the deploy needs network access to ${host}: ${d.reason}`, { rule: d.rule, definitive: true });
  }
  if (!(await hasCommit(run.repoRoot, sha, input.git))) return { verdict: 'unknown', detail: `commit ${sha.slice(0, 12)} is not in the repository, so the verify_command has nothing to run on` };
  const dir = join(files.dir, 'verify');
  const checkoutDir = join(dir, 'checkout');
  const home = join(dir, 'home');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (existsSync(checkoutDir)) await cleanupCandidateCheckout(run.repoRoot, checkoutDir);
  const checkout = await materializeCandidate(run.repoRoot, sha, checkoutDir, { readOnly: false });
  try {
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const tmp = prepareFreshTmpDir(dir);
    const def: CheckDefinition = { id: `release-verify:${envName}`, command: [...a.command], shell: false, cwd: '.', timeout_seconds: env.timeout_seconds, network_hosts: [...env.network_hosts], local_binding: false, env: {}, mandatory: true, flaky_reruns: 0, kind: 'command', category: 'other' };
    const scratch = join(dir, 'toolchains');
    const toolchains = releaseToolchains({ command: a.command, checkout, cacheRoot: input.toolchainCacheRoot ?? null, scratch, tmp, isolation: a.isolation.kind, networkHosts: env.network_hosts, ...(input.homeDir ? { homeDir: input.homeDir } : {}) });
    const profile = profileForCheck({ worktree: checkout, check: def, snapshot, extraWritable: [home, tmp, ...toolchains.writable], readablePaths: toolchains.readOnly, nisDomainName: toolchains.nisDomainName, ...(input.homeDir ? { homeDir: input.homeDir } : {}) });
    const cmdEnv = releaseCommandEnv({ home, tmp, toolchainEnv: toolchains.env, deployEnv: input.deployEnv, runId: run.id, envName, branch, sha, extra: { ORBIT_RELEASE_VERIFY: '1' } });
    try {
      const wrapped = a.isolation.wrap([...a.command], profile, { cwd: checkout, env: cmdEnv });
      try {
        const ran = await runReleaseCommand({ argv: wrapped.argv, checkout, env: wrapped.env, timeoutMs: env.timeout_seconds * 1000, tmp, command: a.command, field: `release.environments.${envName}.verify_command`, what: 'the verify command' });
        const res = ran.result;
        // Its own build was refused an MSBuild worker node (stopped for it, or failed on it at once on Linux): whatever it
        // exited with says nothing about the deploy, an exit 1 included.
        if (ran.note) return { verdict: 'unknown', detail: `verify_command ${ran.stopped ? 'was stopped' : 'failed on its own build'}, so the outcome is still unknown: ${redact(ran.note)}` };
        const output = redact(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`).trim().slice(-500);
        const tail = output ? `: ${output}` : '';
        if (res.timedOut) return { verdict: 'unknown', detail: `the verify_command timed out after ${env.timeout_seconds}s` };
        if (res.exitCode === 0) return { verdict: 'deployed', detail: `verify_command exited 0 for ${sha.slice(0, 12)} in ${envName}${tail}` };
        if (res.exitCode === 1) return { verdict: 'not-deployed', detail: `verify_command exited 1 for ${sha.slice(0, 12)} in ${envName}${tail}` };
        return { verdict: 'unknown', detail: `verify_command ${res.exitCode === null ? 'was stopped by a signal' : `exited ${res.exitCode}`} (0 means deployed, 1 means not deployed), so the outcome is still unknown${tail}` };
      } finally {
        wrapped.cleanup();
      }
    } finally {
      removeScratch(scratch);
    }
  } finally {
    await cleanupCandidateCheckout(run.repoRoot, checkout).catch(() => {});
  }
}
