import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CHECK_SHIM_HASH, CHECK_SHIM_SOURCE, SHIM_FILES, ensureShim, readJsonFile, shimPath } from '../../../src/evidence/check-shim.ts';
import { sha256 } from '../../../src/core/hash.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-shim-cov-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ensureShim', () => {
  it('writes the shim read-only when it is missing and names its hash after the source', () => {
    const path = ensureShim(join(dir, 'run'));
    expect(path).toBe(join(dir, 'run', 'check-shim.mjs'));
    expect(readFileSync(path, 'utf8')).toBe(CHECK_SHIM_SOURCE);
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(CHECK_SHIM_HASH).toBe(sha256(CHECK_SHIM_SOURCE));
  });

  it('leaves an identical shim untouched', () => {
    const path = ensureShim(dir);
    const before = statSync(path).mtimeMs;
    expect(ensureShim(dir)).toBe(path);
    expect(statSync(path).mtimeMs).toBe(before);
  });

  it('replaces a shim that was tampered with, even a read-only one', () => {
    const path = ensureShim(dir);
    chmodSync(path, 0o644);
    writeFileSync(path, '// not the shim\n');
    chmodSync(path, 0o444);
    ensureShim(dir);
    expect(readFileSync(path, 'utf8')).toBe(CHECK_SHIM_SOURCE);
    expect(statSync(path).mode & 0o777).toBe(0o444);
  });
});

describe('readJsonFile', () => {
  it('returns null for a missing file and for a damaged one, the parsed value otherwise', () => {
    expect(readJsonFile(join(dir, 'absent.json'))).toBeNull();
    writeFileSync(join(dir, 'torn.json'), '{"token":');
    expect(readJsonFile(join(dir, 'torn.json'))).toBeNull();
    writeFileSync(join(dir, 'ok.json'), '{"token":"t","pid":4}');
    expect(readJsonFile<{ token: string; pid: number }>(join(dir, 'ok.json'))).toEqual({ token: 't', pid: 4 });
  });

  it('treats a directory where a file should be as absent', () => {
    mkdirSync(join(dir, 'exit.json'));
    expect(readJsonFile(join(dir, 'exit.json'))).toBeNull();
  });
});

describe('shimPath', () => {
  it('maps each shim file key to its name inside the check directory', () => {
    for (const key of Object.keys(SHIM_FILES) as (keyof typeof SHIM_FILES)[]) expect(shimPath('/x', key)).toBe(join('/x', SHIM_FILES[key]));
  });
});
