import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { appendEvent } from '../storage/events.ts';
import type { AmendmentChange, HumanAmendmentChange } from '../contract/amendment-types.ts';
import type { ContractAmendment } from '../contract/types.ts';
import type { InquisitionMode, Level, Reversibility } from './types.ts';

/**
 * Repositories for the Inquisition's tables: questions, ledger, amendments,
 * hypotheses, plus a read-only view of `failures` (the evidence runner owns
 * writing those). The schema has fixed columns, so a few values that do not
 * have one live inside an existing JSON column; each encoding is private to
 * this file and noted where it is used:
 *
 *   questions.affected_json   {affected, changes}      (changes: what the answer would change)
 *   questions.recommendation  {option, reason}
 *   questions.safe_default    {exists, option, reason}
 *   amendments.affected_json  {affected_verification, change, note, contract_before, contract_after}
 *                             (change: the proposal, for re-application after approval; the hashes chain the contract
 *                             states applied amendments produced, so a restart can tell which ones a persisted contract lacks)
 *   hypotheses.result         {outcome}                (the failure fingerprint the hypothesis targets is the `fingerprint` column)
 *
 * Every function runs its writes in one transaction with the event that
 * describes them, and nests inside a caller's `db.tx`.
 */

// ---------------------------------------------------------------------------
// Questions

export const QUESTION_STATUSES = ['open', 'answered', 'withdrawn'] as const;
export type QuestionStatus = (typeof QUESTION_STATUSES)[number];

export interface QuestionOption {
  label: string;
  description: string;
  consequences: string;
}

export interface QuestionRecord {
  id: string;
  runId: string;
  mode: InquisitionMode;
  question: string;
  evidence: string[];
  options: QuestionOption[];
  /** What answering would change: implementation, proof, authority, scope. */
  changes: string[];
  recommendation: { option: string; reason: string } | null;
  safeDefault: { exists: boolean; option: string | null; reason: string } | null;
  material: boolean;
  /** Work blocked until answered; criterion ids (AC-n) plus free-text work items. */
  affected: string[];
  unblocked: string[];
  status: QuestionStatus;
  answer: string | null;
  answeredBy: string | null;
  answeredAt: number | null;
  createdAt: number;
}

export interface NewQuestion {
  id?: string;
  runId: string;
  mode: InquisitionMode;
  question: string;
  evidence: string[];
  options: QuestionOption[];
  changes: string[];
  recommendation: { option: string; reason: string };
  safeDefault: { exists: boolean; option: string | null; reason: string };
  material: boolean;
  affected: string[];
  unblocked: string[];
}

interface QuestionRow {
  id: string;
  run_id: string;
  mode: string;
  question: string;
  evidence: string;
  options_json: string;
  recommendation: string | null;
  safe_default: string | null;
  material: number;
  affected_json: string | null;
  unblocked_json: string | null;
  status: string;
  answer: string | null;
  answered_by: string | null;
  answered_at: number | null;
  created_at: number;
}

/**
 * A missing column falls back; a column that does not parse is corruption and
 * fails loudly. Falling back there would turn an unreadable `affected_json`
 * into "blocks nothing" and an unreadable option list into "no options".
 */
function parseJson<T>(text: string | null, fallback: T): T {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    throw new OrbitError('INTERNAL', `a stored inquisition record holds unreadable JSON: ${text.slice(0, 60)}`, undefined, { cause: err });
  }
}

function toQuestion(r: QuestionRow): QuestionRecord {
  const affected = parseJson<{ affected?: string[]; changes?: string[] }>(r.affected_json, {});
  return {
    id: r.id,
    runId: r.run_id,
    mode: r.mode as InquisitionMode,
    question: r.question,
    evidence: parseJson<string[]>(r.evidence, []),
    options: parseJson<QuestionOption[]>(r.options_json, []),
    changes: affected.changes ?? [],
    recommendation: parseJson<{ option: string; reason: string } | null>(r.recommendation, null),
    safeDefault: parseJson<{ exists: boolean; option: string | null; reason: string } | null>(r.safe_default, null),
    material: r.material === 1,
    affected: affected.affected ?? [],
    unblocked: parseJson<string[]>(r.unblocked_json, []),
    status: r.status as QuestionStatus,
    answer: r.answer,
    answeredBy: r.answered_by,
    answeredAt: r.answered_at,
    createdAt: r.created_at,
  };
}

