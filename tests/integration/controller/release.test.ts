// Release mode (spec sections 5 and 15): after delivery and green CI, the controller merges exactly the
// reviewed commit through delivery/release.performRelease, gated by the completion gate, and records it.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { FakeGitHub, type MergePullRequestInput, type MergeState } from '../../../src/delivery/github.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import type { StepResult } from '../../../src/controller/steps/common.ts';
import { isTerminal } from '../../../src/controller/states.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { readJsonIfExists } from '../../../src/core/fsx.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { systemClock } from '../../../src/core/clock.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { acquireLease, releaseLease } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

function releaseLab(extra?: (c: OrbitConfig) => void): { l: Lab; remote: string } {
  const l = makeLab({
    tweak: (c) => {
      c.mode = 'release';
      c.actions = { ...c.actions, commit: true, push_task_branch: true, open_pull_request: true, read_ci_logs: true, repair_ci: true, merge: true };
      // A draft pull request cannot be merged: release runs open ready ones.
      c.delivery = { ...c.delivery, provider: 'fake', require_ci: false, pull_request: 'ready' };
      c.release = { merge: { method: 'squash', require_checks: [], delete_branch: false }, environments: {} };
      extra?.(c);
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

/** Step the run until CONTRACTING has stored the contract, then turn merge on, as an approved set_delivery amendment would. */
async function withMergeRequested(l: Lab, runId: string): Promise<void> {
  const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-setup' };
  acquireLease(l.db(), runId, 'controller-setup', 3_600_000, systemClock);
  for (let i = 0; i < 400 && runState(l, runId).state !== 'PLANNING'; i++) {
    await step(deps, runId, new AbortController().signal);
    await new Promise((r) => setTimeout(r, 20));
  }
  expect(runState(l, runId).state).toBe('PLANNING');
  const contract = JSON.parse(runState(l, runId).contractJson!) as { delivery: { draft_pr: boolean; merge: boolean } };
  contract.delivery.merge = true;
  l.db().run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ?', JSON.stringify(contract), hashObject(contract), runId);
  releaseLease(l.db(), runId, 'controller-setup');
}

/** Drive the run one step at a time (a crash-looping step would hang a foreground controller forever). */
async function drive(deps: ControllerDeps, l: Lab, runId: string, opts: { until?: (r: StepResult | { error: string }) => boolean; maxMs?: number } = {}): Promise<StepResult | { error: string } | null> {
  acquireLease(l.db(), runId, deps.ownerId, 3_600_000, deps.clock);
  const deadline = Date.now() + (opts.maxMs ?? 60_000);
  let last: StepResult | { error: string } | null = null;
  while (Date.now() < deadline && !isTerminal(runState(l, runId).state)) {
    try {
      last = await step(deps, runId, new AbortController().signal);
    } catch (err) {
      last = { error: err instanceof Error ? err.message : String(err) };
    }
    if (opts.until?.(last)) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return last;
}

describe.skipIf(!canStripTypes)('controller: release mode', () => {
  it('a contract that asks for a merge: the reviewed commit is merged after delivery, and the run succeeds through the completion gate', async () => {
    const { l } = releaseLab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const delivery = readJsonIfExists<{ commit: string; pr: { number: number } }>(join(l.repo, '.orbit', 'runs', run.id, 'delivery.json'))!;
    const release = readJsonIfExists<{ merge: { pr: number; head: string } | null; deploy: unknown; deploy_skipped: string | null }>(join(l.repo, '.orbit', 'runs', run.id, 'release.json'))!;
    expect(release.merge).toMatchObject({ pr: delivery.pr.number, head: delivery.commit });
    expect(release.deploy).toBeNull();
    expect(release.deploy_skipped).toMatch(/no release environment/);
    const state = new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') }).state as unknown as { prs: { number: number; state: string }[] };
    expect(state.prs.find((p) => p.number === delivery.pr.number)?.state).toBe('MERGED');
    expect(listDecisions(l.db(), run.id, { kind: 'release.completed' })).toHaveLength(1);
    // The merged head carries exactly the evidenced tree.
    expect(git(l.repo, 'rev-parse', `${release.merge!.head}^{tree}`)).toBe(listEvidenceReports(l.db(), run.id).at(-1)!.treeHash);
    expect(JSON.parse(done.outcomeJson!)).toMatchObject({ release: { merge: { pr: delivery.pr.number } } });
  }, 90_000);

  it('without a merge in the contract nothing is merged: the release records why, and the pull request stays open', async () => {
    const { l } = releaseLab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const release = readJsonIfExists<{ merge: unknown; merge_skipped: string | null }>(join(l.repo, '.orbit', 'runs', run.id, 'release.json'))!;
    expect(release.merge).toBeNull();
    expect(release.merge_skipped).toMatch(/does not ask for a merge/);
    const state = new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') }).state as unknown as { prs: { state: string }[] };
    expect(state.prs.map((p) => p.state)).toEqual(['OPEN']);
  }, 90_000);

  it('a merge the host keeps refusing without a definitive answer is attempted at most the ledger maximum, and the run blocks with the pull request open', async () => {
    const { l, remote } = releaseLab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    let merges = 0;
    class RefusingGitHub extends FakeGitHub {
      override async mergePullRequest(_input: MergePullRequestInput): Promise<MergeState> {
        merges++;
        // What classifyGhFailure makes of a refusal it does not recognize: DELIVERY_FAILED, not definitive.
        throw new OrbitError('DELIVERY_FAILED', 'gh pr merge failed (exit 1): Pull request #1 is still a draft');
      }
    }
    const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-refused', github: () => new RefusingGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json'), remoteGitDir: remote }) };
    await drive(deps, l, run.id, { maxMs: 60_000 });

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(merges).toBeGreaterThan(0);
    expect(merges).toBeLessThanOrEqual(3);
    const state = new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') }).state as unknown as { prs: { state: string }[] };
    expect(state.prs.map((p) => p.state)).toEqual(['OPEN']);
  }, 90_000);

  it('a required branch check that never reports does not keep a release waiting forever: it blocks after delivery.ci_timeout_minutes', async () => {
    const { l } = releaseLab((c) => {
      c.delivery = { ...c.delivery, ci_timeout_minutes: 1 };
      c.release = { merge: { method: 'squash', require_checks: ['acme-required-gate'], delete_branch: false }, environments: {} };
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    let offset = 0;
    const clock = { now: () => Date.now() + offset, sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) };
    const deps: ControllerDeps = { ...labDeps(l), clock, ownerId: 'controller-timeout' };
    const waiting = await drive(deps, l, run.id, { until: (r) => 'waiting' in r && typeof r.waiting === 'string' && /release: waiting for branch checks/.test(r.waiting) });
    expect(waiting && 'waiting' in waiting ? waiting.waiting : waiting).toMatch(/acme-required-gate/);
    expect(runState(l, run.id).state).toBe('AWAITING_CI');

    // Two minutes later the required check has still not reported.
    offset = 2 * 60_000;
    await drive(deps, l, run.id, { maxMs: 20_000 });
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/acme-required-gate/);
    const state = new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') }).state as unknown as { prs: { state: string }[] };
    expect(state.prs.map((p) => p.state)).toEqual(['OPEN']);
  }, 120_000);

  it('a release whose CI reported nothing keeps the "CI is unverified" note in the run outcome', async () => {
    const { l } = releaseLab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, graceMs: 300 }).start();
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(done.outcomeReason).toMatch(/CI is unverified/);
    expect((JSON.parse(done.outcomeJson!) as { notes: string[] }).notes.join('\n')).toMatch(/CI is unverified/);
  }, 90_000);
});
