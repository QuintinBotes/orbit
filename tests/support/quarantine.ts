/**
 * Quarantined tests: a test that fails now and then for a cause nobody has established yet, with an open issue that
 * says what was seen and what takes it out again. Such a test is skipped by default, so it cannot fail a run it has
 * nothing to do with, and runs with ORBIT_RUN_QUARANTINED=1. Use `it.skipIf(QUARANTINED)` with a comment naming the issue.
 * A quarantined test must still run on every change, so quarantine does not become deletion: add a `quarantined` job
 * to .github/workflows/ci.yml that runs its file with ORBIT_RUN_QUARANTINED=1 and `continue-on-error: true` (the job
 * was removed when #61, #185 and #186 left quarantine; `git log -S "quarantined:" -- .github/workflows/ci.yml` finds it).
 */
export const QUARANTINED = process.env.ORBIT_RUN_QUARANTINED !== '1';
