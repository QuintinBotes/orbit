/**
 * Reading issues (docs/decisions/0019-run-from-issue.md). A narrow client of its own, beside delivery's GitHubClient
 * and the comment ThreadClient: one issue with what a run needs to judge it (state, lock, labels, body, the time of its
 * last update) and the issues GitHub's dependencies say block it, and the backlog `orbit queue` works through (a
 * parent's sub-issues, or the open issues carrying a label). The reader never writes.
 *
 * `GhIssueReader` goes through `gh api` (a GET, array argv, no shell). A command a person types may read with their
 * own `gh` login; the controller reads with its scoped GH_TOKEN only, as delivery does. `GhIssueTracker` adds the three
 * writes the queue makes (docs/decisions/0020-backlog-queue.md): a label, a comment, and closing an issue whose pull
 * request merged into a base branch GitHub does not close issues from. `FakeIssueReader` keeps all of it in a JSON
 * file, for tests and the fake delivery provider.
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

/** Which issues make up a backlog (`orbit queue`). */
export interface BacklogQuery {
  /** The parent issue whose sub-issues, in the parent's order, are the backlog; null for the open issues carrying `label`. */
  parent: number | null;
  /** Only an open issue carrying this label has its blockers read: no other issue can be taken. */
  label: string;
}

/** What `orbit queue` reads and writes (docs/decisions/0020-backlog-queue.md). */
export interface IssueTracker extends IssueReader {
  /**
   * The backlog in priority order: the parent's sub-issues in the parent's order (issues of other repositories left
   * out), or the open issues carrying the label, oldest first. `blockedBy` is read for the open issues that carry the
   * label and is empty for the rest.
   */
  listIssues(query: BacklogQuery): Promise<IssueInfo[]>;
  addLabel(number: number, label: string): Promise<void>;
  comment(number: number, body: string): Promise<void>;
  /** Close the issue as completed. */
  close(number: number): Promise<void>;
}

/** True when the issue carries the label; GitHub compares label names without case. */
export function hasLabel(issue: Pick<IssueInfo, 'labels'>, label: string): boolean {
  const want = label.trim().toLowerCase();
  return issue.labels.some((l) => l.trim().toLowerCase() === want);
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ACCEPT = ['-H', 'Accept: application/vnd.github+json'];
/** More blockers than one page holds are not read; an issue with that many is refused as blocked anyway when any is open. */
const BLOCKERS_PER_PAGE = 100;
const ISSUES_PER_PAGE = 100;
/** A backlog longer than this many pages is not read past them. */
const ISSUE_PAGES = 10;

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
  return issueOf('issue', parseJson('issue', text), repo);
}

/** `GET /repos/{owner}/{repo}/issues/{number}/sub_issues` and `GET /repos/{owner}/{repo}/issues?labels=...`: one page. */
export function parseIssueList(text: string, repo: string): { issues: Omit<IssueInfo, 'blockedBy'>[]; count: number } {
  const v = parseJson('issues', text);
  if (!Array.isArray(v)) throw malformed('issues', 'expected an array');
  // A sub-issue may live in another repository; Orbit runs only issues of the repository it works in.
  const mine = v.filter((x: unknown) => (repoOfUrl((x as { repository_url?: unknown } | null)?.repository_url) ?? repo).toLowerCase() === repo.toLowerCase());
  return { issues: mine.map((x: unknown) => issueOf('issues', x, repo)), count: v.length };
}

