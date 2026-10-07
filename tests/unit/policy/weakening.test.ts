import { describe, expect, it } from 'vitest';
import { detectWeakening, isSnapshotPath, isTestPath, type WeakeningInput } from '../../../src/policy/weakening.ts';

function diff(removed: string[], added: string[], context: string[] = []): string {
  return ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -1,3 +1,3 @@', ...context.map((l) => ` ${l}`), ...removed.map((l) => `-${l}`), ...added.map((l) => `+${l}`)].join('\n');
}

function signals(input: Partial<WeakeningInput> & { diff?: string }): string[] {
  return detectWeakening([{ path: 'src/a.test.ts', status: 'M', diff: '', ...input }]).map((s) => s.signal);
}

describe('test file recognition', () => {
  it('recognises JS/TS, Python and Go test conventions', () => {
    for (const p of ['src/a.test.ts', 'web/b.spec.jsx', '__tests__/c.js', 'tests/unit/d.ts', 'pkg/test_e.py', 'pkg/f_test.py', 'tests/conftest.py', 'cmd/g_test.go', 'e2e/login.spec.ts']) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ['src/a.ts', 'testing.md', 'tests/fixtures/data.json', 'contest.py']) expect(isTestPath(p), p).toBe(false);
  });

  // Issue #30: the same predicate gates test-file-deleted, so a deleted test of another language is a signal too.
  it('flags a deleted test file of every covered language, and a deleted file of a .NET test project by its layout', () => {
    const layout = { dotnetProjects: new Map([['src/Acme', false], ['tests/Acme.Tests', true]]), cargoManifests: new Map([['', true]]) };
    const deleted = (path: string) => detectWeakening([{ path, status: 'D', diff: '' }], layout).map((s) => s.signal);
    for (const p of ['tests/Acme.Tests/CalculatorTests.cs', 'src/test/java/com/acme/CalculatorTest.java', 'spec/models/user_spec.rb', 'tests/Unit/CalculatorTest.php', 'Tests/AcmeTests/CalculatorTests.swift', 'src/parser_test.cc', 'test/acme/calculator_test.exs', 'test/calculator_test.dart', 'tests/mul.rs']) {
      expect(deleted(p), p).toEqual(['test-file-deleted']);
    }
    for (const p of ['src/Acme/Test.cs', 'src/Acme/CalculatorTests.cs', 'src/main/java/com/acme/LoadTest.java', 'src/lib.rs']) expect(deleted(p), p).toEqual([]);
    // Without the layout a C# path says nothing about its project.
    expect(detectWeakening([{ path: 'tests/Acme.Tests/CalculatorTests.cs', status: 'D', diff: '' }]).map((s) => s.signal)).toEqual([]);
  });

  it('judges a Rust source by what the file is, not by the #[test] its change adds: its production numbers are not test tolerances', () => {
    const layout = { dotnetProjects: new Map<string, boolean>(), cargoManifests: new Map([['', true]]) };
    const d = diff(['    let timeout_ms = 500;'], ['    let timeout_ms = 5000;', '#[test]', 'fn mul_works() { assert_eq!(mul(2, 3), 6); }']);
    expect(detectWeakening([{ path: 'src/lib.rs', status: 'M', diff: d }], layout)).toEqual([]);
    expect(detectWeakening([{ path: 'tests/mul.rs', status: 'M', diff: d }], layout).map((s) => s.signal)).toEqual(['timeout-raised']);
  });

  it('recognises stored expectations', () => {
    for (const p of ['src/__snapshots__/a.test.ts.snap', 'e2e/home.spec.ts-snapshots/home-chromium.png', 'tests/__snapshots__/test_x.ambr', 'x/__screenshots__/a.png']) {
      expect(isSnapshotPath(p), p).toBe(true);
    }
    expect(isSnapshotPath('src/snapshot.ts')).toBe(false);
  });
});

