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

/** A negation of the verb that follows it: a negated statement is not the statement these rules apply to. */
const NEGATION = String.raw`(?:does\s+not|doesn['’]t|do\s+not|don['’]t|did\s+not|didn['’]t|is\s+not|isn['’]t|are\s+not|aren['’]t|was\s+not|wasn['’]t|were\s+not|weren['’]t|has\s+not|hasn['’]t|have\s+not|haven['’]t|will\s+not|won['’]t|cannot|can['’]t|should\s+not|shouldn['’]t|must\s+not|never|no\s+longer|not)`;
const PASS_VERB = /\bpass(?:es|ed|ing)?\b/i;

/**
 * Whether a criterion states that its tests (or the change's tests) fail, or are failing, on or against the base
 * revision, before the change, before the fix, or without the change. Within one sentence the tests come before the
 * failing, and the locus comes after the failing, before the tests, or between them: "the function raises
 * ValueError", "tests pass", a test that fails on other input, and code that fails while tests merely cover it do
 * not match. A negated fail verb ("do not fail", "never fail") does not match either, and neither does the
 * tests-locus-fail order when a pass verb stands between the locus and the failing, or the failing is placed after
 * the change ("fail after", "fail afterwards").
 */
export function statesFailBefore(statement: string): boolean {
  const testsFailThenLocus = new RegExp(String.raw`\btests?\b.*\b${FAIL_VERB}\b.*\b${LOCUS}\b`, 'i');
  const locusThenTestsFail = new RegExp(String.raw`\b${LOCUS}\b.*\btests?\b.*\b${FAIL_VERB}\b`, 'i');
  const testsLocusThenFail = new RegExp(String.raw`\btests?\b.*\b${LOCUS}\b(.*)\b${FAIL_VERB}\b`, 'i');
  const negatedFail = new RegExp(String.raw`\b${NEGATION}\s+${FAIL_VERB}\b`, 'gi');
  return sentences(statement).some((s) => {
    const cleaned = s.replace(negatedFail, ' ');
    if (testsFailThenLocus.test(cleaned) || locusThenTestsFail.test(cleaned)) return true;
    const m = testsLocusThenFail.exec(cleaned);
    if (m === null || PASS_VERB.test(m[1]!)) return false;
    return !/^after(?:wards)?\b/i.test(cleaned.slice(m.index + m[0].length).trimStart());
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A check id named in `text` as a whole word: not part of a longer id joined by a letter, a digit, a dash or an underscore. */
function namedAt(text: string, checkId: string): { index: number; end: number } | null {
  if (checkId.length === 0) return null;
  const m = new RegExp(`(?<![A-Za-z0-9._-])${escapeRegExp(checkId)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9])`, 'i').exec(text);
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
/** A verb that, right after a check's name, makes it the subject of a clause of its own rather than another agent. */
const FINITE_VERB = /^\s*(?:runs?|ran|is|are|was|were|passes|passed|fails|failed|checks|lints|executes|does|did|has|have|had|will|would|can|could|should|must|may|reports|uses|covers|builds|stays|remains|keeps)\b/i;

/** What an agent joined by "and" or "or" starts as: a check named as such, the test command or the test runner. */
const AGENT_START = /^\s*(?:the\s+)?(?:[A-Za-z0-9][A-Za-z0-9._-]*\s+)?(?:checks?|test[-\s]+command|test[-\s]+runner)\b/i;

/** A form of "to be" or "get" directly before the run verb's participle: the passive "the tests are run by the check". */
const PASSIVE_RUN = /\b(?:is|are|was|were|be|been|being|gets?|got)\s+(?:run|executed|collected|discovered|picked\s+up|found|imported)\b/i;

/**
 * The passive order of the same statement: the tests or a test file, then "are run" (or executed, collected,
 * discovered, picked up, found, imported), then "by" a check (a check named as such, the test command, the test runner,
 * or a configured check id). A negation stands between the auxiliary and the participle ("are not run by"), so
 * PASSIVE_RUN does not match it and such a statement is not flagged, as its active form is not. The third 0.3.1
 * retest's planner wrote "The pytest suite is run by the unit-tests check with src on the path".
 */
function sentenceStatesTestsRunByCheck(sentence: string, checkIds: readonly string[]): boolean {
  const object = TEST_OBJECT.exec(sentence);
  if (object === null) return false;
  const rest = sentence.slice(object.index + object[0].length);
  const verb = PASSIVE_RUN.exec(rest);
  if (verb === null) return false;
  // A negation anywhere between the tests and the participle states the opposite, compound auxiliaries included
  // ("will not be run", "have not been collected", "cannot be executed").
  if (new RegExp(String.raw`\b${NEGATION}\b`, 'i').test(rest.slice(0, verb.index + verb[0].length))) return false;
  const after = rest.slice(verb.index + verb[0].length);
  const by = /^\s*by\b/i.exec(after);
  if (by === null) return false;
  // The agent is the phrase "by" introduces, up to the end of its clause: a check named in a later clause ("run by CI
  // after the lint check passes") is not what runs the tests.
  const clause = after.slice(by[0].length).split(/[,;:]|\b(?:after|when|whenever|once|before|while|if|but|because|until|unless|so|then|where)\b/i)[0] ?? '';
  // "and" or "or" joins another agent ("by CI and the unit-tests check") when what follows starts as one; anything else
  // after it begins a new clause, which names no agent of this statement.
  const [first, ...joined] = clause.split(/\b(?:and|or)\b/i);
  let agent = first ?? '';
  for (const part of joined) {
    const named = AGENT_START.exec(part) ?? [...new Set(checkIds)].map((id) => new RegExp(String.raw`^\s*(?:the\s+)?${escapeRegExp(id)}(?![A-Za-z0-9_-]|\.[A-Za-z0-9])(?:\s+checks?\b)?`, 'i').exec(part)).find((m) => m !== null) ?? null;
    // A check followed by a verb of its own ("and the lint check runs eslint") is the subject of a new clause, not an agent.
    if (named === null || FINITE_VERB.test(part.slice(named[0].length))) break;
    agent += ` and ${part}`;
  }
  return SUBJECT.test(agent) || [...new Set(checkIds)].some((id) => namedAt(agent, id) !== null);
}

function sentenceStatesCheckRunsTests(sentence: string, checkIds: readonly string[]): boolean {
  if (sentenceStatesTestsRunByCheck(sentence, checkIds)) return true;
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
  // A negation between the subject and the verb states the opposite ("does not run tests"): not this statement.
  if (new RegExp(String.raw`\b${NEGATION}\b`, 'i').test(sentence.slice(subject.end, subject.end + verb.index))) return false;
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

/**
 * Words that stand next to "check" without naming one: articles, demonstratives, quantifiers, and the adjectives a
 * statement uses for a check in general ("the required test check"), which are no check's name.
 */
const NOT_CHECK_NAMES = new Set([
  'the', 'a', 'an', 'this', 'that', 'these', 'those', 'each', 'every', 'any', 'all', 'one', 'its', 'their', 'our', 'your', 'his', 'her', 'no', 'same', 'other',
  'required', 'mandatory', 'optional', 'configured', 'existing', 'trusted', 'relevant', 'new', 'test', 'tests', 'testing', 'ci', 'project', 'repository',
]);
/** Words that follow "the check" as its verb or auxiliary, not as its name. */
const AFTER_CHECK_VERBS = new Set([
  'run', 'runs', 'running', 'discover', 'discovers', 'discovering', 'collect', 'collects', 'collecting', 'execute', 'executes', 'executing', 'pick', 'picks', 'picking', 'find', 'finds', 'finding', 'import', 'imports', 'importing',
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'can', 'could', 'should', 'must', 'pass', 'passes', 'passed', 'fail', 'fails', 'failed',
]);

/**
 * The checks `statement` names as such that are not configured check ids, in the order it names them: a word
 * directly before "check" or "checks" ("the integration check"), or directly after "the check" where a name
 * stands there ("the check named integration"). An assumption naming one names a check that does not exist, so
 * no other check's probe can support it; only a statement naming no check at all falls back to every probed check.
 */
export function unknownNamedChecks(statement: string, checkIds: readonly string[]): string[] {
  const configured = new Set([...checkIds].map((id) => id.toLowerCase()));
  const unknown: string[] = [];
  const seen = new Set<string>();
  const add = (word: string): void => {
    const lower = word.toLowerCase();
    if (configured.has(lower) || NOT_CHECK_NAMES.has(lower) || seen.has(lower)) return;
    seen.add(lower);
    unknown.push(word);
  };
  // A check id's whole grammar (config.schema.json checkId: letters, digits, dots, dashes and underscores), optionally
  // quoted or in backticks; a dot that ends the sentence is not part of the id.
  const ID = String.raw`[\x60"'“‘]?([A-Za-z0-9][A-Za-z0-9._-]*)[\x60"'”’]?`;
  const clean = (word: string): string => word.replace(/\.+$/, '');
  for (const sentence of sentences(statement)) {
    for (const m of sentence.matchAll(new RegExp(String.raw`(?<![A-Za-z0-9._-])${ID}\s+checks?\b`, 'gi'))) add(clean(m[1]!));
    for (const m of sentence.matchAll(new RegExp(String.raw`\bthe\s+checks?\s+(?:named\s+|called\s+)?${ID}`, 'gi'))) {
      const word = clean(m[1]!);
      if (!AFTER_CHECK_VERBS.has(word.toLowerCase())) add(word);
    }
  }
  return unknown;
}
