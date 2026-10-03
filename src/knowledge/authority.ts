/**
 * Authority-language filter for lessons and overlays.
 *
 * Learned text is advisory and is enforced against nothing, but a lesson that
 * reads "skip the flaky test and push the branch" would still steer a worker
 * toward an action the policy layer then has to refuse. Such text is rejected
 * at the door instead of being stored, retrieved or distilled.
 *
 * The filter is a deny-list of imperative patterns, so it is deliberately
 * biased toward rejection: a dropped lesson costs one lesson, while a stored
 * instruction to weaken a test keeps costing attempts. Prohibitions ("never
 * skip a failing test") are allowed, because hazards are often phrased that
 * way, but only when the negation governs the verb directly (see isNegated):
 * "do not hesitate to", "don't forget to" and "it is not a problem to" do not
 * count as negation. Matching runs on visibleText, so invisible characters
 * cannot split a verb or an object.
 */

interface AuthorityRule {
  id: string;
  pattern: RegExp;
}

// Determiners that may sit between a verb and its object without changing what is acted on.
const DET = String.raw`(?:\s+(?:the|any|all|every|a|an|this|that|these|those|its|their|your|our|orbit's|git|existing|current|remaining))*`;
// Up to three further modifier words. Prepositions and conjunctions end the
// object phrase: in "add tests for the settings page" the settings are not
// what is being changed.
const MOD = String.raw`(?:\s+(?!(?:for|of|in|on|with|when|after|before|about|from|that|which|by|to|into|and|or|if|so|then|than|but|because|while|unless)\b)[\w'./-]+){0,3}?`;
const GAP = `${DET}${MOD}\\s+`;
// The object must be the head of its noun phrase: "reduce test flakiness" is
// about flakiness, "reduce tests" is about tests. A few nouns may follow the
// head without changing what is acted on ("the test file", "the token value").
const TAIL = String.raw`(?:\s+(?:files?|entries|entry|values?|rules?|sections?|keys?|jobs?|steps?|cases?|suites?|runs?|stages?|hooks?))?`;
const END = String.raw`(?=$|\s*[.,;:!?)\]"']|\s+(?:for|in|on|at|to|into|onto|that|which|when|whenever|if|and|or|so|until|because|before|after|from|with|without|unless|while|instead|entirely|completely|altogether|temporarily|now|again|first|too|as|by|then|locally|here|there|upstream|anyway|once|immediately|automatically|directly|yourself|afterwards|later|manually|quickly|every|each|during|since|regardless|right|asap)\b)`;

const BYPASS_VERBS = String.raw`(?:bypass(?:es|ed|ing)?|circumvent(?:s|ed|ing)?|overrid(?:e|es|ing)|overrode|overridden|disabl(?:e|es|ed|ing)|turn(?:s|ed|ing)?\s+off|switch(?:es|ed|ing)?\s+off|deactivat(?:e|es|ed|ing)|work(?:s|ed|ing)?\s+around|get(?:s|ting)?\s+around|evad(?:e|es|ed|ing)|sidestep(?:s|ped|ping)?|ignor(?:e|es|ed|ing)|disregard(?:s|ed|ing)?|skip(?:s|ped|ping)?|defeat(?:s|ed|ing)?|suppress(?:es|ed|ing)?|uninstall(?:s|ed|ing)?)`;
const POLICY_OBJECTS = String.raw`(?:polic(?:y|ies)|guard(?:rail)?s?|sandbox(?:es|ing)?|hooks?|permissions?|restrictions?|allow-?lists?|deny-?lists?|gates?|approvals?|reviews?|reviewers?|scope|limits?|hard\s+caps?|caps?|budgets?|protected\s+paths?|security\s+checks?|safety\s+checks?|verification|pre-?commit|pre-?push|instructions?|rules?|contract)\b`;

