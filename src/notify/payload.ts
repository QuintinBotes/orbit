/**
 * What a notification says (ADR 0008). The payload is fixed and small: the run id, its state, a reason, the next
 * action and the open question ids. It leaves the machine (a chat service, a desktop notification centre, a public
 * pull request), so it never carries code, diffs, secrets or log excerpts: the reason is the first line of the
 * outcome reason, cut before anything that looks like code, passed through the redactor and capped; the next action
 * comes from a fixed template per state, never from model prose.
 */
import { redact } from '../core/redact.ts';
import { frozenPolicySetting } from '../controller/resume.ts';
import type { RunRecord } from '../controller/run-store.ts';

export const PAYLOAD_SCHEMA = 'orbit.notification/1';
export const REASON_MAX = 160;
/** Starts every comment Orbit posts, so the remote-answer reader never takes Orbit's own text for a command. */
export const COMMENT_MARKER = '<!-- orbit:notification -->';

export type NotificationKind = 'run.ended' | 'question.open' | 'test';

export interface NotificationPayload {
  schema: typeof PAYLOAD_SCHEMA;
  kind: NotificationKind;
  run_id: string | null;
  state: string | null;
  reason: string | null;
  next_action: string;
  question_ids: string[];
}

export interface PayloadInput {
  kind: Exclude<NotificationKind, 'test'>;
  run: Pick<RunRecord, 'id' | 'state' | 'outcomeReason' | 'branch' | 'mode'> & Partial<Pick<RunRecord, 'outcomeJson'>>;
  questionIds: readonly string[];
  /** The run's pull request, when delivery opened one. */
  pullRequest: number | null;
  /** Where a person may answer with a comment ("pull request #3", "issue #7"), when remote answers are on. */
  remote: { where: string } | null;
}

/** Markers of code, diffs and stack traces: the reason is cut at the first one. */
const CODE_MARKERS: readonly RegExp[] = [/```/, /`[^`]*[;{}()=][^`]*`/, /\bdiff --git\b/, /@@ -\d/, /^\s*[+-]{1,3}\s/, /\n/, /\bat \S+ \(/, /\bTraceback\b/];

/** The first line of a reason, cut before anything that looks like code, redacted and capped; null when nothing is left. */
export function sanitizeReason(text: string | null | undefined): string | null {
  if (text === null || text === undefined) return null;
  let s = text.replace(/\r/g, '');
  for (const re of CODE_MARKERS) {
    const m = re.exec(s);
    if (m) s = s.slice(0, m.index);
  }
  s = redact(s).replace(/\s+/g, ' ').trim().replace(/[\s:;,]+$/, '');
  if (s === '') return null;
  return s.length > REASON_MAX ? s.slice(0, REASON_MAX) : s;
}

function nextAction(input: PayloadInput): string {
  const { run, questionIds, pullRequest, remote } = input;
  const [first] = questionIds;
  if (first !== undefined) {
    const local = `Answer with orbit decide ${run.id} ${first} <answer>`;
    return remote ? `${local}, or comment "/orbit answer ${first} <choice>" on ${remote.where}.` : `${local}, then run orbit resume ${run.id}.`;
  }
  switch (run.state) {
    case 'SUCCEEDED':
      return pullRequest !== null ? `Review pull request #${pullRequest} and merge it if you accept it.` : `Inspect branch ${run.branch ?? `orbit/${run.id}`} and merge it yourself if you accept it.`;
    case 'BLOCKED':
      // A block from the frozen policy is not cleared by resuming: the report names the way forward (a new run).
      if (frozenPolicySetting({ outcomeJson: run.outcomeJson ?? null }) !== null) return `Read orbit report ${run.id}; this block comes from the run's frozen policy, so resuming alone would only block again.`;
      return `Resolve the block, then run orbit resume ${run.id}.`;
    case 'EXHAUSTED':
      return `Read orbit report ${run.id}, then continue by hand or start a new run.`;
    case 'IMPOSSIBLE':
      return `Read orbit report ${run.id}; revise the goal or the authorization before trying again.`;
    case 'CANCELLED':
      return 'Nothing further: the run was cancelled.';
    default:
      return `Follow it with orbit status ${run.id}.`;
  }
}

export function buildPayload(input: PayloadInput): NotificationPayload {
  return {
    schema: PAYLOAD_SCHEMA,
    kind: input.kind,
    run_id: input.run.id,
    state: input.run.state,
    reason: input.kind === 'question.open' ? 'a question needs your answer' : sanitizeReason(input.run.outcomeReason),
    next_action: nextAction(input),
    question_ids: [...input.questionIds],
  };
}

export function testPayload(): NotificationPayload {
  return { schema: PAYLOAD_SCHEMA, kind: 'test', run_id: null, state: null, reason: null, next_action: 'Nothing: this is a test.', question_ids: [] };
}

/** A short title for a desktop notification. */
export function payloadTitle(p: NotificationPayload): string {
  return p.run_id === null ? 'Orbit' : `Orbit: run ${p.run_id} ${p.kind === 'question.open' ? 'has a question' : (p.state ?? '')}`.trim();
}

/** The whole message as one short text: the webhook's `text` field and the desktop body. */
export function payloadText(p: NotificationPayload): string {
  if (p.kind === 'test') return 'Orbit test notification: notifications reach you here.';
  const reason = p.reason ? `: ${p.reason.replace(/[.!?]+$/, '')}` : '';
  const head = p.kind === 'question.open' ? `Orbit run ${p.run_id} (${p.state}) has a question for you` : `Orbit run ${p.run_id} is ${p.state}${reason}`;
  const questions = p.question_ids.length > 0 ? ` Open questions: ${p.question_ids.join(', ')}.` : '';
  return `${head}. ${p.next_action}${questions}`;
}

/** The comment Orbit posts on a pull request or issue: the marker first, and no line that starts with a command. */
export function commentBody(p: NotificationPayload): string {
  const lines = [COMMENT_MARKER, `**${payloadText(p)}**`];
  if (p.question_ids.length > 0) {
    lines.push('', `Questions: ${p.question_ids.map((q) => `\`${q}\``).join(', ')}. Details: \`orbit questions ${p.run_id}\`.`);
  }
  return lines.join('\n');
}
