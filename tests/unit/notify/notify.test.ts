import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { notifyOpenQuestions, notifyRunEnded, resolveNotifyDeps, sendTestNotification, type RunNotifyInput } from '../../../src/notify/notify.ts';
import { RUN, addQuestion, fakeSystem, notifyConfig, setState, setup, type NotifyEnv } from './helpers.ts';

const envs: NotifyEnv[] = [];
afterEach(() => envs.splice(0).forEach((e) => e.cleanup()));

function world(): NotifyEnv {
  const env = setup();
  envs.push(env);
  return env;
}

const allChannels = (issue: number | null = null) =>
  notifyConfig((c) => {
    c.notifications = { desktop: true, webhook: { url_env: 'ACME_WEBHOOK_URL' }, github_comment: true, remote_answers: { enabled: issue !== null, issue, poll_seconds: 120 } };
    c.network.allowed_hosts = ['hooks.acme.test'];
  });

function input(env: NotifyEnv, sys: ReturnType<typeof fakeSystem>, over: Partial<RunNotifyInput> = {}): RunNotifyInput {
  return { db: env.db, clock: env.clock, run: env.run(), runDir: env.runDir, config: allChannels(), deps: sys.deps, actor: 'controller-test', ...over };
}

function events(env: NotifyEnv, type: string): Record<string, unknown>[] {
  return env.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', RUN, type).map((r) => JSON.parse(r.data_json) as Record<string, unknown>);
}

const ENV = { ACME_WEBHOOK_URL: 'https://hooks.acme.test/services/T0/B0/secretpart' };

describe('notifying when a run ends', () => {
  it('sends through every configured channel once, and records each outcome as an event', async () => {
    const env = world();
    setState(env, 'SUCCEEDED', 'all criteria supported', env.clock.now());
    writeFileSync(join(env.runDir, 'delivery.json'), JSON.stringify({ commit: 'c', branch: 'orbit/x', pr: { number: 12, url: 'https://github.test/acme/app/pull/12' } }));
    const sys = fakeSystem({ env: ENV });
    const out = await notifyRunEnded(input(env, sys));
    expect(out!.map((o) => [o.channel, o.status])).toEqual([
      ['desktop', 'sent'],
      ['webhook', 'sent'],
      ['github_comment', 'sent'],
    ]);
    expect(sys.threads.comments(12)).toHaveLength(1);
    expect(sys.threads.comments(12)[0]!.body).toContain('Review pull request #12');
    expect(events(env, 'notification.dispatched')).toEqual([expect.objectContaining({ key: `ended:SUCCEEDED:${env.clock.now()}`, kind: 'run.ended', state: 'SUCCEEDED', questions: [] })]);
    expect(events(env, 'notification.sent').map((e) => e.channel)).toEqual(['desktop', 'webhook', 'github_comment']);
    expect(JSON.stringify(events(env, 'notification.sent'))).not.toContain('secretpart');

    // A restarted controller, or a second call, does not repeat it.
    expect(await notifyRunEnded(input(env, sys))).toBeNull();
    expect(sys.execCalls).toHaveLength(1);
    expect(sys.fetchCalls).toHaveLength(1);
  });

  it('a run that blocks again after a resume is a new notification', async () => {
    const env = world();
    setState(env, 'BLOCKED', 'first block', 1);
    const sys = fakeSystem({ env: ENV });
    expect(await notifyRunEnded(input(env, sys, { config: notifyConfig() }))).not.toBeNull();
    setState(env, 'BLOCKED', 'second block', 2);
    expect(await notifyRunEnded(input(env, sys, { config: notifyConfig() }))).not.toBeNull();
    expect(sys.execCalls).toHaveLength(2);
  });

  it('delivery failures are recorded and never thrown', async () => {
    const env = world();
    setState(env, 'EXHAUSTED', 'budget spent', 5);
    const sys = fakeSystem({ env: ENV, fetchStatus: 503, exec: () => ({ exitCode: 1, notFound: false, stderr: 'no session' }) });
    sys.threads.failNext('createComment', 'AUTH_EXPIRED');
    const out = await notifyRunEnded(input(env, sys, { config: allChannels(9) }));
    expect(out!.map((o) => o.status)).toEqual(['failed', 'failed', 'failed']);
    expect(events(env, 'notification.failed').map((e) => [e.channel, e.detail])).toEqual([
      ['desktop', 'osascript exited 1: no session'],
      ['webhook', 'hooks.acme.test answered 503'],
      ['github_comment', expect.stringMatching(/^AUTH_EXPIRED/)],
    ]);
  });

  it('a channel that throws outright is a failed delivery, not a failed run', async () => {
    const env = world();
    setState(env, 'CANCELLED', 'cancelled by request', 5);
    const sys = fakeSystem();
    sys.deps.threads = async () => {
      throw new Error('remote not readable');
    };
    const out = await notifyRunEnded(input(env, sys, { config: allChannels(9) }));
    expect(out!.find((o) => o.channel === 'github_comment')).toEqual({ channel: 'github_comment', status: 'failed', detail: 'remote not readable' });
  });

  it('names the open questions, so they are not announced again on their own', async () => {
    const env = world();
    const q = addQuestion(env);
    setState(env, 'BLOCKED', `open questions: ${q.id}`, 5);
    const sys = fakeSystem();
    await notifyRunEnded(input(env, sys, { config: notifyConfig() }));
    expect(events(env, 'notification.dispatched')[0]).toMatchObject({ questions: [q.id] });
    expect(await notifyOpenQuestions(input(env, sys, { config: notifyConfig() }))).toBeNull();
    expect(sys.execCalls).toHaveLength(1);
  });

  it('a policy that no longer verifies chooses nothing: only the default channel (desktop) is used', async () => {
    const env = world();
    setState(env, 'BLOCKED', 'POLICY_TAMPERED: hash mismatch', 5);
    const sys = fakeSystem({ env: ENV });
    const out = await notifyRunEnded(input(env, sys, { config: null }));
    expect(out!.map((o) => [o.channel, o.status])).toEqual([
      ['desktop', 'sent'],
      ['webhook', 'skipped'],
      ['github_comment', 'skipped'],
    ]);
    expect(sys.fetchCalls).toEqual([]);
  });

  it('ORBIT_NOTIFICATIONS=off sends nothing and records nothing', async () => {
    const env = world();
    setState(env, 'SUCCEEDED', 'ok', 5);
    const sys = fakeSystem({ env: { ...ENV, ORBIT_NOTIFICATIONS: 'off' } });
    expect(await notifyRunEnded(input(env, sys))).toBeNull();
    expect(sys.execCalls).toEqual([]);
    expect(sys.fetchCalls).toEqual([]);
    expect(events(env, 'notification.dispatched')).toEqual([]);
  });

  it('does nothing for a run that has not ended', async () => {
    const env = world();
    const sys = fakeSystem();
    expect(await notifyRunEnded(input(env, sys))).toBeNull();
  });
});

