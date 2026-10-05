// A moved base branch (spec section 14; docs/gaps.md G37): when the base branch moved on the remote and the
// delivered commit no longer merges into it, the run does not succeed; it blocks with the conflicting paths.
// A base that moved without conflicting changes is no obstacle. With actions.rebase_task_branch the reviewed
// candidate is rebased onto the new base, evidence and reviews are invalidated and the run verifies again.
import { afterEach, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { FakeGitHub } from '../../../src/delivery/github.ts';
import { listCandidates, listEvidenceReports } from '../../../src/evidence/store.ts';
import { readJsonIfExists } from '../../../src/core/fsx.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

function deliveryLab(rebase = false): { l: Lab; remote: string } {
  const l = makeLab({
    tweak: (c) => {
      c.mode = 'autonomous-delivery';
      c.actions = { ...c.actions, commit: true, push_task_branch: true, open_pull_request: true, read_ci_logs: true, repair_ci: true, rebase_task_branch: rebase };
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
    expect(done.outcomeReason).toMatch(/Rebasing the task branch is not authorized \(actions\.rebase_task_branch: /);
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

  it('with actions.rebase_task_branch a base that moved is rebased onto: a new candidate is verified and reviewed again, then delivered as a fast-forward of the task branch, to one pull request', async () => {
    const { l, remote } = deliveryLab(true);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const moved = moveRemoteBase(l, remote, 'README.md', 'acme calculator\n');
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [rebased] = listDecisions(l.db(), run.id, { kind: 'delivery.rebased' });
    expect(rebased?.data).toMatchObject({ to: moved });

    // Two candidates: the reviewed one, and its rebase whose parent is the new base tip.
    const cands = listCandidates(l.db(), run.id);
    expect(cands).toHaveLength(2);
    expect(cands[1]!.parentSha).toBe(moved);
    expect(cands[1]!.treeHash).not.toBe(cands[0]!.treeHash);
    expect(git(l.repo, 'show', `${cands[1]!.commitSha}:README.md`)).toBe('acme calculator');
    expect(git(l.repo, 'show', `${cands[1]!.commitSha}:apps/calc.mjs`)).toContain('mul');

    // The first evidence was invalidated; the second binds the rebased tree, which is what was delivered.
    const reports = listEvidenceReports(l.db(), run.id);
    expect(reports[0]!.invalidatedAt).not.toBeNull();
    expect(reports.at(-1)!.treeHash).toBe(cands[1]!.treeHash);
    expect(reports.at(-1)!.invalidatedAt).toBeNull();
    const delivery = readJsonIfExists<{ commit: string; tree: string; branch: string }>(join(l.repo, '.orbit', 'runs', run.id, 'delivery.json'))!;
    expect(delivery.tree).toBe(cands[1]!.treeHash);
    expect(git(remote, 'rev-parse', `refs/heads/${delivery.branch}`)).toBe(delivery.commit);
    // A fast-forward of what was pushed first, and one pull request throughout.
    const pushes = l.db().all<{ commit_sha: string }>("SELECT commit_sha FROM actions WHERE run_id = ? AND kind = 'push' AND state = 'SUCCEEDED' ORDER BY created_at, rowid", run.id).map((r) => r.commit_sha);
    expect(pushes).toHaveLength(2);
    expect(git(l.repo, 'merge-base', '--is-ancestor', pushes[0]!, pushes[1]!) === '').toBe(true);
    const state = new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') }).state as unknown as { creates: number; prs: unknown[] };
    expect(state.creates).toBe(1);
    expect(state.prs).toHaveLength(1);
    // The run's own base revision followed the rebase.
    expect(done.baseRevision).toBe(moved);
  }, 180_000);

  it('with the permission, a base that moved into a conflict blocks with the conflicting paths and rebases nothing', async () => {
    const { l, remote } = deliveryLab(true);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    moveRemoteBase(l, remote, 'apps/calc.mjs', 'export const add = (a, b) => b + a;\nexport const mul = (a, b) => Math.imul(a, b);\n');
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/rebasing the task branch onto it conflicts in apps\/calc\.mjs/);
    expect(listDecisions(l.db(), run.id, { kind: 'delivery.rebased' })).toEqual([]);
    expect(listCandidates(l.db(), run.id)).toHaveLength(1);
  }, 90_000);

  it('without the permission a base that moved cleanly still completes without any rebase', async () => {
    const { l, remote } = deliveryLab(false);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    moveRemoteBase(l, remote, 'README.md', 'acme calculator\n');
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();
    expect(runState(l, run.id).state).toBe('SUCCEEDED');
    expect(listDecisions(l.db(), run.id, { kind: 'delivery.rebased' })).toEqual([]);
    expect(listCandidates(l.db(), run.id)).toHaveLength(1);
  }, 90_000);
});
