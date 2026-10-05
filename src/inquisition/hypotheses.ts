import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { hashObject } from '../core/hash.ts';
import { insertHypothesis, getHypothesis, listHypotheses, writeHypothesis, type HypothesisRecord } from './store.ts';

/**
 * Causal hypotheses and their experiments (spec section 14: "Changing wording
 * is not a new causal hypothesis. Compare fingerprints, diffs, observations,
 * supported criteria, and experiment results.").
 *
 * Novelty is decided on structure, never on wording alone. Two statements are
 * the same cause when, for the same failure fingerprint, their normalized
 * content agrees (stop words and inflection removed, same polarity, same
 * identifiers and numbers) and they are tested the same way (same experiment
 * or same expected observation). A reworded cause with the same test is a
 * duplicate; a statement that flips polarity ("key includes the tenant" vs
 * "key omits the tenant") or names a different identifier is a different
 * cause even when most words match. The same cause under a genuinely
 * different experiment is a retest, allowed only when the earlier test was
 * inconclusive. Every duplicate carries the id it duplicates, so the
 * scheduler's "materially new hypothesis" requirement can cite why it failed.
 */

const STOP = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'of', 'to', 'in', 'on', 'at', 'for', 'by', 'with', 'from', 'as', 'that', 'this', 'these', 'those',
  'it', 'its', 'and', 'or', 'but', 'so', 'then', 'than', 'because', 'since', 'due', 'which', 'when', 'while', 'if', 'also', 'again', 'still', 'just', 'really', 'actually',
  'probably', 'likely', 'maybe', 'perhaps', 'seems', 'seem', 'appears', 'appear', 'might', 'may', 'could', 'would', 'should', 'will', 'can', 'do', 'does', 'did', 'has', 'have', 'had',
  'think', 'thought', 'guess', 'cause', 'caused', 'causes', 'causing', 'issue', 'problem', 'bug', 'root', 'hypothesis', 'theory', 'we', 'i', 'our', 'there', 'their', 'they', 'into', 'out', 'up', 'over',
]);

const NEGATION = new Set([
  'not', 'no', 'never', 'without', 'missing', 'lacks', 'lack', 'lacking', 'omit', 'omits', 'omitted', 'omitting', 'ignore', 'ignores', 'ignored', 'ignoring',
  'absent', 'cannot', 'nor', 'neither', 'doesn', 'don', 'isn', 'aren', 'wasn', 'didn',
]);

/** Words that mean the same thing for test purposes; folded to one stem before comparing. */
const FOLD: Record<string, string> = {
  identifier: 'id', identifiers: 'id', ids: 'id',
  returns: 'return', returned: 'return', emits: 'return',
  throws: 'throw', raised: 'throw', raises: 'throw',
};

