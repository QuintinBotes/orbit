import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GhCliClient } from '../../../src/delivery/github.ts';

/**
 * GhCliClient against a real child process: a stub `gh` that answers from
 * canned JSON files and records its argv and the credentials in its environment.
 */
const STUB = `#!/bin/sh
d="$GH_STUB_DIR"
echo "$*|GH_TOKEN=$GH_TOKEN|GITHUB_TOKEN=$GITHUB_TOKEN|AWS=$AWS_SECRET_ACCESS_KEY|PROMPT=$GH_PROMPT_DISABLED" >> "$d/calls.log"
case "$1 $2" in
  "pr list") cat "$d/pr-list.json" ;;
  "pr create") cat > "$d/body.txt"; if [ -f "$d/create-fails" ]; then echo "HTTP 502: Bad Gateway" >&2; exit 1; fi; echo "https://github.com/acme/app/pull/7" ;;
  "pr view") cat "$d/pr-view.json" ;;
  "pr checks") if [ -f "$d/nochecks" ]; then echo "no checks reported on the 'orbit/r1' branch" >&2; exit 1; fi; cat "$d/checks.json" ;;
  "run list") cat "$d/run-list.json" ;;
  "run view") if [ -f "$d/log-gone" ]; then echo "failed to get run log: HTTP 410: Server Error" >&2; exit 1; fi; printf 'build\\tnpm test\\t2026-01-01T00:00:00Z \\033[31mFAIL\\033[0m\\n' ;;
  "auth status") cat "$d/auth.json" ;;
  *) echo "unexpected: $*" >&2; exit 1 ;;
esac
`;

const PR = { number: 7, url: 'https://github.com/acme/app/pull/7', headRefName: 'orbit/r1', headRefOid: 'a'.repeat(40), baseRefName: 'main', isDraft: true, state: 'OPEN', title: 'T', body: 'B' };
const TOKEN = 'github_pat_scopedtokenvalue0123456789';

let dir: string;
let gh: string;

function put(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}
function client(env: Record<string, string> = {}): GhCliClient {
  return new GhCliClient({
    repo: 'acme/app',
    ghPath: gh,
    env: { PATH: process.env.PATH ?? '', HOME: dir, GH_TOKEN: TOKEN, GITHUB_TOKEN: 'ghp_ambientshouldnotpass', AWS_SECRET_ACCESS_KEY: 'aws-ambient', GH_STUB_DIR: dir, ...env },
    // The stub reads GH_STUB_DIR, which the scrubbed environment would drop; pass it through the runner's env.
    runner: async (argv, o) => {
      const { execCapture } = await import('../../../src/core/exec.ts');
      return execCapture(argv, { env: { ...o.env, GH_STUB_DIR: dir }, cwd: o.cwd, input: o.input, timeoutMs: o.timeoutMs });
    },
  });
}
const calls = (): string[] => readFileSync(join(dir, 'calls.log'), 'utf8').trim().split('\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-ghstub-'));
  gh = join(dir, 'gh');
  writeFileSync(gh, STUB);
  chmodSync(gh, 0o755);
  put('calls.log', '');
  put('pr-list.json', '[]');
  put('pr-view.json', JSON.stringify(PR));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('GhCliClient with a real gh executable', () => {
  it('uses the controller token only, scrubs ambient credentials, and never prompts', async () => {
    await client().findPullRequest('orbit/r1');
    expect(calls()[0]).toContain(`GH_TOKEN=${TOKEN}`);
    expect(calls()[0]).toContain('GITHUB_TOKEN=|');
    expect(calls()[0]).toContain('AWS=|');
    expect(calls()[0]).toContain('PROMPT=1');
  });

  it('creates a PR: body on stdin, title literal, then reads the PR back as JSON', async () => {
    const title = 'Fix $(touch /tmp/pwned) "quotes" && more';
    const body = 'line one\n`code`\n$HOME';
    const pr = await client().createPullRequest({ head: 'orbit/r1', base: 'main', title, body, draft: true });
    expect(pr).toMatchObject({ number: 7, headRefOid: 'a'.repeat(40) });
    expect(readFileSync(join(dir, 'body.txt'), 'utf8')).toBe(body);
    const create = calls().find((l) => l.startsWith('pr create'))!;
    expect(create).toContain(`--title ${title}`);
    expect(create).toContain('--head orbit/r1 --base main');
    expect(create).toContain('--body-file -');
    expect(create).toContain('--draft');
    expect(calls().some((l) => l.startsWith('pr view 7'))).toBe(true);
  });

  it('reports a failed create as an error (the caller reconciles by head)', async () => {
    put('create-fails', '1');
    await expect(client().createPullRequest({ head: 'orbit/r1', base: 'main', title: 't', body: 'b', draft: false })).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
  });

  it('finds an existing PR and ignores look-alike heads', async () => {
    put('pr-list.json', JSON.stringify([{ ...PR, headRefName: 'other/orbit/r1', number: 2 }, PR]));
    expect((await client().findPullRequest('orbit/r1'))?.number).toBe(7);
  });

  it('computes pass/fail from bucket although the command exits 0', async () => {
    put('checks.json', JSON.stringify([{ name: 'build', state: 'FAILURE', bucket: 'fail', link: 'https://github.com/acme/app/actions/runs/42/job/9' }]));
    const r = await client().listChecks({ pr: 7, sha: 'a'.repeat(40) });
    expect(r.checks[0]).toMatchObject({ bucket: 'fail', runId: '42', jobId: '9' });
  });

  it('maps "no checks reported" (exit 1) onto a workflow-run lookup by commit', async () => {
    put('nochecks', '1');
    put('run-list.json', JSON.stringify([{ databaseId: 42, status: 'completed', conclusion: 'failure', workflowName: 'ci', url: 'https://github.com/acme/app/actions/runs/42' }]));
    const r = await client().listChecks({ pr: 7, sha: 'a'.repeat(40) });
    expect(r).toMatchObject({ absent: false, checks: [{ bucket: 'fail', runId: '42' }] });
    expect(calls().some((l) => l.startsWith(`run list -R acme/app --commit ${'a'.repeat(40)}`))).toBe(true);
  });

  it('returns raw failed logs for the caller to sanitize, and reports expired logs', async () => {
    const ok = await client().failedLogs('42');
    expect(ok.status).toBe('ok');
    expect(ok.text).toContain('\x1b[31m');
    put('log-gone', '1');
    put('jobs.json', '{"jobs":[]}');
    const gone = await client().failedLogs('42');
    expect(gone.status).toBe('expired');
  });

  it('validates the authentication it will use: scoped token or not', async () => {
    put('auth.json', JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'success', tokenSource: 'GH_TOKEN', login: 'bot', scopes: '' }] } }));
    expect(await client().authStatus()).toMatchObject({ ok: true, login: 'bot' });
    put('auth.json', JSON.stringify({ hosts: { 'github.com': [{ active: true, state: 'error', tokenSource: 'GH_TOKEN', login: '', error: 'non-200 OK status code: 401 Unauthorized' }] } }));
    expect(await client().authStatus()).toMatchObject({ ok: false, error: expect.stringMatching(/401/) });
  });

  it('a missing gh executable is reported, not hidden', async () => {
    const c = new GhCliClient({ repo: 'acme/app', ghPath: join(dir, 'no-such-gh'), env: { PATH: '/nonexistent', GH_TOKEN: TOKEN } });
    await expect(c.findPullRequest('orbit/r1')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