const WEAKEN_VERBS = String.raw`(?:skip(?:s|ped|ping)?|disabl(?:e|es|ed|ing)|delet(?:e|es|ed|ing)|remov(?:e|es|ed|ing)|comment(?:s|ed|ing)?\s+out|weaken(?:s|ed|ing)?|loosen(?:s|ed|ing)?|relax(?:es|ed|ing)?|mut(?:e|es|ed|ing)|silenc(?:e|es|ed|ing)|quarantin(?:e|es|ed|ing)|xfail(?:s|ed|ing)?|suppress(?:es|ed|ing)?|lower(?:s|ed|ing)?|reduc(?:e|es|ed|ing)|drop(?:s|ped|ping)?|soften(?:s|ed|ing)?|neuter(?:s|ed|ing)?|stub(?:s|bed|bing)?\s+out)`;
const TEST_OBJECTS = String.raw`(?:tests?|specs?|assertions?|asserts?|checks?|test\s+(?:suites?|files?|cases?)|suites?|coverage(?:\s+thresholds?)?|snapshots?|expectations?|type\s*-?checks?|typecheck(?:s|ing)?|linters?|linting|lint\s+rules?|ci\s+(?:checks?|jobs?|steps?)|oracles?)\b`;

const CONFIG_VERBS = String.raw`(?:chang(?:e|es|ed|ing)|edit(?:s|ed|ing)?|modif(?:y|ies|ied|ying)|updat(?:e|es|ed|ing)|rewrit(?:e|es|ing)|rewrote|overwrit(?:e|es|ing)|overwrote|patch(?:es|ed|ing)?|alter(?:s|ed|ing)?|tweak(?:s|ed|ing)?|loosen(?:s|ed|ing)?|relax(?:es|ed|ing)?)`;
const CONFIG_OBJECTS = String.raw`(?:config(?:uration)?s?\b|settings?\b|polic(?:y|ies)\b|allowed[\s_-]+(?:paths|hosts)\b|protected[\s_-]+paths\b|permissions?\b|\.orbit\b|ci\s+(?:config(?:uration)?|pipelines?|workflows?)\b|workflows?\b|hooks?\b|\.github\b|lockfiles?\b|package\.json\b|tsconfig\b|eslint\w*|(?:vitest|jest|playwright)\.config\b)`;

const EXPAND_VERBS = String.raw`(?:widen(?:s|ed|ing)?|broaden(?:s|ed|ing)?|expand(?:s|ed|ing)?|extend(?:s|ed|ing)?|rais(?:e|es|ed|ing)|increas(?:e|es|ed|ing)|bump(?:s|ed|ing)?|lift(?:s|ed|ing)?)`;
const EXPAND_OBJECTS = String.raw`(?:allowed[\s_-]+(?:paths|hosts)|allow-?lists?|network\s+access|scope|permissions?|budgets?|hard\s+caps?|caps?|limits?|timeouts?|attempts?|retries)\b`;

const PUSH_VERBS = String.raw`(?:force[\s-]?push(?:es|ed|ing)?|push(?:es|ed|ing)?)`;
const PUSH_OBJECTS = String.raw`(?:branch(?:es)?|main|master|trunk|remote|origin|upstream|commits?|tags?|repo(?:sitory)?|github|production|prod|changes|fix)\b`;
const MERGE_VERBS = String.raw`(?:merg(?:e|es|ed|ing)|land(?:s|ed|ing)?|approv(?:e|es|ed|ing)|auto-?merg(?:e|es|ed|ing))`;
const MERGE_OBJECTS = String.raw`(?:pull\s+requests?|prs?|branch(?:es)?|main|master|trunk|release)\b`;
const DEPLOY_VERBS = String.raw`(?:deploy(?:s|ed|ing)?|releas(?:e|es|ed|ing)|publish(?:es|ed|ing)?|ship(?:s|ped|ping)?|roll(?:s|ed|ing)?\s+out)`;
const DEPLOY_OBJECTS = String.raw`(?:production|prod|staging|live|registry|npm|pypi|package|release)\b`;
const TO = String.raw`(?:\s+(?:to|into|onto))?`;
const DESTINATIONS = String.raw`(?:main|master|trunk|default\s+branch|release\s+branch|remote|origin|upstream|production|prod|staging|live|registry|npm|pypi)\b`;

