import { visibleText } from './authority.ts';
import type { Lesson } from './types.ts';

/**
 * Heuristic check that a lesson carries no repository code, paths or
 * identifiers. A lesson's own `code_free` flag is a claim made by a model; the
 * global graph is shared across repositories, so the claim is re-checked
 * here before anything leaves the repository it was learned in.
 *
 * Reasons name the category only, never the matched text, so a refusal can be
 * logged without repeating what it refused.
 */

// Product and technology names that look like identifiers but are vocabulary.
const VOCABULARY = new Set(
  [
    'JavaScript', 'TypeScript', 'CoffeeScript', 'ActionScript', 'GitHub', 'GitLab', 'BitBucket', 'PostgreSQL', 'MySQL', 'SQLite', 'MariaDB', 'MongoDB',
    'DynamoDB', 'CouchDB', 'GraphQL', 'OAuth', 'OpenID', 'OpenAPI', 'WebSocket', 'WebSockets', 'WebAssembly', 'WebKit', 'WebRTC', 'NodeJS', 'iOS',
    'macOS', 'iPadOS', 'watchOS', 'tvOS', 'PowerShell', 'DevOps', 'NoSQL', 'JSDoc', 'TypeDoc', 'PyPI', 'PyTest', 'NumPy', 'SciPy', 'FastAPI',
    'CircleCI', 'TravisCI', 'AppVeyor', 'CloudFormation', 'CloudFront', 'CloudWatch', 'ElasticSearch', 'OpenSearch', 'RabbitMQ', 'ActiveMQ',
    'LocalStorage', 'SessionStorage', 'IndexedDB', 'ReactDOM', 'NextJS', 'NuxtJS', 'VueJS', 'SvelteKit', 'TailwindCSS', 'PostCSS', 'ESLint',
    'TSLint', 'StyleLint', 'YouTube', 'LinkedIn', 'JetBrains', 'IntelliJ', 'PhpStorm', 'WebStorm', 'PyCharm', 'VSCode', 'DataDog', 'PagerDuty',
    'OpenTelemetry', 'ClickHouse', 'BigQuery', 'CockroachDB', 'TimescaleDB', 'InfluxDB', 'MacBook', 'iPhone', 'iPad', 'eBay', 'PayPal',
    'WordPress', 'DigitalOcean', 'CloudFlare', 'TestFlight', 'XCTest', 'JUnit', 'NUnit', 'xUnit', 'TestNG', 'PHPUnit', 'RSpec', 'MiniTest',
    'GoogleTest', 'PlayWright', 'WebDriver', 'ChromeDriver', 'GeckoDriver', 'DevTools', 'VoiceOver', 'TalkBack', 'NVDA', 'JAWS',
  ].map((w) => w.toLowerCase()),
);

const DOTTED_VOCABULARY = new Set(['node.js', 'next.js', 'nuxt.js', 'vue.js', 'express.js', 'nest.js', 'react.js', 'ember.js', 'd3.js', 'three.js', 'chart.js', 'socket.io', 'e.g', 'i.e', 'etc', 'vs']);

const FILE_EXTENSIONS =
  'ts|tsx|mts|cts|js|jsx|mjs|cjs|py|pyi|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|fs|php|scala|clj|ex|exs|erl|hs|lua|dart|r|m|mm|json|jsonc|ya?ml|toml|ini|cfg|conf|env|lock|sql|sh|bash|zsh|ps1|bat|md|mdx|rst|txt|css|scss|sass|less|html?|vue|svelte|astro|xml|gradle|proto|graphql|gql|tf|hcl|dockerfile|csv|ipynb';