function issueOf(what: string, v: unknown, repo: string): Omit<IssueInfo, 'blockedBy'> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw malformed(what, 'expected an object');
  const o = v as Record<string, unknown>;
  if (typeof o.number !== 'number' || !Number.isInteger(o.number) || o.number <= 0) throw malformed(what, 'no issue number');
  if (o.state !== 'open' && o.state !== 'closed') throw malformed(what, 'no state');
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
  protected async get(what: string, path: string): Promise<{ ok: true; text: string } | { ok: false; error: OrbitError }> {
    return this.call(what, [path]);
  }

  /** `gh api` with these arguments; the body, when there is one, goes on stdin. */
  protected async call(what: string, args: string[], input?: string): Promise<{ ok: true; text: string } | { ok: false; error: OrbitError }> {
    if ((this.opts.requireScopedToken ?? false) && !this.baseEnv.GH_TOKEN) {
      throw new OrbitError('AUTH_MISSING', 'no GH_TOKEN in the controller environment; reading the issue needs a token scoped to the repository', { definitive: true });
    }
    let res;
    try {
      res = await this.runner([this.opts.ghPath ?? 'gh', 'api', ...ACCEPT, ...args], { env: this.env(), ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}), ...(input !== undefined ? { input } : {}), timeoutMs: this.opts.timeoutMs ?? 30_000 });
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
    return { ...info, blockedBy: await this.blockedBy(number) };
  }

  private async blockedBy(number: number): Promise<BlockingIssue[]> {
    const blockers = await this.get('blocked_by', `repos/${this.repo}/issues/${number}/dependencies/blocked_by?per_page=${BLOCKERS_PER_PAGE}`);
    // A host without issue dependencies answers 404 for the list of an issue that exists: there are none to read.
    if (!blockers.ok && blockers.error.code !== 'NOT_FOUND') throw blockers.error;
    return blockers.ok ? parseBlockedBy(blockers.text, this.repo) : [];
  }

  async listIssues(query: BacklogQuery): Promise<IssueInfo[]> {
    if (query.parent !== null) assertIssueNumber(query.parent);
    const found: Omit<IssueInfo, 'blockedBy'>[] = [];
    for (let page = 1; page <= ISSUE_PAGES; page++) {
      const path =
        query.parent !== null
          ? `repos/${this.repo}/issues/${query.parent}/sub_issues?per_page=${ISSUES_PER_PAGE}&page=${page}`
          : `repos/${this.repo}/issues?${new URLSearchParams({ state: 'open', labels: query.label, sort: 'created', direction: 'asc', per_page: String(ISSUES_PER_PAGE), page: String(page) }).toString()}`;
      const r = await this.get(query.parent !== null ? 'sub_issues' : 'issues', path);
      if (!r.ok) throw r.error;
      const batch = parseIssueList(r.text, this.repo);
      found.push(...batch.issues);
      if (batch.count < ISSUES_PER_PAGE) break;
    }
    const out: IssueInfo[] = [];
    for (const i of found) out.push({ ...i, blockedBy: i.open && !i.isPullRequest && hasLabel(i, query.label) ? await this.blockedBy(i.number) : [] });
    return out;
  }
}

export class GhIssueTracker extends GhIssueReader implements IssueTracker {
  private async write(what: string, method: 'POST' | 'PATCH', path: string, body: unknown): Promise<void> {
    const r = await this.call(what, ['-X', method, path, '--input', '-'], JSON.stringify(body));
    if (!r.ok) throw r.error;
  }

  async addLabel(number: number, label: string): Promise<void> {
    assertIssueNumber(number);
    await this.write('add label', 'POST', `repos/${this.repo}/issues/${number}/labels`, { labels: [label] });
  }

  async comment(number: number, body: string): Promise<void> {
    assertIssueNumber(number);
    await this.write('comment', 'POST', `repos/${this.repo}/issues/${number}/comments`, { body });
  }

