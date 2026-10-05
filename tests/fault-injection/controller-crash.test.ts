// Fault: kill the controller mid-transition (spec section 17; section 6 invariants "one owner
// lease per run", "every transition has a durable event"). The controller runs in its own process
// with ORBIT_FAULTS so it exits 137 at the instrumented point, as SIGKILL would; a fresh controller
// then takes the expired lease over and finishes the run.
import { afterEach, describe, expect, it } from 'vitest';
import { isTerminal } from '../../src/controller/states.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { baseScenario, calls, canStripTypes, events, exited, implementMul, runState, spawnFaultyController, startLabRun, tracker, transitions, waitFor, writeScenario, type Lab } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

function ownerOf(out: string): string {
  const m = /controller (\S+) pid/.exec(out);
  if (!m) throw new Error(`no owner id in controller output: ${out.slice(0, 500)}`);
  return m[1]!;
}

async function finish(l: Lab, runId: string): Promise<void> {
  const c = t.child(spawnFaultyController(l, { mode: 'foreground', runId, leaseTtlMs: 1_000 }));
  await waitFor(() => isTerminal(runState(l, runId).state), 60_000);
  await exited(c);
  const done = runState(l, runId);
  expect(done.state, `${done.outcomeReason}\n${c.output().slice(-1500)}`).toBe('SUCCEEDED');
}

function expectExactlyOnce(l: Lab, runId: string): void {
  // Every transition event matches the state the run was in: no transition was applied twice or lost.
  const rows = events(l, runId, 'state.transition');
  for (let i = 1; i < rows.length; i++) expect(rows[i]!.from_state).toBe(rows[i - 1]!.to_state);
  expect(rows.at(-1)!.to_state).toBe(runState(l, runId).state);
}

describe.skipIf(!canStripTypes)('fault: controller killed mid-transition', () => {
  it('a crash right after a transition commits: the transition is not repeated, and the next controller takes the lease over', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_000, faults: 'controller.transition.after-commit=crash' }));
    const { code } = await exited(a);
    expect(code, a.output()).toBe(137);
    expect(a.output()).toContain('fault injected at controller.transition.after-commit');
    // The committed transition is durable with its event.
    expect(transitions(l, run.id)).toEqual(['CREATED>PREFLIGHT']);

    await finish(l, run.id);
    expectExactlyOnce(l, run.id);
    const seq = transitions(l, run.id);
    expect(seq.length).toBe(new Set(seq).size);
    expect(transitions(l, run.id).filter((x) => x.endsWith('>PREFLIGHT'))[0]).toBe('CREATED>PREFLIGHT');
    const takeover = events(l, run.id, 'lease.takeover');
    expect(takeover).toHaveLength(1);
    expect(JSON.parse(takeover[0]!.data_json!)).toMatchObject({ previous_owner: ownerOf(a.output()) });
    expect(transitions(l, run.id)).toEqual(expect.arrayContaining(['PREFLIGHT>RECOVERING', 'RECOVERING>PREFLIGHT', 'DELIVERING>SUCCEEDED']));
  }, 60_000);

  it('a crash before a transition commits (inside the recovery transaction): nothing of it survives, and the next owner recovers exactly once', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), sleepMs: 1_500 }] }));
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_000 }));
    await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((w) => w.state === 'RUNNING'), 30_000);
    a.kill('SIGKILL');
    await exited(a);
    const before = transitions(l, run.id);
    // B takes the lease over and starts recovery. The transition to RECOVERING runs inside reconcile's own
    // transaction (recovery/reconcile.ts enterRecovery), so the injected crash lands before that transaction commits.
    const b = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_000, faults: 'controller.transition.after-commit=crash' }));
    expect((await exited(b)).code, b.output()).toBe(137);
    expect(transitions(l, run.id)).toEqual(before);
    expect(runState(l, run.id).state).toBe('IMPLEMENTING');
    expect(events(l, run.id, 'recovery.crash-handled')).toEqual([]);

    await finish(l, run.id);
    expectExactlyOnce(l, run.id);
    expect(transitions(l, run.id).filter((x) => x === 'IMPLEMENTING>RECOVERING')).toHaveLength(1);
    expect(events(l, run.id, 'lease.takeover').length).toBe(2);
    expect(events(l, run.id, 'recovery.crash-handled')).toHaveLength(1);
    // The implementer outlived two controllers and was reattached, never duplicated.
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(calls(l, 'implementer')).toHaveLength(1);
  }, 60_000);

  it('a crash after the worker intent commits but before the process starts: the next controller starts it exactly once', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_000, faults: 'controller.worker.after-plan=crash' }));
    expect((await exited(a)).code, a.output()).toBe(137);
    expect(listWorkers(l.db(), { runId: run.id }).map((w) => [w.role, w.state])).toEqual([['planner', 'PLANNED']]);
    expect(calls(l)).toEqual([]);

    await finish(l, run.id);
    expectExactlyOnce(l, run.id);
    expect(listWorkers(l.db(), { runId: run.id, role: 'planner' })).toHaveLength(1);
    expect(calls(l, 'planner')).toHaveLength(1);
  }, 60_000);

  it('a crash after the process starts but before it is recorded RUNNING: the next controller adopts it from pid.json', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ planner: [{ ...(baseScenario({}) as { roles: { planner: object[] } }).roles.planner[0], sleepMs: 1_000 }], implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_000, faults: 'controller.worker.after-spawn=crash' }));
    expect((await exited(a)).code, a.output()).toBe(137);
    const [planner] = listWorkers(l.db(), { runId: run.id, role: 'planner' });
    expect(planner?.state).toBe('PLANNED');

    await finish(l, run.id);
    expectExactlyOnce(l, run.id);
    expect(listWorkers(l.db(), { runId: run.id, role: 'planner' }).map((w) => w.id)).toEqual([planner!.id]);
    expect(calls(l, 'planner')).toHaveLength(1);
  }, 60_000);
});
