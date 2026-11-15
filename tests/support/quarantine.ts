/**
 * Quarantined tests: a test that fails now and then for a cause nobody has established yet, with an open issue that
 * says what was seen and what takes it out again. Such a test is skipped by default, so it cannot fail a run it has
 * nothing to do with, and runs with ORBIT_RUN_QUARANTINED=1. Use `it.skipIf(QUARANTINED)` with a comment naming the issue.
 */
export const QUARANTINED = process.env.ORBIT_RUN_QUARANTINED !== '1';
