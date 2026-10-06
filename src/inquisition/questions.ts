import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { redact } from '../core/redact.ts';
import { recordDecision, type DecisionRecord } from '../storage/decisions.ts';
import type { GoalContract } from '../contract/types.ts';
import { wordTokens } from '../contract/wording.ts';
import { mentionsIrreversible, riskCategoriesInText, type RiskCategory } from './heuristics.ts';
import {
  getQuestion,
  insertQuestion,
  listQuestions,
  setQuestionAnswer,
  widenQuestionAffected,
  type QuestionOption,
  type QuestionRecord,
} from './store.ts';
import { ANSWER_DECISION_KIND, answerDecisionId, isHumanActor } from './actors.ts';
import { applyBaselineExceptionAnswers, type BaselineApplyOutcome } from './baseline-exception.ts';
import { appendEvent } from '../storage/events.ts';
import type { InquisitionMode, InquisitorQuestion } from './types.ts';

/**
 * Question quality (spec section 10). A question costs a person's attention
 * and, unattended, blocks work, so it has to earn both: it must change
 * implementation, proof, authority or scope; resist responsible inspection;
 * offer options with their consequences; recommend one; say whether a safe
 * default exists; and name the work it blocks and the work that can go on.
 * A question that cannot meet that bar is rejected rather than asked, and the
 * caller falls back to inspecting, experimenting or deciding reversibly.
 */

export const QUESTION_CHANGES = ['implementation', 'proof', 'authority', 'scope'] as const;

/** Things a person asks when the answer is in the repository: inspect instead of asking. */
const ANSWERABLE_BY_INSPECTION: readonly RegExp[] = [
  /^\s*(where|which file|what file|in which (file|directory|folder))\b/i,
  /\b(what|which) (version|framework|library|language|test runner|package manager|build tool)\b/i,
  /^\s*(does|do|is|are)\s+(the|this)\s+(repo|repository|codebase|project|code|app|service)\b/i,
  /^\s*how does (the|this) (code|function|method|module|repo|service|class)\b/i,
  /\bwhat does (this|the) (function|method|class|module|file) do\b/i,
  /\b(can|could) you (please )?(look|check|find|read|search|run|open)\b/i,
  /^\s*is there (a|an|any)\s+\w+\s*(file|test|config|script|helper|function)\b/i,
];

/** Permission-seeking and open-ended asks that decide nothing. */
const NOT_A_DECISION: readonly RegExp[] = [
  /^\s*(should|shall|may|can) i (proceed|continue|go ahead|start|begin)\b/i,
  /\b(is|does|would) (this|that|it|the)( \w+){0,2} (ok|okay|fine|alright|acceptable|good|right|look right)\b/i,
  /\bwhat should i do\b/i,
  /\bany (preferences?|thoughts|comments|concerns|feedback)\b/i,
  /\bplease (confirm|advise|clarify|let me know)\b/i,
  /\bdo you (want|prefer|need) me to\b/i,
  /\bwhat do you (think|want|prefer)\b/i,
];

const NO_EVIDENCE = /^\s*(none|n\/a|na|nothing|unknown|tbd|todo|-+|\.+)\s*\.?\s*$/i;

export interface QuestionValidation {
  valid: boolean;
  /** One line per rule the question breaks; empty when valid. */
  problems: string[];
}

export interface ValidateQuestionOptions {
  /** With a contract, affected work must name real criteria so the controller knows what to block. */
  contract?: GoalContract | null;
}

const AC_ID = /^AC-[0-9]+$/;

function isNonEmpty(v: unknown, min = 1): v is string {
  return typeof v === 'string' && v.trim().length >= min;
}

function norm(label: string): string {
  return wordTokens(label).join(' ');
}

