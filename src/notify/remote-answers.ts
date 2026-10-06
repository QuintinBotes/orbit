/**
 * Remote answers (ADR 0008): a person answers an open question of a BLOCKED run with a comment on the run's pull
 * request, or on the issue the policy links to its runs, whose line starts with `/orbit answer <question-id> <choice>`.
 *
 * This is a security boundary. An answer authorizes (it can approve a contract amendment or a baseline exception),
 * so a comment counts only when GitHub itself says, at the time Orbit reads the comment, that its author has admin,
 * maintain or write permission on the repository. Nothing in the comment text counts. The question must be a question
 * of this run and still open, and the choice must be one of its options (or free text where the question allows it).
 * Everything else is ignored and recorded. An accepted answer goes through the same path as `orbit decide`, with
 * the comment's provenance in the decision.
 */
import { readJsonIfExists } from '../core/fsx.ts';
import { isOrbitError } from '../core/errors.ts';
import { redact } from '../core/redact.ts';
import type { Clock } from '../core/clock.ts';
import type { RunRecord } from '../controller/run-store.ts';
import { amendmentIdOfQuestion, applyAmendmentAnswers } from '../inquisition/amendment-answers.ts';
import { answerQuestion } from '../inquisition/questions.ts';
import { findQuestion, listQuestions, type QuestionRecord } from '../inquisition/store.ts';
import { notificationsPolicy } from '../policy/config.ts';
import type { OrbitConfig } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { join } from 'node:path';
import type { CommentTarget } from './channels.ts';
import { COMMENT_MARKER } from './payload.ts';
import { ANSWERING_ROLES, type ThreadClient, type ThreadComment } from './threads.ts';

export interface AnswerCommand {
  questionId: string;
  choice: string;
}

const COMMAND = /^\s*\/orbit\s+answer\s+([A-Za-z0-9][A-Za-z0-9_-]{0,127})\s+(\S.*?)\s*$/;
export const MAX_CHOICE_CHARS = 2000;

/** The `/orbit answer` commands of a comment: one per line that starts with one. Orbit's own comments have none. */
export function parseAnswerCommands(body: string): AnswerCommand[] {
  if (body.includes(COMMENT_MARKER)) return [];
  const out: AnswerCommand[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = COMMAND.exec(line);
    if (m) out.push({ questionId: m[1]!, choice: m[2]! });
  }
  return out;
}

/** The run's pull request (when delivery opened one) and the issue the policy links to every run. */
export function commentTargets(runDir: string, config: OrbitConfig): CommentTarget[] {
  const out: CommentTarget[] = [];
  const delivery = readJsonIfExists<{ pr?: { number?: unknown } | null }>(join(runDir, 'delivery.json'));
  const pr = delivery?.pr?.number;
  if (typeof pr === 'number' && Number.isInteger(pr) && pr > 0) out.push({ number: pr, kind: 'pull request' });
  const issue = notificationsPolicy(config).remote_answers.issue;
  if (issue !== null && !out.some((t) => t.number === issue)) out.push({ number: issue, kind: 'issue' });
  return out;
}

/** The threads whose comments may answer this run: none unless remote answers are on. */
export function answerThreads(runDir: string, config: OrbitConfig): CommentTarget[] {
  return notificationsPolicy(config).remote_answers.enabled ? commentTargets(runDir, config) : [];
}

export type RefusalReason = 'permission' | 'bot' | 'unknown-question' | 'question-not-open' | 'invalid-choice' | 'rejected';

export interface AcceptedAnswer {
  commentId: number;
  /** Where the comment is ("issue #7", "pull request #12"). */
  thread: string;
  questionId: string;
  author: string;
  permission: string;
}

export interface RefusedAnswer {
  commentId: number;
  thread: string;
  questionId: string;
  author: string;
  reason: RefusalReason;
  permission?: string;
}

export interface PollReport {
  accepted: AcceptedAnswer[];
  refused: RefusedAnswer[];
  /** Reads that failed; the comments involved are read again at the next poll. */
  errors: string[];
}

export interface PollInput {
  db: OrbitDb;
  clock: Clock;
  run: RunRecord;
  runDir: string;
  /** The run's verified policy. */
  config: OrbitConfig;
  client: ThreadClient;
  /** Who records the events (the service's controller id, or `cli:<user>`). */
  actor: string;
}

/** Approval questions take only their option labels: free text cannot approve or reject a contract change. */
export function allowsFreeText(q: Pick<QuestionRecord, 'id'>): boolean {
  return amendmentIdOfQuestion(q.id) === null && !q.id.startsWith('q-baseline-');
}

function norm(s: string): string {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

function validChoice(q: QuestionRecord, choice: string): boolean {
  if (choice.length > MAX_CHOICE_CHARS) return false;
  if (q.options.some((o) => norm(o.label) === norm(choice) || norm(o.description) === norm(choice))) return true;
  return allowsFreeText(q);
}

function processedComments(db: OrbitDb, runId: string): Set<number> {
  const rows = db.all<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type IN ('remote.answer.accepted', 'remote.answer.refused')", runId);
  const out = new Set<number>();
  for (const r of rows) {
    try {
      const id = (JSON.parse(r.data_json ?? '{}') as { comment_id?: unknown }).comment_id;
      if (typeof id === 'number') out.add(id);
    } catch {
      /* not ours */
    }
  }
  return out;
}

function errorText(err: unknown): string {
  return redact(isOrbitError(err) ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err)).slice(0, 300);
}

