import { describe, expect, it } from 'vitest';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { learnFromRun } from '../../../src/knowledge/learn.ts';
import type { CuratorTask } from '../../../src/knowledge/curate.ts';
import { openStore } from './helpers.ts';

function runWithRepair(db: OrbitDb, runId: string) {
  const clock = new ManualClock();
  createRun(db, { id: runId, repoRoot: '/work/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  for (const seq of [1, 2]) {
    db.run(
      "INSERT INTO candidates (id, run_id, seq, attempt, commit_sha, tree_hash, parent_sha, status, created_at) VALUES (?, ?, ?, ?, 'c', 't', 'b', 'verified', ?)",
      `${runId}-c${seq}`,
      runId,
      seq,
      seq,
      seq,
    );
    db.run(
      "INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, log_path, fingerprint, started_at) VALUES (?, ?, ?, 'unit', 'command', 't', 'c', 'p', '[]', '.', 'none', ?, ?, ?, ?)",
      `${runId}-k${seq}`,
      runId,
      `${runId}-c${seq}`,
      seq === 1 ? 'FAILED' : 'PASSED',
      `evidence/${seq}/unit.log`,
      seq === 1 ? 'fp-midnight' : null,
      seq,
    );
  }
}

function curatorFor(runId: string) {
  return async (task: CuratorTask) => {
    expect(task.prompt).toContain(`"run_id": "${runId}"`);
    return {
      lessons: [
        {
          schema: 'orbit.lesson/1',
          kind: 'repair-recipe',
          statement: 'Pin the clock in tests that format dates near midnight.',
          rationale: 'The unit failure appeared only near midnight.',
          applicability: { languages: [], frameworks: [], paths: [], check_ids: ['unit'], fingerprints: ['fp-midnight'], roles: [], keywords: ['dates'] },
          verification: 'The date tests pass with the clock set just before midnight.',
          evidence: [{ run_id: runId, artifact: 'evidence/1/unit.log', relation: 'supports' }],
          provenance: { source: 'run', uri: null, derived_from: [], generated_by: 'x', generated_at: '2026-10-03T00:00:00.000Z' },
          confidence: 'low',
          code_free: true,
          supersedes: null,
        },
      ],
      discarded: [],
    };
  };
}

describe('learnFromRun', () => {
  it('extracts, curates, stores and validates a lesson seen in two runs', async () => {
    const db = openDb(':memory:');
    runWithRepair(db, 'r1');
    runWithRepair(db, 'r2');
    const { store, clock } = openStore();
    const first = await learnFromRun({ store, runDb: db, runId: 'r1', runDir: '/x/r1', clock, curatorModel: 'model-x', runCurator: curatorFor('r1') });
    expect(first).toMatchObject({ observations: 1, skipped: null, merged: [], changes: [] });
    expect(first.created).toHaveLength(1);
    const id = first.created[0]!;
    expect(store.getLesson(id)!.status).toBe('candidate');

    const second = await learnFromRun({ store, runDb: db, runId: 'r2', runDir: '/x/r2', clock, curatorModel: 'model-x', runCurator: curatorFor('r2') });
    expect(second.merged).toEqual([id]);
    expect(second.changes).toEqual([{ lessonId: id, from: 'candidate', to: 'validated', rule: 'promote.supported-by-distinct-runs' }]);
    expect(store.getLesson(id)!.provenance.generated_by).toBe('model-x');
  });

  it('does not call the curator when there is nothing verified to learn from', async () => {
    const db = openDb(':memory:');
    createRun(db, { id: 'r1', repoRoot: '/work/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, new ManualClock());
    const { store, clock } = openStore();
    let called = false;
    const report = await learnFromRun({
      store,
      runDb: db,
      runId: 'r1',
      runDir: '/x',
      clock,
      curatorModel: 'm',
      runCurator: async () => {
        called = true;
        return { lessons: [], discarded: [] };
      },
    });
    expect(report.skipped).toBe('no observations');
    expect(called).toBe(false);
  });
});