export function validateQuestion(q: unknown, opts: ValidateQuestionOptions = {}): QuestionValidation {
  const problems: string[] = [];
  if (q === null || typeof q !== 'object' || Array.isArray(q)) return { valid: false, problems: ['question must be an object'] };
  const d = q as Partial<InquisitorQuestion> & Record<string, unknown>;

  // The ask itself.
  if (!isNonEmpty(d.question, 1)) {
    problems.push('question text is missing');
  } else {
    const text = d.question.trim();
    if (!text.endsWith('?')) problems.push('question text must be a question (end with "?")');
    if (wordTokens(text).length < 5) problems.push('question text is too short to be a decision');
    if (ANSWERABLE_BY_INSPECTION.some((r) => r.test(text))) problems.push('question is answerable by inspecting the repository; inspect instead of asking');
    if (NOT_A_DECISION.some((r) => r.test(text))) problems.push('question asks for permission or opinion; it must pose a decision between options');
  }

  // Must change implementation, proof, authority or scope.
  if (!Array.isArray(d.changes) || d.changes.length === 0) {
    problems.push('question must say what the answer changes: implementation, proof, authority or scope');
  } else if (d.changes.some((c) => !(QUESTION_CHANGES as readonly string[]).includes(c as string))) {
    problems.push(`changes must be drawn from ${QUESTION_CHANGES.join(', ')}`);
  }

  // Unanswerable from responsible inspection: the evidence says what was looked at.
  if (!Array.isArray(d.evidence) || d.evidence.length === 0) {
    problems.push('question needs evidence of what inspection found and why it does not settle the question');
  } else if (d.evidence.some((e) => !isNonEmpty(e, 10) || NO_EVIDENCE.test(e))) {
    problems.push('each evidence entry must state what was inspected or found (at least a short sentence)');
  }

  // Options with consequences.
  const labels: string[] = [];
  if (!Array.isArray(d.options) || d.options.length < 2) {
    problems.push('question needs at least two options');
  } else {
    d.options.forEach((o: Partial<QuestionOption> | null, i) => {
      if (!o || !isNonEmpty(o.label) || !isNonEmpty(o.description)) problems.push(`option ${i + 1} needs a label and a description`);
      else labels.push(o.label.trim());
      if (!o || !isNonEmpty(o.consequences, 8)) problems.push(`option ${i + 1} needs its consequences stated`);
    });
    const normalized = labels.map(norm);
    if (new Set(normalized).size !== normalized.length) problems.push('option labels must be distinct');
    const descriptions = d.options.map((o: Partial<QuestionOption> | null) => norm(o?.description ?? '')).filter((x) => x !== '');
    if (new Set(descriptions).size !== descriptions.length) problems.push('options must differ in substance, not only in label');
  }

  // A recommendation.
  if (!isNonEmpty(d.recommendation)) problems.push('question needs a recommended option');
  else if (labels.length > 0 && !labels.some((l) => norm(l) === norm(d.recommendation as string))) problems.push('recommendation must be the label of one of the options');
  if (!isNonEmpty(d.recommendation_reason, 8)) problems.push('recommendation needs a stated reason');

  // Whether a safe default exists.
  const sd = d.safe_default;
  if (!sd || typeof sd !== 'object' || typeof sd.exists !== 'boolean') {
    problems.push('question must state whether a safe default exists');
  } else {
    if (!isNonEmpty(sd.reason, 8)) problems.push('safe_default needs a reason (why it is safe, or why none is)');
    if (sd.exists) {
      if (!isNonEmpty(sd.option) || (labels.length > 0 && !labels.some((l) => norm(l) === norm(sd.option as string)))) problems.push('safe_default.option must be the label of one of the options');
    } else if (sd.option !== null && sd.option !== undefined) {
      problems.push('safe_default.option must be null when no safe default exists');
    }
  }

  if (typeof d.material !== 'boolean') problems.push('question must say whether it is material');

  // Affected and unblocked work.
  if (!Array.isArray(d.affected_work) || d.affected_work.length === 0 || d.affected_work.some((w) => !isNonEmpty(w))) {
    problems.push('question must name the affected work');
  }
  if (!Array.isArray(d.unblocked_work) || d.unblocked_work.some((w) => !isNonEmpty(w))) {
    problems.push('question must list the work that stays unblocked (an empty list is allowed)');
  }
  if (Array.isArray(d.affected_work) && Array.isArray(d.unblocked_work)) {
    const blocked = new Set(d.affected_work.map((w) => String(w).trim().toLowerCase()));
    const both = d.unblocked_work.filter((w) => blocked.has(String(w).trim().toLowerCase()));
    if (both.length > 0) problems.push(`work cannot be both affected and unblocked: ${both.join(', ')}`);
  }
  if (opts.contract && Array.isArray(d.affected_work)) {
    const ids = d.affected_work.filter((w) => AC_ID.test(String(w).trim())).map((w) => String(w).trim());
    const known = new Set(opts.contract.acceptance_criteria.map((c) => c.id));
    if (ids.length === 0) problems.push('affected work must name at least one acceptance criterion (AC-n) so the controller knows what to block');
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) problems.push(`affected work names criteria that do not exist: ${unknown.join(', ')}`);
    if (Array.isArray(d.unblocked_work)) {
      const clash = d.unblocked_work.filter((w) => ids.includes(String(w).trim()));
      if (clash.length > 0) problems.push(`criteria cannot be both affected and unblocked: ${clash.join(', ')}`);
    }
  }
  return { valid: problems.length === 0, problems };
}

export interface QuestionClassification {
  material: boolean;
  /** Safe to decide autonomously: not material, and a safe default exists. */
  reversible: boolean;
  reasons: string[];
  categories: RiskCategory[];
}

