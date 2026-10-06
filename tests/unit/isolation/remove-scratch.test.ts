// removeScratch on the trees a toolchain leaves behind: Go's module cache is read-only all the way down, and removing
// it must not depend on which error the platform's recursive remove reports for it (EACCES on Node 22, ENOTEMPTY on
// Node 24 on macOS). These trees are real; remove-scratch-errors.test.ts forces each error code on any host.
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { removeScratch } from '../../../src/isolation/toolchains.ts';

const roots: string[] = [];
afterEach(() => {
  // Undo what the tests locked, so the temp directories can go even when an assertion failed.
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

function temp(): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-remove-scratch-')));
  roots.push(d);
  return d;
}

/** A tree shaped like Go's module cache: directories and files read-only, nested, each made read-only after its children. */
function goLikeCache(root: string, beforeLock: (mod: string) => void = () => {}): string {
  const mod = join(root, 'toolchains', 'cache', 'gomod');
  const versions = [join(mod, 'cache', 'download', 'acme', '@v'), join(mod, 'acme@v1.0.0', 'internal', 'deep'), join(mod, 'other@v2.0.0')];
  for (const d of versions) mkdirSync(d, { recursive: true });
  for (const d of versions) writeFileSync(join(d, 'x.go'), 'package x\n');
  writeFileSync(join(mod, 'acme@v1.0.0', 'go.mod'), 'module acme\n');
  beforeLock(mod);
  // Files read-only, then every directory under the cache root, deepest first, then the root: a directory is locked after its entries.
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) chmodSync(join(d, e.name), 0o444);
    }
    chmodSync(d, 0o555);
  };
  walk(mod);
  return join(root, 'toolchains');
}

describe('removeScratch', () => {
  it('removes a tree a tool made read-only all the way down, as Go does its module cache', () => {
    const root = temp();
    const scratch = goLikeCache(root);
    expect(modeOf(join(scratch, 'cache', 'gomod'))).toBe(0o555);
    removeScratch(scratch);
    expect(existsSync(scratch)).toBe(false);
    expect(existsSync(root)).toBe(true);
  });

  it('removes a tree whose directory lost its write bit before its children were looked at, and one with no permissions at all', () => {
    const root = temp();
    const scratch = join(root, 'scratch');
    mkdirSync(join(scratch, 'a', 'b', 'c'), { recursive: true });
    writeFileSync(join(scratch, 'a', 'f'), '1');
    writeFileSync(join(scratch, 'a', 'b', 'g'), '2');
    writeFileSync(join(scratch, 'a', 'b', 'c', 'h'), '3');
    // Top down: each directory is locked before its children are touched. `b` cannot even be listed.
    chmodSync(scratch, 0o555);
    chmodSync(join(scratch, 'a'), 0o555);
    chmodSync(join(scratch, 'a', 'b', 'c'), 0o555);
    chmodSync(join(scratch, 'a', 'b'), 0o000);
    removeScratch(scratch);
    expect(existsSync(scratch)).toBe(false);
  });

  it('never follows a symbolic link out of the tree: the target keeps its mode and its files', () => {
    const root = temp();
    const outside = join(root, 'outside');
    mkdirSync(join(outside, 'inner'), { recursive: true });
    writeFileSync(join(outside, 'keep.txt'), 'kept');
    writeFileSync(join(outside, 'inner', 'keep.txt'), 'kept too');
    chmodSync(join(outside, 'inner'), 0o555);
    chmodSync(outside, 0o555);
    // A link to a directory, one to a file, and a dangling one, among the read-only directories.
    const scratch = goLikeCache(root, (mod) => {
      symlinkSync(outside, join(mod, 'acme@v1.0.0', 'link'));
      symlinkSync(join(outside, 'keep.txt'), join(mod, 'other@v2.0.0', 'file-link'));
      symlinkSync(join(root, 'missing'), join(mod, 'dangling'));
    });
    removeScratch(scratch);
    expect(existsSync(scratch)).toBe(false);
    expect(modeOf(outside)).toBe(0o555);
    expect(modeOf(join(outside, 'inner'))).toBe(0o555);
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('kept');
    expect(readFileSync(join(outside, 'inner', 'keep.txt'), 'utf8')).toBe('kept too');
  });

  it('removes an ordinary tree, a missing directory and a plain file without complaint', () => {
    const root = temp();
    mkdirSync(join(root, 'plain', 'sub'), { recursive: true });
    writeFileSync(join(root, 'plain', 'sub', 'f'), 'x');
    removeScratch(join(root, 'plain'));
    expect(existsSync(join(root, 'plain'))).toBe(false);
    removeScratch(join(root, 'never-existed'));
    writeFileSync(join(root, 'file'), 'x');
    removeScratch(join(root, 'file'));
    expect(existsSync(join(root, 'file'))).toBe(false);
  });
});
