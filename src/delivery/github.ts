/**
 * GitHub access for delivery (spec §15, docs/interfaces/playwright-and-github.md B1 to B6).
 *
 * `GhCliClient` drives the `gh` CLI with the flags the interface notes
 * verified, always with JSON output, never prompting, and with a `GH_TOKEN`
 * taken from the controller's environment only (the user's keyring login is
 * too broad for unattended runs, and a worker never sees either).
 * `FakeGitHub` is a file-backed stand-in with scriptable CI results and
 * faults, for tests and acceptance runs.
 *
 * Both implement the same interface, whose contract for callers is:
 *  - a read never changes anything, so it is always safe to repeat;
 *  - `createPullRequest` may succeed remotely and still throw (a lost
 *    response), which is why delivery looks the PR up by head branch before
 *    and after every create;
 *  - authentication problems throw AUTH_EXPIRED or AUTH_MISSING and are never
 *    retried; rate limits and server errors throw PROVIDER_TRANSIENT, with
 *    `details.retryAfterMs` when the server said how long to wait.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import type { ExecResult } from '../core/exec.ts';
import { execCapture } from '../core/exec.ts';
import { OrbitError } from '../core/errors.ts';
import { atomicWriteJson } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { redact } from '../core/redact.ts';

// ---------------------------------------------------------------------------
// shapes

export type PullRequestState = 'OPEN' | 'CLOSED' | 'MERGED';

export interface PullRequestInfo {
  number: number;
  url: string;
  headRefName: string;
  /** The commit the PR currently points at; delivery asserts it equals the delivered commit. */
  headRefOid: string;
  baseRefName: string;
  isDraft: boolean;
  state: PullRequestState;
  title: string;
  body: string;
}

/** `bucket` as `gh pr checks --json bucket` reports it. */
export const CHECK_BUCKETS = ['pass', 'fail', 'pending', 'skipping', 'cancel'] as const;
export type CheckBucket = (typeof CHECK_BUCKETS)[number];

export interface CheckInfo {
  name: string;
  bucket: CheckBucket;
  /** Raw state, e.g. SUCCESS, FAILURE. */
  state: string;
  link: string | null;
  workflow: string | null;
  /** Parsed from `link` (…/actions/runs/<runId>/job/<jobId>). */
  runId: string | null;
  jobId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  description: string | null;
}

export interface ChecksResult {
  checks: CheckInfo[];
  /** True when the host reports no checks at all (CI not started or not configured): not the same as passing. */
  absent: boolean;
  /**
   * The commit these checks belong to, when known. A PR's checks are those of
   * its current head, which can still be an older commit right after a push;
   * callers must not attribute them to any other commit.
   */
  headSha?: string | null;
}

export type ChecksQuery = { pr: number; sha?: string } | { sha: string };

export interface FailedLogs {
  /** ok: text holds `gh run view --log-failed` output; expired: HTTP 410; not-found: the run has no job logs. */
  status: 'ok' | 'expired' | 'not-found';
  /** Raw, unsanitized: callers pass it through `sanitizeLog` before it goes anywhere. */
  text: string;
  /** Failed step names from the jobs listing, for when the log itself is unavailable. */
  failedSteps: { job: string; step: string }[];
}

export interface AuthStatus {
  ok: boolean;
  login: string | null;
  tokenSource: string | null;
  scopes: string | null;
  /** Why not ok, never containing a token. */
  error: string | null;
}

export interface CreatePullRequestInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

export const MERGE_METHODS = ['squash', 'merge', 'rebase'] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export interface MergePullRequestInput {
  number: number;
  /** The exact commit that was reviewed and checked; the host refuses the merge when the head is anything else. */
  headSha: string;
  method: MergeMethod;
  deleteBranch: boolean;
}

/** A pull request's merge-related state, read back after a merge (or to reconcile a lost merge response). */
export interface MergeState {
  number: number;
  state: PullRequestState;
  headRefOid: string;
  baseRefName: string;
  /** The commit the merge produced on the base branch; null until merged. */
  mergeCommitSha: string | null;
  mergedAt: string | null;
}

export interface GitHubClient {
  /** The run's PR by head branch, in any state; an OPEN one wins. null when none exists. */
  findPullRequest(head: string): Promise<PullRequestInfo | null>;
  createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo>;
  updatePullRequest(number: number, changes: { title?: string; body?: string }): Promise<PullRequestInfo>;
  /** Mark a draft pull request ready for review (`gh pr ready`). Idempotent: a ready one stays ready. */
  markPullRequestReady(number: number): Promise<PullRequestInfo>;
  /**
   * Merge only when the PR head is still `headSha` (`gh pr merge --match-head-commit`).
   * Like a create, it may take effect remotely and still throw, so callers
   * reconcile with `getMergeState`. A refusal by the host (head moved, not
   * mergeable, branch protection) throws a definitive error.
   */
  mergePullRequest(input: MergePullRequestInput): Promise<MergeState>;
  getMergeState(number: number): Promise<MergeState>;
  listChecks(query: ChecksQuery): Promise<ChecksResult>;
  failedLogs(runId: string): Promise<FailedLogs>;
  authStatus(): Promise<AuthStatus>;
}

// ---------------------------------------------------------------------------
// parsing (pure; unit tested against the shapes in the interface notes)

function malformed(what: string, detail: string): OrbitError {
  return new OrbitError('MALFORMED_OUTPUT', `gh ${what}: ${detail}`);
}

function parseJson(what: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw malformed(what, `output is not JSON (${redact(text.slice(0, 120))})`);
  }
}

