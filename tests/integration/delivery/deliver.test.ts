import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetFaults } from '../../../src/core/faults.ts';
import { openDb } from '../../../src/storage/db.ts';
import { ActionLedger } from '../../../src/delivery/actions.ts';
import { deliver, type DeliverInput } from '../../../src/delivery/deliver.ts';
import type { DeliveryCandidate } from '../../../src/delivery/gate.ts';
import { git, makeLab, type Lab } from './harness.ts';

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

const REPORT = { title: 'Add the acme widget', summary: 'Adds the acme widget.\n\nAll mandatory checks pass.' };

function input(c: DeliveryCandidate, over: Partial<DeliverInput> = {}): DeliverInput {
  return {
    run: lab.deliveryRun,
    candidate: c,
    evidence: lab.evidenceFor(c),
    review: lab.reviewFor(c),
    snapshot: lab.snapshot,
    ledger: lab.ledger(),
    client: lab.fake,
    clock: lab.clock,
    report: REPORT,
    ...over,
  };
}

const branch = () => lab.deliveryRun.branch!;
const kinds = () => lab.ledger().list(lab.runId).map((a) => `${a.kind}:${a.state}`);

describe('deliver: happy path', () => {
  it('commits the reviewed tree, pushes the task branch and opens one draft PR', async () => {
    const c = lab.candidate('widget v1\n');
    const r = await deliver(input(c));

    expect(git(lab.work, ['rev-parse', `${r.commit}^{tree}`])).toBe(c.treeHash);
    expect(r.tree).toBe(c.treeHash);
    expect(lab.remoteSha(branch())).toBe(r.commit);
    expect(lab.remoteSha('main')).toBe(lab.base);
    // The author is the controller's identity, not whoever authored the candidate.
    expect(git(lab.work, ['log', '-1', '--format=%ae', r.commit])).toBe('controller@example.com');
    expect(r.pr).toMatchObject({ number: 1, state: 'OPEN', isDraft: true, headRefName: branch(), baseRefName: 'main', headRefOid: r.commit });
    expect(r.pr!.title).toBe('Add the acme widget');
    expect(r.pr!.body).toContain('Adds the acme widget.');
    expect(r.pr!.body).toContain(r.commit);
    expect(kinds()).toEqual(['commit:SUCCEEDED', 'push:SUCCEEDED', 'pr_create:SUCCEEDED']);
    expect(lab.db.get("SELECT 1 AS x FROM events WHERE type = 'delivery.completed'")).toBeTruthy();
    expect(r.warnings).toEqual([]);
  });

  it('is idempotent: delivering again changes nothing and creates no second PR', async () => {
    const c = lab.candidate('widget v1\n');
    const first = await deliver(input(c));
    const second = await deliver(input(c));
    expect(second.commit).toBe(first.commit);
    expect(lab.fake.state.creates).toBe(1);
    expect(lab.fake.state.prs).toHaveLength(1);
    expect(lab.ledger().list(lab.runId)).toHaveLength(3);
  });

  it('opens a ready PR when configured, and warns when an adopted PR disagrees', async () => {
    lab.cleanup();
    lab = makeLab({ tweak: (cfg) => void (cfg.delivery.pull_request = 'ready') });
    const c = lab.candidate('x');
    expect((await deliver(input(c))).pr!.isDraft).toBe(false);
  });

  it('pushes the branch but opens no PR when delivery.pull_request is none', async () => {
    lab.cleanup();
    lab = makeLab({ tweak: (cfg) => void (cfg.delivery.pull_request = 'none') });
    const c = lab.candidate('x');
    const r = await deliver(input(c));
    expect(r.pr).toBeNull();
    expect(r.prSkipped).toMatch(/none/);
    expect(lab.fake.state.prs).toHaveLength(0);
    expect(lab.remoteSha(branch())).toBe(r.commit);
  });

  it('redacts secrets from the PR title and body', async () => {
    const c = lab.candidate('x');
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const r = await deliver(input(c, { report: { title: `Fix auth ${token}`, summary: `Used ${token} while testing` } }));
    expect(r.pr!.title).not.toContain(token);
    expect(r.pr!.body).not.toContain(token);
    expect(r.pr!.body).toContain('[REDACTED');
  });

  it('adopts a PR that already exists for the head branch instead of creating another', async () => {
    const c = lab.candidate('x');
    await deliver(input(c)); // pushes and opens the PR
    // A second run of the ledger on a fresh database file would not know about it; simulate by deleting only the create row.
    lab.db.run("DELETE FROM actions WHERE kind = 'pr_create'");
    const r = await deliver(input(c));
    expect(lab.fake.state.creates).toBe(1);
    expect(r.pr!.number).toBe(1);
  });

  it('refuses to adopt a closed PR: it neither reopens nor replaces it', async () => {
    const c = lab.candidate('x');
    await deliver(input(c));
    lab.fake.setPullRequestState(1, 'CLOSED');
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/CLOSED/) });
    expect(lab.fake.state.creates).toBe(1);
  });

  it('fails when the PR head does not show the delivered commit', async () => {
    const c = lab.candidate('x');
    lab.fake.setHead(branch(), 'f'.repeat(40));
    const t0 = lab.clock.now();
    await expect(deliver(input(c, { verifyAttempts: 3 }))).rejects.toMatchObject({ code: 'DELIVERY_FAILED', message: expect.stringMatching(/not the delivered/) });
    expect(lab.clock.now() - t0).toBeGreaterThan(0);
  });
});

