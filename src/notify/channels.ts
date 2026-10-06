/**
 * The notification channels (ADR 0008): desktop, webhook and a GitHub comment. Each one answers with an outcome
 * (sent, skipped or failed) and never throws: a notification that cannot be delivered is recorded, it never fails a
 * run. Everything that touches the machine or the network is behind `NotifyDeps`, so tests use fakes.
 */
import { join } from 'node:path';
import { OrbitError, isOrbitError } from '../core/errors.ts';
import { execCapture } from '../core/exec.ts';
import { redact } from '../core/redact.ts';
import { resolveRemoteUrl } from '../delivery/git.ts';
import { notificationsPolicy } from '../policy/config.ts';
import { hostAllowed } from '../policy/hosts.ts';
import type { OrbitConfig } from '../policy/types.ts';
import { commentBody, payloadText, payloadTitle, type NotificationPayload } from './payload.ts';
import { FakeThreadClient, GhThreadClient, type ThreadClient } from './threads.ts';

export type ChannelName = 'desktop' | 'webhook' | 'github_comment';
export const CHANNELS: readonly ChannelName[] = ['desktop', 'webhook', 'github_comment'];

export interface ChannelOutcome {
  channel: ChannelName;
  status: 'sent' | 'skipped' | 'failed';
  /** One line for the event and the terminal; never the webhook URL, a token or the payload text. */
  detail: string;
}

export interface ExecOutcome {
  exitCode: number | null;
  /** The program does not exist on this machine. */
  notFound: boolean;
  stderr: string;
}

export type NotifyExec = (argv: string[], timeoutMs: number) => Promise<ExecOutcome>;

export type NotifyFetch = (url: string, init: { method: 'POST'; headers: Record<string, string>; body: string; redirect: 'error'; signal: AbortSignal }) => Promise<{ status: number; ok: boolean }>;

export interface NotifyDeps {
  /** Where `notifications.webhook.url_env`, GH_TOKEN and the ORBIT_NOTIFICATIONS kill switch are read. */
  env: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  exec: NotifyExec;
  fetch: NotifyFetch;
  /** The comment client for a repository under a policy. */
  threads: (repoRoot: string, config: OrbitConfig) => Promise<ThreadClient>;
}

export const DESKTOP_TIMEOUT_MS = 10_000;
export const WEBHOOK_TIMEOUT_MS = 10_000;
/** The fake delivery provider's comment threads live beside its pull requests. */
export const FAKE_THREADS_FILE = 'fake-github-threads.json';

/** ORBIT_NOTIFICATIONS=off turns every channel off (CI, test suites). */
export function notificationsOff(env: Readonly<Record<string, string | undefined>>): boolean {
  return (env.ORBIT_NOTIFICATIONS ?? '').trim().toLowerCase() === 'off';
}

const defaultExec: NotifyExec = async (argv, timeoutMs) => {
  try {
    const r = await execCapture(argv, { timeoutMs, maxOutputBytes: 64 * 1024 });
    return { exitCode: r.timedOut ? null : r.exitCode, notFound: false, stderr: r.timedOut ? `timed out after ${timeoutMs} ms` : r.stderr };
  } catch (err) {
    if (isOrbitError(err, 'NOT_FOUND')) return { exitCode: null, notFound: true, stderr: '' };
    throw err;
  }
};

const defaultFetch: NotifyFetch = async (url, init) => {
  const r = await fetch(url, init);
  // The answer body is not read: it is the receiver's, and nothing in it changes what Orbit does.
  await r.body?.cancel().catch(() => {});
  return { status: r.status, ok: r.ok };
};

/** The comment client a policy selects: the file-backed fake for the fake delivery provider, else gh with GH_TOKEN. */
export function defaultThreads(env: Readonly<Record<string, string | undefined>>): NotifyDeps['threads'] {
  return async (repoRoot, config) => {
    if (config.delivery.provider === 'fake') return new FakeThreadClient({ statePath: join(repoRoot, '.orbit', FAKE_THREADS_FILE) });
    const url = await resolveRemoteUrl(repoRoot, config.repository.remote);
    const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url);
    if (!m) throw new OrbitError('CONFIG_INVALID', `remote ${config.repository.remote} is not a GitHub repository`);
    return new GhThreadClient({ repo: `${m[1]}/${m[2]}`, env, cwd: repoRoot });
  };
}

