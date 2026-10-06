import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

// NM2: the Diagnose mode runs experiments, so the diagnosis worker must be spawned with the experiment grant (Bash inside its sandbox, worktree read-only).
describe.skipIf(!canStripTypes)('controller: the diagnosis worker may run experiments', () => {
  it('spawns the diagnosis verifier read-only with Bash allowed in a sandbox that can write only its scratch directory', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('+'), implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
    expect(runState(l, run.id).state).toBe('SUCCEEDED');

    const [diag] = listWorkers(l.db(), { runId: run.id, role: 'verifier' });
    expect(diag).toBeDefined();
    const settings = JSON.parse(readFileSync(join(diag!.workerDir, 'settings.json'), 'utf8')) as { permissions: { allow: string[]; deny: string[] }; sandbox: { autoAllowBashIfSandboxed: boolean; filesystem: { allowWrite: string[] } } };
    expect(settings.sandbox.autoAllowBashIfSandboxed).toBe(true);
    expect(settings.sandbox.filesystem.allowWrite).toHaveLength(1);
    expect(settings.permissions.allow.some((r) => r.startsWith('Edit'))).toBe(false);
    // The worktree is denied for writing (Edit deny becomes the sandbox's denyWrite), and the prompt says experiments are allowed.
    expect(settings.permissions.deny.some((r) => r.startsWith('Edit(//') && r.endsWith('**)') && r.includes('/worktrees/'))).toBe(true);
    expect(readFileSync(join(diag!.workerDir, 'prompt.md'), 'utf8')).toContain('You may run commands');
  });
});
