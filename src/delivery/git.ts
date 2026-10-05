/**
 * Git side of delivery (spec §15, docs/interfaces/playwright-and-github.md B7).
 *
 * - The delivery commit is made with `commit-tree` on exactly the reviewed
 *   tree, so no hook or signing step can change what was tested, and the tree
 *   is verified again with `rev-parse <commit>^{tree}` before anything is
 *   pushed.
 * - The delivery identity is read from the controller's git configuration at
 *   delivery time; no worker-supplied value can reach it.
 * - A push names an explicit `<sha>:refs/heads/<branch>` refspec. The branch
 *   must be a task branch (configured prefix) and never the base branch.
 *   Force exists only as `--force-with-lease=<ref>:<previously delivered sha>`.
 * - Everything is argv-based (no shell), and `ls-remote` is matched on the full
 *   ref name because git matches patterns against the tail of a ref.
 */
import type { ExecResult } from '../core/exec.ts';
import { execCapture } from '../core/exec.ts';
import { OrbitError } from '../core/errors.ts';
import { redact } from '../core/redact.ts';

const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// What git itself forbids in a ref name, plus a leading dash (option injection) and anything unprintable.
const REF_FORBIDDEN = /(\.\.|@\{|[\s~^:?*[\\\x00-\x1f\x7f]|\/\/|\/\.|\.lock$|\.lock\/|\/$|\.$)/;

export function isObjectId(value: unknown): value is string {
  return typeof value === 'string' && OBJECT_ID.test(value);
}

export interface BranchRules {
  /** repository.branch_prefix, e.g. "orbit/". */
  branchPrefix: string;
  /** repository.base_branch; never a push target. */
  baseBranch: string;
}

/** Throws POLICY_DENIED unless `branch` is a task branch Orbit may push. */
export function assertTaskBranch(branch: string, rules: BranchRules): void {
  const deny = (why: string): never => {
    throw new OrbitError('POLICY_DENIED', `refusing to push ${JSON.stringify(branch)}: ${why}`, { branch, definitive: true });
  };
  if (typeof branch !== 'string' || branch.length === 0) deny('the branch name is empty');
  if (branch.startsWith('refs/')) deny('give the branch name, not a ref');
  if (!rules.branchPrefix) deny('no branch prefix is configured');
  if (!branch.startsWith(rules.branchPrefix) || branch.length === rules.branchPrefix.length) deny(`task branches start with ${rules.branchPrefix}`);
  if (branch === rules.baseBranch) deny('the base branch is never a push target');
  if (branch.startsWith('-') || REF_FORBIDDEN.test(branch)) deny('it is not a valid branch name');
}

export function branchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

export interface GitIdentity {
  name: string;
  email: string;
}

export interface GitOptions {
  /** Complete environment for git. Defaults to a minimal one (see `gitEnv`). */
  env?: Readonly<Record<string, string | undefined>>;
  timeoutMs?: number;
}

/**
 * A minimal environment: enough for git to find its helpers and the
 * controller's own configuration, nothing else. In particular no SSH agent and
 * no token unless the caller passes one for this command.
 */
export function gitEnv(extra: Record<string, string | undefined> = {}, base: Readonly<Record<string, string | undefined>> = process.env): Record<string, string | undefined> {
  const keep = ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR', 'SystemRoot'];
  const env: Record<string, string | undefined> = {};
  for (const k of keep) if (base[k] !== undefined) env[k] = base[k];
  return {
    ...env,
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: '',
    GIT_OPTIONAL_LOCKS: '0',
    // Transports Orbit uses; excludes ext:: and friends.
    GIT_ALLOW_PROTOCOL: 'file:https:http:git:ssh',
    ...extra,
  };
}

async function git(repoRoot: string, args: readonly string[], opts: GitOptions & { input?: string } = {}): Promise<ExecResult> {
  return execCapture(['git', ...args], { cwd: repoRoot, env: opts.env ?? gitEnv(), timeoutMs: opts.timeoutMs ?? 120_000, input: opts.input, maxOutputBytes: 4 * 1024 * 1024 });
}

function fail(what: string, res: ExecResult, extra: Record<string, unknown> = {}): OrbitError {
  const text = redact(`${res.stderr}${res.stdout}`.trim()).slice(0, 2000);
  return new OrbitError('GIT_FAILED', `${what} failed (exit ${res.exitCode ?? res.signal ?? 'unknown'}): ${text}`, { exitCode: res.exitCode, ...extra });
}

/** Whether `git cat-file -e <spec>` succeeds. */
async function objectExists(repoRoot: string, spec: string, opts: GitOptions): Promise<boolean> {
  const res = await git(repoRoot, ['cat-file', '-e', spec], opts);
  return res.exitCode === 0;
}

/** The identity delivery commits carry: the controller's git configuration, read now. */
export async function readControllerIdentity(repoRoot: string, opts: GitOptions = {}): Promise<GitIdentity> {
  const read = async (key: string): Promise<string> => {
    const res = await git(repoRoot, ['config', '--get', key], opts);
    return res.exitCode === 0 ? res.stdout.trim() : '';
  };
  const [name, email] = await Promise.all([read('user.name'), read('user.email')]);
  if (!name || !email) {
    throw new OrbitError('CONFIG_INVALID', 'the controller has no git identity (user.name and user.email); delivery commits never take an identity from a worker', { definitive: true });
  }
  return { name, email };
}

export interface DeliveryCommitInput extends GitOptions {
  repoRoot: string;
  /** The reviewed tree: the one evidence and review are bound to. */
  tree: string;
  /** The delivery commit's parent: the previously delivered commit, or the run's base revision. */
  parent: string;
  message: string;
  identity: GitIdentity;
  /** Author and committer time (epoch ms). Fixed, so repeating the commit yields the same sha. */
  timeMs: number;
  /** When given, the commit is also pinned at this ref so it survives gc while the push is pending. */
  ref?: string;
}

/** `commit-tree` on exactly `tree`, then verify the commit's tree is that tree. */
export async function createDeliveryCommit(input: DeliveryCommitInput): Promise<string> {
  const { repoRoot, tree, parent, message, identity } = input;
  if (!isObjectId(tree)) throw new OrbitError('GIT_FAILED', 'the tree is not a full object id', { tree });
  if (!isObjectId(parent)) throw new OrbitError('GIT_FAILED', 'the parent is not a full object id', { parent });
  if (!message.trim()) throw new OrbitError('GIT_FAILED', 'a delivery commit needs a message');
  if (!identity.name || !identity.email) throw new OrbitError('CONFIG_INVALID', 'a delivery commit needs an identity', { definitive: true });
  if (!(await objectExists(repoRoot, `${tree}^{tree}`, input))) throw new OrbitError('GIT_FAILED', `tree ${tree} is not in the repository`);
  if (!(await objectExists(repoRoot, `${parent}^{commit}`, input))) throw new OrbitError('GIT_FAILED', `parent ${parent} is not a commit in the repository`);

  const when = `${Math.floor(input.timeMs / 1000)} +0000`;
  const env = gitEnv({
    // Reproducible: no user or system configuration can influence the result.
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_AUTHOR_DATE: when,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
    GIT_COMMITTER_DATE: when,
  });
  const res = await git(repoRoot, ['commit-tree', tree, '-p', parent, '-F', '-'], { ...input, env, input: message.endsWith('\n') ? message : `${message}\n` });
  if (res.exitCode !== 0) throw fail('git commit-tree', res);
  const commit = res.stdout.trim();
  if (!isObjectId(commit)) throw new OrbitError('GIT_FAILED', `commit-tree printed an unexpected value: ${res.stdout.trim().slice(0, 80)}`);

  const check = await git(repoRoot, ['rev-parse', `${commit}^{tree}`], input);
  if (check.exitCode !== 0 || check.stdout.trim() !== tree) {
    throw new OrbitError('GIT_FAILED', `the delivery commit ${commit} has tree ${check.stdout.trim()}, not the reviewed tree ${tree}`, { commit, tree, definitive: true });
  }
  if (input.ref) {
    const up = await git(repoRoot, ['update-ref', input.ref, commit], input);
    if (up.exitCode !== 0) throw fail('git update-ref', up);
  }
  return commit;
}

/**
 * Ref that pins the delivery commit made for `tree` on top of `parent`, used to reconcile a commit whose
 * receipt was lost. The parent is part of the name because a repair cycle can deliver the same tree twice
 * in one run, and each delivery is its own commit.
 */
export function deliveryRef(runId: string, tree: string, parent: string): string {
  return `refs/orbit/${runId}/delivery/${parent}/${tree}`;
}

/** The delivery commit already pinned for `tree` on `parent` (verified to carry that tree and parent), or null. */
export async function findDeliveryCommit(repoRoot: string, runId: string, tree: string, parent: string, opts: GitOptions = {}): Promise<string | null> {
  const res = await git(repoRoot, ['rev-parse', '--verify', '--quiet', `${deliveryRef(runId, tree, parent)}^{commit}`], opts);
  if (res.exitCode !== 0) return null;
  const commit = res.stdout.trim();
  const t = await git(repoRoot, ['rev-parse', `${commit}^{tree}`, `${commit}^`], opts);
  const [commitTree, commitParent] = t.stdout.trim().split('\n');
  return t.exitCode === 0 && commitTree === tree && commitParent === parent ? commit : null;
}

// ---------------------------------------------------------------------------
// remote

export interface RemoteOptions extends GitOptions {
  repoRoot: string;
  /** A configured remote name or a URL. Never starts with a dash. */
  remote: string;
  /** Scoped token for HTTPS remotes; supplied through `gh auth git-credential` for this command only. */
  token?: string;
  ghPath?: string;
}

function assertRemote(remote: string): void {
  if (typeof remote !== 'string' || remote.length === 0 || remote.startsWith('-') || /[\0\n\r]/.test(remote)) {
    throw new OrbitError('CONFIG_INVALID', `the remote ${JSON.stringify(remote)} is not usable`, { definitive: true });
  }
}

/**
 * The host a remote address reaches, for `authorize({kind: 'network'})`, or
 * null for a local path. Follows git's own rules: `scheme://[user@]host[:port]/…`,
 * and the scp-like `[user@]host:path` whenever a colon comes before any slash.
 * An address that cannot be parsed is refused rather than treated as local.
 */
export function remoteHost(address: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(address)) {
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      throw new OrbitError('CONFIG_INVALID', 'the remote URL cannot be parsed', { remote: redact(address), definitive: true });
    }
    if (url.protocol === 'file:') return null;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host) throw new OrbitError('CONFIG_INVALID', 'the remote URL names no host', { remote: redact(address), definitive: true });
    return host;
  }
  const scp = /^(?:[^@/]*@)?(\[[^\]]+\]|[^:/]+):/.exec(address);
  if (scp) return scp[1]!.replace(/^\[|\]$/g, '');
  return null;
}