export function defaultNotifyDeps(env: Readonly<Record<string, string | undefined>> = process.env): NotifyDeps {
  return { env, platform: process.platform, exec: defaultExec, fetch: defaultFetch, threads: defaultThreads(env) };
}

function messageOf(err: unknown): string {
  const text = isOrbitError(err) ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
  return redact(text).replace(/\s+/g, ' ').slice(0, 300);
}

// ---------------------------------------------------------------------------
// desktop

/**
 * The text reaches osascript as arguments of an `on run argv` script, never inside the script, so nothing in a
 * reason can become AppleScript.
 */
const OSASCRIPT = ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run'];

export async function sendDesktop(p: NotificationPayload, deps: Pick<NotifyDeps, 'platform' | 'exec'>): Promise<ChannelOutcome> {
  const title = payloadTitle(p);
  const body = payloadText(p);
  let argv: string[];
  if (deps.platform === 'darwin') argv = ['osascript', ...OSASCRIPT, '--', title, body];
  else if (deps.platform === 'linux') argv = ['notify-send', '--app-name=Orbit', '--', title, body];
  else return { channel: 'desktop', status: 'skipped', detail: `no desktop notifier on ${deps.platform}` };
  const program = argv[0]!;
  try {
    const r = await deps.exec(argv, DESKTOP_TIMEOUT_MS);
    if (r.notFound) return { channel: 'desktop', status: 'skipped', detail: `${program} is not available` };
    if (r.exitCode !== 0) return { channel: 'desktop', status: 'failed', detail: `${program} exited ${r.exitCode ?? 'by signal'}: ${redact(r.stderr).trim().slice(0, 200)}`.trim() };
    return { channel: 'desktop', status: 'sent', detail: program };
  } catch (err) {
    return { channel: 'desktop', status: 'failed', detail: messageOf(err) };
  }
}

// ---------------------------------------------------------------------------
// webhook

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export async function sendWebhook(p: NotificationPayload, config: OrbitConfig, deps: Pick<NotifyDeps, 'env' | 'fetch'>): Promise<ChannelOutcome> {
  const hook = notificationsPolicy(config).webhook;
  if (!hook) return { channel: 'webhook', status: 'skipped', detail: 'notifications.webhook is off' };
  const raw = deps.env[hook.url_env];
  if (!raw) return { channel: 'webhook', status: 'skipped', detail: `${hook.url_env} is not set` };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { channel: 'webhook', status: 'failed', detail: `${hook.url_env} does not hold a valid URL` };
  }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.has(host))) {
    return { channel: 'webhook', status: 'failed', detail: 'the webhook URL must use https (plain http only to a loopback host)' };
  }
  if (!hostAllowed(host, config.network.allowed_hosts)) return { channel: 'webhook', status: 'failed', detail: `${host} is not in network.allowed_hosts` };
  try {
    const r = await deps.fetch(url.toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'orbit-notify' },
      body: JSON.stringify({ text: payloadText(p), orbit: p }),
      // A redirect could take the payload to a host the allowlist never saw.
      redirect: 'error',
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    return { channel: 'webhook', status: r.ok ? 'sent' : 'failed', detail: `${host} answered ${r.status}` };
  } catch (err) {
    // A fetch error can quote the URL, whose path is the webhook's secret: report the host only.
    const name = err instanceof Error ? err.name : 'Error';
    return { channel: 'webhook', status: 'failed', detail: `${host} could not be reached (${name})` };
  }
}

// ---------------------------------------------------------------------------
// GitHub comment

export interface CommentTarget {
  number: number;
  kind: 'pull request' | 'issue';
}

export async function sendGithubComment(p: NotificationPayload, target: CommentTarget | null, client: () => Promise<ThreadClient>): Promise<ChannelOutcome> {
  if (!target) return { channel: 'github_comment', status: 'skipped', detail: 'the run has no pull request and no linked issue' };
  try {
    await (await client()).createComment(target.number, commentBody(p));
    return { channel: 'github_comment', status: 'sent', detail: `${target.kind} #${target.number}` };
  } catch (err) {
    return { channel: 'github_comment', status: 'failed', detail: messageOf(err) };
  }
}
