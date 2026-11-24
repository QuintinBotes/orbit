/**
 * `orbit retro`, the part that reads runs: terminal runs are grouped by failure class and signature, a group becomes
 * one proposal citing its runs, and what a person decided about a proposal is remembered so a declined one is not made
 * again (issue #174).
 *
 * The kind of a proposal follows from the class: an Orbit-fault class (today `gate-deadlock`: a run held at a gate
 * nobody could open) is a draft Orbit issue, made from one run; the rest need the failure repeated (two runs or more).
 * A review dispute is a check when the repository declares one its Orbit configuration does not run, else a reviewer
 * standard; every other class is a policy change. It is deterministic over run records, calls no model, and builds a
 * draft only from structured fields: run ids, states, the failure class, the names of the outcome markers, the names
 * of the policy rules that denied calls, and the sequence of states the run went through. It never reads a reason, an
 * outcome value, a goal or a path, so nothing a run quoted (source, a secret, a directory name) can reach a draft; a
 * final pass redacts what the draft still holds as defence. A rule name comes from the worker's transcript, so a worker
 * can choose one: only local drafts carry rule names, never an issue draft. Nothing here sends or applies anything.
 */
import { createHash } from 'node:crypto';
import type { OrbitDb } from '../storage/db.ts';
import { classMarkers, parseOutcome, failureClassOrNull, type FailureClass } from '../controller/failure-class.ts';
import { isOrbitVersion } from '../controller/run-store.ts';
import { TERMINAL_STATES, isRunState } from '../core/run-states.ts';
import { redact } from '../core/redact.ts';
import { wordTokens } from '../contract/wording.ts';

/** Failure classes whose cause is in Orbit, not in the task: a person files them against Orbit, not the repository. */
export const ORBIT_FAULT_CLASSES: readonly FailureClass[] = ['gate-deadlock'];

/** FR-002: what a proposal changes. */
export type ProposalKind = 'check' | 'standard' | 'policy' | 'issue-draft';

/** `drafted` is a proposal nobody has answered yet: it is made again. Every other decision ends it. */
export type RetroDecision = 'drafted' | 'sent' | 'applied' | 'accepted' | 'declined';

/** A check the repository declares (package.json scripts, a solution, ...) that its Orbit configuration does not run. */
export interface DeclaredCheck {
  id: string;
  command: string[];
  category: string;
  timeout_seconds: number;
}

/** Runs one failure needs before it is a proposal: one run is chance, two is a pattern. An Orbit fault needs one. */
export const REPEATED = 2;

export interface RetroRunEvidence {
  runId: string;
  state: string;
  failureClass: FailureClass;
  secondary: FailureClass | null;
  orbitVersion: string;
  endedAt: number | null;
  /** The outcome markers that set the class: key names, with a count when the marker holds a list. */
  markers: string[];
  /** The states the run went through, in order, repeats collapsed. */
  steps: string[];
  /** The policy rules that denied a worker's calls, by name. */
  denials: string[];
}

export interface RetroProposal {
  kind: ProposalKind;
  failureClass: FailureClass;
  /** The marker and denial names the runs share; the same signature is the same proposal. */
  signature: string;
  /** What is remembered about the proposal. */
  key: string;
  runs: RetroRunEvidence[];
  title: string;
  /** The markdown body, redacted. */
  body: string;
  /** The check to add, for kind `check`. */
  check: DeclaredCheck | null;
}

export interface RetroDecisionRow {
  key: string;
  kind: string;
  failureClass: string;
  signature: string;
  decision: RetroDecision;
  runIds: string[];
  draftPath: string | null;
  decidedBy: string | null;
  createdAt: number;
  decidedAt: number | null;
}

const TERMINAL = [...TERMINAL_STATES];
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** A policy rule name as the guard writes one (`bash.unparseable`); anything else a transcript put there is dropped. */
const RULE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const MAX_STEPS = 40;
const MAX_RUNS_LISTED = 50;

interface RunRow {
  id: string;
  state: string;
  failure_class: string | null;
  failure_secondary: string | null;
  orbit_version: string | null;
  ended_at: number | null;
  outcome_json: string | null;
}

/** The text that stands for something that is not a safe, structured value. */
const WITHHELD = '[withheld]';
const safeId = (id: string): string => (RUN_ID.test(id) ? id : WITHHELD);