/**
 * The URL a push to `remote` really goes to. A configured remote name is
 * resolved through git itself (`remote get-url --push --all` applies pushurl
 * and insteadOf rewrites and lists every push URL), so a name can never hide
 * the host it reaches from the network policy. A remote with more than one push
 * URL is refused: git would push to each of them. A URL or path is returned as
 * is. Either way the result must be a URL git pushes to unchanged (no
 * `url.<base>.insteadOf` or `pushInsteadOf` rule matches it), because delivery
 * pushes to this URL itself, never to the name. An unknown name is refused.
 */
export async function resolveRemoteUrl(repoRoot: string, remote: string, opts: GitOptions = {}): Promise<string> {
  assertRemote(remote);
  const res = await git(repoRoot, ['remote', 'get-url', '--push', '--all', remote], opts);
  let url: string;
  if (res.exitCode === 0) {
    const urls = res.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    // Several push URLs would each need authorizing and reconciling; delivery does not support that.
    if (urls.length !== 1) throw new OrbitError('CONFIG_INVALID', `remote ${remote} has ${urls.length} push URLs; delivery needs exactly one`, { definitive: true });
    url = urls[0]!;
  } else if (/[/:]/.test(remote)) {
    url = remote;
  } else {
    throw new OrbitError('CONFIG_INVALID', `no git remote named ${JSON.stringify(remote)} in the repository`, { definitive: true });
  }
  assertRemote(url);
  await assertNotRewritten(repoRoot, url, opts);
  return url;
}

