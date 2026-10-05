import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resetFaults } from '../../../src/core/faults.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { deliver } from '../../../src/delivery/deliver.ts';
import type { DeliveryCandidate, DeliveryEvidence, DeliveryReview } from '../../../src/delivery/gate.ts';
import type { GitHubClient } from '../../../src/delivery/github.ts';
import { performRelease, releaseConfig, type ReleaseInput } from '../../../src/delivery/release.ts';
import { git, makeLab, type Lab } from '../../integration/delivery/harness.ts';

let lab: Lab | null = null;
afterEach(() => {
  delete process.env.ORBIT_FAULTS;
  resetFaults();
  vi.unstubAllEnvs();
  lab?.cleanup();
  lab = null;
});
function faults(spec: string): void {
  process.env.ORBIT_FAULTS = spec;
  resetFaults();
}

const node = process.execPath;
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
const workDir = (l: Lab) => join(l.dir, 'runs', l.runId);
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
    workDir: workDir(l),
    deployEnv: { MARK: join(l.dir, 'deploys.log') },
    ...over,
  };
}
const deployDir = (l: Lab, env: string, sha: string) => join(workDir(l), 'release', `deploy-${env}-${sha.slice(0, 12)}`);
const pass = (l: Lab, sha: string) => l.fake.scriptCi(sha, [[{ name: 'test', bucket: 'pass' }]]);

/** The fake host with some answers rewritten. */
function wrap(l: Lab, over: Partial<GitHubClient>): GitHubClient {
  const b = l.fake;
  return {
    findPullRequest: (h) => b.findPullRequest(h),
    createPullRequest: (i) => b.createPullRequest(i),
    updatePullRequest: (n, c) => b.updatePullRequest(n, c),
    markPullRequestReady: (n) => b.markPullRequestReady(n),
    mergePullRequest: (i) => b.mergePullRequest(i),
    getMergeState: (n) => b.getMergeState(n),
    listChecks: (q) => b.listChecks(q),
    failedLogs: (r) => b.failedLogs(r),
    authStatus: () => b.authStatus(),
    ...over,
  };
}

describe('release profile and readiness', () => {
  it('releaseConfig is null without a profile and the profile when there is one', () => {
    lab = makeLab();
    expect(releaseConfig(lab.snapshot)).toBeNull();
    lab.cleanup();
    const l = releaseLab();
    expect(releaseConfig(l.snapshot)!.merge.method).toBe('squash');
  });

  it('release mode without a release profile is refused', async () => {
    const l = releaseLab((cfg) => void (cfg.release = undefined));
    const d = await delivered(l);
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: expect.objectContaining({ rule: 'release.profile-missing', definitive: true }) });
  });

  it('a failed readiness gate with no reasons still says the gate did not pass', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { readiness: () => ({ ok: false, reasons: [] }) }))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('the release gate did not pass') });
  });

  it('defaults the task branch to <prefix><run id> when the run names none', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    const r = await performRelease(input(l, d, { run: { ...l.deliveryRun, branch: null }, contractMerge: false, environment: 'preview' }));
    expect(r.deploy).toMatchObject({ branch: `orbit/${l.runId}`, sha: d.commit });
  });

  it('refuses a commit that delivery did not push for the reviewed tree', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    const other = l.candidate('something else\n');
    await expect(performRelease(input(l, d, { commit: other.commitSha }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('is not a commit delivery pushed for the reviewed tree') });
  });

  it('refuses a pushed commit that is gone or does not carry the reviewed tree', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    const record = (sha: string) => {
      const ledger = l.ledger();
      const { action } = ledger.recordIntent({ runId: l.runId, kind: 'push', idempotencyKey: `forged:${sha}`, target: { forged: sha }, candidateId: d.c.id, treeHash: d.c.treeHash, commitSha: sha });
      ledger.recordReceipt(ledger.markExecuting(action), { ok: true }, 'execute');
    };
    const other = l.candidate('different tree\n');
    record(other.commitSha);
    await expect(performRelease(input(l, d, { commit: other.commitSha }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('does not carry the reviewed tree') });
    record('1'.repeat(40));
    await expect(performRelease(input(l, d, { commit: '1'.repeat(40) }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('does not carry the reviewed tree') });
  });
});