function obj(what: string, v: unknown): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw malformed(what, 'expected an object');
  return v as Record<string, unknown>;
}

function str(what: string, o: Record<string, unknown>, key: string, optional = false): string {
  const v = o[key];
  if (typeof v === 'string') return v;
  if (optional && (v === undefined || v === null)) return '';
  throw malformed(what, `field ${key} is missing or not a string`);
}

export function parsePullRequest(value: unknown): PullRequestInfo {
  const o = obj('pr', value);
  const state = str('pr', o, 'state').toUpperCase();
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') throw malformed('pr', `unknown state ${JSON.stringify(state)}`);
  const number = o.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) throw malformed('pr', 'field number is missing or not a positive integer');
  return {
    number,
    url: str('pr', o, 'url'),
    headRefName: str('pr', o, 'headRefName'),
    headRefOid: str('pr', o, 'headRefOid'),
    baseRefName: str('pr', o, 'baseRefName'),
    isDraft: o.isDraft === true,
    state,
    title: str('pr', o, 'title', true),
    body: str('pr', o, 'body', true),
  };
}

export function parsePullRequestList(text: string): PullRequestInfo[] {
  const v = parseJson('pr list', text);
  if (!Array.isArray(v)) throw malformed('pr list', 'expected an array');
  return v.map(parsePullRequest);
}

export function parseMergeState(value: unknown): MergeState {
  const o = obj('pr view', value);
  const state = str('pr view', o, 'state').toUpperCase();
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') throw malformed('pr view', `unknown state ${JSON.stringify(state)}`);
  const number = o.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number <= 0) throw malformed('pr view', 'field number is missing or not a positive integer');
  const mc = o.mergeCommit;
  const oid = mc && typeof mc === 'object' && typeof (mc as Record<string, unknown>).oid === 'string' ? ((mc as Record<string, unknown>).oid as string) : null;
  return {
    number,
    state,
    headRefOid: str('pr view', o, 'headRefOid'),
    baseRefName: str('pr view', o, 'baseRefName'),
    mergeCommitSha: state === 'MERGED' && oid ? oid : null,
    mergedAt: typeof o.mergedAt === 'string' && o.mergedAt !== '' ? o.mergedAt : null,
  };
}

const RUN_LINK = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/;

export function isCheckBucket(v: unknown): v is CheckBucket {
  return typeof v === 'string' && (CHECK_BUCKETS as readonly string[]).includes(v);
}

export function parseChecks(text: string): CheckInfo[] {
  const v = parseJson('pr checks', text);
  if (!Array.isArray(v)) throw malformed('pr checks', 'expected an array');
  return v.map((raw) => {
    const o = obj('pr checks', raw);
    const bucket = o.bucket;
    if (!isCheckBucket(bucket)) throw malformed('pr checks', `unknown bucket ${JSON.stringify(bucket)}`);
    const link = typeof o.link === 'string' && o.link !== '' ? o.link : null;
    const m = link ? RUN_LINK.exec(link) : null;
    const opt = (k: string): string | null => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null);
    return {
      name: str('pr checks', o, 'name'),
      bucket,
      state: typeof o.state === 'string' ? o.state : '',
      link,
      workflow: opt('workflow'),
      runId: m?.[1] ?? null,
      jobId: m?.[2] ?? null,
      startedAt: opt('startedAt'),
      completedAt: opt('completedAt'),
      description: opt('description'),
    };
  });
}

/** `gh run list --json …` rows as checks: the fallback when check-runs are not readable with a fine-grained token. */
export function parseRunListAsChecks(text: string): CheckInfo[] {
  const v = parseJson('run list', text);
  if (!Array.isArray(v)) throw malformed('run list', 'expected an array');
  return v.map((raw) => {
    const o = obj('run list', raw);
    const id = o.databaseId;
    if (typeof id !== 'number') throw malformed('run list', 'field databaseId is missing or not a number');
    const status = typeof o.status === 'string' ? o.status : '';
    const conclusion = typeof o.conclusion === 'string' ? o.conclusion : '';
    const name = (typeof o.workflowName === 'string' && o.workflowName) || (typeof o.name === 'string' && o.name) || `run ${id}`;
    return {
      name,
      bucket: runBucket(status, conclusion),
      state: (conclusion || status).toUpperCase(),
      link: typeof o.url === 'string' ? o.url : null,
      workflow: typeof o.workflowName === 'string' ? o.workflowName : null,
      runId: String(id),
      jobId: null,
      startedAt: typeof o.startedAt === 'string' ? o.startedAt : null,
      completedAt: typeof o.updatedAt === 'string' && status === 'completed' ? o.updatedAt : null,
      description: null,
    };
  });
}

export function runBucket(status: string, conclusion: string): CheckBucket {
  if (status !== 'completed') return 'pending';
  switch (conclusion) {
    case 'success':
      return 'pass';
    case 'cancelled':
      return 'cancel';
    case 'skipped':
    case 'neutral':
    case 'stale':
      return 'skipping';
    default:
      // failure, timed_out, startup_failure, action_required and anything unknown: not a pass.
      return 'fail';
  }
}

export function parseFailedSteps(text: string): { job: string; step: string }[] {
  const o = obj('run view', parseJson('run view', text));
  const jobs = Array.isArray(o.jobs) ? o.jobs : [];
  const out: { job: string; step: string }[] = [];
  for (const j of jobs) {
    const job = obj('run view', j);
    const name = typeof job.name === 'string' ? job.name : '';
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const failed = steps.filter((s) => s && typeof s === 'object' && (s as Record<string, unknown>).conclusion === 'failure');
    if (failed.length === 0 && job.conclusion === 'failure') out.push({ job: name, step: '' });
    for (const s of failed) out.push({ job: name, step: String((s as Record<string, unknown>).name ?? '') });
  }
  return out;
}

