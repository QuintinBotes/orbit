import { describe, expect, it } from 'vitest';
import picomatch from 'picomatch';
import {
  containedInAny,
  globContains,
  globsMayOverlap,
  intersectWithScope,
  isAnalysableGlob,
  literalGlob,
  normalizeGlob,
} from '../../../src/contract/globs.ts';

describe('globContains', () => {
  it.each([
    ['src/**', 'src/**'],
    ['src/**', 'src/a/b.ts'],
    ['src/**', 'src/**/*.ts'],
    ['src/**', 'src/*'],
    ['src/**', 'src/a/**/test/*.ts'],
    ['src/**/*.ts', 'src/a.ts'],
    ['src/**/*.ts', 'src/x/y.ts'],
    ['src/**/*.ts', 'src/**/*.ts'],
    ['src/**/a.ts', 'src/a.ts'],
    ['**', 'src/a.ts'],
    ['**/*', 'src/a.ts'],
    ['src/*', 'src/a*'],
    ['src/*a*', 'src/a*'],
    ['src/*.ts', 'src/?.ts'],
    ['src/*', 'src/?'],
    ['src*/**', 'srcfoo/a'],
    ['.github/**', '.github/workflows/ci.yml'],
    ['src/.*', 'src/.env'],
    ['src/**', 'src/*.{ts,tsx}'],
    ['src/**', './src/a.ts'],
    ['src/{a,b}/**', 'src/a/x.ts'],
    ['src/**/**', 'src/a/b'],
    ['*/**', '*/**'],
    ['a/*/**', 'a/*/**'],
    ['*/**', 'a*/**'],
  ])('%s contains %s', (outer, inner) => {
    expect(globContains(outer, inner)).toBe(true);
  });

  it.each([
    ['src/*', 'src/a/b.ts', 'a single star stays in one segment'],
    ['src/*', 'src/**', 'globstar crosses segments'],
    ['src/**/*.ts', 'src/**/*.tsx', 'different extension'],
    ['src/**/*.ts', 'src/**', 'inner is broader'],
    ['src/?.ts', 'src/*.ts', 'question mark is one character'],
    ['src/**', 'srcfoo/a', 'segment prefix is not a directory'],
    ['src/**', 'SRC/a.ts', 'matching is case-sensitive'],
    ['**', '.github/workflows/ci.yml', 'globstar does not cover dot directories for dot:false matchers'],
    ['src/**', 'src/.env', 'globstar does not cover dotfiles for dot:false matchers'],
    ['src/*', 'src/.env', 'star does not cover dotfiles for dot:false matchers'],
    ['src/*.env', 'src/.env', 'leading star never matches a leading dot'],
    ['src/**', 'src/**/.cache/x', 'dot segment under a globstar'],
    ['src/**/*', 'src/**', 'globstar may match zero segments, conservatively not contained'],
    ['src/**', '{src,lib}/**', 'one brace alternative escapes'],
    ['src/**/test/**', 'src/**', 'outer is narrower'],
    ['src/a.ts', 'src/a.tsx', 'literal mismatch'],
    ['a/*/**', 'a/a?', 'a trailing globstar after a star segment needs a segment of its own'],
    ['*/**', '*?/**', 'the inner trailing globstar may match nothing, the outer one may not'],
    ['s*/**', 'src/**', 'inner matches src itself, outer does not'],
  ])('%s does not contain %s (%s)', (outer, inner) => {
    expect(globContains(outer, inner)).toBe(false);
  });

  it.each([
    'src/[ab].ts',
    '!src/**',
    'src/@(a|b).ts',
    'src/+(a).ts',
    'src/\\*.ts',
    '/abs/**',
    '../x/**',
    'src/../x',
    'src/./x',
    'src//x',
    'src/',
    'src/{a,{b,c}}',
    'src/{1..3}.ts',
    'src/{a}.ts',
    'src/}.ts',
    'src/a**b',
    ' src/**',
    '',
    'src/x|lib/**',
    'src/"a*"',
    'src/a"',
  ])('treats unsupported %j as unsure: never contained, contains nothing', (g) => {
    expect(isAnalysableGlob(g)).toBe(false);
    expect(globContains('**', g)).toBe(false);
    expect(globContains(g, 'src/a.ts')).toBe(false);
    expect(normalizeGlob(g)).toBeNull();
  });

  // picomatch compiles braces to a regex alternation, not text substitution,
  // so these differ from their textual expansions. Treating them as
  // expansions credited `{.,apps}/**` with every path in the repository.
  it.each([
    ['{.,apps}/**', 'secrets/**', 'an alternative of "." is a literal ./ segment, not a stripped prefix'],
    ['{**,x}/y', 'y', '** inside braces is not a globstar'],
    ['a/{**,b}/c', 'a/c', '** inside braces never matches zero segments'],
    ['{a,b/**}', 'b', 'a trailing /** inside braces needs a segment'],
    ['{a,*}', 'a', 'a wildcard alternative ignores the dotfile rule'],
    ['{,a}b', 'b', 'an empty alternative'],
  ])('treats brace glob %s as unanalysable, so it is not credited with %s (%s)', (outer, inner) => {
    expect(isAnalysableGlob(outer)).toBe(false);
    expect(globContains(outer, inner)).toBe(false);
    expect(containedInAny(inner, ['docs/**', outer])).toBe(false);
  });

  it('does not credit a glob whose | picomatch reads as alternation over the whole glob', () => {
    const smuggled = 'apps/x|secrets/**';
    expect(picomatch(smuggled, { dot: true })('secrets/key.pem')).toBe(true);
    expect(globContains('apps/**', smuggled)).toBe(false);
    expect(containedInAny(smuggled, ['apps/**', 'tests/**'])).toBe(false);
    expect(intersectWithScope(smuggled, ['apps/**'])).toEqual([]);
  });

  it('counts characters the way picomatch does: ? is one UTF-16 code unit', () => {
    const astral = '\u{1F600}';
    expect(picomatch('src/?.ts')(`src/${astral}.ts`)).toBe(false);
    expect(globContains('src/?.ts', `src/${astral}.ts`)).toBe(false);
    expect(globContains('src/a?', `src/a${astral}`)).toBe(false);
    expect(globContains('src/??.ts', `src/${astral}.ts`)).toBe(true);
    expect(globContains('src/*', `src/${astral}`)).toBe(true);
  });

  it('still analyses brace lists of plain literals, including dot names', () => {
    expect(globContains('{src,tests}/**', 'src/a.ts')).toBe(true);
    expect(globContains('src/**/*.{ts,tsx}', 'src/a/b.tsx')).toBe(true);
    expect(globContains('{.github,src}/**', '.github/workflows/ci.yml')).toBe(true);
    expect(normalizeGlob('./{src,tests}/**')).toBe('{src,tests}/**');
  });

  it('credits a brace glob split across several policy globs only per alternative', () => {
    expect(containedInAny('{src,tests}/**', ['src/**', 'tests/**'])).toBe(true);
    expect(containedInAny('{src,lib}/**', ['src/**', 'tests/**'])).toBe(false);
    expect(containedInAny('src/a.ts', [])).toBe(false);
    expect(containedInAny('src/a.ts', ['src/[ab].ts', 'src/**'])).toBe(true);
  });

  it('normalizes a leading ./ and leaves everything else alone', () => {
    expect(normalizeGlob('././src/**')).toBe('src/**');
    expect(normalizeGlob('src/**')).toBe('src/**');
    expect(literalGlob('src/a.ts')).toBe('src/a.ts');
    expect(literalGlob('src/*.ts')).toBeNull();
    expect(literalGlob('src/[a].ts')).toBeNull();
  });
});

