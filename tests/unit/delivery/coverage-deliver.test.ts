import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetFaults } from '../../../src/core/faults.ts';
import { deliver, type DeliverInput } from '../../../src/delivery/deliver.ts';
import type { DeliveryCandidate } from '../../../src/delivery/gate.ts';
import type { GitHubClient, PullRequestInfo } from '../../../src/delivery/github.ts';
import { git, makeLab, type Lab } from '../../integration/delivery/harness.ts';

let lab: Lab;
beforeEach(() => {
  lab = makeLab();
});
afterEach(() => {
  delete process.env.ORBIT_FAULTS;
  resetFaults();
  lab.cleanup();
});

function faults(spec: string): void {
  process.env.ORBIT_FAULTS = spec;
  resetFaults();
}

const REPORT = { title: 'Add the acme widget', summary: 'Adds the acme widget.' };
const branch = () => lab.deliveryRun.branch!;

function input(c: DeliveryCandidate, over: Partial<DeliverInput> = {}): DeliverInput {
  return { run: lab.deliveryRun, candidate: c, evidence: lab.evidenceFor(c), review: lab.reviewFor(c), snapshot: lab.snapshot, ledger: lab.ledger(), client: lab.fake, clock: lab.clock, report: REPORT, ...over };
}

/** The fake host with some answers rewritten, to model a host that lags, lies or lists nothing. */
function client(over: Partial<GitHubClient>): GitHubClient {
  const base = lab.fake;
  return {
    findPullRequest: (h) => base.findPullRequest(h),
    createPullRequest: (i) => base.createPullRequest(i),
    updatePullRequest: (n, c) => base.updatePullRequest(n, c),
    markPullRequestReady: (n) => base.markPullRequestReady(n),
    mergePullRequest: (i) => base.mergePullRequest(i),
    getMergeState: (n) => base.getMergeState(n),
    listChecks: (q) => base.listChecks(q),
    failedLogs: (r) => base.failedLogs(r),
    authStatus: () => base.authStatus(),
    ...over,
  };
}

const rewritePr = (f: (pr: PullRequestInfo) => PullRequestInfo): Partial<GitHubClient> => ({
  findPullRequest: async (h) => {
    const pr = await lab.fake.findPullRequest(h);
    return pr ? f(pr) : null;
  },
});

describe('deliver: reconciliation of an interrupted commit and PR update', () => {
  it('a commit that never started is absent on reconcile, so the restart makes it once', async () => {
    const c = lab.candidate('x');
    faults('delivery.commit.before-execute=throw');
    await expect(deliver(input(c))).rejects.toThrow(/fault injected/);
    expect(lab.ledger().list(lab.runId, { kind: 'commit' })[0]).toMatchObject({ state: 'EXECUTING', attempts: 1 });
    faults('');
    const r = await deliver(input(c, { ledger: lab.ledger() }));
    expect(git(lab.work, ['rev-parse', `${r.commit}^{tree}`])).toBe(c.treeHash);
    expect(lab.ledger().list(lab.runId, { kind: 'commit' })).toHaveLength(1);
    expect(lab.ledger().list(lab.runId, { kind: 'commit' })[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 2 });
  });

  it('a PR update interrupted before it was sent is found unapplied on reconcile and then applied', async () => {
    const c = lab.candidate('x');
    await deliver(input(c));
    faults('delivery.pr_update.before-execute=throw');
    const next = { title: 'A new title', summary: 'A newer summary.' };
    await expect(deliver(input(c, { report: next, ledger: lab.ledger() }))).rejects.toThrow(/fault injected/);
    expect((await lab.fake.findPullRequest(branch()))!.title).toBe('Add the acme widget');
    faults('');
    const r = await deliver(input(c, { report: next, ledger: lab.ledger() }));
    expect(r.pr!.title).toBe('A new title');
    expect(r.pr!.body).toContain('A newer summary.');
    expect(lab.ledger().list(lab.runId, { kind: 'pr_update' })).toHaveLength(1);
  });

  it('a PR update whose response was lost is recognised as applied and not sent twice', async () => {
    const c = lab.candidate('x');
    await deliver(input(c));
    faults('delivery.pr_update.after-execute=lose-response');
    const r = await deliver(input(c, { report: { title: 'Retitled', summary: 'Body two.' }, ledger: lab.ledger() }));
    expect(r.pr!.title).toBe('Retitled');
    const update = lab.ledger().list(lab.runId, { kind: 'pr_update' })[0]!;
    expect(update).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
    expect(lab.fake.state.calls.filter((k) => k === 'updatePullRequest')).toHaveLength(1);
  });
});

describe('deliver: the remote must hold exactly the delivered commit', () => {
  function hook(script: string): void {
    const path = join(lab.remote, 'hooks', 'post-receive');
    writeFileSync(path, `#!/bin/sh\n${script}\n`);
    chmodSync(path, 0o755);
  }

  it('fails when the remote branch moved to another commit during the push', async () => {
    hook(`git update-ref refs/heads/${branch()} ${lab.base}`);
    const c = lab.candidate('x');
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining(`has ${lab.base} at refs/heads/${branch()}`) });
    expect(lab.fake.state.prs).toHaveLength(0);
  });

  it('says there is no such branch when the remote dropped it', async () => {
    hook(`git update-ref -d refs/heads/${branch()}`);
    const c = lab.candidate('x');
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('no such branch') });
    expect(lab.fake.state.prs).toHaveLength(0);
  });
});