function evidenceFor(db: OrbitDb, row: RunRow, cls: FailureClass): RetroRunEvidence {
  const outcome = parseOutcome(row.outcome_json) ?? {};
  const markers = classMarkers(cls, outcome).map((m) => {
    const v = m === 'gate' ? outcome.gate : outcome[m];
    return Array.isArray(v) ? `${m} (${v.length})` : m;
  });
  const steps: string[] = [];
  for (const e of db.all<{ to_state: string | null }>('SELECT to_state FROM events WHERE run_id = ? AND to_state IS NOT NULL ORDER BY id LIMIT 500', row.id)) {
    if (e.to_state && isRunState(e.to_state) && steps[steps.length - 1] !== e.to_state) steps.push(e.to_state);
  }
  const denials = db
    .all<{ rule: unknown }>("SELECT DISTINCT json_extract(data_json, '$.rule') AS rule FROM decisions WHERE run_id = ? AND kind = 'policy.deny'", row.id)
    .map((d) => d.rule)
    .filter((r): r is string => typeof r === 'string' && RULE.test(r))
    .sort();
  return {
    runId: row.id,
    state: isRunState(row.state) ? row.state : WITHHELD,
    failureClass: cls,
    secondary: failureClassOrNull(row.failure_secondary),
    orbitVersion: row.orbit_version && isOrbitVersion(row.orbit_version) ? row.orbit_version : 'unknown',
    endedAt: row.ended_at,
    markers,
    steps: steps.slice(-MAX_STEPS),
    denials,
  };
}

/**
 * The signature of a failure: the marker names its outcome carries and, unless `withDenials` is false, the rules that
 * denied its calls; never the wording of a reason.
 */
function signatureOf(ev: RetroRunEvidence, withDenials: boolean): string {
  const names = [...new Set(ev.markers.map((m) => m.replace(/ \(\d+\)$/, '')))].sort();
  const parts = [...names, ...(withDenials ? ev.denials.map((r) => `denied:${r}`) : [])];
  return parts.length > 0 ? parts.join('+') : 'unmarked';
}

/** FR-002: the kind of proposal a failure class makes; null for a class nothing should be learnt from. */
function kindFor(cls: FailureClass, missingCheck: DeclaredCheck | null): ProposalKind | null {
  if (ORBIT_FAULT_CLASSES.includes(cls)) return 'issue-draft';
  // A run waiting for a person's answer did not fail: only a question that recurs is a proposal (recurringQuestions).
  if (cls === 'cancelled' || cls === 'awaiting-decision') return null;
  if (cls === 'review-dispute') return missingCheck ? 'check' : 'standard';
  return 'policy';
}

/** Where a policy change for each class is made. */
const POLICY_HINT: Partial<Record<FailureClass, string>> = {
  'turn-cap': 'scheduler.hard_limits.worker_turns_per_session: each of these sessions used every turn it had',
  budget: 'the budgets in scheduler.hard_limits: these runs ran out',
  scope: 'scope.allowed_paths or the change-size limits in scheduler.hard_limits',
  environment: "the checks' environment (their env and network_hosts, the isolation provider) or the machine the checks run on",
  'check-misconfigured': 'the definition of the misconfigured check under checks',
  credentials: 'the credentials these runs need, which expired or were missing',
  model: 'routing: a stronger model or more effort for this kind of task',
};

export function proposalKey(kind: string, failureClass: string, signature: string): string {
  return `${kind}:${failureClass}:${signature}`;
}

