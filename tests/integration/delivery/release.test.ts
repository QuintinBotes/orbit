import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resetFaults } from '../../../src/core/faults.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { deliver } from '../../../src/delivery/deliver.ts';
import { performRelease, type ReleaseInput } from '../../../src/delivery/release.ts';
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
        merge: { method: 'squash', require_checks: ['test'], delete_branch: true },
        environments: {
          staging: { deploy_command: RECORD, allowed_branches: ['main'], require_ci_green: true, network_hosts: ['deploy.example.com'], timeout_seconds: 60 },
          preview: { deploy_command: RECORD, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60 },
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
      cfg.release!.environments.locked = { deploy_command: RECORD, allowed_branches: ['release/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 60 };
      cfg.release!.environments.leaky = { deploy_command: RECORD, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: ['exfil.example.net'], timeout_seconds: 60 };
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