export interface ClassifyOptions {
  contract?: GoalContract | null;
}

function topicMatches(topic: string, text: string): boolean {
  const need = wordTokens(topic).filter((t) => t.length > 2);
  if (need.length === 0) return false;
  const have = new Set(wordTokens(text));
  return need.every((t) => have.has(t));
}

/**
 * Material means a guess could be wrong in a way that matters: product
 * semantics, security rules, financial effects or irreversible data. The
 * classification only ever upgrades: a worker that calls its own question
 * material is believed, one that calls a security question trivial is not.
 */
export function classifyQuestion(q: InquisitorQuestion, opts: ClassifyOptions = {}): QuestionClassification {
  const reasons: string[] = [];
  const surface = [q.question, ...q.options.flatMap((o) => [o.label, o.description, o.consequences]), ...q.evidence].join('\n');
  const categories = riskCategoriesInText(surface);
  if (q.material) reasons.push('the question is marked material');
  if (q.safe_default.exists === false) reasons.push('no safe default exists, so proceeding means guessing');
  if (q.changes.includes('authority')) reasons.push('the answer changes authority');
  if (q.changes.includes('scope')) reasons.push('the answer changes scope');
  if (categories.length > 0) reasons.push(`it touches ${categories.join(', ')}`);
  if (mentionsIrreversible(surface)) reasons.push('an option has irreversible effects');
  for (const topic of opts.contract?.escalation.material_topics ?? []) {
    if (topicMatches(topic, surface)) reasons.push(`the contract lists "${topic}" as a material topic`);
  }
  const material = reasons.length > 0;
  return { material, reversible: !material && q.safe_default.exists, reasons, categories };
}

/** What of an answered question decides whether it still covers a later one. */
export type AnsweredAsk = Pick<QuestionRecord, 'question' | 'options' | 'affected'>;

function optionKey(options: readonly { description: string }[]): string {
  return options.map((o) => norm(o.description)).sort().join('|');
}

/**
 * Whether a person's answer to `answered` already settles `asked`: the same
 * ask, the same options, and no criterion beyond those the answer was given
 * for. Anything less is a different decision (another criterion, other
 * consequences), and treating it as settled would unblock work on a guess.
 */
export function settles(answered: AnsweredAsk, asked: Pick<InquisitorQuestion, 'question' | 'options' | 'affected_work'>): boolean {
  if (!sameAsk(answered.question, asked.question)) return false;
  if (optionKey(answered.options) !== optionKey(asked.options)) return false;
  const covered = new Set(answered.affected);
  return asked.affected_work.every((w) => !AC_ID.test(w.trim()) || covered.has(w.trim()));
}

export interface PersistQuestionOptions extends ClassifyOptions {
  actor?: string;
}

export interface PersistedQuestion {
  question: QuestionRecord;
  /** False when an equivalent open question already existed and was returned instead. */
  created: boolean;
  classification: QuestionClassification;
}

