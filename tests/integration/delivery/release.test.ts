import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetFaults } from '../../../src/core/faults.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { deliver } from '../../../src/delivery/deliver.ts';
import { performRelease, resolveDeploy, unresolvedDeploys, type ReleaseInput } from '../../../src/delivery/release.ts';
import type { DeliveryCandidate, DeliveryEvidence, DeliveryReview } from '../../../src/delivery/gate.ts';
import { git, makeLab, type Lab } from './harness.ts';

let lab: Lab | null = null;

afterEach(() => {
  delete process.env.ORBIT_FAULTS;
  resetFaults();
  lab?.cleanup();
  lab = null;
});

function faults(spec: string): void {
  process.env.ORBIT_FAULTS = spec;
  resetFaults();
}

const node = process.execPath;
// Appends "<sha> <widget.txt content>" to $MARK: proves which commit's checkout the command ran in, and how often.
const RECORD = [node, '-e', "const fs=require('fs');fs.appendFileSync(process.env.MARK, process.env.ORBIT_RELEASE_SHA+' '+fs.readFileSync('widget.txt','utf8'))"];

function releaseLab(tweak: (c: OrbitConfig) => void = () => {}): Lab {
  lab = makeLab({
    mode: 'release',
    tweak: (cfg) => {
      cfg.delivery.pull_request = 'ready';
      cfg.actions.merge = true;
      cfg.actions.deploy_production = true;
      cfg.isolation = { ...cfg.isolation, provider: 'none', allow_unisolated: true };
      cfg.network.allowed_hosts = [...cfg.network.allowed_hosts, 'deploy.example.com'];
      cfg.release = {
        merge: { method: 'squash', require_checks: ['test'], delete_branch: true, mark_ready: true },
        environments: {
          staging: { deploy_command: RECORD, allowed_branches: ['main'], require_ci_green: true, network_hosts: ['deploy.example.com'], timeout_seconds: 60, verify_command: null },
          preview: { deploy_command: RECORD, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: null },
        },
      };
      tweak(cfg);
    },
  });
  return lab;
}

interface Delivered {
  c: DeliveryCandidate;
  ev: DeliveryEvidence;
  rv: DeliveryReview;
  commit: string;
  pr: number | null;
}

async function delivered(l: Lab, content = 'widget v1\n'): Promise<Delivered> {
  const c = l.candidate(content);
  const ev = l.evidenceFor(c);
  const rv = l.reviewFor(c);
  const d = await deliver({ run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock, report: { title: 'Add the acme widget', summary: 'Adds it.' } });
  return { c, ev, rv, commit: d.commit, pr: d.pr?.number ?? null };
}

function input(l: Lab, d: Delivered, over: Partial<ReleaseInput> = {}): ReleaseInput {
  return {
    run: l.deliveryRun,
    candidate: d.c,
    evidence: d.ev,
    review: d.rv,
    snapshot: l.snapshot,
    ledger: l.ledger(),
    client: l.fake,
    clock: l.clock,
    commit: d.commit,
    pr: d.pr,
    contractMerge: true,
    environment: null,
    readiness: () => ({ ok: true, reasons: [] }),
    isolation: new NoIsolation(),
    workDir: join(l.dir, 'runs', l.runId),
    deployEnv: { MARK: join(l.dir, 'deploys.log') },
    ...over,
  };
}

const kinds = (l: Lab) => l.ledger().list(l.runId).map((a) => `${a.kind}:${a.state}`);
const deploys = (l: Lab) => (existsSync(join(l.dir, 'deploys.log')) ? readFileSync(join(l.dir, 'deploys.log'), 'utf8').split('\n').filter(Boolean) : []);

