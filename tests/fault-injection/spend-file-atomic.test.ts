/** Issue #254: the spend file appears whole or not at all, readable by its owner only. */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const WRITER = fileURLToPath(new URL('./fixtures/spend-writer.ts', import.meta.url));

let base: string;
let dir: string;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'orbit-spendfile-'));
  dir = join(base, 'spend');
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const write = (title: string, kill = '') => spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', WRITER, join(dir, 'x.json'), title, kill], { encoding: 'utf8' });
const title = (): unknown => (JSON.parse(readFileSync(join(dir, 'x.json'), 'utf8')) as { title: unknown }).title;
const mode = (p: string): number => statSync(p).mode & 0o777;

describe('writing the spend file', () => {
  it('a kill between write and rename leaves no .json file, and keeps an earlier one whole', () => {
    const killed = write('first', 'kill');
    expect(killed.signal, killed.stderr).toBe('SIGKILL');
    expect(readdirSync(dir)).toHaveLength(1);
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toEqual([]);

    expect(write('whole').status).toBe(0);
    expect(write('second', 'kill').signal).toBe('SIGKILL');
    expect(title()).toBe('whole');
    expect(readdirSync(dir).filter((f) => f.endsWith('.json'))).toEqual(['x.json']);
  });

  it('is mode 0600 in a folder of mode 0700, also one that existed with a wider mode', () => {
    expect(write('a').status).toBe(0);
    expect([mode(dir), mode(join(dir, 'x.json'))]).toEqual([0o700, 0o600]);
    rmSync(dir, { recursive: true });
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    expect(write('b').status).toBe(0);
    expect(mode(dir)).toBe(0o700);
  });
});