/** `gh auth status --json hosts`: the active entry for `host`. */
export function parseAuthStatus(text: string, host: string, requireScopedToken: boolean): AuthStatus {
  const o = obj('auth status', parseJson('auth status', text));
  const hosts = obj('auth status', o.hosts ?? {});
  const entries = Array.isArray(hosts[host]) ? (hosts[host] as unknown[]) : [];
  const active = entries.map((e) => obj('auth status', e)).find((e) => e.active === true);
  if (!active) return { ok: false, login: null, tokenSource: null, scopes: null, error: `no active account for ${host}` };
  const tokenSource = typeof active.tokenSource === 'string' ? active.tokenSource : null;
  const login = typeof active.login === 'string' && active.login !== '' ? active.login : null;
  const scopes = typeof active.scopes === 'string' ? active.scopes : null;
  if (active.state !== 'success') {
    const error = typeof active.error === 'string' && active.error ? redact(active.error).slice(0, 300) : `state ${String(active.state)}`;
    return { ok: false, login, tokenSource, scopes, error };
  }
  if (requireScopedToken && tokenSource !== 'GH_TOKEN') {
    return { ok: false, login, tokenSource, scopes, error: `the active credential comes from ${tokenSource ?? 'an unknown source'}, not a scoped GH_TOKEN` };
  }
  return { ok: true, login, tokenSource, scopes, error: null };
}

/** Map a failed `gh` invocation to an OrbitError carrying the right code. */
export function classifyGhFailure(what: string, exitCode: number | null, stderrText: string): OrbitError {
  const text = redact(stderrText.trim()).slice(0, 800);
  const msg = `gh ${what} failed (exit ${exitCode ?? 'signal'}): ${text}`;
  if (/rate limit|secondary rate|HTTP 429|abuse detection/i.test(text)) {
    const m = /retry[- ]after[:= ]+(\d+)/i.exec(text) ?? /in (\d+) (?:second|sec)/i.exec(text);
    const retryAfterMs = m ? Math.min(Number(m[1]) * 1000, 15 * 60_000) : 60_000;
    return new OrbitError('PROVIDER_TRANSIENT', msg, { retryAfterMs, rateLimited: true });
  }
  if (exitCode === 4 || /HTTP 401|Bad credentials|gh auth login|authentication required|requires authentication|token .*(?:expired|invalid|revoked)/i.test(text)) {
    return new OrbitError('AUTH_EXPIRED', msg, { definitive: true });
  }
  if (/Resource not accessible|HTTP 403/i.test(text)) {
    return new OrbitError('AUTH_MISSING', `${msg} (the delivery token lacks a permission this action needs)`, { definitive: true });
  }
  if (/HTTP 5\d\d|timeout|timed out|connection (?:reset|refused)|EOF|no such host|could not resolve host|temporary failure/i.test(text)) {
    return new OrbitError('PROVIDER_TRANSIENT', msg);
  }
  if (/HTTP 404|Could not resolve to a (?:Repository|PullRequest)/i.test(text)) {
    return new OrbitError('NOT_FOUND', msg, { definitive: true });
  }
  return new OrbitError('DELIVERY_FAILED', msg);
}

// ---------------------------------------------------------------------------
// gh CLI client

export type GhRunner = (argv: readonly string[], opts: { env: Record<string, string | undefined>; cwd?: string; input?: string; timeoutMs: number }) => Promise<ExecResult>;

export interface GhCliOptions {
  /** OWNER/REPO. */
  repo: string;
  /** The controller's environment; only GH_TOKEN is taken from it, never GITHUB_TOKEN. Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  ghPath?: string;
  cwd?: string;
  host?: string;
  /** Refuse to run without GH_TOKEN (the default), so a broad keyring login is never used silently. */
  requireScopedToken?: boolean;
  timeoutMs?: number;
  /** Replaceable for tests. */
  runner?: GhRunner;
}

const PR_FIELDS = 'number,url,headRefName,headRefOid,baseRefName,isDraft,state,title,body';
const MERGE_FIELDS = 'number,state,headRefOid,baseRefName,mergeCommit,mergedAt';
/** gh pr merge refusals that mean nothing happened and repeating cannot help. */
const MERGE_REFUSED = /Head branch was modified|not mergeable|merge conflict|required status check|review is required|reviews? required|base branch policy|protected branch|Merge method .* not allowed|not allowed on this repository|HTTP 405|HTTP 409|HTTP 422/i;
const CHECK_FIELDS = 'name,state,bucket,link,workflow,event,startedAt,completedAt,description';
const RUN_FIELDS = 'databaseId,status,conclusion,headSha,headBranch,event,workflowName,name,attempt,url,startedAt,updatedAt';

export class GhCliClient implements GitHubClient {
  private readonly token: string | undefined;
  private readonly gh: string;
  private readonly runner: GhRunner;
  private readonly requireScoped: boolean;
  private readonly timeoutMs: number;
  private readonly baseEnv: Readonly<Record<string, string | undefined>>;

  private readonly opts: GhCliOptions;

  constructor(opts: GhCliOptions) {
    this.opts = opts;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new OrbitError('CONFIG_INVALID', `repository ${JSON.stringify(opts.repo)} is not OWNER/REPO`, { definitive: true });
    this.baseEnv = opts.env ?? process.env;
    this.token = this.baseEnv.GH_TOKEN || undefined;
    this.gh = opts.ghPath ?? 'gh';
    this.requireScoped = opts.requireScopedToken ?? true;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
    this.runner =
      opts.runner ??
      ((argv, o) => execCapture(argv, { env: o.env, cwd: o.cwd, input: o.input, timeoutMs: o.timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }));
  }