describe('performRelease: merge', () => {
  it('merges the exact reviewed commit after green branch checks, then deploys the merge commit from the base branch', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);

    const first = await performRelease(input(l, d, { environment: 'staging' }));
    // Merged; the deploy waits for CI on the merge commit.
    expect(first.status).toBe('pending');
    expect(first.pending).toMatch(/CI on .* before deploying to staging/);
    expect(first.merge).toMatchObject({ number: d.pr, headSha: d.commit, baseBranch: 'main', method: 'squash' });
    const mergeSha = first.merge!.mergeCommitSha!;
    expect(l.remoteSha('main')).toBe(mergeSha);
    expect(git(l.remote, ['rev-parse', `${mergeSha}^{tree}`])).toBe(d.c.treeHash);
    expect(l.remoteSha(l.deliveryRun.branch!)).toBeNull(); // delete_branch
    expect(l.fake.state.calls.filter((c) => c === 'mergePullRequest')).toHaveLength(1);
    expect(deploys(l)).toEqual([]);

    l.fake.scriptCi(mergeSha, [[{ name: 'test', bucket: 'pass' }]]);
    const second = await performRelease(input(l, d, { environment: 'staging' }));
    expect(second.status).toBe('released');
    expect(second.deploy).toMatchObject({ environment: 'staging', branch: 'main', sha: mergeSha, tree: d.c.treeHash, exitCode: 0, isolation: 'none' });
    expect(deploys(l)).toEqual([`${mergeSha} widget v1`]);
    expect(l.fake.state.merges).toBe(1);
    expect(kinds(l)).toEqual(['commit:SUCCEEDED', 'push:SUCCEEDED', 'pr_create:SUCCEEDED', 'merge:SUCCEEDED', 'deploy:SUCCEEDED']);

    // Idempotent: a third call merges and deploys nothing more.
    const third = await performRelease(input(l, d, { environment: 'staging' }));
    expect(third.status).toBe('released');
    expect(deploys(l)).toHaveLength(1);
    expect(l.fake.state.merges).toBe(1);
  });

  it('refuses every release action outside release mode, before contacting anything', async () => {
    lab = makeLab();
    const d = await delivered(lab);
    const callsBefore = lab.fake.state.calls.length;
    await expect(performRelease(input(lab, d, { environment: 'staging' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'mode.release-required', definitive: true } });
    expect(lab.fake.state.calls.length).toBe(callsBefore);
    expect(kinds(lab)).not.toContain('merge:SUCCEEDED');
    expect(lab.ledger().list(lab.runId, { kind: 'merge' })).toHaveLength(0);
  });

  it('refuses the merge when the PR head moved off the reviewed commit, and never asks the host to merge', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    // Someone pushes another commit onto the task branch after review.
    git(l.work, ['checkout', '-q', '--detach', d.commit]);
    git(l.work, ['commit', '-q', '--allow-empty', '-m', 'unreviewed']);
    git(l.work, ['push', '-q', 'origin', `HEAD:refs/heads/${l.deliveryRun.branch}`]);
    git(l.work, ['checkout', '-q', 'main']);

    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/head .* not the reviewed/) });
    expect(l.fake.state.calls).not.toContain('mergePullRequest');
    expect(l.fake.state.merges).toBe(0);
    expect(l.remoteSha('main')).toBe(l.base);
  });

  it('reconciles a lost merge response by reading the PR state, merging exactly once', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    l.fake.setFaults({ loseMergeResponse: 1 });

    const r = await performRelease(input(l, d));
    expect(r.status).toBe('released');
    expect(r.merge).toMatchObject({ headSha: d.commit, mergeCommitSha: l.remoteSha('main') });
    expect(l.fake.state.merges).toBe(1);
    expect(l.fake.state.calls.filter((c) => c === 'mergePullRequest')).toHaveLength(1);
    const merge = l.ledger().list(l.runId, { kind: 'merge' });
    expect(merge).toHaveLength(1);
    expect(merge[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 1, commitSha: d.commit });
    expect(l.db.get<{ x: number }>("SELECT 1 AS x FROM events WHERE type = 'action.reconciled' AND json_extract(data_json, '$.kind') = 'merge' AND json_extract(data_json, '$.found') = 1")).toBeTruthy();
  });

  it('reconciles a merge whose receipt was lost after the host merged (ledger fault point)', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    faults('delivery.merge.after-execute=lose-response');
    const r = await performRelease(input(l, d));
    expect(r.merge?.headSha).toBe(d.commit);
    expect(l.fake.state.merges).toBe(1);
  });

  it('waits while required checks are missing or running, and refuses on a failing check', async () => {
    const l = releaseLab((cfg) => void (cfg.release!.merge.require_checks = ['test', 'lint']));
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    const r1 = await performRelease(input(l, d));
    expect(r1).toMatchObject({ status: 'pending', merge: null });
    expect(r1.pending).toMatch(/not reported yet: lint/);

    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }, { name: 'lint', bucket: 'pending' }]]);
    expect((await performRelease(input(l, d))).pending).toMatch(/running: lint/);

    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }, { name: 'lint', bucket: 'fail' }]]);
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: { definitive: true } });
    expect(l.fake.state.merges).toBe(0);
    expect(l.ledger().list(l.runId, { kind: 'merge' })).toHaveLength(0);
  });

  it('refuses while a material question is open or the controller gate fails', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    l.db.run(
      `INSERT INTO questions (id, run_id, mode, question, evidence, options_json, material, status, created_at) VALUES ('q1', ?, 'unattended', 'Which export format?', 'e', '[]', 1, 'open', 1)`,
      l.runId,
    );
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'release.open-blockers' } });
    l.db.run("UPDATE questions SET status = 'answered' WHERE id = 'q1'");

    await expect(performRelease(input(l, d, { readiness: () => ({ ok: false, reasons: ['an unresolved high-impact finding blocks'] }) }))).rejects.toMatchObject({
      code: 'POLICY_DENIED',
      details: { rule: 'release.readiness' },
      message: expect.stringMatching(/high-impact finding/),
    });
    expect(l.fake.state.merges).toBe(0);
  });

  it('revalidates on every call: invalidated evidence or another candidate stops a merge that was waiting', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    expect((await performRelease(input(l, d))).status).toBe('pending'); // no checks yet
    l.db.run("UPDATE evidence_reports SET invalidated_at = 1, invalidated_reason = 'policy edit' WHERE id = ?", d.ev.id!);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });

    // A repair cycle delivers a new candidate: the old commit is no longer the PR head and cannot be merged.
    const d2 = await delivered(l, 'widget v2\n');
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    l.fake.scriptCi(d2.commit, [[{ name: 'test', bucket: 'pass' }]]);
    const r = await performRelease(input(l, d2));
    expect(r.merge?.headSha).toBe(d2.commit);
    expect(l.fake.state.merges).toBe(1);
  });

  it('does not merge when the run contract does not ask for it, and is refused when the policy does not allow it', async () => {
    const l = releaseLab((cfg) => void (cfg.actions.merge = false));
    const d = await delivered(l);
    const r = await performRelease(input(l, d, { contractMerge: false }));
    expect(r).toMatchObject({ status: 'released', merge: null, mergeSkipped: expect.stringMatching(/delivery.merge is false/) });
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'actions.merge' } });
    expect(l.fake.state.calls).not.toContain('mergePullRequest');
  });
});

