/**
 * The requirements of a goal (issue #200, FR-005): every statement that says MUST, in capitals as RFC 2119 writes it,
 * MUST NOT included, where MUST is the verb ("the queue MUST stop") and not the noun ("each MUST in the contract").
 * Each gets one conformance check before delivery. A line labelled with an id (`**FR-004**:`, `SC-001:`, `- FR-2 ...`)
 * keeps that id; any other MUST sentence is numbered MUST-1, MUST-2, ... in the order found. Fenced code is skipped: a
 * MUST in a code sample is not a requirement of the goal.
 */

export interface Requirement {
  /** FR-004, SC-001, or MUST-n. Matches the review output's finding id pattern, so a conformance answer can use it. */
  id: string;
  /** The requirement as written, without list markers or emphasis. */
  wording: string;
}

// MUST as the modal verb ("the queue MUST stop", "MUST NOT log"), not the noun ("each MUST in the contract", "a MUST").
const MUST = /(?<!\b(?:[Aa]n?|[Tt]he|[Ee]ach|[Ee]very|[Pp]er|[Oo]ne|[Tt]his|[Tt]hat|[Aa]ny|[Nn]o)\s+)\bMUST(?:\s+NOT)?\s+[a-z]/;
const LABEL = /^(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?([A-Z][A-Z0-9]*-[0-9]+)[A-Za-z]*(?:\*\*|__)?\s*[:.)-]?\s*(?:\*\*|__)?\s*/;

function clean(text: string): string {
  return text
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*)/, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The sentences of a line that say MUST: a requirement is the sentence, not the paragraph around it. */
function mustSentences(line: string): string[] {
  const sentences: string[] = [];
  for (const piece of line.split(/(?<=[.!?]["')]?)\s+(?=[A-Z*_`"'(])/)) {
    // A full stop inside a quotation ("Page not found. Try /reports.") does not end the sentence around it.
    const last = sentences.at(-1);
    if (last !== undefined && (last.match(/"/g)?.length ?? 0) % 2 === 1) sentences[sentences.length - 1] = `${last} ${piece}`;
    else sentences.push(piece);
  }
  return sentences.map(clean).filter((s) => MUST.test(s));
}

export function extractRequirements(texts: readonly string[]): Requirement[] {
  const out: Requirement[] = [];
  const seen = new Set<string>();
  const ids = new Set<string>();
  let n = 0;
  const add = (id: string | null, wording: string): void => {
    if (wording === '' || seen.has(wording)) return;
    seen.add(wording);
    let key = id;
    if (key === null || ids.has(key)) {
      do key = `MUST-${++n}`;
      while (ids.has(key));
    }
    ids.add(key);
    out.push({ id: key, wording });
  };
  for (const text of texts) {
    let fenced = false;
    for (const raw of text.split(/\r?\n/)) {
      if (/^\s*(```|~~~)/.test(raw)) {
        fenced = !fenced;
        continue;
      }
      if (fenced || !MUST.test(raw)) continue;
      const stripped = raw.replace(/^\s*(?:>\s*)?/, '');
      const m = LABEL.exec(stripped);
      if (m) {
        // A labelled requirement is the whole line: its id names every MUST in it.
        add(m[1]!, clean(stripped.slice(m[0].length)));
        continue;
      }
      for (const s of mustSentences(stripped)) add(null, s);
    }
  }
  return out;
}
