import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { Controller } from '../../../src/controller/loop.ts';
import { getLease, getRun } from '../../../src/controller/run-store.ts';
import { isTerminal } from '../../../src/controller/states.ts';
import { listControllers } from '../../../src/storage/controllers.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { killGroup } from '../../../src/core/proc.ts';
import { alive, baseScenario, implementMul, labDeps, makeLab, runState, spawnController, startLabRun, waitFor, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
const children: ChildProcess[] = [];
const groups: number[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const g of groups.splice(0)) killGroup(g, 'SIGKILL');
  for (const l of labs.splice(0)) l.close();
});

function exited(c: ChildProcess): Promise<number | null> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve(c.exitCode);
  return new Promise((r) => c.once('exit', (code) => r(code)));
}

describe.skipIf(!canStripTypes)('controller loop', () => {
  it('shuts down gracefully on SIGTERM: leases released, stop recorded, the worker left running for the next controller', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), sleepMs: 3_000 }] }));
    const run = startLabRun(l);
    const a = spawnController(l, { mode: 'service', leaseTtlMs: 10_000 });
    children.push(a);
    const impl = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((w) => w.state === 'RUNNING' && w.pid !== null), 60_000);
    a.kill('SIGTERM');
    expect(await exited(a)).toBe(0);
    expect(getLease(l.db(), run.id)).toBeNull();
    const stopped = listControllers(l.db(), { includeStopped: true }).find((c) => c.stoppedAt !== null);
    expect(stopped?.stopReason).toBe('received SIGTERM');
    expect(alive(impl.pid!)).toBe(true);

    // A released lease is not a crash: the next controller resumes without RECOVERING and reattaches.
    const b = spawnController(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 10_000 });
    children.push(b);
    await waitFor(() => isTerminal(runState(l, run.id).state), 90_000);
    await exited(b);
    expect(runState(l, run.id).state).toBe('SUCCEEDED');
    const toStates = l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition'", run.id).map((r) => r.to_state);
    expect(toStates).not.toContain('RECOVERING');
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(1);
  });

  it('stops working on a run the moment its lease cannot be renewed', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), sleepMs: 2_000 }] }));
    const run = startLabRun(l);
    const c = new Controller({ mode: 'service', deps: labDeps(l), leaseTtlMs: 5_000, leaseRenewMs: 100, tickIntervalMs: 50, graceMs: 300 });
    const started = c.start();
    const impl = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((w) => w.state === 'RUNNING' && w.pgid !== null), 60_000);
    groups.push(impl.pgid!);
    // Another controller now holds the run.
    l.db().run('UPDATE leases SET owner_id = ?, expires_at = ? WHERE run_id = ?', 'other-controller', Date.now() + 3_600_000, run.id);
    await waitFor(() => c.ownedRuns().length === 0, 5_000);
    await new Promise((r) => setTimeout(r, 3_000));
    // The worker finished, but this controller no longer acts on the run.
    expect(getRun(l.db(), run.id).state).toBe('IMPLEMENTING');
    expect(l.db().get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'lease.lost'", run.id)?.n).toBeGreaterThanOrEqual(1);
    await c.stop('test over');
    await started;
    expect(getLease(l.db(), run.id)?.ownerId).toBe('other-controller');
  });
});
