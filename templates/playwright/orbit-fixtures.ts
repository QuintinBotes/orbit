/**
 * Playwright fixtures for journeys that Orbit runs (spec section 13).
 *
 * Import `test` and `expect` from this file instead of '@playwright/test'.
 * Every test then records, as attachments Orbit's UI runner reads back:
 *   orbit-diagnostics          console errors, page errors, failed requests,
 *                              HTTP 4xx/5xx responses, browser and viewport
 *   orbit-failure-screenshot   a full-page screenshot when the test fails, so
 *                              a repository whose config forgot
 *                              `screenshot: 'only-on-failure'` still gets one
 *   orbit-a11y                 one per expectNoSeriousA11yViolations call
 *
 * Requires @playwright/test and @axe-core/playwright in the repository.
 * The file is a template: copy it into the repository's journeys directory;
 * Orbit never loads it from its own install, because journeys are repository
 * code and a repository must keep working without Orbit.
 */
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export { expect };

/** Bump when the attachment shapes below change; the runner checks it. */
export const ORBIT_FIXTURE_VERSION = 1;
export const DIAGNOSTICS_ATTACHMENT = 'orbit-diagnostics';
export const A11Y_ATTACHMENT = 'orbit-a11y';
export const FAILURE_SCREENSHOT_ATTACHMENT = 'orbit-failure-screenshot';

// Bounds keep a chatty page from producing megabytes of attachment and keep
// any one message from carrying a whole stack dump into a model prompt.
const MAX_ENTRIES = 200;
const MAX_TEXT = 2_000;

export interface ConsoleEntry {
  type: string;
  text: string;
  url: string;
  line: number;
}
export interface PageErrorEntry {
  name: string;
  message: string;
}
export interface FailedRequestEntry {
  url: string;
  method: string;
  failure: string;
}
export interface BadResponseEntry {
  url: string;
  method: string;
  status: number;
}

export interface OrbitDiagnostics {
  version: number;
  project: string;
  browserName: string;
  browserVersion: string;
  viewport: { width: number; height: number } | null;
  finalUrl: string | null;
  consoleErrors: ConsoleEntry[];
  pageErrors: PageErrorEntry[];
  failedRequests: FailedRequestEntry[];
  badResponses: BadResponseEntry[];
  /** Entries dropped by the bounds above, so truncation is visible. */
  dropped: number;
}

