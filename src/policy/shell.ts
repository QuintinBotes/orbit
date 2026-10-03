/**
 * A small POSIX shell lexer and parser, enough to find the simple commands,
 * redirections, pipelines and substitutions inside one Bash tool call. It is
 * not a shell and expands nothing: a word whose value is only known at run
 * time (variables, command substitution, arithmetic) is marked `dynamic`, and
 * the source of every `$(...)`, backtick and `<(...)` is kept so the
 * classifier can look inside it.
 *
 * Constructs it does not model (case statements, function definitions,
 * arrays, extglobs) make parsing fail rather than guess; the classifier
 * treats a failed parse as "cannot see what this does".
 *
 * Two expansions do change which program runs and are modelled exactly,
 * because getting them wrong lets a command hide its name: ANSI-C `$'...'`
 * escapes are decoded the way bash decodes them, and unquoted brace
 * expansion (`{git,push}` is `git push`) turns one word into several.
 */

export interface Word {
  /** Quotes removed and escapes applied; dynamic parts kept verbatim (`$HOME`, `$(...)`). */
  text: string;
  /** Source text of the word. */
  raw: string;
  /** Some part is only known at run time. */
  dynamic: boolean;
  /** Some part was quoted, so it is not a reserved word, tilde or glob. */
  quoted: boolean;
  /** Unquoted glob characters present. */
  glob: boolean;
  /** Command and process substitutions in the word, as source text. */
  subs: string[];
  /** The whole word is a process substitution <(...) or >(...). */
  procSub: boolean;
}

export interface Redirect {
  op: string;
  fd: string | null;
  target: Word | null;
  /** Body of a here-document (`<<`), already cut from the input. */
  heredoc?: { body: string; quoted: boolean; subs: string[] };
}

export interface SimpleCommand {
  assigns: Word[];
  words: Word[];
  redirects: Redirect[];
  /** Pipeline index and position within it; stage > 0 reads the previous stage's output. */
  pipeline: number;
  stage: number;
  /** Ids of the ( ) subshells enclosing this command, outermost first. */
  scope: number[];
  /** Followed by `&`. */
  background: boolean;
}

export type ParseResult = { ok: true; commands: SimpleCommand[] } | { ok: false; error: string; commands: SimpleCommand[] };

/** A word as the lexer reads it, with the mask of characters that came from unquoted source text. */
interface LexWord extends Word {
  active: string;
}

type Token =
  | { kind: 'word'; word: LexWord }
  | { kind: 'op'; op: '&&' | '||' | ';' | '|' | '&' | '(' | ')' | '\n' }
  | { kind: 'redir'; op: string; fd: string | null; heredoc?: Redirect['heredoc'] };

class ShellSyntaxError extends Error {}

const MAX_INPUT = 100_000;

export function parseShell(src: string): ParseResult {
  if (src.length > MAX_INPUT) return { ok: false, error: 'command is too long to inspect', commands: [] };
  if (src.includes('\0')) return { ok: false, error: 'command contains a NUL byte', commands: [] };
  let tokens: Token[];
  try {
    tokens = lex(src);
  } catch (err) {
    return { ok: false, error: (err as Error).message, commands: [] };
  }
  return parseTokens(tokens);
}

// ---------------------------------------------------------------------------
// Lexer