describe('performRelease: deploy', () => {
  it('deploys the delivered task branch commit without a merge when the environment allows that branch', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    const r = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(r.status).toBe('released');
    expect(r.deploy).toMatchObject({ environment: 'preview', branch: l.deliveryRun.branch, sha: d.commit, tree: d.c.treeHash });
    expect(deploys(l)).toEqual([`${d.commit} widget v1`]);
    // The checkout it ran in is gone afterwards.
    expect(existsSync(join(l.dir, 'runs', l.runId, 'release', `deploy-preview-${d.commit.slice(0, 12)}`, 'checkout'))).toBe(false);
  });

  it('refuses an environment the profile does not name, a branch it does not allow, and a host the policy does not allow', async () => {
    const l = releaseLab((cfg) => {
      cfg.release!.environments.locked = { deploy_command: RECORD, allowed_branches: ['release/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: null };
      cfg.release!.environments.leaky = { deploy_command: RECORD, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: ['exfil.example.net'], timeout_seconds: 60, verify_command: null };
    });
    const d = await delivered(l);
    const base = { contractMerge: false };
    await expect(performRelease(input(l, d, { ...base, environment: 'production' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'release.environment' } });
    await expect(performRelease(input(l, d, { ...base, environment: 'locked' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'release.allowed_branches' } });
    await expect(performRelease(input(l, d, { ...base, environment: 'leaky' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'network.not-allowed' } });
    expect(deploys(l)).toEqual([]);
    expect(l.ledger().list(l.runId, { kind: 'deploy' })).toHaveLength(0);
  });

  it('refuses to deploy when deploy_production is not authorized', async () => {
    const l = releaseLab((cfg) => void (cfg.actions.deploy_production = false));
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'actions.deploy_production' } });
    expect(deploys(l)).toEqual([]);
  });

  it('refuses to deploy while CI on the deployed commit is red', async () => {
    const l = releaseLab((cfg) => void (cfg.release!.environments.preview!.require_ci_green = true));
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'fail' }]]);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/not green/) });
    expect(deploys(l)).toEqual([]);
  });

  it('records a failed deploy and never re-runs it automatically', async () => {
    const l = releaseLab((cfg) => void (cfg.release!.environments.preview!.deploy_command = [node, '-e', "require('fs').appendFileSync(process.env.MARK, 'ran\\n'); process.exit(3)"]));
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/exited 3/) });
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/not retried automatically/) });
    expect(deploys(l)).toEqual(['ran']);
    expect(l.ledger().list(l.runId, { kind: 'deploy' })[0]).toMatchObject({ state: 'FAILED', attempts: 1 });
  });

  it('reconciles a lost deploy receipt from the recorded outcome, running the command once', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    faults('delivery.deploy.after-execute=lose-response');
    const r = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(r.deploy?.sha).toBe(d.commit);
    expect(deploys(l)).toHaveLength(1);
    expect(l.ledger().list(l.runId, { kind: 'deploy' })[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
  });

  it('after a crash mid-deploy, adopts a recorded outcome, and blocks instead of re-running when there is none', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    faults('delivery.deploy.after-execute=throw');
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toThrow();
    faults('');
    expect(l.ledger().list(l.runId, { kind: 'deploy' })[0]!.state).toBe('EXECUTING');

    // The command started and its outcome is gone: unknown, so it is not run again.
    const outcome = join(l.dir, 'runs', l.runId, 'release', `deploy-preview-${d.commit.slice(0, 12)}`, 'outcome.json');
    const saved = readFileSync(outcome, 'utf8');
    rmSync(outcome);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: { outcomeUnknown: true, definitive: true } });
    expect(deploys(l)).toHaveLength(1);

    // With the outcome recorded, the next call adopts it.
    writeFileSync(outcome, saved);
    const r = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(r.deploy?.sha).toBe(d.commit);
    expect(deploys(l)).toHaveLength(1);
  });
});