  /** Minimal environment: the token the controller holds, and nothing a worker could have left around. */
  private env(): Record<string, string | undefined> {
    const e: Record<string, string | undefined> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (this.baseEnv[k] !== undefined) e[k] = this.baseEnv[k];
    if (this.token) e.GH_TOKEN = this.token;
    e.GH_PROMPT_DISABLED = '1';
    e.GH_NO_UPDATE_NOTIFIER = '1';
    e.GH_TELEMETRY = 'false';
    e.NO_COLOR = '1';
    e.GH_PAGER = 'cat';
    return e;
  }

  private assertToken(): void {
    if (this.requireScoped && !this.token) {
      throw new OrbitError('AUTH_MISSING', 'no GH_TOKEN in the controller environment; delivery needs a fine-grained token scoped to the target repository', { definitive: true });
    }
  }

  private async exec(argv: string[], input?: string): Promise<ExecResult> {
    return this.runner([this.gh, ...argv], { env: this.env(), cwd: this.opts.cwd, input, timeoutMs: this.timeoutMs });
  }

  private async ok(what: string, argv: string[], input?: string): Promise<string> {
    this.assertToken();
    const res = await this.exec(argv, input);
    if (res.timedOut) throw new OrbitError('PROVIDER_TRANSIENT', `gh ${what} timed out`);
    if (res.exitCode !== 0) throw classifyGhFailure(what, res.exitCode, `${res.stderr}\n${res.stdout}`);
    return res.stdout;
  }

