/**
 * Static analysis of path globs, used to decide whether a contract's
 * allowed_paths stay inside the policy scope without enumerating files.
 *
 * Containment must be sound: `globContains(outer, inner)` returns true only
 * when every path `inner` can match is also matched by `outer`, under either
 * dotfile setting a matcher might use. Anything this module cannot analyse
 * (character classes, extglobs, escapes, negation, ranges, `|`, quotes) is
 * "unsure", and unsure means not contained. Overlap is the opposite: it
 * answers true unless the two globs provably share no path.
 *
 * Supported syntax: path segments of literal characters, `*` and `?`; a
 * whole-segment `**`; simple comma brace lists of plain literals such as
 * `{ts,tsx}`; a leading `./`. Matching is case-sensitive, which is the
 * conservative direction for containment on case-insensitive filesystems too.
 *
 * Brace alternatives are restricted to plain literal text because picomatch
 * does not treat a brace as text substitution: inside braces `**` is not a
 * globstar, `/**` never matches zero segments, and an alternative of `.`
 * stays a literal `./` instead of a prefix to strip. Expanding such braces
 * textually would credit `{.,apps}/**` with containing every path.
 */

type Sym = { k: 'lit'; c: string } | { k: 'any' } | { k: 'star' };
type Segment = { kind: 'globstar' } | { kind: 'pattern'; syms: Sym[] };
type Parsed = Segment[];

