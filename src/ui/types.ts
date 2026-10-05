import type { EvidenceBinding } from '../evidence/types.ts';

/**
 * UI verification results (spec section 13). Everything a journey reports
 * about itself (console output, accessibility findings, even its step names)
 * comes from repository code and is data, never instructions.
 */

export const UI_JOURNEY_STATUSES = ['PASSED', 'FAILED', 'FLAKY', 'SKIPPED', 'TIMED_OUT', 'INTERRUPTED'] as const;
export type UiJourneyStatus = (typeof UI_JOURNEY_STATUSES)[number];

/**
 * PASS         every journey passed and nothing needs a human
 * FAIL         a journey failed, timed out or was skipped (a skipped journey proves nothing)
 * BLOCKED      journeys passed but a stored visual or accessibility baseline changed in the
 *              candidate; baseline changes never pass on their own (scenario 18)
 * ERROR        the run itself is untrustworthy: no report, global errors, snapshots not in 'none' mode
 * TIMEOUT      the run exceeded its limit
 * CANCELLED    stopped on request or interrupted; never a pass
 */
export const UI_RUN_VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'ERROR', 'TIMEOUT', 'CANCELLED'] as const;
export type UiRunVerdict = (typeof UI_RUN_VERDICTS)[number];

export const UI_ARTIFACT_KINDS = ['screenshot', 'trace', 'video', 'console', 'diagnostics', 'accessibility', 'error-context', 'visual-expected', 'visual-actual', 'visual-diff', 'report', 'log', 'other'] as const;
export type UiArtifactKind = (typeof UI_ARTIFACT_KINDS)[number];

export interface UiArtifact {
  name: string;
  kind: UiArtifactKind;
  contentType: string;
  /** Absolute path of the stored file. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface UiConsoleEntry {
  type: string;
  text: string;
  url: string;
  line: number;
}
export interface UiFailedRequest {
  url: string;
  method: string;
  failure: string;
}
export interface UiBadResponse {
  url: string;
  method: string;
  status: number;
}

/** What the orbit-fixtures module recorded in the browser. Untrusted. */
export interface UiDiagnostics {
  consoleErrors: UiConsoleEntry[];
  pageErrors: { name: string; message: string }[];
  failedRequests: UiFailedRequest[];
  badResponses: UiBadResponse[];
  finalUrl: string | null;
  dropped: number;
}

export interface UiA11yEntry {
  ruleId: string;
  impact: string;
  target: string;
  url: string;
  viewport: string;
  help: string;
  fingerprint: string;
}
export interface UiA11yScan {
  url: string;
  viewport: string;
  baselinePath: string | null;
  baselineLoaded: boolean;
  seriousOrCritical: number;
  newViolations: UiA11yEntry[];
  baselinedCount: number;
}

export interface UiJourneyError {
  /** ANSI escapes removed, redacted, bounded. */
  message: string;
  location: { file: string; line: number; column: number } | null;
  /** Source excerpt around the failing line. */
  snippet: string | null;
  expected: string | null;
  observed: string | null;
  /** The assertion's own diff when it is not a plain expected/received pair. */
  diff: string | null;
}

export interface UiStep {
  title: string;
  status: 'passed' | 'failed';
  durationMs: number;
}

export interface UiJourneyResult {
  /** `<project>/<file>#<titles>`: unique per journey and project. */
  id: string;
  title: string;
  titlePath: string[];
  /** Relative to the checkout when inside it. */
  file: string;
  line: number;
  project: string;
  checkId: string;
  status: UiJourneyStatus;
  /** Number of attempts that ran (1 without retries). */
  attempts: number;
  durationMs: number;
  browser: { name: string; version: string } | null;
  viewport: Viewport | null;
  steps: UiStep[];
  /** Deepest failing step, as "outer > inner"; null when no named step failed. */
  failedStep: string | null;
  error: UiJourneyError | null;
  artifacts: UiArtifact[];
  diagnostics: UiDiagnostics | null;
  a11y: UiA11yScan[];
  /** Playwright's error-context sections; DOM evidence is the page snapshot. Untrusted. */
  errorContext: { errorDetails: string | null; pageSnapshot: string | null } | null;
  /** The command that reruns just this journey. */
  reproduction: UiReproduction;
  /** test.fail() and similar annotations that change what a pass means. */
  annotations: string[];
}

export interface UiReproduction {
  cwd: string;
  argv: string[];
  env: Record<string, string>;
  /** `argv` joined for a terminal, quoted. */
  command: string;
}

export interface UiCheckRun {
  checkId: string;
  argv: string[];
  exitCode: number | null;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  logPath: string;
  reportPath: string;
  reportFound: boolean;
  isolation: string;
  isolationLimitations: string[];
  playwrightVersion: string | null;
}

export interface UiBinding extends EvidenceBinding {
  commitSha: string;
  playwrightVersion: string | null;
  browsers: { name: string; version: string }[];
  viewports: Viewport[];
  baseUrl: string;
}

export interface UiRunResult {
  verdict: UiRunVerdict;
  passed: boolean;
  /** Why the verdict is not PASS, in plain words. */
  reasons: string[];
  binding: UiBinding;
  journeys: UiJourneyResult[];
  checks: UiCheckRun[];
  stats: { passed: number; failed: number; flaky: number; skipped: number; other: number };
  /** Passed only after a retry somewhere: disclosed, never a clean pass. */
  flaky: boolean;
  /** Visual baseline files that differ between the candidate's base and the candidate (or were written during the run). */
  visualBaselineChanges: string[];
  /** Accessibility baseline files named by journeys that the candidate changed. */
  a11yBaselineChanges: string[];
  consoleErrorCount: number;
  coverage: {
    configuredViewports: Viewport[];
    observedViewports: Viewport[];
    missingViewports: Viewport[];
    configuredBrowsers: string[];
    observedBrowsers: string[];
    missingBrowsers: string[];
  };
  /** Things the run could not establish, stated rather than implied (feeds EvidenceReport.unverified). */
  unverified: string[];
  /** Coverage limits that always apply, such as the limits of automated accessibility scans. */
  limitations: string[];
  outDir: string;
  startedAt: number;
  endedAt: number;
}

/** The slice of a run the evidence report carries (EvidenceReport.ui). */
export interface UiEvidenceEntry {
  journey: string;
  /** The playwright check the journey belongs to, so criteria and required checks can map to it. */
  checkId?: string;
  status: 'PASSED' | 'FAILED' | 'ERROR' | 'TIMEOUT' | 'CANCELLED';
  artifacts: string[];
}
