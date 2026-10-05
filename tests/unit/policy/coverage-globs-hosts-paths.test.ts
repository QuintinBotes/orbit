import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { compileGlobs, globBases, globProblem, hasGlobChars, shellGlobMatches, stripDotSlash } from '../../../src/policy/globs.ts';
import { hostAllowed, hostEntryCovered, hostEntryProblem, normalizeHost } from '../../../src/policy/hosts.ts';
import { canonicalize, isCaseInsensitiveFs, relativeInside, resolveDetailed, toPosix } from '../../../src/policy/paths.ts';

describe('globs', () => {
  it('globProblem reports a NUL byte and a pattern picomatch cannot compile', () => {
    expect(globProblem('a\0b')).toBe('contains a NUL byte');
    const tooLong = `${'a'.repeat(70_000)}/**`;
    expect(globProblem(tooLong)).toMatch(/^is not a valid glob \(.*\)$/);
    expect(globProblem('apps/**')).toBeNull();
    expect(globProblem('docs/')).toBeNull();
  });

  it('globProblem names each class of mistake', () => {
    const cases: Array<[unknown, RegExp]> = [
      [undefined, /non-empty string/],
      ['', /non-empty string/],
      [3, /non-empty string/],
      ['a\\b', /forward slashes/],
      ['/abs', /relative to the repository root$/],
      ['C:/x', /relative to the repository root$/],
      ['~/x', /not the home directory/],
      ['!x', /negation/],
      ['./x', /must not start with/],
      ['a/../b', /'\.\.'/],
      ['a//b', /empty segments/],
    ];
    for (const [glob, message] of cases) expect(globProblem(glob)).toMatch(message);
  });

  it('shellGlobMatches follows shell semantics for dotfiles and returns false for an unusable pattern', () => {
    expect(shellGlobMatches('.g*', '.git')).toBe(true);
    expect(shellGlobMatches('*', '.git')).toBe(false);
    expect(shellGlobMatches('*.md', 'README.md')).toBe(true);
    expect(shellGlobMatches('a'.repeat(70_000), 'a')).toBe(false);
  });

  it('compileGlobs honours nocase, strips ./ and matches nothing for an empty list', () => {
    expect(compileGlobs([], { nocase: true })('anything')).toBe(false);
    const ci = compileGlobs(['**/.env*'], { nocase: true });
    expect(ci('./apps/.ENV.local')).toBe(true);
    expect(compileGlobs(['Apps/**'], { nocase: false })('apps/x')).toBe(false);
    expect(stripDotSlash('././a/./b')).toBe('a/./b');
  });

  it('globBases returns literal leading directories without duplicates', () => {
    expect(globBases(['.git/**', '.git/hooks/**', '**/x', 'docs/guide.md', '.git/**'])).toEqual(['.git', '.git/hooks', 'docs/guide.md']);
  });

  it('hasGlobChars', () => {
    expect(hasGlobChars('a*b')).toBe(true);
    expect(hasGlobChars('a?')).toBe(true);
    expect(hasGlobChars('[ab]')).toBe(true);
    expect(hasGlobChars('plain.txt')).toBe(false);
  });
});

describe('hosts', () => {
  it('hostEntryProblem rejects every malformed allowlist entry with a specific reason', () => {
    const cases: Array<[unknown, RegExp]> = [
      ['', /non-empty/],
      [5, /non-empty/],
      ['Example.com', /lower case/],
      ['*', /bare/],
      ['https://example.com', /host name only/],
      ['example.com:443', /host name only/],
      ['*.a.*.example.com', /only one leading/],
      ['*.192.0.2.10', /not addresses/],
      ['*.com', /registrable domain/],
      ['*.-bad.example.com', /not a valid host name/],
      ['a*b.example.com', /only allowed as a leading/],
      ['-bad.example.com', /not a valid host name or IPv4/],
      ['300.300.300.300', /not a valid host name or IPv4/],
      ['x'.repeat(254), /not a valid host name or IPv4/],
      [`${'a'.repeat(64)}.example.com`, /not a valid host name or IPv4/],
    ];
    for (const [entry, message] of cases) expect(hostEntryProblem(entry)).toMatch(message);
    for (const ok of ['example.com', '192.0.2.10', '*.example.com', 'localhost']) expect(hostEntryProblem(ok)).toBeNull();
  });

  it('normalizeHost canonicalises or refuses', () => {
    expect(normalizeHost(' Example.COM. ')).toBe('example.com');
    expect(normalizeHost('example.com:8443')).toBe('example.com');
    expect(normalizeHost('[::1]')).toBe('[::1]');
    expect(normalizeHost('[::1]:8080')).toBe('[::1]');
    for (const bad of [undefined, 7, '', '   ', 'a\0b', '[::1', '[::1]x', '[::1]:123456', 'example.com:abc', 'ex ample.com', '999.1.1.1']) {
      expect(normalizeHost(bad as string)).toBeNull();
    }
  });

  it('hostAllowed matches exact hosts and deep subdomains but never the bare parent or an IPv6 literal', () => {
    const allowed = ['example.com', '*.cdn.example.net'];
    expect(hostAllowed('example.com:443', allowed)).toBe(true);
    expect(hostAllowed('a.b.cdn.example.net', allowed)).toBe(true);
    expect(hostAllowed('cdn.example.net', allowed)).toBe(false);
    expect(hostAllowed('evilcdn.example.net', allowed)).toBe(false);
    expect(hostAllowed('[::1]', ['::1', 'example.com'])).toBe(false);
    expect(hostAllowed('not a host', allowed)).toBe(false);
    expect(hostAllowed('example.com', [])).toBe(false);
  });

  it('hostEntryCovered keeps a narrower list inside a broader one', () => {
    expect(hostEntryCovered('example.com', ['example.com'])).toBe(true);
    expect(hostEntryCovered('api.example.com', ['*.example.com'])).toBe(true);
    expect(hostEntryCovered('*.api.example.com', ['*.example.com'])).toBe(true);
    expect(hostEntryCovered('*.example.com', ['*.example.com'])).toBe(true);
    expect(hostEntryCovered('*.example.com', ['*.api.example.com'])).toBe(false);
    expect(hostEntryCovered('*.example.com', ['example.com'])).toBe(false);
    expect(hostEntryCovered('other.test', ['*.example.com'])).toBe(false);
  });
});

