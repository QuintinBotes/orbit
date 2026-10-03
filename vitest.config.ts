import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Integration and fault-injection tests spawn real processes, git repos and
    // SQLite files; they share nothing, but they are heavy, so cap the pool.
    maxWorkers: 4,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