describe('globsMayOverlap', () => {
  it.each([
    ['**/*.tsx', 'server/**', true],
    ['src/*.css', 'src/a.css', true],
    ['apps/web/**/*.tsx', 'apps/**', true],
    ['a*', '*b', true],
    ['src/[x].ts', 'lib/**', true],
    ['apps/**', 'src/**', false],
    ['**/*.ts', '**/*.tsx', false],
    ['src/a/*', 'src/b/*', false],
    ['src/*', 'src/a/b', false],
    ['a?c', 'abd', false],
  ])('%s and %s overlap: %s', (a, b, expected) => {
    expect(globsMayOverlap(a, b)).toBe(expected);
    expect(globsMayOverlap(b, a)).toBe(expected);
  });
});

describe('intersectWithScope', () => {
  const scope = ['apps/**', 'tests/**'];
  it('keeps a contained glob, narrows a broader one, drops a disjoint or unsupported one', () => {
    expect(intersectWithScope('apps/web/**', scope)).toEqual(['apps/web/**']);
    expect(intersectWithScope('./apps/web/**', scope)).toEqual(['apps/web/**']);
    expect(intersectWithScope('**', scope)).toEqual(['apps/**', 'tests/**']);
    expect(intersectWithScope('lib/**', scope)).toEqual([]);
    expect(intersectWithScope('apps/[a].ts', scope)).toEqual([]);
    // Partial overlap that cannot be expressed exactly is dropped, never widened.
    expect(intersectWithScope('*/web/**', scope)).toEqual([]);
  });
});

