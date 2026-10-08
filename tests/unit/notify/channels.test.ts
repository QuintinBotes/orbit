import { afterEach, describe, expect, it } from 'vitest';
import { notificationsOff, sendDesktop, sendGithubComment, sendWebhook } from '../../../src/notify/channels.ts';
import { buildPayload, COMMENT_MARKER, testPayload } from '../../../src/notify/payload.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { fakeSystem, notifyConfig } from './helpers.ts';

const HOOK = 'https://hooks.acme.test/services/T000/B000/XXXXXXXXXXXXXXXX';
const payload = buildPayload({ kind: 'run.ended', run: { id: 'orb-1', state: 'SUCCEEDED', outcomeReason: 'all criteria supported', mode: 'autonomous' }, questionIds: [], pullRequest: null, remote: null, refs: { branch: 'orbit/orb-1', candidateRef: null } });

const webhookConfig = (hosts: string[] = ['hooks.acme.test']) =>
  notifyConfig((c) => {
    c.notifications = { ...c.notifications!, webhook: { url_env: 'ACME_WEBHOOK_URL' } };
    c.network.allowed_hosts = hosts;
  });

describe('desktop channel', () => {
  it('macOS: osascript gets the text as arguments of an "on run argv" script, never inside the script', async () => {
    const sys = fakeSystem({ platform: 'darwin' });
    const out = await sendDesktop({ ...payload, reason: 'say "hi" & do shell script "rm -rf ~"' }, sys.deps);
    expect(out).toEqual({ channel: 'desktop', status: 'sent', detail: 'osascript' });
    const argv = sys.execCalls[0]!;
    expect(argv[0]).toBe('osascript');
    const script = argv.slice(0, argv.indexOf('--')).join(' ');
    expect(script).toContain('on run argv');
    expect(script).not.toContain('rm -rf');
    expect(argv.slice(argv.indexOf('--') + 1).join(' ')).toContain('rm -rf');
  });

  it('Linux: notify-send with the title and body as separate arguments after --', async () => {
    const sys = fakeSystem({ platform: 'linux' });
    const out = await sendDesktop(payload, sys.deps);
    expect(out.status).toBe('sent');
    expect(sys.execCalls[0]!.slice(0, 4)).toEqual(['notify-send', '--app-name=Orbit', '--', 'Orbit: run orb-1 SUCCEEDED']);
  });

  it('is skipped silently when the program is missing or the platform has none', async () => {
    const missing = fakeSystem({ platform: 'linux', exec: () => ({ exitCode: null, notFound: true, stderr: '' }) });
    expect(await sendDesktop(payload, missing.deps)).toEqual({ channel: 'desktop', status: 'skipped', detail: 'notify-send is not available' });
    const win = fakeSystem({ platform: 'win32' });
    expect(await sendDesktop(payload, win.deps)).toEqual({ channel: 'desktop', status: 'skipped', detail: 'no desktop notifier on win32' });
    expect(win.execCalls).toEqual([]);
  });

  it('a notifier that fails is reported, not thrown', async () => {
    const sys = fakeSystem({ platform: 'darwin', exec: () => ({ exitCode: 1, notFound: false, stderr: 'execution error' }) });
    expect(await sendDesktop(payload, sys.deps)).toEqual({ channel: 'desktop', status: 'failed', detail: 'osascript exited 1: execution error' });
    const thrower = fakeSystem({ platform: 'darwin', exec: () => { throw new Error('spawn EACCES'); } });
    expect(await sendDesktop(payload, thrower.deps)).toMatchObject({ status: 'failed', detail: 'spawn EACCES' });
  });
});