describe('performRelease: a draft pull request (G48)', () => {
  const draftLab = (mark?: boolean): Lab =>
    releaseLab((cfg) => {
      cfg.delivery.pull_request = 'draft';
      if (mark !== undefined) cfg.release!.merge.mark_ready = mark;
    });

  it('marks the draft ready as its own ledgered action before the merge, then merges', async () => {
    const l = draftLab();
    const d = await delivered(l);
    expect(l.fake.state.prs[0]!.isDraft).toBe(true);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);

    const r = await performRelease(input(l, d));
    expect(r.status).toBe('released');
    expect(r.merge).toMatchObject({ number: d.pr, headSha: d.commit });
    expect(kinds(l)).toContain('pr_ready:SUCCEEDED');
    expect(kinds(l)).toContain('merge:SUCCEEDED');
    const order = l.ledger().list(l.runId).map((a) => a.kind);
    expect(order.indexOf('pr_ready')).toBeGreaterThan(-1);
    expect(order.indexOf('pr_ready')).toBeLessThan(order.indexOf('merge'));
    expect(l.fake.state.readies).toBe(1);
    expect(l.ledger().list(l.runId, { kind: 'pr_ready' })[0]).toMatchObject({ state: 'SUCCEEDED', commitSha: d.commit, treeHash: d.c.treeHash });

    // Idempotent: nothing is marked ready or merged a second time.
    await performRelease(input(l, d));
    expect(l.fake.state.readies).toBe(1);
    expect(l.fake.state.merges).toBe(1);
  });

  it('reconciles a lost ready response by reading the pull request, marking it ready once', async () => {
    const l = draftLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    l.fake.setFaults({ loseReadyResponse: 1 });
    const r = await performRelease(input(l, d));
    expect(r.status).toBe('released');
    expect(l.fake.state.calls.filter((c) => c === 'markPullRequestReady')).toHaveLength(1);
    expect(l.ledger().list(l.runId, { kind: 'pr_ready' })[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
  });

  it('with mark_ready off a draft refuses the merge with that reason and changes nothing on the host', async () => {
    const l = draftLab(false);
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/draft and release\.merge\.mark_ready is false/), details: { definitive: true } });
    expect(l.fake.state.readies ?? 0).toBe(0);
    expect(l.fake.state.merges).toBe(0);
    expect(l.fake.state.prs[0]!.isDraft).toBe(true);
  });

  it('a ready pull request is never marked ready again', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }]]);
    await performRelease(input(l, d));
    expect(l.ledger().list(l.runId, { kind: 'pr_ready' })).toEqual([]);
    expect(l.fake.state.calls).not.toContain('markPullRequestReady');
  });
});

