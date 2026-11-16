/**
 * The spec check (docs/decisions/0019-run-from-issue.md): a deterministic reading of a Markdown body in the Spec Kit
 * spec template's format. No model is called and nothing is executed; the body is text, and what comes out is text.
 *
 * A body passes when
 *  - the headings "User Scenarios & Testing", "Requirements" and "Success Criteria" exist;
 *  - every user story has a priority, a reason, an Independent Test and at least one Given/When/Then line, and every
 *    entry listed under its Acceptance Scenarios is such a line;
 *  - requirement and success-criterion ids have the forms FR-### and SC-###, with at least one of each;
 *  - no clarification marker (`[NEEDS CLARIFICATION: ...]`) remains.
 *
 * The section "Implementation notes" is outside the spec: it is returned apart as `hints` and left out of `spec`.
 */

export interface SpecScenario {
  /** Stable key, `S<story>-<n>`: the planner refers to the scenario by it and the contract keeps one criterion per key. */
  key: string;
  story: number;
  storyTitle: string;
  /** The scenario as one plain line: "Given ..., When ..., Then ...". */
  statement: string;
}

export interface SpecStory {
  number: number;
  title: string;
  priority: string | null;
  why: string | null;
  independentTest: string | null;
  scenarios: SpecScenario[];
}

export interface SpecItem {
  id: string;
  text: string;
}

export interface ParsedSpec {
  stories: SpecStory[];
  requirements: SpecItem[];
  successCriteria: SpecItem[];
  /** The body of the "Implementation notes" section, or null. Advice for the planner, never part of the spec. */
  hints: string | null;
  /** The body without the implementation notes. */
  spec: string;
}

export interface SpecCheck {
  ok: boolean;
  /** One line each, naming the story, id or marker at fault. */
  problems: string[];
  parsed: ParsedSpec;
}

/** The longest statement a scenario contributes to a contract. */
export const SCENARIO_MAX_CHARS = 600;
const QUOTE_MAX = 160;

interface Line {
  text: string;
  /** Inside a fenced code block (or the fence line itself): never a heading, a list entry or a marker. */
  code: boolean;
}

interface Heading {
  index: number;
  level: number;
  title: string;
}

function readLines(body: string): Line[] {
  const out: Line[] = [];
  let fence: string | null = null;
  for (const text of body.replace(/\r\n?/g, '\n').split('\n')) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(text);
    if (fence === null && m) {
      fence = m[1]![0]!.repeat(m[1]!.length);
      out.push({ text, code: true });
    } else if (fence !== null) {
      if (m && m[1]![0] === fence[0] && m[1]!.length >= fence.length && text.trim() === m[1]) fence = null;
      out.push({ text, code: true });
    } else out.push({ text, code: false });
  }
  return out;
}