describe('scenario 8: a lost PR response still results in exactly one PR', () => {
  it('create succeeds remotely but the response is lost: reconcile finds it', async () => {
    const c = lab.candidate('x');
    lab.fake.setFaults({ loseCreateResponse: 1 });
    const r = await deliver(input(c));
    expect(lab.fake.state.creates).toBe(1);
    expect(lab.fake.state.prs).toHaveLength(1);
    expect(r.pr!.number).toBe(1);
    const create = lab.ledger().find(`deliver:${lab.runId}:pr-create:${branch()}`)!;
    expect(create).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
    expect(lab.db.get("SELECT 1 AS x FROM events WHERE type = 'action.unknown'")).toBeTruthy();
    expect(lab.db.get("SELECT 1 AS x FROM events WHERE type = 'action.reconciled'")).toBeTruthy();
  });

  it('the ledger fault point lose-response is honoured', async () => {
    const c = lab.candidate('x');
    faults('delivery.pr_create.after-execute=lose-response');
    const r = await deliver(input(c));
    expect(lab.fake.state.creates).toBe(1);
    expect(r.pr!.number).toBe(1);
    expect(lab.ledger().find(`deliver:${lab.runId}:pr-create:${branch()}`)!.attempts).toBe(1);
  });

  it('the controller dies right after the create; a restarted controller (new ledger, reopened database) opens no second PR', async () => {
    const c = lab.candidate('x');
    faults('delivery.pr_create.after-execute=throw');
    await expect(deliver(input(c))).rejects.toThrow(/fault injected/);
    expect(lab.fake.state.prs).toHaveLength(1);
    expect(lab.ledger().find(`deliver:${lab.runId}:pr-create:${branch()}`)!.state).toBe('EXECUTING');

    faults('');
    const reopened = openDb(lab.db.path);
    try {
      const restarted = new ActionLedger(reopened, lab.clock, { backoffMs: () => 10 });
      const r = await deliver(input(c, { ledger: restarted }));
      expect(r.pr!.number).toBe(1);
      expect(lab.fake.state.creates).toBe(1);
      expect(lab.fake.state.prs).toHaveLength(1);
      expect(restarted.list(lab.runId).map((a) => a.state)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
      expect(reopened.all('SELECT id FROM actions')).toHaveLength(3);
    } finally {
      reopened.close();
    }
  });

  it('the controller dies before the create was sent; the restart creates it once', async () => {
    const c = lab.candidate('x');
    faults('delivery.pr_create.before-execute=throw');
    await expect(deliver(input(c))).rejects.toThrow(/fault injected/);
    expect(lab.fake.state.prs).toHaveLength(0);
    faults('');
    const r = await deliver(input(c, { ledger: lab.ledger() }));
    expect(r.pr!.number).toBe(1);
    expect(lab.fake.state.creates).toBe(1);
  });

  it('the PR was created, the response lost, and the reconciling read is rate limited too: the call stops, a later one adopts it', async () => {
    const c = lab.candidate('x');
    lab.fake.setFaults({ loseCreateResponse: 1 });
    // While the ledger waits after the lost response, the host starts rate limiting reads.
    const clock = Object.create(lab.clock) as typeof lab.clock;
    clock.sleep = async (ms: number) => {
      lab.fake.setFaults({ rateLimit: 1, rateLimitRetryAfterMs: 1000 });
      await lab.clock.sleep(ms);
    };
    await expect(deliver(input(c, { ledger: new ActionLedger(lab.db, clock, { backoffMs: () => 10 }) }))).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    // Never a blind retry: the create was not repeated while its outcome was unknown.
    expect(lab.fake.state.creates).toBe(1);
    expect(lab.ledger().find(`deliver:${lab.runId}:pr-create:${branch()}`)).toMatchObject({ state: 'UNKNOWN', attempts: 1 });

    const r = await deliver(input(c, { ledger: lab.ledger() }));
    expect(r.pr!.number).toBe(1);
    expect(lab.fake.state.creates).toBe(1);
    expect(lab.fake.state.prs).toHaveLength(1);
  });
});

describe('push reconciliation', () => {
  it('the push succeeded but the receipt was lost: reconciled by ls-remote, not pushed again', async () => {
    const c = lab.candidate('x');
    faults('delivery.push.after-execute=lose-response');
    const r = await deliver(input(c));
    const push = lab.ledger().list(lab.runId, { kind: 'push' })[0]!;
    expect(push).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
    expect(lab.remoteSha(branch())).toBe(r.commit);
    expect(r.pr).not.toBeNull();
  });

  it('the controller died mid-push; the restart reconciles against the remote', async () => {
    const c = lab.candidate('x');
    faults('delivery.push.after-execute=throw');
    await expect(deliver(input(c))).rejects.toThrow(/fault injected/);
    const commit = lab.ledger().list(lab.runId, { kind: 'commit' })[0]!.receipt as { commit: string };
    expect(lab.remoteSha(branch())).toBe(commit.commit);
    expect(lab.ledger().list(lab.runId, { kind: 'push' })[0]!.state).toBe('EXECUTING');

    faults('');
    const r = await deliver(input(c, { ledger: lab.ledger() }));
    expect(lab.ledger().list(lab.runId, { kind: 'push' })[0]).toMatchObject({ state: 'SUCCEEDED', attempts: 1 });
    expect(r.commit).toBe(commit.commit);
  });

  it('the controller died before pushing; the restart pushes once', async () => {
    const c = lab.candidate('x');
    faults('delivery.push.before-execute=throw');
    await expect(deliver(input(c))).rejects.toThrow(/fault injected/);
    expect(lab.remoteSha(branch())).toBeNull();
    faults('');
    const r = await deliver(input(c, { ledger: lab.ledger() }));
    expect(lab.remoteSha(branch())).toBe(r.commit);
    expect(lab.ledger().list(lab.runId, { kind: 'push' })[0]!.attempts).toBe(2);
  });

  it('a commit whose receipt was lost is found again through its pinned ref', async () => {
    const c = lab.candidate('x');
    faults('delivery.commit.after-execute=throw');
    await expect(deliver(input(c))).rejects.toThrow(/fault injected/);
    faults('');
    const r = await deliver(input(c, { ledger: lab.ledger() }));
    expect(git(lab.work, ['rev-parse', `${r.commit}^{tree}`])).toBe(c.treeHash);
    expect(lab.ledger().list(lab.runId, { kind: 'commit' })).toHaveLength(1);
  });
});

describe('scenario 10: stale evidence cannot authorize delivery', () => {
  it('refuses a tree that changed by one byte after review, before anything is persisted or pushed', async () => {
    const reviewed = lab.candidate('exact reviewed content\n');
    const changed = lab.candidate('exact reviewed content!\n'); // one byte differs
    expect(changed.treeHash).not.toBe(reviewed.treeHash);
    await expect(
      deliver(input(changed, { evidence: lab.evidenceFor(reviewed), review: lab.reviewFor(reviewed) })),
    ).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(lab.ledger().list(lab.runId)).toHaveLength(0);
    expect(lab.remoteSha(branch())).toBeNull();
    expect(lab.fake.state.calls).toEqual([]);
  });

  it('refuses when the worktree was re-captured and no longer has the reviewed tree', async () => {
    const reviewed = lab.candidate('a');
    const other = lab.candidate('b');
    await expect(deliver(input(reviewed, { currentTree: other.treeHash }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/worktree now has tree/) });
    expect(lab.remoteSha(branch())).toBeNull();
  });

  it('refuses a candidate record whose commit carries a different tree than the one reviewed', async () => {
    const reviewed = lab.candidate('a');
    const other = lab.candidate('b');
    const lying = { ...reviewed, commitSha: other.commitSha };
    await expect(deliver(input(lying))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(lab.ledger().list(lab.runId)).toHaveLength(0);
  });

  it('refuses failing evidence and a non-approving review', async () => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { evidence: lab.evidenceFor(c, { verdict: 'FAIL' }) }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    await expect(deliver(input(c, { review: lab.reviewFor(c, { verdict: 'REQUEST_CHANGES' }) }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(lab.ledger().list(lab.runId)).toHaveLength(0);
  });

  it('re-checks before every external action: evidence invalidated after the push stops the PR', async () => {
    const c = lab.candidate('a');
    const evidence = lab.evidenceFor(c);
    const ledger = lab.ledger();
    // Evidence that is valid until the push has landed, then is invalidated (a later check run, say).
    const live = {
      ...evidence,
      get verdict(): string {
        return ledger.list(lab.runId, { kind: 'push', state: 'SUCCEEDED' }).length > 0 ? 'FAIL' : 'PASS';
      },
    };
    await expect(deliver(input(c, { evidence: live, ledger }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/not PASS/) });
    expect(ledger.list(lab.runId).map((a) => `${a.kind}:${a.state}`)).toEqual(['commit:SUCCEEDED', 'push:SUCCEEDED']);
    expect(lab.fake.state.creates).toBe(0);
    expect(ledger.list(lab.runId, { kind: 'pr_create' })).toHaveLength(0);
  });

  it('refuses after a durable cancellation', async () => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { run: { ...lab.deliveryRun, cancelRequested: true } }))).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('refuses a policy snapshot that does not match the run record', async () => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { run: { ...lab.deliveryRun, policyHash: `sha256:${'0'.repeat(64)}` } }))).rejects.toMatchObject({ code: 'POLICY_TAMPERED' });
  });
});

