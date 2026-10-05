/**
 * Spec section 17, scenarios 7, 8 and 20 (spec section 2: "a closed
 * terminal, crashed controller, failed provider request, or lost PR response
 * must not create duplicate workers or duplicate external actions"):
 * restarts reattach instead of duplicating, a lost PR response still ends in
 * one PR, and a durable cancellation survives a controller restart.
 * Controllers run in their own processes and are killed with SIGKILL.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isTerminal } from '../../src/controller/states.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listCheckRuns } from '../../src/evidence/store.ts';
import { killGroup } from '../../src/core/proc.ts';
import { alive, argvCalls, drive, git, makeLab, orbitOnce, READY, runState, spawnController, startLabRun, waitFor, writeScenario, type ControllerChild, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, implementer, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertCancellationFinal, assertRunInvariants, events, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
const children: ControllerChild[] = [];
const groups: number[] = [];
afterEach(() => {
  for (const c of children.splice(0)) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL');
  for (const g of groups.splice(0)) {
    try {
      killGroup(g, 'SIGKILL');
    } catch {
      /* gone */
    }
  }
  labs.splice(0).forEach((l) => l.close());
});
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}
function controller(l: Lab, opts: Parameters<typeof spawnController>[1]): ControllerChild {
  const c = spawnController(l, opts);
  children.push(c);
  return c;
}

/** External actions by kind and state, for the "no duplicate actions" checks. */
function actions(l: Lab, runId: string): { kind: string; state: string; idempotency_key: string }[] {
  return l.db().all('SELECT kind, state, idempotency_key FROM actions WHERE run_id = ? ORDER BY created_at', runId);
}