/** Emphasis, inline code ticks and the template's "(mandatory)" note removed; one line. */
function plain(text: string): string {
  return text
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function headingsOf(lines: readonly Line[]): Heading[] {
  const out: Heading[] = [];
  lines.forEach((l, index) => {
    if (l.code) return;
    const m = /^\s{0,3}(#{1,6})\s+([\s\S]*)/.exec(l.text);
    // The closing #s go in a second step: one pattern ending `(.*?)\s*#*\s*$` backtracks in cubic time. (?<!#) tries each run of #s once.
    if (m) out.push({ index, level: m[1]!.length, title: plain(m[2]!.trimEnd().replace(/(?<!#)#+$/, '').replace(/\*?\(mandatory\)\*?/i, '')) });
  });
  return out;
}

/** The lines of a heading's section: up to the next heading of the same or a higher level. */
function sectionRange(headings: readonly Heading[], h: Heading, lineCount: number): [number, number] {
  const next = headings.find((x) => x.index > h.index && x.level <= h.level);
  return [h.index + 1, next ? next.index : lineCount];
}

function findSection(headings: readonly Heading[], name: RegExp): Heading | null {
  return headings.find((h) => name.test(h.title)) ?? null;
}

// Every pattern in this file runs on untrusted issue bodies and is linear in its input (tests/unit/intake/spec.test.ts times them at the cap).
// `s` lets `.*` cross a U+2028 in the line: without it `$` fails there and the `\s+` before it backtracks in quadratic time.
const LIST_ITEM = /^\s*(?:\d+[.)]|[-*+])\s+(.*)$/s;

/** List entries in a range, each with its wrapped continuation lines joined. */
function listItems(lines: readonly Line[], from: number, to: number): { text: string; ordered: boolean; index: number }[] {
  const out: { text: string; ordered: boolean; index: number }[] = [];
  let open = false;
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (l.code || /^\s{0,3}#{1,6}\s/.test(l.text)) {
      open = false;
      continue;
    }
    const m = LIST_ITEM.exec(l.text);
    if (m) {
      out.push({ text: m[1]!, ordered: /^\s*\d/.test(l.text), index: i });
      open = true;
    } else if (open && l.text.trim() !== '' && /^\s+\S/.test(l.text)) out[out.length - 1]!.text += ` ${l.text.trim()}`;
    else open = false;
  }
  return out;
}

/** The text after a bold label such as `**Independent Test**:`, on the label's line; null when the label is absent. */
function labelled(lines: readonly Line[], from: number, to: number, label: RegExp): string | null {
  for (let i = from; i < to; i++) {
    const l = lines[i]!;
    if (l.code) continue;
    const m = label.exec(plain(l.text));
    if (m) return (m[1] ?? '').trim();
  }
  return null;
}

/** "Given", then "When", then "Then", each a whole word: three forward searches, where one pattern backtracks in cubic time. */
function isGivenWhenThen(text: string): boolean {
  let from = 0;
  for (const word of [/\bGiven\b/gi, /\bWhen\b/gi, /\bThen\b/gi]) {
    word.lastIndex = from;
    if (!word.exec(text)) return false;
    from = word.lastIndex;
  }
  return true;
}

const STORY = /^User Story\s+(\d+)\s*(?:[-:–—]\s*)?(.*)$/i;
const PRIORITY = /\(\s*Priority\s*:\s*(P\d+)\s*\)\s*$/i;
/** A bold label that reads as an id: letters, then a dash or digits, no spaces ("FR-001", "SC-1", "REQ12"). */
const ID_LIKE = /^[A-Za-z]{1,6}-?\d[A-Za-z0-9-]*$/;
/** The marker as the template writes it; a mention in inline code or a code block is not a marker. */
const CLARIFICATION = /\[\s*NEEDS CLARIFICATION\b[^\]\n]*\]?/gi;

function quote(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX)}...` : t;
}

function idItems(lines: readonly Line[], from: number, to: number): { label: string; text: string }[] {
  return listItems(lines, from, to).flatMap((item) => {
    const m = /^\*\*(.+?)\*\*\s*:?\s*(.*)$/s.exec(item.text.trim());
    return m ? [{ label: m[1]!.trim().replace(/:$/, ''), text: plain(m[2]!) }] : [];
  });
}

export function checkSpec(body: string): SpecCheck {
  const lines = readLines(body);
  const headings = headingsOf(lines);
  const problems: string[] = [];

  // ---- clarification markers ----------------------------------------------
  lines.forEach((l, i) => {
    if (l.code) return;
    const visible = l.text.replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
    for (const m of visible.matchAll(CLARIFICATION)) problems.push(`line ${i + 1} still has a clarification marker: "${quote(l.text.slice(m.index, m.index + m[0].length))}"`);
  });

  // ---- required headings ---------------------------------------------------
  const scenariosH = findSection(headings, /^User Scenarios\s*(?:&|and)\s*Testing\b/i);
  const requirementsH = findSection(headings, /^Requirements\b/i);
  const criteriaH = findSection(headings, /^Success Criteria\b/i);
  if (!scenariosH) problems.push('the heading "User Scenarios & Testing" is missing');
  if (!requirementsH) problems.push('the heading "Requirements" is missing');
  if (!criteriaH) problems.push('the heading "Success Criteria" is missing');

  // ---- stories --------------------------------------------------------------
  const stories: SpecStory[] = [];
  if (scenariosH) {
    const [from, to] = sectionRange(headings, scenariosH, lines.length);
    for (const h of headings.filter((x) => x.index >= from && x.index < to)) {
      const m = STORY.exec(h.title);
      if (!m) continue;
      const number = Number(m[1]);
      const priority = PRIORITY.exec(m[2]!)?.[1]?.toUpperCase() ?? null;
      const title = m[2]!.replace(/\(\s*Priority\b[^()]*\)\s*$/i, '').trim() || `story ${number}`;
      const [a, b] = sectionRange(headings, h, lines.length);
      const name = `User Story ${number} (${quote(title)})`;
      const why = labelled(lines, a, b, /^Why this priority\s*:?\s*(.*)$/i);
      const independentTest = labelled(lines, a, b, /^Independent Test\s*:?\s*(.*)$/i);
      if (stories.some((s) => s.number === number)) problems.push(`${name}: the story number ${number} is used twice`);
      if (priority === null) problems.push(`${name} has no priority: its heading must end with "(Priority: P1)" or another P-number`);
      if (!why) problems.push(`${name} has no reason: "**Why this priority**:" is missing or empty`);
      if (!independentTest) problems.push(`${name} has no Independent Test: "**Independent Test**:" is missing or empty`);
      // Entries under "Acceptance Scenarios" are the scenarios; without that label, every Given/When/Then entry of the story is.
      let start = a;
      for (let i = a; i < b; i++) if (!lines[i]!.code && /^Acceptance Scenarios\b/i.test(plain(lines[i]!.text))) start = i + 1;
      const items = listItems(lines, start, b);
      const scenarios: SpecScenario[] = [];
      for (const item of items) {
        const statement = plain(item.text);
        if (isGivenWhenThen(statement)) {
          scenarios.push({ key: `S${number}-${scenarios.length + 1}`, story: number, storyTitle: title, statement: statement.length > SCENARIO_MAX_CHARS ? `${statement.slice(0, SCENARIO_MAX_CHARS)}...` : statement });
        } else if (start !== a && item.ordered) {
          problems.push(`${name}: the acceptance scenario on line ${item.index + 1} is not a Given/When/Then line: "${quote(statement)}"`);
        }
      }
      if (scenarios.length === 0) problems.push(`${name} has no Given/When/Then line`);
      stories.push({ number, title, priority, why: why || null, independentTest: independentTest || null, scenarios });
    }
    if (stories.length === 0) problems.push('"User Scenarios & Testing" has no user story (a heading such as "### User Story 1 - Title (Priority: P1)")');
  }

  // ---- requirement and criterion ids -----------------------------------------
  // A bold label that does not read as an id (the names under Key Entities) is not judged.
  const collect = (h: Heading | null, form: RegExp, shape: string, what: string): SpecItem[] => {
    if (!h) return [];
    const [from, to] = sectionRange(headings, h, lines.length);
    const out: SpecItem[] = [];
    for (const item of idItems(lines, from, to)) {
      if (!ID_LIKE.test(item.label)) continue;
      if (form.test(item.label)) {
        if (out.some((x) => x.id === item.label)) problems.push(`${what} id ${item.label} is used twice`);
        out.push({ id: item.label, text: item.text });
      } else problems.push(`${what} id "${quote(item.label)}" does not have the form ${shape}`);
    }
    if (out.length === 0) problems.push(`"${h.title}" lists no ${what} with an id of the form ${shape}`);
    return out;
  };
  const requirements = collect(requirementsH, /^FR-\d{3}$/, 'FR-###', 'requirement');
  const successCriteria = collect(criteriaH, /^SC-\d{3}$/, 'SC-###', 'success criterion');

  // ---- implementation notes: outside the spec --------------------------------
  const notesH = headings.find((h) => /^Implementation notes\b/i.test(h.title)) ?? null;
  let hints: string | null = null;
  let spec = lines.map((l) => l.text).join('\n');
  if (notesH) {
    const [from, to] = sectionRange(headings, notesH, lines.length);
    hints = lines.slice(from, to).map((l) => l.text).join('\n').trim() || null;
    spec = [...lines.slice(0, notesH.index), ...lines.slice(to)].map((l) => l.text).join('\n');
  }

  return { ok: problems.length === 0, problems, parsed: { stories, requirements, successCriteria, hints, spec: spec.trim() } };
}

/** Every scenario of a parsed spec, in story order. */
export function scenariosOf(parsed: ParsedSpec): SpecScenario[] {
  return parsed.stories.flatMap((s) => s.scenarios);
}

const REPRODUCTION = /^(?:steps to reproduce|how to reproduce|to reproduce|reproduction(?: steps)?|repro(?: steps)?|reproduce)\b/i;

/** The text of a reproduction section ("Steps to reproduce", "Reproduction", ...), or null when there is none or it is empty. */
export function reproductionOf(body: string): string | null {
  const lines = readLines(body);
  const headings = headingsOf(lines);
  const h = headings.find((x) => REPRODUCTION.test(x.title));
  if (!h) return null;
  const [from, to] = sectionRange(headings, h, lines.length);
  const text = lines.slice(from, to).map((l) => l.text).join('\n').trim();
  return text === '' ? null : text;
}