describe('webhook channel', () => {
  it('posts the payload with a Slack-compatible text field to the URL from the named variable', async () => {
    const sys = fakeSystem({ env: { ACME_WEBHOOK_URL: HOOK } });
    const out = await sendWebhook(payload, webhookConfig(), sys.deps);
    expect(out).toEqual({ channel: 'webhook', status: 'sent', detail: 'hooks.acme.test answered 200' });
    const call = sys.fetchCalls[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.redirect).toBe('error');
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(call.body) as { text: string; orbit: unknown };
    expect(body.text).toContain('Orbit run orb-1 is SUCCEEDED');
    expect(body.orbit).toEqual(payload);
    // The URL is a secret of its own: no outcome detail names more than its host.
    expect(JSON.stringify(out)).not.toContain('XXXXXXXX');
  });

  it('is off without a webhook setting, and skipped when the variable is unset', async () => {
    const sys = fakeSystem();
    expect(await sendWebhook(payload, notifyConfig(), sys.deps)).toEqual({ channel: 'webhook', status: 'skipped', detail: 'notifications.webhook is off' });
    expect(await sendWebhook(payload, webhookConfig(), sys.deps)).toEqual({ channel: 'webhook', status: 'skipped', detail: 'ACME_WEBHOOK_URL is not set' });
    expect(sys.fetchCalls).toEqual([]);
  });

  it('refuses a host outside network.allowed_hosts, plain http to a remote host, and a value that is not a URL', async () => {
    const outside = fakeSystem({ env: { ACME_WEBHOOK_URL: 'https://collector.example.org/x' } });
    expect(await sendWebhook(payload, webhookConfig(), outside.deps)).toEqual({ channel: 'webhook', status: 'failed', detail: 'collector.example.org is not in network.allowed_hosts' });
    const http = fakeSystem({ env: { ACME_WEBHOOK_URL: 'http://hooks.acme.test/x' } });
    expect(await sendWebhook(payload, webhookConfig(), http.deps)).toEqual({ channel: 'webhook', status: 'failed', detail: 'the webhook URL must use https (plain http only to a loopback host)' });
    const junk = fakeSystem({ env: { ACME_WEBHOOK_URL: 'not a url' } });
    expect(await sendWebhook(payload, webhookConfig(), junk.deps)).toEqual({ channel: 'webhook', status: 'failed', detail: 'ACME_WEBHOOK_URL does not hold a valid URL' });
    for (const s of [outside, http, junk]) expect(s.fetchCalls).toEqual([]);
  });

  it('allows plain http to a loopback host that the allowlist covers', async () => {
    const sys = fakeSystem({ env: { ACME_WEBHOOK_URL: 'http://127.0.0.1:8080/hook' } });
    expect(await sendWebhook(payload, webhookConfig(['127.0.0.1']), sys.deps)).toMatchObject({ status: 'sent' });
  });

  it('a non-2xx answer or a network error is a failed delivery, never thrown', async () => {
    const bad = fakeSystem({ env: { ACME_WEBHOOK_URL: HOOK }, fetchStatus: 500 });
    expect(await sendWebhook(payload, webhookConfig(), bad.deps)).toEqual({ channel: 'webhook', status: 'failed', detail: 'hooks.acme.test answered 500' });
    const down = fakeSystem({ env: { ACME_WEBHOOK_URL: HOOK }, fetchError: new Error(`connect ECONNREFUSED for ${HOOK}`) });
    const out = await sendWebhook(payload, webhookConfig(), down.deps);
    expect(out.status).toBe('failed');
    expect(out.detail).not.toContain('XXXXXXXX');
  });
});

describe('GitHub comment channel', () => {
  it('comments on the target with the Orbit marker', async () => {
    const sys = fakeSystem();
    const out = await sendGithubComment(payload, { number: 12, kind: 'pull request' }, () => sys.deps.threads('/repo', notifyConfig()));
    expect(out).toEqual({ channel: 'github_comment', status: 'sent', detail: 'pull request #12' });
    const [posted] = sys.threads.comments(12);
    expect(posted!.body.startsWith(COMMENT_MARKER)).toBe(true);
    expect(posted!.body).toContain('orb-1');
  });

  it('is skipped without a pull request or a linked issue, and a client error is a failed delivery', async () => {
    const sys = fakeSystem();
    expect(await sendGithubComment(testPayload(), null, () => sys.deps.threads('/repo', notifyConfig()))).toEqual({ channel: 'github_comment', status: 'skipped', detail: 'the run has no pull request and no linked issue' });
    const out = await sendGithubComment(payload, { number: 3, kind: 'issue' }, async () => {
      throw new OrbitError('AUTH_MISSING', 'no GH_TOKEN in the controller environment');
    });
    expect(out).toEqual({ channel: 'github_comment', status: 'failed', detail: 'AUTH_MISSING: no GH_TOKEN in the controller environment' });
  });
});

describe('the kill switch', () => {
  const saved = process.env.ORBIT_NOTIFICATIONS;
  afterEach(() => {
    if (saved === undefined) delete process.env.ORBIT_NOTIFICATIONS;
    else process.env.ORBIT_NOTIFICATIONS = saved;
  });

  it('ORBIT_NOTIFICATIONS=off in the given environment turns notifications off', () => {
    delete process.env.ORBIT_NOTIFICATIONS;
    expect(notificationsOff({ ORBIT_NOTIFICATIONS: 'off' })).toBe(true);
    expect(notificationsOff({ ORBIT_NOTIFICATIONS: 'OFF' })).toBe(true);
    expect(notificationsOff({})).toBe(false);
    expect(notificationsOff({ ORBIT_NOTIFICATIONS: 'on' })).toBe(false);
  });
});
