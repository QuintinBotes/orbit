import { OrbitError } from '../core/errors.ts';
import type { DiagnosisOutput } from '../contract/model-outputs.ts';
import type { RepairBrief } from '../evidence/types.ts';
import { wordTokens } from '../contract/wording.ts';
import { isNewHypothesis, type HypothesisNovelty, type PriorHypothesis } from './hypotheses.ts';

/**
 * Repair briefs and progress (spec sections 7 and 14). A brief is the only
 * thing a repair worker acts on, so it must say what failed (fingerprint and
 * evidence), why (competing hypotheses), how to find out (experiment and
 * expected observation), what to change (a scoped fix), how it will be judged
 * (post-fix checks the policy defines) and what must not break (preserved
 * constraints, protected tests included). Progress is measured on outcomes;
 * tokens spent and lines changed are never progress.
 */

export interface BriefContext {
  /** Check ids the frozen policy defines; post-fix checks must come from here. */
  policyCheckIds: readonly string[];
  /** Tests no repair may touch; each must appear among the preserved constraints. */
  protectedTests?: readonly string[];
  /** The fingerprint being repaired; the brief must be about this failure. */
  expectedFingerprint?: string;
  /** Hypotheses already tried for this run, to refuse a brief that only rewords them. */
  priorHypotheses?: readonly PriorHypothesis[];
}

export interface RepairBriefValidation {
  valid: boolean;
  problems: string[];
  /** Novelty of each hypothesis against the priors; empty without priors. */
  novelty: { index: number; novelty: HypothesisNovelty }[];
}

/** Placeholders and verbs with no object: a brief made of these tells a worker nothing. */
const PLACEHOLDER = /^\s*(tbd|todo|n\/a|na|none|unknown|nothing|-+|\.+)\s*\.?\s*$/i;
const GENERIC_ACTION = /^\s*(investigate|look into|debug|check|figure out|fix|try|examine|review|analy[sz]e)( (the|this|it))?( (issue|problem|bug|failure|error|code|thing|it|this))?\s*\.?\s*$/i;
const BROAD_FIX = /\b(rewrite|refactor|rework|overhaul|redo|replace)\b.{0,40}\b(everything|entire|whole|all|codebase|system|project)\b|\b(fix|change|update) (everything|all (of )?(the )?(tests|code|files))\b/i;

function specific(text: unknown, minWords: number): text is string {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  return t.length > 0 && !PLACEHOLDER.test(t) && !GENERIC_ACTION.test(t) && wordTokens(t).length >= minWords;
}

