// removeScratch's reading of the error a recursive remove reports for a tree it cannot empty. Which code that is
// depends on the platform and the Node version (EACCES or EPERM from the unlink; ENOTEMPTY on Node 24 on macOS, where
// the parent's failed rmdir replaces the child's error), so each is forced here, on any host: the first removal leaves
// the read-only tree in place and reports the code, and the second is the real one.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const forced = vi.hoisted(() => ({ code: null as string | null, calls: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    rmSync: (path: import('node:fs').PathLike, options?: import('node:fs').RmOptions) => {
      forced.calls++;
      if (forced.code !== null && forced.calls === 1) {
        const err = Object.assign(new Error(`${forced.code}, forced by the test: ${String(path)}`), { code: forced.code, syscall: 'rm', path: String(path) });
        throw err;
      }
      return real.rmSync(path, options);
    },
  };
});

const { removeScratch } = await import('../../../src/isolation/toolchains.ts');

const roots: string[] = [];
beforeEach(() => {
  forced.code = null;
  forced.calls = 0;
});
afterEach(() => {
  forced.code = null;
  for (const r of roots.splice(0)) {
    unlock(r);
    rmSync(r, { recursive: true, force: true });
  }
});

function unlock(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name));
  } catch {
    /* gone */
  }
}

const modeOf = (p: string) => lstatSync(p).mode & 0o777;

function readOnlyScratch(): { root: string; scratch: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-remove-scratch-')));
  roots.push(root);
  const scratch = join(root, 'scratch');
  mkdirSync(join(scratch, 'ro', 'nested'), { recursive: true });
  writeFileSync(join(scratch, 'ro', 'f'), '1');
  writeFileSync(join(scratch, 'ro', 'nested', 'g'), '2');
  chmodSync(join(scratch, 'ro', 'nested'), 0o555);
  chmodSync(join(scratch, 'ro'), 0o555);
  return { root, scratch };
}

describe('removeScratch and the error a remove reports', () => {
  for (const code of ['EACCES', 'EPERM', 'ENOTEMPTY']) {
    it(`makes the tree writable and removes it again when the first removal reports ${code}`, () => {
      const { scratch } = readOnlyScratch();
      forced.code = code;
      removeScratch(scratch);
      expect(forced.calls).toBe(2);
      expect(existsSync(scratch)).toBe(false);
    });
  }

  it('throws any other error as it came, without touching the tree', () => {
    const { scratch } = readOnlyScratch();
    forced.code = 'EIO';
    expect(() => removeScratch(scratch)).toThrow(/EIO/);
    expect(forced.calls).toBe(1);
    expect(existsSync(scratch)).toBe(true);
    expect(modeOf(join(scratch, 'ro'))).toBe(0o555);
  });

  it('does not chmod what a scratch root that is itself a symbolic link points at', () => {
    const { root } = readOnlyScratch();
    const outside = join(root, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'kept');
    chmodSync(outside, 0o555);
    const link = join(root, 'scratch-link');
    symlinkSync(outside, link);
    forced.code = 'ENOTEMPTY';
    removeScratch(link);
    expect(forced.calls).toBe(2);
    expect(existsSync(link)).toBe(false);
    expect(modeOf(outside)).toBe(0o555);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('kept');
    chmodSync(outside, 0o700);
  });

  it('lets a tree that vanished while the modes were being fixed, or a scratch root that is a file, through to the second removal', () => {
    const { root, scratch } = readOnlyScratch();
    unlock(scratch);
    rmSync(scratch, { recursive: true, force: true });
    forced.code = 'ENOTEMPTY';
    forced.calls = 0;
    removeScratch(scratch);
    expect(forced.calls).toBe(2);
    forced.calls = 0;
    writeFileSync(join(root, 'file'), 'x');
    removeScratch(join(root, 'file'));
    expect(forced.calls).toBe(2);
    expect(existsSync(join(root, 'file'))).toBe(false);
  });
});