describe('paths edge cases', () => {
  let base: string;
  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), 'orbit-paths-cov-'));
  });
  afterAll(() => {
    try {
      chmodSync(join(base, 'locked'), 0o700);
    } catch {
      /* not created */
    }
    rmSync(base, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it('rejects non-string, NUL-containing and oversized inputs with POLICY_DENIED', () => {
    for (const bad of [42, 'a\0b', `/${'a'.repeat(4100)}`]) {
      expect(() => canonicalize(bad as string)).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
    }
    expect(() => resolveDetailed(base, 'x\0y')).toThrow(/NUL byte/);
    expect(() => resolveDetailed(5 as unknown as string, 'x')).toThrow(/root must be a string/);
    expect(() => resolveDetailed(base, 'a'.repeat(5000))).toThrow(/path is too long/);
    expect(() => resolveDetailed('relative/root', 'x')).toThrow(/root must be absolute/);
    expect(() => resolveDetailed(join(base, 'missing-root'), 'x')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED', details: { code: 'ENOENT' } }));
    expect(() => canonicalize('relative')).toThrow(/expected an absolute path/);
  });

  it('relativeInside is null for roots on different volumes and for shorter or different paths', () => {
    expect(relativeInside('rel/root', '/abs/path', false)).toBeNull();
    expect(relativeInside('/a/b', '/a', false)).toBeNull();
    expect(relativeInside('/a/b', '/a/c/d', false)).toBeNull();
    expect(relativeInside('/a/b', '/a/b', false)).toBe('.');
    expect(relativeInside('/a/B', '/a/b/c/d', true)).toBe('c/d');
    expect(relativeInside('/a/B', '/a/b/c', false)).toBeNull();
    expect(relativeInside('/a/\u00e9', '/a/e\u0301/x', true)).toBe('x');
  });

  it('toPosix leaves POSIX paths alone', () => {
    expect(toPosix('a/b')).toBe('a/b');
  });

  it('isCaseInsensitiveFs climbs past components without letters and answers false at the filesystem root', () => {
    expect(isCaseInsensitiveFs('/')).toBe(false);
    mkdirSync(join(base, '123', '456'), { recursive: true });
    const digitsOnly = join(base, '123', '456');
    // 456 and 123 cannot be case swapped, so the probe uses the nearest component with letters (base itself).
    expect(typeof isCaseInsensitiveFs(digitsOnly)).toBe('boolean');
    expect(isCaseInsensitiveFs(digitsOnly)).toBe(isCaseInsensitiveFs(base));
  });

  it('isCaseInsensitiveFs propagates unexpected stat errors instead of guessing', () => {
    if (process.getuid?.() === 0) return;
    const locked = join(base, 'locked');
    mkdirSync(join(locked, 'Inner'), { recursive: true });
    chmodSync(locked, 0o000);
    try {
      expect(() => isCaseInsensitiveFs(join(locked, 'Inner'))).toThrow(expect.objectContaining({ code: 'EACCES' }));
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it('canonicalize keeps the lexical spelling when the existing prefix cannot be resolved', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (orig) => {
      const real = await orig<typeof import('node:fs')>();
      const realpathSync = Object.assign(() => '', { native: () => { throw Object.assign(new Error('boom'), { code: 'EIO' }); } });
      return { ...real, realpathSync };
    });
    const paths = await import('../../../src/policy/paths.ts');
    // Symlinks are still followed lexically (macOS /var -> /private/var); only the on-disk respelling is skipped.
    const real = realpathSync(base);
    expect(paths.canonicalize(join(base, 'does', 'not', 'exist'))).toBe(join(real, 'does', 'not', 'exist'));
    expect(paths.canonicalize(base)).toBe(real);
  });

  it('canonicalize returns the path unchanged when nothing on it exists, not even the root', async () => {
    vi.resetModules();
    vi.doMock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), existsSync: () => false }));
    const paths = await import('../../../src/policy/paths.ts');
    expect(paths.canonicalize('/nowhere/at/all')).toBe('/nowhere/at/all');
  });

  it('resolves symlinks to a canonical on-disk spelling when the target exists', () => {
    mkdirSync(join(base, 'real'), { recursive: true });
    symlinkSync(join(base, 'real'), join(base, 'link'));
    expect(canonicalize(join(base, 'link', 'new.txt'))).toBe(join(realpathSync(base), 'real', 'new.txt'));
  });
});
