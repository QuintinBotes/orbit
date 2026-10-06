import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { startRun } from '../../../src/controller/start.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { getQuestion } from '../../../src/inquisition/store.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import type { NotifyDeps } from '../../../src/notify/channels.ts';
import { FakeThreadClient } from '../../../src/notify/threads.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

function fakes(l: Lab, opts: { exitCode?: number } = {}): { notify: Partial<NotifyDeps>; threads: FakeThreadClient; desktop: string[][]; posts: string[] } {
  const threads = new FakeThreadClient({ statePath: join(l.base, 'threads.json') });
  const desktop: string[][] = [];
  const posts: string[] = [];
  return {
    threads,
    desktop,
    posts,
    notify: {
      env: { ACME_HOOK: 'https://hooks.acme.test/T/B/secret' },
      platform: 'linux',
      exec: async (argv) => {
        desktop.push(argv);
        return { exitCode: opts.exitCode ?? 0, notFound: false, stderr: opts.exitCode ? 'no display' : '' };
      },
      fetch: async (url, init) => {
        posts.push(init.body);
        return { status: 204, ok: true };
      },
      threads: async () => threads,
    },
  };
}

function writeConfig(l: Lab, notifications: string): void {
  mkdirSync(join(l.repo, '.orbit'), { recursive: true });
  writeFileSync(join(l.repo, '.orbit', 'config.yaml'), `version: 1\nmode: autonomous\nnetwork:\n  allowed_hosts: [hooks.acme.test]\nnotifications:\n${notifications}`);
}

describe('orbit notify test', () => {
  it('sends a test notification through each configured channel and prints the outcome of each', async () => {
    const l = lab();
    writeConfig(l, '  desktop: true\n  webhook:\n    url_env: ACME_HOOK\n  github_comment: true\n  remote_answers:\n    enabled: false\n    issue: 4\n');
    const f = fakes(l);
    const r = await l.cli(['notify', 'test'], { seams: { notify: f.notify } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('desktop: sent (notify-send)');
    expect(r.out).toContain('webhook: sent (hooks.acme.test answered 204)');
    expect(r.out).toContain('github_comment: sent (issue #4)');
    expect(r.out).not.toContain('secret');
    expect(JSON.parse(f.posts[0]!).orbit).toMatchObject({ kind: 'test' });
    expect(f.threads.comments(4)).toHaveLength(1);
  });

  it('exits 1 when a channel fails, and --json prints the outcomes', async () => {
    const l = lab();
    writeConfig(l, '  desktop: true\n');
    const f = fakes(l, { exitCode: 1 });
    const r = await l.cli(['notify', 'test', '--json'], { seams: { notify: f.notify } });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({
      outcomes: [
        { channel: 'desktop', status: 'failed', detail: 'notify-send exited 1: no display' },
        { channel: 'webhook', status: 'skipped', detail: 'notifications.webhook is off' },
        { channel: 'github_comment', status: 'skipped', detail: 'notifications.github_comment is off' },
      ],
    });
  });

  it('needs a config, and is refused inside a worker', async () => {
    const l = lab();
    const f = fakes(l);
    expect((await l.cli(['notify', 'test'], { seams: { notify: f.notify } })).code).toBe(3);
    writeConfig(l, '  desktop: true\n');
    const r = await l.cli(['notify', 'test'], { env: { ...process.env, ORBIT_WORKER: '1' }, seams: { notify: f.notify } });
    expect(r.code).toBe(4);
    expect(f.desktop).toEqual([]);
  });
});

describe('orbit resume reads remote answers first', () => {
  function blocked(l: Lab): { runId: string; questionId: string } {
    const config = defaultConfig('autonomous');
    config.notifications = { desktop: false, webhook: null, github_comment: false, remote_answers: { enabled: true, issue: 9, poll_seconds: 120 } };
    const run = startRun({ db: l.db(), repoRoot: l.repo, goal: 'Add a mul function to the calculator.', config, clock: systemClock });
    l.moveTo(run.id, ['PREFLIGHT', 'BLOCKED']);
    const q = l.ask(run.id);
    return { runId: run.id, questionId: q.id };
  }

  it('a permitted answer on the linked issue lets the run resume', async () => {
    const l = lab();
    const { runId, questionId } = blocked(l);
    const f = fakes(l);
    f.threads.setPermission('acme-dev', 'maintain');
    f.threads.addComment(9, 'acme-dev', `/orbit answer ${questionId} B`);
    const r = await l.cli(['resume', runId, '--detach'], { seams: { notify: f.notify } });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`recorded the answer to ${questionId} by acme-dev (maintain) from issue #9`);
    expect(getQuestion(l.db(), questionId)).toMatchObject({ status: 'answered', answer: 'B', answeredBy: 'github:acme-dev' });
    expect(getRun(l.db(), runId).state).toBe('PREFLIGHT');
  });

  it('a refused comment changes nothing: the open question still stops the resume', async () => {
    const l = lab();
    const { runId, questionId } = blocked(l);
    const f = fakes(l);
    f.threads.setPermission('outsider', 'triage');
    f.threads.addComment(9, 'outsider', `/orbit answer ${questionId} B`);
    const r = await l.cli(['resume', runId, '--detach'], { seams: { notify: f.notify } });
    expect(r.code).toBe(5);
    expect(r.out).toContain(`ignored a comment by outsider on issue #9 (permission)`);
    expect(getQuestion(l.db(), questionId).status).toBe('open');
    expect(getRun(l.db(), runId).state).toBe('BLOCKED');
  });

  it('a failed read is reported and the resume goes on by its usual rules', async () => {
    const l = lab();
    const { runId } = blocked(l);
    const f = fakes(l);
    f.threads.failNext('listComments', 'AUTH_MISSING');
    const r = await l.cli(['resume', runId, '--detach'], { seams: { notify: f.notify } });
    expect(r.code).toBe(5);
    expect(r.out).toMatch(/could not read remote answers: issue #9: AUTH_MISSING/);
    const broken = await l.cli(['resume', runId, '--detach'], { seams: { notify: { ...f.notify, threads: async () => { throw new Error('no remote'); } } } });
    expect(broken.code).toBe(5);
    expect(broken.out).toContain('could not read remote answers: no remote');
  });
});