/** A short, stable file stem for a proposal, safe on every file system. */
export function draftFileName(key: string): string {
  const slug = key.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `${slug}-${createHash('sha256').update(key).digest('hex').slice(0, 8)}.md`;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Absolute paths (POSIX and Windows) and the given roots, replaced; the draft carries none, so this is a net, not a
 * mechanism. A root becomes `<repo>`, and a path below it `<repo>/<path>`: the name of a file or directory inside a
 * repository can say as much as the directory it sits in, so only the root's own place is kept.
 */
export function redactPaths(text: string, roots: readonly string[] = []): string {
  let out = text;
  // Longest root first, so a repository below the home directory is named as the repository. A root is matched whole:
  // `/tmp/x` is not the start of `/tmp/xyz`.
  const bare = [...new Set(roots.map((r) => r.replace(/[\\/]+$/, '')))].filter((x) => x.length > 1).sort((a, b) => b.length - a.length);
  for (const r of bare) {
    out = out.replace(new RegExp(`${escapeRegExp(r)}(?![\\w@+-]|\\.\\w)((?:[\\\\/][^\\s)\`'"|]*)?)`, 'g'), (_m, tail: string) => (tail.length > 1 ? '<repo>/<path>' : '<repo>'));
  }
  out = out.replace(/(?<![\w./-])~\/[^\s)`'"|]+/g, '<path>');
  out = out.replace(/(?<![\w.:/-])\/(?:[\w.@+-]+\/)+[\w.@+-]*/g, '<path>');
  out = out.replace(/\b[A-Za-z]:\\[^\s)`'"|]+/g, '<path>');
  return out;
}

const iso = (ms: number | null): string => (ms === null ? '-' : new Date(ms).toISOString());

function proposedChange(kind: ProposalKind, cls: FailureClass, signature: string, runs: readonly RetroRunEvidence[], check: DeclaredCheck | null, question: string | null): string[] {
  if (question !== null) {
    return [
      `These runs each waited for an answer to the same question: "${question}"`,
      '',
      `Answer it once with \`orbit decide\` and write the answer down as a default in the policy (.orbit/config.yaml) or the repository's instructions, so the next run does not stop to ask it.`,
    ];
  }
  if (kind === 'issue-draft') return [`Which gate held the run is named by the markers above (\`${signature}\`). Expected: a run at a gate either opens it, or ends naming the one decision a person must make.`];
  if (kind === 'check' && check) {
    return [
      `Add the check \`${check.id}\` to the repository's Orbit configuration (.orbit/config.yaml), on a branch for review: command \`${check.command.join(' ')}\`, category ${check.category}, timeout ${check.timeout_seconds}s.`,
      'The repository declares this check and its Orbit configuration does not run it, so what the reviewer kept finding reached review without a check to catch it first.',
    ];
  }
  if (kind === 'standard') {
    return [
      `Read the open findings of these runs (\`orbit report ${safeId(runs[0]!.runId)}\`) and add the judgement they share as one line to the reviewer standards.`,
      'The repository declares no check that its Orbit configuration does not already run, so this is a judgement call for the reviewer, not a check.',
    ];
  }
  const denied = runs[0]!.denials;
  return [
    `Change ${POLICY_HINT[cls] ?? 'the policy setting behind this class'}.`,
    ...(denied.length > 0 ? ['', `The rule(s) ${denied.map((r) => `\`${r}\``).join(', ')} denied calls in every one of these runs: allow what was denied in .orbit/config.yaml if it is safe, or file an issue against Orbit if the denial is wrong.`] : []),
  ];
}

const TITLE: Record<ProposalKind, string> = { 'issue-draft': 'Orbit fault', check: 'Add a check', standard: 'Reviewer standard', policy: 'Policy change' };

function render(kind: ProposalKind, failureClass: FailureClass, signature: string, runs: readonly RetroRunEvidence[], check: DeclaredCheck | null, question: string | null): { title: string; body: string } {
  const title = `${TITLE[kind]}${check ? ` ${check.id}` : ''}: runs ended in ${failureClass} (${signature})`;
  const listed = runs.slice(0, MAX_RUNS_LISTED);
  const lines = [
    `# ${title}`,
    '',
    '## What happened',
    '',
    `${runs.length} run${runs.length === 1 ? '' : 's'} of one repository ended in failure class \`${failureClass}\` with the same signature \`${signature}\`${kind === 'issue-draft' ? ": the run was held at a gate that nothing could open, which is a fault in Orbit's gates or their messages, not in the task" : ''}.`,
    '',
    '## Runs',
    '',
    '| run | final state | class | secondary class | orbit version | ended | markers |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...listed.map((r) => `| ${safeId(r.runId)} | ${r.state} | ${r.failureClass} | ${r.secondary ?? '-'} | ${r.orbitVersion} | ${iso(r.endedAt)} | ${r.markers.length > 0 ? r.markers.join(', ') : '-'} |`),
    ...(runs.length > listed.length ? ['', `(${runs.length - listed.length} more run(s) not listed)`] : []),
    '',
    '## Step markers',
    '',
    ...listed.map((r) => `- ${safeId(r.runId)}: ${r.steps.length > 0 ? r.steps.join(' > ') : '(no recorded transitions)'}`),
    '',
    '## Proposed change',
    '',
    ...proposedChange(kind, failureClass, signature, runs, check, question),
    '',
    '## Privacy',
    '',
    `Drafted by \`orbit retro\` from run records only: ids, states, the failure class and the names of markers and policy rules${question === null ? '' : ', and the wording of the question the runs waited on'}. Paths, source code, goals, reasons and credentials are not included. Review this before sending.`,
    '',
  ];
  return { title, body: lines.join('\n') };
}

/**
 * FR-001: the proposals for the terminal runs created at or after `since` (epoch ms, or null for all), one per failure
 * class and signature, citing every run that shares it. `missingCheck` is a check the repository declares and its
 * configuration does not run, or null.
 */
export function retroProposals(db: OrbitDb, opts: { since: number | null; roots?: readonly string[]; missingCheck?: DeclaredCheck | null }): RetroProposal[] {
  const marks = TERMINAL.map(() => '?').join(',');
  const rows = db.all<RunRow>(
    `SELECT id, state, failure_class, failure_secondary, orbit_version, ended_at, outcome_json FROM runs
      WHERE state IN (${marks}) AND failure_class IS NOT NULL AND created_at >= ? ORDER BY created_at, id`,
    ...TERMINAL,
    opts.since ?? 0,
  );
  const missingCheck = opts.missingCheck ?? null;
  const groups = new Map<string, { kind: ProposalKind; cls: FailureClass; signature: string; runs: RetroRunEvidence[] }>();
  for (const row of rows) {
    const cls = failureClassOrNull(row.failure_class);
    const kind = cls === null ? null : kindFor(cls, missingCheck);
    if (cls === null || kind === null) continue;
    const ev = evidenceFor(db, row, cls);
    // A rule name is read from the worker's transcript, where any failing command can print one: it stays out of an issue draft, the one proposal that leaves the machine.
    const signature = signatureOf(ev, kind !== 'issue-draft');
    const key = proposalKey(kind, cls, signature);
    const g = groups.get(key) ?? { kind, cls, signature, runs: [] };
    g.runs.push(ev);
    groups.set(key, g);
  }
  const proposals = [...groups]
    .filter(([, g]) => g.runs.length >= (g.kind === 'issue-draft' ? 1 : REPEATED))
    .map(([key, g]) => {
      const check = g.kind === 'check' ? missingCheck : null;
      const { title, body } = render(g.kind, g.cls, g.signature, g.runs, check, null);
      return { kind: g.kind, failureClass: g.cls, signature: g.signature, key, runs: g.runs, title: redact(redactPaths(title, opts.roots)), body: redact(redactPaths(body, opts.roots)), check };
    });
  return [...proposals, ...recurringQuestions(db, rows, opts.roots)];
}

/** A run that ended waiting for a person's answer, with the ids of its open questions. */
export interface AwaitingDecision {
  runId: string;
  questionIds: string[];
  /** The outcome markers the run waits on besides a question (an authorization, a ledger entry, a fail-before answer). */
  waitingOn: string[];
}

interface WaitingRow {
  run_id: string;
  id: string;
  question: string;
}

/** The open questions of the runs that ended `awaiting-decision`, in run order. */
function waitingQuestions(db: OrbitDb, rows: readonly RunRow[]): WaitingRow[] {
  const ids = rows.filter((r) => r.failure_class === 'awaiting-decision').map((r) => r.id);
  if (ids.length === 0) return [];
  return db.all<WaitingRow>(`SELECT run_id, id, question FROM questions WHERE status = 'open' AND run_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at, id`, ...ids);
}

const MAX_QUESTION_CHARS = 300;
/** Runs one question must hold up before a default for it is proposed. */
export const REPEATED_QUESTION = 3;

/** Issue #237: the runs waiting for a decision, listed apart from the failures; they propose nothing. */
export function awaitingDecisions(db: OrbitDb, opts: { since: number | null }): AwaitingDecision[] {
  const marks = TERMINAL.map(() => '?').join(',');
  const rows = db.all<RunRow>(
    `SELECT id, state, failure_class, failure_secondary, orbit_version, ended_at, outcome_json FROM runs
      WHERE state IN (${marks}) AND failure_class = 'awaiting-decision' AND created_at >= ? ORDER BY created_at, id`,
    ...TERMINAL,
    opts.since ?? 0,
  );
  const by = new Map<string, AwaitingDecision>();
  for (const r of rows) by.set(r.id, { runId: r.id, questionIds: [], waitingOn: classMarkers('awaiting-decision', parseOutcome(r.outcome_json) ?? {}).filter((m) => m !== 'questions') });
  for (const q of waitingQuestions(db, rows)) by.get(q.run_id)?.questionIds.push(q.id);
  return [...by.values()];
}

/** Issue #237: one policy default for each question that three runs or more waited on, quoting it. */
function recurringQuestions(db: OrbitDb, rows: readonly RunRow[], roots?: readonly string[]): RetroProposal[] {
  const groups = new Map<string, { text: string; runs: Set<string> }>();
  for (const q of waitingQuestions(db, rows)) {
    const norm = wordTokens(q.question).join(' ');
    if (norm === '') continue;
    const g = groups.get(norm) ?? { text: q.question, runs: new Set<string>() };
    g.runs.add(q.run_id);
    groups.set(norm, g);
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: RetroProposal[] = [];
  for (const [norm, g] of groups) {
    if (g.runs.size < REPEATED_QUESTION) continue;
    const runs = [...g.runs].map((id) => evidenceFor(db, byId.get(id)!, 'awaiting-decision'));
    const signature = `question:${createHash('sha256').update(norm).digest('hex').slice(0, 8)}`;
    const quoted = redact(redactPaths(g.text.replace(/\s+/g, ' ').trim().slice(0, MAX_QUESTION_CHARS), roots)).replace(/"/g, "'");
    const { title, body } = render('policy', 'awaiting-decision', signature, runs, null, quoted);
    out.push({ kind: 'policy', failureClass: 'awaiting-decision', signature, key: proposalKey('policy', 'awaiting-decision', signature), runs, title: redact(redactPaths(title, roots)), body: redact(redactPaths(body, roots)), check: null });
  }
  return out;
}

interface DecisionRow {
  key: string;
  kind: string;
  failure_class: string;
  signature: string;
  decision: string;
  run_ids_json: string;
  draft_path: string | null;
  decided_by: string | null;
  created_at: number;
  decided_at: number | null;
}

function toDecision(r: DecisionRow): RetroDecisionRow {
  let ids: string[] = [];
  try {
    const v: unknown = JSON.parse(r.run_ids_json);
    if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === 'string');
  } catch {
    /* an unreadable list cites nothing */
  }
  return { key: r.key, kind: r.kind, failureClass: r.failure_class, signature: r.signature, decision: r.decision as RetroDecision, runIds: ids, draftPath: r.draft_path, decidedBy: r.decided_by, createdAt: r.created_at, decidedAt: r.decided_at };
}

/** What is recorded about a proposal, or null when it has never been made. */
export function findDecision(db: OrbitDb, key: string): RetroDecisionRow | null {
  const r = db.get<DecisionRow>('SELECT * FROM retro_decisions WHERE key = ?', key);
  return r ? toDecision(r) : null;
}

export function listDecisions(db: OrbitDb): RetroDecisionRow[] {
  return db.all<DecisionRow>('SELECT * FROM retro_decisions ORDER BY created_at, key').map(toDecision);
}

/** Record that a proposal was made (its draft written), or refresh the runs a still unanswered one cites. An answered one is left alone. */
export function recordProposal(db: OrbitDb, p: RetroProposal, draftPath: string, now: number): void {
  db.run(
    `INSERT INTO retro_decisions (key, kind, failure_class, signature, decision, run_ids_json, draft_path, created_at) VALUES (?, ?, ?, ?, 'drafted', ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET run_ids_json = excluded.run_ids_json, draft_path = excluded.draft_path WHERE retro_decisions.decision = 'drafted'`,
    p.key,
    p.kind,
    p.failureClass,
    p.signature,
    JSON.stringify(p.runs.map((r) => r.runId)),
    draftPath,
    now,
  );
}

/** Record the person's answer to a drafted proposal. */
export function recordAnswer(db: OrbitDb, key: string, decision: Exclude<RetroDecision, 'drafted'>, by: string, now: number): void {
  db.run('UPDATE retro_decisions SET decision = ?, decided_by = ?, decided_at = ? WHERE key = ?', decision, by, now, key);
}