function samePath(a: string, b: string): boolean {
  return a.replace(/^\.\//, '') === b.replace(/^\.\//, '');
}

export function validateRepairBrief(brief: unknown, ctx: BriefContext): RepairBriefValidation {
  const problems: string[] = [];
  const novelty: RepairBriefValidation['novelty'] = [];
  if (brief === null || typeof brief !== 'object' || Array.isArray(brief)) return { valid: false, problems: ['repair brief must be an object'], novelty };
  const b = brief as Partial<RepairBrief> & Record<string, unknown>;

  if (typeof b.fingerprint !== 'string' || b.fingerprint.trim() === '' || PLACEHOLDER.test(b.fingerprint)) problems.push('fingerprint is missing');
  else if (ctx.expectedFingerprint !== undefined && b.fingerprint.trim() !== ctx.expectedFingerprint) {
    problems.push(`fingerprint ${b.fingerprint.trim()} is not the failure being repaired (${ctx.expectedFingerprint})`);
  }

  if (!Array.isArray(b.evidence) || b.evidence.length === 0) problems.push('evidence is missing: cite the log lines, check results or paths that show the failure');
  else if (b.evidence.some((e) => !specific(e, 3))) problems.push('each evidence entry must state something observed (not a placeholder or a bare instruction)');

  const hyps = Array.isArray(b.hypotheses) ? b.hypotheses : [];
  if (hyps.length === 0) problems.push('at least one hypothesis is required');
  hyps.forEach((h: { statement?: unknown; supporting?: unknown; refuting?: unknown } | null, i) => {
    if (!h || !specific(h.statement, 3)) problems.push(`hypothesis ${i + 1} needs a specific causal statement`);
    if (!h || !specific(h.supporting, 3)) problems.push(`hypothesis ${i + 1} needs the evidence supporting it`);
    if (h && h.refuting !== undefined && h.refuting !== null && typeof h.refuting !== 'string') problems.push(`hypothesis ${i + 1}: refuting must be text when present`);
  });
  // Rewordings inside one brief do not make it a set of competing hypotheses.
  const fp = typeof b.fingerprint === 'string' ? b.fingerprint.trim() : '';
  const seen: PriorHypothesis[] = [];
  hyps.forEach((h: { statement?: unknown } | null, i) => {
    if (!h || typeof h.statement !== 'string' || h.statement.trim() === '') return;
    const input = { statement: h.statement, fingerprint: fp, experiment: typeof b.experiment === 'string' ? b.experiment : null, expectedObservation: typeof b.expected_observation === 'string' ? b.expected_observation : null };
    // Within one brief every hypothesis shares the experiment, so compare causes only.
    const own = isNewHypothesis({ statement: input.statement, fingerprint: fp }, seen);
    if (!own.isNew) problems.push(own.matchedId === null ? `hypothesis ${i + 1}: ${own.reason}` : `hypothesis ${i + 1} restates ${own.matchedId}: reworded causes are not competing hypotheses`);
    seen.push({ id: `hypothesis ${i + 1}`, statement: h.statement, fingerprint: fp, experiment: null, expectedObservation: null, status: 'proposed' });
    if (ctx.priorHypotheses && ctx.priorHypotheses.length > 0) novelty.push({ index: i, novelty: isNewHypothesis(input, ctx.priorHypotheses) });
  });
  if (novelty.length > 0 && !novelty.some((n) => n.novelty.kind !== 'duplicate')) {
    problems.push(`no hypothesis is new: ${novelty.map((n) => `#${n.index + 1} ${n.novelty.reason}`).join('; ')}`);
  }

  if (!specific(b.experiment, 4)) problems.push('experiment must be a specific, runnable investigation (not "investigate" or "debug")');
  if (!specific(b.expected_observation, 4)) problems.push('expected_observation must say what the experiment will show if the leading hypothesis is true');
  if (!specific(b.scoped_fix, 5)) problems.push('scoped_fix must name what to change');
  else if (BROAD_FIX.test(b.scoped_fix)) problems.push('scoped_fix is not scoped: a repair changes the cause, not everything near it');

  const known = new Set(ctx.policyCheckIds);
  if (!Array.isArray(b.post_fix_checks) || b.post_fix_checks.length === 0) problems.push('post_fix_checks must name at least one check');
  else {
    const unknown = b.post_fix_checks.filter((c) => typeof c !== 'string' || !known.has(c.trim()));
    if (unknown.length > 0) problems.push(`post_fix_checks must be check ids defined in policy; unknown: ${unknown.map(String).join(', ')}`);
  }

  if (!Array.isArray(b.preserved_constraints) || b.preserved_constraints.length === 0) problems.push('preserved_constraints must name what the repair must not break');
  else {
    if (b.preserved_constraints.some((c) => !specific(c, 3))) problems.push('each preserved constraint must be specific');
    for (const t of ctx.protectedTests ?? []) {
      // Prose puts a full stop or colon right after the path; strip it, but only at the end so "export.test.ts.bak" stays a different file.
      if (!b.preserved_constraints.some((c) => typeof c === 'string' && c.split(/[\s"'`,;()]+/).some((tok) => samePath(tok.replace(/[.:!?]+$/, ''), t)))) {
        problems.push(`preserved_constraints must include the protected test ${t}`);
      }
    }
  }
  return { valid: problems.length === 0, problems, novelty };
}

/** The diagnosis schema writes an absent refutation as null; the brief type leaves it out. */
export function briefFromDiagnosis(out: Pick<DiagnosisOutput, 'repair_brief'>): RepairBrief {
  const r = out.repair_brief;
  return {
    fingerprint: r.fingerprint,
    evidence: r.evidence,
    hypotheses: r.hypotheses.map((h) => (h.refuting === null ? { statement: h.statement, supporting: h.supporting } : { statement: h.statement, supporting: h.supporting, refuting: h.refuting })),
    experiment: r.experiment,
    expected_observation: r.expected_observation,
    scoped_fix: r.scoped_fix,
    post_fix_checks: r.post_fix_checks,
    preserved_constraints: r.preserved_constraints,
  };
}

// ---------------------------------------------------------------------------
// Progress

/** What one attempt established. `tokens` and `diffLines` are accepted so callers can pass the whole row; they are never read for progress. */
export interface AttemptSnapshot {
  attempt: number;
  supportedCriteria: readonly string[];
  /** Mandatory checks that passed on this attempt's candidate. */
  passingMandatoryChecks: readonly string[];
  failingMandatoryChecks: readonly string[];
  failureFingerprints: readonly string[];
  /** Cumulative: every hypothesis conclusively eliminated so far. */
  eliminatedHypotheses: readonly string[];
  /** Where the fault is, once known (path:symbol or fingerprint plus location). */
  localizedFault: string | null;
  /** Cumulative: questions and ambiguities resolved so far. */
  resolvedAmbiguities: readonly string[];
  tokens?: number;
  diffLines?: number;
  /** The candidate tree the attempt produced, when known: an attempt that reproduces an earlier tree changed nothing. */
  treeHash?: string;
}

/** Spec section 7 progress record; the key names match scheduling's ProgressReport. */
export interface ProgressRecord {
  newly_supported_criteria: string[];
  fixed_checks: string[];
  eliminated_hypotheses: string[];
  localized_fault: string | null;
  resolved_ambiguity: string[];
  regressions: { lost_criteria: string[]; newly_failing_checks: string[] };
  made_progress: boolean;
  summary: string;
  /** Measurements that were offered and deliberately not counted. */
  ignored: string[];
}

const EMPTY: AttemptSnapshot = {
  attempt: 0,
  supportedCriteria: [],
  passingMandatoryChecks: [],
  failingMandatoryChecks: [],
  failureFingerprints: [],
  eliminatedHypotheses: [],
  localizedFault: null,
  resolvedAmbiguities: [],
};

function minus(a: readonly string[], b: readonly string[]): string[] {
  const s = new Set(b);
  return a.filter((x) => !s.has(x));
}

/**
 * What the current attempt achieved over the previous one (null: nothing
 * established yet). Gains count only when they outweigh what was lost: fixing
 * one check while breaking another is a swap, not progress, and accepting
 * swaps would let a repair loop run forever.
 */
export function progressSince(previous: AttemptSnapshot | null, current: AttemptSnapshot): ProgressRecord {
  const prev = previous ?? EMPTY;
  const newlySupported = minus(current.supportedCriteria, prev.supportedCriteria);
  // A check counts as fixed only if it was failing and now demonstrably passes, not merely absent.
  const fixed = prev.failingMandatoryChecks.filter((c) => current.passingMandatoryChecks.includes(c) && !current.failingMandatoryChecks.includes(c));
  const eliminated = minus(current.eliminatedHypotheses, prev.eliminatedHypotheses);
  const resolved = minus(current.resolvedAmbiguities, prev.resolvedAmbiguities);
  // Only the first localization is new knowledge. A fault that "moves" each attempt is a belief being revised, and counting every revision would let a loop that never converges look like steady progress forever.
  const hadLocation = prev.localizedFault !== null && prev.localizedFault.trim() !== '';
  const localized = !hadLocation && current.localizedFault !== null && current.localizedFault.trim() !== '' ? current.localizedFault : null;
  const lost = minus(prev.supportedCriteria, current.supportedCriteria);
  const newlyFailing = current.failingMandatoryChecks.filter((c) => prev.passingMandatoryChecks.includes(c));

  const gains = newlySupported.length + fixed.length + eliminated.length + resolved.length + (localized === null ? 0 : 1);
  const losses = lost.length + newlyFailing.length;
  const madeProgress = gains > 0 && gains > losses;

  const ignored: string[] = [];
  if (current.tokens !== undefined && previous?.tokens !== undefined && current.tokens > previous.tokens) ignored.push('more tokens spent');
  if (current.diffLines !== undefined && previous?.diffLines !== undefined && current.diffLines > previous.diffLines) ignored.push('larger diff');

  const parts: string[] = [];
  if (newlySupported.length) parts.push(`newly supported ${newlySupported.join(', ')}`);
  if (fixed.length) parts.push(`fixed ${fixed.join(', ')}`);
  if (eliminated.length) parts.push(`eliminated ${eliminated.join(', ')}`);
  if (resolved.length) parts.push(`resolved ${resolved.join(', ')}`);
  if (localized !== null) parts.push(`localized fault at ${localized}`);
  if (losses > 0) parts.push(`but lost ${[...lost, ...newlyFailing].join(', ')}`);
  const summary = gains === 0 ? 'no measurable progress' : madeProgress ? parts.join('; ') : `no net progress: ${parts.join('; ')}`;
  return {
    newly_supported_criteria: newlySupported,
    fixed_checks: fixed,
    eliminated_hypotheses: eliminated,
    localized_fault: localized,
    resolved_ambiguity: resolved,
    regressions: { lost_criteria: lost, newly_failing_checks: newlyFailing },
    made_progress: madeProgress,
    summary,
    ignored,
  };
}

export interface NonProgressDecision {
  terminate: boolean;
  reason: string;
  /** Trailing attempts, counted back from the latest, that made no progress. */
  consecutiveNoProgress: number;
  threshold: number;
  /** A fingerprint every non-progress attempt shared, when there is one. */
  fingerprint: string | null;
  /** The state the controller should move to when `terminate` is true. */
  suggestedState: 'EXHAUSTED' | null;
}

/** Attempts without progress that end a repair loop: one more than the repeated-failure threshold that called the Inquisition in. */
export function nonProgressThreshold(repeatedFailureThreshold: number): number {
  return repeatedFailureThreshold + 1;
}

/**
 * Scenario 6. History is the attempts in order, oldest first. The loop ends
 * when `threshold` consecutive attempts, counted from the latest, each failed
 * to improve on the one before. An attempt that made progress resets the
 * count, so a slow repair is not cut off, but the same failure going round
 * again is.
 */
export function nonProgress(history: readonly AttemptSnapshot[], threshold: number): NonProgressDecision {
  if (!Number.isInteger(threshold) || threshold < 1) throw new OrbitError('INTERNAL', `non-progress threshold must be a positive integer, got ${threshold}`);
  let streak = 0;
  // The first attempt has no predecessor and no baseline of failing checks to be credited against, so it can neither count as progress nor against it.
  for (let i = history.length - 1; i >= 1; i--) {
    if (progressSince(history[i - 1]!, history[i]!).made_progress) break;
    streak++;
  }
  const recent = history.slice(history.length - streak);
  let fingerprint: string | null = null;
  if (streak > 0) {
    const shared = recent[0]!.failureFingerprints.filter((f) => recent.every((a) => a.failureFingerprints.includes(f)));
    fingerprint = shared[0] ?? null;
  }
  const terminate = streak >= threshold;
  // The plainest non-progress there is: a stalled attempt produced exactly the tree of an earlier one.
  let sameTreeAs: number | null = null;
  for (const a of recent) {
    if (a.treeHash === undefined) continue;
    const earlier = history.find((h) => h.attempt < a.attempt && h.treeHash === a.treeHash);
    if (earlier) {
      sameTreeAs = earlier.attempt;
      break;
    }
  }
  const sameTree = sameTreeAs !== null ? `: no measurable progress (same tree as attempt ${sameTreeAs})` : '';
  const reason = terminate
    ? `${streak} consecutive attempts made no progress${sameTree}${fingerprint ? ` (the same failure, ${fingerprint}, each time)` : ''}; more attempts, tokens or lines would not change that`
    : streak === 0
      ? 'the latest attempt made progress'
      : `${streak} of ${threshold} attempts without progress`;
  return { terminate, reason, consecutiveNoProgress: streak, threshold, fingerprint, suggestedState: terminate ? 'EXHAUSTED' : null };
}
