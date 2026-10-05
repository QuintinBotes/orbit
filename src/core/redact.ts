import { homedir } from 'node:os';

/**
 * Secret redaction for logs, artifacts and anything sent to a provider.
 * Matches become `[REDACTED:<kind>]` so a reader can still tell what was there
 * without learning the value.
 *
 * Every pattern stays linear on hostile input. Each starts with a lookbehind
 * that excludes its own leading characters, so a run such as "eyJeyJeyJ..."
 * offers one start position instead of one per character; quantified parts
 * are single character classes, bounded wherever something after them can
 * fail. Private key blocks are found with indexOf rather than a lazy regex so a
 * missing END line cannot make the scan quadratic. The unit tests feed
 * adversarial inputs to hold this.
 *
 * Over-redaction is preferred to a leak, but ordinary source code must come
 * through unchanged, so assignments are redacted only when the value is a
 * literal: quoted, or bare with no spaces around `=` and not a variable passed
 * as a keyword argument. Placeholders such as `${TOKEN}` are left alone. A
 * bare value runs to the next whitespace, quote or `&`: brackets and
 * separators glued onto it (`x8#Kd(2mQ`, `p,ss`) are part of the secret, and
 * only an identifier followed by a bracket it closes (`getToken()`) is code.
 */

export interface RedactorOptions {
  /** Exact values to remove wherever they appear (and their URL-encoded form). */
  extraSecrets?: Iterable<string>;
  /**
   * Environment whose secret-looking variables are removed by value. Defaults
   * to `process.env`, read on every call so later changes are honoured.
   * Pass `{}` to disable.
   */
  env?: Readonly<Record<string, string | undefined>>;
  /** Additional patterns from config (`retention.redact_patterns`), redacted as `custom`. */
  patterns?: readonly (RegExp | string)[];
}

export interface Redactor {
  redact(text: string): string;
  /** `redact` plus absolute home paths shortened to `~`, for text that leaves the machine. */
  forProvider(text: string): string;
}

const MIN_EXTRA_SECRET_LENGTH = 4;
// Short env values ("1", "dev") would turn ordinary words into redactions.
const MIN_ENV_SECRET_LENGTH = 8;

/**
 * Configured patterns (`retention.redact_patterns`) in force for this
 * process, keyed by source and flags. Every redaction honours them: `redact`,
 * `redactForProvider`, `redactValue` and each `createRedactor` instance, so
 * the logger, worker prompts, review packets, CI and check logs and the
 * final report need no extra plumbing to apply a user's patterns.
 *
 * Usage: the policy layer calls `applyRedactPatterns(config.retention.redact_patterns)`
 * whenever it freezes, verifies or loads a policy (policy/snapshot.ts,
 * policy/config.ts loadConfig), which is how every run's controller picks up
 * its patterns. A caller that needs a fixed, explicit set instead uses
 * `createRedactor({ patterns })`, which applies those on top of the
 * registered ones.
 *
 * Patterns are only ever added: one controller process may own runs whose
 * policies differ, and over-redaction is preferred to a leak, so text is
 * redacted with the union of every policy this process has loaded.
 */
const registered = new Map<string, RegExp>();

/** Register configured patterns for every later redaction in this process. Invalid patterns throw CONFIG-style errors at config load, not here; here they are skipped. */
export function applyRedactPatterns(patterns: readonly (RegExp | string)[] | null | undefined): void {
  for (const p of patterns ?? []) {
    let re: RegExp;
    try {
      re = toGlobalRegExp(p);
    } catch {
      continue;
    }
    // An empty match would put a tag between every character.
    if (re.test('')) continue;
    const key = `${re.flags}/${re.source}`;
    if (!registered.has(key)) registered.set(key, re);
  }
}

/** The configured patterns now in force (copies), for diagnostics and tests. */
export function registeredRedactPatterns(): RegExp[] {
  return [...registered.values()].map((re) => new RegExp(re.source, re.flags));
}

/** Redact known secret shapes, the given exact values, and secret-named environment values. */
export function redact(text: string, extraSecrets?: Iterable<string>): string {
  return redactWith(text, { extraSecrets });
}

