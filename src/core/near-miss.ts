/**
 * "Did you mean" for a word a person typed: the CLI's command names and the config's keys and allowed values use the
 * same rule, so a typo gets the same help wherever it is made.
 */

/** Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length]!;
}

/** The candidate closest to `word` when it is plausibly a typo of it (distance at most a third of the word, and at least 1 or 2). */
export function closest(word: string, candidates: readonly string[]): string | null {
  const limit = Math.max(2, Math.floor(word.length / 3));
  let best: { name: string; d: number } | null = null;
  for (const name of candidates) {
    const d = editDistance(word.toLowerCase(), name.toLowerCase());
    if (d <= limit && (best === null || d < best.d)) best = { name, d };
  }
  return best?.name ?? null;
}
