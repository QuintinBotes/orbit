// Fault: kill a worker during an edit (spec section 17; section 14 "Worker crash: preserve
// worktree/checkpoint; restart bounded worker"). The fake implementer writes part of its change,
// then is SIGKILLed with its whole process group (shim included), so no exit.json is ever written.
import { afterEach, describe, expect, it } from 'vitest';
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { killGroup } from '../../src/core/proc.ts';
import { isTerminal } from '../../src/controller/states.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { alive, baseScenario, calls, canStripTypes, events, exited, git, IMPLEMENTER_OUTPUT, implementMul, runState, spawnFaultyController, startLabRun, tracker, waitFor, writeScenario, type Lab } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

const WIP = 'export const wip = "first half of an edit that never fin';

/** First call: a partial edit, then a long sleep (killed mid-task). Later calls: the real change. */
function crashingScenario(): object {
  return baseScenario({
    implementer: [
      { edits: [{ op: 'write', path: 'apps/wip.mjs', content: WIP }], sleepMs: 60_000, structured: IMPLEMENTER_OUTPUT },
      implementMul('*'),
    ],
  });
}

/**
 * `controller` is a controller that must die together with the worker: it is killed first, so it cannot notice
 * the dead worker and restart it in the window before the test would otherwise kill it. Without this, a slow
 * host lets the live controller reconcile the worker itself and the next controller finds nothing to do. The
 * worker runs in its own session, so it keeps running until it is killed here.
 */
async function killWorkerMidEdit(l: Lab, runId: string, controller?: ChildProcess): Promise<{ id: string; pid: number; pgid: number; worktree: string }> {
  const w = await waitFor(() => listWorkers(l.db(), { runId, role: 'implementer' }).find((x) => x.state === 'RUNNING' && x.pgid !== null), 30_000);
  const worktree = runState(l, runId).worktreePath!;
  // Mid-edit: the first half of the change is on disk and the worker is still going.
  await waitFor(() => existsSync(join(worktree, 'apps/wip.mjs')), 15_000);
  t.group(w.pgid);
  if (controller) {
    controller.kill('SIGKILL');
    await exited(controller);
  }
  killGroup(w.pgid!, 'SIGKILL');
  await waitFor(() => !alive(w.pid!), 5_000);
  expect(existsSync(join(w.workerDir, 'exit.json'))).toBe(false);
  return { id: w.id, pid: w.pid!, pgid: w.pgid!, worktree };
}

describe.skipIf(!canStripTypes)('fault: worker killed during an edit', () => {
  it('worker and controller die together: the next controller marks the worker LOST, restarts it once in the same worktree, and the run completes', async () => {
    const l = t.lab();
    writeScenario(l, crashingScenario());
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_000 }));
    const killed = await killWorkerMidEdit(l, run.id, a);
    a.kill('SIGKILL');
    await exited(a);

    const b = t.child(spawnFaultyController(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 1_000 }));
    await waitFor(() => isTerminal(runState(l, run.id).state), 60_000);
    await exited(b);
    const done = runState(l, run.id);
    expect(done.state, `${done.outcomeReason}\n${b.output().slice(-1500)}`).toBe('SUCCEEDED');

    // LOST detection and a bounded restart of the same worker row: no second implementer, one restart.
    const reconciled = events(l, run.id, 'recovery.reconciled').map((e) => JSON.parse(e.data_json!) as { workers: { id: string; observation: string; restart_planned: boolean }[] });
    expect(reconciled.flatMap((r) => r.workers)).toContainEqual(expect.objectContaining({ id: killed.id, observation: 'lost', restart_planned: true }));
    const implementers = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(implementers.map((w) => w.id)).toEqual([killed.id]);
    expect(implementers[0]!.restartCount).toBe(1);
    const implCalls = calls(l, 'implementer');
    expect(implCalls).toHaveLength(2);
    // The restart ran in the preserved worktree: the killed worker's partial file is still there and part of the candidate.
    expect(new Set(implCalls.map((c) => c.cwd))).toEqual(new Set([killed.worktree]));
    expect(readFileSync(join(killed.worktree, 'apps/wip.mjs'), 'utf8')).toBe(WIP);
    expect(git(l.repo, 'show', `orbit/${run.id}:apps/wip.mjs`)).toBe(WIP.trim());
    expect(events(l, run.id, 'lease.takeover').length).toBeGreaterThanOrEqual(1);
  }, 90_000);

  it('the worker dies under a live controller: it is detected LOST and restarted in the preserved worktree, without a duplicate', async () => {
    const l = t.lab();
    writeScenario(l, crashingScenario());
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 1_500 }));
    const killed = await killWorkerMidEdit(l, run.id);
    await waitFor(() => isTerminal(runState(l, run.id).state), 60_000);
    await exited(a);
    const done = runState(l, run.id);

    const implementers = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    const first = implementers.find((w) => w.id === killed.id)!;
    expect(first.resultStatus).toBe('lost');
    // Never two live implementers: every implementer process started after the killed one was gone.
    expect(calls(l, 'implementer').every((c) => c.cwd === killed.worktree)).toBe(true);
    expect(readFileSync(join(killed.worktree, 'apps/wip.mjs'), 'utf8')).toBe(WIP);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    // A lost worker is restarted for the same attempt; its half-written tree is not handed to verification as an attempt.
    expect(events(l, run.id, 'implementation.attempt')).toHaveLength(1);
    expect(calls(l, 'implementer')).toHaveLength(2);
  }, 90_000);
});