// Soundness against a real matcher: whenever containment is claimed, every
// sample path the inner glob matches must also match the outer glob, under
// both dotfile settings.
describe('containment soundness against picomatch', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const rand = rng(20261003);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const segPieces = ['a', 'b', 'ab', 'ba', '.a', 'x.ts', 'a.ts', '.env', 'src', 'a.b', 'ts', 'xa', 'ax', '\u{1F600}', 'a\u{1F600}'];
  const globSegs = [
    'a', 'b', '*', '?', 'a*', '*a', '*.ts', '.*', '**', '**', 'src', '.a', '?b', 'a?', '*?', '?*', '*b*', '{a,b}', '{a,.a}', '*.{ts,b}',
    // Brace forms whose picomatch meaning differs from their expansion; they
    // must come out unanalysable rather than unsound.
    '{.,a}', '{**,a}', '{a,b/**}', '{a,*}', '{,a}', '{a,b}*', 'x{a,b}', '*{a,b}', '{.a,src}',
    // Astral characters are two UTF-16 units to picomatch.
    '\u{1F600}', 'a\u{1F600}', '??',
    // Characters picomatch gives a meaning; they must come out unanalysable.
    'a|b', '?|a', 'a"', '"a*"',
  ];
  const paths: string[] = [];
  for (let i = 0; i < 400; i++) {
    const n = 1 + Math.floor(rand() * 4);
    paths.push(Array.from({ length: n }, () => pick(segPieces)).join('/'));
  }
  const globs: string[] = [];
  for (let i = 0; i < 160; i++) {
    const n = 1 + Math.floor(rand() * 3);
    globs.push(Array.from({ length: n }, () => pick(globSegs)).join('/'));
  }

  it('never claims containment that a sample path refutes', () => {
    let claims = 0;
    for (const outer of globs) {
      for (const inner of globs) {
        if (!globContains(outer, inner)) continue;
        claims++;
        for (const dot of [false, true]) {
          const mi = picomatch(inner, { dot });
          const mo = picomatch(outer, { dot });
          for (const p of paths) {
            if (mi(p) && !mo(p)) throw new Error(`unsound: ${outer} claimed to contain ${inner}, but ${p} (dot=${dot}) refutes it`);
          }
        }
      }
    }
    expect(claims).toBeGreaterThan(160);
  });

  it('never calls two globs disjoint when a sample path matches both', () => {
    for (const a of globs) {
      for (const b of globs) {
        if (globsMayOverlap(a, b)) continue;
        for (const dot of [false, true]) {
          const ma = picomatch(a, { dot });
          const mb = picomatch(b, { dot });
          for (const p of paths) {
            if (ma(p) && mb(p)) throw new Error(`unsound: ${a} and ${b} called disjoint, but ${p} (dot=${dot}) matches both`);
          }
        }
      }
    }
  });
});

// Literal characters picomatch might give a meaning to (it does for `|` and
// `"`). Any glob the module accepts must agree with picomatch on every
// normalized repository path (no `.` or `..` segments, which git never
// produces and the policy layer rejects).
describe('soundness with punctuation and non-ASCII literals', () => {
  let seed = 4242;
  const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const chars = ['a', 'b', '.', '^', '$', '+', '@', '|', '#', '%', '=', '&', ';', '~', "'", '"', ' ', '-', '_', ',', '}', '`', '<', '>', ':', 'é', '́', ' '];
  const lit = () => Array.from({ length: 1 + Math.floor(rand() * 3) }, () => pick(chars)).join('');
  const seg = () => {
    const r = rand();
    if (r < 0.15) return '*';
    if (r < 0.25) return '**';
    if (r < 0.35) return `?${lit()}`;
    if (r < 0.45) return `${lit()}*`;
    if (r < 0.5) return `{${lit()},${lit()}}`;
    return lit();
  };
  const globs = Array.from({ length: 160 }, () => Array.from({ length: 1 + Math.floor(rand() * 3) }, seg).join('/'));
  const paths = Array.from({ length: 1200 }, () => Array.from({ length: 1 + Math.floor(rand() * 3) }, lit).join('/')).filter(
    (p) => !p.split('/').some((s) => s === '.' || s === '..'),
  );
  const matcher = (g: string, dot: boolean) => {
    try {
      return picomatch(g, { dot });
    } catch {
      return () => false;
    }
  };

  it('never claims containment or disjointness that picomatch refutes', () => {
    let claims = 0;
    for (const outer of globs) {
      for (const inner of globs) {
        const contained = globContains(outer, inner);
        const disjoint = !globsMayOverlap(outer, inner);
        if (!contained && !disjoint) continue;
        claims++;
        for (const dot of [false, true]) {
          const mi = matcher(inner, dot);
          const mo = matcher(outer, dot);
          for (const p of paths) {
            if (contained && mi(p) && !mo(p)) throw new Error(`unsound: ${JSON.stringify(outer)} claimed to contain ${JSON.stringify(inner)}, refuted by ${JSON.stringify(p)} (dot=${dot})`);
            if (disjoint && mi(p) && mo(p)) throw new Error(`unsound: ${JSON.stringify(outer)} and ${JSON.stringify(inner)} called disjoint, but ${JSON.stringify(p)} matches both (dot=${dot})`);
          }
        }
      }
    }
    expect(claims).toBeGreaterThan(1000);
  });
});
