import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isOrbitError } from '../../../src/core/errors.ts';
import {
  assertArgv,
  assertRepresentablePath,
  canonicalPath,
  gitCommonDir,
  isWithin,
  probeFailure,
  readablePathsOf,
  runBounded,
  which,
  withoutNested,
} from '../../../src/isolation/util.ts';
import { tempRoot, writeExecutable } from './fixtures.ts';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
function root(): string {
  const t = tempRoot();
  cleanups.push(t.remove);
  return t.root;
}

describe('isWithin', () => {
  it('matches the path itself and descendants only', () => {
    expect(isWithin('/a/b', '/a/b')).toBe(true);
    expect(isWithin('/a/b/c', '/a/b')).toBe(true);
    expect(isWithin('/a/bc', '/a/b')).toBe(false);
    expect(isWithin('/a', '/a/b')).toBe(false);
    expect(isWithin('/anything', '/')).toBe(true);
  });
});

describe('canonicalPath', () => {
  it('refuses relative paths', () => {
    expect(() => canonicalPath('relative/x')).toThrow(/absolute/);
  });

  it('resolves symlinks, including above a tail that does not exist yet', () => {
    const r = root();
    mkdirSync(join(r, 'real'));
    symlinkSync(join(r, 'real'), join(r, 'link'));
    expect(canonicalPath(join(r, 'link'))).toBe(join(r, 'real'));
    expect(canonicalPath(join(r, 'link', 'not', 'yet'))).toBe(join(r, 'real', 'not', 'yet'));
    expect(canonicalPath(join(r, 'real', '..', 'real', '.', 'x'))).toBe(join(r, 'real', 'x'));
  });

  it.runIf(process.platform === 'darwin')('spells /tmp the way the kernel does on macOS', () => {
    expect(canonicalPath('/tmp/orbit-does-not-exist')).toBe('/private/tmp/orbit-does-not-exist');
  });
});

describe('withoutNested', () => {
  it('keeps only outermost paths', () => {
    expect(withoutNested(['/a/b/c', '/a/b', '/x', '/a/b', '/a/bc'])).toEqual(['/a/b', '/x', '/a/bc']);
  });
});

describe('which', () => {
  it('finds executables on PATH and skips non-executable files', () => {
    const r = root();
    writeFileSync(join(r, 'tool'), 'not executable');
    const bin = join(r, 'bin');
    writeExecutable(join(bin, 'tool'), 'exit 0');
    expect(which('tool', `${r}:${bin}`)).toBe(join(bin, 'tool'));
    expect(which('missing', bin)).toBeNull();
    expect(which('tool', undefined)).toBeNull();
    expect(which(join(bin, 'tool'), '')).toBe(join(bin, 'tool'));
  });
});

describe('which with relative PATH entries', () => {
  it('never resolves against the working directory', () => {
    const r = root();
    writeExecutable(join(r, 'tool'), 'exit 0');
    const cwd = process.cwd();
    process.chdir(r);
    try {
      // "", "." and "sub" all resolve against the current directory, here a stand-in for a repository.
      expect(which('tool', ':.:./:sub')).toBeNull();
      expect(which('./tool', '')).toBeNull();
      expect(which('tool', `.:${r}`)).toBe(join(r, 'tool'));
    } finally {
      process.chdir(cwd);
    }
  });
});

describe('gitCommonDir', () => {
  it('follows a linked worktree to the shared git directory', () => {
    const r = root();
    const common = join(r, 'repo', '.git');
    const gitdir = join(common, 'worktrees', 'w1');
    mkdirSync(gitdir, { recursive: true });
    writeFileSync(join(gitdir, 'commondir'), '../..\n');
    const wt = join(r, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), `gitdir: ${gitdir}\n`);
    expect(gitCommonDir(wt)).toBe(common);
  });

  it('uses the gitdir itself when there is no commondir file', () => {
    const r = root();
    const gitdir = join(r, 'elsewhere.git');
    mkdirSync(gitdir);
    const wt = join(r, 'wt');
    mkdirSync(wt);
    writeFileSync(join(wt, '.git'), 'gitdir: ../elsewhere.git\n');
    expect(gitCommonDir(wt)).toBe(gitdir);
  });

  it('returns null for an ordinary checkout, a missing .git and garbage', () => {
    const r = root();
    mkdirSync(join(r, 'plain', '.git'), { recursive: true });
    expect(gitCommonDir(join(r, 'plain'))).toBeNull();
    expect(gitCommonDir(join(r, 'nothing'))).toBeNull();
    mkdirSync(join(r, 'bad'));
    writeFileSync(join(r, 'bad', '.git'), 'not a gitdir line');
    expect(gitCommonDir(join(r, 'bad'))).toBeNull();
  });
});

describe('guards', () => {
  it('refuses paths a sandbox would read as a pattern', () => {
    for (const p of ['/a/*', '/a/b?', '/a/[x]', '/a/{b}', '/a/b\nc']) {
      let caught: unknown;
      try {
        assertRepresentablePath(p, 'test path');
      } catch (err) {
        caught = err;
      }
      expect(isOrbitError(caught, 'ISOLATION_UNAVAILABLE'), p).toBe(true);
    }
    expect(() => assertRepresentablePath('/a/b c/d-e_f.g', 'test path')).not.toThrow();
  });

  it('refuses empty or non-string argv', () => {
    expect(() => assertArgv([])).toThrow(/non-empty/);
    expect(() => assertArgv([''])).toThrow(/non-empty/);
    expect(() => assertArgv(['ok', 3 as unknown as string])).toThrow(/non-empty/);
    expect(() => assertArgv(['ok'])).not.toThrow();
  });

  it('reads the optional readable paths without trusting their shape', () => {
    const base = { writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 1, memoryMb: null, cpus: null, pids: null } };
    expect(readablePathsOf(base)).toEqual([]);
    expect(readablePathsOf({ ...base, readablePaths: ['/x'] } as typeof base)).toEqual(['/x']);
    expect(readablePathsOf({ ...base, readablePaths: '/x' } as unknown as typeof base)).toEqual([]);
  });
});

describe('runBounded', () => {
  it('reports exit status and output', async () => {
    const r = await runBounded('/bin/sh', ['-c', 'echo out; echo err >&2; exit 4'], { timeoutMs: 5_000 });
    expect(r).toMatchObject({ code: 4, stdout: 'out\n', stderr: 'err\n', timedOut: false, spawnError: null });
    expect(probeFailure(r)).toBe('exit 4: err');
  });

  it('kills the whole process group at the deadline', async () => {
    const started = Date.now();
    const r = await runBounded('/bin/sh', ['-c', 'sleep 30 & sleep 30'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(probeFailure(r)).toBe('timed out');
  });

  it('reports a binary that cannot start', async () => {
    const r = await runBounded('/nonexistent/orbit-tool', [], { timeoutMs: 1_000 });
    expect(r.spawnError).toMatch(/ENOENT/);
    expect(probeFailure(r)).toMatch(/ENOENT/);
  });
});
