/**
 * The clauses of a statement, for the classifiers that act only when everything a statement says is about one thing: a
 * review finding that disputes a classification Orbit recorded, and a planner criterion that the new tests fail on the
 * base revision (ADR 0014, 0.3.1 addendum). Such a classifier asks every clause, so a clause about anything else keeps
 * the statement as it is.
 */

/** A conjunction that joins two clauses: "and" (also "and also"), "but", "however", "although", "though", "while", "whereas". */
const CONJUNCTION = String.raw`(?:^|\s)(?:and(?:\s+also)?|but|however|although|though|while|whereas)(?=[\s,]|$)`;
/** The end of a sentence, a semicolon, a colon followed by a space, or a conjunction. */
const BREAK = new RegExp(String.raw`[.!?](?=\s|$)|;|:(?=\s|$)|${CONJUNCTION}`, 'i');
/** As BREAK, and a comma. */
const BREAK_OR_COMMA = new RegExp(String.raw`[.!?](?=\s|$)|[;,]|:(?=\s|$)|${CONJUNCTION}`, 'i');
/** A criterion id, as the contract names one: "AC-2". */
const CRITERION_ID = String.raw`\bAC-\d+\b`;
/** A list of criterion ids: "AC-1, AC-2 and AC-3", "AC-1 to AC-4", "AC-1 through AC-7 and AC-9". It is one phrase. */
const CRITERION_IDS = new RegExp(String.raw`${CRITERION_ID}(?:(?:\s*,\s*(?:(?:and|or)\s+)?|\s+(?:and|or|to|through)\s+)${CRITERION_ID})+`, 'gi');
/** A part that names only criterion ids or an abbreviation ("AC-2", "AC-3 to AC-5", "e.g"): it says nothing. */
const SAYS_NOTHING = new RegExp(String.raw`^(?:(?:${CRITERION_ID}|e\.g|i\.e|etc|and|or|to|through)[\s,.]*)+$`, 'i');
/** Marks where an aside was taken out of the text (any NUL in the text itself is a space first). */
const ASIDE = /\0(\d+)\0/g;
/** Marks where a list of criterion ids was taken out of the text, so it is not split (as is any SOH in the text). */
const IDS = /\x01(\d+)\x01/g;

/**
 * A statement's clauses, in order: its sentences, and the parts joined by a semicolon, a colon or a conjunction, and with
 * `commas`, by a comma. An aside in parentheses is never dropped: its own clauses follow the clause it sits in.
 * Parentheses right after a name, as in `round_price(2.675)`, are not an aside but part of their clause, and a list of
 * criterion ids ("AC-1, AC-2 and AC-3") is not split. A part that names only criterion ids says nothing and is left out.
 */
export function clausesOf(statement: string, opts: { commas?: boolean } = {}): string[] {
  const lists: string[] = [];
  const text = statement.replace(/[\0\x01]/g, ' ').replace(CRITERION_IDS, (ids) => `\x01${lists.push(ids) - 1}\x01`);
  return split(text, lists, opts);
}

function split(text: string, lists: readonly string[], opts: { commas?: boolean }): string[] {
  const asides: string[] = [];
  let main = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '(') {
      main += text[i];
      continue;
    }
    // The matching parenthesis, or the end of the text when there is none.
    let depth = 0;
    let j = i;
    for (; j < text.length; j++) {
      if (text[j] === '(') depth++;
      else if (text[j] === ')' && --depth === 0) break;
    }
    if (i > 0 && /[\w\]]/.test(text[i - 1]!)) {
      main += text.slice(i, j + 1);
    } else {
      main += ` \0${asides.length}\0 `;
      asides.push(text.slice(i + 1, j));
    }
    i = j;
  }
  const out: string[] = [];
  for (const part of main.split(opts.commas ? BREAK_OR_COMMA : BREAK)) {
    const inner: string[] = [];
    const clause = part
      .replace(ASIDE, (_, k: string) => {
        inner.push(asides[Number(k)]!);
        return ' ';
      })
      .replace(IDS, (_, k: string) => lists[Number(k)]!)
      .replace(/\s+/g, ' ')
      .replace(/^[\s,]+|[\s,.]+$/g, '');
    if (clause !== '' && !SAYS_NOTHING.test(clause)) out.push(clause);
    for (const aside of inner) out.push(...split(aside, lists, opts));
  }
  return out;
}
