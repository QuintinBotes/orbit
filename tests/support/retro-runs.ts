/**
 * Runs for the `orbit retro` tests that drive the real CLI: written through the real run store into a repository's state
 * database, as a controller ends them, so the failure class, the outcome and the transitions are the ones Orbit records.
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../src/core/clock.ts';
import { defaultConfig } from '../../src/policy/config.ts';
import { startRun, stateDbPath } from '../../src/controller/start.ts';
import { acquireLease, releaseLease, transition } from '../../src/controller/run-store.ts';
import type { RunState } from '../../src/controller/states.ts';
import { openDb } from '../../src/storage/db.ts';

/** The markers of a run held at a gate nobody could open: open questions and the criteria they block. */
export const DEADLOCK_OUTCOME = { questions: [{ id: 'q1' }], blocked_criteria: ['AC-1'] };

export interface SeedRun {
  id: string;
  state: RunState;
  /** The structured outcome the controller stored; null for a run that stored none. */
  outcome: Record<string, unknown> | null;
  goal?: string;
  reason?: string;
}

/** Writes the runs to `repo`'s state database and closes it, so a child process can open it next. */
export function seedRuns(repo: string, runs: readonly SeedRun[]): void {
  mkdirSync(join(repo, '.orbit'), { recursive: true });
  const db = openDb(stateDbPath(repo));
  try {
    for (const r of runs) {
      startRun({ db, repoRoot: repo, goal: r.goal ?? 'Add a mul function to the calculator.', config: defaultConfig('autonomous'), clock: systemClock, runId: r.id });
      acquireLease(db, r.id, 'test-controller', 60_000, systemClock);
      try {
        const path: RunState[] = ['PREFLIGHT', 'CONTRACTING', 'PLANNING', ...(r.state === 'SUCCEEDED' ? (['IMPLEMENTING', 'VERIFYING', 'REVIEWING'] as RunState[]) : [])];
        for (const to of path) transition(db, { runId: r.id, to, ownerId: 'test-controller', reason: 'test' }, systemClock);
        const reason = r.reason ?? 'ended';
        transition(db, { runId: r.id, to: r.state, ownerId: 'test-controller', reason, ...(r.outcome ? { patch: { outcomeReason: reason, outcomeJson: JSON.stringify(r.outcome) } } : {}) }, systemClock);
      } finally {
        releaseLease(db, r.id, 'test-controller');
      }
    }
  } finally {
    db.close();
  }
}

/** A stand-in `gh` in `dir` that records every call (one argument per line) to `log` and answers with an issue URL, or fails. */
export function writeFakeGh(dir: string, log: string, opts: { fail?: string } = {}): void {
  const path = join(dir, 'gh');
  const body = opts.fail ? `printf '%s\\n' ${JSON.stringify(opts.fail)} >&2\nexit 1\n` : 'echo https://github.com/QuintinBotes/orbit/issues/4242\n';
  writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\n${body}`);
  chmodSync(path, 0o755);
}