describe.skipIf(!READY)('acceptance: restarts, lost responses and cancellation', () => {
  it('scenario 7: a controller killed mid-implementation is replaced by one that reattaches to the same worker; nothing is started twice', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT], { extra: { sleepMs: 4_000 } })] }));
    const run = startLabRun(l, GOAL);
    const a = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    const impl = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((w) => w.state === 'RUNNING' && w.pid !== null), 90_000);
    a.kill('SIGKILL');
    await a.exited();
    // The worker is detached in its own process group: it outlives its controller.
    expect(alive(impl.pid!)).toBe(true);

    const b = controller(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 1_500 });
    await waitFor(() => isTerminal(runState(l, run.id).state), 150_000, 100);
    await b.exited();

    const done = runState(l, run.id);
    expect(done.state, `${done.outcomeReason}\n${b.output().slice(-1500)}`).toBe('SUCCEEDED');
    const db = l.db();
    // One implementer, never restarted, and one provider call for it.
    const implementers = listWorkers(db, { runId: run.id, role: 'implementer' });
    expect(implementers.map((w) => [w.id, w.restartCount])).toEqual([[impl.id, 0]]);
    expect(argvCalls(l).filter((c) => c.role === 'implementer')).toHaveLength(1);
    // The new owner took the expired lease, recorded the crash, recovered and resumed.
    expect(events(db, run.id, 'lease.takeover').length).toBeGreaterThanOrEqual(1);
    expect(transitions(db, run.id)).toContain('RECOVERING');
    // One of each external action, one PR.
    expect(actions(l, run.id).map((x) => x.kind).sort()).toEqual([...new Set(actions(l, run.id).map((x) => x.kind))].sort());
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('scenario 7: a controller killed as delivery opens the PR is replaced without a second commit, push or PR', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const a = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    const ghPath = join(l.repo, '.orbit', 'fake-github.json');
    await waitFor(() => existsSync(ghPath) && (JSON.parse(readFileSync(ghPath, 'utf8')) as { prs: unknown[] }).prs.length > 0, 150_000, 5);
    a.kill('SIGKILL');
    await a.exited();

    const b = controller(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 1_500 });
    await waitFor(() => isTerminal(runState(l, run.id).state), 150_000, 100);
    await b.exited();

    const done = runState(l, run.id);
    expect(done.state, `${done.outcomeReason}\n${b.output().slice(-1500)}`).toBe('SUCCEEDED');
    const gh = l.github().state;
    expect(gh.prs).toHaveLength(1);
    expect(gh.creates).toBe(1);
    // Each external action exists once (idempotency keys are unique) and ended with a receipt.
    const acts = actions(l, run.id);
    expect(acts.filter((x) => x.kind === 'commit')).toHaveLength(1);
    expect(acts.filter((x) => x.kind === 'push')).toHaveLength(1);
    expect(acts.every((x) => x.state === 'SUCCEEDED')).toBe(true);
    expect(git(l.remote, 'for-each-ref', '--format=%(refname)', 'refs/heads/orbit/')).toBe(`refs/heads/orbit/${run.id}`);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('scenario 8: a PR whose create response is lost is adopted on reconciliation, so the run still has exactly one PR', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    // The service creates the PR, then the response never arrives.
    l.github().setFaults({ loseCreateResponse: 1 });
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const gh = l.github().state;
    expect(gh.faults.loseCreateResponse).toBe(0);
    expect(gh.prs).toHaveLength(1);
    expect(gh.creates).toBe(1);
    expect(gh.prs[0]).toMatchObject({ headRefName: `orbit/${run.id}`, isDraft: true });
    const delivery = JSON.parse(readFileSync(join(l.runDir(run.id), 'delivery.json'), 'utf8')) as { pr: { number: number } };
    expect(delivery.pr.number).toBe(gh.prs[0]!.number);
    // One PR action with a receipt naming that PR; the lost response is not a second intent.
    const prActions = actions(l, run.id).filter((x) => /pull|pr/i.test(x.kind));
    expect(prActions).toHaveLength(1);
    expect(prActions[0]!.state).toBe('SUCCEEDED');
    const receipt = l.db().get<{ receipt_json: string }>("SELECT receipt_json FROM actions WHERE run_id = ? AND idempotency_key = ?", run.id, prActions[0]!.idempotency_key)!;
    expect(JSON.parse(receipt.receipt_json)).toMatchObject({ number: gh.prs[0]!.number });
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('scenario 20: a cancellation recorded with `orbit cancel` while the controller is dead is carried out by the next controller, and stays final', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT], { extra: { sleepMs: 120_000 } })] }));
    const run = startLabRun(l, GOAL);
    // A long lease: the dead controller still "owns" the run when the cancellation is recorded.
    const a = controller(l, { mode: 'service', leaseTtlMs: 8_000 });
    const impl = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' }).find((w) => w.state === 'RUNNING' && w.pid !== null && w.pgid !== null), 90_000);
    groups.push(impl.pgid!);
    a.kill('SIGKILL');
    await a.exited();

    const cancel = await orbitOnce(l, ['cancel', run.id]);
    expect(cancel.code, cancel.out).toBe(0);
    expect(cancel.out).toMatch(/cancellation recorded/);
    expect(runState(l, run.id).cancelRequested).toBe(true);
    expect(runState(l, run.id).state).toBe('IMPLEMENTING');
    // The orphaned worker is still running: only a controller can stop it.
    expect(alive(impl.pid!)).toBe(true);

    const b = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    await waitFor(() => runState(l, run.id).state === 'CANCELLED', 60_000, 100);
    await waitFor(() => !alive(impl.pid!), 15_000);
    b.kill('SIGTERM');
    await b.exited();

    // A further restart changes nothing: no new worker, no new check, no state change.
    const workersBefore = listWorkers(l.db(), { runId: run.id }).length;
    const checksBefore = listCheckRuns(l.db(), { runId: run.id }).length;
    const c = controller(l, { mode: 'service', leaseTtlMs: 1_500 });
    await new Promise((r) => setTimeout(r, 2_500));
    c.kill('SIGTERM');
    await c.exited();

    const done = runState(l, run.id);
    expect(done.state).toBe('CANCELLED');
    expect(listWorkers(l.db(), { runId: run.id })).toHaveLength(workersBefore);
    expect(listCheckRuns(l.db(), { runId: run.id })).toHaveLength(checksBefore);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    expect(l.github().state.prs).toEqual([]);
    expect(argvCalls(l).filter((x) => x.role === 'implementer')).toHaveLength(1);
    assertCancellationFinal(l.db(), run.id);
    assertRunInvariants(l, run.id);
  }, 240_000);
});
