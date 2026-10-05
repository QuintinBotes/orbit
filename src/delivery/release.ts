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
 * Deploy. Only to an environment the caller names and the release profile
 * defines, with `deploy_production` authorized. The deployed ref must match
 * the environment's `allowed_branches` (the base branch after a merge, the
 * task branch without one), CI must be green on the deployed commit when the
 * environment requires it, and every host the command may reach must be in
 * `network.allowed_hosts`. The command comes from the frozen policy snapshot
 * (trusted configuration, never a worker), runs in a clean checkout of the
 * deployed commit under the configured isolation provider, and goes through
 * the action ledger like every external action. Its outcome is written to a
 * file the moment it exits, which is what reconciles a lost receipt. A deploy
 * that may have started but left no outcome, or that failed, is never re-run
 * automatically: it is reported as a blocker for a person to resolve.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';
import picomatch from 'picomatch';
import type { Clock } from '../core/clock.ts';
import type { AuthorizationDecision, CheckDefinition, PolicySnapshot, ReleaseConfig, ReleaseEnvironment } from '../policy/types.ts';
import type { IsolationProvider } from '../isolation/types.ts';
import type { ActionLedger, ActionRecord } from './actions.ts';
import type { ChecksResult, GitHubClient, MergeMethod, MergeState } from './github.ts';
import type { DeliveryCandidate, DeliveryEvidence, DeliveryReview, DeliveryRun } from './gate.ts';
import type { GitOptions } from './git.ts';
import { execCapture } from '../core/exec.ts';
import { OrbitError } from '../core/errors.ts';
import { atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { redact } from '../core/redact.ts';
import { authorize } from '../policy/authorize.ts';
import { prepareWorkerTmpDir, profileForCheck } from '../isolation/profiles.ts';
import { cleanupCandidateCheckout, materializeCandidate } from '../evidence/candidate.ts';
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
  /** A key of `release.environments` to deploy to; null or omitted deploys nothing. */
  environment?: string | null;
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
  /** Real home directory, used only to compute what the sandbox must hide. */
  homeDir?: string;
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
  deploy: DeployReceipt | null;
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
  let deploy: DeployReceipt | null = null;
  let deploySkipped: string | null = null;
  const envName = input.environment ?? null;
  if (envName === null) {
    deploySkipped = 'no release environment was requested';
  } else {
    const deployAuth = requireAllowed(authorize(snapshot, { kind: 'action', action: 'deploy_production' }), 'deploying');
    if (!ENV_NAME.test(envName) || !Object.hasOwn(release.environments, envName)) {
      deny('release.environment', `release environment ${JSON.stringify(envName)} is not defined in the release profile (defined: ${Object.keys(release.environments).join(', ') || 'none'})`);
    }
    const env = release.environments[envName]!;
    // After a merge the base branch carries the release; without one, the task branch at the delivered commit.
    const target = merge ? { branch: merge.baseBranch, sha: merge.mergeCommitSha } : { branch, sha: commit };
    if (!target.sha || !isObjectId(target.sha)) throw new OrbitError('DELIVERY_FAILED', `the merge of pull request #${merge?.number} reported no merge commit to deploy`, { definitive: true });
    const sha = target.sha;
    if (env.allowed_branches.length === 0 || !picomatch(env.allowed_branches, { dot: true })(target.branch)) {
      deny('release.allowed_branches', `environment ${envName} may not be deployed from ${target.branch} (allowed: ${env.allowed_branches.join(', ') || 'none'})`);
    }
    for (const host of env.network_hosts) requireAllowed(authorize(snapshot, { kind: 'network', host }), `deploy network access to ${host}`);
    if (!Array.isArray(env.deploy_command) || env.deploy_command.length === 0 || env.deploy_command.some((a) => typeof a !== 'string' || a.length === 0)) {
      throw new OrbitError('CONFIG_INVALID', `release environment ${envName} has no usable deploy_command`, { definitive: true });
    }
    if (!input.isolation || !input.workDir) throw new OrbitError('INTERNAL', 'deploying needs an isolation provider and a work directory');
    const isolation = input.isolation;
    const files = deployFiles(input.workDir, envName, sha);

    const key = `release:${run.id}:deploy:${envName}:${sha}`;
    const prior = ledger.find(key);
    if (prior?.state === 'SUCCEEDED') deploy = prior.receipt as DeployReceipt;
    else {
      if (prior?.state === 'FAILED') {
        throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} to ${envName} failed earlier (${prior.error ?? 'no detail'}); a failed deploy is not retried automatically`, { definitive: true, actionId: prior.id });
      }
      const ciGate = async (): Promise<CheckVerdict> => verdictOf(await client.listChecks({ sha }), sha, [], true);
      if (env.require_ci_green) {
        apiAllowed();
        const v = await ciGate();
        if (v.state === 'pending') return pendingResult(ledger, run.id, `waiting for CI on ${sha.slice(0, 12)} before deploying to ${envName}: ${v.detail}`, merge, mergeSkipped);
        if (v.state === 'failed') throw new OrbitError('DELIVERY_FAILED', `deploy refused: CI on ${sha.slice(0, 12)} is not green: ${v.detail}`, { definitive: true, checks: v.detail });
      }

      const result = await ledger.performAction<DeployReceipt>(
        { runId: run.id, kind: 'deploy', idempotencyKey: key, target: { environment: envName, branch: target.branch, sha, command: env.deploy_command.map((a) => redact(a)) }, candidateId: candidate.id, treeHash: tree, commitSha: sha },
        {
          execute: (ctx) => runDeploy({ input, env, envName, branch: target.branch, sha, isolation, files, attempt: ctx.attempt, remote, viaBaseBranch: merge !== null }),
          reconcile: async () => readDeployOutcome(files, sha),
        },
        {
          authorization: deployAuth,
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
      deploy = result.receipt;
    }
  }

  ledger.event(run.id, 'release.completed', { merge: merge ? { pr: merge.number, head: merge.headSha, merge_commit: merge.mergeCommitSha } : null, merge_skipped: mergeSkipped, deploy: deploy ? { environment: deploy.environment, sha: deploy.sha } : null, deploy_skipped: deploySkipped });
  return { status: 'released', pending: null, merge, mergeSkipped, deploy, deploySkipped, actions: ledger.list(run.id) };
}

function pendingResult(ledger: ActionLedger, runId: string, reason: string, merge: MergeReceipt | null, mergeSkipped: string | null): ReleaseResult {
  return { status: 'pending', pending: reason, merge, mergeSkipped, deploy: null, deploySkipped: null, actions: ledger.list(runId) };
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
function readDeployOutcome(files: DeployFiles, sha: string): DeployReceipt | null {
  const outcome = readJsonIfExists<DeployOutcome>(files.outcome);
  if (outcome && outcome.sha === sha) {
    if (outcome.exitCode === 0 && !outcome.timedOut) return receiptOf(outcome);
    throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} to ${outcome.environment} ${outcome.timedOut ? 'timed out' : `exited ${outcome.exitCode ?? 'by signal'}`}; it is not retried automatically`, { definitive: true });
  }
  if (existsSync(files.started)) {
    throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} started but recorded no outcome (the controller stopped while it ran); check the environment, then resolve this run by hand`, { definitive: true, outcomeUnknown: true });
  }
  return null;
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
    const tmp = prepareWorkerTmpDir(files.dir);
    const def: CheckDefinition = {
      id: `release:${envName}`,
      command: [...env.deploy_command],
      shell: false,
      cwd: '.',
      timeout_seconds: env.timeout_seconds,
      network_hosts: [...env.network_hosts],
      env: {},
      mandatory: true,
      flaky_reruns: 0,
      kind: 'command',
      category: 'other',
    };
    const profile = profileForCheck({ worktree: checkout, check: def, snapshot, extraWritable: [files.home, tmp], ...(input.homeDir ? { homeDir: input.homeDir } : {}) });
    const cmdEnv: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: files.home,
      TMPDIR: tmp,
      LANG: platform() === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8',
      TERM: 'dumb',
      CI: '1',
      NO_COLOR: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      ...(input.deployEnv ?? {}),
      ORBIT_RUN_ID: run.id,
      ORBIT_RELEASE_ENVIRONMENT: envName,
      ORBIT_RELEASE_BRANCH: branch,
      ORBIT_RELEASE_SHA: sha,
    };
    const wrapped = a.isolation.wrap([...env.deploy_command], profile, { cwd: checkout, env: cmdEnv });
    // The marker goes down before the command starts: from here on, a missing outcome means "unknown", never "not run".
    atomicWriteJson(files.started, { environment: envName, sha, attempt: a.attempt, started_at: input.clock.now() }, 0o600);
    let outcome: DeployOutcome;
    try {
      const res = await execCapture(wrapped.argv, { cwd: checkout, env: wrapped.env, timeoutMs: env.timeout_seconds * 1000, maxOutputBytes: 1024 * 1024 });
      const output = redact(`${res.stdout}${res.stderr ? `\n${res.stderr}` : ''}`).slice(-OUTPUT_TAIL);
      outcome = { environment: envName, branch, sha, tree, attempt: a.attempt, exitCode: res.exitCode, timedOut: res.timedOut, durationMs: res.durationMs, isolation: a.isolation.kind, limitations: wrapped.limitations, output };
    } finally {
      wrapped.cleanup();
    }
    atomicWriteJson(files.outcome, outcome, 0o600);
    if (outcome.exitCode !== 0 || outcome.timedOut) {
      throw new OrbitError('DELIVERY_FAILED', `the deploy of ${sha.slice(0, 12)} to ${envName} ${outcome.timedOut ? `timed out after ${env.timeout_seconds}s` : `exited ${outcome.exitCode ?? 'by signal'}`}: ${outcome.output.slice(-500)}`, { definitive: true });
    }
    return receiptOf(outcome);
  } finally {
    await cleanupCandidateCheckout(repoRoot, files.checkout).catch(() => {});
  }
}