  async findPullRequest(head: string): Promise<PullRequestInfo | null> {
    assertHead(head);
    const out = await this.ok('pr list', ['pr', 'list', '-R', this.opts.repo, '--head', head, '--state', 'all', '-L', '30', '--json', PR_FIELDS]);
    // `--head` matches the branch name only (no owner prefix); keep exact matches, OPEN first, then the newest.
    const mine = parsePullRequestList(out).filter((p) => p.headRefName === head);
    mine.sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number);
    return mine[0] ?? null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    assertHead(input.head);
    this.assertToken();
    const argv = ['pr', 'create', '-R', this.opts.repo, '--head', input.head, '--base', input.base, '--title', input.title, '--body-file', '-'];
    if (input.draft) argv.push('--draft');
    const res = await this.exec(argv, input.body);
    if (res.timedOut) throw new OrbitError('PROVIDER_TRANSIENT', 'gh pr create timed out');
    if (res.exitCode !== 0) {
      // A PR for this head already exists (`gh` refuses): adopt it rather than report a failure.
      if (/already exists/i.test(res.stderr)) {
        const found = await this.findPullRequest(input.head);
        if (found) return found;
      }
      // A partial `--attach` failure also exits non-zero after creating the PR; the caller reconciles by head.
      throw classifyGhFailure('pr create', res.exitCode, `${res.stderr}\n${res.stdout}`);
    }
    const url = res.stdout.split('\n').map((l) => l.trim()).reverse().find((l) => /^https?:\/\/\S+\/pull\/\d+/.test(l));
    const number = url ? Number(/\/pull\/(\d+)/.exec(url)![1]) : NaN;
    if (Number.isInteger(number)) return this.viewPullRequest(number);
    const found = await this.findPullRequest(input.head);
    if (found) return found;
    throw new OrbitError('DELIVERY_FAILED', 'gh pr create exited 0 but no pull request URL was printed and none is listed for the head branch');
  }

  async updatePullRequest(number: number, changes: { title?: string; body?: string }): Promise<PullRequestInfo> {
    if (!Number.isInteger(number) || number <= 0) throw new OrbitError('INTERNAL', 'pull request number must be a positive integer');
    const argv = ['pr', 'edit', String(number), '-R', this.opts.repo];
    if (changes.title !== undefined) argv.push('--title', changes.title);
    if (changes.body !== undefined) argv.push('--body-file', '-');
    if (argv.length > 5) await this.ok('pr edit', argv, changes.body);
    return this.viewPullRequest(number);
  }

  async markPullRequestReady(number: number): Promise<PullRequestInfo> {
    if (!Number.isInteger(number) || number <= 0) throw new OrbitError('INTERNAL', 'pull request number must be a positive integer');
    this.assertToken();
    await this.ok('pr ready', ['pr', 'ready', String(number), '-R', this.opts.repo]);
    return this.viewPullRequest(number);
  }

  private async viewPullRequest(number: number): Promise<PullRequestInfo> {
    const out = await this.ok('pr view', ['pr', 'view', String(number), '-R', this.opts.repo, '--json', PR_FIELDS]);
    return parsePullRequest(parseJson('pr view', out));
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<MergeState> {
    assertMergeInput(input);
    this.assertToken();
    // -R makes gh skip every local-branch step of --delete-branch: only the remote head branch is deleted.
    const argv = ['pr', 'merge', String(input.number), '-R', this.opts.repo, `--${input.method}`, '--match-head-commit', input.headSha];
    if (input.deleteBranch) argv.push('--delete-branch');
    const res = await this.exec(argv);
    if (res.timedOut) throw new OrbitError('PROVIDER_TRANSIENT', 'gh pr merge timed out');
    if (res.exitCode !== 0) {
      const text = `${res.stderr}\n${res.stdout}`;
      if (/already (?:been )?merged/i.test(text)) return this.getMergeState(input.number);
      const err = classifyGhFailure('pr merge', res.exitCode, text);
      if (err.code === 'DELIVERY_FAILED' && MERGE_REFUSED.test(text)) throw new OrbitError('DELIVERY_FAILED', err.message, { definitive: true, refused: true });
      throw err;
    }
    const state = await this.getMergeState(input.number);
    // Exit 0 without a merge: the host queued it (merge queue or auto-merge). Orbit does not wait on a queue it cannot see.
    if (state.state !== 'MERGED') throw new OrbitError('DELIVERY_FAILED', `gh pr merge exited 0 but pull request #${input.number} is ${state.state}; a merge queue or auto-merge is not supported`, { definitive: true, state: state.state });
    return state;
  }

  async getMergeState(number: number): Promise<MergeState> {
    if (!Number.isInteger(number) || number <= 0) throw new OrbitError('INTERNAL', 'pull request number must be a positive integer');
    const out = await this.ok('pr view', ['pr', 'view', String(number), '-R', this.opts.repo, '--json', MERGE_FIELDS]);
    return parseMergeState(parseJson('pr view', out));
  }

  async listChecks(query: ChecksQuery): Promise<ChecksResult> {
    this.assertToken();
    if ('pr' in query) {
      // `gh pr checks` reports the PR's current head, which lags a push for a moment: read the head first,
      // and when it is not the commit asked about, read that commit's own workflow runs instead.
      if (query.sha) {
        const head = (await this.viewPullRequest(query.pr)).headRefOid;
        if (head !== query.sha) return this.checksFromRuns(query.sha);
      }
      const headSha = query.sha ?? null;
      const res = await this.exec(['pr', 'checks', String(query.pr), '-R', this.opts.repo, '--json', CHECK_FIELDS]);
      if (res.timedOut) throw new OrbitError('PROVIDER_TRANSIENT', 'gh pr checks timed out');
      if (res.exitCode === 0) {
        const checks = parseChecks(res.stdout);
        if (checks.length > 0 || !query.sha) return { checks, absent: checks.length === 0, headSha };
        return this.checksFromRuns(query.sha);
      }
      const text = `${res.stderr}\n${res.stdout}`;
      // "no checks reported on the '<branch>' branch" exits 1: CI has not started or is not configured.
      if (/no checks reported/i.test(text)) return query.sha ? this.checksFromRuns(query.sha) : { checks: [], absent: true, headSha };
      const err = classifyGhFailure('pr checks', res.exitCode, text);
      // A fine-grained token may not be able to read check runs (UNVERIFIED in the notes); workflow runs are Actions-read.
      if (err.code === 'AUTH_MISSING' && query.sha) return this.checksFromRuns(query.sha);
      throw err;
    }
    return this.checksFromRuns(query.sha);
  }

  private async checksFromRuns(sha: string): Promise<ChecksResult> {
    if (!/^[0-9a-f]{7,64}$/.test(sha)) throw new OrbitError('INTERNAL', `not a commit sha: ${sha}`);
    const out = await this.ok('run list', ['run', 'list', '-R', this.opts.repo, '--commit', sha, '-L', '50', '--json', RUN_FIELDS]);
    const checks = parseRunListAsChecks(out);
    return { checks, absent: checks.length === 0, headSha: sha };
  }

  async failedLogs(runId: string): Promise<FailedLogs> {
    if (!/^\d+$/.test(runId)) throw new OrbitError('INTERNAL', `not a run id: ${runId}`);
    this.assertToken();
    const res = await this.exec(['run', 'view', runId, '-R', this.opts.repo, '--log-failed']);
    if (res.timedOut) throw new OrbitError('PROVIDER_TRANSIENT', 'gh run view timed out');
    if (res.exitCode === 0) return { status: 'ok', text: res.stdout, failedSteps: [] };
    const text = `${res.stderr}\n${res.stdout}`;
    const status = /HTTP 410/.test(text) ? 'expired' : /log not found/i.test(text) ? 'not-found' : null;
    if (status === null) throw classifyGhFailure('run view --log-failed', res.exitCode, text);
    // The log is gone; the jobs listing still names the failed steps.
    let failedSteps: { job: string; step: string }[] = [];
    try {
      failedSteps = parseFailedSteps(await this.ok('run view', ['run', 'view', runId, '-R', this.opts.repo, '--json', 'jobs']));
    } catch (err) {
      if ((err as { code?: string }).code === 'AUTH_EXPIRED') throw err;
    }
    return { status, text: '', failedSteps };
  }

  async authStatus(): Promise<AuthStatus> {
    const host = this.opts.host ?? 'github.com';
    if (this.requireScoped && !this.token) {
      return { ok: false, login: null, tokenSource: null, scopes: null, error: 'no GH_TOKEN in the controller environment' };
    }
    // `--json hosts` always exits 0 for a bad credential; the verdict is in the JSON.
    const res = await this.exec(['auth', 'status', '--json', 'hosts']);
    if (res.exitCode !== 0) return { ok: false, login: null, tokenSource: null, scopes: null, error: redact(`${res.stderr}${res.stdout}`.trim()).slice(0, 300) || `gh exited ${res.exitCode}` };
    return parseAuthStatus(res.stdout, host, this.requireScoped);
  }
}

function assertMergeInput(input: MergePullRequestInput): void {
  if (!Number.isInteger(input.number) || input.number <= 0) throw new OrbitError('INTERNAL', 'pull request number must be a positive integer');
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(input.headSha)) throw new OrbitError('INTERNAL', `not a full commit sha: ${JSON.stringify(input.headSha)}`);
  if (!(MERGE_METHODS as readonly string[]).includes(input.method)) throw new OrbitError('CONFIG_INVALID', `unknown merge method ${JSON.stringify(input.method)}`, { definitive: true });
}