/** Identifier-like tokens: backticked text, paths, numbers, camelCase, snake_case, CONSTANTS. They must match exactly. */
const ANCHOR = /`([^`]+)`|[\w-]+(?:[/.][\w-]+)+|\b\d+(?:\.\d+)?\b|\b[a-z]+[A-Z]\w*\b|\b[A-Z][A-Z0-9_]{2,}\b|\b[a-z0-9]+_[a-z0-9_]+\b/g;

export interface NormalizedText {
  /** Sorted unique stems with stop words and negations removed. */
  tokens: string[];
  /** Any negation or absence word: the statement asserts something is missing or not done. Parity is not used, so a second negation elsewhere in the sentence cannot flip it back. */
  negated: boolean;
  /** Sorted unique identifiers and numbers, lowercased. */
  anchors: string[];
}

export interface HypothesisInput {
  statement: string;
  /** The fingerprint of the failure this hypothesis tries to explain. */
  fingerprint: string;
  experiment?: string | null;
  expectedObservation?: string | null;
}

export interface NormalizedHypothesis {
  content: NormalizedText;
  experiment: NormalizedText | null;
  observation: NormalizedText | null;
  fingerprint: string;
  /** Hash of the normalized content and fingerprint: equal for pure rewordings. */
  hash: string;
}

/** "dropped" and "drops" both reach "drop". */
function undouble(w: string): string {
  return w.length > 3 && w[w.length - 1] === w[w.length - 2] && !/[aeiouls]/.test(w[w.length - 1]!) ? w.slice(0, -1) : w;
}

function stem(w: string): string {
  const folded = FOLD[w];
  if (folded !== undefined) return folded;
  if (w.length > 5 && w.endsWith('ing')) return undouble(w.slice(0, -3));
  if (w.length > 4 && w.endsWith('ied')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('ed')) return undouble(w.slice(0, -2));
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function normalizeText(text: string): NormalizedText {
  const anchors = new Set<string>();
  for (const m of text.matchAll(ANCHOR)) anchors.add((m[1] ?? m[0]).toLowerCase());
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  let negations = 0;
  const tokens = new Set<string>();
  for (const w of words) {
    if (NEGATION.has(w)) {
      negations++;
      continue;
    }
    if (STOP.has(w)) continue;
    tokens.add(stem(w));
  }
  return { tokens: [...tokens].sort(), negated: negations > 0, anchors: [...anchors].sort() };
}

export function normalizeHypothesis(h: HypothesisInput): NormalizedHypothesis {
  const content = normalizeText(h.statement);
  return {
    content,
    experiment: h.experiment ? normalizeText(h.experiment) : null,
    observation: h.expectedObservation ? normalizeText(h.expectedObservation) : null,
    fingerprint: h.fingerprint,
    hash: hashObject({ t: content.tokens, n: content.negated, a: content.anchors, f: h.fingerprint }),
  };
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const sb = new Set(b);
  let inter = 0;
  for (const t of a) if (sb.has(t)) inter++;
  return inter / (a.length + b.length - inter);
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/**
 * Short statements share words by accident: "timeout is too short" and
 * "timeout is too long" overlap by half yet name opposite causes. The fewer
 * distinct words in play, the closer the match must be.
 */
function sizeFloor(a: readonly string[], b: readonly string[]): number {
  const union = new Set([...a, ...b]).size;
  return union <= 5 ? 0.75 : union <= 8 ? 0.6 : 0;
}

function similar(a: NormalizedText, b: NormalizedText, threshold: number): boolean {
  return a.negated === b.negated && sameSet(a.anchors, b.anchors) && jaccard(a.tokens, b.tokens) >= Math.max(threshold, sizeFloor(a.tokens, b.tokens));
}

const CONTENT_THRESHOLD = 0.5;
const TEST_THRESHOLD = 0.7;

export type HypothesisNoveltyKind = 'new' | 'duplicate' | 'retest';

export interface HypothesisNovelty {
  /** True only for a materially new causal hypothesis. Rewordings and retests are false. */
  isNew: boolean;
  kind: HypothesisNoveltyKind;
  reason: string;
  /** The earlier hypothesis this one repeats or retests. */
  matchedId: string | null;
}

export interface PriorHypothesis {
  id: string;
  statement: string;
  fingerprint: string;
  experiment: string | null;
  expectedObservation: string | null;
  status: HypothesisRecord['status'];
}

/** Whether a statement says anything a test could be about: a content word or an identifier. */
export function namesACause(statement: string): boolean {
  const t = normalizeText(statement);
  return t.tokens.length > 0 || t.anchors.length > 0;
}

export function isNewHypothesis(candidate: HypothesisInput, priors: readonly PriorHypothesis[]): HypothesisNovelty {
  // Two statements with no content normalise identically to nothing, so no comparison could ever call them the same: without this guard every vacuous rewording would count as a new hypothesis and buy an extra attempt.
  if (!namesACause(candidate.statement)) return { isNew: false, kind: 'duplicate', matchedId: null, reason: 'the statement names no cause (only hedges and filler words), so it cannot be a new hypothesis' };
  const c = normalizeHypothesis(candidate);
  let retest: HypothesisNovelty | null = null;
  let differentFailure = 0;
  for (const prior of priors) {
    if (prior.fingerprint !== candidate.fingerprint) {
      differentFailure++;
      continue;
    }
    const p = normalizeHypothesis(prior);
    const sameContent = similar(c.content, p.content, CONTENT_THRESHOLD);
    const sameExperiment = c.experiment !== null && p.experiment !== null && similar(c.experiment, p.experiment, TEST_THRESHOLD);
    const sameObservation = c.observation !== null && p.observation !== null && similar(c.observation, p.observation, TEST_THRESHOLD);
    const hasTest = (c.experiment !== null || c.observation !== null) && (p.experiment !== null || p.observation !== null);

    if (sameContent && (!hasTest || sameExperiment || sameObservation)) {
      return { isNew: false, kind: 'duplicate', matchedId: prior.id, reason: `same cause and same test as ${prior.id} (${prior.status}); different wording is not a new hypothesis` };
    }
    if (!sameContent && sameExperiment && sameObservation) {
      return { isNew: false, kind: 'duplicate', matchedId: prior.id, reason: `reworded cause with the same experiment and expected observation as ${prior.id}; the result would be the same` };
    }
    if (sameContent) {
      // Same cause, different test. Only an inconclusive earlier test leaves anything to learn.
      if (prior.status === 'inconclusive') {
        retest ??= { isNew: false, kind: 'retest', matchedId: prior.id, reason: `same cause as ${prior.id}, whose experiment was inconclusive; a different experiment is a retest, not a new hypothesis` };
      } else {
        return { isNew: false, kind: 'duplicate', matchedId: prior.id, reason: `same cause as ${prior.id} (${prior.status}); a different experiment does not make it a new hypothesis` };
      }
    }
  }
  if (retest) return retest;
  return {
    isNew: true,
    kind: 'new',
    matchedId: null,
    reason: priors.length === 0 ? 'no earlier hypothesis' : differentFailure === priors.length ? 'earlier hypotheses target different failures' : 'differs in cause or in test from every earlier hypothesis for this failure',
  };
}

/** A hypothesis row as the novelty check wants it. */
export function toPrior(h: HypothesisRecord): PriorHypothesis {
  return { id: h.id, statement: h.statement, fingerprint: h.fingerprint, experiment: h.experiment, expectedObservation: h.expectedObservation, status: h.status };
}

export interface ProposeResult {
  novelty: HypothesisNovelty;
  /** The stored hypothesis; null when the proposal duplicated an earlier one and nothing was stored. */
  record: HypothesisRecord | null;
}

/**
 * Store the hypothesis unless it repeats an earlier one. A retest is stored
 * (it is a new experiment on an open question) but is not "new" for budget
 * extension purposes; the caller reads that from `novelty`.
 */
export function proposeHypothesis(db: OrbitDb, runId: string, input: HypothesisInput, clock: Clock): ProposeResult {
  if (!input.statement.trim()) throw new OrbitError('SCHEMA_INVALID', 'a hypothesis needs a statement');
  if (!namesACause(input.statement)) throw new OrbitError('SCHEMA_INVALID', 'a hypothesis must name a cause, not only hedges and filler words');
  if (!input.fingerprint.trim()) throw new OrbitError('SCHEMA_INVALID', 'a hypothesis must name the failure fingerprint it targets');
  return db.tx(() => {
    const novelty = isNewHypothesis(input, listHypotheses(db, runId).map(toPrior));
    if (novelty.kind === 'duplicate') return { novelty, record: null };
    const record = insertHypothesis(
      db,
      { runId, statement: input.statement.trim(), normalizedHash: normalizeHypothesis(input).hash, fingerprint: input.fingerprint, experiment: input.experiment ?? null, expectedObservation: input.expectedObservation ?? null },
      clock,
    );
    return { novelty, record };
  });
}

/**
 * Record the experiment and, before it runs, what each outcome would look
 * like. Fixing the expectation first keeps the result from being explained
 * away afterwards.
 */
export function recordExperiment(db: OrbitDb, hypothesisId: string, input: { experiment: string; expectedObservation: string }, clock: Clock): HypothesisRecord {
  if (!input.experiment.trim()) throw new OrbitError('SCHEMA_INVALID', 'an experiment needs a description');
  if (!input.expectedObservation.trim()) throw new OrbitError('SCHEMA_INVALID', 'an experiment needs an expected observation recorded before it runs');
  return db.tx(() => {
    const h = getHypothesis(db, hypothesisId);
    if (h.status === 'supported' || h.status === 'eliminated') {
      throw new OrbitError('TRANSITION_INVALID', `hypothesis ${hypothesisId} is already ${h.status}; its experiment is settled`, { hypothesisId });
    }
    if (h.status === 'testing') {
      // Re-recording the same plan is a retry after a crash. A different plan would rewrite the prediction after the experiment began, which is the explaining-away this record exists to prevent.
      if (h.experiment === input.experiment.trim() && h.expectedObservation === input.expectedObservation.trim()) return h;
      throw new OrbitError('TRANSITION_INVALID', `hypothesis ${hypothesisId} is already under test; its experiment and expectation are fixed until a result is recorded`, { hypothesisId });
    }
    return writeHypothesis(db, hypothesisId, { status: 'testing', experiment: input.experiment.trim(), expectedObservation: input.expectedObservation.trim() }, clock);
  });
}

export interface ExperimentResult {
  outcome: 'supported' | 'eliminated' | 'inconclusive';
  observation: string;
  /** Check run ids or log paths. Required to support or eliminate a hypothesis. */
  evidence: string[];
}

/**
 * Conclude an experiment. Supporting or eliminating a hypothesis needs
 * evidence a person can look up, because "eliminated" is progress (spec
 * section 7) and unproven progress would buy extra attempts.
 */
export function recordExperimentResult(db: OrbitDb, hypothesisId: string, result: ExperimentResult, clock: Clock): HypothesisRecord {
  if (!result.observation.trim()) throw new OrbitError('SCHEMA_INVALID', 'an experiment result needs the observation');
  const evidence = result.evidence.map((e) => e.trim()).filter((e) => e !== '');
  if (result.outcome !== 'inconclusive' && evidence.length === 0) {
    throw new OrbitError('SCHEMA_INVALID', `a hypothesis can only be ${result.outcome} with evidence`, { hypothesisId });
  }
  return db.tx(() => {
    const h = getHypothesis(db, hypothesisId);
    // Recording the same result again is a retry after a crash, not a second conclusion.
    if (h.status === result.outcome && h.outcome?.observation === result.observation.trim()) return h;
    if (h.status !== 'testing') {
      throw new OrbitError('TRANSITION_INVALID', `hypothesis ${hypothesisId} is ${h.status}; record its experiment before its result`, { hypothesisId });
    }
    // Eliminating a hypothesis counts as progress (spec section 7), so the claim must rest on something this run recorded, not on a string.
    if (result.outcome !== 'inconclusive' && !evidence.some((ref) => recordedByRun(db, h.runId, ref))) {
      throw new OrbitError('NOT_FOUND', `a hypothesis can only be ${result.outcome} on evidence this run recorded (a check run, worker or evidence report id); none of ${evidence.join(', ')} is one`, { hypothesisId });
    }
    return writeHypothesis(db, hypothesisId, { status: result.outcome, outcome: { status: result.outcome, observation: result.observation.trim(), evidence, at: clock.now() } }, clock);
  });
}

function recordedByRun(db: OrbitDb, runId: string, ref: string): boolean {
  for (const table of ['check_runs', 'workers', 'evidence_reports']) {
    if (db.get(`SELECT 1 AS x FROM ${table} WHERE id = ? AND run_id = ?`, ref, runId)) return true;
  }
  return false;
}

export function eliminatedHypothesisIds(db: OrbitDb, runId: string): string[] {
  return listHypotheses(db, runId)
    .filter((h) => h.status === 'eliminated')
    .map((h) => h.id);
}
