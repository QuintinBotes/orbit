// A moved base branch (spec section 14; docs/gaps.md G37): when the base branch moved on the remote and the
// delivered commit no longer merges into it, the run does not succeed; it blocks with the conflicting paths.
// A base that moved without conflicting changes is no obstacle.
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

function deliveryLab(): { l: Lab; remote: string } {
  const l = makeLab({
    tweak: (c) => {
      c.mode = 'autonomous-delivery';
      c.actions = { ...c.actions, commit: true, push_task_branch: true, open_pull_request: true, read_ci_logs: true, repair_ci: true };
      c.delivery = { ...c.delivery, provider: 'fake', require_ci: false };
    },
  });
  labs.push(l);
  const remote = join(l.base, 'remote.git');
  git(l.base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(l.repo, 'remote', 'add', 'origin', remote);
  git(l.repo, 'push', '-q', 'origin', 'main');
  git(l.repo, 'config', 'user.name', 'Acme Controller');
  git(l.repo, 'config', 'user.email', 'controller@acme.test');
  return { l, remote };
}

/** Someone else moves main on the remote after the run's base revision was taken. */
function moveRemoteBase(l: Lab, remote: string, path: string, content: string): string {
  const other = join(l.base, 'other');
  git(l.base, 'clone', '-q', remote, other);
  writeFileSync(join(other, path), content);
  git(other, 'add', '-A');
  git(other, '-c', 'user.name=acme', '-c', 'user.email=dev@acme.test', 'commit', '-q', '-m', 'move main');
  git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
}

describe.skipIf(!canStripTypes)('controller: a moved base branch', () => {
  it('a delivered commit that conflicts with the moved base blocks with the conflicting paths', async () => {
    const { l, remote } = deliveryLab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const moved = moveRemoteBase(l, remote, 'apps/calc.mjs', 'export const add = (a, b) => b + a;\nexport const mul = (a, b) => Math.imul(a, b);\n');
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/base branch main moved .* no longer merges cleanly: conflicts in apps\/calc\.mjs/);
    expect(done.outcomeReason).toMatch(/Rebasing the task branch is not an authorized action/);
    const [d] = listDecisions(l.db(), run.id, { kind: 'delivery.base-conflict' });
    expect(d?.data).toMatchObject({ baseBranch: 'main', to: moved, files: ['apps/calc.mjs'] });
  }, 90_000);

  it('a base that moved without touching the change still completes', async () => {
    const { l, remote } = deliveryLab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    moveRemoteBase(l, remote, 'README.md', 'acme calculator\n');
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listDecisions(l.db(), run.id, { kind: 'delivery.base-conflict' })).toEqual([]);
  }, 90_000);
});
