/**
 * What `orbit queue` reads and writes on GitHub (issue #171): the backlog (a parent's sub-issues, or the open issues
 * carrying a label) and the three writes (a label, a comment, closing an issue). `gh` is replaced by a recording
 * runner; nothing here reaches GitHub.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '../../../src/core/exec.ts';
import { FakeIssueReader, GhIssueTracker, hasLabel, parseIssueList } from '../../../src/intake/github.ts';
import { validateConfig } from '../../../src/policy/config.ts';

interface Call {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  input?: string;
}

function tracker(answers: Partial<ExecResult>[]): { t: GhIssueTracker; calls: Call[] } {
  const calls: Call[] = [];
  const t = new GhIssueTracker({
    repo: 'acme/app',
    env: { PATH: '/bin', HOME: '/home/alice', GITHUB_TOKEN: 'never' },
    runner: async (argv, o) => {
      calls.push({ argv, env: o.env, ...(o.input !== undefined ? { input: o.input } : {}) });
      return { exitCode: 0, signal: null, stdout: '[]', stderr: '', timedOut: false, durationMs: 1, truncated: false, ...answers.shift() } as ExecResult;
    },
  });
  return { t, calls };
}

const API = 'https://api.github.com/repos/acme/app';
const item = (number: number, o: { state?: string; labels?: string[]; repo?: string; pr?: boolean } = {}) => ({
  number,
  title: `Issue ${number}`,
  state: o.state ?? 'open',
  labels: (o.labels ?? ['ready-for-agent']).map((name) => ({ name })),
  repository_url: o.repo ? `https://api.github.com/repos/${o.repo}` : API,
  ...(o.pr ? { pull_request: { url: 'x' } } : {}),
});

describe('reading a backlog through gh', () => {
  it("lists a parent's sub-issues in its order, leaves out other repositories, and reads blockers only of open issues carrying the label", async () => {
    const subs = [item(170, { state: 'closed' }), item(171), item(172, { labels: ['spec'] }), item(5, { repo: 'acme/other' }), item(173, { labels: ['ready-for-agent', 'ready-for-human'] })];
    const { t, calls } = tracker([{ stdout: JSON.stringify(subs) }, { stdout: JSON.stringify([{ number: 170, state: 'closed', repository_url: API }]) }, { stdout: '[]' }]);
    const issues = await t.listIssues({ parent: 165, label: 'ready-for-agent' });
    expect(issues.map((i) => [i.number, i.open, i.blockedBy])).toEqual([
      [170, false, []],
      [171, true, [{ repo: 'acme/app', number: 170, open: false }]],
      [172, true, []],
      [173, true, []],
    ]);
    expect(calls.map((c) => c.argv.slice(1))).toEqual([
      ['api', '-H', 'Accept: application/vnd.github+json', 'repos/acme/app/issues/165/sub_issues?per_page=100&page=1'],
      ['api', '-H', 'Accept: application/vnd.github+json', 'repos/acme/app/issues/171/dependencies/blocked_by?per_page=100'],
      ['api', '-H', 'Accept: application/vnd.github+json', 'repos/acme/app/issues/173/dependencies/blocked_by?per_page=100'],
    ]);
    // Reads are GETs: no method, field or input; GITHUB_TOKEN is never passed on.
    for (const c of calls) expect(c.argv.some((a) => a === '-X' || a === '-f' || a === '--input')).toBe(false);
    expect(calls[0]!.env.GITHUB_TOKEN).toBeUndefined();
  });

  it('without a parent, lists the open issues carrying the label, oldest first, page by page, and skips pull requests', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => item(i + 1, { pr: i === 0 }));
    const { t, calls } = tracker([{ stdout: JSON.stringify(page1) }, { stdout: JSON.stringify([item(101)]) }]);
    const issues = await t.listIssues({ parent: null, label: 'ready for agent' });
    expect(issues).toHaveLength(101);
    expect(issues[0]).toMatchObject({ number: 1, isPullRequest: true, blockedBy: [] });
    expect(calls[0]!.argv.at(-1)).toBe('repos/acme/app/issues?state=open&labels=ready+for+agent&sort=created&direction=asc&per_page=100&page=1');
    expect(calls[1]!.argv.at(-1)).toMatch(/&page=2$/);
  });

  it('writes a label, a comment and a close as JSON on stdin, never in argv', async () => {
    const { t, calls } = tracker([{ stdout: '{}' }, { stdout: '{}' }, { stdout: '{}' }]);
    await t.addLabel(7, 'ready-for-human');
    await t.comment(7, 'Body with `code` and "quotes"; $(id)');
    await t.close(7);
    expect(calls.map((c) => [c.argv.slice(4), c.input])).toEqual([
      [['-X', 'POST', 'repos/acme/app/issues/7/labels', '--input', '-'], '{"labels":["ready-for-human"]}'],
      [['-X', 'POST', 'repos/acme/app/issues/7/comments', '--input', '-'], JSON.stringify({ body: 'Body with `code` and "quotes"; $(id)' })],
      [['-X', 'PATCH', 'repos/acme/app/issues/7', '--input', '-'], '{"state":"closed","state_reason":"completed"}'],
    ]);
  });

  it('says what failed in one line', async () => {
    const { t } = tracker([{ exitCode: 1, stdout: '', stderr: 'HTTP 404: Not Found' }]);
    await expect(t.listIssues({ parent: 9, label: 'x' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(() => parseIssueList('{}', 'acme/app')).toThrow(/expected an array/);
    await expect(tracker([]).t.addLabel(0, 'x')).rejects.toMatchObject({ code: 'SCHEMA_INVALID' });
  });
});

describe('the fake tracker', () => {
  const dirs: string[] = [];
  afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
  function fake(): FakeIssueReader {
    const d = mkdtempSync(join(tmpdir(), 'orbit-tracker-'));
    dirs.push(d);
    return new FakeIssueReader({ statePath: join(d, 'issues.json') });
  }

  it("lists a parent's sub-issues in its order and the labelled issues by number, and records every write", async () => {
    const f = fake();
    f.put({ number: 1, body: '', subIssues: [4, 2, 3, 99] });
    f.put({ number: 2, body: '', labels: ['ready-for-agent'] });
    f.put({ number: 3, body: '', labels: ['ready-for-agent'], blockedBy: [2] });
    f.put({ number: 4, body: '', open: false, labels: ['ready-for-agent'] });
    expect((await f.listIssues({ parent: 1, label: 'ready-for-agent' })).map((i) => [i.number, i.blockedBy.map((b) => b.number)])).toEqual([
      [4, []],
      [2, []],
      [3, [2]],
    ]);
    expect((await f.listIssues({ parent: null, label: 'ready-for-agent' })).map((i) => i.number)).toEqual([2, 3]);
    await f.addLabel(3, 'ready-for-human');
    await f.addLabel(3, 'ready-for-human');
    await f.comment(3, 'why');
    await f.close(2);
    expect(f.issue(3)!.labels).toEqual(['ready-for-agent', 'ready-for-human']);
    expect(f.issue(2)!.open).toBe(false);
    expect(f.comments(3)).toEqual(['why']);
    expect(f.writes).toEqual(['label #3 ready-for-human', 'label #3 ready-for-human', 'comment #3', 'close #2']);
    expect(hasLabel(f.issue(3)! as { labels: string[] }, 'READY-FOR-HUMAN')).toBe(true);
    await expect(f.close(50)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});

describe('the base branch on the command line', () => {
  it('is validated exactly as if the policy file said it', () => {
    const c = validateConfig({ version: 1, mode: 'autonomous' }, { baseBranch: 'next' });
    expect(c.repository.base_branch).toBe('next');
    expect(() => validateConfig({ version: 1, mode: 'autonomous' }, { baseBranch: 'orbit/x' })).toThrow(/also matches the base branch/);
    expect(() => validateConfig({ version: 1, mode: 'autonomous' }, { baseBranch: 'bad..name' })).toThrow(/repository\.base_branch/);
  });
});