/** `redact`, then absolute home paths become `~`. Use for anything sent to a model provider. */
export function redactForProvider(text: string, extraSecrets?: Iterable<string>): string {
  return stripHomePaths(redactWith(text, { extraSecrets }));
}

/** A redactor with fixed options: an explicit environment, extra values and config patterns (on top of the registered ones). */
export function createRedactor(options: RedactorOptions = {}): Redactor {
  const custom: RegExp[] = [];
  for (const p of options.patterns ?? []) {
    const re = toGlobalRegExp(p);
    if (!re.test('')) custom.push(re);
  }
  const opts: InternalOptions = {
    extraSecrets: options.extraSecrets ? [...options.extraSecrets] : undefined,
    env: options.env,
    custom,
  };
  return {
    redact: (text) => redactWith(text, opts),
    forProvider: (text) => stripHomePaths(redactWith(text, opts)),
  };
}

/**
 * Deep copy of `value` with every string redacted. Strings under a field
 * whose name says it holds a credential (`password`, `apiKey`, `sessionToken`)
 * are replaced whole, since a structured value has no surrounding text for a
 * pattern to recognise. Keys are kept; cycles become "[Circular]".
 */
export function redactValue(value: unknown, redactor: (s: string) => string = redact): unknown {
  return walk(value, redactor, new WeakSet(), 0, null);
}

const envNameCache = new Map<string, boolean>();

/** Environment variable names that hold credentials: GITHUB_TOKEN, AWS_SECRET_ACCESS_KEY, DB_PASSWORD... */
export function isSecretEnvName(name: string): boolean {
  const cached = envNameCache.get(name);
  if (cached !== undefined) return cached;
  let secret = false;
  for (const segment of name.toUpperCase().split(/[^A-Z0-9]+/)) {
    if (!segment) continue;
    if (/TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL/.test(segment) || segment.endsWith('KEY') || segment === 'KEYS' || segment === 'PASS') {
      secret = true;
      break;
    }
  }
  if (envNameCache.size < 4096) envNameCache.set(name, secret);
  return secret;
}

/** Field names in structured data that hold a credential. Stricter than env names: `cacheKey` is not one. */
export function isSecretFieldName(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/(?:password|passwd|passphrase|secret|token|apikey|accesskey|secretkey|secretkeybase|signingkey|encryptionkey|masterkey|privatekey|credential|credentials|authorization|cookie)$/.test(n)) return true;
  // `pass` as a word of its own (`db_pass`, `dbPass`), never inside `bypass`.
  return /(?:^|[^A-Za-z0-9])pass$/i.test(name) || /[a-z0-9]Pass$/.test(name);
}

/** Values of secret-named variables worth redacting, longest first. */
export function envSecretValues(env: Readonly<Record<string, string | undefined>> = process.env): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  for (const name of Object.keys(env)) {
    if (!isSecretEnvName(name)) continue;
    const value = env[name];
    if (!value || value.length < MIN_ENV_SECRET_LENGTH) continue;
    // Numeric limits (MAX_TOKENS=100000000) and flags are configuration, not credentials.
    if (/^\d+$/.test(value) || /^(?:true|false|yes|no|on|off|null|none)$/i.test(value)) continue;
    out.push({ name, value });
  }
  return out.sort((a, b) => b.value.length - a.value.length);
}

// ---------------------------------------------------------------------------

interface InternalOptions {
  extraSecrets?: Iterable<string> | undefined;
  env?: Readonly<Record<string, string | undefined>> | undefined;
  custom?: RegExp[];
}

/** A replacement that also covers input past the end of the match, up to `end`. */
interface Extended {
  text: string;
  end: number;
}

interface Rule {
  re: RegExp;
  /** Cheap prefilter: the rule is skipped when none of these substrings occur. */
  hints?: readonly string[];
  /** Case-insensitive prefilter for rules keyed on words like "password". */
  hintRe?: RegExp;
  replace: (match: string, groups: string[], offset: number, input: string) => string | Extended;
}