describe('detectWeakening', () => {
  it('flags removed assertions in JS/TS, Python and Go', () => {
    expect(signals({ diff: diff(['  expect(total).toBe(42);', '  expect(rows).toHaveLength(3);'], ['  const unused = 1;']) })).toContain('assertion-removed');
    expect(signals({ path: 'tests/test_calc.py', diff: diff(['    assert total == 42', '    self.assertEqual(a, b)'], []) })).toContain('assertion-removed');
    expect(signals({ path: 'calc/calc_test.go', diff: diff(['\tif got != want { t.Errorf("got %d", got) }', '\trequire.NoError(t, err)'], []) })).toContain('assertion-removed');
  });

  it('does not flag a reworded assertion that is still there', () => {
    expect(signals({ diff: diff(['  expect(total).toBe(42);'], ['  expect(total).toBe(43);']) })).not.toContain('assertion-removed');
  });

  it('flags an assertion turned into a comment', () => {
    const s = detectWeakening([{ path: 'src/a.test.ts', status: 'M', diff: diff(['  expect(x).toBe(1);'], ['  // expect(x).toBe(1);']) }]);
    expect(s).toEqual(expect.arrayContaining([expect.objectContaining({ signal: 'assertion-removed', detail: 'assertion commented out' })]));
  });

  it('flags looser matchers and assertions that cannot fail', () => {
    expect(signals({ diff: diff(['  expect(user.name).toEqual("Ada");'], ['  expect(user.name).toBeDefined();']) })).toContain('assertion-weakened');
    expect(signals({ diff: diff([], ['  expect(true).toBe(true);']) })).toContain('assertion-weakened');
    expect(signals({ path: 'tests/test_x.py', diff: diff([], ['    assert True']) })).toContain('assertion-weakened');
  });

  it('flags skipped and focused tests across frameworks', () => {
    const skipped = [
      "it.skip('works', () => {})",
      "xit('works', () => {})",
      "xdescribe('suite', () => {})",
      "test.fixme('flow', async () => {})",
      "test.skip('flow', async () => {})",
      "describe.skip('suite', () => {})",
      "test.describe.skip('suite', () => {})",
      "it.todo('later')",
    ];
    for (const line of skipped) expect(signals({ diff: diff([], [line]) }), line).toContain('test-skipped');
    for (const line of ['@pytest.mark.skip(reason="flaky")', '@pytest.mark.xfail', '@unittest.skip("x")', '    pytest.skip("no")', '    self.skipTest("no")']) {
      expect(signals({ path: 'tests/test_y.py', diff: diff([], [line]) }), line).toContain('test-skipped');
    }
    expect(signals({ path: 'pkg/z_test.go', diff: diff([], ['\tt.Skip("later")']) })).toContain('test-skipped');
    expect(signals({ path: 'pkg/z_test.go', diff: diff([], ['//go:build ignore']) })).toContain('test-skipped');
    for (const line of ["it.only('x', () => {})", "describe.only('x', () => {})", "fit('x', () => {})", "test.describe.only('x', () => {})"]) {
      expect(signals({ diff: diff([], [line]) }), line).toContain('test-focused');
    }
  });

  it('ignores skip markers that only appear in comments', () => {
    expect(signals({ diff: diff([], ['  // TODO: it.skip this if it gets flaky']) })).not.toContain('test-skipped');
  });

  it('flags raised timeouts but not lowered ones', () => {
    expect(signals({ diff: diff(['  jest.setTimeout(5000);'], ['  jest.setTimeout(60000);']) })).toContain('timeout-raised');
    expect(signals({ diff: diff(["  it('x', async () => {}, { timeout: 2_000 });"], ["  it('x', async () => {}, { timeout: 30_000 });"]) })).toContain('timeout-raised');
    expect(signals({ path: 'playwright.config.ts', diff: diff(['  timeout: 30000,'], ['  timeout: 120000,']) })).toContain('timeout-raised');
    expect(signals({ path: 'tests/test_t.py', diff: diff(['@pytest.mark.timeout(5)'], ['@pytest.mark.timeout(50)']) })).toContain('timeout-raised');
    expect(signals({ diff: diff(['  jest.setTimeout(60000);'], ['  jest.setTimeout(5000);']) })).not.toContain('timeout-raised');
    expect(signals({ diff: diff([], ['  test.slow();']) })).toContain('timeout-raised');
  });

  it('flags deleted test files and edited or deleted snapshots', () => {
    expect(signals({ path: 'src/a.test.ts', status: 'D', diff: diff(['expect(1).toBe(1)'], []) })).toEqual(['test-file-deleted']);
    expect(signals({ path: 'src/__snapshots__/a.test.ts.snap', status: 'M' })).toEqual(['snapshot-edited']);
    expect(signals({ path: 'e2e/a.spec.ts-snapshots/home.png', status: 'D' })).toEqual(['snapshot-edited']);
    expect(signals({ path: 'src/__snapshots__/new.test.ts.snap', status: 'A' })).toEqual(['snapshot-added']);
    expect(signals({ path: 'src/a.ts', status: 'D' })).toEqual([]);
  });

  it('flags inline snapshot rewrites', () => {
    expect(signals({ diff: diff(['    "total": 42,'], ['    "total": 41,'], ['  expect(report).toMatchInlineSnapshot(`']) })).toContain('snapshot-edited');
  });

  it('flags tolerance increases', () => {
    expect(signals({ diff: diff(['  expect(x).toBeCloseTo(0.3, 5);'], ['  expect(x).toBeCloseTo(0.3, 1);']) })).toContain('tolerance-increased');
    expect(signals({ diff: diff(['  expect(x).toBeCloseTo(0.3, 5);'], ['  expect(x).toBeCloseTo(0.3);']) })).toContain('tolerance-increased');
    expect(signals({ path: 'e2e/a.spec.ts', diff: diff(["  await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.01 });"], ["  await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.2 });"]) })).toContain('tolerance-increased');
    expect(signals({ path: 'playwright.config.ts', diff: diff(['    toHaveScreenshot: { threshold: 0.1 },'], ['    toHaveScreenshot: { threshold: 0.5 },']) })).toContain('tolerance-increased');
    expect(signals({ path: 'tests/test_n.py', diff: diff(['    assert x == pytest.approx(1.0, rel=1e-6)'], ['    assert x == pytest.approx(1.0, rel=0.1)']) })).toContain('tolerance-increased');
    expect(signals({ path: 'tests/test_n.py', diff: diff(['    self.assertAlmostEqual(a, b, places=7)'], ['    self.assertAlmostEqual(a, b, places=2)']) })).toContain('tolerance-increased');
    expect(signals({ path: 'm/m_test.go', diff: diff(['\tassert.InDelta(t, 1.0, got, 0.001)'], ['\tassert.InDelta(t, 1.0, got, 0.5)']) })).toContain('tolerance-increased');
    expect(signals({ diff: diff(['  expect(x).toBeCloseTo(0.3, 1);'], ['  expect(x).toBeCloseTo(0.3, 5);']) })).not.toContain('tolerance-increased');
  });

  it('flags lint and type-check suppressions in any file', () => {
    for (const [path, line] of [
      ['src/a.ts', '  // eslint-disable-next-line no-unused-vars'],
      ['src/a.ts', '  // @ts-ignore'],
      ['src/a.ts', '  // @ts-expect-error'],
      ['app/x.py', 'import os  # noqa: F401'],
      ['app/x.py', 'x = f()  # type: ignore'],
      ['pkg/x.go', 'func f() {} //nolint:errcheck'],
      ['src/a.ts', '/* istanbul ignore next */'],
    ] as const) {
      expect(signals({ path, diff: diff([], [line]) }), line).toContain('lint-disabled');
    }
  });

  it('flags relaxed lint and test configuration', () => {
    expect(signals({ path: '.eslintrc.json', diff: diff(['    "no-console": "error",'], ['    "no-console": "off",']) })).toContain('lint-disabled');
    expect(signals({ path: 'tsconfig.json', diff: diff(['    "strict": true,'], ['    "strict": false,']) })).toContain('lint-disabled');
    expect(signals({ path: 'jest.config.js', diff: diff([], ['  passWithNoTests: true,']) })).toContain('test-config-weakened');
    expect(signals({ path: 'jest.config.js', diff: diff([], ["  testPathIgnorePatterns: ['/reports/'],"]) })).toContain('test-config-weakened');
    expect(signals({ path: 'playwright.config.ts', diff: diff(['  retries: 0,'], ['  retries: 3,']) })).toContain('test-config-weakened');
    expect(signals({ path: 'playwright.config.ts', diff: diff([], ['  ignoreSnapshots: true,']) })).toContain('test-config-weakened');
    expect(signals({ path: 'vitest.config.ts', diff: diff(['      thresholds: { lines: 90 },'], ['      thresholds: { lines: 40 },']) })).toContain('test-config-weakened');
    expect(signals({ path: 'package.json', diff: diff(['    "test": "vitest run",'], ['    "test": "vitest run || true",']) })).toContain('test-config-weakened');
  });

  it('flags secret-scanner suppression and diff-hiding attributes', () => {
    expect(signals({ path: 'src/config.ts', diff: diff([], ['const k = "AKIA..."; // gitleaks:allow']) })).toContain('secret-scan-suppressed');
    expect(signals({ path: '.gitleaks.toml', status: 'A' })).toContain('secret-scan-suppressed');
    expect(signals({ path: '.gitleaksignore', status: 'M' })).toContain('secret-scan-suppressed');
    expect(signals({ path: '.gitattributes', status: 'M', diff: diff([], ['*.ts -diff']) })).toContain('diff-attributes-changed');
  });

  it('stays quiet on an ordinary source change', () => {
    expect(detectWeakening([{ path: 'src/a.ts', status: 'M', diff: diff(['  return a + b;'], ['  return a + b + c;']) }])).toEqual([]);
    expect(detectWeakening([{ path: 'src/a.test.ts', status: 'A', diff: diff([], ["it('adds', () => {", '  expect(add(1, 2)).toBe(3);', '});']) }])).toEqual([]);
  });
});