describe('merge: refusals around the pull request', () => {
  it('needs a pull request to merge', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { pr: null }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('no pull request to merge') });
  });

  it('refuses a pull request that targets another base, is closed, or has an unknown head', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    const state = (over: object) => wrap(l, { getMergeState: async (n) => ({ ...(await l.fake.getMergeState(n)), ...over }) });
    await expect(performRelease(input(l, d, { client: state({ baseRefName: 'develop' }) }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/targets develop, not main/) });
    await expect(performRelease(input(l, d, { client: state({ state: 'CLOSED' }) }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/is closed; Orbit does not reopen it/) });
    await expect(performRelease(input(l, d, { client: state({ headRefOid: '' }) }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/head is unknown, not the reviewed/) });
    expect(l.fake.state.merges).toBe(0);
  });

  it('checks the host is reachable when the provider is github', async () => {
    const l = releaseLab((cfg) => void (cfg.delivery.provider = 'github'));
    const d = await delivered(l);
    pass(l, d.commit);
    expect((await performRelease(input(l, d))).merge).toMatchObject({ headSha: d.commit });
  });

  it('stops before merging when the host answers that the merge did not take (a queue, say)', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    const queued = wrap(l, { mergePullRequest: async (i) => ({ ...(await l.fake.getMergeState(i.number)), state: 'OPEN', mergeCommitSha: null, mergedAt: null }) });
    await expect(performRelease(input(l, d, { client: queued }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/after the merge, pull request #1 is OPEN/), details: expect.objectContaining({ definitive: true }) });
  });

  it('a merge interrupted before it was sent is found unmerged on reconcile and then performed once', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    faults('delivery.merge.before-execute=throw');
    await expect(performRelease(input(l, d))).rejects.toThrow(/fault injected/);
    expect(l.fake.state.merges).toBe(0);
    faults('');
    const r = await performRelease(input(l, d));
    expect(r.status).toBe('released');
    expect(l.fake.state.merges).toBe(1);
    expect(l.ledger().list(l.runId, { kind: 'merge' })[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 2 });
  });

  it('refuses when reconciling shows the pull request was closed instead of merged', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    faults('delivery.merge.before-execute=throw');
    await expect(performRelease(input(l, d))).rejects.toThrow(/fault injected/);
    faults('');
    let reads = 0;
    // Reads in the second call: the gate, the pre-attempt gate, then the reconcile read, which finds it closed.
    const closing = wrap(l, {
      getMergeState: async (n) => {
        const s = await l.fake.getMergeState(n);
        return ++reads === 3 ? { ...s, state: 'CLOSED' } : s;
      },
    });
    await expect(performRelease(input(l, d, { client: closing }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/is CLOSED at .*was not merged by Orbit/) });
    expect(l.fake.state.merges).toBe(0);
  });

  it('proceeds when the pull request turns out merged at the reviewed commit just before the attempt', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    let reads = 0;
    const early = wrap(l, {
      getMergeState: async (n) => {
        const s = await l.fake.getMergeState(n);
        // Read 2 is the pre-attempt gate: another executor has merged it already.
        return ++reads === 2 ? { ...s, state: 'MERGED' } : s;
      },
    });
    const r = await performRelease(input(l, d, { client: early }));
    expect(r.merge).toMatchObject({ headSha: d.commit });
    expect(l.fake.state.merges).toBe(1);
  });

  it('refuses at the pre-attempt gate when checks turned red, or are no longer settled, after the first look', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }], [{ name: 'test', bucket: 'fail' }]]);
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: expect.objectContaining({ definitive: true }), message: expect.stringMatching(/branch checks on .* are failed: failing: test \(fail\)/) });
    l.fake.scriptCi(d.commit, [[{ name: 'test', bucket: 'pass' }], [{ name: 'test', bucket: 'pending' }]]);
    await expect(performRelease(input(l, d))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: expect.objectContaining({ definitive: false }), message: expect.stringMatching(/are pending: running: test/) });
    expect(l.fake.state.merges).toBe(0);
  });
});

