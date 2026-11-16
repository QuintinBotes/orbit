import { ORBIT_ROOT, run } from '../../scripts/demo/lib/example.ts';

/**
 * Why Chromium cannot start here, or null when it can: one Playwright launch per test file, as the srt tests probe srt.
 * In a command check's sandbox on macOS it cannot: Playwright finds no browser under the check's private home, and Orbit
 * gives Chromium's Mach services to UI journey runs only (#203).
 */
export const CHROMIUM_REFUSED: string | null = (() => {
  const script = "require('@playwright/test').chromium.launch().then((b) => b.close()).then(() => process.exit(0), (e) => { console.error(String(e && e.message).split('\\n')[0]); process.exit(1); })";
  const r = run(ORBIT_ROOT, process.execPath, ['-e', script], { timeoutMs: 60_000 });
  return r.ok ? null : `Chromium cannot start here (${r.out.trim().split('\n')[0] || 'its launch failed'}), as in a command check's sandbox on macOS`;
})();

/** Skip the current test, saying why, where Chromium cannot start: `beforeEach(skipWithoutChromium)`, or a test's first line. */
export function skipWithoutChromium(ctx: { skip(condition: boolean, note?: string): void }): void {
  ctx.skip(CHROMIUM_REFUSED !== null, CHROMIUM_REFUSED ?? undefined);
}