describe('branch and authorization protections', () => {
  it.each(['main', 'feature/x', 'orbit/', 'refs/heads/orbit/x', 'orbit/a..b'])('never pushes %j', async (name) => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { run: { ...lab.deliveryRun, branch: name } }))).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(lab.ledger().list(lab.runId)).toHaveLength(0);
    expect(lab.remoteSha('main')).toBe(lab.base);
    expect(lab.remoteSha('feature/x')).toBeNull();
  });

  it('defaults the branch to <prefix><run id>', async () => {
    const c = lab.candidate('a');
    const r = await deliver(input(c, { run: { ...lab.deliveryRun, branch: null } }));
    expect(r.branch).toBe(`orbit/${lab.runId}`);
  });

  it('does nothing in a mode that does not authorize commits', async () => {
    lab.cleanup();
    lab = makeLab({ mode: 'autonomous' });
    const c = lab.candidate('a');
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/committing/) });
    expect(lab.ledger().list(lab.runId)).toHaveLength(0);
  });

  it('commits locally but does not push when push_task_branch is off', async () => {
    lab.cleanup();
    lab = makeLab({ tweak: (cfg) => void (cfg.actions.push_task_branch = false) });
    const c = lab.candidate('a');
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/pushing/) });
    expect(lab.remoteSha(branch())).toBeNull();
    expect(kinds()).toEqual(['commit:SUCCEEDED']);
  });

  it('pushes but skips the PR when open_pull_request is off', async () => {
    lab.cleanup();
    lab = makeLab({ tweak: (cfg) => void (cfg.actions.open_pull_request = false) });
    const c = lab.candidate('a');
    const r = await deliver(input(c));
    expect(r.pr).toBeNull();
    expect(r.prSkipped).toMatch(/open_pull_request/);
    expect(lab.fake.state.calls).toEqual([]);
  });

  it('refuses a remote host that network.allowed_hosts does not list, before pushing', async () => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { remote: 'https://evil.example/acme/app.git' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/remote/) });
    expect(lab.remoteSha(branch())).toBeNull();
  });
});