describe('merge: a draft pull request', () => {
  const draftLab = () => releaseLab((cfg) => void (cfg.delivery.pull_request = 'draft'));

  it('a ready action that finished is not repeated when a later call comes back to the merge', async () => {
    const l = draftLab();
    const d = await delivered(l);
    pass(l, d.commit);
    faults('delivery.merge.before-execute=throw');
    await expect(performRelease(input(l, d))).rejects.toThrow(/fault injected/);
    faults('');
    expect(l.ledger().list(l.runId, { kind: 'pr_ready' })[0]).toMatchObject({ state: 'SUCCEEDED' });
    const r = await performRelease(input(l, d));
    expect(r.status).toBe('released');
    expect(l.fake.state.readies).toBe(1);
  });

  it('fails when the host still shows a draft after it was marked ready', async () => {
    const l = draftLab();
    const d = await delivered(l);
    pass(l, d.commit);
    const stubborn = wrap(l, { markPullRequestReady: async (n) => ({ ...(await l.fake.markPullRequestReady(n)), isDraft: true }) });
    await expect(performRelease(input(l, d, { client: stubborn }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('is still a draft after it was marked ready') });
  });

  it('a ready request that never reached the host is found still a draft on reconcile and then sent', async () => {
    const l = draftLab();
    const d = await delivered(l);
    pass(l, d.commit);
    faults('delivery.pr_ready.before-execute=throw');
    await expect(performRelease(input(l, d))).rejects.toThrow(/fault injected/);
    expect(l.fake.state.readies ?? 0).toBe(0);
    faults('');
    const r = await performRelease(input(l, d));
    expect(r.status).toBe('released');
    expect(l.fake.state.readies).toBe(1);
  });
});

describe('a named environment is refused before anything is merged (G50)', () => {
  const mergeActions = (l: Lab) => l.ledger().list(l.runId, { kind: 'merge' });
  const untouched = (l: Lab) => {
    expect(l.fake.state.prs.map((p) => p.state)).toEqual(['OPEN']);
    expect(mergeActions(l)).toEqual([]);
  };

  it('an environment the base branch is not allowed for leaves the pull request open', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    // preview is allowed for orbit/* only; a merge would deploy from main.
    await expect(performRelease(input(l, d, { environments: ['preview'] }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: expect.objectContaining({ rule: 'release.allowed_branches', definitive: true }), message: expect.stringContaining('environment preview may not be deployed from main (allowed: orbit/*)') });
    untouched(l);
  });

  it('without a merge the environment is judged against the task branch', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environments: ['staging'] }))).rejects.toMatchObject({ details: expect.objectContaining({ rule: 'release.allowed_branches' }), message: expect.stringContaining(`environment staging may not be deployed from orbit/${l.runId} (allowed: main)`) });
    expect(l.fake.state.prs.map((p) => p.state)).toEqual(['OPEN']);
  });

  it('an environment the profile does not define leaves the pull request open', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    await expect(performRelease(input(l, d, { environments: ['production'] }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: expect.objectContaining({ rule: 'release.environment' }), message: expect.stringContaining('(defined: staging, preview)') });
    untouched(l);
  });

  it('a policy that does not authorize deploying refuses the named environment before the merge', async () => {
    const l = releaseLab((cfg) => void (cfg.actions.deploy_production = false));
    const d = await delivered(l);
    pass(l, d.commit);
    await expect(performRelease(input(l, d, { environments: ['staging'] }))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('deploying is not authorized') });
    untouched(l);
  });
});

describe('deploy: environment selection and configuration', () => {
  it('says "none" when a named environment is not defined and the profile defines none', async () => {
    const l = releaseLab((cfg) => void (cfg.release!.environments = {}));
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'prod' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', details: expect.objectContaining({ rule: 'release.environment' }), message: expect.stringContaining('(defined: none)') });
  });

  it('an environment with no allowed branches is refused when named, and skipped with that reason under all', async () => {
    const l = releaseLab((cfg) => void (cfg.release!.environments.preview!.allowed_branches = []));
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('(allowed: none)') });
    const all = await performRelease(input(l, d, { contractMerge: false, environments: 'all' }));
    expect(all.deploySkipped).toContain('environment preview is not deployed from');
    expect(all.deploySkipped).toContain('(allowed: none)');
  });

  it('refuses to deploy a merge that reported no merge commit', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    const noSha = wrap(l, { mergePullRequest: async (i) => ({ ...(await l.fake.mergePullRequest(i)), mergeCommitSha: null }) });
    await expect(performRelease(input(l, d, { client: noSha, environment: 'staging' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('reported no merge commit to deploy') });
  });

  it('refuses a deploy_command that is empty or has an empty argument', async () => {
    for (const command of [[], [node, '']]) {
      const l = releaseLab((cfg) => void (cfg.release!.environments.preview!.deploy_command = command));
      const d = await delivered(l);
      await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('has no usable deploy_command') });
      l.cleanup();
    }
    lab = null;
  });

  it('needs an isolation provider and a work directory to deploy', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview', isolation: undefined }))).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('isolation provider and a work directory') });
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview', workDir: undefined }))).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('a failed deploy with no recorded error reads "no detail" in the refusal to retry', async () => {
    const l = releaseLab((cfg) => void (cfg.release!.environments.preview!.deploy_command = [node, '-e', 'process.exit(5)']));
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ message: expect.stringMatching(/exited 5/) });
    l.db.run("UPDATE actions SET error = NULL WHERE kind = 'deploy'");
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ message: expect.stringContaining('failed earlier (no detail)') });
  });

  it('refuses at the pre-attempt gate when CI on the deployed commit turned red after the first look', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    const first = await performRelease(input(l, d, { environment: 'staging' }));
    const mergeSha = first.merge!.mergeCommitSha!;
    l.fake.scriptCi(mergeSha, [[{ name: 'build', bucket: 'pass' }], [{ name: 'build', bucket: 'fail' }]]);
    await expect(performRelease(input(l, d, { environment: 'staging' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: expect.objectContaining({ definitive: true }), message: expect.stringMatching(/deploy refused: CI on .* is failed/) });
    expect(existsSync(join(l.dir, 'deploys.log'))).toBe(false);
  });
});

