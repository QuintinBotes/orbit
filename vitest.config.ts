import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration and fault-injection tests spawn real processes, git repos and
    // SQLite files; they share nothing, but they are heavy, so cap the pool.
    maxWorkers: 4,
    testTimeout: 60_000,
    // Times in expected output are written in UTC; a test that is about local time sets its own zone.
    // ORBIT_NOTIFICATIONS=off: no test run pops a desktop notification or posts anywhere; notification tests inject fakes.
    env: { TZ: 'UTC', ORBIT_NOTIFICATIONS: 'off' },
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // Only files that hold types and no runtime code: they have nothing to execute.
      exclude: ['src/contract/amendment-types.ts', 'src/contract/types.ts', 'src/evidence/types.ts', 'src/isolation/types.ts'],
      reporter: ['text-summary', 'json-summary'],
      reportOnFailure: true,
      thresholds: { lines: 95, functions: 95, statements: 95, branches: 90 },
    },
  },
});