function lex(s: string): Token[] {
  const tokens: Token[] = [];
  const n = s.length;
  let i = 0;
  const pendingHeredocs: { delim: string; strip: boolean; quoted: boolean; token: Extract<Token, { kind: 'redir' }> }[] = [];
  let expectHeredocDelim: Extract<Token, { kind: 'redir' }> | null = null;

  const readHeredocBodies = () => {
    for (const h of pendingHeredocs.splice(0)) {
      const lines: string[] = [];
      while (i < n) {
        let end = s.indexOf('\n', i);
        if (end < 0) end = n;
        const line = s.slice(i, end);
        i = end + 1;
        const cmp = h.strip ? line.replace(/^\t+/, '') : line;
        if (cmp === h.delim) break;
        lines.push(line);
      }
      const body = lines.join('\n');
      h.token.heredoc = { body, quoted: h.quoted, subs: h.quoted ? [] : scanDoubleQuotedSubs(body) };
    }
  };

  while (i < n) {
    const c = s[i]!;
    // Only space and tab separate words; bash keeps a carriage return inside the word.
    if (c === ' ' || c === '\t') {
      i++;
      continue;
    }
    if (c === '\\' && s[i + 1] === '\n') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      tokens.push({ kind: 'op', op: '\n' });
      i++;
      if (pendingHeredocs.length > 0) readHeredocBodies();
      continue;
    }
    if (c === '#') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    const two = s.slice(i, i + 2);
    const three = s.slice(i, i + 3);
    if (three === '&>>') {
      tokens.push({ kind: 'redir', op: '&>>', fd: null });
      i += 3;
      continue;
    }
    if (two === '&>') {
      tokens.push({ kind: 'redir', op: '&>', fd: null });
      i += 2;
      continue;
    }
    if (two === '&&' || two === '||') {
      tokens.push({ kind: 'op', op: two });
      i += 2;
      continue;
    }
    if (two === '|&') {
      tokens.push({ kind: 'op', op: '|' });
      i += 2;
      continue;
    }
    if (c === '|' || c === '&' || c === '(' || c === ')') {
      tokens.push({ kind: 'op', op: c });
      i++;
      continue;
    }
    if (c === ';') {
      // ;; ;& ;;& only appear in case statements, which end up unparseable anyway.
      i++;
      while (s[i] === ';' || s[i] === '&') i++;
      tokens.push({ kind: 'op', op: ';' });
      continue;
    }
    if ((c === '<' || c === '>') && s[i + 1] !== '(') {
      const op = readRedirOp();
      const tok: Extract<Token, { kind: 'redir' }> = { kind: 'redir', op, fd: null };
      tokens.push(tok);
      if (op === '<<' || op === '<<-') expectHeredocDelim = tok;
      continue;
    }
    // A word. A run of digits directly followed by < or > is a file descriptor.
    const start = i;
    const word = readWord();
    if (/^\d+$/.test(word.raw) && (s[i] === '<' || s[i] === '>') && s[i + 1] !== '(') {
      const op = readRedirOp();
      const tok: Extract<Token, { kind: 'redir' }> = { kind: 'redir', op, fd: word.raw };
      tokens.push(tok);
      if (op === '<<' || op === '<<-') expectHeredocDelim = tok;
      continue;
    }
    if (i === start) throw new ShellSyntaxError(`unexpected character ${JSON.stringify(c)}`);
    if (expectHeredocDelim) {
      pendingHeredocs.push({ delim: word.text, strip: expectHeredocDelim.op === '<<-', quoted: word.quoted, token: expectHeredocDelim });
      expectHeredocDelim = null;
    }
    tokens.push({ kind: 'word', word });
  }
  if (pendingHeredocs.length > 0) readHeredocBodies();
  return tokens;

  function readRedirOp(): string {
    for (const op of ['<<<', '<<-', '<<', '<>', '<&', '>>', '>|', '>&', '<', '>']) {
      if (s.startsWith(op, i)) {
        i += op.length;
        return op;
      }
    }
    throw new ShellSyntaxError('bad redirection');
  }

  function readWord(): LexWord {
    const start = i;
    let text = '';
    // One flag per character of `text`: true when it came from unquoted source
    // text, so it can still take part in brace expansion and globbing.
    let active = '';
    let dynamic = false;
    let quoted = false;
    let glob = false;
    let procSub = false;
    const subs: string[] = [];
    const put = (t: string, isActive: boolean) => {
      text += t;
      active += (isActive ? '1' : '0').repeat(t.length);
    };
    if ((s[i] === '<' || s[i] === '>') && s[i + 1] === '(') {
      const end = scanBalanced(s, i + 2);
      subs.push(s.slice(i + 2, end - 1));
      text = s.slice(i, end);
      i = end;
      return { text, raw: text, dynamic: true, quoted: false, glob: false, subs, procSub: true, active: '0'.repeat(text.length) };
    }
    while (i < n) {
      const c = s[i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '&' || c === '|' || c === '(' || c === ')' || c === '<' || c === '>') break;
      if (c === '\\') {
        if (s[i + 1] === '\n') {
          i += 2;
          continue;
        }
        if (i + 1 >= n) throw new ShellSyntaxError('trailing backslash');
        put(s[i + 1]!, false);
        quoted = true;
        i += 2;
        continue;
      }
      if (c === "'") {
        const end = s.indexOf("'", i + 1);
        if (end < 0) throw new ShellSyntaxError('unterminated single quote');
        put(s.slice(i + 1, end), false);
        quoted = true;
        i = end + 1;
        continue;
      }
      if (c === '"') {
        const r = readDoubleQuoted(i + 1);
        put(r.text, false);
        dynamic ||= r.dynamic;
        subs.push(...r.subs);
        quoted = true;
        i = r.end;
        continue;
      }
      if (c === '$') {
        const r = readDollar(i);
        if (r) {
          put(r.text, false);
          dynamic ||= r.dynamic;
          quoted ||= r.quoted;
          subs.push(...r.subs);
          i = r.end;
          continue;
        }
        put('$', true);
        i++;
        continue;
      }
      if (c === '`') {
        const end = scanBacktick(s, i + 1);
        subs.push(unescapeBacktick(s.slice(i + 1, end - 1)));
        put(s.slice(i, end), false);
        dynamic = true;
        i = end;
        continue;
      }
      if (c === '*' || c === '?' || c === '[') glob = true;
      put(c, true);
      i++;
    }
    return { text, raw: s.slice(start, i), dynamic, quoted, glob, subs, procSub, active };
  }

  function readDoubleQuoted(from: number): { text: string; dynamic: boolean; subs: string[]; end: number } {
    let j = from;
    let text = '';
    let dynamic = false;
    const subs: string[] = [];
    while (j < n) {
      const c = s[j]!;
      if (c === '"') return { text, dynamic, subs, end: j + 1 };
      if (c === '\\') {
        const next = s[j + 1];
        if (next === undefined) break;
        if (next === '\n') {
          j += 2;
          continue;
        }
        text += '$`"\\'.includes(next) ? next : `\\${next}`;
        j += 2;
        continue;
      }
      if (c === '$') {
        const r = readDollar(j);
        if (r) {
          text += r.text;
          dynamic ||= r.dynamic;
          subs.push(...r.subs);
          j = r.end;
          continue;
        }
      }
      if (c === '`') {
        const end = scanBacktick(s, j + 1);
        subs.push(unescapeBacktick(s.slice(j + 1, end - 1)));
        text += s.slice(j, end);
        dynamic = true;
        j = end;
        continue;
      }
      text += c;
      j++;
    }
    throw new ShellSyntaxError('unterminated double quote');
  }

  function readDollar(at: number): { text: string; dynamic: boolean; quoted: boolean; subs: string[]; end: number } | null {
    const next = s[at + 1];
    if (next === '(') {
      if (s[at + 2] === '(') {
        const end = scanBalanced(s, at + 3, 2);
        return { text: s.slice(at, end), dynamic: true, quoted: false, subs: scanDoubleQuotedSubs(s.slice(at + 3, end - 2)), end };
      }
      const end = scanBalanced(s, at + 2);
      return { text: s.slice(at, end), dynamic: true, quoted: false, subs: [s.slice(at + 2, end - 1)], end };
    }
    if (next === '{') {
      const end = scanBraces(s, at + 2);
      return { text: s.slice(at, end), dynamic: true, quoted: false, subs: scanDoubleQuotedSubs(s.slice(at + 2, end - 1)), end };
    }
    if (next === "'") {
      // ANSI-C quoting: a literal once escapes are applied (see decodeAnsiC).
      let j = at + 2;
      while (j < n && s[j] !== "'") j += s[j] === '\\' && j + 1 < n ? 2 : 1;
      if (j >= n) throw new ShellSyntaxError('unterminated $\'...\' string');
      return { text: decodeAnsiC(s.slice(at + 2, j)), dynamic: false, quoted: true, subs: [], end: j + 1 };
    }
    if (next === '"') {
      const r = readDoubleQuoted(at + 2);
      return { text: r.text, dynamic: r.dynamic, quoted: true, subs: r.subs, end: r.end };
    }
    if (next !== undefined && /[A-Za-z_]/.test(next)) {
      let j = at + 1;
      while (j < n && /[A-Za-z0-9_]/.test(s[j]!)) j++;
      return { text: s.slice(at, j), dynamic: true, quoted: false, subs: [], end: j };
    }
    if (next !== undefined && /[0-9@*#?$!-]/.test(next)) {
      return { text: s.slice(at, at + 2), dynamic: true, quoted: false, subs: [], end: at + 2 };
    }
    return null;
  }
}