// Key names end in one of these. `pass` counts only as a word of its own
// (DB_PASS, not bypass); SECRET_KEY and friends are named before plain `secret`
// would stop the match short of the `=`.
const KEYWORDS = String.raw`(?:password|passwd|passphrase|(?<![a-z0-9])pass|secret(?:[_-]?key(?:[_-]?base)?)?|(?:signing|encryption|master)[_-]?key|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth)`;
const KEYWORD_HINT = /pass|secret|token|key|credential|auth/i;
// Quoted literals honour backslash escapes so `"ab\"cd"` is redacted whole.
const DQ = String.raw`"(?:[^"\\\n]|\\.){0,4096}"`;
const SQ = String.raw`'(?:[^'\\\n]|\\.){0,4096}'`;

const tag = (kind: string): string => `[REDACTED:${kind}]`;
const whole = (kind: string) => (): string => tag(kind);

function kindForKey(key: string): string {
  const k = key.toLowerCase();
  if (k.includes('pass')) return 'password';
  if (k.includes('secret')) return 'secret';
  if (k.includes('token')) return 'token';
  if (k.includes('credential')) return 'credential';
  if (k.includes('key')) return 'key';
  return 'auth';
}

const SCHEME_WORDS = /^(?:bearer|basic|token|digest)$/i;
const NOT_SECRET_WORDS =
  /^(?:null|undefined|none|nil|true|false|string|str|number|int|float|bool|boolean|bytes|any|unknown|object|never|void|bigint|required|optional|redacted|bearer|basic|digest|await|new|this|self|typeof|function|async|yield)$/i;

/**
 * Values that refer to a secret rather than being one, in unquoted shell,
 * env-file and YAML text: any `$name` expansion, an operator such as `=>`,
 * plus everything `isLiteralPlaceholder` accepts.
 */