/** Refuses a URL that a configured url.<base>.insteadOf or pushInsteadOf rule would rewrite when pushed to directly. */
async function assertNotRewritten(repoRoot: string, url: string, opts: GitOptions): Promise<void> {
  const res = await git(repoRoot, ['config', '-z', '--get-regexp', '^url\\..*\\.(insteadof|pushinsteadof)$'], opts);
  // Exit 1: no such rule is configured.
  if (res.exitCode === 1 && res.stdout === '') return;
  if (res.exitCode !== 0) throw fail('git config --get-regexp url.*.insteadOf', res);
  for (const entry of res.stdout.split('\0')) {
    const nl = entry.indexOf('\n');
    const prefix = nl < 0 ? '' : entry.slice(nl + 1);
    if (prefix !== '' && url.startsWith(prefix)) {
      throw new OrbitError('CONFIG_INVALID', `the push URL ${redact(url)} matches a url.<base>.${/pushinsteadof$/i.test(entry.slice(0, nl)) ? 'pushInsteadOf' : 'insteadOf'} rule, so git would rewrite it to another destination; remove the rule or name the final URL`, { definitive: true });
    }
  }
}

function remoteEnvAndArgs(o: RemoteOptions): { env: Record<string, string | undefined>; pre: string[] } {
  if (!o.token) return { env: (o.env as Record<string, string | undefined> | undefined) ?? gitEnv(), pre: [] };
  // An empty helper resets the list, so the user's own helpers never see the token or answer instead of it.
  const helper = `!${o.ghPath ?? 'gh'} auth git-credential`;
  return {
    env: { ...((o.env as Record<string, string | undefined> | undefined) ?? gitEnv()), GH_TOKEN: o.token },
    pre: ['-c', 'credential.helper=', '-c', `credential.helper=${helper}`],
  };
}

