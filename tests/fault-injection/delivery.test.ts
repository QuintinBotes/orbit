// Faults around delivery (spec sections 15 and 17): a lost pull request response, a controller that
// dies right after the remote acted, and a candidate that changes after it was reviewed.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../src/core/clock.ts';
import { readJsonIfExists } from '../../src/core/fsx.ts';
import { CANDIDATE_EVENT } from '../../src/controller/context.ts';
import { isTerminal } from '../../src/controller/states.ts';
import { appendEvent } from '../../src/storage/events.ts';
import { step } from '../../src/controller/steps/index.ts';
import { FakeGitHub } from '../../src/delivery/github.ts';
import { snapshotCandidate } from '../../src/evidence/candidate.ts';
import { listEvidenceReports } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { baseScenario, canStripTypes, drive, events, exited, git, implementMul, runState, spawnFaultyController, startLabRun, stepTo, tracker, waitFor, writeScenario, type Lab } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

function deliveryLab(): { l: Lab; remote: string } {
  const l = t.lab({
    tweak: (c) => {
      c.mode = 'autonomous-delivery';
      c.actions = { ...c.actions, commit: true, push_task_branch: true, open_pull_request: true, read_ci_logs: true, repair_ci: true };
      c.delivery = { ...c.delivery, provider: 'fake', require_ci: false };
    },
  });
  const remote = join(l.base, 'remote.git');
  git(l.base, 'init', '-q', '--bare', '-b', 'main', remote);
  git(l.repo, 'remote', 'add', 'origin', remote);
  git(l.repo, 'push', '-q', 'origin', 'main');
  git(l.repo, 'config', 'user.name', 'Acme Controller');
  git(l.repo, 'config', 'user.email', 'controller@acme.test');
  writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
  return { l, remote };
}

function github(l: Lab): FakeGitHub {
  return new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') });
}

function prActions(l: Lab, runId: string): { kind: string; state: string; attempts: number }[] {
  return l.db().all("SELECT kind, state, attempts FROM actions WHERE run_id = ? AND kind = 'pr_create' ORDER BY created_at", runId);
}

