// Release mode, end to end through the controller (docs/gaps.md G48, G50, G51): a draft pull request is marked ready
// and merged, the merge commit deploys through a fake environment for every environment the release profile names
// that the base branch is allowed for, and a deploy left with an unknown outcome is settled by the environment's
// verify_command before a person is asked, or by `orbit release resolve` when it cannot be.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { FakeGitHub } from '../../../src/delivery/github.ts';
import type { OrbitConfig, ReleaseEnvironment } from '../../../src/policy/types.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { readJsonIfExists } from '../../../src/core/fsx.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { systemClock } from '../../../src/core/clock.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { acquireLease, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { baseScenario, git, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const node = process.execPath;

/** A scratch directory outside the lab for the fake environment to write into (the deploy runs in a throwaway checkout). */
function markFile(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-env-')));
  dirs.push(dir);
  return join(dir, 'deploys.log');
}

const record = (mark: string): string[] => [node, '-e', `require('fs').appendFileSync(${JSON.stringify(mark)}, process.env.ORBIT_RELEASE_ENVIRONMENT + ' ' + process.env.ORBIT_RELEASE_SHA + '\\n')`];
const lines = (mark: string): string[] => (existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').filter(Boolean) : []);
const env = (deploy_command: string[], over: Partial<ReleaseEnvironment> = {}): ReleaseEnvironment => ({
  deploy_command,
  allowed_branches: ['main'],
  require_ci_green: false,
  network_hosts: [],
  timeout_seconds: 60,
  verify_command: null,
  ...over,
});

function releaseLab(environments: NonNullable<OrbitConfig['release']>['environments']): { l: Lab; remote: string } {
  const l = makeLab({
    tweak: (c) => {
      c.mode = 'release';
      c.actions = { ...c.actions, commit: true, push_task_branch: true, open_pull_request: true, read_ci_logs: true, repair_ci: true, merge: true, deploy_production: true };
      // The default: a draft pull request, which release mode has to mark ready before it can merge.
      c.delivery = { ...c.delivery, provider: 'fake', require_ci: false, pull_request: 'draft' };
      c.release = { merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true }, environments };
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

async function drive(l: Lab, runId: string, deps: Omit<ControllerDeps, 'ownerId'> = labDeps(l)): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps, tickIntervalMs: 20, graceMs: 300 }).start();
}

const releaseFile = (l: Lab, runId: string) =>
  readJsonIfExists<{ merge: { pr: number; head: string; merge_commit: string } | null; deploy: { environment: string; sha: string } | null; deploys: { environment: string; sha: string }[]; deploy_skipped: string | null }>(join(l.repo, '.orbit', 'runs', runId, 'release.json'))!;
const fakeState = (l: Lab) => new FakeGitHub({ statePath: join(l.repo, '.orbit', 'fake-github.json') }).state as unknown as { prs: { number: number; state: string; isDraft: boolean }[]; readies?: number };

describe.skipIf(!canStripTypes)('controller: release mode deploys', () => {
  it('a draft pull request is marked ready, merged, and the merge commit is deployed through the environment; release.completed records it', async () => {
    const mark = markFile();
    const { l, remote } = releaseLab({ staging: env(record(mark)) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const release = releaseFile(l, run.id);
    const mergeCommit = release.merge!.merge_commit;
    expect(git(remote, 'rev-parse', 'refs/heads/main')).toBe(mergeCommit);
    expect(release.deploy).toMatchObject({ environment: 'staging', sha: mergeCommit });
    expect(release.deploys).toEqual([{ environment: 'staging', sha: mergeCommit, branch: 'main' }]);
    expect(release.deploy_skipped).toBeNull();
    expect(lines(mark)).toEqual([`staging ${mergeCommit}`]);

    // The draft was marked ready by a ledgered action, ahead of the merge.
    const state = fakeState(l);
    expect(state.readies).toBe(1);
    expect(state.prs.map((p) => [p.state, p.isDraft])).toEqual([['MERGED', false]]);
    const kinds = l.db().all<{ kind: string; state: string }>("SELECT kind, state FROM actions WHERE run_id = ? ORDER BY created_at, rowid", run.id).map((a) => `${a.kind}:${a.state}`);
    expect(kinds.indexOf('pr_ready:SUCCEEDED')).toBeGreaterThan(-1);
    expect(kinds.indexOf('pr_ready:SUCCEEDED')).toBeLessThan(kinds.indexOf('merge:SUCCEEDED'));
    expect(kinds.indexOf('merge:SUCCEEDED')).toBeLessThan(kinds.indexOf('deploy:SUCCEEDED'));

    const ev = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'release.completed'", run.id)!;
    expect(JSON.parse(ev.data_json)).toMatchObject({ deploy: { environment: 'staging', sha: mergeCommit }, merge: { merge_commit: mergeCommit } });
    expect(listDecisions(l.db(), run.id, { kind: 'release.completed' })).toHaveLength(1);
    expect(JSON.parse(done.outcomeJson!)).toMatchObject({ release: { deploy: { environment: 'staging', sha: mergeCommit } } });
  }, 120_000);

  it('every environment the profile names that the base branch is allowed for deploys, in profile order; the others are reported as skipped', async () => {
    const mark = markFile();
    const { l } = releaseLab({
      staging: env(record(mark)),
      canary: env(record(mark)),
      preview: env(record(mark), { allowed_branches: ['orbit/*'] }),
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const release = releaseFile(l, run.id);
    const sha = release.merge!.merge_commit;
    expect(release.deploys.map((d) => d.environment)).toEqual(['staging', 'canary']);
    expect(lines(mark)).toEqual([`staging ${sha}`, `canary ${sha}`]);
    expect(release.deploy_skipped).toMatch(/environment preview is not deployed from main/);
  }, 120_000);

  it('a run that names its environment (orbit run --environment) deploys only that one; the contract carries the name (G50)', async () => {
    const mark = markFile();
    const { l } = releaseLab({ staging: env(record(mark)), canary: env(record(mark)) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l, undefined, { environment: 'canary' });
    expect(run.environment).toBe('canary');
    await withMergeRequested(l, run.id);
    expect((JSON.parse(runState(l, run.id).contractJson!) as { delivery: { environment?: string } }).delivery.environment).toBe('canary');
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const release = releaseFile(l, run.id);
    const sha = release.merge!.merge_commit;
    expect(release.deploys).toEqual([{ environment: 'canary', sha, branch: 'main' }]);
    expect(release.deploy_skipped).toBeNull();
    expect(lines(mark)).toEqual([`canary ${sha}`]);
    expect(l.db().all<{ target_json: string }>("SELECT target_json FROM actions WHERE run_id = ? AND kind = 'deploy'", run.id).map((a) => (JSON.parse(a.target_json) as { environment: string }).environment)).toEqual(['canary']);
  }, 120_000);

  it('a named environment the base branch is not allowed for blocks the release before the pull request is merged (G50)', async () => {
    const mark = markFile();
    const { l, remote } = releaseLab({ staging: env(record(mark)), preview: env(record(mark), { allowed_branches: ['orbit/*'] }) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l, undefined, { environment: 'preview' });
    await withMergeRequested(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/release refused: environment preview may not be deployed from main \(allowed: orbit\/\*\)/);
    expect(fakeState(l).prs.map((p) => p.state)).toEqual(['OPEN']);
    expect(git(remote, 'log', '--format=%s', 'refs/heads/main')).toBe('base');
    expect(lines(mark)).toEqual([]);
    expect(l.db().all<{ kind: string }>("SELECT kind FROM actions WHERE run_id = ? AND kind IN ('merge', 'deploy')", run.id)).toEqual([]);
  }, 120_000);

  it('a run that names an environment the release profile does not define is refused at intake, before any worker starts (G50)', async () => {
    const mark = markFile();
    const { l } = releaseLab({ staging: env(record(mark)) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l, undefined, { environment: 'production' });
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/intake gate: the run names release environment "production", which cannot be used: "production" is not defined in release\.environments \(defined: staging\)/);
    expect(l.db().all('SELECT id FROM workers WHERE run_id = ?', run.id)).toEqual([]);
    expect(lines(mark)).toEqual([]);
  }, 120_000);

  it('a deploy that timed out is settled by the environment\'s verify_command before anyone is asked: deployed means adopted, never run twice', async () => {
    const mark = markFile();
    const { l } = releaseLab({
      staging: env([node, '-e', `require('fs').appendFileSync(${JSON.stringify(mark)}, 'ran\\n'); setTimeout(() => {}, 30000)`], {
        timeout_seconds: 1,
        verify_command: [node, '-e', `process.exit(require('fs').existsSync(${JSON.stringify(mark)}) ? 0 : 1)`],
      }),
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(lines(mark)).toEqual(['ran']);
    expect(releaseFile(l, run.id).deploy).toMatchObject({ environment: 'staging' });
    const [resolved] = listDecisions(l.db(), run.id, { kind: 'release.deploy-resolved' });
    expect(resolved?.summary).toMatch(/resolved as deployed by verify_command/);
    expect(l.db().get<{ state: string }>("SELECT state FROM actions WHERE run_id = ? AND kind = 'deploy'", run.id)!.state).toBe('SUCCEEDED');
  }, 120_000);

  it('a verify_command that says "not deployed" lets the controller run the deploy again, once', async () => {
    const mark = markFile();
    const flag = `${mark}.live`;
    // First run: touches nothing and hangs (so it times out). The verify says not deployed until the flag exists;
    // the second run writes the flag and exits cleanly.
    const deploy = [node, '-e', `const fs=require('fs');const m=${JSON.stringify(mark)};fs.appendFileSync(m,'run\\n');if(fs.readFileSync(m,'utf8').split('\\n').filter(Boolean).length<2){setTimeout(()=>{},30000)}`];
    const { l } = releaseLab({ staging: env(deploy, { timeout_seconds: 1, verify_command: [node, '-e', `process.exit(require('fs').existsSync(${JSON.stringify(flag)}) ? 0 : 1)`] }) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(lines(mark)).toEqual(['run', 'run']);
    const [resolved] = listDecisions(l.db(), run.id, { kind: 'release.deploy-resolved' });
    expect(resolved?.summary).toMatch(/resolved as not-deployed by verify_command/);
    expect(l.db().get<{ state: string; attempts: number }>("SELECT state, attempts FROM actions WHERE run_id = ? AND kind = 'deploy'", run.id)).toMatchObject({ state: 'SUCCEEDED', attempts: 2 });
  }, 120_000);

  it('an outcome nothing can settle blocks the run naming the command; orbit release resolve records what the person found and the run completes without a second deploy', async () => {
    const mark = markFile();
    const { l } = releaseLab({
      staging: env([node, '-e', `require('fs').appendFileSync(${JSON.stringify(mark)}, 'ran\\n'); setTimeout(() => {}, 30000)`], {
        timeout_seconds: 1,
        // Cannot tell: exits 2.
        verify_command: [node, '-e', 'process.exit(2)'],
      }),
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await withMergeRequested(l, run.id);
    await drive(l, run.id);

    const blocked = runState(l, run.id);
    expect(blocked.state, blocked.outcomeReason ?? '').toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/whether it took effect is unknown/);
    expect(blocked.outcomeReason).toContain(`orbit release resolve ${run.id} --deployed`);
    expect(blocked.outcomeReason).toMatch(/automatic check: verify_command exited 2/);
    expect(lines(mark)).toEqual(['ran']);

    const io = memoryIo();
    const code = await main(['release', 'resolve', run.id, '--deployed', '--repo', l.repo], { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env }, user: 'acme-operator' });
    expect(code, io.stderr).toBe(0);
    expect(io.stdout).toMatch(/DEPLOYED/);
    expect(io.stdout).toContain(`orbit resume ${run.id}`);

    // What `orbit resume` does for a blocked run: back to the stage it stopped in.
    acquireLease(l.db(), run.id, 'person-resume', 60_000, systemClock);
    transition(l.db(), { runId: run.id, to: runState(l, run.id).resumeState!, ownerId: 'person-resume', reason: 'resumed after resolving the deploy', actor: 'acme-operator', expectedFrom: 'BLOCKED' }, systemClock);
    releaseLease(l.db(), run.id, 'person-resume');
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(lines(mark)).toEqual(['ran']);
    expect(releaseFile(l, run.id).deploy).toMatchObject({ environment: 'staging' });
  }, 150_000);
});
