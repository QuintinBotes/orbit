import { redact } from '../core/redact.ts';
import type { UiA11yScan, UiDiagnostics, UiJourneyError, UiKeyboardScan, UiStep } from './types.ts';

/**
 * Parsing Playwright's JSON report (docs/interfaces/playwright-and-github.md
 * A3). The report is written by a process that ran repository code, so every
 * field is checked rather than cast, and strings are bounded and redacted
 * before they reach a brief or a model.
 */

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
export const MAX_MESSAGE_CHARS = 4_000;
const MAX_DIFF_LINES = 40;
const MAX_STEPS = 50;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** ANSI-free, redacted and bounded: the form in which any report text is stored. */
export function cleanText(text: string, max = MAX_MESSAGE_CHARS): string {
  const clean = redact(stripAnsi(text));
  return clean.length > max ? `${clean.slice(0, max)}\n[orbit: truncated ${clean.length - max} characters]` : clean;
}

export interface RawAttachment {
  name: string;
  contentType: string;
  path: string | null;
  /** Decoded inline body, when the attachment had one. */
  body: Buffer | null;
}

export interface RawResult {
  status: string;
  durationMs: number;
  retry: number;
  error: { message: string; snippet: string | null; location: { file: string; line: number; column: number } | null } | null;
  steps: RawStep[];
  attachments: RawAttachment[];
}

export interface RawStep {
  title: string;
  durationMs: number;
  failed: boolean;
  steps: RawStep[];
}

export interface RawTest {
  titlePath: string[];
  file: string;
  line: number;
  projectName: string;
  /** Playwright's outcome: expected, unexpected, flaky, skipped. */
  outcome: string;
  expectedStatus: string;
  annotations: string[];
  results: RawResult[];
}

