/**
 * P19: the worktrees of a run that ended SUCCEEDED or CANCELLED are removed (the branch and the candidate refs stay,
 * so nothing is lost), while a BLOCKED or EXHAUSTED run keeps its worktree for the person who resolves it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { acquireLease, requestCancel } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { listCandidates } from '../../../src/evidence/store.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['SUCCEEDED', 'BLOCKED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED'];

/** The registered worktrees of the repository other than the main one. */
function linkedWorktrees(l: Lab): string[] {
  return git(l.repo, 'worktree', 'list', '--porcelain')
    .split('\n')
    .filter((x) => x.startsWith('worktree '))
    .map((x) => x.slice('worktree '.length))
    .filter((p) => p !== l.repo && !p.endsWith(l.repo));
}

async function drive(l: Lab, runId: string, deps: ControllerDeps, until: (state: string) => boolean): Promise<void> {
  for (let i = 0; i < 2_400 && !until(runState(l, runId).state); i++) {
    await step(deps, runId, new AbortController().signal);
    await sleep(25);
  }
}

describe.skipIf(!canStripTypes)('worktrees of finished runs (P19)', () => {
  it('a SUCCEEDED run leaves no worktree behind, and its branch is still there', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    const wt = runState(l, run.id).worktreePath;
    await drive(l, run.id, deps, (s) => TERMINAL.includes(s));
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(done.worktreePath ?? wt).toBeTruthy();
    expect(linkedWorktrees(l)).toEqual([]);
    expect(existsSync(done.worktreePath!)).toBe(false);
    expect(existsSync(join(deps.orbitHome, 'worktrees'))).toBe(true);
    // The work is kept: the branch and the candidate ref resolve to the delivered commit.
    expect(git(l.repo, 'rev-parse', '--verify', `refs/heads/${done.branch}`)).toMatch(/^[0-9a-f]{40}$/);
    expect(git(l.repo, 'show', `refs/heads/${done.branch}:apps/calc.mjs`)).toContain('mul');
  }, 180_000);

  it('a CANCELLED run leaves no worktree behind, and edits that were never a candidate are kept as one', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    await drive(l, run.id, deps, (s) => s === 'IMPLEMENTING');
    expect(runState(l, run.id).state).toBe('IMPLEMENTING');
    const wt = runState(l, run.id).worktreePath!;
    expect(existsSync(wt)).toBe(true);
    expect(linkedWorktrees(l)).toHaveLength(1);
    // An edit a worker made that never became a candidate (the run is cancelled mid-work).
    writeFileSync(join(wt, 'apps', 'wip.mjs'), 'export const wip = true;\n');
    requestCancel(l.db(), run.id, 'test', systemClock);
    await drive(l, run.id, deps, (s) => TERMINAL.includes(s));
    expect(runState(l, run.id).state).toBe('CANCELLED');
    expect(linkedWorktrees(l)).toEqual([]);
    expect(existsSync(wt)).toBe(false);
    const kept = listCandidates(l.db(), run.id).filter((c) => c.status === 'READY' || c.commitSha);
    expect(kept.length).toBeGreaterThan(0);
    expect(git(l.repo, 'show', `${kept.at(-1)!.commitSha}:apps/wip.mjs`)).toContain('wip');
  }, 180_000);
});