/** Whether two question texts ask the same thing (word overlap, so a re-worded repeat is still the same ask). */
export function sameAsk(a: string, b: string): boolean {
  const ta = new Set(wordTokens(a));
  const tb = new Set(wordTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.85;
}

/**
 * Validate and store a question. Throws SCHEMA_INVALID with the problems when
 * the question is weak. An equivalent open question is returned instead of a
 * duplicate: asking twice would split the answer across two records.
 */
export function persistQuestion(db: OrbitDb, runId: string, mode: InquisitionMode, q: InquisitorQuestion, clock: Clock, opts: PersistQuestionOptions = {}): PersistedQuestion {
  const check = validateQuestion(q, opts);
  if (!check.valid) throw new OrbitError('SCHEMA_INVALID', `question rejected: ${check.problems.join('; ')}`, { problems: check.problems });
  const classification = classifyQuestion(q, opts);
  return db.tx(() => {
    // An answered question is still the answer to that ask: re-asking it would reopen what a person already settled and block the work again.
    const all = listQuestions(db, runId);
    // An open ask is the same question when its options match, or when it concerns a criterion the open one already
    // blocks: inquiries reword the options each time (e2e Nm8 asked one conflict three times), and two open records
    // would split the person's answer. An answered question stays strict (see settles).
    const asked = new Set(q.affected_work.map((w) => w.trim()).filter((w) => AC_ID.test(w)));
    const open = all.find((o) => o.status === 'open' && sameAsk(o.question, q.question) && (optionKey(o.options) === optionKey(q.options) || o.affected.some((a) => asked.has(a))));
    if (open) {
      // The same ask for further criteria blocks them too.
      return { question: widenQuestionAffected(db, open.id, q.affected_work.map((w) => w.trim()), clock, opts.actor ?? 'controller'), created: false, classification };
    }
    const settled = all.find((o) => o.status === 'answered' && settles(o, q));
    if (settled) return { question: settled, created: false, classification };
    // The worker read repository content to write this; whatever credential it quoted must not become a durable record.
    const r = (text: string): string => redact(text.trim());
    const question = insertQuestion(
      db,
      {
        runId,
        mode,
        question: r(q.question),
        evidence: q.evidence.map(r),
        options: q.options.map((o) => ({ label: o.label.trim(), description: r(o.description), consequences: r(o.consequences) })),
        changes: [...q.changes],
        recommendation: { option: q.recommendation.trim(), reason: r(q.recommendation_reason) },
        safeDefault: { exists: q.safe_default.exists, option: q.safe_default.option, reason: r(q.safe_default.reason) },
        material: classification.material,
        affected: q.affected_work.map((w) => w.trim()),
        unblocked: q.unblocked_work.map((w) => w.trim()),
      },
      clock,
      opts.actor ?? 'controller',
    );
    return { question, created: true, classification };
  });
}

export { isHumanActor };

export interface AnsweredQuestion {
  question: QuestionRecord;
  decision: DecisionRecord;
  /** The option the answer names, or null for a free-text answer. */
  chosenOption: QuestionOption | null;
  /** Affected work released by this answer. */
  unblocks: string[];
  /** For the answer to a baseline-exception question (preflight): what happened to the exception; null for any other question. */
  baselineException: BaselineApplyOutcome | null;
}

export { ANSWER_DECISION_KIND };

/**
 * `orbit decide`: record a person's answer. The answer lands on the question
 * row and as a decision record (the id a human-approved amendment cites).
 * Idempotent: repeating the same answer repairs a missing decision after a
 * crash and changes nothing else. `provenance` says where an answer that did
 * not come from the repository's shell came from (a pull request comment: its
 * URL, author and the permission GitHub reported); it is kept in the decision.
 */
export function answerQuestion(db: OrbitDb, runDir: string, id: string, answer: string, by: string, clock: Clock, opts: { provenance?: Record<string, unknown> } = {}): AnsweredQuestion {
  if (!isHumanActor(by)) throw new OrbitError('POLICY_DENIED', `"${by}" cannot answer a question: decisions come from a person, not a model or worker`, { by });
  const text = answer.trim();
  if (text === '') throw new OrbitError('SCHEMA_INVALID', 'an answer cannot be empty');
  const existing = getQuestion(db, id);
  // A person may name the option by its label (the schema uses letters) or repeat its description.
  const matched = existing.options.find((o) => norm(o.label) === norm(text)) ?? existing.options.find((o) => norm(o.description) === norm(text)) ?? null;
  const stored = matched ? matched.label : text;
  const question = setQuestionAnswer(db, id, stored, by.trim(), clock);
  // Fixed id: a retry after a crash between the row and the decision finds the same record.
  const decision = recordDecision(
    db,
    runDir,
    {
      id: answerDecisionId(id),
      runId: question.runId,
      kind: ANSWER_DECISION_KIND,
      summary: `${matched ? `chose "${matched.label}"` : 'answered'}: ${question.question}`,
      data: { question_id: id, answer: stored, chosen_option: matched?.label ?? null, free_text: matched === null, answered_by: by.trim(), material: question.material, affected: question.affected, ...(opts.provenance ? { provenance: opts.provenance } : {}) },
    },
    clock,
    { actor: by.trim() },
  );
  // The answer to a baseline-exception question is applied to the run's contract here, while the person is answering:
  // "Approve" adds the exception through the amendment rules, anything else leaves the contract alone.
  let baselineException: BaselineApplyOutcome | null = null;
  try {
    baselineException = applyBaselineExceptionAnswers({ db, clock, runId: question.runId, runDir }, { questionId: id }).outcomes[0] ?? null;
  } catch (err) {
    // The answer itself is recorded; the controller retries the application at its next step.
    db.tx(() => appendEvent(db, question.runId, 'baseline-exception.apply-failed', by.trim(), { question_id: id, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 500) }, clock.now()));
  }
  return { question, decision, chosenOption: matched, unblocks: question.affected, baselineException };
}

export function openQuestions(db: OrbitDb, runId: string): QuestionRecord[] {
  return listQuestions(db, runId, { status: 'open' });
}

/** Criterion ids blocked by questions still waiting for an answer. */
export function criteriaBlockedByQuestions(questions: readonly QuestionRecord[]): string[] {
  const out = new Set<string>();
  for (const q of questions) {
    if (q.status !== 'open' || !q.material) continue;
    for (const w of q.affected) if (AC_ID.test(w)) out.add(w);
  }
  return [...out].sort();
}
