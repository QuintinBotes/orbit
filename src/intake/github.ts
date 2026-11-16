/**
 * Reading issues (docs/decisions/0019-run-from-issue.md). A narrow, read-only client of its own, beside delivery's
 * GitHubClient and the comment ThreadClient: one issue with what a run needs to judge it (state, lock, labels, body,
 * the time of its last update) and the issues GitHub's dependencies say block it. Nothing here writes.
 *
 * `GhIssueReader` goes through `gh api` (a GET, array argv, no shell). A command a person types may read with their
 * own `gh` login; the controller reads with its scoped GH_TOKEN only, as delivery does. `FakeIssueReader` keeps the
 * same in a JSON file, for tests and the fake delivery provider.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execCapture } from '../core/exec.ts';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { atomicWriteJson } from '../core/fsx.ts';
import { redact } from '../core/redact.ts';
import { classifyGhFailure, type GhRunner } from '../delivery/github.ts';
import { resolveRemoteUrl } from '../delivery/git.ts';
import type { OrbitConfig } from '../policy/types.ts';

export interface BlockingIssue {
  /** OWNER/REPO of the blocking issue; it may live in another repository. */
  repo: string;
  number: number;
  open: boolean;
}

export interface IssueInfo {
  /** OWNER/REPO the issue was read from. */
  repo: string;
  number: number;
  title: string;
  body: string;
  open: boolean;
  /** GitHub's state reason of a closed issue ("completed", "not_planned"), when it gave one. */
  stateReason: string | null;
  locked: boolean;
  /** The number names a pull request: GitHub serves those through the issues API too. */
  isPullRequest: boolean;
  labels: string[];
  /** ISO time of the issue's last update, as GitHub reports it. */
  updatedAt: string;
  url: string;
  blockedBy: BlockingIssue[];
}

export interface IssueReader {
  /** OWNER/REPO this reader reads from. */
  readonly repo: string;
  getIssue(number: number): Promise<IssueInfo>;
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCEPT = ['-H', 'Accept: application/vnd.github+json'];
/** More blockers than one page holds are not read; an issue with that many is refused as blocked anyway when any is open. */
const BLOCKERS_PER_PAGE = 100;

function malformed(what: string, detail: string): OrbitError {
  return new OrbitError('MALFORMED_OUTPUT', `gh api ${what}: ${detail}`);
}

function parseJson(what: string, text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw malformed(what, `output is not JSON (${redact(text.slice(0, 120))})`);
  }
}

function repoOfUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = /\/repos\/([^/]+\/[^/]+)(?:\/|$)/.exec(url) ?? /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\//.exec(url);
  return m && REPO.test(m[1]!) ? m[1]! : null;
}