const MAX_EXPANSIONS = 64;
// Besides classes, extglobs, negation and escapes: picomatch reads `|` as a
// regex alternation over the whole glob (`apps/x|secrets/**` matches
// `secrets/key.pem`) and `"` as quoting, so neither is a literal character.
const UNSUPPORTED_CHARS = /[[\]()!\\|"]/;
// A brace alternative must be non-empty literal text within one segment.
const LITERAL_ALTERNATIVE = /^[^/*?{},]+$/;

/** Expand simple, non-nested `{a,b}` lists of literals. null when the braces are anything else. */
function expandBraces(glob: string): string[] | null {
  const open = glob.indexOf('{');
  if (open === -1) return glob.includes('}') ? null : [glob];
  const close = glob.indexOf('}', open);
  if (close === -1) return null;
  const body = glob.slice(open + 1, close);
  if (body.includes('{') || !body.includes(',') || body.includes('..')) return null;
  const alternatives = body.split(',');
  if (!alternatives.every((alt) => LITERAL_ALTERNATIVE.test(alt))) return null;
  const head = glob.slice(0, open);
  const tails = expandBraces(glob.slice(close + 1));
  if (!tails) return null;
  const out: string[] = [];
  for (const alt of alternatives) {
    for (const tail of tails) {
      out.push(head + alt + tail);
      if (out.length > MAX_EXPANSIONS) return null;
    }
  }
  return out;
}

function parseSingle(g: string): Parsed | null {
  if (g === '' || g.startsWith('/') || g.endsWith('/') || UNSUPPORTED_CHARS.test(g)) return null;
  const segments: Segment[] = [];
  for (const raw of g.split('/')) {
    if (raw === '' || raw === '.' || raw === '..') return null;
    if (raw === '**') {
      // Consecutive globstars mean the same as one.
      if (segments.at(-1)?.kind !== 'globstar') segments.push({ kind: 'globstar' });
      continue;
    }
    if (raw.includes('**')) return null;
    const syms: Sym[] = [];
    // UTF-16 code units, not code points: picomatch compiles to a regex
    // without the u flag, where `?` matches half of an astral character.
    for (let k = 0; k < raw.length; k++) {
      const c = raw[k]!;
      if (c === '*') syms.push({ k: 'star' });
      else if (c === '?') syms.push({ k: 'any' });
      else syms.push({ k: 'lit', c });
    }
    segments.push({ kind: 'pattern', syms });
  }
  return segments;
}

/** All brace expansions of a glob, parsed; null when any part is unsupported. */
export function parseGlob(glob: string): Parsed[] | null {
  if (typeof glob !== 'string' || glob.trim() !== glob) return null;
  // Only the glob's own leading `./` is a prefix (picomatch strips it the
  // same way); a `./` produced by a brace alternative is a literal `.`
  // segment, which parseSingle rejects.
  let g = glob;
  while (g.startsWith('./')) g = g.slice(2);
  const expansions = expandBraces(g);
  if (!expansions) return null;
  const out: Parsed[] = [];
  for (const e of expansions) {
    const p = parseSingle(e);
    if (!p) return null;
    out.push(p);
  }
  return out;
}

/** True when the glob uses only syntax this module can reason about. */
export function isAnalysableGlob(glob: string): boolean {
  return parseGlob(glob) !== null;
}

/** Normalized spelling: leading `./` removed. null for unsupported globs. */
export function normalizeGlob(glob: string): string | null {
  if (!isAnalysableGlob(glob)) return null;
  let g = glob;
  while (g.startsWith('./')) g = g.slice(2);
  return g;
}

function startsWithLiteralDot(seg: Segment): boolean {
  if (seg.kind !== 'pattern') return false;
  const first = seg.syms[0];
  return first !== undefined && first.k === 'lit' && first.c === '.';
}

function startsWithWildcard(seg: Segment & { kind: 'pattern' }): boolean {
  const first = seg.syms[0];
  return first !== undefined && first.k !== 'lit';
}

/**
 * Segment containment over `*`/`?`/literal symbols. An outer star may absorb
 * any run of inner symbols; an outer `?` absorbs exactly one inner literal or
 * `?`; literals must agree. This alignment is sound, though it misses a few
 * exotic equivalences, which only ever makes the answer "not contained".
 */
function segmentContains(outer: Sym[], inner: Sym[]): boolean {
  const memo = new Map<number, boolean>();
  const width = inner.length + 1;
  const go = (a: number, b: number): boolean => {
    const key = a * width + b;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result: boolean;
    const o = outer[a];
    if (o === undefined) result = b === inner.length;
    else if (o.k === 'star') result = go(a + 1, b) || (b < inner.length && go(a, b + 1));
    else {
      const i = inner[b];
      if (i === undefined) result = false;
      else if (o.k === 'any') result = i.k !== 'star' && go(a + 1, b + 1);
      else result = i.k === 'lit' && i.c === o.c && go(a + 1, b + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function patternSegmentContains(outer: Segment & { kind: 'pattern' }, inner: Segment & { kind: 'pattern' }): boolean {
  // With dot:false a leading wildcard never matches a leading dot. The inner
  // glob may name a dotfile literally, so the outer must name the dot too.
  if (startsWithWildcard(outer) && startsWithLiteralDot(inner)) return false;
  return segmentContains(outer.syms, inner.syms);
}

// Whether the globstar at `index` can match zero segments. A leading or
// inner `**` can ("a/**/b" matches "a/b"). A trailing one can only after a
// segment that does not end in `*`: picomatch matches "a/b/**" and
// "a/*b/**" against "a/b", but not "a/b*/**" against "a/b". Modelling that
// quirk on both sides keeps containment sound and still lets a glob contain
// itself.
function globstarMayBeEmpty(p: Parsed, index: number): boolean {
  if (index < p.length - 1) return true;
  const prev = p[index - 1];
  return prev !== undefined && prev.kind === 'pattern' && prev.syms.at(-1)?.k !== 'star';
}

function parsedContains(outer: Parsed, inner: Parsed): boolean {
  const memo = new Map<number, boolean>();
  const width = inner.length + 1;
  const go = (j: number, i: number): boolean => {
    const key = j * width + i;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let result = false;
    const o = outer[j];
    if (o === undefined) result = i === inner.length;
    else if (o.kind === 'globstar') {
      // The globstar absorbs a run of whole inner segments, never a
      // dot-named one (dot:false matchers skip those). The run must produce
      // at least one segment unless this globstar may match none.
      const mayBeEmpty = globstarMayBeEmpty(outer, j);
      if (mayBeEmpty && go(j + 1, i)) result = true;
      let minSegments = 0;
      for (let k = i; !result && k < inner.length; k++) {
        const seg = inner[k]!;
        if (startsWithLiteralDot(seg)) break;
        minSegments += seg.kind === 'globstar' && globstarMayBeEmpty(inner, k) ? 0 : 1;
        if ((minSegments > 0 || mayBeEmpty) && go(j + 1, k + 1)) result = true;
      }
    } else {
      const next = inner[i];
      result = next !== undefined && next.kind === 'pattern' && patternSegmentContains(o, next) && go(j + 1, i + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** Every path `inner` can match is matched by `outer`. False when unsure. */
export function globContains(outer: string, inner: string): boolean {
  return containedInAny(inner, [outer]);
}

/**
 * Every path `inner` can match is matched by at least one glob in `outers`.
 * Each brace expansion of `inner` must fit inside a single expansion of some
 * outer glob; a path covered only by the union of two outers is not credited.
 */
export function containedInAny(inner: string, outers: readonly string[]): boolean {
  const innerParsed = parseGlob(inner);
  if (!innerParsed) return false;
  const outerParsed: Parsed[] = [];
  for (const o of outers) {
    const p = parseGlob(o);
    if (p) outerParsed.push(...p);
  }
  return innerParsed.every((ip) => outerParsed.some((op) => parsedContains(op, ip)));
}

function segmentsOverlap(a: Sym[], b: Sym[]): boolean {
  const memo = new Map<number, boolean>();
  const width = b.length + 1;
  const go = (x: number, y: number): boolean => {
    const key = x * width + y;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const p = a[x];
    const q = b[y];
    let result = false;
    if (p === undefined && q === undefined) result = true;
    else if (p?.k === 'star' && (go(x + 1, y) || (q !== undefined && go(x, y + 1)))) result = true;
    else if (q?.k === 'star' && (go(x, y + 1) || (p !== undefined && go(x + 1, y)))) result = true;
    else if (p !== undefined && q !== undefined && p.k !== 'star' && q.k !== 'star') {
      const compatible = p.k === 'any' || q.k === 'any' || (p.k === 'lit' && q.k === 'lit' && p.c === q.c);
      result = compatible && go(x + 1, y + 1);
    }
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

function parsedOverlap(a: Parsed, b: Parsed): boolean {
  const memo = new Map<number, boolean>();
  const width = b.length + 1;
  const go = (x: number, y: number): boolean => {
    const key = x * width + y;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const p = a[x];
    const q = b[y];
    let result = false;
    if (p === undefined && q === undefined) result = true;
    else if (p?.kind === 'globstar' && (go(x + 1, y) || (q !== undefined && go(x, y + 1)))) result = true;
    else if (q?.kind === 'globstar' && (go(x, y + 1) || (p !== undefined && go(x + 1, y)))) result = true;
    else if (p?.kind === 'pattern' && q?.kind === 'pattern') result = segmentsOverlap(p.syms, q.syms) && go(x + 1, y + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** Some path could match both globs. True when unsure. */
export function globsMayOverlap(a: string, b: string): boolean {
  const pa = parseGlob(a);
  const pb = parseGlob(b);
  if (!pa || !pb) return true;
  return pa.some((x) => pb.some((y) => parsedOverlap(x, y)));
}

/**
 * The part of `glob` that lies inside `scope`, as globs: the glob itself when
 * it is contained, otherwise the scope globs it contains. Partial overlaps
 * that cannot be expressed exactly are dropped, which narrows, never widens.
 */
export function intersectWithScope(glob: string, scope: readonly string[]): string[] {
  const g = normalizeGlob(glob);
  if (g === null) return [];
  if (containedInAny(g, scope)) return [g];
  const inside: string[] = [];
  for (const s of scope) {
    const n = normalizeGlob(s);
    if (n !== null && globContains(g, n) && !inside.includes(n)) inside.push(n);
  }
  return inside;
}

/** Escape a concrete repository path so it can be used as a glob that matches only itself. */
export function literalGlob(path: string): string | null {
  if (/[*?{}]/.test(path)) return null;
  const n = normalizeGlob(path);
  return n;
}