const SECRET_VERBS = String.raw`(?:print(?:s|ed|ing)?|cat|echo(?:es|ed|ing)?|export(?:s|ed|ing)?|send(?:s|ing)?|sent|upload(?:s|ed|ing)?|cop(?:y|ies|ied|ying)|exfiltrat(?:e|es|ed|ing)|post(?:s|ed|ing)?|shar(?:e|es|ed|ing)|log(?:s|ged|ging)?|dump(?:s|ed|ing)?|leak(?:s|ed|ing)?|reveal(?:s|ed|ing)?|steal(?:s|ing)?)`;
const SECRET_OBJECTS = String.raw`(?:credentials?\b|secrets?\b|tokens?\b|api\s+keys?\b|ssh\s+keys?\b|private\s+keys?\b|passwords?\b|gh_token\b|github_token\b|ssh_auth_sock\b|keychain\b|\.env\b|\.ssh\b|id_rsa\b|id_ed25519\b)`;

const PASSIVE_MODAL = String.raw`\s+(?:can|may|should|must|could|might|will|is|are)\s+(?:safely\s+|simply\s+|just\s+|now\s+)?(?:be\s+)?`;

const RULES: readonly AuthorityRule[] = [
  {
    id: 'override-instructions',
    pattern: /\b(?:ignor(?:e|ing)|disregard(?:ing)?|forget(?:ting)?|overrid(?:e|ing)|supersed(?:e|ing))\s+(?:all\s+|any\s+|the\s+|your\s+|these\s+|those\s+)?(?:previous|prior|above|earlier|system|original|other|existing)\s+(?:instructions?|prompts?|rules|guidelines|directives|messages?)\b/gi,
  },
  { id: 'override-instructions', pattern: /\btakes?\s+precedence\s+over\b/gi },
  { id: 'grant-authority', pattern: /\b(?:you\s+are|you're|workers?\s+(?:are|is)|the\s+agent\s+is)\s+(?:now\s+|hereby\s+)?(?:allowed|authori[sz]ed|permitted|cleared|free)\s+to\b/gi },
  { id: 'grant-authority', pattern: /\b(?:grant|give)\s+(?:yourself|itself|the\s+worker|workers|the\s+agent|the\s+model)\b/gi },
  { id: 'bypass-policy', pattern: new RegExp(String.raw`\b${BYPASS_VERBS}${GAP}${POLICY_OBJECTS}${TAIL}${END}`, 'gi') },
  { id: 'bypass-policy', pattern: new RegExp(String.raw`\b${POLICY_OBJECTS}${PASSIVE_MODAL}(?:bypassed|ignored|disabled|overridden|turned\s+off|skipped|circumvented|optional)\b`, 'gi') },
  { id: 'weaken-tests', pattern: new RegExp(String.raw`\b${WEAKEN_VERBS}${GAP}${TEST_OBJECTS}${TAIL}${END}`, 'gi') },
  {
    id: 'weaken-tests',
    pattern: new RegExp(String.raw`\b${TEST_OBJECTS}${PASSIVE_MODAL}(?:skipped|disabled|removed|deleted|weakened|relaxed|loosened|commented\s+out|muted|quarantined|silenced|lowered|dropped|optional)\b`, 'gi'),
  },
  { id: 'weaken-tests', pattern: /\b(?:updat(?:e|ing)|regenerat(?:e|ing)|re-?record(?:ing)?|accept(?:ing)?|overwrit(?:e|ing))\s+(?:all\s+|the\s+|any\s+)?(?:failing\s+|visual\s+|new\s+)?(?:snapshots?|baselines?|golden\s+files?)\b/gi },
  { id: 'weaken-tests', pattern: /(?:\.(?:skip|only)\s*\(|\b(?:xit|xdescribe|xtest)\s*\(|@pytest\.mark\.skip|@Disabled\b|@Ignore\b)/g },
  { id: 'change-config', pattern: new RegExp(String.raw`\b${CONFIG_VERBS}${GAP}${CONFIG_OBJECTS}${TAIL}${END}`, 'gi') },
  { id: 'expand-authority', pattern: new RegExp(String.raw`\b${EXPAND_VERBS}${GAP}${EXPAND_OBJECTS}${TAIL}${END}`, 'gi') },
  { id: 'expand-authority', pattern: /\badd\b(?:[^.;:!?\n]|\.(?=\S)){1,60}?\bto\s+(?:the\s+)?(?:allow-?list|allowed[\s_-]+(?:paths|hosts)|network\s+allow-?list|scope|protected[\s_-]+paths)\b/gi },
  { id: 'push', pattern: new RegExp(String.raw`\b${PUSH_VERBS}${TO}${GAP}${PUSH_OBJECTS}${TAIL}${END}`, 'gi') },
  // "push hotfixes straight to main", "merge your work into trunk", "deploy the app to production".
  { id: 'push', pattern: new RegExp(String.raw`\b${PUSH_VERBS}${MOD}\s+(?:to|into|onto)\s+(?:the\s+)?${DESTINATIONS}`, 'gi') },
  { id: 'merge', pattern: new RegExp(String.raw`\b${MERGE_VERBS}${MOD}\s+(?:to|into|onto)\s+(?:the\s+)?${DESTINATIONS}`, 'gi') },
  { id: 'deploy', pattern: new RegExp(String.raw`\b${DEPLOY_VERBS}${MOD}\s+(?:to|into|onto)\s+(?:the\s+)?${DESTINATIONS}`, 'gi') },
  { id: 'push', pattern: /\bgit\s+(?:push|tag)\b|--no-verify\b|--force(?:-with-lease)?\b|\bgh\s+(?:pr|release|repo|api)\b/gi },
  { id: 'merge', pattern: new RegExp(String.raw`\b${MERGE_VERBS}${TO}${GAP}${MERGE_OBJECTS}${TAIL}${END}`, 'gi') },
  { id: 'merge', pattern: /\bgit\s+(?:merge|rebase|reset\s+--hard|commit)\b|\b(?:open|create|submit)\s+(?:a\s+|the\s+)?(?:pull\s+request|pr)\b/gi },
  { id: 'deploy', pattern: new RegExp(String.raw`\b${DEPLOY_VERBS}${TO}${GAP}${DEPLOY_OBJECTS}${TAIL}${END}`, 'gi') },
  { id: 'credentials', pattern: new RegExp(String.raw`\b${SECRET_VERBS}${GAP}${SECRET_OBJECTS}${TAIL}${END}`, 'gi') },
  { id: 'dangerous-command', pattern: /\bsudo\b|\brm\s+-[a-z]*r[a-z]*f\b|\bchmod\s+(?:-R\s+)?[0-7]{3,4}\b|\bcurl\b[^\n|]*\|\s*(?:ba|z)?sh\b/gi },
];

const NEGATIONS = new Set([
  'never', 'not', "don't", 'dont', "doesn't", 'doesnt', "didn't", 'didnt', 'avoid', 'avoids', 'avoiding', 'without', 'no', 'cannot', "can't", 'cant',
  "mustn't", 'mustnt', "shouldn't", 'shouldnt', "won't", 'wont', 'nor', 'refuse', 'refuses', 'refusing', 'stop', 'prevent', 'prevents', 'preventing',
]);
const NEGATION_PAIRS = new Set(['instead of', 'rather than']);
const NEGATION_PREFIXES = ['prohibit', 'forbid'];
// Words that may sit between a negation and the verb it governs without
// changing what is prohibited: "do not ever skip", "never try to bypass",
// "it is not acceptable to weaken", "workers are not allowed to push".
// Anything else breaks the link, so "it is not a problem to skip tests" and
// "don't hesitate to skip tests" are read as the encouragements they are.
const NEGATION_FILLER = new Set([
  'to', 'ever', 'be', 'been', 'being', 'do', 'does', 'did', 'you', 'we', 'they', 'it', 'try', 'trying', 'attempt', 'attempting', 'simply', 'just',
  'silently', 'quietly', 'blindly', 'casually', 'accidentally', 'also', 'even', 'merely', 'need', 'needs', 'acceptable', 'ok', 'okay', 'safe', 'fine',
  'appropriate', 'allowed', 'permitted', 'is', 'are', 'was', 'were',
]);
const NEGATION_REACH = 6;

function isNegation(word: string, previous: string | undefined): boolean {
  if (NEGATIONS.has(word)) return true;
  if (previous !== undefined && NEGATION_PAIRS.has(`${previous} ${word}`)) return true;
  return NEGATION_PREFIXES.some((p) => word.startsWith(p));
}

/**
 * A match is a prohibition only when a negation governs it directly: walking
 * back from the verb within its clause, every word before the negation must
 * be filler. Distance alone is not enough, since "not" four words earlier
 * often negates something else.
 */
function isNegated(text: string, index: number): boolean {
  const before = text.slice(0, index);
  let clauseStart = -1;
  for (const mark of ['.', ';', ':', '!', '?', '\n', ',']) clauseStart = Math.max(clauseStart, before.lastIndexOf(mark));
  const words = before
    .slice(clauseStart + 1)
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}']+|[^\p{L}']+$/gu, ''))
    .filter(Boolean)
    .slice(-NEGATION_REACH);
  for (let i = words.length - 1; i >= 0; i--) {
    if (isNegation(words[i]!, words[i - 1])) return true;
    if (!NEGATION_FILLER.has(words[i]!)) return false;
  }
  return false;
}