function isPlaceholder(value: string): boolean {
  const v = value.trim();
  if (isLiteralPlaceholder(v)) return true;
  if (v === '$' || /^\$(?:\{|\(|[A-Za-z_])/.test(v)) return true;
  return v.startsWith('=') || v.startsWith('>');
}

/**
 * Placeholders inside a quoted literal or a structured value, where `$x`,
 * `=x` and `>x` are just characters of the value: whole templates
 * (`${X}`, `$(cmd)`, `{{ x }}`, `<x>`), upper-case variable names, earlier
 * redactions, environment lookups, masks and type names.
 */
function isLiteralPlaceholder(value: string): boolean {
  const v = value.trim();
  if (v.length === 0) return true;
  if (v.startsWith('[REDACTED')) return true;
  if (/^\$\{[^\n]*\}$/.test(v) || /^\$\([^\n]*\)$/.test(v) || /^\$[A-Z_][A-Z0-9_]*$/.test(v)) return true;
  if (/^%[A-Za-z_][A-Za-z0-9_]*%$/.test(v)) return true;
  if (/^<[^<>]*>$/.test(v) || v.startsWith('{{')) return true;
  if (/^(?:[*•]+|[xX]{3,}|\.{3,})$/.test(v)) return true;
  if (/^(?:process\.env|os\.environ|import\.meta\.env|secrets\.|vars\.|env\.)/i.test(v)) return true;
  return NOT_SECRET_WORDS.test(v);
}

const IDENTIFIER_PATH = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/**
 * `password = password_from_env` (Python) and `password = hunter2` (INI) are
 * the same shape; an identifier is taken to be a variable unless it looks
 * generated: long, mixed case, with digits and no dots.
 */
function looksLikeVariable(value: string): boolean {
  if (!IDENTIFIER_PATH.test(value)) return false;
  const random = value.length >= 20 && !value.includes('.') && /\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value);
  return !random;
}

const RULES: readonly Rule[] = [
  {
    // scheme://user:password@host. The password may itself contain '@'; the
    // greedy class backtracks to the last '@' before the host.
    hints: ['://'],
    // The user name may be empty (`redis://:password@host`).
    re: /(?<![A-Za-z0-9+.-])([A-Za-z][A-Za-z0-9+.-]{0,30}:\/\/)[^\s:@/?#'"<>]{0,256}:[^\s/?#'"<>]{1,4096}@(?=[A-Za-z0-9[])/g,
    replace: (_m, g) => `${g[0]}${tag('url-credentials')}@`,
  },
  {
    hints: ['sk-ant-'],
    re: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{6,}/g,
    replace: whole('anthropic-key'),
  },
  {
    // Real keys contain a digit; requiring one keeps CSS names such as
    // "sk-spinner-fading-circle" intact.
    hints: ['sk-'],
    re: /(?<![A-Za-z0-9_-])sk-(?:proj-|svcacct-|admin-)?(?=[A-Za-z_-]{0,256}[0-9])[A-Za-z0-9_-]{20,}/g,
    replace: whole('openai-key'),
  },
  {
    hints: ['ghp_', 'gho_', 'ghu_', 'ghs_', 'ghr_', 'github_pat_'],
    re: /(?<![A-Za-z0-9_])(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
    replace: whole('github-token'),
  },
  {
    re: /(?<![A-Za-z0-9])(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|APKA)[A-Z0-9]{16}(?![A-Za-z0-9])/g,
    replace: whole('aws-access-key'),
  },
  {
    // A bare 40-character base64 string is indistinguishable from a git sha
    // or a digest, so the secret key is recognised only next to its name.
    hintRe: /secret/i,
    re: /((?:aws_?)?secret_?(?:access_?)?key["']?[ \t]*[:=][ \t]*["']?)[A-Za-z0-9/+]{40}(?![A-Za-z0-9/+])/gi,
    replace: (_m, g) => `${g[0]}${tag('aws-secret-key')}`,
  },
  {
    hints: ['xox', 'xapp-'],
    re: /(?<![A-Za-z0-9-])(?:xox[abposre]-[A-Za-z0-9-]{10,}|xapp-[0-9]-[A-Za-z0-9-]{10,})/g,
    replace: whole('slack-token'),
  },
  {
    hints: ['hooks.slack.com'],
    re: /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]{10,}/g,
    replace: whole('slack-webhook'),
  },
  {
    hints: ['eyJ'],
    re: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g,
    replace: whole('jwt'),
  },
  {
    hintRe: /authorization/i,
    // The value class is unbounded: nothing follows it, so it cannot backtrack,
    // and a bound would leave the tail of a long token in place.
    re: /((?:proxy-)?authorization["'`]?[ \t]*[:=][ \t]*["'`]?(?:(?:bearer|basic|token|digest)[ \t]+)?)([^\s"'`,;]+)/gi,
    replace: (m, g) => (isPlaceholder(g[1]!) || SCHEME_WORDS.test(g[1]!) ? m : `${g[0]}${tag('authorization')}`),
  },
  {
    hintRe: /bearer/i,
    re: /(?<![A-Za-z0-9_-])([Bb]earer[ \t]+)(?=[A-Za-z._~+/-]{0,256}[0-9])[A-Za-z0-9._~+/-]{16,}=*/g,
    replace: (_m, g) => `${g[0]}${tag('bearer')}`,
  },
  {
    // KEY=value with no spaces: env files, shell exports, query strings, --flags.
    hintRe: KEYWORD_HINT,
    re: new RegExp(String.raw`(?<![A-Za-z0-9_.-])([A-Za-z0-9_.-]{0,64}?${KEYWORDS})(["']?=)(?![\s=>])(${DQ}|${SQ}|[^\s"'&;,<>(){}\[\]]+)`, 'gi'),
    replace: (m, g, offset, input) => {
      const [key, eq, value] = g as [string, string, string];
      const kind = kindForKey(key);
      if (value.startsWith('"') || value.startsWith("'")) {
        // A shell expands `$NAME` inside double quotes but not inside single ones.
        const inner = value.slice(1, -1);
        if (value.startsWith("'") ? isLiteralPlaceholder(inner) : isPlaceholder(inner)) return m;
        return `${key}${eq}${value[0]}${tag(kind)}${value[0]}`;
      }
      // `X=${X}` is a template, `X=$X` an expansion.
      if (isPlaceholder(value)) return m;
      const end = offset + m.length;
      const next = input[end] ?? '';
      // `token=getToken()` is a call and `key=tokens[0]` an index: an
      // identifier followed by a bracket that closes later on the line. A
      // literal such as `Kd8x(2mQ` does not close what it opens.
      if ((next === '(' || next === '[') && IDENTIFIER_PATH.test(value) && closesOnLine(input, end + 1, next === '(' ? ')' : ']')) return m;
      const glued = gluedEnd(input, end);
      // `f(password=password)` passes a variable as a keyword argument.
      if (glued === end && looksLikeVariable(value) && /[(,]/.test(previousNonBlank(input, offset))) return m;
      const text = `${key}${eq}${tag(kind)}`;
      return glued > end ? { text, end: glued } : text;
    },
  },
  {
    // key: "value" or key = 'value' with a quoted literal (JSON, YAML, source).
    hintRe: KEYWORD_HINT,
    re: new RegExp(String.raw`(?<![A-Za-z0-9_.-])(["']?)([A-Za-z0-9_.-]{0,64}?${KEYWORDS})\1([ \t]*[:=][ \t]*)(${DQ}|${SQ})`, 'gi'),
    replace: (m, g) => {
      const [q, key, sep, value] = g as [string, string, string, string];
      if (isLiteralPlaceholder(value.slice(1, -1))) return m;
      return `${q}${key}${q}${sep}${value[0]}${tag(kindForKey(key))}${value[0]}`;
    },
  },
  {
    // YAML-style `password: hunter2` on its own line. Type annotations,
    // multi-word prose, object-literal entries holding a variable
    // (`token: tok,`), calls, anchors and block scalars are left alone. A
    // trailing `# comment` is not part of a YAML plain scalar and is kept.
    hintRe: KEYWORD_HINT,
    re: new RegExp(String.raw`^([ \t]*(?:-[ \t]+)?[A-Za-z0-9_.-]{0,64}?${KEYWORDS}:[ \t]+)([^\s"'#][^\n]{0,4096})$`, 'gim'),
    replace: (m, g) => {
      const [prefix, raw] = g as [string, string];
      const comment = /^(\S+)([ \t]+#[^\n]*)$/.exec(raw);
      const body = comment ? comment[1]! : raw.trimEnd();
      const rest = comment ? comment[2]! : raw.slice(body.length);
      const punct = /[,;]+$/.exec(body)?.[0] ?? '';
      const value = body.slice(0, body.length - punct.length);
      if (value === '' || isPlaceholder(value) || /\s/.test(value) || /[{}()]$/.test(value)) return m;
      if (punct && looksLikeVariable(value)) return m;
      if (/^[|>][-+0-9]*$/.test(value) || /^[&*!][A-Za-z0-9_-]+$/.test(value)) return m;
      if (/^[A-Za-z_][\w.]*(?:\[[^\]]*\]|<[^>]*>)$/.test(value)) return m;
      return `${prefix}${tag(kindForKey(prefix))}${punct}${rest}`;
    },
  },
  {
    // INI/TOML/credentials-file style `aws_session_token = IQoJb3JpZ2lu...`
    // on its own line, optionally followed by a `# comment` or `; comment`.
    // Source code assigns expressions and variables in the same shape, so
    // those are skipped.
    hintRe: KEYWORD_HINT,
    re: new RegExp(String.raw`^([ \t]*[A-Za-z0-9_.-]{0,64}?${KEYWORDS}[ \t]+=[ \t]*|[ \t]*[A-Za-z0-9_.-]{0,64}?${KEYWORDS}=[ \t]+)([^\s"'#;\x60][^\s]{0,4096})([ \t]+[#;][^\n]{0,4096})?[ \t]*$`, 'gim'),
    replace: (m, g) => {
      const [prefix, value, comment] = g as [string, string, string];
      if (isPlaceholder(value) || looksLikeVariable(value) || /[()[\]{},;]/.test(value)) return m;
      return `${prefix}${tag(kindForKey(prefix))}${comment}`;
    },
  },
];

// Whitespace, a quote, or a query-string `&` ends a bare value.
const VALUE_END = /[\s"'`&]/;
const STOP = /[\s"'`]/;
// Closing brackets, separators and sentence punctuation.
const CLOSERS = ')]}>,;.:!?';

/**
 * Where a bare value really ends. The pattern stops at brackets and
 * separators so `f(token=abc)` and `token=abc;` keep their punctuation, but a
 * secret may contain those characters too (`x8#Kd(2mQ`, `p,ss`). A run of
 * closers and separators right before whitespace or the end is punctuation;
 * anything else glued on belongs to the value, up to whitespace or a quote.
 * Every character scanned is either a closer run that ends the value or
 * swallowed with it, so the total work stays linear.
 */
function gluedEnd(input: string, end: number): number {
  const c = input[end];
  if (c === undefined || VALUE_END.test(c)) return end;
  let i = end;
  while (i < input.length && CLOSERS.includes(input[i]!)) i++;
  if (i > end && (i === input.length || STOP.test(input[i]!))) return end;
  while (i < input.length && !STOP.test(input[i]!)) i++;
  return i;
}

/** Whether `closer` appears soon after `from` on the same line; bounded so repeated calls stay cheap. */
function closesOnLine(input: string, from: number, closer: string): boolean {
  const limit = Math.min(input.length, from + 256);
  for (let i = from; i < limit; i++) {
    const c = input[i];
    if (c === closer) return true;
    if (c === '\n') return false;
  }
  return false;
}

function previousNonBlank(input: string, offset: number): string {
  let i = offset - 1;
  while (i >= 0 && (input[i] === ' ' || input[i] === '\t')) i--;
  return i >= 0 ? input[i]! : '';
}

function redactWith(input: string, opts: InternalOptions): string {
  if (typeof input !== 'string' || input.length === 0) return input;
  let text = input;

  // Exact values first, so a known secret goes even when no pattern knows its shape.
  const exact: { value: string; kind: string }[] = [];
  for (const s of opts.extraSecrets ?? []) {
    if (typeof s === 'string' && s.length >= MIN_EXTRA_SECRET_LENGTH) exact.push({ value: s, kind: 'secret' });
  }
  for (const { name, value } of envSecretValues(opts.env ?? process.env)) exact.push({ value, kind: `env:${name}` });
  exact.sort((a, b) => b.value.length - a.value.length);
  for (const { value, kind } of exact) {
    if (text.includes(value)) text = text.split(value).join(tag(kind));
    const encoded = encodeURIComponent(value);
    if (encoded !== value && text.includes(encoded)) text = text.split(encoded).join(tag(kind));
  }

  text = redactPrivateKeys(text);

  for (const rule of RULES) {
    if (rule.hints && !rule.hints.some((h) => text.includes(h))) continue;
    if (rule.hintRe && !rule.hintRe.test(text)) continue;
    text = applyRule(rule, text);
  }

  for (const re of [...(opts.custom ?? []), ...registered.values()]) {
    re.lastIndex = 0;
    text = text.replace(re, tag('custom'));
  }
  return text;
}

/**
 * String.replace with one extension: a rule may claim input past the end of
 * its match (a value glued to brackets), which is then replaced too and never
 * rescanned.
 */
function applyRule(rule: Rule, input: string): string {
  const re = rule.re;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let changed = false;
  for (let m = re.exec(input); m !== null; m = re.exec(input)) {
    const start = m.index;
    const matchEnd = start + m[0].length;
    const result = rule.replace(m[0], m.slice(1).map((g) => g ?? ''), start, input);
    const text = typeof result === 'string' ? result : result.text;
    const end = typeof result === 'string' ? matchEnd : Math.max(matchEnd, result.end);
    if (text !== m[0] || end !== matchEnd) {
      out += input.slice(last, start) + text;
      last = end;
      changed = true;
    }
    re.lastIndex = end > start ? end : start + 1;
  }
  return changed ? out + input.slice(last) : input;
}

const PEM_BEGIN = /-----BEGIN[A-Z0-9 ]{0,40} PRIVATE KEY(?: BLOCK)?-----/y;
const PEM_END = /-----END[A-Z0-9 ]{0,40} PRIVATE KEY(?: BLOCK)?-----/y;
// Body of a block cut off before its END line: base64 lines and the few
// header lines PEM allows, separated by real or JSON-escaped newlines.
const PEM_BODY = /(?:(?:\s|\\n|\\r)+(?:[A-Za-z0-9+/=]{16,}|[A-Za-z0-9+/]{1,15}={1,2}|(?:Proc-Type|DEK-Info|Comment|Version|Hash|Charset):[^\n]{0,200}))*/y;

/**
 * Removes private key blocks, including one truncated before its END line,
 * as log excerpts often are. Scans forward with indexOf and caches the next
 * END position, so the cost stays linear however many BEGIN lines repeat.
 */
function redactPrivateKeys(text: string): string {
  if (!text.includes('PRIVATE KEY')) return text;
  let out = '';
  let pos = 0;
  let cachedEnd = -2;
  const nextEnd = (from: number): number => {
    if (cachedEnd === -1 || cachedEnd >= from) return cachedEnd;
    cachedEnd = text.indexOf('-----END', from);
    return cachedEnd;
  };
  for (;;) {
    const begin = text.indexOf('-----BEGIN', pos);
    if (begin === -1) break;
    PEM_BEGIN.lastIndex = begin;
    const header = PEM_BEGIN.exec(text);
    if (!header) {
      out += text.slice(pos, begin + 10);
      pos = begin + 10;
      continue;
    }
    const bodyStart = begin + header[0].length;
    const nextBegin = text.indexOf('-----BEGIN', bodyStart);
    const limit = nextBegin === -1 ? text.length : nextBegin;
    let stop = -1;
    for (let e = nextEnd(bodyStart); e !== -1 && e < limit; e = nextEnd(e + 8)) {
      PEM_END.lastIndex = e;
      const footer = PEM_END.exec(text);
      if (footer) {
        stop = e + footer[0].length;
        break;
      }
    }
    if (stop === -1) {
      PEM_BODY.lastIndex = bodyStart;
      const body = PEM_BODY.exec(text);
      stop = Math.min(bodyStart + (body ? body[0].length : 0), limit);
    }
    out += text.slice(pos, begin) + tag('private-key');
    pos = stop;
  }
  return out + text.slice(pos);
}

const PATH_END = String.raw`/\s'"\x60:;,)\]}`;

/**
 * Home directories identify the user, so text sent to a provider names them
 * `~`. Any /Users/<name> or /home/<name> counts as a home directory: on the
 * machine Orbit runs on, the only interactive user is the one running it.
 */
function stripHomePaths(text: string): string {
  let out = text;
  const home = safeHomedir();
  if (home && home !== '/' && out.includes(home)) {
    out = out.replace(new RegExp(`${escapeRegExp(home)}(?![^${PATH_END}])`, 'g'), '~');
  }
  if (out.includes('/Users/') || out.includes('/home/')) {
    out = out.replace(new RegExp(String.raw`(?<![A-Za-z0-9_.~-])/(?:Users|home)/(?!Shared(?:[${PATH_END}]|$))[^${PATH_END}]+`, 'g'), '~');
  }
  return out;
}

function safeHomedir(): string | null {
  try {
    return homedir().replace(/\/+$/, '') || null;
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/**
 * Config validation compiles patterns with the `u` flag, so they are applied
 * with it too (`\p{L}` must mean a letter here as well); a string that only
 * compiles without it still works for direct callers.
 */
function toGlobalRegExp(p: RegExp | string): RegExp {
  if (typeof p === 'string') {
    try {
      return new RegExp(p, 'gu');
    } catch {
      return new RegExp(p, 'g');
    }
  }
  return p.flags.includes('g') ? new RegExp(p.source, p.flags) : new RegExp(p.source, `${p.flags}g`);
}

function walk(value: unknown, r: (s: string) => string, seen: WeakSet<object>, depth: number, secretKey: string | null): unknown {
  if (typeof value === 'string') {
    // Structured values are literal: `$x` here is not a shell expansion.
    if (secretKey !== null && !isLiteralPlaceholder(value)) return tag(kindForKey(secretKey));
    return r(value);
  }
  // A numeric PIN or password (YAML `password: 123456` parses to a number) is still a credential.
  if (secretKey !== null && (typeof value === 'number' || typeof value === 'bigint')) return tag(kindForKey(secretKey));
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  if (depth > 32) return '[MaxDepth]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => walk(v, r, seen, depth + 1, secretKey));
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Everything beneath a credential-named field is treated as credential.
      // Keys are redacted too: a map keyed by token would otherwise carry it.
      out[r(k)] = walk(v, r, seen, depth + 1, secretKey ?? (isSecretFieldName(k) ? k : null));
    }
    return out;
  } finally {
    seen.delete(value);
  }
}
