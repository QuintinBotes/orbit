/**
 * When Orbit notifies, and how it remembers that it did (ADR 0008). A run that ends, and a run that raises a
 * question a person must answer, is announced once through the channels its frozen policy names. Each notification
 * has a key, recorded in a `notification.dispatched` event before anything is sent, so a restarted controller never
 * repeats it; every channel outcome is an event of its own. Nothing here throws into the caller: a notification
 * that cannot be delivered never changes the run.
 */
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { readJsonIfExists } from '../core/fsx.ts';
import { createdBranch, currentCandidateRef } from '../controller/run-refs.ts';
import type { RunRecord } from '../controller/run-store.ts';
import { TERMINAL_STATES } from '../core/run-states.ts';
import { listQuestions } from '../inquisition/store.ts';
import { defaultNotifications, notificationsPolicy } from '../policy/config.ts';
import type { NotificationsConfig, OrbitConfig } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { defaultNotifyDeps, notificationsOff, sendDesktop, sendGithubComment, sendWebhook, type ChannelOutcome, type CommentTarget, type NotifyDeps } from './channels.ts';
import { buildPayload, testPayload, type NotificationKind, type NotificationPayload } from './payload.ts';
import { answerThreads, commentTargets } from './remote-answers.ts';

export interface RunNotifyInput {
  db: OrbitDb;
  clock: Clock;
  run: RunRecord;
  runDir: string;
  /** The run's verified policy; null when it no longer verifies, which leaves only the default channels. */
  config: OrbitConfig | null;
  deps: NotifyDeps;
  /** Who records the events. */
  actor: string;
}

/**
 * The collaborators for a controller or command: the given ones, else the real machine. The kill switch is read from
 * the process environment as well as the controller's, so a test suite (or CI) that sets it turns every channel off.
 */
export function resolveNotifyDeps(d: { hostEnv?: Readonly<Record<string, string | undefined>>; notify?: Partial<NotifyDeps> }): NotifyDeps {
  const env = d.notify?.env ?? { ...process.env, ...(d.hostEnv ?? {}) };
  return { ...defaultNotifyDeps(env), ...(d.notify ?? {}), env };
}

const DISPATCHED = 'notification.dispatched';

interface Dispatched {
  key: string;
  questions: string[];
}

function dispatched(db: OrbitDb, runId: string): Dispatched[] {
  return db.all<{ data_json: string | null }>('SELECT data_json FROM events WHERE run_id = ? AND type = ?', runId, DISPATCHED).flatMap((r) => {
    try {
      const d = JSON.parse(r.data_json ?? '{}') as { key?: unknown; questions?: unknown };
      return typeof d.key === 'string' ? [{ key: d.key, questions: Array.isArray(d.questions) ? d.questions.filter((q): q is string => typeof q === 'string') : [] }] : [];
    } catch {
      return [];
    }
  });
}

function pullRequestOf(runDir: string): number | null {
  const pr = readJsonIfExists<{ pr?: { number?: unknown } | null }>(join(runDir, 'delivery.json'))?.pr?.number;
  return typeof pr === 'number' && Number.isInteger(pr) && pr > 0 ? pr : null;
}

function where(t: CommentTarget): string {
  return `${t.kind} #${t.number}`;
}

/** Send through every channel the settings turn on; channels that are off are reported as skipped. */
async function sendAll(p: NotificationPayload, n: NotificationsConfig, config: OrbitConfig | null, target: CommentTarget | null, repoRoot: string, deps: NotifyDeps): Promise<ChannelOutcome[]> {
  const off = (channel: ChannelOutcome['channel']): ChannelOutcome => ({ channel, status: 'skipped', detail: `notifications.${channel} is off` });
  return Promise.all([
    n.desktop ? sendDesktop(p, deps) : off('desktop'),
    n.webhook && config ? sendWebhook(p, config, deps) : off('webhook'),
    n.github_comment && config ? sendGithubComment(p, target, () => deps.threads(repoRoot, config)) : off('github_comment'),
  ]);
}

async function dispatch(input: RunNotifyInput, kind: Exclude<NotificationKind, 'test'>, key: string, questionIds: string[]): Promise<ChannelOutcome[] | null> {
  const { db, clock, run, runDir, config, deps, actor } = input;
  if (notificationsOff(deps.env)) return null;
  if (dispatched(db, run.id).some((d) => d.key === key)) return null;
  const n = config ? notificationsPolicy(config) : defaultNotifications();
  const pr = pullRequestOf(runDir);
  const targets = config ? commentTargets(runDir, config) : [];
  const answerable = config && questionIds.length > 0 ? answerThreads(runDir, config) : [];
  const refs = { branch: createdBranch(db, run), candidateRef: currentCandidateRef(db, run.id) };
  const payload = buildPayload({ kind, run, refs, questionIds, pullRequest: pr, remote: answerable[0] ? { where: where(answerable[0]) } : null });
  // Recorded before sending: a crash mid-send loses this notification rather than repeating it.
  db.tx(() => appendEvent(db, run.id, DISPATCHED, actor, { key, kind, state: run.state, questions: questionIds }, clock.now()));
  const outcomes = await sendAll(payload, n, config, targets[0] ?? null, run.repoRoot, deps);
  db.tx(() => {
    for (const o of outcomes) appendEvent(db, run.id, `notification.${o.status}`, actor, { key, channel: o.channel, detail: o.detail }, clock.now());
  });
  return outcomes;
}

/** A run reached a terminal state: announce it once, with the questions a BLOCKED run is waiting on. */
export async function notifyRunEnded(input: RunNotifyInput): Promise<ChannelOutcome[] | null> {
  const { run } = input;
  if (!TERMINAL_STATES.has(run.state)) return null;
  const questions = run.state === 'BLOCKED' ? listQuestions(input.db, run.id, { status: 'open' }).map((q) => q.id) : [];
  return dispatch(input, 'run.ended', `ended:${run.state}:${run.endedAt ?? 0}`, questions);
}

/** Open questions no notification has named yet, announced once; a run that has ended (other than BLOCKED) asks nothing. */
export async function notifyOpenQuestions(input: RunNotifyInput): Promise<ChannelOutcome[] | null> {
  const { db, run } = input;
  if (TERMINAL_STATES.has(run.state) && run.state !== 'BLOCKED') return null;
  const named = new Set(dispatched(db, run.id).flatMap((d) => d.questions));
  const fresh = listQuestions(db, run.id, { status: 'open' })
    .map((q) => q.id)
    .filter((id) => !named.has(id));
  if (fresh.length === 0) return null;
  return dispatch(input, 'question.open', `question:${fresh.join(',')}`, fresh);
}

/** `orbit notify test`: a test payload through the configured channels, with no run and no events. */
export async function sendTestNotification(input: { config: OrbitConfig; repoRoot: string; deps: NotifyDeps }): Promise<ChannelOutcome[]> {
  const { config, repoRoot, deps } = input;
  if (notificationsOff(deps.env)) return (['desktop', 'webhook', 'github_comment'] as const).map((channel) => ({ channel, status: 'skipped', detail: 'ORBIT_NOTIFICATIONS=off' }));
  const n = notificationsPolicy(config);
  const issue = n.remote_answers.issue;
  return sendAll(testPayload(), n, config, issue !== null ? { number: issue, kind: 'issue' } : null, repoRoot, deps);
}
