/**
 * Publication guard (docs/architecture.md "Publication guard"). Before text
 * leaves the repository it came from (global knowledge graph, overlays, demo
 * or documentation artifacts, another repository), it is checked against the
 * private terms file shared with the publish-guard plugin and for email
 * identities that are not explicitly allowed.
 *
 * The guard must never become the leak: a term is held only inside a
 * compiled matcher that does not print, warnings name line numbers instead
 * of terms, and excerpts replace every match with a block character.
 *
 * Terms file format (shared with publish-guard): one term per line; blank
 * lines and lines starting with '#' are ignored; a plain line is a
 * case-insensitive substring; a line starting with 're:' is a regular
 * expression, also matched case-insensitively. Orbit additionally treats the
 * spaces, dots, dashes, underscores and slashes inside a plain term as
 * interchangeable or absent, so "acme corp" also catches "Acme-Corp" and
 * "acmecorp"; that only ever blocks more.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { OrbitError } from '../core/errors.ts';

export const DEFAULT_TERMS_PATH_PARTS = ['.config', 'publish-guard', 'terms.txt'] as const;
export const DEFAULT_GUARD_CONFIG_PATH_PARTS = ['.config', 'publish-guard', 'config.json'] as const;

/** Replaces every matched term or identity in an excerpt. */
export const MASK = '█';
const CONTEXT_CHARS = 24;
const REDACTION_PASSES = 4;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * publish-guard's settings file: `$PUBLISH_GUARD_CONFIG`, else
 * `$XDG_CONFIG_HOME/publish-guard/config.json`, else
 * `~/.config/publish-guard/config.json`. Resolved exactly as publish-guard
 * resolves it, because looking anywhere else would check a different terms
 * file than the one the user maintains.
 */
export function defaultGuardConfigPath(env: Env = process.env): string {
  const override = env.PUBLISH_GUARD_CONFIG;
  if (override) return resolveFrom(process.cwd(), override, env);
  const base = env.XDG_CONFIG_HOME ? expandHome(env.XDG_CONFIG_HOME, env) : join(home(env), '.config');
  return join(base, 'publish-guard', 'config.json');
}

/** publish-guard's terms file when its settings do not name one: terms.txt beside the settings file. */
export function defaultTermsPath(env: Env = process.env): string {
  return join(dirname(defaultGuardConfigPath(env)), 'terms.txt');
}

/**
 * One private term. The pattern lives in a private field, so neither
 * JSON.stringify nor console.log nor util.inspect can print it; only the
 * line number is visible.
 */
export class GuardTerm {
  readonly line: number;
  readonly kind: 'substring' | 'regex';
  /** False when the line could not be compiled; such a term blocks every publication. */
  readonly usable: boolean;
  readonly #matcher: RegExp | null;

  constructor(line: number, kind: 'substring' | 'regex', matcher: RegExp | null) {
    this.line = line;
    this.kind = kind;
    this.#matcher = matcher;
    this.usable = matcher !== null;
  }

  /** Match ranges in `text` (already sanitized), skipping empty matches. */
  ranges(text: string): { start: number; end: number }[] {
    if (!this.#matcher) return [];
    const re = new RegExp(this.#matcher.source, this.#matcher.flags);
    const out: { start: number; end: number }[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex = m.index + 1;
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length });
    }
    return out;
  }

  toJSON(): { line: number; kind: string; usable: boolean } {
    return { line: this.line, kind: this.kind, usable: this.usable };
  }

  [inspect.custom](): string {
    return `GuardTerm { line: ${this.line}, kind: '${this.kind}', usable: ${this.usable} }`;
  }
}

export interface TermsList {
  path: string;
  /** False when the file does not exist; the list is then empty. */
  found: boolean;
  terms: GuardTerm[];
  /** Human-readable problems. They name line numbers, never terms. */
  warnings: string[];
}

/**
 * Load the terms file. A missing file is not an error (the user may not use
 * publish-guard) but is reported. A file that exists and cannot be read
 * fails closed with CONFIG_INVALID, since silently checking nothing would
 * let private text through.
 */