describe('performRelease: every environment the release names (G50)', () => {
  const twoEnvLab = (deployAllowed = true): Lab =>
    releaseLab((cfg) => {
      cfg.actions.deploy_production = deployAllowed;
      cfg.release!.merge.require_checks = [];
      cfg.release!.environments = {
        staging: { deploy_command: RECORD, allowed_branches: ['main'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: null },
        canary: { deploy_command: RECORD, allowed_branches: ['main'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: null },
        preview: { deploy_command: RECORD, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60, verify_command: null },
      };
    });

  it("'all' deploys the merge commit to each defined environment the base branch is allowed for, in order, and says why it skipped the rest", async () => {
    const l = twoEnvLab();
    const d = await delivered(l);
    const r = await performRelease(input(l, d, { environments: 'all' }));
    expect(r.status).toBe('released');
    const mergeSha = r.merge!.mergeCommitSha!;
    expect(r.deploys.map((x) => [x.environment, x.sha])).toEqual([['staging', mergeSha], ['canary', mergeSha]]);
    expect(r.deploy?.environment).toBe('staging');
    expect(r.deploySkipped).toMatch(/environment preview is not deployed from main/);
    expect(deploys(l)).toEqual([`${mergeSha} widget v1`, `${mergeSha} widget v1`]);
    expect(l.ledger().list(l.runId, { kind: 'deploy' }).map((a) => (a.target as { environment: string }).environment)).toEqual(['staging', 'canary']);

    // Idempotent: a second call deploys nothing more.
    const again = await performRelease(input(l, d, { environments: 'all' }));
    expect(again.deploys).toHaveLength(2);
    expect(deploys(l)).toHaveLength(2);
  });

  it("'all' without a merge deploys to the environments that allow the task branch", async () => {
    const l = twoEnvLab();
    const d = await delivered(l);
    const r = await performRelease(input(l, d, { contractMerge: false, environments: 'all' }));
    expect(r.deploys.map((x) => x.environment)).toEqual(['preview']);
    expect(r.deploySkipped).toMatch(/staging is not deployed from orbit\//);
    expect(deploys(l)).toEqual([`${d.commit} widget v1`]);
  });

  it("'all' skips every environment, with the reason, when deploy_production is not authorized", async () => {
    const l = twoEnvLab(false);
    const d = await delivered(l);
    const r = await performRelease(input(l, d, { contractMerge: false, environments: 'all' }));
    expect(r.deploys).toEqual([]);
    expect(r.deploySkipped).toMatch(/deploying is not authorized/);
    expect(deploys(l)).toEqual([]);
  });

  it('explicitly named environments are strict: a branch the first does not allow refuses the whole release before it deploys anything', async () => {
    const l = twoEnvLab();
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environments: ['preview', 'staging'] }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: { rule: 'release.allowed_branches' } });
    // preview ran before staging was refused; that is the order the caller asked for.
    expect(deploys(l)).toEqual([`${d.commit} widget v1`]);
  });

  it("'all' with no environment defined says so", async () => {
    const l = releaseLab((cfg) => void (cfg.release!.environments = {}));
    const d = await delivered(l);
    const r = await performRelease(input(l, d, { contractMerge: false, environments: 'all' }));
    expect(r.deploys).toEqual([]);
    expect(r.deploySkipped).toMatch(/no release environment is defined/);
  });
});

