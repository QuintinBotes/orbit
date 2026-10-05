import { defineConfig } from '@playwright/test';

// Orbit's runner adds --reporter, --output, --trace and --update-snapshots=none
// on the command line; the rest of the contract lives here.
export default defineConfig({
  testDir: './journeys',
  fullyParallel: false,
  workers: 2,
  retries: 0,
  timeout: 20_000,
  expect: { timeout: 5_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01 } },
  // The platform is part of the path: renderings differ between operating systems.
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{platform}/{testFilePath}/{arg}{ext}',
  use: {
    baseURL: process.env.ORBIT_UI_BASE_URL ?? 'http://127.0.0.1:4173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
