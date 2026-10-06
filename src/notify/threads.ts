/**
 * Pull request and issue comments, for notifications and remote answers (ADR 0008). A narrow client of its own,
 * beside delivery's GitHubClient: read a thread's comments, read a person's permission on the repository, post a
 * comment. `GhThreadClient` goes through `gh api` with the controller's scoped GH_TOKEN only (never GITHUB_TOKEN,
 * never a keyring login), as delivery does. `FakeThreadClient` keeps the same state in a JSON file, for tests and
 * the fake delivery provider.
 *
 * A permission is whatever GitHub's collaborator permission endpoint says (`role_name`, which tells maintain from
 * write and triage from read, then `permission`); the caller decides what is enough. Nothing in a comment counts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { execCapture, type ExecResult } from '../core/exec.ts';
import { OrbitError, type OrbitErrorCode } from '../core/errors.ts';
import { atomicWriteJson } from '../core/fsx.ts';
import { classifyGhFailure, type GhRunner } from '../delivery/github.ts';
import { redact } from '../core/redact.ts';

export interface ThreadComment {
  id: number;
  url: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ThreadClient {
  /** Every comment of the issue or pull request `number`, oldest first; `since` (ISO time) limits it to newer ones. */
  listComments(number: number, since: string | null): Promise<ThreadComment[]>;
  /** The person's role on the repository, lower case (admin, maintain, write, triage, read, none, or a custom role). */
  permission(login: string): Promise<string>;
  createComment(number: number, body: string): Promise<{ url: string }>;
}

/** The roles whose answers count: they can push to the repository anyway. */
export const ANSWERING_ROLES: ReadonlySet<string> = new Set(['admin', 'maintain', 'write']);

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

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

export function parseComments(text: string): ThreadComment[] {
  const v = parseJson('comments', text);
  if (!Array.isArray(v)) throw malformed('comments', 'expected an array');
  return v.map((c: unknown) => {
    const o = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    if (typeof o.id !== 'number' || !Number.isInteger(o.id)) throw malformed('comments', 'a comment has no integer id');
    const user = o.user && typeof o.user === 'object' ? (o.user as Record<string, unknown>) : null;
    return {
      id: o.id,
      url: typeof o.html_url === 'string' ? o.html_url : '',
      author: typeof user?.login === 'string' ? user.login : '',
      body: typeof o.body === 'string' ? o.body : '',
      createdAt: typeof o.created_at === 'string' ? o.created_at : '',
    };
  });
}

export function parsePermission(text: string): string {
  const v = parseJson('permission', text);
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const role = typeof o.role_name === 'string' && o.role_name !== '' ? o.role_name : typeof o.permission === 'string' && o.permission !== '' ? o.permission : 'unknown';
  return role.toLowerCase();
}

export interface GhThreadOptions {
  /** OWNER/REPO. */
  repo: string;
  /** The controller's environment; only GH_TOKEN is taken from it. */
  env?: Readonly<Record<string, string | undefined>>;
  ghPath?: string;
  cwd?: string;
  timeoutMs?: number;
  runner?: GhRunner;
}

const PER_PAGE = 100;
const MAX_PAGES = 10;
const ACCEPT = ['-H', 'Accept: application/vnd.github+json'];

export class GhThreadClient implements ThreadClient {
  private readonly opts: GhThreadOptions;
  private readonly token: string | undefined;
  private readonly baseEnv: Readonly<Record<string, string | undefined>>;
  private readonly runner: GhRunner;

  constructor(opts: GhThreadOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) throw new OrbitError('CONFIG_INVALID', `repository ${JSON.stringify(opts.repo)} is not OWNER/REPO`, { definitive: true });
    this.opts = opts;
    this.baseEnv = opts.env ?? process.env;
    this.token = this.baseEnv.GH_TOKEN || undefined;
    this.runner = opts.runner ?? ((argv, o) => execCapture(argv, { env: o.env, cwd: o.cwd, input: o.input, timeoutMs: o.timeoutMs, maxOutputBytes: 8 * 1024 * 1024 }));
  }

  private env(): Record<string, string | undefined> {
    const e: Record<string, string | undefined> = {};
    for (const k of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']) if (this.baseEnv[k] !== undefined) e[k] = this.baseEnv[k];
    e.GH_TOKEN = this.token;
    e.GH_PROMPT_DISABLED = '1';
    e.GH_NO_UPDATE_NOTIFIER = '1';
    e.GH_TELEMETRY = 'false';
    e.NO_COLOR = '1';
    e.GH_PAGER = 'cat';
    return e;
  }

  private async exec(what: string, args: string[], input?: string): Promise<ExecResult> {
    if (!this.token) throw new OrbitError('AUTH_MISSING', 'no GH_TOKEN in the controller environment; comments and remote answers need a token scoped to the repository', { definitive: true });
    const res = await this.runner([this.opts.ghPath ?? 'gh', 'api', ...ACCEPT, ...args], { env: this.env(), ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}), ...(input !== undefined ? { input } : {}), timeoutMs: this.opts.timeoutMs ?? 30_000 });
    if (res.timedOut) throw new OrbitError('PROVIDER_TRANSIENT', `gh api ${what} timed out`);
    return res;
  }

  private async ok(what: string, args: string[], input?: string): Promise<string> {
    const res = await this.exec(what, args, input);
    if (res.exitCode !== 0) throw classifyGhFailure(`api ${what}`, res.exitCode, `${res.stderr}\n${res.stdout}`);
    return res.stdout;
  }

  async listComments(number: number, since: string | null): Promise<ThreadComment[]> {
    assertNumber(number);
    const out: ThreadComment[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const q = new URLSearchParams({ per_page: String(PER_PAGE), ...(since ? { since } : {}), page: String(page) });
      const batch = parseComments(await this.ok('comments', [`repos/${this.opts.repo}/issues/${number}/comments?${q.toString()}`]));
      out.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return out;
  }

  async permission(login: string): Promise<string> {
    assertLogin(login);
    const res = await this.exec('permission', [`repos/${this.opts.repo}/collaborators/${login}/permission`]);
    if (res.exitCode !== 0) {
      const err = classifyGhFailure('api permission', res.exitCode, `${res.stderr}\n${res.stdout}`);
      // Not a collaborator at all.
      if (err.code === 'NOT_FOUND') return 'none';
      throw err;
    }
    return parsePermission(res.stdout);
  }

  async createComment(number: number, body: string): Promise<{ url: string }> {
    assertNumber(number);
    const out = await this.ok('create comment', ['-X', 'POST', `repos/${this.opts.repo}/issues/${number}/comments`, '--input', '-'], JSON.stringify({ body }));
    const v = parseJson('create comment', out) as Record<string, unknown> | null;
    return { url: typeof v?.html_url === 'string' ? v.html_url : '' };
  }
}