  async close(number: number): Promise<void> {
    assertIssueNumber(number);
    await this.write('close issue', 'PATCH', `repos/${this.repo}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
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
  /** A parent's sub-issues, in the parent's order. */
  subIssues?: number[];
}

interface FakeIssueState {
  issues: FakeIssue[];
  /** Every getIssue call, by number. */
  reads: number[];
  /** Every comment Orbit wrote, in order. */
  comments?: { number: number; body: string }[];
  /** Every write, in order: "label #3 ready-for-human", "comment #3", "close #3". */
  writes?: string[];
  /** The next read fails once with this error. */
  failNext?: { code: 'AUTH_EXPIRED' | 'PROVIDER_TRANSIENT' | 'PROVIDER_UNAVAILABLE'; message: string; retryAfterMs?: number } | null;
}

/** The fake delivery provider's issues live beside its pull requests. */
export const FAKE_ISSUES_FILE = 'fake-github-issues.json';
/** The repository the fakes stand for. */
export const FAKE_REPO = 'acme/app';

export class FakeIssueReader implements IssueTracker {
  readonly repo: string;
  private readonly statePath: string;

  constructor(opts: { statePath: string; repo?: string }) {
    this.statePath = opts.statePath;
    this.repo = opts.repo ?? FAKE_REPO;
  }

  private read(): FakeIssueState {
    if (!existsSync(this.statePath)) return { issues: [], reads: [], comments: [], writes: [] };
    const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<FakeIssueState>;
    return { issues: s.issues ?? [], reads: s.reads ?? [], failNext: s.failNext ?? null, comments: s.comments ?? [], writes: s.writes ?? [] };
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

  /** The issue as the fake holds it now, or undefined. */
  issue(number: number): FakeIssue | undefined {
    return this.read().issues.find((i) => i.number === number);
  }

  /** Every comment Orbit wrote on the issue, oldest first. */
  comments(number: number): string[] {
    return (this.read().comments ?? []).filter((c) => c.number === number).map((c) => c.body);
  }

  get writes(): string[] {
    return this.read().writes ?? [];
  }

  async listIssues(query: BacklogQuery): Promise<IssueInfo[]> {
    if (query.parent !== null) assertIssueNumber(query.parent);
    const s = this.read();
    const numbers =
      query.parent !== null
        ? (s.issues.find((i) => i.number === query.parent)?.subIssues ?? [])
        : s.issues.filter((i) => (i.open ?? true) && !i.isPullRequest && hasLabel({ labels: i.labels ?? [] }, query.label)).map((i) => i.number).sort((a, b) => a - b);
    const out: IssueInfo[] = [];
    for (const n of numbers) {
      if (!s.issues.some((i) => i.number === n)) continue;
      const info = await this.getIssue(n);
      out.push(info.open && !info.isPullRequest && hasLabel(info, query.label) ? info : { ...info, blockedBy: [] });
    }
    return out;
  }

  private change(number: number, write: string, fn: (i: FakeIssue, s: FakeIssueState) => void): void {
    assertIssueNumber(number);
    const s = this.read();
    const i = s.issues.find((x) => x.number === number);
    if (!i) throw new OrbitError('NOT_FOUND', `gh api ${write} failed (exit 1): HTTP 404: Not Found (repos/${this.repo}/issues/${number})`, { definitive: true });
    fn(i, s);
    s.writes = [...(s.writes ?? []), write];
    this.write(s);
  }

  async addLabel(number: number, label: string): Promise<void> {
    this.change(number, `label #${number} ${label}`, (i) => {
      if (!hasLabel({ labels: i.labels ?? [] }, label)) i.labels = [...(i.labels ?? []), label];
    });
  }

  async comment(number: number, body: string): Promise<void> {
    this.change(number, `comment #${number}`, (_i, s) => {
      s.comments = [...(s.comments ?? []), { number, body }];
    });
  }

  async close(number: number): Promise<void> {
    this.change(number, `close #${number}`, (i) => {
      i.open = false;
      i.stateReason = 'completed';
    });
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
  return new GhIssueReader({ repo: await githubRepoOf(repoRoot, config), env, cwd: repoRoot, requireScopedToken: opts.scoped === true });
}

/** What `orbit queue` reads and writes through: the fake for the fake delivery provider, else `gh` with GH_TOKEN or the person's own login. */
export async function issueTrackerFor(repoRoot: string, config: Pick<OrbitConfig, 'delivery' | 'repository'>, env: Readonly<Record<string, string | undefined>>): Promise<IssueTracker> {
  if (config.delivery.provider === 'fake') return new FakeIssueReader({ statePath: join(repoRoot, '.orbit', FAKE_ISSUES_FILE) });
  return new GhIssueTracker({ repo: await githubRepoOf(repoRoot, config), env, cwd: repoRoot });
}

/** OWNER/REPO of the GitHub repository the configured remote names. */
async function githubRepoOf(repoRoot: string, config: Pick<OrbitConfig, 'repository'>): Promise<string> {
  const remote = config.repository.remote;
  let url: string;
  try {
    url = await resolveRemoteUrl(repoRoot, remote);
  } catch {
    throw new OrbitError('CONFIG_INVALID', `this checkout has no remote "${remote}", so there is no repository to read an issue from`, { definitive: true });
  }
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
  if (!m) throw new OrbitError('CONFIG_INVALID', `remote "${remote}" is not a github.com repository, so there is no issue tracker Orbit can read`, { definitive: true });
  return `${m[1]}/${m[2]}`;
}
