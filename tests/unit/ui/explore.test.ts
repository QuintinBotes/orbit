import { describe, expect, it } from 'vitest';
import { explorationConfigOf, explorationFollowUps, explorerWorkUnit, lintExplorationSpec, renderExplorationReport, type ExplorationFinding, type ExplorationResult } from '../../../src/ui/explore.ts';
import type { UiConfig } from '../../../src/policy/types.ts';

const BASE = 'http://127.0.0.1:4173';
const GOOD = `import { expect, test } from '@playwright/test';
test('count', async ({ page }) => {
  await page.goto('/reports');
  await expect(page.locator('#count')).toHaveText('2 reports');
});
`;

describe('lintExplorationSpec', () => {
  it('accepts a plain Playwright spec against the application', () => {
    expect(lintExplorationSpec(GOOD, BASE)).toEqual([]);
    expect(lintExplorationSpec(GOOD.replace("'/reports'", `'${BASE}/reports'`), BASE)).toEqual([]);
  });

  it.each([
    ['an empty spec', '', /empty/],
    ['a spec without a test', "import { expect } from '@playwright/test';\nexpect(1).toBe(2);", /no test/],
    ['a spec without an assertion', GOOD.replace(/await expect[^\n]*\n/, ''), /no assertion/],
    ['a spec that never opens the app', GOOD.replace("await page.goto('/reports');", ''), /never opens/],
    ['a node: import', `import { readFileSync } from 'node:fs';\n${GOOD}`, /node:fs/],
    ['a relative import', `import { x } from './helpers.ts';\n${GOOD}`, /\.\/helpers\.ts/],
    ['dynamic import', GOOD.replace("await page.goto('/reports');", "await page.goto('/reports'); await import('node:os');"), /dynamically/],
    ['process access', GOOD.replace("await page.goto('/reports');", "await page.goto('/reports'); void process.env;"), /outside the page/],
    ['test.skip', GOOD.replace("test('count'", "test.skip('count'"), /skips, inverts/],
    ['test.fail', GOOD.replace("test('count'", "test.fail('count'"), /skips, inverts/],
    ['test.only', GOOD.replace("test('count'", "test.only('count'"), /skips, inverts/],
    ['mocked responses', GOOD.replace("await page.goto('/reports');", "await page.route('**/api/**', (r) => r.fulfill({ body: '[]' })); await page.goto('/reports');"), /replaces what the application serves/],
    ['setContent', GOOD.replace("await page.goto('/reports');", "await page.setContent('<p/>'); await page.goto('/reports');"), /replaces what the application serves/],
    ['a throw', GOOD.replace("await expect(", "throw new Error('x'); await expect("), /by construction/],
    ['a constant assertion', GOOD.replace("await expect(page.locator('#count')).toHaveText('2 reports');", 'expect(true).toBe(false);'), /by construction/],
    ['another host', GOOD.replace("'/reports'", "'https://example.com/reports'"), /example\.com/],
    ['another port', GOOD.replace("'/reports'", "'http://127.0.0.1:9/reports'"), /127\.0\.0\.1:9/],
  ])('refuses %s', (_name, source, pattern) => {
    expect(lintExplorationSpec(source, BASE).join(' ')).toMatch(pattern);
  });

  it('does not read commented-out code', () => {
    const src = `// import { readFileSync } from 'node:fs';\n/* test.skip */\n${GOOD}`;
    expect(lintExplorationSpec(src, BASE)).toEqual([]);
  });

  it('refuses an overlong spec', () => {
    expect(lintExplorationSpec(`${GOOD}\n// ${'x'.repeat(100)}`, BASE)).toEqual([]);
    expect(lintExplorationSpec(`${GOOD}\nconst pad = '${'x'.repeat(21_000)}';`, BASE).join(' ')).toMatch(/longer than/);
  });
});

describe('explorationConfigOf', () => {
  const ui = (exploration: unknown): UiConfig => ({ exploration }) as unknown as UiConfig;

  it('is disabled when the policy has no exploration block', () => {
    expect(explorationConfigOf({} as UiConfig)).toEqual({ enabled: false, max_minutes: 0, budget_usd: 0 });
    expect(explorationConfigOf(ui(null)).enabled).toBe(false);
  });
  it('reads the three bounds and only treats `true` as enabled', () => {
    expect(explorationConfigOf(ui({ enabled: true, max_minutes: 7, budget_usd: 1.5 }))).toEqual({ enabled: true, max_minutes: 7, budget_usd: 1.5 });
    expect(explorationConfigOf(ui({ enabled: 'yes', max_minutes: -1, budget_usd: -2 }))).toEqual({ enabled: false, max_minutes: 0, budget_usd: 0 });
  });
});

function finding(over: Partial<ExplorationFinding>): ExplorationFinding {
  return {
    id: 'EX-1',
    summary: 's',
    steps: [],
    expected: 'e',
    observed: 'o',
    severity: 'low',
    proposedTest: 't',
    status: 'not_reproduced',
    reason: 'r',
    runs: [],
    spec: null,
    reproduction: null,
    artifacts: [],
    countsAsAcceptanceEvidence: false,
    ...over,
  };
}

function result(findings: ExplorationFinding[]): ExplorationResult {
  return {
    outcome: 'completed',
    findings,
    reproduced: findings.filter((f) => f.status === 'reproduced'),
    unreproduced: findings.filter((f) => f.status !== 'reproduced'),
    observations: [],
    coverageNotes: null,
    budgetUsd: 1,
    maxMinutes: 5,
    costUsd: null,
    reasons: [],
    unverified: [],
    acceptanceEvidence: false,
    baseUrl: BASE,
    outDir: '/out',
    startedAt: 1,
    endedAt: 2,
  };
}

describe('follow-ups and report', () => {
  it('hands the implementer only reproduced findings, each with its failing spec', () => {
    const r = result([
      finding({ id: 'EX-1', status: 'reproduced', spec: { path: '/out/EX-1.spec.ts', sha256: 'a'.repeat(64), source: GOOD }, reproduction: 'npx playwright test' }),
      finding({ id: 'EX-2', status: 'intermittent', spec: { path: '/out/EX-2.spec.ts', sha256: 'b'.repeat(64), source: GOOD }, reproduction: null }),
      finding({ id: 'EX-3', status: 'invalid_test' }),
    ]);
    expect(explorationFollowUps(r).map((f) => [f.id, f.specPath])).toEqual([['EX-1', '/out/EX-1.spec.ts']]);
  });

  it('labels unproven findings and says exploration is not acceptance evidence', () => {
    const md = renderExplorationReport(result([finding({ id: 'EX-2', status: 'intermittent', reason: 'failed 1 of 2 runs' })]));
    expect(md).toContain('EX-2 (low): intermittent');
    expect(md).toMatch(/not acceptance evidence/);
    expect(md).toContain('Reproduced: 0');
  });

  it('keeps model text inside a fence it cannot close', () => {
    const md = renderExplorationReport(result([finding({ summary: '```\n# injected heading' })]));
    expect(md).toContain('````text');
  });

  it('writes the bounds into the explorer work unit', () => {
    const text = explorerWorkUnit({ baseUrl: BASE, viewports: [{ width: 390, height: 844 }], browsers: ['chromium'], goal: 'Check the reports page' }, { enabled: true, max_minutes: 9, budget_usd: 2 });
    expect(text).toContain(BASE);
    expect(text).toContain('390x844');
    expect(text).toContain('9 minute');
    expect(text).toContain('USD 2');
    expect(text).toContain('Check the reports page');
  });
});
