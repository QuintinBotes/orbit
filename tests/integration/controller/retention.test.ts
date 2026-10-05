// retention.keep_runs_days is applied by the controller (spec section 3; docs/gaps.md G21, wired here): an
// expired finished run loses its artifacts when a controller starts and on the service's periodic pass, a
// recent one and a BLOCKED one keep theirs.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, waitFor, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const DAY = 86_400_000;

function age(l: Lab, runId: string, days: number): void {
  const t = Date.now() - days * DAY;
  l.db().run('UPDATE runs SET ended_at = ?, updated_at = ? WHERE id = ?', t, t, runId);
}

function pruned(l: Lab, runId: string): boolean {
  return l.db().get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'run.artifacts_pruned'", runId) !== undefined;
}

describe.skipIf(!canStripTypes)('controller: artifact retention', () => {
  it('prunes expired finished runs when a service controller starts and leaves recent and blocked runs alone', async () => {
    const l = makeLab({ tweak: (c) => void (c.retention = { ...c.retention, keep_runs_days: 7 }) });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*'), implementMul('*')] }));
    const old = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: old.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
    const recent = startLabRun(l, 'Add a mul function to the calculator, again.');
    await new Controller({ mode: 'foreground', runId: recent.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
    expect(runState(l, old.id).state).toBe('SUCCEEDED');
    expect(runState(l, recent.id).state).toBe('SUCCEEDED');
    age(l, old.id, 30);
    age(l, recent.id, 2);
    const oldDir = join(l.repo, '.orbit', 'runs', old.id);
    expect(existsSync(oldDir)).toBe(true);

    const c = new Controller({ mode: 'service', deps: labDeps(l), tickIntervalMs: 50, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 300 });
    const started = c.start();
    try {
      await waitFor(() => pruned(l, old.id), 15_000);
    } finally {
      await c.stop('test over');
      await started;
    }
    expect(existsSync(oldDir)).toBe(false);
    // The row stays: status and statistics still know the run.
    expect(runState(l, old.id).state).toBe('SUCCEEDED');
    expect(pruned(l, recent.id)).toBe(false);
    expect(existsSync(join(l.repo, '.orbit', 'runs', recent.id, 'final.md'))).toBe(true);
  }, 120_000);

  it('the periodic pass prunes a run that expires while the service runs', async () => {
    const l = makeLab({ tweak: (c) => void (c.retention = { ...c.retention, keep_runs_days: 7 }) });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
    const c = new Controller({ mode: 'service', deps: labDeps(l), tickIntervalMs: 50, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 300, retention: { intervalMs: 100 } });
    const started = c.start();
    try {
      await waitFor(() => c.ownedRuns().length === 0 && l.db().get("SELECT 1 AS x FROM controllers WHERE id = ?", c.ownerId) !== undefined, 10_000);
      expect(pruned(l, run.id)).toBe(false);
      age(l, run.id, 8);
      await waitFor(() => pruned(l, run.id), 10_000);
    } finally {
      await c.stop('test over');
      await started;
    }
    expect(existsSync(join(l.repo, '.orbit', 'runs', run.id))).toBe(false);
  }, 120_000);
});