/**
 * Index just past the `)` that closes a construct opened before `from`,
 * honouring quotes and nested substitutions. `closers` is 2 for `$((...))`.
 */
function scanBalanced(s: string, from: number, closers = 1): number {
  let depth = closers;
  let j = from;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", j + 1);
      if (end < 0) throw new ShellSyntaxError('unterminated single quote');
      j = end + 1;
      continue;
    }
    if (c === '"') {
      j = scanDoubleQuoteEnd(s, j + 1);
      continue;
    }
    if (c === '`') {
      j = scanBacktick(s, j + 1);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  throw new ShellSyntaxError('unterminated $( or (');
}

function scanDoubleQuoteEnd(s: string, from: number): number {
  let j = from;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '"') return j + 1;
    if (c === '$' && s[j + 1] === '(') {
      j = scanBalanced(s, j + 2);
      continue;
    }
    if (c === '`') {
      j = scanBacktick(s, j + 1);
      continue;
    }
    j++;
  }
  throw new ShellSyntaxError('unterminated double quote');
}

function scanBraces(s: string, from: number): number {
  let depth = 1;
  let j = from;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", j + 1);
      if (end < 0) throw new ShellSyntaxError('unterminated single quote');
      j = end + 1;
      continue;
    }
    if (c === '"') {
      j = scanDoubleQuoteEnd(s, j + 1);
      continue;
    }
    if (c === '$' && s[j + 1] === '(') {
      j = scanBalanced(s, j + 2);
      continue;
    }
    if (c === '`') {
      j = scanBacktick(s, j + 1);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  throw new ShellSyntaxError('unterminated ${');
}