describe('loosening introduced where the framework default applied before', () => {
  it('flags a timeout added to an existing test file or test config', () => {
    expect(signals({ diff: diff([], ['  test.setTimeout(120_000);'], ["test('slow', async () => {"]) })).toContain('timeout-raised');
    expect(signals({ diff: diff([], ['  jest.setTimeout(60000);']) })).toContain('timeout-raised');
    expect(signals({ path: 'vitest.config.ts', diff: diff([], ['    testTimeout: 30000,'], ['  test: {']) })).toContain('timeout-raised');
    expect(signals({ path: 'tests/test_api.py', diff: diff([], ['@pytest.mark.timeout(600)']) })).toContain('timeout-raised');
  });

  it('flags a tolerance added where the comparison used to be exact', () => {
    expect(signals({ path: 'e2e/home.spec.ts', diff: diff([], ['  await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.2 });'], ['  await page.goto("/");']) })).toContain('tolerance-increased');
    expect(signals({ path: 'playwright.config.ts', diff: diff([], ['    toHaveScreenshot: { threshold: 0.5 },']) })).toContain('tolerance-increased');
  });

  it('leaves brand new test files alone: an explicit timeout there loosens nothing', () => {
    expect(signals({ status: 'A', diff: diff([], ["test('x', async () => {", '  test.setTimeout(120_000);', '});']) })).not.toContain('timeout-raised');
  });

  it('does not flag a timeout that is lowered or kept', () => {
    expect(signals({ diff: diff(['  test.setTimeout(60_000);'], ['  test.setTimeout(30_000);']) })).not.toContain('timeout-raised');
    expect(signals({ diff: diff([], ['  // a comment about the timeout: 5000']) })).not.toContain('timeout-raised');
  });
});
