/**
 * Conservative comparison of an old and a new requirement statement. Spec
 * section 6 lets Inquisition clarify a requirement but not weaken or redefine
 * it, and a model can always argue that a rewrite "only clarifies".
 *
 * Plain words narrow a requirement as easily as hedges do ("for the demo
 * dataset", "in a mocked environment", "archived records aside"), so no list
 * of suspicious words can be complete. The test is therefore closed: the new
 * text must keep every word of the old one, in order, and may add only words
 * from a short list that cannot narrow anything (articles, "and", emphasis).
 * Any other rewrite needs a human decision. Inquisition can still make a
 * requirement more precise without one by adding a derived criterion or
 * proof entry, which never removes an obligation. False alarms cost an
 * approval; misses cost proof.
 */

/** Words a clarification may add: they can only restate or strengthen. */
const NEUTRAL_ADDITIONS = new Set([
  'a', 'an', 'the', 'and', 'also', 'all', 'every', 'each', 'both', 'always', 'must',
  'fully', 'entire', 'entirely', 'whole', 'complete', 'completely', 'correctly', 'exactly', 'strictly',
]);

/** Reported by name because they are the common ways of hedging or narrowing. */
const QUALIFIER_WORDS = new Set([
  // exceptions and narrowing
  'only', 'except', 'excepting', 'excluding', 'exclude', 'excludes', 'unless', 'but', 'however', 'subset', 'partial', 'partially',
  'some', 'first', 'limit', 'limits', 'limited', 'max', 'maximum', 'most', 'least', 'until', 'before', 'after',
  // negation
  'not', 'no', 'never', 'without', 'none', 'nor', 'cannot', 'don', 'doesn', 'didn', 'isn', 'aren', 'wasn', 'weren', 'won', 'wouldn', 'shouldn', 'couldn', 't',
  // hedges and modality
  'may', 'might', 'optionally', 'optional', 'should', 'could', 'can', 'ideally', 'preferably', 'possible', 'possibly', 'feasible',
  'approximately', 'roughly', 'about', 'around', 'mostly', 'generally', 'usually', 'typically', 'eventually', 'later', 'temporarily',
  'attempt', 'attempts', 'try', 'tries', 'best', 'effort',
  // conditions
  'if', 'when', 'whenever', 'where', 'while', 'provided', 'assuming',
  // alternatives and replacement
  'or', 'either', 'alternatively', 'instead', 'otherwise', 'rather', 'replace', 'replaces', 'replaced',
  // skipping
  'skip', 'skips', 'skipped', 'ignore', 'ignores', 'ignored', 'omit', 'omits', 'omitted', 'drop', 'drops', 'dropped', 'remove', 'removes', 'removed',
]);

const MAX_LISTED_WORDS = 8;

const QUALIFIER_PHRASES = ['up to', 'at most', 'no more than', 'less than', 'fewer than', 'for now', 'as needed', 'as appropriate', 'or similar', 'and or'];

/** Lowercase word tokens; punctuation and spacing do not matter. */
export function wordTokens(text: string): string[] {
  return text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

function isSubsequence(needle: readonly string[], hay: readonly string[]): boolean {
  let i = 0;
  for (const t of hay) {
    if (i < needle.length && needle[i] === t) i++;
  }
  return i === needle.length;
}

function countPhrase(tokens: readonly string[], phrase: string): number {
  const words = phrase.split(' ');
  let n = 0;
  for (let i = 0; i + words.length <= tokens.length; i++) {
    if (words.every((w, k) => tokens[i + k] === w)) n++;
  }
  return n;
}

function countWord(tokens: readonly string[], word: string): number {
  return tokens.reduce((n, t) => (t === word ? n + 1 : n), 0);
}

export interface WordingVerdict {
  clarification: boolean;
  /** Why the change is not a pure clarification; empty when it is. */
  reasons: string[];
}

/** Whether `next` only clarifies `prev` (keeps all its words, adds only neutral ones). */
export function compareWording(prev: string, next: string): WordingVerdict {
  const a = wordTokens(prev);
  const b = wordTokens(next);
  const reasons: string[] = [];
  if (b.length === 0) reasons.push('the new text is empty');
  if (!isSubsequence(a, b)) reasons.push('the new text drops or reorders words of the old text');
  const qualifiers = new Set<string>();
  const others = new Set<string>();
  for (const w of new Set(b)) {
    if (countWord(b, w) <= countWord(a, w)) continue;
    if (QUALIFIER_WORDS.has(w)) qualifiers.add(w);
    else if (!NEUTRAL_ADDITIONS.has(w)) others.add(w);
  }
  for (const p of QUALIFIER_PHRASES) {
    if (countPhrase(b, p) > countPhrase(a, p)) qualifiers.add(p);
  }
  if (qualifiers.size > 0) reasons.push(`the new text adds qualifying language (${[...qualifiers].sort().join(', ')})`);
  if (others.size > 0) {
    const shown = [...others].slice(0, MAX_LISTED_WORDS);
    const more = others.size > shown.length ? `, and ${others.size - shown.length} more` : '';
    reasons.push(`the new text adds words that can narrow or redefine it (${shown.join(', ')}${more})`);
  }
  return { clarification: reasons.length === 0, reasons };
}

/** Normalized form used to compare proof entries and list items. */
export function normalizeEntry(text: string): string {
  return wordTokens(text).join(' ');
}