export function insertQuestion(db: OrbitDb, input: NewQuestion, clock: Clock, actor = 'controller'): QuestionRecord {
  const id = input.id ?? newId('q');
  const now = clock.now();
  return db.tx(() => {
    if (!db.get('SELECT 1 AS x FROM runs WHERE id = ?', input.runId)) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
    db.run(
      `INSERT INTO questions (id, run_id, mode, question, evidence, options_json, recommendation, safe_default, material, affected_json, unblocked_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      id,
      input.runId,
      input.mode,
      input.question,
      JSON.stringify(input.evidence),
      JSON.stringify(input.options),
      JSON.stringify(input.recommendation),
      JSON.stringify(input.safeDefault),
      input.material ? 1 : 0,
      JSON.stringify({ affected: input.affected, changes: input.changes }),
      JSON.stringify(input.unblocked),
      now,
    );
    appendEvent(db, input.runId, 'question.created', actor, { question_id: id, mode: input.mode, material: input.material, affected: input.affected }, now);
    return getQuestion(db, id);
  });
}

export function findQuestion(db: OrbitDb, id: string): QuestionRecord | null {
  const row = db.get<QuestionRow>('SELECT * FROM questions WHERE id = ?', id);
  return row ? toQuestion(row) : null;
}

export function getQuestion(db: OrbitDb, id: string): QuestionRecord {
  const q = findQuestion(db, id);
  if (!q) throw new OrbitError('NOT_FOUND', `no question ${id}`);
  return q;
}

export function listQuestions(db: OrbitDb, runId: string, opts: { status?: QuestionStatus } = {}): QuestionRecord[] {
  const rows =
    opts.status === undefined
      ? db.all<QuestionRow>('SELECT * FROM questions WHERE run_id = ? ORDER BY created_at, rowid', runId)
      : db.all<QuestionRow>('SELECT * FROM questions WHERE run_id = ? AND status = ? ORDER BY created_at, rowid', runId, opts.status);
  return rows.map(toQuestion);
}

/**
 * open -> answered. Answering twice with the same answer is a no-op (a retried
 * `orbit decide`); a different second answer is rejected, because decisions
 * and amendments may already rest on the first.
 */
export function setQuestionAnswer(db: OrbitDb, id: string, answer: string, by: string, clock: Clock): QuestionRecord {
  const now = clock.now();
  return db.tx(() => {
    const q = getQuestion(db, id);
    if (q.status === 'answered') {
      if (q.answer === answer && q.answeredBy === by) return q;
      throw new OrbitError('CONCURRENT_UPDATE', `question ${id} was already answered`, { questionId: id });
    }
    if (q.status !== 'open') throw new OrbitError('TRANSITION_INVALID', `question ${id} is ${q.status}; only an open question can be answered`, { questionId: id });
    db.run("UPDATE questions SET status = 'answered', answer = ?, answered_by = ?, answered_at = ? WHERE id = ? AND status = 'open'", answer, by, now, id);
    appendEvent(db, q.runId, 'question.answered', by, { question_id: id }, now);
    return getQuestion(db, id);
  });
}

/**
 * Add work to an open question's blocked set. A question asked again for more
 * criteria must block all of them; merging it into the first without this
 * would leave the later criteria running on a guess.
 */
export function widenQuestionAffected(db: OrbitDb, id: string, extra: readonly string[], clock: Clock, actor = 'controller'): QuestionRecord {
  const now = clock.now();
  return db.tx(() => {
    const q = getQuestion(db, id);
    const added = extra.filter((w) => !q.affected.includes(w));
    if (added.length === 0) return q;
    if (q.status !== 'open') throw new OrbitError('TRANSITION_INVALID', `question ${id} is ${q.status}; only an open question can be widened`, { questionId: id });
    db.run('UPDATE questions SET affected_json = ? WHERE id = ?', JSON.stringify({ affected: [...q.affected, ...added], changes: q.changes }), id);
    appendEvent(db, q.runId, 'question.widened', actor, { question_id: id, added }, now);
    return getQuestion(db, id);
  });
}

export function withdrawQuestion(db: OrbitDb, id: string, reason: string, clock: Clock, actor = 'controller'): QuestionRecord {
  const now = clock.now();
  return db.tx(() => {
    const q = getQuestion(db, id);
    if (q.status === 'withdrawn') return q;
    if (q.status !== 'open') throw new OrbitError('TRANSITION_INVALID', `question ${id} is ${q.status}; only an open question can be withdrawn`, { questionId: id });
    db.run("UPDATE questions SET status = 'withdrawn' WHERE id = ? AND status = 'open'", id);
    appendEvent(db, q.runId, 'question.withdrawn', actor, { question_id: id, reason }, now);
    return getQuestion(db, id);
  });
}

// ---------------------------------------------------------------------------
// Assumption ledger

export const LEDGER_STATUSES = ['unverified', 'supported', 'rejected', 'needs-decision'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

/** What may stand behind a status change. A model's claim is deliberately not a kind. */
export const LEDGER_EVIDENCE_KINDS = ['check', 'experiment', 'inspection', 'decision', 'review'] as const;
export type LedgerEvidenceKind = (typeof LEDGER_EVIDENCE_KINDS)[number];

export interface LedgerEvidence {
  kind: LedgerEvidenceKind | 'asserted';
  /** Check run id, experiment id, path:line, decision id... something a person can look up. */
  ref: string;
  note?: string;
  at: number;
}

export interface LedgerRecord {
  id: string;
  runId: string;
  claim: string;
  source: string;
  confidence: Level;
  consequence: string | null;
  reversibility: Reversibility;
  experiment: string | null;
  status: LedgerStatus;
  evidence: LedgerEvidence[];
  createdAt: number;
  updatedAt: number;
}

export interface NewLedgerEntry {
  id?: string;
  runId: string;
  claim: string;
  source: string;
  confidence: Level;
  consequence: string | null;
  reversibility: Reversibility;
  experiment: string | null;
  status?: LedgerStatus;
  evidence?: LedgerEvidence[];
}

interface LedgerRow {
  id: string;
  run_id: string;
  claim: string;
  source: string;
  confidence: string;
  consequence: string | null;
  reversibility: string;
  experiment: string | null;
  status: string;
  evidence_json: string | null;
  created_at: number;
  updated_at: number;
}

function toLedger(r: LedgerRow): LedgerRecord {
  return {
    id: r.id,
    runId: r.run_id,
    claim: r.claim,
    source: r.source,
    confidence: r.confidence as Level,
    consequence: r.consequence,
    reversibility: r.reversibility as Reversibility,
    experiment: r.experiment,
    status: r.status as LedgerStatus,
    evidence: parseJson<LedgerEvidence[]>(r.evidence_json, []),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function insertLedgerEntry(db: OrbitDb, input: NewLedgerEntry, clock: Clock, actor = 'controller'): LedgerRecord {
  const id = input.id ?? newId('as');
  const now = clock.now();
  return db.tx(() => {
    if (!db.get('SELECT 1 AS x FROM runs WHERE id = ?', input.runId)) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
    db.run(
      `INSERT INTO ledger (id, run_id, claim, source, confidence, consequence, reversibility, experiment, status, evidence_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.runId,
      input.claim,
      input.source,
      input.confidence,
      input.consequence,
      input.reversibility,
      input.experiment,
      input.status ?? 'unverified',
      JSON.stringify(input.evidence ?? []),
      now,
      now,
    );
    appendEvent(db, input.runId, 'ledger.added', actor, { ledger_id: id, status: input.status ?? 'unverified' }, now);
    return getLedgerEntry(db, id);
  });
}

export function findLedgerEntry(db: OrbitDb, id: string): LedgerRecord | null {
  const row = db.get<LedgerRow>('SELECT * FROM ledger WHERE id = ?', id);
  return row ? toLedger(row) : null;
}

export function getLedgerEntry(db: OrbitDb, id: string): LedgerRecord {
  const e = findLedgerEntry(db, id);
  if (!e) throw new OrbitError('NOT_FOUND', `no ledger entry ${id}`);
  return e;
}

export function listLedger(db: OrbitDb, runId: string, opts: { status?: LedgerStatus } = {}): LedgerRecord[] {
  const rows =
    opts.status === undefined
      ? db.all<LedgerRow>('SELECT * FROM ledger WHERE run_id = ? ORDER BY created_at, rowid', runId)
      : db.all<LedgerRow>('SELECT * FROM ledger WHERE run_id = ? AND status = ? ORDER BY created_at, rowid', runId, opts.status);
  return rows.map(toLedger);
}

/** Raw status write with optimistic check; the transition rules live in ledger.ts. */
export function writeLedgerStatus(db: OrbitDb, id: string, from: LedgerStatus, to: LedgerStatus, evidence: LedgerEvidence[], clock: Clock, actor = 'controller'): LedgerRecord {
  const now = clock.now();
  return db.tx(() => {
    const cur = getLedgerEntry(db, id);
    const res = db.run('UPDATE ledger SET status = ?, evidence_json = ?, updated_at = ? WHERE id = ? AND status = ?', to, JSON.stringify([...cur.evidence, ...evidence]), now, id, from);
    if (res.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `ledger entry ${id} changed while updating`, { ledgerId: id });
    appendEvent(db, cur.runId, 'ledger.transition', actor, { ledger_id: id, from, to }, now);
    return getLedgerEntry(db, id);
  });
}

// ---------------------------------------------------------------------------
// Amendments

export const AMENDMENT_STATUSES = ['applied', 'pending-approval', 'rejected'] as const;
export type AmendmentStatus = (typeof AMENDMENT_STATUSES)[number];

export interface AmendmentRecord {
  id: string;
  runId: string;
  record: ContractAmendment;
  /** The proposed operation, kept so an approved amendment can be re-applied exactly. */
  change: AmendmentChange | HumanAmendmentChange | null;
  approvedBy: string | null;
  status: AmendmentStatus;
  /** Why it is pending or rejected; empty for applied ones. */
  note: string;
  /** Hashes of the contract just before and just after the amendment applied; null until it has. */
  contractBefore: string | null;
  contractAfter: string | null;
  createdAt: number;
}

interface AmendmentRow {
  id: string;
  run_id: string;
  field: string;
  old_json: string | null;
  new_json: string | null;
  evidence: string;
  reason: string;
  approval_required: number;
  approved_by: string | null;
  affected_json: string | null;
  status: string;
  created_at: number;
}

function toAmendment(r: AmendmentRow): AmendmentRecord {
  const env = parseJson<{ affected_verification?: string[]; change?: AmendmentChange | HumanAmendmentChange | null; note?: string; contract_before?: string | null; contract_after?: string | null }>(r.affected_json, {});
  return {
    id: r.id,
    runId: r.run_id,
    record: {
      field: r.field,
      old_value: parseJson<unknown>(r.old_json, null),
      new_value: parseJson<unknown>(r.new_json, null),
      evidence: r.evidence,
      reason: r.reason,
      approval_required: r.approval_required === 1,
      affected_verification: env.affected_verification ?? [],
    },
    change: env.change ?? null,
    approvedBy: r.approved_by,
    status: r.status as AmendmentStatus,
    note: env.note ?? '',
    contractBefore: env.contract_before ?? null,
    contractAfter: env.contract_after ?? null,
    createdAt: r.created_at,
  };
}

export interface NewAmendment {
  id?: string;
  runId: string;
  record: ContractAmendment;
  change: AmendmentChange | HumanAmendmentChange | null;
  status: AmendmentStatus;
  approvedBy?: string | null;
  note?: string;
  contractBefore?: string | null;
  contractAfter?: string | null;
}

export function insertAmendment(db: OrbitDb, input: NewAmendment, clock: Clock, actor = 'controller'): AmendmentRecord {
  const id = input.id ?? newId('amd');
  const now = clock.now();
  return db.tx(() => {
    if (!db.get('SELECT 1 AS x FROM runs WHERE id = ?', input.runId)) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
    db.run(
      `INSERT INTO amendments (id, run_id, field, old_json, new_json, evidence, reason, approval_required, approved_by, affected_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.runId,
      input.record.field,
      JSON.stringify(input.record.old_value ?? null),
      JSON.stringify(input.record.new_value ?? null),
      input.record.evidence,
      input.record.reason,
      input.record.approval_required ? 1 : 0,
      input.approvedBy ?? null,
      JSON.stringify({ affected_verification: input.record.affected_verification, change: input.change, note: input.note ?? '', contract_before: input.contractBefore ?? null, contract_after: input.contractAfter ?? null }),
      input.status,
      now,
    );
    appendEvent(db, input.runId, `amendment.${input.status}`, actor, { amendment_id: id, field: input.record.field }, now);
    return getAmendment(db, id);
  });
}

export function findAmendment(db: OrbitDb, id: string): AmendmentRecord | null {
  const row = db.get<AmendmentRow>('SELECT * FROM amendments WHERE id = ?', id);
  return row ? toAmendment(row) : null;
}

export function getAmendment(db: OrbitDb, id: string): AmendmentRecord {
  const a = findAmendment(db, id);
  if (!a) throw new OrbitError('NOT_FOUND', `no amendment ${id}`);
  return a;
}

export function listAmendments(db: OrbitDb, runId: string, opts: { status?: AmendmentStatus } = {}): AmendmentRecord[] {
  const rows =
    opts.status === undefined
      ? db.all<AmendmentRow>('SELECT * FROM amendments WHERE run_id = ? ORDER BY created_at, rowid', runId)
      : db.all<AmendmentRow>('SELECT * FROM amendments WHERE run_id = ? AND status = ? ORDER BY created_at, rowid', runId, opts.status);
  return rows.map(toAmendment);
}

/** The applied amendments in order: what `applyAmendment` needs as `history` so criterion ids are never reused. */
export function amendmentHistory(db: OrbitDb, runId: string): ContractAmendment[] {
  return listAmendments(db, runId, { status: 'applied' }).map((a) => a.record);
}

/**
 * pending-approval -> applied (with the approving decision) or rejected. An
 * amendment applied here records the contract hashes around it, so a restart
 * can replay it onto a contract that was persisted without it.
 */
export function resolveAmendment(db: OrbitDb, id: string, to: 'applied' | 'rejected', approvedBy: string | null, clock: Clock, actor = 'controller', hashes?: { before: string; after: string }): AmendmentRecord {
  const now = clock.now();
  return db.tx(() => {
    const a = getAmendment(db, id);
    if (a.status === to && a.approvedBy === approvedBy) return a;
    if (a.status !== 'pending-approval') throw new OrbitError('TRANSITION_INVALID', `amendment ${id} is ${a.status}; only a pending amendment can be resolved`, { amendmentId: id });
    const row = db.get<{ affected_json: string | null }>('SELECT affected_json FROM amendments WHERE id = ?', id);
    const env = parseJson<Record<string, unknown>>(row?.affected_json ?? null, {});
    if (hashes) {
      env.contract_before = hashes.before;
      env.contract_after = hashes.after;
    }
    db.run('UPDATE amendments SET status = ?, approved_by = ?, affected_json = ? WHERE id = ? AND status = ?', to, approvedBy, JSON.stringify(env), id, 'pending-approval');
    appendEvent(db, a.runId, `amendment.${to}`, actor, { amendment_id: id, approved_by: approvedBy }, now);
    return getAmendment(db, id);
  });
}

// ---------------------------------------------------------------------------
// Hypotheses

export const HYPOTHESIS_STATUSES = ['proposed', 'testing', 'supported', 'eliminated', 'inconclusive'] as const;
export type HypothesisStatus = (typeof HYPOTHESIS_STATUSES)[number];

export interface HypothesisOutcome {
  status: Exclude<HypothesisStatus, 'proposed' | 'testing'>;
  /** What the experiment actually showed. */
  observation: string;
  /** Check run ids, log paths: what a person can look at. */
  evidence: string[];
  at: number;
}

export interface HypothesisRecord {
  id: string;
  runId: string;
  statement: string;
  normalizedHash: string;
  /** The failure fingerprint this hypothesis tries to explain. */
  fingerprint: string;
  experiment: string | null;
  expectedObservation: string | null;
  status: HypothesisStatus;
  outcome: HypothesisOutcome | null;
  createdAt: number;
  updatedAt: number;
}

interface HypothesisRow {
  id: string;
  run_id: string;
  statement: string;
  normalized_hash: string;
  experiment: string | null;
  expected_observation: string | null;
  status: string;
  result: string | null;
  fingerprint: string | null;
  created_at: number;
  updated_at: number;
}

function toHypothesis(r: HypothesisRow): HypothesisRecord {
  // Rows written before the fingerprint column existed carry it in the result JSON; new rows never do.
  const res = parseJson<{ fingerprint?: string; outcome?: HypothesisOutcome | null }>(r.result, {});
  return {
    id: r.id,
    runId: r.run_id,
    statement: r.statement,
    normalizedHash: r.normalized_hash,
    fingerprint: r.fingerprint ?? res.fingerprint ?? '',
    experiment: r.experiment,
    expectedObservation: r.expected_observation,
    status: r.status as HypothesisStatus,
    outcome: res.outcome ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewHypothesis {
  id?: string;
  runId: string;
  statement: string;
  normalizedHash: string;
  fingerprint: string;
  experiment?: string | null;
  expectedObservation?: string | null;
}

export function insertHypothesis(db: OrbitDb, input: NewHypothesis, clock: Clock, actor = 'controller'): HypothesisRecord {
  const id = input.id ?? newId('hyp');
  const now = clock.now();
  return db.tx(() => {
    if (!db.get('SELECT 1 AS x FROM runs WHERE id = ?', input.runId)) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
    db.run(
      `INSERT INTO hypotheses (id, run_id, statement, normalized_hash, fingerprint, experiment, expected_observation, status, result, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?)`,
      id,
      input.runId,
      input.statement,
      input.normalizedHash,
      input.fingerprint,
      input.experiment ?? null,
      input.expectedObservation ?? null,
      JSON.stringify({ outcome: null }),
      now,
      now,
    );
    appendEvent(db, input.runId, 'hypothesis.proposed', actor, { hypothesis_id: id, fingerprint: input.fingerprint }, now);
    return getHypothesis(db, id);
  });
}

export function findHypothesis(db: OrbitDb, id: string): HypothesisRecord | null {
  const row = db.get<HypothesisRow>('SELECT * FROM hypotheses WHERE id = ?', id);
  return row ? toHypothesis(row) : null;
}

export function getHypothesis(db: OrbitDb, id: string): HypothesisRecord {
  const h = findHypothesis(db, id);
  if (!h) throw new OrbitError('NOT_FOUND', `no hypothesis ${id}`);
  return h;
}

export function listHypotheses(db: OrbitDb, runId: string): HypothesisRecord[] {
  return db.all<HypothesisRow>('SELECT * FROM hypotheses WHERE run_id = ? ORDER BY created_at, rowid', runId).map(toHypothesis);
}

export function writeHypothesis(
  db: OrbitDb,
  id: string,
  patch: { status: HypothesisStatus; experiment?: string; expectedObservation?: string; outcome?: HypothesisOutcome | null },
  clock: Clock,
  actor = 'controller',
): HypothesisRecord {
  const now = clock.now();
  return db.tx(() => {
    const cur = getHypothesis(db, id);
    db.run(
      'UPDATE hypotheses SET status = ?, experiment = ?, expected_observation = ?, result = ?, fingerprint = ?, updated_at = ? WHERE id = ?',
      patch.status,
      patch.experiment ?? cur.experiment,
      patch.expectedObservation ?? cur.expectedObservation,
      JSON.stringify({ outcome: patch.outcome === undefined ? cur.outcome : patch.outcome }),
      // Also moves a legacy row (fingerprint only in its old result JSON) onto the column.
      cur.fingerprint,
      now,
      id,
    );
    appendEvent(db, cur.runId, `hypothesis.${patch.status}`, actor, { hypothesis_id: id, fingerprint: cur.fingerprint }, now);
    return getHypothesis(db, id);
  });
}

// ---------------------------------------------------------------------------
// Failures (read-only; written by the evidence runner)

export interface FailureRecord {
  id: number;
  runId: string;
  candidateId: string | null;
  source: string;
  sourceId: string | null;
  fingerprint: string;
  excerpt: string | null;
  createdAt: number;
}

interface FailureRow {
  id: number;
  run_id: string;
  candidate_id: string | null;
  source: string;
  source_id: string | null;
  fingerprint: string;
  excerpt: string | null;
  created_at: number;
}

export function listFailures(db: OrbitDb, runId: string): FailureRecord[] {
  return db.all<FailureRow>('SELECT * FROM failures WHERE run_id = ? ORDER BY id', runId).map((r) => ({
    id: r.id,
    runId: r.run_id,
    candidateId: r.candidate_id,
    source: r.source,
    sourceId: r.source_id,
    fingerprint: r.fingerprint,
    excerpt: r.excerpt,
    createdAt: r.created_at,
  }));
}

/**
 * How many distinct candidates hit each fingerprint. A rerun of the same
 * candidate (flaky classification) is one occurrence, not two: the same tree
 * failing twice says nothing new about the repair.
 */
export function fingerprintOccurrences(failures: readonly FailureRecord[]): Map<string, { candidates: string[]; rows: number; excerpt: string | null }> {
  const out = new Map<string, { candidates: string[]; rows: number; excerpt: string | null }>();
  for (const f of failures) {
    const e = out.get(f.fingerprint) ?? { candidates: [], rows: 0, excerpt: null };
    const key = f.candidateId ?? `row:${f.id}`;
    if (!e.candidates.includes(key)) e.candidates.push(key);
    e.rows++;
    e.excerpt = f.excerpt ?? e.excerpt;
    out.set(f.fingerprint, e);
  }
  return out;
}
