import { describe, expect, it } from 'vitest';
import { fingerprintFailure, normalizeLine, sameFailure, stripAnsi } from '../../../src/evidence/fingerprint.ts';

const check = { id: 'unit' };

const runA = `
\u001B[31m FAIL \u001B[39m  src/math.test.ts > math > adds numbers
AssertionError: expected 3 to be 4
 ❯ src/math.test.ts:12:20
    at /Users/alice/work/acme/src/math.test.ts:12:20
    at processTicksAndRejections (node:internal/process/task_queues:105:5)
 Test Files  1 failed | 3 passed (4)
      Tests  1 failed | 10 passed (11)
   Start at  13:34:04
   Duration  4.86s (transform 120ms, collect 1.2s)
tmp dir: /var/folders/zz/abc123def456/T/orbit-Ab3dEf9/run
request id 3f2b8c1e-9d4a-4e0b-8a77-0a1b2c3d4e5f took 341ms at 2026-10-03T13:34:04.123Z
`;

const runB = `
 FAIL  src/math.test.ts > math > adds numbers
AssertionError: expected 3 to be 4
 ❯ src/math.test.ts:48:3
    at /home/ci/builds/9981/acme/src/math.test.ts:48:3
    at processTicksAndRejections (node:internal/process/task_queues:105:5)
 Test Files  1 failed | 7 passed (8)
      Tests  1 failed | 30 passed (31)
   Start at  09:02:51
   Duration  12.40s (transform 800ms, collect 3.1s)
tmp dir: /private/var/folders/qq/xyz789uvw012/T/orbit-Zq9yXw1/run
request id 7a1c2d3e-0000-4111-8222-aabbccddeeff took 12ms at 2026-11-20T01:02:03.999Z
`;

describe('fingerprintFailure', () => {
  it('is stable across timestamps, durations, paths, temp dirs, ids, line numbers and colour codes', () => {
    const a = fingerprintFailure(runA, check, { roots: ['/Users/alice/work/acme'] });
    const b = fingerprintFailure(runB, check, { roots: ['/home/ci/builds/9981/acme'] });
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(sameFailure(a, b)).toBe(true);
    expect(sameFailure(a.fingerprint, b.fingerprint)).toBe(true);
  });

  it('is stable when the same failures print in a different order or repeat', () => {
    const lines = ['FAIL a.test.ts > one', 'Error: boom in one', 'FAIL b.test.ts > two', 'Error: boom in two'];
    const first = fingerprintFailure(lines.join('\n'), check);
    const shuffled = fingerprintFailure([lines[2], lines[3], lines[0], lines[1], lines[0], lines[1]].join('\n'), check);
    expect(first.fingerprint).toBe(shuffled.fingerprint);
  });

  it('differs when the failure differs: another message, another test, another check', () => {
    const base = fingerprintFailure(runA, check);
    expect(fingerprintFailure(runA.replace('expected 3 to be 4', 'expected 3 to be 5'), check).fingerprint).not.toBe(base.fingerprint);
    expect(fingerprintFailure(runA.replace('adds numbers', 'subtracts numbers'), check).fingerprint).not.toBe(base.fingerprint);
    expect(fingerprintFailure(runA, { id: 'lint' }).fingerprint).not.toBe(base.fingerprint);
    expect(fingerprintFailure(runA + '\nError: a second problem', check).fingerprint).not.toBe(base.fingerprint);
  });

  it('ignores chatter, progress and summary counts that do not describe the cause', () => {
    const quiet = fingerprintFailure('Error: disk full', check);
    const noisy = fingerprintFailure('compiling 12 files...\nTests: 4 failed, 20 passed, 24 total\nwarming cache\nError: disk full\nDone in 3.2s', check);
    expect(noisy.fingerprint).toBe(quiet.fingerprint);
  });

  it('keeps only the top stack frame after an error', () => {
    const shallow = fingerprintFailure('TypeError: x is not a function\n    at foo (/a/b/c.js:1:1)', check);
    const deep = fingerprintFailure('TypeError: x is not a function\n    at foo (/a/b/c.js:1:1)\n    at bar (/a/b/d.js:2:2)\n    at baz (/a/b/e.js:3:3)', check);
    expect(deep.fingerprint).toBe(shallow.fingerprint);
    expect(deep.signature).toHaveLength(2);
  });

  it('gives a silent failure an identity from its tail and how it ended, and a timeout its own', () => {
    const exit1 = fingerprintFailure('', check, { exitCode: 1 });
    const exit2 = fingerprintFailure('', check, { exitCode: 2 });
    const timeout = fingerprintFailure('', check, { timedOut: true });
    expect(new Set([exit1.fingerprint, exit2.fingerprint, timeout.fingerprint]).size).toBe(3);
    expect(fingerprintFailure('', check, { exitCode: 1 }).fingerprint).toBe(exit1.fingerprint);
    expect(exit1.excerpt).toBe('');
    expect(timeout.excerpt).toContain('timed out');
  });

  it('bounds the excerpt in lines and characters and redacts secrets in it', () => {
    const many = Array.from({ length: 100 }, (_, i) => `Error: problem number ${i}`).join('\n');
    expect(fingerprintFailure(many, check, { maxLines: 5 }).excerpt.split('\n')).toHaveLength(5);
    const long = `Error: ${'x'.repeat(5000)}`;
    const capped = fingerprintFailure(long, check, { maxExcerptChars: 100 }).excerpt;
    expect(capped.length).toBeLessThan(140);
    expect(capped).toContain('[orbit: excerpt truncated]');
    const secret = fingerprintFailure(`Error: bad token ghp_${'a1B2'.repeat(9)} rejected`, check).excerpt;
    expect(secret).not.toContain('ghp_a1B2');
    expect(secret).toContain('[REDACTED');
  });

  it('keeps the original wording in the excerpt, without colour codes', () => {
    const { excerpt } = fingerprintFailure(runA, check);
    expect(excerpt).toContain('AssertionError: expected 3 to be 4');
    expect(excerpt).not.toContain('\u001B');
    expect(excerpt).not.toContain('Duration');
  });

  it('stays fast on a very large log', () => {
    const big = Array.from({ length: 150_000 }, (_, i) => (i % 1000 === 0 ? `Error: line ${i}` : `progress ${i} /some/long/path/to/a/file/${i}.ts:${i}:1`)).join('\n');
    const t0 = Date.now();
    const r = fingerprintFailure(big, check);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.signature.length).toBeLessThan(200);
  });
});