describe('deploy: a merge commit that is only on the remote', () => {
  it('fetches the merge commit when the remote host is allowed by policy', async () => {
    const l = releaseLab((cfg) => void (cfg.network.allowed_hosts = [...cfg.network.allowed_hosts, 'git.example.test']));
    const d = await delivered(l);
    pass(l, d.commit);
    // After delivery: the host name the push URL claims is policy-checked; the fetch itself still goes to the local remote.
    git(l.work, ['remote', 'set-url', '--push', 'origin', 'https://git.example.test/acme/app.git']);
    const first = await performRelease(input(l, d, { environment: 'staging' }));
    l.fake.scriptCi(first.merge!.mergeCommitSha!, [[{ name: 'build', bucket: 'pass' }]]);
    const second = await performRelease(input(l, d, { environment: 'staging' }));
    expect(second.deploy).toMatchObject({ environment: 'staging', sha: first.merge!.mergeCommitSha });
    expect(git(l.work, ['rev-parse', `refs/orbit/release/${l.runId}`])).toBe(first.merge!.mergeCommitSha);
  });

  it('refuses to fetch it from a host the policy does not allow', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    pass(l, d.commit);
    git(l.work, ['remote', 'set-url', '--push', 'origin', 'https://git.example.test/acme/app.git']);
    const first = await performRelease(input(l, d, { environment: 'staging' }));
    l.fake.scriptCi(first.merge!.mergeCommitSha!, [[{ name: 'build', bucket: 'pass' }]]);
    await expect(performRelease(input(l, d, { environment: 'staging' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('fetching the merge commit is not authorized') });
  });

  it('refuses to deploy a task-branch commit that has vanished from the repository', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    // A git that cannot see any object by `cat-file` (what hasCommit asks), as if the commit were pruned after the gate.
    const bin = join(l.dir, 'fakebin');
    mkdirSync(bin);
    const real = (await import('node:child_process')).execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase "$1" in cat-file) exit 1;; esac\nexec '${real}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', details: expect.objectContaining({ definitive: true }), message: expect.stringMatching(/commit .* is not in the repository/) });
  });
});