export interface ParsedReport {
  playwrightVersion: string | null;
  updateSnapshots: string | null;
  grepInvert: boolean;
  shard: boolean;
  projectNames: string[];
  /**
   * Ways the run was narrowed that Orbit cannot undo: grep or shard on the command line or in the config, and
   * per-project testIgnore. Each means some journeys may not have run, so each is reported as unverified.
   */
  selection: string[];
  /** Global errors (webServer, globalSetup); any of them makes the run untrustworthy. */
  errors: string[];
  stats: { expected: number; unexpected: number; flaky: number; skipped: number };
  tests: RawTest[];
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const num = (v: unknown, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

const MAX_INLINE_BODY_BYTES = 2 * 1024 * 1024;

export function parsePlaywrightReport(raw: unknown): ParsedReport {
  if (!isObj(raw)) throw new TypeError('Playwright report is not an object');
  const config = isObj(raw.config) ? raw.config : {};
  const stats = isObj(raw.stats) ? raw.stats : {};
  const report: ParsedReport = {
    playwrightVersion: str(config.version),
    updateSnapshots: str(config.updateSnapshots),
    grepInvert: config.grepInvert !== null && config.grepInvert !== undefined,
    shard: config.shard !== null && config.shard !== undefined,
    projectNames: arr(config.projects).flatMap((p) => (isObj(p) && typeof p.name === 'string' ? [p.name] : [])),
    selection: selectionSignals(config),
    errors: arr(raw.errors).map((e) => cleanText(isObj(e) ? (str(e.message) ?? str(e.stack) ?? 'unknown error') : String(e), 1_000)),
    stats: { expected: num(stats.expected), unexpected: num(stats.unexpected), flaky: num(stats.flaky), skipped: num(stats.skipped) },
    tests: [],
  };
  for (const suite of arr(raw.suites)) walkSuite(suite, [], true, report);
  return report;
}

const SELECTION_ARG = /^(?:-g|--grep|-G|--grep-invert|--shard|--only-changed|--last-failed|--test-list|--test-list-invert)(?:=.*)?$/;

function selectionSignals(config: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (config.grepInvert !== null && config.grepInvert !== undefined) out.push('grepInvert is set');
  if (config.shard !== null && config.shard !== undefined) out.push('shard is set');
  // The report records the real command line (verified on 1.63.0), which also exposes a -g the check command carried.
  for (const a of arr(config.argv)) if (typeof a === 'string' && SELECTION_ARG.test(a)) out.push(`the command line carries ${cleanText(a, 80)}`);
  for (const p of arr(config.projects)) {
    if (!isObj(p)) continue;
    const ignored = Array.isArray(p.testIgnore) ? p.testIgnore.length > 0 : typeof p.testIgnore === 'string' && p.testIgnore !== '';
    if (ignored) out.push(`project ${cleanText(str(p.name) ?? '?', 80)} sets testIgnore`);
  }
  return [...new Set(out)];
}

function walkSuite(suite: unknown, parents: string[], isFile: boolean, out: ParsedReport): void {
  if (!isObj(suite)) return;
  // The top-level suite of each file is titled with the file name, which the spec's own `file` already carries.
  const title = str(suite.title);
  const path = isFile || title === null || title === '' ? parents : [...parents, title];
  for (const spec of arr(suite.specs)) {
    if (!isObj(spec)) continue;
    for (const test of arr(spec.tests)) {
      if (!isObj(test)) continue;
      out.tests.push({
        titlePath: [...path, str(spec.title) ?? '(untitled)'],
        file: str(spec.file) ?? str(suite.file) ?? '',
        line: num(spec.line),
        projectName: str(test.projectName) ?? str(test.projectId) ?? '',
        outcome: str(test.status) ?? 'unknown',
        expectedStatus: str(test.expectedStatus) ?? 'passed',
        annotations: arr(test.annotations).flatMap((a) => (isObj(a) && typeof a.type === 'string' ? [a.type] : [])),
        results: arr(test.results).flatMap((r) => (isObj(r) ? [parseResult(r)] : [])),
      });
    }
  }
  for (const child of arr(suite.suites)) walkSuite(child, path, false, out);
}

function parseResult(r: Record<string, unknown>): RawResult {
  const err = isObj(r.error) ? r.error : null;
  const loc = err && isObj(err.location) ? err.location : null;
  return {
    status: str(r.status) ?? 'unknown',
    durationMs: num(r.duration),
    retry: num(r.retry),
    error: err
      ? {
          message: cleanText(str(err.message) ?? str(err.stack) ?? 'unknown error'),
          snippet: str(err.snippet) === null ? null : cleanText(str(err.snippet) ?? '', 1_500),
          location: loc && str(loc.file) !== null ? { file: str(loc.file) ?? '', line: num(loc.line), column: num(loc.column) } : null,
        }
      : null,
    steps: arr(r.steps).slice(0, MAX_STEPS).flatMap((s) => (isObj(s) ? [parseStep(s, 0)] : [])),
    attachments: arr(r.attachments).flatMap((a) => (isObj(a) ? parseAttachment(a) : [])),
  };
}

function parseStep(s: Record<string, unknown>, depth: number): RawStep {
  return {
    title: cleanText(str(s.title) ?? '', 200),
    durationMs: num(s.duration),
    failed: isObj(s.error),
    steps: depth >= 4 ? [] : arr(s.steps).flatMap((c) => (isObj(c) ? [parseStep(c, depth + 1)] : [])),
  };
}

function parseAttachment(a: Record<string, unknown>): RawAttachment[] {
  const name = str(a.name);
  if (name === null) return [];
  let body: Buffer | null = null;
  const b64 = str(a.body);
  // Base64 inflates by a third; refuse before decoding rather than after.
  if (b64 !== null && b64.length <= (MAX_INLINE_BODY_BYTES * 4) / 3 + 4) body = Buffer.from(b64, 'base64');
  return [{ name, contentType: str(a.contentType) ?? 'application/octet-stream', path: str(a.path), body }];
}

// ---------------------------------------------------------------------------
// Steps and errors

export function summarizeSteps(steps: RawStep[]): UiStep[] {
  return steps.map((s) => ({ title: s.title, status: s.failed ? 'failed' : 'passed', durationMs: Math.round(s.durationMs) }));
}

/** The deepest step on the failing path, as "outer > inner"; null when no step failed. */
export function failedStepPath(steps: RawStep[]): string | null {
  const failing = steps.find((s) => s.failed);
  if (!failing) return null;
  const parts = [failing.title];
  let cur = failing;
  for (;;) {
    const next = cur.steps.find((s) => s.failed);
    if (!next) break;
    parts.push(next.title);
    cur = next;
  }
  return parts.filter(Boolean).join(' > ') || null;
}

const EXPECTED = /^\s*Expected(?:\s+[a-z][a-z ]*)?:\s*(.+)$/im;
const RECEIVED = /^\s*Received(?:\s+[a-z][a-z ]*)?:\s*(.+)$/im;

/**
 * Pull "expected vs observed" out of an assertion message. Playwright's
 * matchers use either `Expected: x` / `Received: y` lines or a jest-style diff
 * (`- Expected  - 0` / `+ Received  + 3`); anything else (a timeout, a thrown
 * error) has neither and keeps only its message.
 */
export function describeError(err: NonNullable<RawResult['error']>, rootDir: string | null): UiJourneyError {
  const message = err.message;
  const exp = EXPECTED.exec(message)?.[1]?.trim() ?? null;
  const rec = RECEIVED.exec(message)?.[1]?.trim() ?? null;
  let diff: string | null = null;
  if (exp === null && rec === null && /^[-+] (Expected|Received)\b/m.test(message)) {
    const lines = message.split('\n');
    const start = lines.findIndex((l) => /^- Expected\b/.test(l));
    if (start >= 0) diff = lines.slice(start, start + MAX_DIFF_LINES).join('\n').trimEnd();
  }
  const loc = err.location;
  return {
    message,
    location: loc ? { file: relativeTo(loc.file, rootDir), line: loc.line, column: loc.column } : null,
    snippet: err.snippet,
    expected: exp,
    observed: rec,
    diff,
  };
}

export function relativeTo(file: string, rootDir: string | null): string {
  if (!rootDir) return file;
  const prefix = rootDir.endsWith('/') ? rootDir : `${rootDir}/`;
  return file.startsWith(prefix) ? file.slice(prefix.length) : file;
}

// ---------------------------------------------------------------------------
// error-context.md and the fixture attachments

/**
 * Playwright writes an `error-context.md` next to a failing test: instructions
 * addressed to a model, the error, and (verified on 1.63.0) a YAML accessibility
 * snapshot of the page. The instructions section is dropped: it is text telling
 * a reader what to do, and Orbit's own brief decides that. What remains is
 * evidence and stays untrusted.
 */
export function parseErrorContext(markdown: string): { errorDetails: string | null; pageSnapshot: string | null } {
  const sections = new Map<string, string>();
  let current: string | null = null;
  let buf: string[] = [];
  const flush = (): void => {
    if (current !== null) sections.set(current, buf.join('\n').trim());
    buf = [];
  };
  let inFence = false;
  for (const line of markdown.split('\n')) {
    if (/^```/.test(line)) inFence = !inFence;
    const h = !inFence ? /^#\s+(.+?)\s*$/.exec(line) : null;
    if (h) {
      flush();
      current = h[1]?.toLowerCase() ?? null;
      continue;
    }
    buf.push(line);
  }
  flush();
  const fenced = (s: string | undefined): string | null => {
    if (!s) return null;
    const m = /```[a-z]*\n([\s\S]*?)\n```/.exec(s);
    return cleanText(m?.[1] ?? s, 6_000);
  };
  return { errorDetails: fenced(sections.get('error details')), pageSnapshot: fenced(sections.get('page snapshot')) };
}

const MAX_ENTRIES = 200;

export function parseDiagnostics(body: Buffer): UiDiagnostics | null {
  const j = safeJson(body);
  if (!isObj(j)) return null;
  const list = <T>(v: unknown, pick: (o: Record<string, unknown>) => T | null): T[] =>
    arr(v)
      .slice(0, MAX_ENTRIES)
      .flatMap((e) => {
        const p = isObj(e) ? pick(e) : null;
        return p === null ? [] : [p];
      });
  return {
    consoleErrors: list(j.consoleErrors, (e) => ({ type: str(e.type) ?? 'error', text: cleanText(str(e.text) ?? '', 1_000), url: str(e.url) ?? '', line: num(e.line) })),
    pageErrors: list(j.pageErrors, (e) => ({ name: str(e.name) ?? 'Error', message: cleanText(str(e.message) ?? '', 1_000) })),
    failedRequests: list(j.failedRequests, (e) => ({ url: cleanText(str(e.url) ?? '', 500), method: str(e.method) ?? 'GET', failure: str(e.failure) ?? 'unknown' })),
    badResponses: list(j.badResponses, (e) => ({ url: cleanText(str(e.url) ?? '', 500), method: str(e.method) ?? 'GET', status: num(e.status) })),
    finalUrl: str(j.finalUrl),
    dropped: num(j.dropped),
  };
}

export function parseBrowserInfo(body: Buffer): { name: string; version: string; viewport: { width: number; height: number } | null; project: string | null } | null {
  const j = safeJson(body);
  if (!isObj(j)) return null;
  const vp = isObj(j.viewport) ? j.viewport : null;
  const name = str(j.browserName);
  const version = str(j.browserVersion);
  if (name === null || version === null) return null;
  return {
    name,
    version,
    viewport: vp && typeof vp.width === 'number' && typeof vp.height === 'number' ? { width: vp.width, height: vp.height } : null,
    project: str(j.project),
  };
}

export function parseA11y(body: Buffer): UiA11yScan | null {
  const j = safeJson(body);
  if (!isObj(j)) return null;
  const entry = (e: Record<string, unknown>) => ({
    ruleId: str(e.ruleId) ?? '',
    impact: str(e.impact) ?? '',
    target: cleanText(str(e.target) ?? '', 500),
    url: str(e.url) ?? '',
    viewport: str(e.viewport) ?? '',
    help: cleanText(str(e.help) ?? '', 300),
    fingerprint: str(e.fingerprint) ?? '',
  });
  return {
    url: str(j.url) ?? '',
    viewport: str(j.viewport) ?? '',
    baselinePath: str(j.baselinePath),
    baselineLoaded: j.baselineLoaded === true,
    seriousOrCritical: num(j.seriousOrCritical),
    newViolations: arr(j.newViolations)
      .slice(0, MAX_ENTRIES)
      .flatMap((e) => (isObj(e) ? [entry(e)] : [])),
    baselinedCount: arr(j.baselined).length,
    advisory: j.advisory === true,
  };
}

export function parseKeyboard(body: Buffer): UiKeyboardScan | null {
  const j = safeJson(body);
  if (!isObj(j)) return null;
  const names = (v: unknown): string[] => arr(v).slice(0, MAX_ENTRIES).flatMap((e) => (typeof e === 'string' ? [cleanText(e, 300)] : []));
  const entries = arr(j.entries)
    .slice(0, MAX_ENTRIES)
    .flatMap((e) => {
      if (!isObj(e) || typeof e.selector !== 'string') return [];
      return [{ selector: cleanText(e.selector, 300), reachedAtTab: typeof e.reachedAtTab === 'number' ? e.reachedAtTab : null, focusVisible: typeof e.focusVisible === 'boolean' ? e.focusVisible : null }];
    });
  const unreachable = names(j.unreachable);
  const outOfOrder = names(j.outOfOrder);
  const missingFocusRing = names(j.missingFocusRing);
  return {
    url: str(j.url) ?? '',
    viewport: str(j.viewport) ?? '',
    tabsPressed: num(j.tabsPressed),
    ordered: j.ordered !== false,
    entries,
    unreachable,
    outOfOrder,
    missingFocusRing,
    // Recomputed rather than trusted: a scan that lists problems has not passed whatever its own flag says.
    passed: j.passed === true && unreachable.length === 0 && outOfOrder.length === 0 && missingFocusRing.length === 0,
  };
}

function safeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
}