describe('normalizeLine', () => {
  it.each([
    ['file.ts:12:34 failed', 'file.ts:<n> failed'],
    ['took 1.5s', 'took <dur>'],
    ['at 2026-10-03 13:34:04,123 boom', 'at <time> boom'],
    ['id 0xdeadBEEF end', 'id <hex> end'],
    ['commit 9f86d081884c7d659a2f done', 'commit <hex> done'],
    ['listening on localhost:41233', 'listening on localhost:<port>'],
    ['open /tmp/abc123/x.log failed', 'open <tmp> failed'],
    ['read /usr/local/lib/node_modules/pkg/index.js', 'read <path>/pkg/index.js'],
    ['see https://example.com/a/b/c', 'see https://example.com/a/b/c'],
    ['either/or and a / b', 'either/or and a / b'],
    ['line 77 col 3', 'line <n> col <n>'],
  ])('%s', (input, expected) => {
    expect(normalizeLine(input)).toBe(expected);
  });

  it('replaces the given roots before the generic path rule', () => {
    expect(normalizeLine('Error in /work/acme/src/a.ts:3:4', ['/work/acme'])).toBe('Error in <repo>/src/a.ts:<n>');
  });

  it('strips ANSI colour and cursor codes', () => {
    expect(stripAnsi('\u001B[1;31mred\u001B[0m \u001B[2K\u001B[1Gdone')).toBe('red done');
  });
});

describe('sameFailure', () => {
  it('treats missing or different fingerprints as different', () => {
    expect(sameFailure(null, null)).toBe(false);
    expect(sameFailure('fp:a', undefined)).toBe(false);
    expect(sameFailure('fp:a', 'fp:b')).toBe(false);
    expect(sameFailure({ fingerprint: 'fp:a' }, 'fp:a')).toBe(true);
  });
});
