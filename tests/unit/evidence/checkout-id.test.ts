import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutId } from '../../../src/evidence/git.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const d = mkdtempSync(join(tmpdir(), 'orbit-cid-'));
  dirs.push(d);
  execFileSync('git', ['init', '-q', d]);
  return d;
}

describe('checkoutId', () => {
  it('is stable for one checkout and differs between checkouts', async () => {
    const a = repo();
    const first = await checkoutId(a);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await checkoutId(a)).toBe(first);
    expect(await checkoutId(repo())).not.toBe(first);
  });

  it('replaces an empty id left by a crash, then keeps the new one', async () => {
    const a = repo();
    const file = join(a, '.git', 'orbit-checkout-id');
    writeFileSync(file, '');
    const id = await checkoutId(a);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(readFileSync(file, 'utf8')).toBe(id);
    expect(await checkoutId(a)).toBe(id);
  });
});