export function loadTerms(path: string = defaultTermsPath()): TermsList {
  const resolved = expandHome(path);
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: resolved, found: false, terms: [], warnings: [`publication guard: terms file ${resolved} not found; no private terms are checked`] };
    }
    throw new OrbitError('CONFIG_INVALID', `publication guard: terms file ${resolved} exists but cannot be read`, { path: resolved }, { cause: err });
  }
  const { terms, warnings } = parseTerms(raw);
  return { path: resolved, found: true, terms, warnings };
}

/** Parse terms file content. Exposed for tests and for callers holding the text already. */
export function parseTerms(content: string): { terms: GuardTerm[]; warnings: string[] } {
  const terms: GuardTerm[] = [];
  const warnings: string[] = [];
  content.split(/\r?\n/).forEach((rawLine, i) => {
    const line = i + 1;
    const trimmed = rawLine.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    if (trimmed.startsWith('re:')) {
      const source = trimmed.slice(3).trim();
      const re = source === '' ? null : compileRegexTerm(source);
      if (!re) warnings.push(`publication guard: terms file line ${line} is not a usable regular expression; publication is refused until it is fixed`);
      terms.push(new GuardTerm(line, 'regex', re));
      return;
    }
    const re = substringMatcher(trimmed);
    if (!re) {
      warnings.push(`publication guard: terms file line ${line} has no letters or digits and is ignored`);
      return;
    }
    if (trimmed.length < 3) warnings.push(`publication guard: terms file line ${line} is shorter than 3 characters and will match very broadly`);
    terms.push(new GuardTerm(line, 'substring', re));
  });
  return { terms, warnings };
}

const SEPARATORS = '[\\s._/-]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function substringMatcher(term: string): RegExp | null {
  const parts = sanitize(term).split(new RegExp(`${SEPARATORS}+`, 'u')).filter((p) => p !== '');
  if (parts.length === 0) return null;
  return new RegExp(parts.map(escapeRegExp).join(`${SEPARATORS}*`), 'giu');
}

/**
 * publish-guard's regex lines may use Python syntax. The common differences
 * are translated; anything else that JavaScript cannot compile is reported
 * and makes the guard refuse, rather than skipping the term.
 */
function compileRegexTerm(source: string): RegExp | null {
  const translated = source
    .replace(/^\(\?i\)/, '')
    .replace(/\(\?P<([A-Za-z_][A-Za-z0-9_]*)>/g, '(?<$1>')
    .replace(/\(\?P=([A-Za-z_][A-Za-z0-9_]*)\)/g, '\\k<$1>')
    .replace(/\\A/g, '^')
    .replace(/\\Z/g, '$');
  for (const flags of ['giu', 'gi']) {
    try {
      return new RegExp(translated, flags);
    } catch {
      /* try the next flag set */
    }
  }
  return null;
}

/**
 * NFKC folds look-alike forms (full-width letters, ligatures). Removing
 * format and default-ignorable characters (zero-width spaces and joiners,
 * soft hyphens, bidi marks, the combining grapheme joiner, variation
 * selectors) and control characters other than whitespace stops a term from
 * being split invisibly. Removal can only join text, so it only adds matches.
 */
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}\u0000-\u0008\u000e-\u001f\u007f-\u009f]/gu;

function sanitize(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '');
}

function home(env: Env = process.env): string {
  return env.HOME || homedir();
}

function expandHome(p: string, env: Env = process.env): string {
  if (p === '~') return home(env);
  if (p.startsWith('~/')) return join(home(env), p.slice(2));
  return p;
}

