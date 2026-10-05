// Fault: resource saturation (spec sections 8 and 17; mandatory scenario 15). The scheduler admits no
// more than capacity, and when the machine's memory or CPU is saturated it defers work instead of
// starting it. The first block drives the real AgentScheduler with saturated probes; the second runs
// the real controller with two runs and real fake workers while free memory reads as exhausted.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentScheduler } from '../../src/scheduling/scheduler.ts';
import type { WorkUnit } from '../../src/scheduling/types.ts';
import { Controller } from '../../src/controller/loop.ts';
import { isTerminal } from '../../src/controller/states.ts';
import { listActiveWorkers } from '../../src/storage/workers.ts';
import { baseScenario, canStripTypes, implementMul, labDeps, runState, startLabRun, tracker, waitFor, writeScenario } from './helpers.ts';

// Free memory reads as exhausted for everything this file runs, the controller's scheduler included.
const memory = vi.hoisted(() => ({ freeBytes: 0 }));
vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>();
  const freemem = () => memory.freeBytes;
  return { ...os, freemem, default: { ...os, freemem } };
});

const t = tracker();
afterEach(() => t.cleanup());

const MB = 1024 * 1024;
const config = (parallel: number) => ({ agents: { default_parallelism: parallel, cancel_obsolete_workers: true }, scheduler: { hard_limits: { parallel_workers: parallel } } });

function unit(id: string, opts: Partial<WorkUnit> = {}): WorkUnit {
  return { id, role: 'verifier', writer: false, ownedPaths: [], dependsOn: [], revision: null, cancelWhen: [], budget: {}, provider: 'claude', worktree: null, status: 'pending', ...opts };
}

describe('fault: resource saturation (scheduler)', () => {
  it('admits no more than the configured capacity, however much is pending', () => {
    const s = new AgentScheduler(config(2), { system: { availableParallelism: () => 16, freemem: () => 64_000 * MB } });
    const pending = Array.from({ length: 6 }, (_, i) => unit(`u${i}`));
    const plan = s.plan(pending, { parallelism: 2 });
    expect(plan.start.map((u) => u.id)).toEqual(['u0', 'u1']);
    expect(plan.deferred).toHaveLength(4);
    for (const d of plan.deferred) expect(d.reason).toMatch(/at capacity: 2 active of 2/);
    // With two running, nothing more starts.
    const again = s.plan([unit('r0', { status: 'running' }), unit('r1', { status: 'running' }), ...pending], { parallelism: 2 });
    expect(again.start).toEqual([]);
  });

  it('saturated memory defers new work while a worker runs, and names memory as the limit', () => {
    const s = new AgentScheduler(config(4), { system: { availableParallelism: () => 16, freemem: () => 512 * MB } });
    const cap = s.capacity();
    expect(cap.parts.memory).toBe(0);
    expect(cap.slots).toBe(1);
    expect(cap.limited_by).toContain('memory');
    const plan = s.plan([unit('busy', { status: 'running' }), unit('next'), unit('later')], { parallelism: 4 });
    expect(plan.start).toEqual([]);
    for (const d of plan.deferred) expect(d.reason).toMatch(/at capacity: 1 active of 1 \(limited by .*memory/);
  });

  it('saturated CPU defers new work while a worker runs', () => {
    const s = new AgentScheduler(config(4), { system: { availableParallelism: () => 1, freemem: () => 64_000 * MB } });
    expect(s.capacity().limited_by).toContain('cpu');
    const plan = s.plan([unit('busy', { status: 'running' }), unit('next')], { parallelism: 4 });
    expect(plan.start).toEqual([]);
    expect(plan.deferred[0]!.reason).toMatch(/limited by .*cpu/);
  });

  it('unreadable probes count as saturated rather than unlimited', () => {
    const s = new AgentScheduler(config(4), { system: { availableParallelism: () => Number.NaN, freemem: () => Number.NaN } });
    const plan = s.plan([unit('busy', { status: 'running' }), unit('next')], { parallelism: 4 });
    expect(plan.start).toEqual([]);
    expect(s.capacity().notes.join(' ')).toMatch(/could not read/);
  });
});

describe.skipIf(!canStripTypes)('fault: resource saturation (controller with real workers)', () => {
  it('with memory saturated, a controller owning two runs never has more than one implementer running', async () => {
    const l = t.lab();
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('*'), sleepMs: 2_500 }] }));
    const first = startLabRun(l);
    const second = startLabRun(l, 'Add a mul function to the calculator, second request.');
    const c = new Controller({ mode: 'service', deps: labDeps(l), leaseTtlMs: 30_000, leaseRenewMs: 500, tickIntervalMs: 50, graceMs: 300, shutdownGraceMs: 300 });
    const started = c.start();
    let peak = 0;
    try {
      await waitFor(() => {
        const live = listActiveWorkers(l.db()).filter((w) => w.role === 'implementer').length;
        peak = Math.max(peak, live);
        return isTerminal(runState(l, first.id).state) && isTerminal(runState(l, second.id).state);
      }, 45_000, 25);
    } finally {
      await c.stop('test over');
      await started;
    }
    expect(runState(l, first.id).state).toBe('SUCCEEDED');
    expect(runState(l, second.id).state).toBe('SUCCEEDED');
    expect(peak).toBe(1);
  }, 60_000);
});