const CHECKS: { reason: string; test: (text: string) => boolean }[] = [
  { reason: 'code fence or inline code', test: (t) => /```|~~~|`[^`\n]+`/.test(t) },
  { reason: 'path-like token', test: (t) => /(?:^|[\s("'])(?:\.{1,2}\/|~\/|\/[\w.-]+\/)/.test(t) || /\b[\w.-]+(?:\/[\w.*-]+){2,}/.test(t) || /\b[\w-]+\/[\w-]+\.\w{1,6}\b/.test(t) || /\*\*\/|\/\*\*/.test(t) || /\b[A-Za-z]:\\/.test(t) },
  { reason: 'file name', test: (t) => new RegExp(String.raw`(?:^|[^\w.])[\w-]+\.(?:${FILE_EXTENSIONS})\b`, 'i').test(t) && !onlyVocabularyDots(t) },
  // Prose uses "test (unit)" and "test(s)"; code uses "run()" and "fn(a, b)".
  { reason: 'call or member syntax', test: (t) => /\b[A-Za-z_$][\w$]*\((?:\s*|[\w$]+(?:,\s*[\w$]+)+)\)/.test(t) || /::|=>|\$\{/.test(t) },
  { reason: 'dotted identifier', test: (t) => hasDottedIdentifier(t) },
  { reason: 'camelCase or PascalCase identifier', test: (t) => hasCasedIdentifier(t) },
  { reason: 'snake_case or SCREAMING_CASE identifier', test: (t) => /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/.test(t) },
  { reason: 'hash or long hex value', test: (t) => /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{12,}\b/i.test(t) },
];

function onlyVocabularyDots(text: string): boolean {
  const re = new RegExp(String.raw`(?:^|[^\w.])([\w-]+\.(?:${FILE_EXTENSIONS}))\b`, 'gi');
  for (const m of text.matchAll(re)) {
    // Group 1 always participates in a match.
    if (!DOTTED_VOCABULARY.has(m[1]!.toLowerCase())) return false;
  }
  return true;
}

function hasDottedIdentifier(text: string): boolean {
  for (const m of text.matchAll(/\b([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+)\b/g)) {
    const token = m[1]!;
    if (DOTTED_VOCABULARY.has(token.toLowerCase())) continue;
    const parts = token.split('.');
    // "e.g" and sentence joins like "end.Then" without a space are not identifiers.
    if (parts.every((p) => p.length <= 1)) continue;
    if (parts.length === 2 && /^[A-Z]/.test(parts[1]!) && /^[a-z]+$/.test(parts[0]!) && parts[0]!.length > 3) continue;
    return true;
  }
  return false;
}

function hasCasedIdentifier(text: string): boolean {
  for (const m of text.matchAll(/\b[A-Za-z][A-Za-z0-9]*\b/g)) {
    const w = m[0];
    if (VOCABULARY.has(w.toLowerCase())) continue;
    // camelCase: lower then an upper later (getUser, userId).
    if (/^[a-z]+[A-Z]/.test(w)) return true;
    // PascalCase with an internal hump after a lowercase run (UserService), but not
    // acronyms (HTTP, API) or acronym-led words (HTTPS, JSONs).
    if (/^[A-Z][a-z0-9]+[A-Z]/.test(w)) return true;
  }
  return false;
}

/**
 * Reasons the text does not look code-free. `repoTerms` are names known to
 * belong to the repository (file basenames, symbols, package names); any of
 * them appearing as a whole word fails the check. Checks run on the visible
 * text, so a zero-width character cannot split a name or an identifier.
 */
export function codeFreeViolations(text: string, repoTerms: readonly string[] = []): string[] {
  const visible = visibleText(text);
  const reasons: string[] = [];
  for (const check of CHECKS) if (check.test(visible)) reasons.push(check.reason);
  if (mentionsRepoTerm(visible, repoTerms)) reasons.push('repository identifier');
  return reasons;
}

/** Whether any repository term appears in `text` as a whole word (case-insensitive, on the visible text). */
export function mentionsRepoTerm(text: string, repoTerms: readonly string[]): boolean {
  const lower = visibleText(text).toLowerCase();
  for (const term of repoTerms) {
    const t = term.trim().toLowerCase();
    if (t.length < 3) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?:^|[^\\w])${escaped}(?:[^\\w]|$)`).test(lower)) return true;
  }
  return false;
}

/** The prose that travels with a lesson into another repository's prompts; the code heuristics run on this. */
export function shareableText(lesson: {
  statement: string;
  rationale: string;
  verification: string;
  applicability: { keywords: readonly string[]; frameworks: readonly string[]; languages: readonly string[] };
}): string {
  return [lesson.statement, lesson.rationale, lesson.verification, lesson.applicability.keywords.join(' ')].join('\n');
}

/**
 * Every string a lesson carries into another repository, prose and lists
 * alike. Check ids, framework names and fingerprints are not prose, so the
 * code heuristics do not apply to them, but a repository name inside one
 * leaks just the same.
 */
export function travellingText(lesson: Pick<Lesson, 'statement' | 'rationale' | 'verification' | 'applicability'>): string {
  const a = lesson.applicability;
  return [lesson.statement, lesson.rationale, lesson.verification, ...a.keywords, ...a.frameworks, ...a.languages, ...a.check_ids, ...a.fingerprints, ...a.roles, ...a.paths].join('\n');
}