describe('authentication and rate limits', () => {
  it('expired credentials block with AUTH_EXPIRED and the PR create is not retried', async () => {
    const c = lab.candidate('a');
    lab.fake.setFaults({ authExpired: true });
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    // Exactly one call reached the host: the find-before-create, which was refused.
    expect(lab.fake.state.calls).toEqual(['findPullRequest']);
    expect(lab.ledger().list(lab.runId, { kind: 'pr_create' })[0]).toMatchObject({ state: 'FAILED', attempts: 1 });
    // The branch was pushed with the controller's own credentials before the PR step; nothing else happened.
    expect(lab.fake.state.prs).toHaveLength(0);
  });

  it('after credentials are renewed, a resumed delivery completes with one PR', async () => {
    const c = lab.candidate('a');
    lab.fake.setFaults({ authExpired: true });
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
    lab.fake.setFaults({ authExpired: false });
    const r = await deliver(input(c, { ledger: lab.ledger() }));
    expect(r.pr!.number).toBe(1);
    expect(lab.fake.state.creates).toBe(1);
    expect(lab.ledger().list(lab.runId, { kind: 'pr_create' })[0]!.attempts).toBe(2);
  });

  it('a rate limit is waited out using the retry-after hint, then succeeds once', async () => {
    const c = lab.candidate('a');
    lab.fake.setFaults({ rateLimit: 1, rateLimitRetryAfterMs: 7000 });
    const t0 = lab.clock.now();
    const r = await deliver(input(c));
    expect(r.pr!.number).toBe(1);
    expect(lab.fake.state.creates).toBe(1);
    expect(lab.clock.now() - t0).toBeGreaterThanOrEqual(7000);
  });

  it('persistent rate limiting exhausts the bounded attempts and leaves the action UNKNOWN', async () => {
    const c = lab.candidate('a');
    lab.fake.setFaults({ rateLimit: 100, rateLimitRetryAfterMs: 1000 });
    await expect(deliver(input(c, { ledger: lab.ledger({ maxAttempts: 2 }) }))).rejects.toMatchObject({ code: 'PROVIDER_TRANSIENT' });
    const create = lab.ledger().list(lab.runId, { kind: 'pr_create' })[0]!;
    // Never a blind retry: the failed reconcile read stopped the loop with the action still unresolved.
    expect(create.state).toBe('UNKNOWN');
    expect(create.attempts).toBe(1);
    expect(lab.fake.state.prs).toHaveLength(0);
  });
});

