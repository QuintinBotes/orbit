import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendJsonl, atomicWrite, atomicWriteJson, ensureDir, readJsonIfExists } from '../../../src/core/fsx.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function runNode(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-fsx-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const tempFiles = (d: string): string[] => readdirSync(d).filter((f) => f.endsWith('.tmp'));

describe('atomicWrite', () => {
  it('creates missing parent directories and writes the exact bytes', () => {
    const path = join(dir, 'a', 'b', 'c.txt');
    atomicWrite(path, 'hello\n');
    expect(readFileSync(path, 'utf8')).toBe('hello\n');
    const bytes = new Uint8Array([0, 1, 2, 255]);
    atomicWrite(path, bytes);
    expect(new Uint8Array(readFileSync(path))).toEqual(bytes);
  });

  it('replaces existing content and leaves no temp files behind', () => {
    const path = join(dir, 'f.json');
    for (let i = 0; i < 20; i++) atomicWrite(path, `v${i}`);
    expect(readFileSync(path, 'utf8')).toBe('v19');
    expect(tempFiles(dir)).toEqual([]);
  });

  it('applies the requested mode even when the file already existed with another', () => {
    const path = join(dir, 'policy.json');
    writeFileSync(path, 'old');
    chmodSync(path, 0o600);
    atomicWrite(path, 'frozen', 0o444);
    expect(statSync(path).mode & 0o777).toBe(0o444);
    expect(readFileSync(path, 'utf8')).toBe('frozen');
  });

  it('can replace a read-only file, because rename does not need write permission on the target', () => {
    const path = join(dir, 'ro.json');
    atomicWrite(path, 'one', 0o444);
    atomicWrite(path, 'two', 0o444);
    expect(readFileSync(path, 'utf8')).toBe('two');
  });

  it('writes empty content', () => {
    const path = join(dir, 'empty');
    atomicWrite(path, '');
    expect(readFileSync(path, 'utf8')).toBe('');
  });

  it.skipIf(process.getuid?.() === 0)('fails without touching the old file when the directory cannot be written (skipped as root, which ignores modes)', () => {
    const sub = ensureDir(join(dir, 'locked'));
    const path = join(sub, 'x.txt');
    atomicWrite(path, 'kept');
    chmodSync(sub, 0o500);
    try {
      expect(() => atomicWrite(path, 'new')).toThrow();
      expect(readFileSync(path, 'utf8')).toBe('kept');
    } finally {
      chmodSync(sub, 0o700);
    }
  });

  it('never lets a concurrent reader in another process see a partial or mixed file', async () => {
    const path = join(dir, 'big.txt');
    const stop = join(dir, 'stop');
    const size = 256 * 1024;
    // The file exists before the reader starts, so a reader that ever finds it
    // missing has seen the replacement happen non-atomically.
    atomicWrite(path, 'C'.repeat(size));
    const reader = runNode([fixture('atomic-reader.ts'), path, stop, String(size)]);
    const writer = await runNode([fixture('atomic-writer.ts'), path, '300', String(size)]);
    writeFileSync(stop, '');
    const result = await reader;
    expect(writer.code, writer.stderr).toBe(0);
    expect(result.code, result.stderr).toBe(0);
    const stats = JSON.parse(result.stdout) as { reads: number; missing: number; torn: number };
    expect(stats.reads).toBeGreaterThan(50);
    expect(stats.torn).toBe(0);
    expect(stats.missing).toBe(0);
    expect(tempFiles(dir)).toEqual([]);
  });
});

describe('atomicWriteJson and readJsonIfExists', () => {
  it('round-trips JSON with a trailing newline', () => {
    const path = join(dir, 'x', 'v.json');
    atomicWriteJson(path, { a: [1, 2], b: 'c' });
    expect(readFileSync(path, 'utf8').endsWith('}\n')).toBe(true);
    expect(readJsonIfExists(path)).toEqual({ a: [1, 2], b: 'c' });
  });

  it('returns null for a missing file and throws for malformed JSON', () => {
    expect(readJsonIfExists(join(dir, 'nope.json'))).toBeNull();
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"a":');
    expect(() => readJsonIfExists(bad)).toThrow(SyntaxError);
  });
});

describe('appendJsonl', () => {
  it('appends one JSON document per line and creates the directory', () => {
    const path = join(dir, 'runs', 'r1', 'decisions.jsonl');
    appendJsonl(path, { n: 1 });
    appendJsonl(path, { n: 2, s: 'line\nbreak' });
    const lines = readFileSync(path, 'utf8').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(lines.slice(0, 2).map((l) => JSON.parse(l))).toEqual([{ n: 1 }, { n: 2, s: 'line\nbreak' }]);
  });
});

describe('ensureDir', () => {
  it('is idempotent and returns the path', () => {
    const p = join(dir, 'x', 'y');
    expect(ensureDir(p)).toBe(p);
    expect(ensureDir(p)).toBe(p);
    expect(statSync(p).isDirectory()).toBe(true);
  });
});