/**
 * The text a reader (or a model) effectively sees: compatibility forms folded
 * (NFKC), invisible format characters removed (zero-width spaces and joiners,
 * soft hyphens, word joiners, bidi marks), and typographic apostrophes made
 * plain. Without this, "sk<zero-width space>ip the tests" reads as "skip the
 * tests" to a model but matches no pattern.
 */
export function visibleText(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[‘’ʼ′]/g, "'");
}

/**
 * Rule ids for every authority instruction found in `text` (deduplicated, in
 * rule order). Empty means the text reads as advice, not as an instruction to
 * act outside the worker's authority.
 */
export function authorityViolations(text: string): string[] {
  const found: string[] = [];
  const flat = visibleText(text);
  for (const rule of RULES) {
    if (found.includes(rule.id)) continue;
    for (const m of flat.matchAll(rule.pattern)) {
      if (!isNegated(flat, m.index ?? 0)) {
        found.push(rule.id);
        break;
      }
    }
  }
  return found;
}

export function hasAuthorityLanguage(text: string): boolean {
  return authorityViolations(text).length > 0;
}

/** The human-readable fields of a lesson, which are what a worker would read. */
export function lessonText(lesson: { statement: string; rationale: string; verification: string; applicability?: { keywords?: readonly string[] } }): string {
  return [lesson.statement, lesson.rationale, lesson.verification, ...(lesson.applicability?.keywords ?? [])].join('\n');
}

/**
 * Verification text says how to check a lesson; it must never be something a
 * worker could paste into a shell. Returns the reason, or null when it reads
 * as a description.
 */
export function verificationLooksExecutable(raw: string): string | null {
  const text = visibleText(raw);
  if (/`/.test(text)) return 'contains code formatting';
  if (/(?:^|\n)\s*[$#>]\s+\S/.test(text)) return 'contains a shell prompt line';
  if (/&&|\|\||;\s*\w+\s+-|\$\(|\|\s*\w/.test(text)) return 'contains shell operators';
  if (/(?:^|[\s(])(?:npm|npx|pnpm|yarn|bun|node|deno|python3?|pip|pytest|go|cargo|make|bash|sh|zsh|git|gh|docker|kubectl|curl|wget|mvn|gradle|dotnet|bundle|rake|tsc|vitest|jest|playwright|orbit)\s+(?:-{1,2}\w|run\b|test\b|exec\b|install\b|add\b|build\b|push\b|commit\b|\w+\.\w+)/i.test(text)) {
    return 'contains a command invocation';
  }
  return null;
}