describe('repair cycles', () => {
  it('delivers a repaired candidate as a fast-forward on the same branch and updates the same PR', async () => {
    const first = lab.candidate('v1\n');
    const r1 = await deliver(input(first));
    const second = lab.candidate('v2\n');
    const r2 = await deliver(input(second, { report: { title: 'Add the acme widget', summary: 'Second attempt after a CI failure.' } }));

    expect(r2.commit).not.toBe(r1.commit);
    expect(git(lab.work, ['rev-parse', `${r2.commit}^`])).toBe(r1.commit);
    expect(git(lab.work, ['rev-parse', `${r2.commit}^{tree}`])).toBe(second.treeHash);
    expect(lab.remoteSha(branch())).toBe(r2.commit);
    expect(lab.fake.state.prs).toHaveLength(1);
    expect(lab.fake.state.creates).toBe(1);
    expect(lab.fake.state.updates).toBe(1);
    expect(r2.pr!.body).toContain('Second attempt');
    expect(r2.pr!.headRefOid).toBe(r2.commit);
  });

  it('a repair cycle that reproduces an earlier delivered tree makes a new fast-forward commit instead of reusing the old one', async () => {
    const first = lab.candidate('v1\n');
    const r1 = await deliver(input(first));
    const r2 = await deliver(input(lab.candidate('v2\n')));
    // The third attempt lands on exactly the first tree again. Reusing the first commit would push a non-fast-forward.
    const again = lab.candidate('v1\n');
    expect(again.treeHash).toBe(first.treeHash);
    const r3 = await deliver(input(again));

    expect(r3.commit).not.toBe(r1.commit);
    expect(r3.commit).not.toBe(r2.commit);
    expect(git(lab.work, ['rev-parse', `${r3.commit}^`])).toBe(r2.commit);
    expect(git(lab.work, ['rev-parse', `${r3.commit}^{tree}`])).toBe(first.treeHash);
    expect(lab.remoteSha(branch())).toBe(r3.commit);
    // The remote history is a straight line r1 -> r2 -> r3.
    expect(git(lab.remote, ['rev-list', '--first-parent', `refs/heads/${branch()}`]).split('\n').slice(0, 3)).toEqual([r3.commit, r2.commit, r1.commit]);
    expect(lab.fake.state.prs).toHaveLength(1);
    expect(r3.pr!.headRefOid).toBe(r3.commit);
  });

  it('re-delivering the same tree after it was delivered is idempotent and does not add an empty commit', async () => {
    const c = lab.candidate('v1\n');
    const r1 = await deliver(input(c));
    const r2 = await deliver(input(c));
    expect(r2.commit).toBe(r1.commit);
    expect(lab.ledger().list(lab.runId, { kind: 'commit' })).toHaveLength(1);
    // Same again after an intermediate tree: the last delivery is idempotent too.
    const mid = await deliver(input(lab.candidate('v2\n')));
    const back = lab.candidate('v1\n');
    const r3 = await deliver(input(back));
    const r4 = await deliver(input(back));
    expect(r4.commit).toBe(r3.commit);
    expect(r3.commit).not.toBe(mid.commit);
    expect(lab.ledger().list(lab.runId, { kind: 'commit' })).toHaveLength(3);
  });
});