function assertHead(head: string): void {
  if (typeof head !== 'string' || head === '' || head.startsWith('-') || /[\s\0]/.test(head)) {
    throw new OrbitError('INTERNAL', `not a usable head branch: ${JSON.stringify(head)}`);
  }
}

// ---------------------------------------------------------------------------
// fake

export interface FakeCheckSpec {
  name: string;
  bucket: CheckBucket;
  runId?: string;
}

interface FakePr extends PullRequestInfo {
  /** Set when the PR's head cannot be resolved from a remote, and frozen when the PR is merged. */
  fixedHeadOid?: string;
  mergeCommitOid?: string;
  mergedAt?: string;
}

interface FakeFaults {
  /** Number of upcoming createPullRequest calls that create the PR and then fail with a lost response. */
  loseCreateResponse: number;
  /** Number of upcoming calls (any method but authStatus) that fail with a rate limit. */
  rateLimit: number;
  rateLimitRetryAfterMs: number;
  /** Every call fails with AUTH_EXPIRED, and authStatus reports not ok. */
  authExpired: boolean;
  /** Number of upcoming mergePullRequest calls that merge and then fail with a lost response. */
  loseMergeResponse: number;
  /** Number of upcoming markPullRequestReady calls that mark it ready and then fail with a lost response. */
  loseReadyResponse: number;
}

interface FakeState {
  nextNumber: number;
  prs: FakePr[];
  /** Per commit: a sequence of snapshots, one consumed per listChecks call; the last one repeats. */
  ci: Record<string, { script: FakeCheckSpec[][]; cursor: number }>;
  logs: Record<string, { status: FailedLogs['status']; text: string; failedSteps: FailedLogs['failedSteps'] }>;
  heads: Record<string, string>;
  faults: FakeFaults;
  calls: string[];
  creates: number;
  updates: number;
  merges: number;
  /** Draft pull requests that were marked ready. */
  readies?: number;
}

export interface FakeGitHubOptions {
  /** JSON state file; shared by every FakeGitHub instance pointed at it, so a "restarted" controller sees the same world. */
  statePath: string;
  /** A (bare) git directory whose refs/heads/<head> gives a PR its headRefOid, like the real service. */
  remoteGitDir?: string;
  repo?: string;
}

export class FakeGitHub implements GitHubClient {
  private readonly opts: FakeGitHubOptions;

  constructor(opts: FakeGitHubOptions) {
    this.opts = opts;
  }

  // -- test controls

  get state(): Readonly<FakeState> {
    return this.load();
  }

  setFaults(faults: Partial<FakeFaults>): void {
    this.mutate((s) => void Object.assign(s.faults, faults));
  }

  /** Script CI for a commit: each listChecks call for it returns the next snapshot (the last repeats). */
  scriptCi(sha: string, script: FakeCheckSpec[][]): void {
    this.mutate((s) => {
      s.ci[sha] = { script, cursor: 0 };
    });
  }

  scriptLog(runId: string, log: { status?: FailedLogs['status']; text?: string; failedSteps?: FailedLogs['failedSteps'] }): void {
    this.mutate((s) => {
      s.logs[runId] = { status: log.status ?? 'ok', text: log.text ?? '', failedSteps: log.failedSteps ?? [] };
    });
  }

  /** Pin a branch's head sha when no remote is attached. */
  setHead(branch: string, sha: string): void {
    this.mutate((s) => {
      s.heads[branch] = sha;
    });
  }

  setPullRequestState(number: number, state: PullRequestState): void {
    this.mutate((s) => {
      const pr = s.prs.find((p) => p.number === number);
      if (pr) pr.state = state;
    });
  }

  // -- GitHubClient