/** `GET /repos/{owner}/{repo}/issues/{number}`. */
export function parseIssue(text: string, repo: string): Omit<IssueInfo, 'blockedBy'> {
  const v = parseJson('issue', text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw malformed('issue', 'expected an object');
  const o = v as Record<string, unknown>;
  if (typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number <= 0) throw malformed('issue', 'no issue number');
  if (o.state !== 'open' && o.state !== 'closed') throw malformed('issue', 'no state');
  const labels = Array.isArray(o.labels) ? o.labels.flatMap((l: unknown) => (typeof l === 'string' ? [l] : l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string' ? [(l as { name: string }).name] : [])) : [];
  return {
    repo,
    number: o.number,
    title: typeof o.title === 'string' ? o.title : '',
    body: typeof o.body === 'string' ? o.body : '',
    open: o.state === 'open',
    stateReason: typeof o.state_reason === 'string' ? o.state_reason : null,
    locked: o.locked === true,
    isPullRequest: o.pull_request !== undefined && o.pull_request !== null,
    labels,
    updatedAt: typeof o.updated_at === 'string' ? o.updated_at : '',
    url: typeof o.html_url === 'string' ? o.html_url : '',
  };
}

/** `GET /repos/{owner}/{repo}/issues/{number}/dependencies/blocked_by`: the issues that block this one. */
export function parseBlockedBy(text: string, repo: string): BlockingIssue[] {
  const v = parseJson('blocked_by', text);
  if (!Array.isArray(v)) throw malformed('blocked_by', 'expected an array');
  return v.map((x: unknown) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    if (typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number <= 0) throw malformed('blocked_by', 'a blocking issue has no number');
    // An entry whose state is not readable counts as open: a blocker is never assumed away.
    return { repo: repoOfUrl(o.repository_url) ?? repoOfUrl(o.html_url) ?? repo, number: o.number, open: o.state !== 'closed' };
  });
}

export interface GhIssueReaderOptions {
  /** OWNER/REPO. */
  repo: string;
  /** Only PATH, HOME, the locale, gh's own config location and GH_TOKEN are taken from it; never GITHUB_TOKEN. */
  env?: Readonly<Record<string, string | undefined>>;
  ghPath?: string;
  cwd?: string;
  timeoutMs?: number;
  /** Refuse to read without GH_TOKEN (the controller). A command a person runs may use their `gh` login: false. */
  requireScopedToken?: boolean;
  /** Replaceable for tests. */
  runner?: GhRunner;
}

export class GhIssueReader implements IssueReader {
  readonly repo: string;
  private readonly opts: GhIssueReaderOptions;
  private readonly baseEnv: Readonly<Record<string, string | undefined>>;
  private readonly runner: GhRunner;

  constructor(opts: GhIssueReaderOptions) {
    if (!REPO.test(opts.repo)) throw new OrbitError('CONFIG_INVALID', `repository ${JSON.stringify(opts.repo)} is not OWNER/REPO`, { definitive: true });
    this.opts = opts;
    this.repo = opts.repo;
    this.baseEnv = opts.env ?? process.env;
    this.runner = opts.runner ?? ((argv, o) => execCapture(argv, { env: o.env, cwd: o.cwd, input: o.input, timeoutMs: o.timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }));
  }

  private env(): Record<string, string | undefined> {
    const e: Record<string, string | undefined> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'GH_CONFIG_DIR', 'XDG_CONFIG_HOME']) if (this.baseEnv[k] !== undefined) e[k] = this.baseEnv[k];
    if (this.baseEnv.GH_TOKEN) e.GH_TOKEN = this.baseEnv.GH_TOKEN;
    e.GH_PROMPT_DISABLED = '1';
    e.GH_NO_UPDATE_NOTIFIER = '1';
    e.GH_TELEMETRY = 'false';
    e.NO_COLOR = '1';
    e.GH_PAGER = 'cat';
    return e;
  }

  /** A read: `gh api <path>` with no method, field or input flag is a GET. */
  private async get(what: string, path: string): Promise<{ ok: true; text: string } | { ok: false; error: OrbitError }> {
    if ((this.opts.requireScopedToken ?? false) && !this.baseEnv.GH_TOKEN) {
      throw new OrbitError('AUTH_MISSING', 'no GH_TOKEN in the controller environment; reading the issue needs a token scoped to the repository', { definitive: true });
    }
    let res;
    try {
      res = await this.runner([this.opts.ghPath ?? 'gh', 'api', ...ACCEPT, path], { env: this.env(), ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}), timeoutMs: this.opts.timeoutMs ?? 30_000 });
    } catch (err) {
      if (isOrbitError(err, 'NOT_FOUND') && err.details?.errno === 'ENOENT') {
        throw new OrbitError('PROVIDER_UNAVAILABLE', 'the GitHub CLI (gh) was not found on PATH; install it (https://cli.github.com) and run "gh auth login" to read issues', { definitive: true });
      }
      throw err;
    }
    if (res.timedOut) throw new OrbitError('PROVIDER_TRANSIENT', `gh api ${what} timed out`);
    if (res.exitCode !== 0) return { ok: false, error: classifyGhFailure(`api ${what}`, res.exitCode, `${res.stderr}\n${res.stdout}`) };
    return { ok: true, text: res.stdout };
  }

  async getIssue(number: number): Promise<IssueInfo> {
    assertIssueNumber(number);
    const issue = await this.get('issue', `repos/${this.repo}/issues/${number}`);
    if (!issue.ok) throw issue.error;
    const info = parseIssue(issue.text, this.repo);
    const blockers = await this.get('blocked_by', `repos/${this.repo}/issues/${number}/dependencies/blocked_by?per_page=${BLOCKERS_PER_PAGE}`);
    // A host without issue dependencies answers 404 for the list of an issue that exists: there are none to read.
    if (!blockers.ok && blockers.error.code !== 'NOT_FOUND') throw blockers.error;
    return { ...info, blockedBy: blockers.ok ? parseBlockedBy(blockers.text, this.repo) : [] };
  }
}

export function assertIssueNumber(n: number): void {
  if (!Number.isInteger(n) || n <= 0 || n > 2_147_483_647) throw new OrbitError('SCHEMA_INVALID', 'an issue number must be a positive integer');
}

// ---------------------------------------------------------------------------
// Fake

export interface FakeIssue {
  number: number;
  title?: string;
  body: string;
  open?: boolean;
  stateReason?: string | null;
  locked?: boolean;
  isPullRequest?: boolean;
  labels?: string[];
  updatedAt?: string;
  /** Numbers of issues in the same fake repository that block this one. */
  blockedBy?: number[];
}

