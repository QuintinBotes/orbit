import { defineConfig } from '@playwright/test';

const port = process.env.PORT ?? '4310';

// Orbit's runner adds --reporter, --output, --trace and --update-snapshots=none on
// the command line; the rest of the contract lives here.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  // The same output everywhere: Playwright's default switches to "dot" when CI is set, which hides the project names.
  reporter: 'list',
  timeout: 20_000,
  expect: { timeout: 5_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  // The platform is part of the path: renderings differ between operating systems.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{platform}/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: process.env.ORBIT_UI_BASE_URL ?? `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // Locally, `npx playwright test` starts the app itself. Under Orbit the runner starts it
  // (ui.environment.start_command) and sets ORBIT_UI_RUN, so this block stays out of the way.
  ...(process.env.ORBIT_UI_RUN
    ? {}
    : { webServer: { command: 'node src/main.ts', url: `http://127.0.0.1:${port}/reports`, reuseExistingServer: true, env: { PORT: port } } }),
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
