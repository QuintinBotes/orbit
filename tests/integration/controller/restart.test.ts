import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { systemClock } from '../../../src/core/clock.ts';
import { requestCancel } from '../../../src/controller/run-store.ts';
import { isTerminal } from '../../../src/controller/states.ts';
import { listCheckRuns } from '../../../src/evidence/store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { alive, argvCalls, baseScenario, implementMul, makeLab, runState, spawnController, startLabRun, waitFor, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const l of labs.splice(0)) l.close();
});

function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

function controller(l: Lab, opts: Parameters<typeof spawnController>[1]) {
  const c = spawnController(l, opts);
  children.push(c);
  return c;
}

function exited(c: ChildProcess): Promise<void> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
  return new Promise((r) => c.once('exit', () => r()));
}

function events(l: Lab, runId: string, type: string): { id: number; data_json: string | null; to_state: string | null }[] {
  return l.db().all('SELECT id, data_json, to_state FROM events WHERE run_id = ? AND type = ? ORDER BY id', runId, type);
}

describe.skipIf(!canStripTypes)('controller restarts (real controller processes)', () => {
  it('scenario 7: a controller killed mid-implementation is replaced by one that reattaches instead of spawning a duplicate', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), sleepMs: 5_000 }] }));
    const run = startLabRun(l);
    const a = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    const impl = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((w) => w.state === 'RUNNING' && w.pid !== null), 60_000);
    a.kill('SIGKILL');
    await exited(a);
    // The worker is detached in its own process group: it outlives the controller.
    expect(alive(impl.pid!)).toBe(true);

    const b = controller(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 1_500 });
    await waitFor(() => isTerminal(runState(l, run.id).state), 90_000);
    await exited(b);

    const done = runState(l, run.id);
    expect(done.state, `${done.outcomeReason}\n${b.output().slice(-2000)}`).toBe('SUCCEEDED');
    const implementers = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(implementers.map((w) => w.id)).toEqual([impl.id]);
    expect(implementers[0]!.restartCount).toBe(0);
    expect(argvCalls(l).filter((c) => c.role === 'implementer')).toHaveLength(1);
    // The new owner took the expired lease, recorded the crash, recovered and resumed implementation.
    expect(events(l, run.id, 'lease.takeover').length).toBeGreaterThanOrEqual(1);
    expect(events(l, run.id, 'state.transition').map((e) => e.to_state)).toEqual(expect.arrayContaining(['RECOVERING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING', 'SUCCEEDED']));
  });

  it('scenario 20: cancellation during checks is honoured, and still holds after a controller restart', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/slow.flag', content: '1\n' }])] }));
    const run = startLabRun(l);
    const a = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    const check = await waitFor(() => listCheckRuns(l.db(), { runId: run.id }).find((r) => r.candidateId !== null && r.status === 'RUNNING' && r.pid !== null), 60_000);
    requestCancel(l.db(), run.id, 'test', systemClock);
    await waitFor(() => runState(l, run.id).state === 'CANCELLED', 30_000);
    await waitFor(() => !alive(check.pid!), 15_000);
    expect(listCheckRuns(l.db(), { runId: run.id, checkId: 'unit' }).filter((r) => r.candidateId !== null).at(-1)?.status).toBe('CANCELLED');
    a.kill('SIGTERM');
    await exited(a);

    // A new controller finds nothing to do: no new worker, no new check, no state change.
    const workersBefore = listWorkers(l.db(), { runId: run.id }).length;
    const checksBefore = listCheckRuns(l.db(), { runId: run.id }).length;
    const b = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    await new Promise((r) => setTimeout(r, 2_500));
    b.kill('SIGTERM');
    await exited(b);
    expect(runState(l, run.id).state).toBe('CANCELLED');
    expect(listWorkers(l.db(), { runId: run.id })).toHaveLength(workersBefore);
    expect(listCheckRuns(l.db(), { runId: run.id })).toHaveLength(checksBefore);
  });

  it('scenario 20: a cancellation recorded while the controller dies is carried out by the next one', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/slow.flag', content: '1\n' }])] }));
    const run = startLabRun(l);
    const a = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    const check = await waitFor(() => listCheckRuns(l.db(), { runId: run.id }).find((r) => r.candidateId !== null && r.status === 'RUNNING' && r.pid !== null), 60_000);
    a.kill('SIGKILL');
    await exited(a);
    requestCancel(l.db(), run.id, 'test', systemClock);
    // The check outlived its controller; only the next controller can stop it.
    expect(alive(check.pid!)).toBe(true);

    const b = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    await waitFor(() => runState(l, run.id).state === 'CANCELLED', 30_000);
    await waitFor(() => !alive(check.pid!), 15_000);
    b.kill('SIGTERM');
    await exited(b);
    const done = runState(l, run.id);
    expect(done.state).toBe('CANCELLED');
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    expect(events(l, run.id, 'state.transition').map((e) => e.to_state)).not.toContain('REVIEWING');
  });
});
