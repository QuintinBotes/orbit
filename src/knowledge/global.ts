import { canonicalJson } from '../core/hash.ts';
import type { KnowledgeStore } from './store.ts';
import type { Lesson } from './types.ts';
import { authorityViolations, lessonText } from './authority.ts';
import { codeFreeViolations, mentionsRepoTerm, shareableText, travellingText } from './codefree.ts';

/**
 * Promotion from a repository's graph into the opt-in global graph, which
 * feeds every other repository's prompts. Four independent gates, all
 * required, checked in this order so the cheapest refusal comes first:
 *
 *   1. the repository is configured knowledge.share_globally: true
 *      (otherwise nothing is read, checked or written);
 *   2. the lesson is validated and claims code_free;
 *   3. a heuristic re-check finds no paths, code or identifiers in its prose,
 *      and no name known to belong to the repository in any field it carries
 *      (check ids and framework names included);
 *   4. the publication guard, injected so this module does not depend on
 *      guard/, finds no private term or identity in the exact document that
 *      would be written, asked twice: once about the canonical JSON and once
 *      about its strings as plain text. JSON escaping turns a line break into
 *      a backslash and a letter, so a term split across lines would match in
 *      the text a model reads but not in the JSON.
 *
 * The global copy drops what only makes sense inside the source repository:
 * applicability.paths, and the evidence references (run ids and run-directory
 * artifact paths that resolve nowhere else). Provenance keeps the repository
 * lesson id it was derived from.
 */

export interface GuardVerdict {
  allowed: boolean;
  /** Stable rule id for the report; never the matched text. */
  rule?: string;
}

/** The shape guard/ checkPublication returns; only `ok` and the violation kinds are read. */
export interface GuardResult {
  ok: boolean;
  violations?: readonly { kind: string }[];
}

/**
 * Publication guard check over the exact text that would leave the
 * repository. A boolean, a GuardVerdict or checkPublication's own result are
 * all accepted, so the controller can pass the guard through unchanged.
 */
export type PublicationCheck = (text: string) => GuardVerdict | GuardResult | boolean | Promise<GuardVerdict | GuardResult | boolean>;

export interface GlobalPromotionOptions {
  /** The source repository's knowledge.share_globally setting. */
  shareGlobally: boolean;
  guard: PublicationCheck;
  /** Names that belong to the source repository (file basenames, symbols, package and product names). */
  repoTerms?: readonly string[];
}

export interface GlobalPromotionReport {
  /** False when share_globally is off: nothing was read or written. */
  ran: boolean;
  promoted: { lessonId: string; globalId: string; created: boolean }[];
  refused: { lessonId: string; reason: string }[];
}

/** The form a lesson takes in the global graph. */
export function toGlobalLesson(lesson: Lesson): Lesson {
  return {
    ...lesson,
    scope: 'global',
    applicability: { ...lesson.applicability, paths: [] },
    evidence: [],
    provenance: {
      ...lesson.provenance,
      uri: null,
      derived_from: [lesson.id],
    },
    supersedes: null,
  };
}

async function askGuard(guard: PublicationCheck, text: string): Promise<{ ok: boolean; reason: string }> {
  try {
    const verdict = await guard(text);
    if (typeof verdict === 'boolean') return verdict ? { ok: true, reason: '' } : { ok: false, reason: 'publication guard refused' };
    const allowed = 'allowed' in verdict ? verdict.allowed === true : verdict.ok === true;
    if (allowed) return { ok: true, reason: '' };
    // Only fixed identifiers reach the report: a rule id, or the violation kinds.
    const labels = 'allowed' in verdict ? [verdict.rule] : [...new Set((verdict.violations ?? []).map((v) => v.kind))].sort();
    const safe = labels.filter((l): l is string => typeof l === 'string' && /^[\w.:-]{1,40}$/.test(l));
    return { ok: false, reason: `publication guard refused${safe.length > 0 ? ` (${safe.join(', ')})` : ''}` };
  } catch {
    // Fail closed: a guard that cannot answer has not said yes.
    return { ok: false, reason: 'publication guard failed' };
  }
}

/** Every string in the document, unescaped, one per line: what a reader of the lesson actually sees. */
function plainText(value: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(value);
  return out.join('\n');
}

/** Why one lesson may not go global, before the guard is asked; null when it may. */
export function globalRefusal(lesson: Lesson, repoTerms: readonly string[] = []): string | null {
  if (lesson.status !== 'validated') return `status is ${lesson.status}, not validated`;
  if (!lesson.code_free) return 'not marked code_free';
  const global = toGlobalLesson(lesson);
  const reasons = codeFreeViolations(shareableText(global));
  if (mentionsRepoTerm(travellingText(global), repoTerms)) reasons.push('repository identifier');
  if (reasons.length > 0) return `not code-free: ${reasons.join(', ')}`;
  const authority = authorityViolations(lessonText(global));
  if (authority.length > 0) return `authority language (${authority.join(', ')})`;
  return null;
}

/**
 * Copy every eligible validated lesson from `repoStore` into `globalStore`.
 * Returns immediately, touching neither store and never calling the guard,
 * when shareGlobally is not exactly true.
 */
export async function promoteToGlobal(repoStore: KnowledgeStore, globalStore: KnowledgeStore, options: GlobalPromotionOptions): Promise<GlobalPromotionReport> {
  const report: GlobalPromotionReport = { ran: false, promoted: [], refused: [] };
  if (options.shareGlobally !== true) return report;
  report.ran = true;
  for (const lesson of repoStore.listLessons({ statuses: ['validated'] })) {
    const refusal = globalRefusal(lesson, options.repoTerms ?? []);
    if (refusal) {
      report.refused.push({ lessonId: lesson.id, reason: refusal });
      continue;
    }
    const global = toGlobalLesson(lesson);
    let verdict = await askGuard(options.guard, canonicalJson(global));
    if (verdict.ok) verdict = await askGuard(options.guard, plainText(global));
    if (!verdict.ok) {
      report.refused.push({ lessonId: lesson.id, reason: verdict.reason });
      continue;
    }
    try {
      const res = globalStore.upsertLesson(global);
      report.promoted.push({ lessonId: lesson.id, globalId: res.lesson.id, created: res.created });
    } catch (err) {
      report.refused.push({ lessonId: lesson.id, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return report;
}
