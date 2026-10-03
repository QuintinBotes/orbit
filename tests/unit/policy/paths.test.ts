import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonicalize, isCaseInsensitiveFs, relativeInside, resolveDetailed, resolveInside } from '../../../src/policy/paths.ts';
import { isOrbitError } from '../../../src/core/errors.ts';

let base: string;
let root: string;
let outside: string;

beforeAll(() => {
  // mkdtemp under os.tmpdir(): on macOS that path itself goes through the /var -> /private/var symlink.
  base = mkdtempSync(join(tmpdir(), 'orbit-paths-'));
  root = join(base, 'Worktree');
  outside = join(base, 'outside');
  mkdirSync(join(root, 'apps', 'web'), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, 'apps', 'web', 'index.ts'), 'x');
  writeFileSync(join(outside, 'secret.txt'), 's');
  symlinkSync(outside, join(root, 'apps', 'escape'));
  symlinkSync('../../outside/secret.txt', join(root, 'apps', 'relative-escape'));
  symlinkSync(join(root, 'apps', 'web'), join(root, 'apps', 'inside-link'));
  symlinkSync(join(outside, 'not-yet-created.txt'), join(root, 'apps', 'dangling'));
  symlinkSync('loop-b', join(root, 'apps', 'loop-a'));
  symlinkSync('loop-a', join(root, 'apps', 'loop-b'));
  // `deep/..` resolves through the link first: deep -> outside/sub, so deep/.. is `outside`, not `apps`.
  mkdirSync(join(outside, 'sub'));
  symlinkSync(join(outside, 'sub'), join(root, 'apps', 'deep'));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function expectEscape(candidate: string): void {
  try {
    resolveInside(root, candidate);
  } catch (err) {
    expect(isOrbitError(err, 'SCOPE_VIOLATION')).toBe(true);
    return;
  }
  throw new Error(`expected ${candidate} to escape`);
}

describe('resolveInside', () => {
  it('returns repo-relative POSIX paths for relative and absolute candidates', () => {
    expect(resolveInside(root, 'apps/web/index.ts')).toBe('apps/web/index.ts');
    expect(resolveInside(root, join(root, 'apps', 'web', 'index.ts'))).toBe('apps/web/index.ts');
    expect(resolveInside(root, './apps/./web/new-file.ts')).toBe('apps/web/new-file.ts');
    expect(resolveInside(root, 'apps/web/../web/index.ts')).toBe('apps/web/index.ts');
    expect(resolveInside(root, '')).toBe('.');
    expect(resolveInside(root, root)).toBe('.');
  });

  it('accepts not-yet-existing nested paths inside the root', () => {
    expect(resolveInside(root, 'apps/new/dir/file.ts')).toBe('apps/new/dir/file.ts');
  });

  it('rejects ../ traversal, including traversal through non-existent directories', () => {
    expectEscape('../outside/secret.txt');
    expectEscape('apps/../../outside');
    expectEscape('apps/missing/../../../outside');
    expectEscape(join(root, '..', 'outside'));
    expectEscape('/etc/passwd');
  });

  it('follows symlinks that leave the root, absolute and relative', () => {
    expectEscape('apps/escape/secret.txt');
    expectEscape('apps/escape');
    expectEscape('apps/relative-escape');
  });

  it('follows a dangling symlink to where a write would land', () => {
    expectEscape('apps/dangling');
  });

  it('applies .. after the symlink it follows, as the kernel does', () => {
    // Lexically apps/deep/../web is apps/web; really it is outside/web.
    expectEscape('apps/deep/../web');
  });

  it('keeps symlinks that stay inside the root and reports the real target', () => {
    expect(resolveInside(root, 'apps/inside-link/index.ts')).toBe('apps/web/index.ts');
  });

  it('rejects NUL bytes and symlink loops as malformed input', () => {
    expect(() => resolveInside(root, 'apps/web\0/x')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
    expect(() => resolveInside(root, 'apps/loop-a/x')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
    expect(() => resolveInside('relative/root', 'x')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
    expect(() => resolveInside(join(base, 'no-such-root'), 'x')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });

  it('reports outside paths without throwing from resolveDetailed', () => {
    const r = resolveDetailed(root, 'apps/escape/secret.txt');
    expect(r.rel).toBeNull();
    expect(r.abs).toBe(realpathSync.native(join(outside, 'secret.txt')));
    expect(r.root).toBe(realpathSync.native(root));
  });
});

describe('case-insensitive filesystems', () => {
  it('detects the filesystem behaviour by inode, and judges containment accordingly', () => {
    const ci = isCaseInsensitiveFs(realpathSync.native(root));
    if (ci) {
      // Default macOS APFS: the differently cased spelling is the same directory.
      expect(resolveInside(root, 'APPS/WEB/index.ts')).toBe('apps/web/index.ts');
      expect(resolveInside(root, `${root.toUpperCase()}/apps/web/index.ts`)).toBe('apps/web/index.ts');
    } else {
      // Case-sensitive: APPS is a different, non-existent directory, but still inside.
      expect(resolveInside(root, 'APPS/WEB/index.ts')).toBe('APPS/WEB/index.ts');
    }
  });

  it('compares segments case-folded only when asked to', () => {
    expect(relativeInside('/Repo/Root', '/repo/root/a/b', true)).toBe('a/b');
    expect(relativeInside('/Repo/Root', '/repo/root/a/b', false)).toBeNull();
    expect(relativeInside('/repo', '/repository/x', true)).toBeNull();
    expect(relativeInside('/repo', '/repo', false)).toBe('.');
  });
});

describe('canonicalize', () => {
  it('resolves the platform temp-dir symlink to its real path', () => {
    expect(canonicalize(join(root, 'apps', 'web'))).toBe(realpathSync.native(join(root, 'apps', 'web')));
  });

  it('requires an absolute path', () => {
    expect(() => canonicalize('apps')).toThrow(expect.objectContaining({ code: 'POLICY_DENIED' }));
  });
});