  async findPullRequest(head: string): Promise<PullRequestInfo | null> {
    this.enter('findPullRequest');
    const state = this.load();
    const mine = state.prs.filter((p) => p.headRefName === head).sort((a, b) => Number(b.state === 'OPEN') - Number(a.state === 'OPEN') || b.number - a.number);
    return mine[0] ? this.view(state, mine[0]) : null;
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<PullRequestInfo> {
    this.enter('createPullRequest');
    let created: PullRequestInfo | null = null;
    let lose = false;
    this.mutate((s) => {
      if (s.prs.some((p) => p.headRefName === input.head && p.state === 'OPEN')) {
        throw new OrbitError('DELIVERY_FAILED', `a pull request for branch "${input.head}" into branch "${input.base}" already exists`);
      }
      const number = s.nextNumber++;
      const pr: FakePr = {
        number,
        url: `https://github.example/${this.opts.repo ?? 'acme/app'}/pull/${number}`,
        headRefName: input.head,
        headRefOid: '',
        baseRefName: input.base,
        isDraft: input.draft,
        state: 'OPEN',
        title: input.title,
        body: input.body,
      };
      s.prs.push(pr);
      s.creates++;
      created = this.view(s, pr);
      if (s.faults.loseCreateResponse > 0) {
        s.faults.loseCreateResponse--;
        lose = true;
      }
    });
    // The PR exists now; the caller just never hears about it.
    if (lose) throw new OrbitError('PROVIDER_TRANSIENT', 'connection reset while waiting for the create response');
    return created!;
  }

  async updatePullRequest(number: number, changes: { title?: string; body?: string }): Promise<PullRequestInfo> {
    this.enter('updatePullRequest');
    let out: PullRequestInfo | null = null;
    this.mutate((s) => {
      const pr = s.prs.find((p) => p.number === number);
      if (!pr) throw new OrbitError('NOT_FOUND', `no pull request #${number}`, { definitive: true });
      if (changes.title !== undefined) pr.title = changes.title;
      if (changes.body !== undefined) pr.body = changes.body;
      s.updates++;
      out = this.view(s, pr);
    });
    return out!;
  }

  async markPullRequestReady(number: number): Promise<PullRequestInfo> {
    this.enter('markPullRequestReady');
    let out: PullRequestInfo | null = null;
    let lose = false;
    this.mutate((s) => {
      const pr = s.prs.find((p) => p.number === number);
      if (!pr) throw new OrbitError('NOT_FOUND', `no pull request #${number}`, { definitive: true });
      if (pr.state !== 'OPEN') throw new OrbitError('DELIVERY_FAILED', `gh pr ready failed: pull request #${number} is ${pr.state.toLowerCase()}`, { definitive: true });
      if (pr.isDraft) s.readies = (s.readies ?? 0) + 1;
      pr.isDraft = false;
      out = this.view(s, pr);
      if ((s.faults.loseReadyResponse ?? 0) > 0) {
        s.faults.loseReadyResponse--;
        lose = true;
      }
    });
    if (lose) throw new OrbitError('PROVIDER_TRANSIENT', 'connection reset while waiting for the ready response');
    return out!;
  }

  /**
   * Like the real service: refused unless the PR is open, not a draft and its
   * head is still `headSha`. With a remote attached, the base branch really
   * moves (a squash or rebase onto an unmoved base, or a two-parent merge
   * commit); a base that moved since the head was cut is refused as not
   * mergeable, since the fake does not do three-way merges.
   */
  async mergePullRequest(input: MergePullRequestInput): Promise<MergeState> {
    this.enter('mergePullRequest');
    assertMergeInput(input);
    let out: MergeState | null = null;
    let lose = false;
    this.mutate((s) => {
      const pr = s.prs.find((p) => p.number === input.number);
      if (!pr) throw new OrbitError('NOT_FOUND', `no pull request #${input.number}`, { definitive: true });
      if (pr.state === 'MERGED') {
        out = this.mergeView(s, pr);
        return;
      }
      if (pr.state !== 'OPEN') throw new OrbitError('DELIVERY_FAILED', `gh pr merge failed: pull request #${pr.number} is closed`, { definitive: true, refused: true });
      if (pr.isDraft) throw new OrbitError('DELIVERY_FAILED', `gh pr merge failed: pull request #${pr.number} is still a draft`, { definitive: true, refused: true });
      const head = this.headOid(s, pr) ?? pr.fixedHeadOid ?? '';
      if (head !== input.headSha) {
        throw new OrbitError('DELIVERY_FAILED', 'gh pr merge failed: Head branch was modified. Review and try the merge again.', { definitive: true, refused: true, head });
      }
      const mergeCommit = this.mergeOnRemote(pr, head, input.method, s.nextNumber);
      pr.state = 'MERGED';
      pr.fixedHeadOid = head;
      pr.mergeCommitOid = mergeCommit;
      pr.mergedAt = new Date(0).toISOString();
      if (input.deleteBranch && this.opts.remoteGitDir) this.git(['update-ref', '-d', `refs/heads/${pr.headRefName}`, head]);
      s.merges = (s.merges ?? 0) + 1;
      out = this.mergeView(s, pr);
      if (s.faults.loseMergeResponse > 0) {
        s.faults.loseMergeResponse--;
        lose = true;
      }
    });
    if (lose) throw new OrbitError('PROVIDER_TRANSIENT', 'connection reset while waiting for the merge response');
    return out!;
  }

  async getMergeState(number: number): Promise<MergeState> {
    this.enter('getMergeState');
    const s = this.load();
    const pr = s.prs.find((p) => p.number === number);
    if (!pr) throw new OrbitError('NOT_FOUND', `no pull request #${number}`, { definitive: true });
    return this.mergeView(s, pr);
  }

  async listChecks(query: ChecksQuery): Promise<ChecksResult> {
    this.enter('listChecks');
    let sha: string | undefined = query.sha;
    let result: ChecksResult = { checks: [], absent: true, headSha: sha ?? null };
    this.mutate((s) => {
      if ('pr' in query) {
        const pr = s.prs.find((p) => p.number === query.pr);
        if (!pr) throw new OrbitError('NOT_FOUND', `no pull request #${query.pr}`, { definitive: true });
        // Like the real service: a PR's checks are its current head's, whatever commit the caller meant.
        sha = this.view(s, pr).headRefOid || undefined;
        result = { checks: [], absent: true, headSha: sha ?? null };
      }
      const entry = sha ? s.ci[sha] : undefined;
      if (!entry || entry.script.length === 0) return;
      const snapshot = entry.script[Math.min(entry.cursor, entry.script.length - 1)]!;
      entry.cursor++;
      const checks: CheckInfo[] = snapshot.map((c) => ({
        name: c.name,
        bucket: c.bucket,
        state: c.bucket === 'pass' ? 'SUCCESS' : c.bucket === 'fail' ? 'FAILURE' : c.bucket === 'cancel' ? 'CANCELLED' : c.bucket === 'skipping' ? 'SKIPPED' : 'IN_PROGRESS',
        link: c.runId ? `https://github.example/${this.opts.repo ?? 'acme/app'}/actions/runs/${c.runId}/job/1` : null,
        workflow: 'ci',
        runId: c.runId ?? null,
        jobId: c.runId ? '1' : null,
        startedAt: null,
        completedAt: null,
        description: null,
      }));
      result = { checks, absent: checks.length === 0, headSha: sha ?? null };
    });
    return result;
  }

  async failedLogs(runId: string): Promise<FailedLogs> {
    this.enter('failedLogs');
    const entry = this.load().logs[runId];
    return entry ? { ...entry } : { status: 'not-found', text: '', failedSteps: [] };
  }

  async authStatus(): Promise<AuthStatus> {
    this.mutate((s) => void s.calls.push('authStatus'));
    if (this.load().faults.authExpired) {
      return { ok: false, login: null, tokenSource: 'GH_TOKEN', scopes: null, error: 'non-200 OK status code: 401 Unauthorized' };
    }
    return { ok: true, login: 'orbit-bot', tokenSource: 'GH_TOKEN', scopes: null, error: null };
  }

  // -- internals

  /** Record the call, then apply the call-level faults. */
  private enter(name: string): void {
    let fault: OrbitError | null = null;
    this.mutate((s) => {
      s.calls.push(name);
      if (s.faults.authExpired) {
        fault = new OrbitError('AUTH_EXPIRED', `gh ${name} failed (exit 4): HTTP 401: Bad credentials`, { definitive: true });
      } else if (s.faults.rateLimit > 0) {
        s.faults.rateLimit--;
        fault = new OrbitError('PROVIDER_TRANSIENT', `gh ${name} failed: API rate limit exceeded`, { retryAfterMs: s.faults.rateLimitRetryAfterMs, rateLimited: true });
      }
    });
    if (fault) throw fault;
  }

  private view(state: FakeState, pr: FakePr): PullRequestInfo {
    const { fixedHeadOid, mergeCommitOid: _m, mergedAt: _a, ...info } = pr;
    // A merged PR keeps the head it was merged at, even after its branch is deleted.
    const head = pr.state === 'MERGED' && fixedHeadOid ? fixedHeadOid : (this.headOid(state, pr) ?? fixedHeadOid ?? '');
    return { ...info, headRefOid: head };
  }

  private mergeView(state: FakeState, pr: FakePr): MergeState {
    const v = this.view(state, pr);
    return { number: v.number, state: v.state, headRefOid: v.headRefOid, baseRefName: v.baseRefName, mergeCommitSha: pr.state === 'MERGED' ? (pr.mergeCommitOid ?? null) : null, mergedAt: pr.state === 'MERGED' ? (pr.mergedAt ?? null) : null };
  }

  /** Move the base branch on the attached remote; without one, a stable synthetic merge commit id. */
  private mergeOnRemote(pr: FakePr, head: string, method: MergeMethod, salt: number): string {
    if (!this.opts.remoteGitDir) return sha256(`fake-merge:${pr.number}:${head}:${method}:${salt}`).slice(-40);
    const baseRef = `refs/heads/${pr.baseRefName}`;
    const base = this.git(['rev-parse', '--verify', '--quiet', baseRef]);
    if (!base) throw new OrbitError('DELIVERY_FAILED', `gh pr merge failed: base branch ${pr.baseRefName} does not exist`, { definitive: true, refused: true });
    if (this.git(['merge-base', base, head]) !== base) {
      throw new OrbitError('DELIVERY_FAILED', `gh pr merge failed: Pull Request is not mergeable (base ${pr.baseRefName} moved)`, { definitive: true, refused: true });
    }
    let commit: string;
    if (method === 'rebase') commit = head;
    else {
      const tree = this.git(['rev-parse', `${head}^{tree}`]);
      const parents = method === 'merge' ? ['-p', base, '-p', head] : ['-p', base];
      commit = this.git(['commit-tree', tree, ...parents, '-m', `${pr.title} (#${pr.number})`]);
    }
    this.git(['update-ref', baseRef, commit, base]);
    return commit;
  }

  private git(args: string[]): string {
    try {
      return execFileSync('git', ['--git-dir', this.opts.remoteGitDir!, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fake GitHub', GIT_AUTHOR_EMAIL: 'noreply@example.com', GIT_COMMITTER_NAME: 'Fake GitHub', GIT_COMMITTER_EMAIL: 'noreply@example.com', GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_DATE: '1700000000 +0000' },
      }).trim();
    } catch (err) {
      if (args[0] === 'rev-parse') return '';
      throw new OrbitError('DELIVERY_FAILED', `fake remote: git ${args[0]} failed: ${(err as Error).message}`);
    }
  }

  private headOid(state: FakeState, pr: FakePr): string | null {
    if (state.heads[pr.headRefName]) return state.heads[pr.headRefName]!;
    if (!this.opts.remoteGitDir) return null;
    try {
      return execFileSync('git', ['--git-dir', this.opts.remoteGitDir, 'rev-parse', '--verify', '--quiet', `refs/heads/${pr.headRefName}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
    } catch {
      return null;
    }
  }

  private load(): FakeState {
    if (!existsSync(this.opts.statePath)) return emptyState();
    return JSON.parse(readFileSync(this.opts.statePath, 'utf8')) as FakeState;
  }

  private mutate(fn: (s: FakeState) => void): void {
    const s = this.load();
    fn(s);
    atomicWriteJson(this.opts.statePath, s);
  }
}

function emptyState(): FakeState {
  return {
    nextNumber: 1,
    prs: [],
    ci: {},
    logs: {},
    heads: {},
    faults: { loseCreateResponse: 0, rateLimit: 0, rateLimitRetryAfterMs: 1000, authExpired: false, loseMergeResponse: 0, loseReadyResponse: 0 },
    calls: [],
    creates: 0,
    updates: 0,
    merges: 0,
  };
}