function scanBacktick(s: string, from: number): number {
  let j = from;
  while (j < s.length) {
    if (s[j] === '\\') {
      j += 2;
      continue;
    }
    if (s[j] === '`') return j + 1;
    j++;
  }
  throw new ShellSyntaxError('unterminated backtick');
}

function unescapeBacktick(body: string): string {
  return body.replace(/\\([`$\\])/g, '$1');
}

/** Substitutions inside text that the shell expands like a double-quoted string (heredoc bodies, ${...}). */
function scanDoubleQuotedSubs(text: string): string[] {
  const subs: string[] = [];
  let j = 0;
  while (j < text.length) {
    const c = text[j]!;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (c === '$' && text[j + 1] === '(' && text[j + 2] !== '(') {
      try {
        const end = scanBalanced(text, j + 2);
        subs.push(text.slice(j + 2, end - 1));
        j = end;
        continue;
      } catch {
        // An unbalanced $( inside data is the shell's problem; record what we can.
        subs.push(text.slice(j + 2));
        break;
      }
    }
    if (c === '`') {
      try {
        const end = scanBacktick(text, j + 1);
        subs.push(unescapeBacktick(text.slice(j + 1, end - 1)));
        j = end;
        continue;
      } catch {
        subs.push(text.slice(j + 1));
        break;
      }
    }
    j++;
  }
  return subs;
}

const SIMPLE_ESCAPES: Record<string, string> = {
  a: '\x07',
  b: '\b',
  e: '\x1b',
  E: '\x1b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
  '\\': '\\',
  "'": "'",
  '"': '"',
  '?': '?',
};

/**
 * The value of a `$'...'` body, decoded as bash does: simple escapes, octal
 * `\nnn`, hex `\xHH`, unicode `\uHHHH`/`\UHHHHHHHH` and control `\cX`. An
 * escape bash does not recognise stays as written, and the value ends at the
 * first NUL it produces, because bash hands the string to C. Getting this
 * wrong lets `$'\x67it' push` hide the name of `git push`.
 */
export function decodeAnsiC(body: string): string {
  let out = '';
  let j = 0;
  while (j < body.length) {
    const c = body[j]!;
    if (c !== '\\' || j + 1 >= body.length) {
      out += c;
      j++;
      continue;
    }
    const e = body[j + 1]!;
    let decoded: string;
    let used = 2;
    if (Object.hasOwn(SIMPLE_ESCAPES, e)) {
      decoded = SIMPLE_ESCAPES[e]!;
    } else if (/[0-7]/.test(e)) {
      const digits = /^[0-7]{1,3}/.exec(body.slice(j + 1))![0];
      decoded = String.fromCharCode(parseInt(digits, 8) & 0xff);
      used = 1 + digits.length;
    } else if (e === 'x' || e === 'u' || e === 'U') {
      const max = e === 'x' ? 2 : e === 'u' ? 4 : 8;
      const digits = new RegExp(`^[0-9A-Fa-f]{1,${max}}`).exec(body.slice(j + 2))?.[0];
      if (!digits) {
        decoded = `\\${e}`;
      } else {
        const code = parseInt(digits, 16);
        decoded = code <= 0x10ffff ? String.fromCodePoint(code) : '';
        used = 2 + digits.length;
      }
    } else if (e === 'c' && j + 2 < body.length) {
      const ch = body[j + 2]!;
      decoded = ch === '?' ? '\x7f' : String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
      used = 3;
    } else {
      decoded = `\\${e}`;
    }
    const nul = decoded.indexOf('\0');
    if (nul >= 0) return out + decoded.slice(0, nul);
    out += decoded;
    j += used;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;

function parseTokens(tokens: Token[]): ParseResult {
  const commands: SimpleCommand[] = [];
  const scope: number[] = [];
  let nextScope = 1;
  let pipeline = 0;
  let stage = 0;
  let cur = fresh();
  let pendingRedir: Redirect | null = null;

  function fresh(): SimpleCommand {
    return { assigns: [], words: [], redirects: [], pipeline, stage, scope: [...scope], background: false };
  }
  function finish(): SimpleCommand | null {
    const done = cur;
    const nonEmpty = done.words.length > 0 || done.assigns.length > 0 || done.redirects.length > 0;
    if (nonEmpty) commands.push(done);
    return nonEmpty ? done : null;
  }
  const fail = (error: string): ParseResult => ({ ok: false, error, commands });

  for (const tok of tokens) {
    if (tok.kind === 'redir') {
      // Inside [[ ]] the < and > characters compare strings; they are not redirections.
      if (cur.words[0]?.text === '[[' && !cur.words[0].quoted && !cur.words.some((w) => w.text === ']]')) {
        cur.words.push({ text: tok.op, raw: tok.op, dynamic: false, quoted: false, glob: false, subs: [], procSub: false });
        continue;
      }
      if (pendingRedir) return fail('redirection without a target');
      pendingRedir = { op: tok.op, fd: tok.fd, target: null, ...(tok.heredoc ? { heredoc: tok.heredoc } : {}) };
      cur.redirects.push(pendingRedir);
      continue;
    }
    if (tok.kind === 'word') {
      if (pendingRedir) {
        // bash brace-expands a redirection target and refuses it when that gives
        // more than one word; recording one redirection per expansion over-reports
        // a command that fails, which is the safe direction.
        const [first, ...more] = expandBraces(tok.word);
        pendingRedir.target = first!;
        for (const extra of more) cur.redirects.push({ op: pendingRedir.op, fd: pendingRedir.fd, target: extra });
        pendingRedir = null;
        continue;
      }
      // The name and `=` must be unquoted in the source; the value may be quoted (`A="x y" cmd`).
      // Assignments are never brace-expanded; every other word may become several.
      if (cur.words.length === 0 && ASSIGNMENT.test(tok.word.raw)) cur.assigns.push(plainWord(tok.word));
      else cur.words.push(...expandBraces(tok.word));
      continue;
    }
    if (pendingRedir) return fail('redirection without a target');
    switch (tok.op) {
      case '&&':
      case '||':
      case ';':
      case '\n':
      case '&': {
        const done = finish();
        if (done && tok.op === '&') done.background = true;
        pipeline++;
        stage = 0;
        cur = fresh();
        break;
      }
      case '|': {
        if (!finish()) return fail('pipe without a command');
        stage++;
        cur = fresh();
        break;
      }
      case '(': {
        if (cur.words.length > 0 || cur.assigns.length > 0) return fail('unsupported syntax: "(" after a word (function definition, array or extglob)');
        scope.push(nextScope++);
        cur = fresh();
        break;
      }
      case ')': {
        if (scope.length === 0) return fail('unbalanced ")" (case statements are not supported)');
        finish();
        scope.pop();
        cur = fresh();
        break;
      }
    }
  }
  if (pendingRedir) return fail('redirection without a target');
  finish();
  if (scope.length > 0) return fail('unclosed "("');
  return { ok: true, commands };
}

// ---------------------------------------------------------------------------
// Brace expansion

/** More alternatives than this and the word is treated as computed: enumerating them would only slow the hook. */
const MAX_BRACE_RESULTS = 256;

function plainWord(w: LexWord): Word {
  const { active: _active, ...word } = w;
  return word;
}

/**
 * bash brace expansion of one word: `a{b,c}d` -> `abd acd`, nested groups,
 * and `{1..3}` / `{a..c}` sequences. Only braces and commas that came from
 * unquoted source text count, which is what the active mask records. A word
 * without a valid group is returned unchanged.
 */
export function expandBraces(w: LexWord): Word[] {
  if (!w.active.includes('1') || !/[{]/.test(w.text)) return [plainWord(w)];
  const results = expandText({ text: w.text, active: w.active }, 0);
  if (results === null) return [{ ...plainWord(w), dynamic: true }];
  if (results.length === 1 && results[0]!.text === w.text) return [plainWord(w)];
  return results.map((r, idx) => {
    let glob = false;
    for (let k = 0; k < r.text.length; k++) if (r.active[k] === '1' && '*?['.includes(r.text[k]!)) glob = true;
    // Substitutions belong to the word once; repeating them would classify them once per alternative.
    return { text: r.text, raw: w.raw, dynamic: w.dynamic, quoted: w.quoted, glob, subs: idx === 0 ? w.subs : [], procSub: false };
  });
}

interface Masked {
  text: string;
  active: string;
}

function expandText(m: Masked, depth: number): Masked[] | null {
  if (depth > 32) return null;
  const group = findBraceGroup(m);
  if (group === null) return [m];
  const { open, close, alternatives } = group;
  const pre: Masked = { text: m.text.slice(0, open), active: m.active.slice(0, open) };
  const post: Masked = { text: m.text.slice(close + 1), active: m.active.slice(close + 1) };
  const out: Masked[] = [];
  for (const alt of alternatives) {
    // The rest of the word may hold further groups (`{a,b}{c,d}`); expand the whole result again.
    const expanded = expandText({ text: pre.text + alt.text + post.text, active: pre.active + alt.active + post.active }, depth + 1);
    if (expanded === null) return null;
    out.push(...expanded);
    if (out.length > MAX_BRACE_RESULTS) return null;
  }
  return out;
}

/** The first `{` that opens a valid comma list or sequence, with its alternatives. */
function findBraceGroup(m: Masked): { open: number; close: number; alternatives: Masked[] } | null {
  const { text, active } = m;
  for (let open = 0; open < text.length; open++) {
    if (text[open] !== '{' || active[open] !== '1') continue;
    let depth = 0;
    const commas: number[] = [];
    let close = -1;
    for (let k = open; k < text.length; k++) {
      if (active[k] !== '1') continue;
      const ch = text[k];
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          close = k;
          break;
        }
      } else if (ch === ',' && depth === 1) commas.push(k);
    }
    if (close < 0) continue;
    if (commas.length > 0) {
      const alternatives: Masked[] = [];
      let from = open + 1;
      for (const c of [...commas, close]) {
        alternatives.push({ text: text.slice(from, c), active: active.slice(from, c) });
        from = c + 1;
      }
      return { open, close, alternatives };
    }
    const inner = text.slice(open + 1, close);
    const seq = active.slice(open + 1, close).includes('0') ? null : sequence(inner);
    if (seq !== null) return { open, close, alternatives: seq.map((t) => ({ text: t, active: '0'.repeat(t.length) })) };
  }
  return null;
}

/** `1..5`, `05..10`, `10..1..3`, `a..e`; null when the text is not a sequence bash would expand. */
function sequence(inner: string): string[] | null {
  const num = /^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (num) {
    const a = Number(num[1]);
    const b = Number(num[2]);
    const step = Math.abs(Number(num[3] ?? 1)) || 1;
    const count = Math.floor(Math.abs(b - a) / step) + 1;
    if (count > MAX_BRACE_RESULTS) return Array.from({ length: MAX_BRACE_RESULTS + 1 }, () => '');
    const width = /^-?0\d/.test(num[1]!) || /^-?0\d/.test(num[2]!) ? Math.max(num[1]!.length, num[2]!.length) : 0;
    const out: string[] = [];
    for (let k = 0, v = a; k < count; k++, v += a <= b ? step : -step) {
      const digits = String(Math.abs(v)).padStart(width - (v < 0 ? 1 : 0), '0');
      out.push(v < 0 ? `-${digits}` : digits);
    }
    return out;
  }
  const chr = /^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/.exec(inner);
  if (chr) {
    const a = chr[1]!.charCodeAt(0);
    const b = chr[2]!.charCodeAt(0);
    const step = Math.abs(Number(chr[3] ?? 1)) || 1;
    const out: string[] = [];
    for (let v = a; a <= b ? v <= b : v >= b; v += a <= b ? step : -step) out.push(String.fromCharCode(v));
    return out;
  }
  return null;
}
