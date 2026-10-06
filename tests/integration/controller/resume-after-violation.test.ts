// e2e re-test Nm7: `orbit resume` after a protected-path (policy violation) block must not send the implementer
// back into the worktree that still holds the violating change. The implementer may not touch protected paths, so
// it could never remove it: every attempt reproduced the invalidated tree until the run ended EXHAUSTED. On resume
// the controller restores the worktree to the last valid candidate (here the base revision) and repairs from there.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import type { CliSeams } from '../../../src/cli/context.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { listCandidates } from '../../../src/evidence/store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, seedRegistry, startLabRun, writeScenario, type Lab } from './harness.ts';
import { Controller } from '../../../src/controller/loop.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function seams(l: Lab): CliSeams {
  return {
    pollMs: 20,
    controller: { tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 400, startGraceMs: 2_000 },
    controllerDeps: (input) => {
      seedRegistry(input.db!);
      return labDeps(l, input.db);
    },
  };
}

async function cli(l: Lab, argv: string[]) {
  const io = memoryIo();
  const code = await main(argv, { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome, HOME: l.base }, user: 'alice', seams: seams(l) });
  return { code, out: io.stdout, err: io.stderr };
}

const ROGUE = { op: 'write', path: '.github/workflows/ci.yml', content: 'rogue: true\n' };

describe.skipIf(!canStripTypes)('controller: resume after a policy-violation block (Nm7)', () => {
  it('restores the worktree before the next attempt, so the repair does not reproduce the violating tree', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [ROGUE]), implementMul('*')] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();

    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/policy violation in candidate 1: protected paths changed: \.github\/workflows\/ci\.yml/);
    // The block says what resume does about the worktree, which still holds the change for inspection.
    expect(blocked.outcomeReason).toMatch(/resume.*restores the worktree/);
    expect(existsSync(join(blocked.worktreePath!, '.github', 'workflows', 'ci.yml'))).toBe(true);

    const resumed = await cli(l, ['resume', run.id, '--foreground', '--policy', l.configPath]);
    const done = getRun(l.db(), run.id);
    expect(done.state, `${done.outcomeReason}\n${resumed.out}\n${resumed.err}`).toBe('SUCCEEDED');
    expect(existsSync(join(done.worktreePath ?? blocked.worktreePath!, '.github', 'workflows', 'ci.yml'))).toBe(false);
    const cands = listCandidates(l.db(), run.id);
    expect(cands).toHaveLength(2);
    expect(cands[1]!.diffStat?.paths).not.toContain('.github/workflows/ci.yml');
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(2);
    const restored = l.db().all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'worktree.restored'", run.id);
    expect(restored).toHaveLength(1);
    expect(JSON.parse(restored[0]!.data_json)).toMatchObject({ candidate_id: cands[0]!.id, restored_to: 'base' });
  }, 180_000);
});
