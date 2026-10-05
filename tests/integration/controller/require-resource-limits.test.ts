// isolation.require_resource_limits (docs/gaps.md G24), end to end: a run whose isolation provider cannot enforce a
// configured limit is refused at preflight, before any worker starts; with the limit off, the same run succeeds.
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

function lab(memoryMb: number | null): Lab {
  const l = makeLab({
    tweak: (c) => {
      c.isolation = { ...c.isolation, provider: 'none', allow_unisolated: true, require_resource_limits: true, limits: { cpu_seconds: 3600, max_processes: 2048, max_file_mb: 2048, memory_mb: memoryMb } };
    },
  });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
  return l;
}

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();
}

describe.skipIf(!canStripTypes)('controller: isolation.require_resource_limits', () => {
  it('blocks at preflight, naming the limit the provider cannot enforce, and starts no worker', async () => {
    const l = lab(4096);
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/^environment gate: isolation\.require_resource_limits is true but none cannot enforce isolation\.limits\.memory_mb \(4096 MB\): isolation provider none enforces no memory limit; use isolation\.provider "container"/);
    expect(l.db().all('SELECT id FROM workers WHERE run_id = ?', run.id)).toEqual([]);
  }, 60_000);

  it('runs normally when every configured limit is enforced (the memory limit switched off)', async () => {
    const l = lab(null);
    const run = startLabRun(l);
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
  }, 120_000);
});