describe('freshness is re-read from the recorded state before every action', () => {
  it('refuses evidence whose recorded row was invalidated, even if the object in hand still says PASS', async () => {
    const c = lab.candidate('a');
    const evidence = lab.evidenceFor(c);
    lab.db.run("UPDATE evidence_reports SET invalidated_at = 1, invalidated_reason = 'check config changed' WHERE id = ?", evidence.id!);
    await expect(deliver(input(c, { evidence }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/invalidated/) });
    expect(lab.ledger().list(lab.runId)).toHaveLength(0);
    expect(lab.remoteSha(branch())).toBeNull();
  });

  it('refuses a review whose recorded row was invalidated', async () => {
    const c = lab.candidate('a');
    const review = lab.reviewFor(c);
    lab.db.run('UPDATE reviews SET invalidated_at = 1 WHERE id = ?', review.id!);
    await expect(deliver(input(c, { review }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(lab.remoteSha(branch())).toBeNull();
  });

  it('refuses evidence or a review with no recorded row at all', async () => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { evidence: { ...lab.evidenceFor(c), id: 'ev-missing' } }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/no recorded evidence/) });
    const { id: _ignored, ...noId } = lab.reviewFor(c);
    const withoutReviewRow = input(c, { review: noId });
    lab.db.run('DELETE FROM reviews');
    await expect(deliver(withoutReviewRow)).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/no recorded review/) });
    expect(lab.ledger().list(lab.runId)).toHaveLength(0);
  });

  it('evidence invalidated in the database while a retry waits stops the retry: no PR is created', async () => {
    const c = lab.candidate('a');
    const evidence = lab.evidenceFor(c);
    // The first create is rate limited; while delivery waits, a newer check run invalidates the evidence.
    lab.fake.setFaults({ rateLimit: 1, rateLimitRetryAfterMs: 5000 });
    const clock = Object.create(lab.clock) as typeof lab.clock;
    clock.sleep = async (ms: number) => {
      lab.db.run("UPDATE evidence_reports SET invalidated_at = 1, invalidated_reason = 'newer check run' WHERE id = ?", evidence.id!);
      await lab.clock.sleep(ms);
    };
    await expect(deliver(input(c, { evidence, ledger: new ActionLedger(lab.db, clock, { backoffMs: () => 10 }) }))).rejects.toMatchObject({ code: 'STALE_EVIDENCE' });
    expect(lab.fake.state.creates).toBe(0);
    expect(lab.fake.state.prs).toHaveLength(0);
  });

  it('a durable cancellation recorded after delivery started stops the next action', async () => {
    const c = lab.candidate('a');
    lab.fake.setFaults({ rateLimit: 1, rateLimitRetryAfterMs: 5000 });
    const clock = Object.create(lab.clock) as typeof lab.clock;
    clock.sleep = async (ms: number) => {
      lab.db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', lab.runId);
      await lab.clock.sleep(ms);
    };
    await expect(deliver(input(c, { ledger: new ActionLedger(lab.db, clock, { backoffMs: () => 10 }) }))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(lab.fake.state.creates).toBe(0);
  });
});

