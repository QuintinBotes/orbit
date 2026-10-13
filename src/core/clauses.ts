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
/** A part that names only criterion ids or an abbreviation ("AC-2", "AC-3 to AC-5", "e.g"): it says nothing. */
const SAYS_NOTHING = /^(?:(?:[a-z]{1,5}-\d+|e\.g|i\.e|etc|and|or|to|through)[\s,.]*)+$/i;
/** Marks where an aside was taken out of the text (any NUL in the text itself is a space first). */
const ASIDE = /\0(\d+)\0/g;

/**
 * A statement's clauses, in order: its sentences, and the parts joined by a semicolon, a colon or a conjunction, and with
 * `commas`, by a comma. An aside in parentheses is never dropped: its own clauses follow the clause it sits in.
 * Parentheses right after a name, as in `round_price(2.675)`, are not an aside but part of their clause. A part that
 * names only criterion ids says nothing and is left out.
 */
export function clausesOf(statement: string, opts: { commas?: boolean } = {}): string[] {
  const text = statement.replace(/\0/g, ' ');
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
      .replace(/\s+/g, ' ')
      .replace(/^[\s,]+|[\s,.]+$/g, '');
    if (clause !== '' && !SAYS_NOTHING.test(clause)) out.push(clause);
    for (const aside of inner) out.push(...clausesOf(aside, opts));
  }
  return out;
}
