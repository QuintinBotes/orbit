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
 *   orbit-keyboard             one per expectKeyboardReachable call: tab
 *                              order, reachability and focus ring per element
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

// These run inside the browser (page.evaluate), where the DOM exists; the repository's
// TypeScript config may not include the DOM lib, so they are declared loosely here.
/* eslint-disable @typescript-eslint/no-explicit-any */
declare const document: any;
declare const window: any;
declare function getComputedStyle(el: any): any;

/** Bump when the attachment shapes below change; the runner checks it. */
export const ORBIT_FIXTURE_VERSION = 2;
export const DIAGNOSTICS_ATTACHMENT = 'orbit-diagnostics';
export const A11Y_ATTACHMENT = 'orbit-a11y';
export const FAILURE_SCREENSHOT_ATTACHMENT = 'orbit-failure-screenshot';
export const KEYBOARD_ATTACHMENT = 'orbit-keyboard';

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
  /**
   * True when ORBIT_A11Y_FAIL_ON=none (ui.accessibility.fail_on_new_serious_or_critical: false):
   * new violations are recorded here but do not fail the test.
   */
  advisory: boolean;
  /** Automated scans find only some problems (spec section 13); said every time, not once in a README. */
  limitation: string;
}

/**
 * Which impacts fail a test. Orbit's runner sets ORBIT_A11Y_FAIL_ON from
 * ui.accessibility.fail_on_new_serious_or_critical: `serious,critical` when
 * true, `none` when false. Unset (the fixture used outside Orbit) means fail.
 */
export function a11yFailsOn(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  const raw = (env.ORBIT_A11Y_FAIL_ON ?? 'serious,critical').trim().toLowerCase();
  return raw !== 'none';
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
    advisory: !a11yFailsOn(),
    limitation: A11Y_LIMITATION,
  };
  await base.info().attach(A11Y_ATTACHMENT, { body: JSON.stringify(attachment), contentType: 'application/json' });

  if (newViolations.length > 0 && attachment.advisory) return;
  if (newViolations.length > 0) {
    const lines = newViolations.map((e) => `  ${e.impact} ${e.ruleId} at ${e.target}: ${e.help}`);
    throw new Error(`${newViolations.length} new serious or critical accessibility violation(s) on ${path} at ${viewport}:\n${lines.join('\n')}`);
  }
}

// ---------------------------------------------------------------------------
// Keyboard navigation

export interface KeyboardEntry {
  selector: string;
  /** 1-based number of the Tab press that first focused a match; null when never reached. */
  reachedAtTab: number | null;
  /** Whether a focus indicator (outline or box-shadow) was visible on the element when focused; null when never reached. */
  focusVisible: boolean | null;
}
export interface KeyboardAttachment {
  version: number;
  url: string;
  viewport: string;
  tabsPressed: number;
  ordered: boolean;
  entries: KeyboardEntry[];
  /** Selectors never focused within the Tab budget. */
  unreachable: string[];
  /** Selectors focused before one that was listed earlier. */
  outOfOrder: string[];
  /** Selectors focused without a visible focus indicator. */
  missingFocusRing: string[];
  passed: boolean;
  limitation: string;
}

export const KEYBOARD_LIMITATION = 'Keyboard checks cover tab order, reachability and a visible focus indicator for the listed elements only; they do not test operation by keyboard, focus traps or screen reader behaviour.';

export interface KeyboardOptions {
  /** Require the selectors to be reached in the order given (default true). */
  ordered?: boolean;
  /** Require a visible focus indicator on each (default true). */
  requireFocusRing?: boolean;
  /** Most Tab presses to try (default 60). */
  maxTabs?: number;
}

interface Focused {
  matches: number[];
  ring: boolean;
  key: string;
  isBody: boolean;
}

/**
 * Presses Tab from the top of the page and checks that every CSS selector in
 * `selectors` receives focus, in the order given, with a visible focus
 * indicator. Call it right after navigation, before clicking anything:
 * sequential focus navigation starts from the last interaction.
 */