function assertNumber(n: number): void {
  if (!Number.isInteger(n) || n <= 0) throw new OrbitError('INTERNAL', 'an issue or pull request number must be a positive integer');
}

function assertLogin(login: string): void {
  if (!LOGIN.test(login)) throw new OrbitError('SCHEMA_INVALID', `${JSON.stringify(login.slice(0, 60))} is not a GitHub login`);
}

// ---------------------------------------------------------------------------
// Fake

interface FakeState {
  comments: (ThreadComment & { thread: number })[];
  permissions: Record<string, string>;
  /** Every call fails with this error code (a scripted outage). */
  fail?: OrbitErrorCode | null;
  /** The next call of one operation fails once with this code. */
  failNext?: Partial<Record<FakeOperation, OrbitErrorCode>>;
}

export type FakeOperation = 'listComments' | 'permission' | 'createComment';

/** The author Orbit's own comments have in the fake. */
export const FAKE_ORBIT_AUTHOR = 'orbit-bot';

export class FakeThreadClient implements ThreadClient {
  private readonly statePath: string;

  constructor(opts: { statePath: string }) {
    this.statePath = opts.statePath;
  }

  private read(): FakeState {
    if (!existsSync(this.statePath)) return { comments: [], permissions: {} };
    const s = JSON.parse(readFileSync(this.statePath, 'utf8')) as Partial<FakeState>;
    return { comments: s.comments ?? [], permissions: s.permissions ?? {}, fail: s.fail ?? null, failNext: s.failNext ?? {} };
  }

  private write(s: FakeState): void {
    atomicWriteJson(this.statePath, s);
  }

  private gate(op: FakeOperation): void {
    const s = this.read();
    if (s.fail) throw new OrbitError(s.fail, `fake GitHub: ${op} failed (scripted)`);
    const once = s.failNext?.[op];
    if (once) {
      delete s.failNext![op];
      this.write(s);
      throw new OrbitError(once, `fake GitHub: ${op} failed once (scripted)`);
    }
  }

  /** A comment by `author`, as a person would write it on the thread. */
  addComment(thread: number, author: string, body: string): ThreadComment {
    const s = this.read();
    const id = s.comments.reduce((m, c) => Math.max(m, c.id), 0) + 1;
    const c = { thread, id, url: `https://github.test/acme/app/issues/${thread}#issuecomment-${id}`, author, body, createdAt: new Date().toISOString() };
    s.comments.push(c);
    this.write(s);
    return strip(c);
  }

  setPermission(login: string, role: string): void {
    const s = this.read();
    s.permissions[login] = role;
    this.write(s);
  }

  failNext(op: FakeOperation, code: OrbitErrorCode): void {
    const s = this.read();
    s.failNext = { ...(s.failNext ?? {}), [op]: code };
    this.write(s);
  }

  comments(thread: number): ThreadComment[] {
    return this.read().comments.filter((c) => c.thread === thread).map(strip);
  }

  async listComments(number: number, since: string | null): Promise<ThreadComment[]> {
    this.gate('listComments');
    return this.comments(number).filter((c) => since === null || c.createdAt >= since);
  }

  async permission(login: string): Promise<string> {
    this.gate('permission');
    return this.read().permissions[login] ?? 'none';
  }

  async createComment(number: number, body: string): Promise<{ url: string }> {
    this.gate('createComment');
    return { url: this.addComment(number, FAKE_ORBIT_AUTHOR, body).url };
  }
}

function strip(c: ThreadComment & { thread?: number }): ThreadComment {
  return { id: c.id, url: c.url, author: c.author, body: c.body, createdAt: c.createdAt };
}
