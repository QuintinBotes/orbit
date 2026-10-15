/**
 * Statements about fail-before that a planner writes although its brief forbids them (ADR 0016, item 1): a criterion
 * stating that its tests fail on the base revision, and an assumption stating that a check runs the new tests.
 * Wording only selects the statements this applies to, and can only make Orbit stricter (the structural-evidence rule):
 * a flagged statement is never credited by its wording or by a passing log, only by the fail-before probe, and an
 * unflagged statement is judged exactly as before.
 */

const LOCUS = String.raw`(?:(?:on|against)\s+(?:the\s+)?base revision|before\s+(?:the|this)\s+(?:change|fix)|without\s+(?:the|this)\s+change)`;
const FAIL_VERB = String.raw`(?:fails?|failing|failed)`;

/** The statement split into sentences, so a match never joins words from two sentences. A dot inside a path is not a split. */
function sentences(statement: string): string[] {
  return statement
    .split(/(?<=[.!?;])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Whether a criterion states that its tests (or the change's tests) fail, or are failing, on or against the base
 * revision, before the change, before the fix, or without the change. Within one sentence the tests come before the
 * failing, and the locus comes after the failing or before the tests: "the function raises ValueError", "tests pass",
 * a test that fails on other input, and code that fails while tests merely cover it do not match.
 */
export function statesFailBefore(statement: string): boolean {
  const testsFailThenLocus = new RegExp(String.raw`\btests?\b.*\b${FAIL_VERB}\b.*\b${LOCUS}\b`, 'i');
  const locusThenTestsFail = new RegExp(String.raw`\b${LOCUS}\b.*\btests?\b.*\b${FAIL_VERB}\b`, 'i');
  return sentences(statement).some((s) => testsFailThenLocus.test(s) || locusThenTestsFail.test(s));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A check id named in `text` as a whole word: not part of a longer id joined by a letter, a digit, a dash or an underscore. */
function namedAt(text: string, checkId: string): { index: number; end: number } | null {
  if (checkId.length === 0) return null;
  const m = new RegExp(`(?<![A-Za-z0-9_-])${escapeRegExp(checkId)}(?![A-Za-z0-9_-])`, 'i').exec(text);
  return m === null ? null : { index: m.index, end: m.index + m[0].length };
}

/** The configured check ids `text` names as whole words, in the order it names them. */
function namedCheckIds(text: string, checkIds: readonly string[]): string[] {
  return [...new Set(checkIds)]
    .flatMap((id) => {
      const at = namedAt(text, id);
      return at === null ? [] : [{ id, index: at.index }];
    })
    .sort((a, b) => a.index - b.index)
    .map((x) => x.id);
}

const SUBJECT = /\bchecks?\b|\btest[-\s]+command\b|\btest[-\s]+runner\b/i;
const RUN_VERB = /\b(?:runs?|running|discovers?|discovering|collects?|collecting|executes?|executing|picks?\s+up|picking\s+up|finds?|finding|imports?|importing)\b/i;
const TEST_OBJECT = /\btests?\b|test_[a-z0-9_]|[a-z0-9_]+_test\b|\.test\.|\bpytest\b/i;

/**
 * Whether one sentence is that a check (or the test command, or the test runner) runs, discovers, collects, executes,
 * picks up, finds or imports the tests: the subject (a check named as such, the test command, the test runner, or a
 * configured check id), then one of those verbs, then the tests or a test file. A check that merely passes, a test
 * runner with no object, and the application running tests are not it.
 */
function sentenceStatesCheckRunsTests(sentence: string, checkIds: readonly string[]): boolean {
  const subjects: { index: number; end: number }[] = [];
  const generic = SUBJECT.exec(sentence);
  if (generic !== null) subjects.push({ index: generic.index, end: generic.index + generic[0].length });
  for (const id of new Set(checkIds)) {
    const at = namedAt(sentence, id);
    if (at !== null) subjects.push(at);
  }
  subjects.sort((a, b) => a.index - b.index || b.end - a.end);
  const subject = subjects[0];
  if (subject === undefined) return false;
  const verb = RUN_VERB.exec(sentence.slice(subject.end));
  if (verb === null) return false;
  return TEST_OBJECT.test(sentence.slice(subject.end + verb.index + verb[0].length));
}

/**
 * For an assumption that a check (or the test command, or the test runner) runs, discovers, collects, executes, picks
 * up, finds or imports the tests, the configured check ids it names as whole words (possibly none); for any other
 * assumption, null. Wording only selects the assumption and the checks it names: whether it holds is the probe's to
 * establish, never the statement's.
 */
export function statesCheckRunsTests(statement: string, checkIds: readonly string[]): string[] | null {
  return sentences(statement).some((s) => sentenceStatesCheckRunsTests(s, checkIds)) ? namedCheckIds(statement, checkIds) : null;
}
