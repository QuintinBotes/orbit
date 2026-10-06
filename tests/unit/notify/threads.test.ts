import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '../../../src/core/exec.ts';
import type { GhRunner } from '../../../src/delivery/github.ts';
import { FakeThreadClient, GhThreadClient, parseComments, parsePermission } from '../../../src/notify/threads.ts';

function res(over: Partial<ExecResult>): ExecResult {
  return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, cancelled: false, durationMs: 1, stdoutTruncated: false, stderrTruncated: false, pid: 1, ...over };
}

const COMMENT = { id: 101, html_url: 'https://github.com/acme/app/pull/7#issuecomment-101', user: { login: 'acme-dev' }, body: '/orbit answer q-1 A', created_at: '2026-10-06T10:00:00Z', author_association: 'OWNER' };

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function client(answer: (argv: readonly string[], input?: string) => ExecResult, env: Record<string, string> = { PATH: '/bin', HOME: '/home/acme', GH_TOKEN: 'github_pat_acme' }) {
  const calls: { argv: readonly string[]; env: Record<string, string | undefined>; input?: string }[] = [];
  const runner: GhRunner = async (argv, opts) => {
    calls.push({ argv, env: opts.env, ...(opts.input !== undefined ? { input: opts.input } : {}) });
    return answer(argv, opts.input);
  };
  return { c: new GhThreadClient({ repo: 'acme/app', env, runner }), calls };
}

describe('parsing GitHub comment and permission answers', () => {
  it('keeps id, url, author, body and time, and ignores the author association', () => {
    expect(parseComments(JSON.stringify([COMMENT]))).toEqual([{ id: 101, url: COMMENT.html_url, author: 'acme-dev', body: '/orbit answer q-1 A', createdAt: '2026-10-06T10:00:00Z' }]);
    expect(parseComments(JSON.stringify([{ ...COMMENT, user: null }]))[0]!.author).toBe('');
    expect(() => parseComments('{}')).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT' }));
    expect(() => parseComments(JSON.stringify([{ ...COMMENT, id: 'x' }]))).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT' }));
  });

  it('reads role_name first (it tells maintain from write and triage from read), then permission', () => {
    expect(parsePermission(JSON.stringify({ permission: 'write', role_name: 'maintain' }))).toBe('maintain');
    expect(parsePermission(JSON.stringify({ permission: 'read', role_name: 'triage' }))).toBe('triage');
    expect(parsePermission(JSON.stringify({ permission: 'admin' }))).toBe('admin');
    expect(parsePermission(JSON.stringify({ role_name: 'Custom Role' }))).toBe('custom role');
    expect(parsePermission(JSON.stringify({}))).toBe('unknown');
    expect(() => parsePermission('nope')).toThrow(expect.objectContaining({ code: 'MALFORMED_OUTPUT' }));
  });
});

describe('GhThreadClient', () => {
  it('lists issue comments page by page through gh api with the scoped token only', async () => {
    const page = Array.from({ length: 100 }, (_, i) => ({ ...COMMENT, id: i + 1 }));
    const { c, calls } = client((argv) => res({ stdout: JSON.stringify(String(argv.at(-1)).endsWith('&page=1') ? page : [COMMENT]) }));
    const got = await c.listComments(7, '2026-10-06T09:00:00.000Z');
    expect(got).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).toEqual(['gh', 'api', '-H', 'Accept: application/vnd.github+json', 'repos/acme/app/issues/7/comments?per_page=100&since=2026-10-06T09%3A00%3A00.000Z&page=1']);
    expect(calls[0]!.env.GH_TOKEN).toBe('github_pat_acme');
    expect(calls[0]!.env.GITHUB_TOKEN).toBeUndefined();
    expect(calls[0]!.env.GH_PROMPT_DISABLED).toBe('1');
  });

  it('reads a collaborator permission, and a 404 (not a collaborator) as none', async () => {
    const { c, calls } = client((argv) => (String(argv.at(-1)).includes('stranger') ? res({ exitCode: 1, stderr: 'gh: Not Found (HTTP 404)' }) : res({ stdout: JSON.stringify({ permission: 'write', role_name: 'write' }) })));
    expect(await c.permission('acme-dev')).toBe('write');
    expect(calls[0]!.argv.at(-1)).toBe('repos/acme/app/collaborators/acme-dev/permission');
    expect(await c.permission('stranger')).toBe('none');
  });

  it('never asks about a login that is not a GitHub login', async () => {
    const { c, calls } = client(() => res({ stdout: '{}' }));
    await expect(c.permission('../../orgs/acme')).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
    expect(calls).toEqual([]);
  });

  it('posts a comment with the body on stdin, never on the command line', async () => {
    const { c, calls } = client(() => res({ stdout: JSON.stringify({ html_url: 'https://github.com/acme/app/issues/3#issuecomment-9' }) }));
    expect(await c.createComment(3, 'hello `world`')).toEqual({ url: 'https://github.com/acme/app/issues/3#issuecomment-9' });
    expect(calls[0]!.argv).toEqual(['gh', 'api', '-H', 'Accept: application/vnd.github+json', '-X', 'POST', 'repos/acme/app/issues/3/comments', '--input', '-']);
    expect(JSON.parse(calls[0]!.input!)).toEqual({ body: 'hello `world`' });
  });

  it('refuses to run without GH_TOKEN and maps gh failures to error codes', async () => {
    const { c, calls } = client(() => res({}), { PATH: '/bin' });
    await expect(c.listComments(1, null)).rejects.toMatchObject({ code: 'AUTH_MISSING' });
    expect(calls).toEqual([]);
    const failing = client(() => res({ exitCode: 1, stderr: 'HTTP 401: Bad credentials' })).c;
    await expect(failing.createComment(1, 'x')).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    const slow = client(() => res({ exitCode: null, timedOut: true })).c;
    await expect(slow.permission('acme-dev')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    expect(() => new GhThreadClient({ repo: 'not a repo' })).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });
});

describe('FakeThreadClient', () => {
  it('keeps comments and permissions in a file, so a test and a controller can share them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-fake-threads-'));
    dirs.push(dir);
    const path = join(dir, 'threads.json');
    const a = new FakeThreadClient({ statePath: path });
    a.setPermission('acme-dev', 'write');
    const added = a.addComment(7, 'acme-dev', '/orbit answer q-1 A');
    expect(added).toMatchObject({ id: 1, author: 'acme-dev', url: 'https://github.test/acme/app/issues/7#issuecomment-1' });
    const b = new FakeThreadClient({ statePath: path });
    expect(await b.listComments(7, null)).toEqual([added]);
    expect(await b.listComments(8, null)).toEqual([]);
    expect(await b.permission('acme-dev')).toBe('write');
    expect(await b.permission('stranger')).toBe('none');
    const posted = await b.createComment(7, 'from orbit');
    expect(posted.url).toBe('https://github.test/acme/app/issues/7#issuecomment-2');
    expect(a.comments(7).map((x) => x.author)).toEqual(['acme-dev', 'orbit-bot']);
    expect(JSON.parse(readFileSync(path, 'utf8')).comments).toHaveLength(2);
  });

  it('can be scripted to fail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-fake-threads-'));
    dirs.push(dir);
    const path = join(dir, 'threads.json');
    writeFileSync(path, JSON.stringify({ comments: [], permissions: {}, fail: 'PROVIDER_TRANSIENT' }));
    const c = new FakeThreadClient({ statePath: path });
    await expect(c.listComments(1, null)).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    await expect(c.permission('x')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    await expect(c.createComment(1, 'x')).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
  });
});