export async function expectKeyboardReachable(page: Page, selectors: string[], options: KeyboardOptions = {}): Promise<void> {
  if (selectors.length === 0) throw new Error('expectKeyboardReachable needs at least one selector');
  const ordered = options.ordered ?? true;
  const requireRing = options.requireFocusRing ?? true;
  const maxTabs = Math.min(Math.max(options.maxTabs ?? 60, 1), 300);
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active && active !== document.body && typeof active.blur === 'function') active.blur();
    window.scrollTo(0, 0);
  });

  const entries: KeyboardEntry[] = selectors.map((selector) => ({ selector, reachedAtTab: null, focusVisible: null }));
  const seen = new Set<string>();
  let pressed = 0;
  while (pressed < maxTabs && entries.some((e) => e.reachedAtTab === null)) {
    await page.keyboard.press('Tab');
    pressed += 1;
    const focused = await page.evaluate((sels: string[]): Focused => {
      let el: any = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el === document.documentElement) return { matches: [], ring: false, key: 'body', isBody: true };
      const style = getComputedStyle(el);
      const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0 && style.outlineColor !== 'rgba(0, 0, 0, 0)' && style.outlineColor !== 'transparent';
      const ring = outline || (style.boxShadow !== 'none' && style.boxShadow !== '');
      const matches: number[] = [];
      sels.forEach((s: string, i: number) => {
        try {
          if (el.matches(s)) matches.push(i);
        } catch {
          /* invalid selector: reported as unreachable */
        }
      });
      const index = Array.prototype.indexOf.call(document.querySelectorAll(el.tagName), el);
      return { matches, ring, key: `${el.tagName}#${el.id}:${index}`, isBody: false };
    }, selectors);
    if (focused.isBody) {
      // Focus left the page content: every focusable element has been visited.
      if (seen.size > 0) break;
      continue;
    }
    if (seen.has(focused.key)) break;
    seen.add(focused.key);
    for (const i of focused.matches) {
      const entry = entries[i];
      if (entry && entry.reachedAtTab === null) {
        entry.reachedAtTab = pressed;
        entry.focusVisible = focused.ring;
      }
    }
  }

  const unreachable = entries.filter((e) => e.reachedAtTab === null).map((e) => e.selector);
  const outOfOrder: string[] = [];
  if (ordered) {
    let last = 0;
    for (const e of entries) {
      if (e.reachedAtTab === null) continue;
      if (e.reachedAtTab < last) outOfOrder.push(e.selector);
      else last = e.reachedAtTab;
    }
  }
  const missingFocusRing = requireRing ? entries.filter((e) => e.reachedAtTab !== null && e.focusVisible === false).map((e) => e.selector) : [];
  const size = page.viewportSize();
  const attachment: KeyboardAttachment = {
    version: ORBIT_FIXTURE_VERSION,
    url: new URL(page.url()).pathname,
    viewport: size ? `${size.width}x${size.height}` : 'unknown',
    tabsPressed: pressed,
    ordered,
    entries,
    unreachable,
    outOfOrder,
    missingFocusRing,
    passed: unreachable.length === 0 && outOfOrder.length === 0 && missingFocusRing.length === 0,
    limitation: KEYBOARD_LIMITATION,
  };
  await base.info().attach(KEYBOARD_ATTACHMENT, { body: JSON.stringify(attachment), contentType: 'application/json' });

  if (!attachment.passed) {
    const lines = [
      ...unreachable.map((s) => `  not reachable by Tab within ${pressed} presses: ${s}`),
      ...outOfOrder.map((s) => `  focused before an element listed earlier: ${s}`),
      ...missingFocusRing.map((s) => `  no visible focus indicator: ${s}`),
    ];
    throw new Error(`keyboard navigation problems on ${attachment.url} at ${attachment.viewport}:\n${lines.join('\n')}`);
  }
}