const AUTH_PATTERN = /Authentication failed|could not read (?:Username|Password)|Permission denied|invalid credentials|Bad credentials|error: 40[13]|HTTP 40[13]|requires authentication|Invalid username or token|not permitted to push/i;
const TRANSIENT_PATTERN = /Could not resolve host|Connection (?:timed out|reset|refused)|timed out|unable to access|early EOF|remote end hung up|error: 5\d\d|HTTP 5\d\d|RPC failed|Temporary failure/i;

function classifyRemoteFailure(what: string, res: ExecResult): OrbitError {
  const text = `${res.stderr}\n${res.stdout}`;
  if (AUTH_PATTERN.test(text)) {
    return new OrbitError('AUTH_EXPIRED', `${what} was refused for lack of valid credentials: ${redact(text.trim()).slice(0, 500)}`, { exitCode: res.exitCode, definitive: true });
  }
  if (res.timedOut || TRANSIENT_PATTERN.test(text)) {
    return new OrbitError('PROVIDER_TRANSIENT', `${what} failed transiently: ${redact(text.trim()).slice(0, 500)}`, { exitCode: res.exitCode });
  }
  return fail(what, res);
}

/** The sha `refs/heads/<branch>` has on the remote, or null when the remote has no such branch. */
export async function lsRemoteBranch(o: RemoteOptions & { branch: string }): Promise<string | null> {
  assertRemote(o.remote);
  const ref = branchRef(o.branch);
  const { env, pre } = remoteEnvAndArgs(o);
  const res = await git(o.repoRoot, [...pre, 'ls-remote', '--', o.remote, ref], { ...o, env });
  if (res.exitCode !== 0) throw classifyRemoteFailure('git ls-remote', res);
  for (const line of res.stdout.split('\n')) {
    const [sha, name] = line.split('\t');
    // Exact name only: git matches the tail, so refs/heads/x/<branch> would also be listed.
    if (name === ref && isObjectId(sha)) return sha;
  }
  return null;
}

export type PushOutcome = 'created' | 'updated' | 'forced' | 'up-to-date';

export interface PushReceipt {
  remote: string;
  ref: string;
  sha: string;
  outcome: PushOutcome;
}

export interface PushInput extends RemoteOptions, BranchRules {
  commit: string;
  branch: string;
  /** Overwrite a diverged remote branch. Only ever as a lease on `leaseSha`. */
  force?: boolean;
  /** The previously delivered commit the remote branch is expected to hold; required with `force`. */
  leaseSha?: string;
}

export interface PorcelainLine {
  flag: string;
  from: string;
  to: string;
  summary: string;
}

/** Parse `git push --porcelain`: `<flag>\t<from>:<to>\t<summary>`. */
export function parsePushPorcelain(stdout: string): PorcelainLine[] {
  const out: PorcelainLine[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^([ +\-*!=])\t([^\t:]*):(\S+)\t(.*)$/.exec(line);
    if (m) out.push({ flag: m[1]!, from: m[2]!, to: m[3]!, summary: m[4]! });
  }
  return out;
}

/**
 * Push `commit` to `refs/heads/<branch>` on the remote. Rejections (stale
 * lease, non-fast-forward, a protected branch) are definitive: they changed
 * nothing, so they are reported and never retried. Authentication failure is
 * AUTH_EXPIRED. Anything else is left to reconciliation (`lsRemoteBranch`).
 */
