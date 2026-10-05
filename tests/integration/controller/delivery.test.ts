import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { FakeGitHub } from '../../../src/delivery/github.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { listReviews } from '../../../src/review/store.ts';
import { readJsonIfExists } from '../../../src/core/fsx.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

describe.skipIf(!canStripTypes)('controller: autonomous delivery', () => {
  it('delivers exactly the reviewed tree to an orbit/ branch with one pull request, then completes', async () => {
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
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);

    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const ev = listEvidenceReports(l.db(), run.id).at(-1)!;
    const review = listReviews(l.db(), run.id).at(-1)!;
    const delivery = readJsonIfExists<{ commit: string; tree: string; branch: string; pr: { number: number } }>(join(l.repo, '.orbit', 'runs', run.id, 'delivery.json'))!;
    expect(delivery.branch).toBe(`orbit/${run.id}`);
    expect(delivery.tree).toBe(ev.treeHash);
    expect(review.treeHash).toBe(ev.treeHash);
    expect(git(remote, 'rev-parse', `refs/heads/${delivery.branch}`)).toBe(delivery.commit);
    expect(git(remote, 'rev-parse', `${delivery.commit}^{tree}`)).toBe(ev.treeHash);
    const state = new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') }).state;
    expect(state.prs).toHaveLength(1);
    expect(state.creates).toBe(1);
    expect(done.outcomeReason).toMatch(/CI is unverified/);
  });
});