function resolveFrom(base: string, p: string, env: Env = process.env): string {
  const expanded = expandHome(p, env);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

/**
 * Text that went through JSON.stringify (the global knowledge graph checks
 * the canonical JSON of a lesson) carries separators and control characters
 * as escapes, so "acme\\ncorp" would slip past the separator-tolerant
 * matcher. The decoded view is checked as well. null when there is nothing
 * to decode.
 */
function decodeJsonEscapes(text: string): string | null {
  if (!text.includes('\\')) return null;
  const decoded = text.replace(/\\(["\\/bfnrt]|u[0-9a-fA-F]{4})/g, (_m, esc: string) => {
    switch (esc[0]) {
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return String.fromCharCode(parseInt(esc.slice(1), 16));
      default:
        return esc;
    }
  });
  return decoded === text ? null : decoded;
}

// ---------------------------------------------------------------------------
// Checking

export interface PublicationCheckOptions {
  terms: readonly GuardTerm[] | TermsList;
  /** Exact addresses that may appear (case-insensitive). */
  allowedEmails?: readonly string[];
  /** Regular expressions (searched, case-insensitive) for addresses that may appear. */
  allowedEmailPatterns?: readonly (string | RegExp)[];
  /** Addresses at reserved example domains (RFC 2606/6761) are not identities. Default true. */
  allowReservedEmailDomains?: boolean;
}

export interface PublicationViolation {
  kind: 'term' | 'email';
  /** Terms file line of the matching term. */
  termLine?: number;
  /** Surrounding text with every match replaced by MASK. Never contains a term or a blocked address. */
  excerpt: string;
}

export interface PublicationResult {
  ok: boolean;
  violations: PublicationViolation[];
}

const LOCAL_CHAR = /[\p{L}\p{N}._%+-]/u;
const DOMAIN_CHAR = /[\p{L}\p{N}.-]/u;
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;
const TOP_LABEL = /^\p{L}{2,}$/u;
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

interface Hit {
  start: number;
  end: number;
  kind: 'term' | 'email';
  termLine?: number;
}

export function checkPublication(text: string, opts: PublicationCheckOptions): PublicationResult {
  const terms = Array.isArray(opts.terms) ? (opts.terms as readonly GuardTerm[]) : (opts.terms as TermsList).terms;
  const usable = terms.filter((t) => t.usable);
  const violations: PublicationViolation[] = [];

  for (const term of terms) {
    if (!term.usable) {
      // Fail closed: a term that cannot be evaluated cannot clear any text.
      violations.push({ kind: 'term', termLine: term.line, excerpt: `(terms file line ${term.line} could not be compiled, so no text can be cleared)` });
    }
  }

  const allowed = new Set((opts.allowedEmails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => e !== ''));
  const patterns = (opts.allowedEmailPatterns ?? []).map(compileAllowPattern).filter((p): p is RegExp => p !== null);
  const allowReserved = opts.allowReservedEmailDomains ?? true;
  const isAllowedEmail = (address: string): boolean => {
    const lower = address.toLowerCase();
    if (allowed.has(lower)) return true;
    if (allowReserved && RESERVED_DOMAIN.test(lower.slice(lower.lastIndexOf('@') + 1))) return true;
    return patterns.some((p) => p.test(address));
  };

  const primary = sanitize(text);
  const views = [primary];
  const decoded = decodeJsonEscapes(primary);
  if (decoded !== null) views.push(sanitize(decoded));

  // A match found in the primary view is reported once; a decoded view adds
  // only matches beyond those (counted per term and for addresses).
  const reported = new Map<string, number>();
  for (const view of views) {
    const hits: Hit[] = [];
    for (const term of usable) {
      for (const r of term.ranges(view)) hits.push({ ...r, kind: 'term', termLine: term.line });
    }
    for (const found of findEmails(view)) {
      if (!isAllowedEmail(view.slice(found.start, found.end))) hits.push({ ...found, kind: 'email' });
    }
    hits.sort((a, b) => a.start - b.start || a.end - b.end);
    const masked = mergeRanges(hits);
    const counts = new Map<string, number>();
    for (const h of hits) {
      const key = h.kind === 'term' ? `term:${h.termLine}` : 'email';
      const n = (counts.get(key) ?? 0) + 1;
      counts.set(key, n);
      if (n <= (reported.get(key) ?? 0)) continue;
      reported.set(key, n);
      violations.push({ kind: h.kind, ...(h.termLine !== undefined ? { termLine: h.termLine } : {}), excerpt: excerpt(view, h, masked, usable) });
    }
  }
  return { ok: violations.length === 0, violations };
}

/**
 * Email addresses, found by scanning outward from each '@' with the RFC 5321
 * length limits (64 for the local part, 253 for the domain). A single regex
 * over the whole text would backtrack quadratically on long runs of word
 * characters, such as an embedded hash or base64 blob.
 */
function findEmails(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let at = text.indexOf('@');
  while (at !== -1) {
    let start = at;
    while (start > 0 && at - start < 64 && LOCAL_CHAR.test(text[start - 1]!)) start--;
    while (start < at && text[start] === '.') start++;
    let end = at + 1;
    while (end < text.length && end - at - 1 < 253 && DOMAIN_CHAR.test(text[end]!)) end++;
    while (end > at + 1 && /[.-]/.test(text[end - 1]!)) end--;
    const labels = text.slice(at + 1, end).split('.');
    const valid = start < at && labels.length >= 2 && labels.every((l) => DOMAIN_LABEL.test(l)) && TOP_LABEL.test(labels.at(-1)!);
    if (valid) out.push({ start, end });
    at = text.indexOf('@', at + 1);
  }
  return out;
}

/** Throws POLICY_DENIED when `text` may not be published. The message counts matches and names none. */
export function assertPublishable(text: string, opts: PublicationCheckOptions, what = 'text'): void {
  const res = checkPublication(text, opts);
  if (res.ok) return;
  const terms = res.violations.filter((v) => v.kind === 'term').length;
  const emails = res.violations.length - terms;
  throw new OrbitError(
    'POLICY_DENIED',
    `publication guard refused ${what}: ${terms} private term match${terms === 1 ? '' : 'es'}, ${emails} unapproved email address${emails === 1 ? '' : 'es'}`,
    { violations: res.violations },
  );
}

function compileAllowPattern(p: string | RegExp): RegExp | null {
  // An empty pattern would match every address; it is a mistake, not a rule.
  if (typeof p === 'string' && p.trim() === '') return null;
  if (p instanceof RegExp) {
    if (p.source === '(?:)') return null;
    // Stateful flags would make test() depend on the previous call.
    const flags = p.flags.replace(/[gy]/g, '');
    return new RegExp(p.source, flags.includes('i') ? flags : `${flags}i`);
  }
  for (const flags of ['iu', 'i']) {
    try {
      return new RegExp(p, flags);
    } catch {
      /* try the next flag set */
    }
  }
  // An allow pattern that cannot compile allows nothing.
  return null;
}

function mergeRanges(hits: readonly { start: number; end: number }[]): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  for (const h of hits) {
    const last = out.at(-1);
    if (last && h.start <= last.end) last.end = Math.max(last.end, h.end);
    else out.push({ start: h.start, end: h.end });
  }
  return out;
}

/**
 * Context around one hit with every masked range (not only this hit's)
 * collapsed to a single MASK, so neither the term, its length nor a second
 * match nearby shows. Window edges that fall inside a masked range still
 * print MASK rather than a fragment.
 */
function excerpt(text: string, hit: Hit, masked: readonly { start: number; end: number }[], terms: readonly GuardTerm[]): string {
  let from = Math.max(0, hit.start - CONTEXT_CHARS);
  let to = Math.min(text.length, hit.end + CONTEXT_CHARS);
  // Widen the edges to whole masked ranges so truncation marks reflect text
  // that was really left out, not the inside of a mask.
  for (const r of masked) {
    if (r.start < from && r.end > from) from = r.start;
    if (r.start < to && r.end > to) to = r.end;
  }
  let out = from > 0 ? '…' : '';
  let pos = from;
  for (const r of masked) {
    if (r.end <= from || r.start >= to) continue;
    if (r.start > pos) out += text.slice(pos, r.start);
    out += MASK;
    pos = Math.max(pos, r.end);
  }
  if (pos < to) out += text.slice(pos, to);
  if (to < text.length) out += '…';
  return redactAgain(out.replace(/\s+/g, ' '), terms);
}

/**
 * Cutting, masking and collapsing whitespace can form a new match (a regex
 * term with a literal space, or one that spans a mask), so the finished
 * excerpt is redacted again until no term matches. If that does not settle,
 * nothing of the excerpt is shown.
 */
function redactAgain(text: string, terms: readonly GuardTerm[]): string {
  let out = text;
  for (let pass = 0; pass < REDACTION_PASSES; pass++) {
    const ranges = mergeRanges(terms.flatMap((t) => t.ranges(out)).sort((a, b) => a.start - b.start || a.end - b.end));
    if (ranges.length === 0) return out;
    let next = '';
    let pos = 0;
    for (const r of ranges) {
      next += out.slice(pos, r.start) + MASK;
      pos = r.end;
    }
    out = next + out.slice(pos);
  }
  return terms.some((t) => t.ranges(out).length > 0) ? MASK : out;
}

// ---------------------------------------------------------------------------
// publish-guard settings

export interface GuardSettings {
  /** The settings file that was looked for. */
  configPath: string;
  /** False when there is no settings file; the defaults then apply. */
  configFound: boolean;
  termsPath: string;
  allowedEmails: string[];
  allowedEmailPatterns: string[];
  warnings: string[];
}

/**
 * Read publish-guard's config.json (keys `terms_file`, `allowed_emails`,
 * `allowed_email_patterns`) the way publish-guard does: a relative or `~`
 * terms_file is resolved from the settings file's directory, and without one
 * the terms file is terms.txt beside it.
 *
 * A missing settings file means the defaults. A settings file that exists but
 * cannot be read, is not a JSON object, or names its terms file with
 * something other than a non-empty string throws CONFIG_INVALID: falling back
 * to the default terms path would silently check a different (possibly
 * absent) list than the one the user maintains. Malformed allow lists only
 * shrink what is allowed, so they are warnings.
 */
export function loadGuardSettings(configPath: string = defaultGuardConfigPath(), env: Env = process.env): GuardSettings {
  const resolved = resolveFrom(process.cwd(), configPath, env);
  const settings: GuardSettings = {
    configPath: resolved,
    configFound: false,
    termsPath: join(dirname(resolved), 'terms.txt'),
    allowedEmails: [],
    allowedEmailPatterns: [],
    warnings: [],
  };
  let raw: string;
  try {
    raw = readFileSync(resolved, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return settings;
    throw new OrbitError('CONFIG_INVALID', `publication guard: settings file ${resolved} exists but cannot be read`, { path: resolved }, { cause: err });
  }
  settings.configFound = true;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new OrbitError('CONFIG_INVALID', `publication guard: settings file ${resolved} is not valid JSON`, { path: resolved });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new OrbitError('CONFIG_INVALID', `publication guard: settings file ${resolved} is not a JSON object`, { path: resolved });
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.terms_file !== undefined) {
    if (typeof obj.terms_file !== 'string' || obj.terms_file.trim() === '') {
      throw new OrbitError('CONFIG_INVALID', `publication guard: terms_file in ${resolved} must be a non-empty string`, { path: resolved });
    }
    settings.termsPath = resolveFrom(dirname(resolved), obj.terms_file.trim(), env);
  }
  settings.allowedEmails = stringList(obj.allowed_emails, 'allowed_emails', settings.warnings);
  settings.allowedEmailPatterns = stringList(obj.allowed_email_patterns, 'allowed_email_patterns', settings.warnings);
  return settings;
}

function stringList(value: unknown, key: string, warnings: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    warnings.push(`publication guard: ${key} is not a list; ignored`);
    return [];
  }
  const out = value.filter((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (out.length !== value.length) warnings.push(`publication guard: ${key} has entries that are not non-empty strings; they are ignored`);
  return out;
}

export interface PublicationGuard {
  terms: TermsList;
  options: PublicationCheckOptions;
  warnings: string[];
}

/**
 * Settings plus terms, ready for checkPublication. `termsPath` overrides the
 * settings file (Orbit's own config may point elsewhere).
 *
 * Only an unconfigured guard may run without terms: when the terms file was
 * named explicitly, or a publish-guard settings file exists (publish-guard
 * itself then requires its terms file), a missing terms file throws
 * CONFIG_INVALID instead of checking nothing.
 */
export function loadPublicationGuard(opts: { configPath?: string; termsPath?: string; env?: Env } = {}): PublicationGuard {
  const env = opts.env ?? process.env;
  const settings = loadGuardSettings(opts.configPath ?? defaultGuardConfigPath(env), env);
  const explicit = opts.termsPath !== undefined;
  const termsPath = explicit ? resolveFrom(process.cwd(), opts.termsPath!, env) : settings.termsPath;
  const terms = loadTerms(termsPath);
  if (!terms.found && (explicit || settings.configFound)) {
    const why = explicit ? 'the configured terms file' : `the terms file named by ${settings.configPath}`;
    throw new OrbitError('CONFIG_INVALID', `publication guard: ${why} (${terms.path}) does not exist; refusing to publish without it`, { path: terms.path });
  }
  return {
    terms,
    options: { terms, allowedEmails: settings.allowedEmails, allowedEmailPatterns: settings.allowedEmailPatterns },
    warnings: [...settings.warnings, ...terms.warnings],
  };
}
