import type { UiJourneyResult, UiRunResult } from '../../../src/ui/types.ts';

export function journeyResult(over: Partial<UiJourneyResult> = {}): UiJourneyResult {
  return {
    id: 'desktop/journeys/reports.spec.ts#reports-export',
    title: 'reports-export',
    titlePath: ['reports-export'],
    file: 'journeys/reports.spec.ts',
    line: 5,
    project: 'desktop',
    checkId: 'ui-journeys',
    status: 'PASSED',
    attempts: 1,
    durationMs: 100,
    browser: { name: 'chromium', version: '153.0.8010.12' },
    viewport: { width: 1440, height: 900 },
    steps: [],
    failedStep: null,
    error: null,
    artifacts: [],
    diagnostics: null,
    a11y: [],
    keyboard: [],
    errorContext: null,
    reproduction: { cwd: '/repo', argv: ['npx', 'playwright', 'test'], env: {}, command: 'cd /repo && npx playwright test' },
    annotations: [],
    ...over,
  };
}

export function runResult(over: Partial<UiRunResult> = {}): UiRunResult {
  return {
    verdict: 'PASS',
    passed: true,
    reasons: [],
    binding: { candidateId: 'cand-1', treeHash: 'a'.repeat(40), checkConfigHash: 'sha256:x', policyHash: 'sha256:y', commitSha: 'b'.repeat(40), playwrightVersion: '1.63.0', browsers: [], viewports: [], baseUrl: 'http://127.0.0.1:3000', keyboard: { scans: 0, failed: 0 }, accessibilityFailOn: 'serious,critical' },
    journeys: [],
    checks: [],
    stats: { passed: 0, failed: 0, flaky: 0, skipped: 0, other: 0 },
    flaky: false,
    visualBaselineChanges: [],
    a11yBaselineChanges: [],
    a11yAdvisory: [],
    consoleErrorCount: 0,
    coverage: { configuredViewports: [], observedViewports: [], missingViewports: [], configuredBrowsers: [], observedBrowsers: [], missingBrowsers: [] },
    unverified: [],
    limitations: ['Automated accessibility scans find only part of the possible problems.'],
    outDir: '/evidence/ui',
    startedAt: 1,
    endedAt: 2,
    ...over,
  };
}