const clip = (text: string): string => (text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...[truncated]` : text);

function watch(context: BrowserContext, diag: OrbitDiagnostics): void {
  const push = <T>(list: T[], entry: T): void => {
    if (list.length >= MAX_ENTRIES) diag.dropped += 1;
    else list.push(entry);
  };
  context.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const loc = msg.location();
    push(diag.consoleErrors, { type: msg.type(), text: clip(msg.text()), url: loc.url, line: loc.lineNumber });
  });
  context.on('weberror', (err) => {
    const e = err.error();
    push(diag.pageErrors, { name: e.name, message: clip(e.message) });
  });
  context.on('requestfailed', (req) => {
    push(diag.failedRequests, { url: req.url(), method: req.method(), failure: req.failure()?.errorText ?? 'unknown' });
  });
  context.on('response', (res) => {
    if (res.status() >= 400) push(diag.badResponses, { url: res.url(), method: res.request().method(), status: res.status() });
  });
}

export const test = base.extend<{ orbitDiagnostics: OrbitDiagnostics }>({
  orbitDiagnostics: [
    async ({ page, context, browser }, use, testInfo) => {
      const diag: OrbitDiagnostics = {
        version: ORBIT_FIXTURE_VERSION,
        project: testInfo.project.name,
        browserName: browser.browserType().name(),
        browserVersion: browser.version(),
        viewport: null,
        finalUrl: null,
        consoleErrors: [],
        pageErrors: [],
        failedRequests: [],
        badResponses: [],
        dropped: 0,
      };
      watch(context, diag);
      await use(diag);

      // Teardown runs for failed, timed-out and interrupted tests too, which is
      // exactly when the evidence matters. Nothing below may throw: a broken
      // attachment must not replace the real failure.
      try {
        diag.viewport = page.viewportSize();
        diag.finalUrl = page.isClosed() ? null : page.url();
      } catch {
        /* page already gone */
      }
      if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
        try {
          const path = testInfo.outputPath('orbit-failure.png');
          await page.screenshot({ path, fullPage: true, timeout: 5_000 });
          await testInfo.attach(FAILURE_SCREENSHOT_ATTACHMENT, { path, contentType: 'image/png' });
        } catch {
          /* page crashed or hung; the trace still exists */
        }
      }
      await testInfo.attach(DIAGNOSTICS_ATTACHMENT, { body: JSON.stringify(diag), contentType: 'application/json' });
    },
    { auto: true },
  ],
});

// ---------------------------------------------------------------------------
// Accessibility

export const A11Y_BASELINE_VERSION = 1;
export type Impact = 'serious' | 'critical';

export interface A11yEntry {
  fingerprint: string;
  ruleId: string;
  impact: Impact;
  target: string;
  url: string;
  viewport: string;
  help: string;
}
export interface A11yBaseline {
  version: number;
  entries: A11yEntry[];
}
export interface A11yAttachment {
  version: number;
  url: string;
  viewport: string;
  baselinePath: string | null;
  baselineLoaded: boolean;
  seriousOrCritical: number;
  newViolations: A11yEntry[];
  baselined: A11yEntry[];
  /** Automated scans find only some problems (spec section 13); said every time, not once in a README. */
  limitation: string;
}

export const A11Y_LIMITATION = 'Automated axe-core scans cover only part of WCAG; a pass is not a claim of accessibility.';

/** rule + target + page path + viewport: stable across runs, specific to one element on one page at one size. */
export function a11yFingerprint(ruleId: string, target: string, url: string, viewport: string): string {
  return createHash('sha256').update([ruleId, target, url, viewport].join('\u0000')).digest('hex').slice(0, 24);
}

function readBaseline(path: string): A11yBaseline | null {
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) throw new Error(`accessibility baseline ${path} has no entries array`);
  return { version: A11Y_BASELINE_VERSION, entries: entries as A11yEntry[] };
}

export interface A11yOptions {
  /**
   * Recorded violations that already existed. When set, only violations not in
   * the file fail. A missing file means an empty baseline: everything fails.
   */
  baselinePath?: string;
  include?: string[];
  exclude?: string[];
  /** axe tags such as 'wcag2a'; default is every non-experimental rule. */
  tags?: string[];
}

/**
 * Fails when the page has a serious or critical axe violation that is not in
 * the baseline. Orbit never records a baseline: recording is a human decision
 * made by running the suite with ORBIT_A11Y_RECORD_BASELINE=1, and that mode
 * is refused when ORBIT_UI_RUN is set, which Orbit's runner always sets.
 */
export async function expectNoSeriousA11yViolations(page: Page, options: A11yOptions = {}): Promise<void> {
  let builder = new AxeBuilder({ page });
  for (const sel of options.include ?? []) builder = builder.include(sel);
  for (const sel of options.exclude ?? []) builder = builder.exclude(sel);
  if (options.tags) builder = builder.withTags(options.tags);
  const results = await builder.analyze();

  const size = page.viewportSize();
  const viewport = size ? `${size.width}x${size.height}` : 'unknown';
  const path = new URL(page.url()).pathname;
  const found: A11yEntry[] = [];
  for (const v of results.violations) {
    if (v.impact !== 'serious' && v.impact !== 'critical') continue;
    for (const node of v.nodes) {
      const target = JSON.stringify(node.target);
      found.push({ fingerprint: a11yFingerprint(v.id, target, path, viewport), ruleId: v.id, impact: v.impact, target, url: path, viewport, help: v.help });
    }
  }

  const baselinePath = options.baselinePath ?? null;
  if (process.env.ORBIT_A11Y_RECORD_BASELINE === '1') {
    if (process.env.ORBIT_UI_RUN) throw new Error('refusing to record an accessibility baseline inside an Orbit run');
    if (!baselinePath) throw new Error('ORBIT_A11Y_RECORD_BASELINE=1 needs a baselinePath');
    const existing = readBaseline(baselinePath)?.entries ?? [];
    const known = new Set(existing.map((e) => e.fingerprint));
    const merged = [...existing, ...found.filter((e) => !known.has(e.fingerprint))];
    mkdirSync(dirname(baselinePath), { recursive: true });
    writeFileSync(baselinePath, `${JSON.stringify({ version: A11Y_BASELINE_VERSION, entries: merged }, null, 2)}\n`);
    return;
  }

  const baseline = baselinePath ? readBaseline(baselinePath) : null;
  const known = new Set((baseline?.entries ?? []).map((e) => e.fingerprint));
  const newViolations = found.filter((e) => !known.has(e.fingerprint));
  const attachment: A11yAttachment = {
    version: ORBIT_FIXTURE_VERSION,
    url: path,
    viewport,
    baselinePath,
    baselineLoaded: baseline !== null,
    seriousOrCritical: found.length,
    newViolations,
    baselined: found.filter((e) => known.has(e.fingerprint)),
    limitation: A11Y_LIMITATION,
  };
  await base.info().attach(A11Y_ATTACHMENT, { body: JSON.stringify(attachment), contentType: 'application/json' });

  if (newViolations.length > 0) {
    const lines = newViolations.map((e) => `  ${e.impact} ${e.ruleId} at ${e.target}: ${e.help}`);
    throw new Error(`${newViolations.length} new serious or critical accessibility violation(s) on ${path} at ${viewport}:\n${lines.join('\n')}`);
  }
}