describe('network authorization covers the remote a name points at', () => {
  it('refuses a configured remote name whose URL names a host outside network.allowed_hosts', async () => {
    const c = lab.candidate('a');
    git(lab.work, ['remote', 'set-url', 'origin', 'https://evil.example/acme/app.git']);
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/remote/) });
    expect(lab.ledger().list(lab.runId, { kind: 'push' })).toHaveLength(0);
  });

  it('refuses an scp-style address without a user part', async () => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { remote: 'evil.example:acme/app.git' }))).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringMatching(/remote/) });
    expect(lab.ledger().list(lab.runId, { kind: 'push' })).toHaveLength(0);
  });

  it('refuses a remote name that does not resolve', async () => {
    const c = lab.candidate('a');
    await expect(deliver(input(c, { remote: 'nosuchremote' }))).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(lab.ledger().list(lab.runId, { kind: 'push' })).toHaveLength(0);
  });

  it('refuses a remote with a second push URL before pushing to either', async () => {
    const c = lab.candidate('a');
    const canary = join(lab.dir, 'canary.git');
    git(lab.dir, ['init', '--bare', '-b', 'main', canary]);
    // git remote get-url --push without --all prints only the first of these.
    git(lab.work, ['remote', 'set-url', '--add', '--push', 'origin', lab.remote]);
    git(lab.work, ['remote', 'set-url', '--add', '--push', 'origin', canary]);
    await expect(deliver(input(c))).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('2 push URLs') });
    expect(lab.ledger().list(lab.runId, { kind: 'push' })).toHaveLength(0);
    expect(lab.remoteSha(branch())).toBeNull();
    expect(() => git(canary, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch()}`])).toThrow();
  });

  it('pushes to and reads back from the validated URL itself, never through the remote name', async () => {
    const c = lab.candidate('a');
    const bin = join(lab.dir, 'logbin');
    const log = join(lab.dir, 'git-calls.log');
    mkdirSync(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexec '${realGit}' "$@"\n`);
    chmodSync(join(bin, 'git'), 0o755);
    vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`);
    try {
      const r = await deliver(input(c));
      expect(lab.remoteSha(branch())).toBe(r.commit);
    } finally {
      vi.unstubAllEnvs();
    }
    const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    const remoteCalls = calls.filter((l) => / (push|ls-remote) /.test(` ${l} `));
    expect(remoteCalls.length).toBeGreaterThan(0);
    for (const l of remoteCalls) {
      expect(l).toContain(` -- ${lab.remote} `);
      expect(l).not.toMatch(/ origin( |$)/);
    }
  });
});

describe('re-delivering the same commit with a changed report', () => {
  it('updates the PR each time instead of failing on a reused idempotency key', async () => {
    const c = lab.candidate('a');
    await deliver(input(c));
    await deliver(input(c, { report: { title: 'Add the acme widget', summary: 'Second report.' } }));
    const r = await deliver(input(c, { report: { title: 'Add the acme widget', summary: 'Third report.' } }));
    expect(r.pr!.body).toContain('Third report.');
    expect(lab.fake.state.updates).toBe(2);
    expect(lab.fake.state.creates).toBe(1);
  });
});