/**
 * Read the run's threads once and act on every `/orbit answer` comment not read before. Never throws: a failed read
 * is an event and an entry in `errors`, and the comments it concerns are read again next time.
 */
export async function pollRemoteAnswers(input: PollInput): Promise<PollReport> {
  const { db, clock, run, runDir, config, client, actor } = input;
  const report: PollReport = { accepted: [], refused: [], errors: [] };
  const threads = answerThreads(runDir, config);
  if (threads.length === 0) return report;
  const note = (type: string, data: Record<string, unknown>) => db.tx(() => appendEvent(db, run.id, type, actor, data, clock.now()));
  const done = processedComments(db, run.id);
  const since = new Date(run.createdAt).toISOString();
  for (const thread of threads) {
    const where = `${thread.kind} #${thread.number}`;
    let comments: ThreadComment[];
    try {
      comments = await client.listComments(thread.number, since);
    } catch (err) {
      report.errors.push(`${where}: ${errorText(err)}`);
      note('remote.poll-failed', { thread: where, error: errorText(err) });
      continue;
    }
    for (const c of comments) {
      if (done.has(c.id)) continue;
      const commands = parseAnswerCommands(c.body);
      if (commands.length === 0) continue;
      const handled = await handleComment({ ...input, thread, where, comment: c, commands, report, note });
      if (handled) done.add(c.id);
    }
  }
  return report;
}

interface CommentInput extends PollInput {
  thread: CommentTarget;
  where: string;
  comment: ThreadComment;
  commands: AnswerCommand[];
  report: PollReport;
  note: (type: string, data: Record<string, unknown>) => void;
}

/** Returns false when the comment must be read again (its author's permission could not be read). */
async function handleComment(ci: CommentInput): Promise<boolean> {
  const { db, run, comment: c, commands, report, note, where } = ci;
  const base = { comment_id: c.id, comment_url: c.url, author: c.author, thread: where };
  const refuse = (questionId: string, reason: RefusalReason, permission?: string): void => {
    report.refused.push({ commentId: c.id, thread: where, questionId, author: c.author, reason, ...(permission !== undefined ? { permission } : {}) });
    note('remote.answer.refused', { ...base, question_id: questionId, reason, ...(permission !== undefined ? { permission } : {}) });
  };
  const own = new Map(listQuestions(db, run.id).map((q) => [q.id.toLowerCase(), q]));
  // A question of another run linked to the same issue is that run's to answer; on the run's own pull request it is unknown here.
  const mine = commands.filter((cmd) => own.has(cmd.questionId.toLowerCase()) || ci.thread.kind === 'pull request' || foreignOwner(db, cmd.questionId, run.id) === null);
  if (mine.length === 0) return false;
  // Apps and bots (a "[bot]" login) are not people; a person's answer is an authorization.
  if (c.author === '' || /\[bot\]$/i.test(c.author)) {
    for (const cmd of mine) refuse(cmd.questionId, 'bot');
    return true;
  }
  let permission: string;
  try {
    permission = (await ci.client.permission(c.author)).toLowerCase();
  } catch (err) {
    report.errors.push(`${where}: permission of ${c.author}: ${errorText(err)}`);
    note('remote.poll-failed', { thread: where, comment_id: c.id, error: errorText(err) });
    return false;
  }
  for (const cmd of mine) {
    if (!ANSWERING_ROLES.has(permission)) {
      refuse(cmd.questionId, 'permission', permission);
      continue;
    }
    const q = own.get(cmd.questionId.toLowerCase());
    if (!q) {
      refuse(cmd.questionId, 'unknown-question', permission);
      continue;
    }
    // Read again: an earlier command of this comment may have answered it.
    const current = findQuestion(db, q.id);
    if (!current || current.status !== 'open') {
      refuse(q.id, 'question-not-open', permission);
      continue;
    }
    if (!validChoice(current, cmd.choice)) {
      refuse(q.id, 'invalid-choice', permission);
      continue;
    }
    try {
      accept(ci, current, cmd.choice, permission);
      report.accepted.push({ commentId: c.id, thread: where, questionId: q.id, author: c.author, permission });
      note('remote.answer.accepted', { ...base, question_id: q.id, permission });
    } catch (err) {
      report.errors.push(`${where}: answer to ${q.id}: ${errorText(err)}`);
      refuse(q.id, 'rejected', permission);
    }
  }
  return true;
}

function foreignOwner(db: OrbitDb, questionId: string, runId: string): string | null {
  const row = db.get<{ run_id: string }>('SELECT run_id FROM questions WHERE lower(id) = lower(?) LIMIT 1', questionId);
  return row && row.run_id !== runId ? row.run_id : null;
}

/** The `orbit decide` path: the answer and its decision record, then an approved amendment applied at once. */
function accept(ci: CommentInput, q: QuestionRecord, choice: string, permission: string): void {
  const { db, clock, run, runDir, comment: c, where } = ci;
  answerQuestion(db, runDir, q.id, choice, `github:${c.author}`, clock, {
    provenance: { source: 'github-comment', comment_url: c.url, comment_id: c.id, author: c.author, permission, thread: where },
  });
  if (amendmentIdOfQuestion(q.id) === null) return;
  try {
    applyAmendmentAnswers({ db, clock, runId: run.id, runDir }, { questionId: q.id });
  } catch (err) {
    // The answer is recorded; the controller applies it at its next safe point, as after orbit decide.
    ci.note('amendment.apply-failed', { question_id: q.id, error: errorText(err) });
  }
}