describe('resolveDeploy: a deploy left UNKNOWN (G51)', () => {
  // Exit 0 when $LIVE exists (the deploy took effect), 1 when it does not, 2 when $BROKEN exists (cannot tell).
  const VERIFY = [node, '-e', "const fs=require('fs');process.exit(fs.existsSync(process.env.BROKEN)?2:fs.existsSync(process.env.LIVE)?0:1)"];

  async function unknownDeploy(withVerify = true): Promise<{ l: Lab; d: Delivered; live: string; broken: string }> {
    const l = releaseLab((cfg) => {
      if (withVerify) cfg.release!.environments.preview!.verify_command = VERIFY;
    });
    const d = await delivered(l);
    faults('delivery.deploy.after-execute=throw');
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toThrow();
    faults('');
    const outcome = join(l.dir, 'runs', l.runId, 'release', `deploy-preview-${d.commit.slice(0, 12)}`, 'outcome.json');
    rmSync(outcome);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ details: { outcomeUnknown: true, environment: 'preview', sha: d.commit } });
    return { l, d, live: join(l.dir, 'live'), broken: join(l.dir, 'broken') };
  }

  const resolve = (l: Lab, over: Partial<Parameters<typeof resolveDeploy>[0]> = {}) =>
    resolveDeploy({ run: l.deliveryRun, snapshot: l.snapshot, ledger: l.ledger(), clock: l.clock, workDir: join(l.dir, 'runs', l.runId), resolution: 'verify', by: 'acme-operator', isolation: new NoIsolation(), ...over });

  it('verify_command exit 0: the deploy is adopted, never run again, and the next release completes with its receipt', async () => {
    const { l, d, live, broken } = await unknownDeploy();
    writeFileSync(live, 'yes');
    const r = await resolve(l, { deployEnv: { LIVE: live, BROKEN: broken } });
    expect(r).toMatchObject({ verdict: 'deployed', via: 'verify_command', environment: 'preview', sha: d.commit });
    expect(l.ledger().list(l.runId, { kind: 'deploy' })[0]).toMatchObject({ state: 'SUCCEEDED' });

    const done = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(done.deploy).toMatchObject({ environment: 'preview', sha: d.commit, exitCode: 0 });
    expect(deploys(l)).toHaveLength(1);
    const decisions = readFileSync(join(l.dir, 'runs', l.runId, 'decisions.jsonl'), 'utf8');
    expect(decisions).toMatch(/release\.deploy-resolved/);
  });

  it('verify_command exit 1: the deploy did not take effect, so the next release runs it once more', async () => {
    const { l, d, live, broken } = await unknownDeploy();
    const r = await resolve(l, { deployEnv: { LIVE: live, BROKEN: broken } });
    expect(r).toMatchObject({ verdict: 'not-deployed', via: 'verify_command' });
    expect(deploys(l)).toHaveLength(1);

    const done = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(done.deploy?.sha).toBe(d.commit);
    expect(deploys(l)).toHaveLength(2);
    expect(l.ledger().list(l.runId, { kind: 'deploy' })[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 2 });
  });

  it('any other verify_command result leaves the deploy unknown and changes nothing', async () => {
    const { l, d, live, broken } = await unknownDeploy();
    writeFileSync(broken, 'x');
    const r = await resolve(l, { deployEnv: { LIVE: live, BROKEN: broken } });
    expect(r.verdict).toBe('unknown');
    expect(r.detail).toMatch(/exited 2/);
    expect(l.ledger().list(l.runId, { kind: 'deploy' })[0]!.state).not.toBe('SUCCEEDED');
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ details: { outcomeUnknown: true } });
    expect(deploys(l)).toHaveLength(1);
  });

  it('an environment without a verify_command stays unknown under verify, and a person can settle it', async () => {
    const { l, d } = await unknownDeploy(false);
    const v = await resolve(l);
    expect(v).toMatchObject({ verdict: 'unknown', detail: expect.stringMatching(/no verify_command/) });

    const person = await resolve(l, { resolution: 'deployed', by: 'acme-operator' });
    expect(person).toMatchObject({ verdict: 'deployed', via: 'person' });
    const done = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(done.deploy?.sha).toBe(d.commit);
    expect(deploys(l)).toHaveLength(1);
  });

  it('a person reporting not-deployed lets the release run the command again', async () => {
    const { l, d } = await unknownDeploy(false);
    expect(await resolve(l, { resolution: 'not-deployed' })).toMatchObject({ verdict: 'not-deployed', via: 'person' });
    await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(deploys(l)).toHaveLength(2);
  });

  it('a deploy that timed out is an unknown outcome that can be settled', async () => {
    const l = releaseLab((cfg) => {
      const e = cfg.release!.environments.preview!;
      e.deploy_command = [node, '-e', "require('fs').appendFileSync(process.env.MARK, 'ran\\n'); setTimeout(() => {}, 30000)"];
      e.timeout_seconds = 1;
    });
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ details: { outcomeUnknown: true, environment: 'preview' } });
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ details: { outcomeUnknown: true } });
    expect(deploys(l)).toEqual(['ran']);
    expect(l.ledger().list(l.runId, { kind: 'deploy' })[0]!.state).toBe('FAILED');
    expect(unresolvedDeploys(l.ledger(), l.runId, join(l.dir, 'runs', l.runId))).toHaveLength(1);

    await resolve(l, { resolution: 'deployed' });
    const done = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(done.deploy?.sha).toBe(d.commit);
    expect(deploys(l)).toEqual(['ran']);
  }, 60_000);

  it('refuses when nothing is unresolved, outside release mode, and without a name when two are', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    await expect(resolve(l, { resolution: 'deployed' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    await expect(resolve(l, { resolution: 'deployed' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const other = { ...l.snapshot, config: { ...l.snapshot.config, mode: 'autonomous-delivery' as const } };
    await expect(resolve(l, { snapshot: other, resolution: 'deployed' })).rejects.toMatchObject({ code: 'POLICY_DENIED' });
  });
});