export async function pushBranch(input: PushInput): Promise<PushReceipt> {
  assertRemote(input.remote);
  assertTaskBranch(input.branch, input);
  if (!isObjectId(input.commit)) throw new OrbitError('GIT_FAILED', 'the commit to push is not a full object id', { commit: input.commit });
  if (input.force && !isObjectId(input.leaseSha)) {
    throw new OrbitError('POLICY_DENIED', 'a forced push needs --force-with-lease against the previously delivered commit', { definitive: true });
  }
  if (!(await objectExists(input.repoRoot, `${input.commit}^{commit}`, input))) {
    throw new OrbitError('GIT_FAILED', `commit ${input.commit} is not in the repository`);
  }
  const ref = branchRef(input.branch);
  const { env, pre } = remoteEnvAndArgs(input);
  const args = [...pre, 'push', '--porcelain', '--no-verify'];
  // Explicit expectation: a bare --force-with-lease compares against a tracking ref that fetches refresh behind our back.
  if (input.force) args.push(`--force-with-lease=${ref}:${input.leaseSha}`);
  args.push('--', input.remote, `${input.commit}:${ref}`);

  const res = await git(input.repoRoot, args, { ...input, env });
  const lines = parsePushPorcelain(res.stdout);
  const mine = lines.find((l) => l.to === ref);
  if (mine && mine.flag === '!') {
    // A server-side hook can refuse for want of permission; that is a credential problem, not a diverged branch.
    if (AUTH_PATTERN.test(`${res.stderr}\n${res.stdout}`)) throw classifyRemoteFailure('git push', res);
    throw new OrbitError('GIT_FAILED', `the remote rejected the push of ${input.branch}: ${mine.summary}`, { definitive: true, rejected: mine.summary, ref });
  }
  if (res.exitCode !== 0) throw classifyRemoteFailure('git push', res);
  if (!mine) throw new OrbitError('GIT_FAILED', `git push reported success but no result for ${ref}`, { stdout: redact(res.stdout).slice(0, 500) });
  const outcome: PushOutcome = mine.flag === '*' ? 'created' : mine.flag === '+' ? 'forced' : mine.flag === '=' ? 'up-to-date' : 'updated';
  return { remote: redact(input.remote), ref, sha: input.commit, outcome };
}

/**
 * Did the push take effect? Asks the remote. The receipt when the branch holds
 * exactly `commit`, null otherwise (absent, or at another sha: either way this
 * push did not land).
 */
export async function reconcilePush(o: RemoteOptions & { commit: string; branch: string }): Promise<PushReceipt | null> {
  const sha = await lsRemoteBranch(o);
  if (sha !== o.commit) return null;
  return { remote: redact(o.remote), ref: branchRef(o.branch), sha, outcome: 'up-to-date' };
}

/**
 * Fetch `branch` from the remote into the private ref `ref` (under
 * refs/orbit/) and confirm `commit` is on it: the tip itself or an ancestor.
 * Used by release to obtain a merge commit the host made on the base branch.
 * Returns the fetched tip.
 */
export async function fetchBranchContaining(o: RemoteOptions & { branch: string; commit: string; ref: string }): Promise<string> {
  assertRemote(o.remote);
  if (!isObjectId(o.commit)) throw new OrbitError('INTERNAL', `not a full commit sha: ${o.commit}`);
  if (!o.ref.startsWith('refs/orbit/') || REF_FORBIDDEN.test(o.ref.slice('refs/'.length))) throw new OrbitError('INTERNAL', `fetch target must be a private refs/orbit/ ref: ${o.ref}`);
  if (o.branch.startsWith('-') || REF_FORBIDDEN.test(o.branch)) throw new OrbitError('CONFIG_INVALID', `not a valid branch name: ${JSON.stringify(o.branch)}`, { definitive: true });
  const { env, pre } = remoteEnvAndArgs(o);
  const res = await git(o.repoRoot, [...pre, 'fetch', '--no-tags', '--no-write-fetch-head', '--', o.remote, `+${branchRef(o.branch)}:${o.ref}`], { ...o, env });
  if (res.exitCode !== 0) throw classifyRemoteFailure('git fetch', res);
  const tip = (await git(o.repoRoot, ['rev-parse', '--verify', '--quiet', `${o.ref}^{commit}`], o)).stdout.trim();
  if (!isObjectId(tip)) throw new OrbitError('GIT_FAILED', `git fetch of ${o.branch} produced no commit at ${o.ref}`);
  const onBranch = tip === o.commit || (await git(o.repoRoot, ['merge-base', '--is-ancestor', o.commit, tip], o)).exitCode === 0;
  if (!onBranch) {
    throw new OrbitError('DELIVERY_FAILED', `commit ${o.commit.slice(0, 12)} is not on ${o.branch} at ${o.remote}`, { branch: o.branch, commit: o.commit, tip, definitive: true });
  }
  return tip;
}

/** Whether the local repository has `commit` as a commit object. */
export async function hasCommit(repoRoot: string, commit: string, opts: GitOptions = {}): Promise<boolean> {
  return isObjectId(commit) && (await objectExists(repoRoot, `${commit}^{commit}`, opts));
}