describe('notifying open questions', () => {
  it('announces each open question once, with how to answer it remotely when that is on', async () => {
    const env = world();
    setState(env, 'PLANNING');
    const q = addQuestion(env);
    const sys = fakeSystem();
    const out = await notifyOpenQuestions(input(env, sys, { config: allChannels(7) }));
    expect(out!.find((o) => o.channel === 'github_comment')).toEqual({ channel: 'github_comment', status: 'sent', detail: 'issue #7' });
    const body = sys.threads.comments(7)[0]!.body;
    expect(body).toContain(q.id);
    expect(body).toContain(`/orbit answer ${q.id} <choice>`);
    expect(events(env, 'notification.dispatched')).toEqual([expect.objectContaining({ kind: 'question.open', key: `question:${q.id}`, questions: [q.id] })]);
    expect(await notifyOpenQuestions(input(env, sys, { config: allChannels(7) }))).toBeNull();

    // A new question later is new; an answered one is not announced.
    const q2 = addQuestion(env);
    const q3 = addQuestion(env);
    answerQuestion(env.db, env.runDir, q3.id, 'A', 'acme', env.clock);
    await notifyOpenQuestions(input(env, sys, { config: allChannels(7) }));
    expect(events(env, 'notification.dispatched').at(-1)).toMatchObject({ questions: [q2.id] });
  });
});

describe('resolving the collaborators', () => {
  it('reads the kill switch from the process environment too, so a test suite can turn every channel off', () => {
    const saved = process.env.ORBIT_NOTIFICATIONS;
    process.env.ORBIT_NOTIFICATIONS = 'off';
    try {
      expect(resolveNotifyDeps({ hostEnv: { PATH: '/bin' } }).env.ORBIT_NOTIFICATIONS).toBe('off');
      expect(resolveNotifyDeps({ hostEnv: { PATH: '/bin' }, notify: { env: { PATH: '/bin' } } }).env.ORBIT_NOTIFICATIONS).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env.ORBIT_NOTIFICATIONS;
      else process.env.ORBIT_NOTIFICATIONS = saved;
    }
    expect(resolveNotifyDeps({}).platform).toBe(process.platform);
  });
});

describe('orbit notify test', () => {
  it('sends a test payload through the configured channels without a run', async () => {
    const sys = fakeSystem({ env: ENV });
    const out = await sendTestNotification({ config: allChannels(7), repoRoot: '/repo/acme', deps: sys.deps });
    expect(out.map((o) => [o.channel, o.status])).toEqual([
      ['desktop', 'sent'],
      ['webhook', 'sent'],
      ['github_comment', 'sent'],
    ]);
    expect(JSON.parse(sys.fetchCalls[0]!.body).orbit).toMatchObject({ kind: 'test', run_id: null });
    expect(sys.threads.comments(7)[0]!.body).toContain('Orbit test notification');
  });

  it('reports every channel as skipped when the kill switch is set', async () => {
    const sys = fakeSystem({ env: { ORBIT_NOTIFICATIONS: 'off' } });
    const out = await sendTestNotification({ config: allChannels(7), repoRoot: '/repo/acme', deps: sys.deps });
    expect(out).toEqual([
      { channel: 'desktop', status: 'skipped', detail: 'ORBIT_NOTIFICATIONS=off' },
      { channel: 'webhook', status: 'skipped', detail: 'ORBIT_NOTIFICATIONS=off' },
      { channel: 'github_comment', status: 'skipped', detail: 'ORBIT_NOTIFICATIONS=off' },
    ]);
  });
});