interface FakeIssueState {
  issues: FakeIssue[];
  /** Every getIssue call, by number. */
  reads: number[];
  /** The next read fails once with this error. */
  failNext?: { code: 'AUTH_EXPIRED' | 'PROVIDER_TRANSIENT' | 'PROVIDER_UNAVAILABLE'; message: string; retryAfterMs?: number } | null;
}

/** The fake delivery provider's issues live beside its pull requests. */
export const FAKE_ISSUES_FILE = 'fake-github-issues.json';
/** The repository the fakes stand for. */
export const FAKE_REPO = 'acme/app';

export class FakeIssueReader implements IssueReader {
  readonly repo: string;
  private readonly statePath: string;

  constructor(opts: { statePath: string; repo?: string }) {
    this.statePath = opts.statePath;
    this.repo = opts.repo ?? FAKE_REPO;
  }

  private read(): FakeIssueState {
    if (!existsSync(this.statePath)) return { issues: [], reads: [] };
    const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<FakeIssueState>;
    return { issues: s.issues ?? [], reads: s.reads ?? [], failNext: s.failNext ?? null };
  }

  private write(s: FakeIssueState): void {
    atomicWriteJson(this.statePath, s);
  }

  /** Add an issue, or replace the one with the same number (a person editing it): its update time moves on. */
  put(issue: FakeIssue): void {
    const s = this.read();
    const at = issue.updatedAt ?? new Date(Date.UTC(2026, 0, 1) + s.issues.length * 1000 + s.reads.length).toISOString();
    s.issues = [...s.issues.filter((i) => i.number !== issue.number), { ...issue, updatedAt: at }];
    this.write(s);
  }

  failNext(fault: NonNullable<FakeIssueState['failNext']>): void {
    const s = this.read();
    s.failNext = fault;
    this.write(s);
  }

  get reads(): number[] {
    return this.read().reads;
  }

  async getIssue(number: number): Promise<IssueInfo> {
    assertIssueNumber(number);
    const s = this.read();
    s.reads.push(number);
    const fault = s.failNext ?? null;
    s.failNext = null;
    this.write(s);
    if (fault) throw new OrbitError(fault.code, fault.message, { definitive: fault.code !== 'PROVIDER_TRANSIENT', ...(fault.retryAfterMs !== undefined ? { retryAfterMs: fault.retryAfterMs, rateLimited: true } : {}) });
    const i = s.issues.find((x) => x.number === number);
    if (!i) throw new OrbitError('NOT_FOUND', `gh api issue failed (exit 1): HTTP 404: Not Found (repos/${this.repo}/issues/${number})`, { definitive: true });
    return {
      repo: this.repo,
      number,
      title: i.title ?? `Issue ${number}`,
      body: i.body,
      open: i.open ?? true,
      stateReason: i.stateReason ?? null,
      locked: i.locked ?? false,
      isPullRequest: i.isPullRequest ?? false,
      labels: i.labels ?? [],
      updatedAt: i.updatedAt ?? '',
      url: `https://github.test/${this.repo}/issues/${number}`,
      blockedBy: (i.blockedBy ?? []).map((n) => ({ repo: this.repo, number: n, open: s.issues.find((x) => x.number === n)?.open ?? true })),
    };
  }
}

/**
 * The issue reader a policy selects: the file-backed fake for the fake delivery provider, else `gh` for the GitHub
 * repository the configured remote names. `scoped` is how the controller reads: with GH_TOKEN or not at all.
 */
export async function issueReaderFor(repoRoot: string, config: Pick<OrbitConfig, 'delivery' | 'repository'>, env: Readonly<Record<string, string | undefined>>, opts: { scoped?: boolean } = {}): Promise<IssueReader> {
  if (config.delivery.provider === 'fake') return new FakeIssueReader({ statePath: join(repoRoot, '.orbit', FAKE_ISSUES_FILE) });
  const remote = config.repository.remote;
  let url: string;
  try {
    url = await resolveRemoteUrl(repoRoot, remote);
  } catch {
    throw new OrbitError('CONFIG_INVALID', `this checkout has no remote "${remote}", so there is no repository to read an issue from`, { definitive: true });
  }
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new OrbitError('CONFIG_INVALID', `remote "${remote}" is not a github.com repository, so there is no issue tracker Orbit can read`, { definitive: true });
  return new GhIssueReader({ repo: `${m[1]}/${m[2]}`, env, cwd: repoRoot, requireScopedToken: opts.scoped === true });
}
