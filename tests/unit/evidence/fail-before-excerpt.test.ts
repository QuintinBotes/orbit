// The probe log excerpt a review packet shows under fail_before: required (ADR 0014, 0.3.1 addendum). The 0.3.0 packet
// showed the last 2,000 characters of the log, which for a test runner is its passing suites and summary, so the reviewer
// never saw which tests failed (demo ui run orb-20261013-080027-02f61e, reviews/1/packet.md lines 119-131). The excerpt
// is built from the lines that report a failure, in any runner's words, with a little context and a size bound; a log
// with no such line is shown by its head and tail.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { failureExcerpt, probeLogExcerpt } from '../../../src/evidence/fail-before.ts';

const passing = (n: number, from = 0): string[] => Array.from({ length: n }, (_, i) => `ok ${from + i + 1} - existing test ${from + i}`);

describe('failureExcerpt', () => {
  it('returns a log that fits unchanged', () => {
    expect(failureExcerpt('one\ntwo\n', 500)).toBe('one\ntwo\n');
  });

  it('shows the lines that report failures with a little context, wherever they are, and not the passing tail', () => {
    const log = [...passing(200), 'FAILED tests/test_pricing.py::test_ties - AssertionError: assert 2.67 == 2.68', 'E   assert 2.67 == 2.68', ...passing(300, 200), '1 failed, 500 passed in 0.31s'].join('\n');
    const out = failureExcerpt(log, 1_500);
    expect(out.length).toBeLessThanOrEqual(1_500);
    expect(out).toContain('FAILED tests/test_pricing.py::test_ties - AssertionError: assert 2.67 == 2.68');
    expect(out).toContain('E   assert 2.67 == 2.68');
    expect(out).toContain('1 failed, 500 passed in 0.31s');
    expect(out).toContain('ok 200 - existing test 199');
    expect(out).not.toContain('ok 400 - existing test 399');
    // What was left out is marked, so the reader knows the excerpt is not the whole log.
    expect(out).toMatch(/lines? not shown/);
  });

  it('reads failures in any runner\'s words: TAP, pytest, xunit, go, cargo, a compiler', () => {
    const lines = [
      'not ok 3 - tests/unit/export.test.ts',
      'ERROR tests/test_pricing.py',
      "CalculatorTests.cs(23,49): error CS1061: 'Calculator' does not contain a definition for 'Clamp'",
      '--- FAIL: TestClamp (0.00s)',
      'test clamp::below ... FAILED',
      "thread 'clamp::below' panicked at src/lib.rs:9:5",
      '  Failed Acme.Tests.CalculatorTests.Clamp_LimitsToRange [3 ms]',
    ];
    for (const line of lines) {
      const out = failureExcerpt([...passing(300), line, ...passing(300, 300)].join('\n'), 1_200);
      expect(out, line).toContain(line);
    }
  });

  it('does not take a summary that counts no failures for a failure', () => {
    const log = [...passing(100), '# fail 0', 'Failed: 0, Passed: 100', '0 failed, 100 passed', ...passing(100, 100)].join('\n');
    const out = failureExcerpt(log, 1_000);
    // No failure line: the head and the tail are shown instead.
    expect(out).toContain('ok 1 - existing test 0');
    expect(out).toContain('ok 200 - existing test 199');
  });

  it('falls back to the head and the tail of a log with no failure line', () => {
    const log = [...passing(400), 'Killed'].join('\n');
    const out = failureExcerpt(log, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out.startsWith('ok 1 - existing test 0')).toBe(true);
    expect(out.trimEnd().endsWith('Killed')).toBe(true);
    expect(out).toMatch(/not shown/);
  });

  it('keeps to its bound with many failures and says how many failure lines it left out', () => {
    const log = Array.from({ length: 400 }, (_, i) => `not ok ${i + 1} - broken test ${i}`).join('\n');
    const out = failureExcerpt(log, 1_000);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain('not ok 1 - broken test 0');
    expect(out).toMatch(/more failing lines? not shown/);
  });

  it('cuts a very long line instead of spending the bound on it', () => {
    const long = `Error: ${'x'.repeat(5_000)}`;
    const out = failureExcerpt([...passing(50), long, 'not ok 51 - second failure', ...passing(50, 51)].join('\n'), 1_200);
    expect(out.length).toBeLessThanOrEqual(1_200);
    expect(out).toContain('not ok 51 - second failure');
  });
});

describe('probeLogExcerpt', () => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-fb-excerpt-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the log and excerpts it; a log that cannot be read is empty', () => {
    const path = join(dir, 'unit~1.log');
    writeFileSync(path, [...passing(300), 'not ok 301 - the new test', ...passing(300, 301)].join('\n'));
    expect(probeLogExcerpt(path, 1_000)).toContain('not ok 301 - the new test');
    expect(probeLogExcerpt(join(dir, 'missing.log'))).toBe('');
  });
});