describe('deploy execution', () => {
  const deployWith = (command: string[], over: Partial<ReleaseInput> = {}) => {
    const l = releaseLab((cfg) => void (cfg.release!.environments.preview!.deploy_command = command));
    return { l, run: async () => performRelease(input(l, await delivered(l), { contractMerge: false, environment: 'preview', ...over })) };
  };

  it('removes a leftover checkout from an earlier attempt before deploying', async () => {
    const l = releaseLab();
    const d = await delivered(l);
    const leftover = join(deployDir(l, 'preview', d.commit), 'checkout');
    mkdirSync(leftover, { recursive: true });
    writeFileSync(join(leftover, 'stale.txt'), 'old');
    const r = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(r.deploy?.sha).toBe(d.commit);
    expect(existsSync(leftover)).toBe(false);
  });

  it('records the tail of stdout and stderr, redacted, when a home directory is given for the sandbox profile', async () => {
    const { run } = deployWith([node, '-e', "console.log('out line'); console.error('err ghp_abcdefghijklmnopqrstuvwxyz0123456789')"], { homeDir: '/nonexistent/acme-home' });
    const r = await run();
    expect(r.deploy!.output).toContain('out line');
    expect(r.deploy!.output).toContain('err [REDACTED');
    expect(r.deploy!.output).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
  });

  it('builds the deploy environment from the controller only: no credentials when none are given', async () => {
    const { run } = deployWith([node, '-e', 'console.log(JSON.stringify({ run: process.env.ORBIT_RUN_ID, env: process.env.ORBIT_RELEASE_ENVIRONMENT, extra: process.env.MARK ?? null, ci: process.env.CI }))'], { deployEnv: undefined });
    const out = JSON.parse((await run()).deploy!.output.trim()) as Record<string, string | null>;
    expect(out).toMatchObject({ env: 'preview', extra: null, ci: '1' });
    expect(out.run).toMatch(/^orb-/);
  });

  it('names a signal death, and a timeout as an unknown outcome, in the failure', async () => {
    const sig = deployWith([node, '-e', "process.kill(process.pid, 'SIGKILL')"]);
    await expect(sig.run()).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/exited by signal/) });

    lab?.cleanup();
    const l = releaseLab((cfg) => {
      cfg.release!.environments.preview!.deploy_command = [node, '-e', 'setTimeout(() => {}, 60000)'];
      cfg.release!.environments.preview!.timeout_seconds = 1;
    });
    const d = await delivered(l);
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({
      code: 'DELIVERY_FAILED',
      details: expect.objectContaining({ outcomeUnknown: true, environment: 'preview', sha: d.commit }),
      message: expect.stringMatching(/timed out after 1s, so whether it took effect is unknown/),
    });
    // A retry names the unknown outcome and points at "orbit release resolve".
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ message: expect.stringContaining('orbit release resolve'), details: expect.objectContaining({ outcomeUnknown: true }) });
  }, 30_000);

  it('does not fail the release when the checkout cannot be cleaned up afterwards', async () => {
    // A deploy command that turns the checkout's .git file into a directory: cleanup refuses to delete a repository.
    const { run } = deployWith([node, '-e', "const fs=require('fs');fs.rmSync('.git');fs.mkdirSync('.git')"]);
    const r = await run();
    expect(r.status).toBe('released');
    expect(r.deploy!.exitCode).toBe(0);
  });
});

describe('deploy: what a recorded outcome says when the receipt was lost', () => {
  async function interrupted(): Promise<{ l: Lab; d: Delivered; outcome: string }> {
    const l = releaseLab();
    const d = await delivered(l);
    faults('delivery.deploy.before-execute=throw');
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toThrow(/fault injected/);
    faults('');
    const dir = deployDir(l, 'preview', d.commit);
    mkdirSync(dir, { recursive: true });
    return { l, d, outcome: join(dir, 'outcome.json') };
  }
  const recorded = (d: Delivered, over: object) => JSON.stringify({ environment: 'preview', branch: 'orbit/x', sha: d.commit, tree: d.c.treeHash, attempt: 1, exitCode: 0, timedOut: false, durationMs: 5, isolation: 'none', limitations: [], output: '', ...over });

  it('a recorded nonzero exit, a recorded signal death and a recorded timeout each refuse to run it again', async () => {
    const { l, d, outcome } = await interrupted();
    writeFileSync(outcome, recorded(d, { exitCode: 2 }));
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/exited 2; it is not retried automatically/), details: { definitive: true } });
    writeFileSync(outcome, recorded(d, { exitCode: null }));
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ message: expect.stringMatching(/exited by signal; it is not retried/) });
    writeFileSync(outcome, recorded(d, { exitCode: null, timedOut: true }));
    await expect(performRelease(input(l, d, { contractMerge: false, environment: 'preview' }))).rejects.toMatchObject({ message: expect.stringMatching(/timed out, so whether it took effect is unknown/), details: expect.objectContaining({ outcomeUnknown: true }) });
    expect(existsSync(join(l.dir, 'deploys.log'))).toBe(false);
  });

  it('an outcome recorded for another commit is ignored, and a deploy that never started is run', async () => {
    const { l, d, outcome } = await interrupted();
    writeFileSync(outcome, recorded(d, { sha: 'e'.repeat(40), exitCode: 9 }));
    const r = await performRelease(input(l, d, { contractMerge: false, environment: 'preview' }));
    expect(r.deploy?.sha).toBe(d.commit);
    expect(readFileSync(join(l.dir, 'deploys.log'), 'utf8')).toContain(d.commit);
  });
});