describe('deliver: the pull request step', () => {
  it('reaches the PR API through the client when the provider is github and the host is allowed', async () => {
    lab.cleanup();
    lab = makeLab({ tweak: (cfg) => void (cfg.delivery.provider = 'github') });
    const c = lab.candidate('x');
    const r = await deliver(input(c));
    expect(r.pr).toMatchObject({ number: 1, state: 'OPEN' });
  });

  it('refuses to reach the PR API when network policy does not list api.github.com', async () => {
    lab.cleanup();
    lab = makeLab({
      tweak: (cfg) => {
        cfg.delivery.provider = 'github';
        cfg.network.allowed_hosts = [];
      },
    });
    const c = lab.candidate('x');
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('pull request API') });
    expect(lab.fake.state.calls).toEqual([]);
    // The branch was already pushed; only the PR step is stopped.
    expect(lab.remoteSha(branch())).not.toBeNull();
  });

  it('falls back to the run goal, then to the run id, for the title', async () => {
    const c = lab.candidate('x');
    const r1 = await deliver(input(c, { report: { title: '', summary: 's' } }));
    expect(r1.pr!.title).toBe('Add the acme widget');
    expect(git(lab.work, ['log', '-1', '--format=%s', r1.commit])).toBe('Add the acme widget');

    lab.cleanup();
    lab = makeLab();
    const c2 = lab.candidate('y');
    const noGoal = { ...lab.deliveryRun, goal: undefined };
    const r2 = await deliver(input(c2, { run: noGoal, report: { title: '', summary: 's' } }));
    expect(r2.pr!.title).toBe(`Orbit run ${lab.runId}`);
    expect(git(lab.work, ['log', '-1', '--format=%s', r2.commit])).toBe(`Orbit run ${lab.runId}`);
  });

  it('uses the run id when the title is only whitespace', async () => {
    const c = lab.candidate('x');
    const r = await deliver(input(c, { report: { title: '   \n  ', summary: 's' } }));
    expect(r.pr!.title).toBe(`Orbit run ${lab.runId}`);
    expect(git(lab.work, ['log', '-1', '--format=%s', r.commit])).toBe(`Orbit run ${lab.runId}`);
    expect(git(lab.work, ['log', '-1', '--format=%b', r.commit])).toContain(`Orbit run: ${lab.runId}`);
  });

  it('keeps only the first line of the title and cuts the commit subject at 72 characters', async () => {
    const c = lab.candidate('x');
    const long = 'w'.repeat(100);
    const r = await deliver(input(c, { report: { title: `${long}\nsecond line`, summary: 's' } }));
    expect(r.pr!.title).toBe(long);
    expect(git(lab.work, ['log', '-1', '--format=%s', r.commit])).toBe('w'.repeat(72));
  });

  it('truncates a very long summary in the PR body and says so', async () => {
    const c = lab.candidate('x');
    const r = await deliver(input(c, { report: { title: 'Big', summary: 'z'.repeat(70_000) } }));
    expect(r.pr!.body.endsWith('\n[truncated]')).toBe(true);
    expect(r.pr!.body.length).toBe(60_000 + '\n[truncated]'.length);
  });

  it('refuses a PR that targets another base branch', async () => {
    const c = lab.candidate('x');
    const lying = client(rewritePr((pr) => ({ ...pr, baseRefName: 'develop' })));
    await expect(deliver(input(c, { client: lying }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/targets develop, not main/) });
  });

  it('warns when the adopted PR is ready but the mode is draft, and the reverse', async () => {
    const c = lab.candidate('x');
    const ready = await deliver(input(c, { client: client(rewritePr((pr) => ({ ...pr, isDraft: false }))) }));
    expect(ready.warnings).toEqual([expect.stringMatching(/is ready for review; the configured mode is draft/)]);

    lab.cleanup();
    lab = makeLab({ tweak: (cfg) => void (cfg.delivery.pull_request = 'ready') });
    const c2 = lab.candidate('y');
    const draft = await deliver(input(c2, { client: client(rewritePr((pr) => ({ ...pr, isDraft: true }))) }));
    expect(draft.warnings).toEqual([expect.stringMatching(/is a draft; the configured mode is ready/)]);
  });

  it('fails when the host lists no PR right after creating one', async () => {
    const c = lab.candidate('x');
    const blind = client({ findPullRequest: async () => null });
    await expect(deliver(input(c, { client: blind }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('no pull request is listed') });
    expect(lab.fake.state.creates).toBe(1);
  });

  it('names an unknown commit when the PR head is empty, and reads the PR once when attempts is zero', async () => {
    const c = lab.candidate('x');
    let reads = 0;
    const lagging = client({
      findPullRequest: async (h) => {
        reads++;
        const pr = await lab.fake.findPullRequest(h);
        return pr && reads > 1 ? { ...pr, headRefOid: '' } : pr;
      },
    });
    await expect(deliver(input(c, { client: lagging, verifyAttempts: 0 }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringContaining('an unknown commit') });
    // One read inside the create action, one verification read: the zero was treated as one attempt.
    expect(reads).toBe(2);
  });
});