describe.skipIf(!canStripTypes)('fault: delivery', () => {
  it('a lost pull request response is reconciled against the remote: exactly one pull request', async () => {
    const { l } = deliveryLab();
    const run = startLabRun(l);
    const c = t.child(spawnFaultyController(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 5_000, faults: 'delivery.pr_create.after-execute=lose-response' }));
    await exited(c);
    const done = runState(l, run.id);
    expect(done.state, `${done.outcomeReason}\n${c.output().slice(-1500)}`).toBe('SUCCEEDED');
    const gh = github(l).state;
    expect(gh.prs).toHaveLength(1);
    expect(gh.creates).toBe(1);
    expect(prActions(l, run.id)).toEqual([expect.objectContaining({ state: 'SUCCEEDED', attempts: 1 })]);
    // The remote was queried before any retry, and found the pull request the lost response had created.
    const reconciled = events(l, run.id, 'action.reconciled').map((e) => JSON.parse(e.data_json!) as { kind: string; found: boolean });
    expect(reconciled).toContainEqual(expect.objectContaining({ kind: 'pr_create', found: true }));
  }, 60_000);

  it('a controller that dies right after the pull request was created: the next one reconciles instead of creating a second', async () => {
    const { l } = deliveryLab();
    const run = startLabRun(l);
    const a = t.child(spawnFaultyController(l, { mode: 'service', leaseTtlMs: 1_000, faults: 'delivery.pr_create.after-execute=crash' }));
    expect((await exited(a)).code, a.output().slice(-1500)).toBe(137);
    expect(github(l).state.creates).toBe(1);
    expect(prActions(l, run.id).map((x) => x.state)).toEqual(['EXECUTING']);

    const b = t.child(spawnFaultyController(l, { mode: 'foreground', runId: run.id, leaseTtlMs: 1_000 }));
    await waitFor(() => isTerminal(runState(l, run.id).state), 60_000);
    await exited(b);
    const done = runState(l, run.id);
    expect(done.state, `${done.outcomeReason}\n${b.output().slice(-1500)}`).toBe('SUCCEEDED');
    const gh = github(l).state;
    expect(gh.prs).toHaveLength(1);
    expect(gh.creates).toBe(1);
    expect(prActions(l, run.id)).toEqual([expect.objectContaining({ state: 'SUCCEEDED' })]);
  }, 60_000);

  it('a worktree edited after review does not reach the remote: delivery ships exactly the reviewed tree', async () => {
    const { l, remote } = deliveryLab();
    const run = startLabRun(l);
    await stepTo(l, run.id, 'DELIVERING');
    const reviewed = listReviews(l.db(), run.id).at(-1)!;
    writeFileSync(join(runState(l, run.id).worktreePath!, 'apps/late.mjs'), 'export const late = true;\n');
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const delivery = readJsonIfExists<{ commit: string; tree: string }>(join(l.repo, '.orbit', 'runs', run.id, 'delivery.json'))!;
    expect(delivery.tree).toBe(reviewed.treeHash);
    expect(git(remote, 'rev-parse', `${delivery.commit}^{tree}`)).toBe(reviewed.treeHash);
    expect(git(remote, 'ls-tree', '-r', '--name-only', delivery.commit)).not.toContain('apps/late.mjs');
  }, 60_000);

  it('a candidate changed after review cannot be delivered: delivery is refused and the new tree is verified and reviewed first', async () => {
    const { l, remote } = deliveryLab();
    const run = startLabRun(l);
    const deps = await stepTo(l, run.id, 'DELIVERING');
    expect(runState(l, run.id).state).toBe('DELIVERING');
    const reviewed = listReviews(l.db(), run.id).at(-1)!;

    // The run's current candidate moves on after review: a late edit snapshotted and recorded as the attempt's candidate.
    const r = runState(l, run.id);
    writeFileSync(join(r.worktreePath!, 'apps/late.mjs'), 'export const late = true;\n');
    const changed = await snapshotCandidate({ db: l.db(), clock: systemClock, repoRoot: l.repo, worktree: r.worktreePath!, runId: run.id, baseRev: r.baseRevision!, attempt: 1, workerId: null });
    expect(changed.treeHash).not.toBe(reviewed.treeHash);
    l.db().tx(() => appendEvent(l.db(), run.id, CANDIDATE_EVENT, 'test', { attempt: 1, candidate_id: changed.id, seq: changed.seq, tree_hash: changed.treeHash, reused: false }, Date.now()));

    await step(deps, run.id, new AbortController().signal);
    expect(runState(l, run.id).state).toBe('VERIFYING');
    expect(events(l, run.id, 'state.transition').at(-1)!.data_json).toMatch(/delivery refused/);
    // Nothing left the repository for either tree.
    expect(existsSync(join(l.repo, '.orbit', 'runs', run.id, 'delivery.json'))).toBe(false);
    expect(l.db().all('SELECT id FROM actions WHERE run_id = ?', run.id)).toEqual([]);
    expect(git(remote, 'branch', '--list', `orbit/${run.id}`)).toBe('');

    // Driven on, the new tree is verified and reviewed, and only that tree is delivered.
    await drive(l, run.id);
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const delivery = readJsonIfExists<{ tree: string }>(join(l.repo, '.orbit', 'runs', run.id, 'delivery.json'))!;
    expect(delivery.tree).toBe(changed.treeHash);
    expect(listEvidenceReports(l.db(), run.id).at(-1)!.treeHash).toBe(changed.treeHash);
    expect(listReviews(l.db(), run.id).filter((x) => x.verdict === 'APPROVE').map((x) => x.treeHash)).toEqual([reviewed.treeHash, changed.treeHash]);
    expect(github(l).state.prs).toHaveLength(1);
  }, 60_000);
});
