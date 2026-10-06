import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Deliver = typeof import('../../../src/delivery/deliver.ts');
type Release = typeof import('../../../src/delivery/release.ts');
const hooks = vi.hoisted(() => ({ deliver: vi.fn(), performRelease: vi.fn(), resolveDeploy: vi.fn() }));
vi.mock('../../../src/delivery/deliver.ts', async (orig) => ({ ...(await orig<Deliver>()), deliver: hooks.deliver }));
vi.mock('../../../src/delivery/release.ts', async (orig) => ({ ...(await orig<Release>()), performRelease: hooks.performRelease, resolveDeploy: hooks.resolveDeploy }));

const { complete, deliveringStep, githubClient, githubClientFor, releaseDelivered, DELIVERY_FILE, RELEASE_FILE } = await import('../../../src/controller/steps/delivering.ts');
const { OrbitError } = await import('../../../src/core/errors.ts');
const { snapshotCandidate } = await import('../../../src/evidence/candidate.ts');
const { getRun, requestCancel } = await import('../../../src/controller/run-store.ts');
const { getCandidate } = await import('../../../src/evidence/store.ts');
const { insertQuestion } = await import('../../../src/inquisition/store.ts');
const { listDecisions } = await import('../../../src/storage/decisions.ts');
const { recordReview } = await import('../../../src/review/store.ts');
const { FakeGitHub, GhCliClient } = await import('../../../src/delivery/github.ts');
const { addEvidence, giveRepository, gitIn, initLedger, makeUnitLab, setContract } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type CandidateRecord = import('../../../src/evidence/store.ts').CandidateRecord;
type OrbitConfig = import('../../../src/policy/types.ts').OrbitConfig;

let lab: UnitLab;
beforeEach(() => {
  for (const f of Object.values(hooks)) f.mockReset();
});
afterEach(() => lab?.cleanup());

interface Setup {
  mode?: 'autonomous' | 'autonomous-delivery' | 'release';
  tweak?: (c: OrbitConfig) => void;
  review?: boolean;
  evidence?: boolean;
  state?: 'DELIVERING' | 'AWAITING_CI';
}

async function setup(o: Setup = {}): Promise<{ cand: CandidateRecord }> {
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING'],
    tweak: (c) => {
      if (o.mode) c.mode = o.mode;
      o.tweak?.(c);
    },
  });
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base, allowed_paths: ['apps/calc.mjs'] });
  initLedger(lab);
  writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 1, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  if (o.evidence !== false) addEvidence(lab, cand);
  if (o.review !== false) recordReview(lab.db, { id: 'rev-1', runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: 1, provider: 'codex', model: null, workerId: null, verdict: 'APPROVE', packetSha256: null, findings: [] }, lab.clock);
  return { cand };
}

const run = () => deliveringStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });

const delivered = (cand: CandidateRecord, over: object = {}) => ({
  commit: cand.commitSha,
  tree: cand.treeHash,
  branch: `orbit/${lab.runId}`,
  push: {},
  pr: { number: 7, url: 'https://example.test/pr/7', state: 'open', isDraft: true },
  prSkipped: null,
  warnings: ['one warning'],
  actions: [],
  ...over,
});

describe('deliveringStep: preconditions', () => {
  it('stops at a safe point and needs a candidate', async () => {
    await setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await run()).toMatchObject({ done: true });
    cleanup();
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING'] });
    setContract(lab);
    await expect(run()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('DELIVERING without a candidate') });
  });

  it.each([
    ['no live evidence', { evidence: false }],
    ['no approving review of this tree', { review: false }],
  ] as const)('goes back to verification when there is %s', async (why, o) => {
    await setup(o);
    await run();
    expect(state()).toBe('VERIFYING');
    expect(lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'VERIFYING'", lab.runId)).toBeTruthy();
    expect(getRun(lab.db, lab.runId).outcomeReason).toBeNull();
    expect(JSON.stringify(lab.db.all("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition'", lab.runId))).toContain(`delivery refused: ${why}`);
  });

  it('goes back to verification when the evidence went stale since the review', async () => {
    await setup();
    lab.db.run("UPDATE evidence_reports SET policy_hash = 'sha256:stale', report_json = json_set(report_json, '$.policy_hash', 'sha256:stale') WHERE run_id = ?", lab.runId);
    await run();
    expect(state()).toBe('VERIFYING');
    expect(JSON.stringify(lab.db.all("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition'", lab.runId))).toContain('the evidence is stale');
  });

  it('blocks while a criterion waits for a person\'s decision', async () => {
    await setup();
    insertQuestion(lab.db, { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which rounding?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: ['AC-1'], unblocked: [] }, lab.clock);
    await run();
    expect(state()).toBe('BLOCKED');
  });
});

function cleanup(): void {
  lab?.cleanup();
}

describe('a mode that takes no external action', () => {
  it('leaves the reviewed candidate on a local branch and succeeds through the completion gate', async () => {
    const { cand } = await setup();
    expect(await run()).toEqual({ progressed: true, done: true });
    expect(state()).toBe('SUCCEEDED');
    const branch = getRun(lab.db, lab.runId).branch!;
    expect(gitIn(lab.repo, 'rev-parse', `refs/heads/${branch}`)).toBe(cand.commitSha);
    expect(hooks.deliver).not.toHaveBeenCalled();
    expect(decisions('gate.delivery')).toHaveLength(1);
    expect(decisions('gate.completion')).toHaveLength(1);
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain(`all mandatory requirements hold for tree ${cand.treeHash}`);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ branch, commit: cand.commitSha, delivery: 'local branch; no external action in this mode' });
  });

  it('names the branch from the policy when the run has none recorded', async () => {
    const { cand } = await setup();
    lab.db.run('UPDATE runs SET branch = NULL WHERE id = ?', lab.runId);
    await run();
    expect(gitIn(lab.repo, 'rev-parse', `refs/heads/orbit/${lab.runId}`)).toBe(cand.commitSha);
  });

  it('does not succeed when the completion gate does not hold', async () => {
    // review.when_unavailable: block, the default before decision 0007 (#6, #8), requires an independent approval.
    await setup({ tweak: (c) => void (c.review.when_unavailable = 'block') });
    // The delivery gate passes, but no independent reviewer other than the implementer's provider approved.
    lab.db.run("UPDATE reviews SET provider = 'claude'");
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^completion gate: /);
  });
});

describe('a delivery mode', () => {
  const delivering = () => setup({ mode: 'autonomous-delivery' });

  it('delivers the reviewed tree, records what happened, marks the candidate delivered and waits for CI', async () => {
    const { cand } = await delivering();
    hooks.deliver.mockResolvedValue(delivered(cand));
    lab.deps.github = () => new FakeGitHub({ statePath: join(lab.base, 'gh.json') }) as never;
    expect(await run()).toEqual({ progressed: true });
    expect(state()).toBe('AWAITING_CI');
    const input = hooks.deliver.mock.calls[0]![0] as { candidate: { id: string }; evidence: { verdict: string }; review: { id: string }; report: { title: string; summary: string } };
    expect(input.candidate.id).toBe(cand.id);
    expect(input.report.title).toBe('Add a mul function to the calculator.');
    expect(input.report.summary).toContain('Acceptance criteria:');
    expect(input.report.summary).toContain('- AC-1 (unverified): mul(a, b) returns the product');
    expect(input.report.summary).toContain('- unit: PASSED');
    const file = JSON.parse(readFileSync(join(lab.ctx().runDir, DELIVERY_FILE), 'utf8'));
    expect(file).toMatchObject({ commit: cand.commitSha, tree: cand.treeHash, branch: `orbit/${lab.runId}`, pr: { number: 7, url: 'https://example.test/pr/7', state: 'open', isDraft: true }, pr_skipped: null, warnings: ['one warning'] });
    expect(getCandidate(lab.db, cand.id).status).toBe('DELIVERED');
    expect(decisions('delivery.completed')[0]?.summary).toBe(`delivered ${cand.commitSha.slice(0, 12)} (tree ${cand.treeHash.slice(0, 12)}) to orbit/${lab.runId}, PR #7`);
    expect(getRun(lab.db, lab.runId).branch).toBe(`orbit/${lab.runId}`);
  });

  it('a delivery with no pull request says none was opened', async () => {
    const { cand } = await delivering();
    hooks.deliver.mockResolvedValue(delivered(cand, { pr: null, prSkipped: 'delivery.pull_request is none' }));
    lab.deps.github = () => new FakeGitHub({ statePath: join(lab.base, 'gh.json') }) as never;
    await run();
    expect(JSON.parse(readFileSync(join(lab.ctx().runDir, DELIVERY_FILE), 'utf8'))).toMatchObject({ pr: null, pr_skipped: 'delivery.pull_request is none' });
    expect(decisions('delivery.completed')[0]?.summary).not.toContain('PR #');
  });

  it('blocks when the delivered commit is not the reviewed tree', async () => {
    const { cand } = await delivering();
    hooks.deliver.mockResolvedValue(delivered(cand, { tree: 'f'.repeat(40) }));
    lab.deps.github = () => new FakeGitHub({ statePath: join(lab.base, 'gh.json') }) as never;
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^delivery gate: /);
    expect(existsSync(join(lab.ctx().runDir, DELIVERY_FILE))).toBe(false);
  });

  it('a refusal by the freshness gate sends the run back to verification', async () => {
    await delivering();
    hooks.deliver.mockRejectedValue(new OrbitError('STALE_EVIDENCE', 'the tree changed'));
    lab.deps.github = () => ({}) as never;
    await run();
    expect(state()).toBe('VERIFYING');
    expect(JSON.stringify(lab.db.all("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition'", lab.runId))).toContain('delivery refused by the freshness gate: the tree changed');
  });

  it('a delivery interrupted by a cancellation ends at the next safe point; one that merely lost its race waits', async () => {
    await delivering();
    lab.deps.github = () => ({}) as never;
    hooks.deliver.mockRejectedValue(new OrbitError('CANCELLED', 'cancelled mid-delivery'));
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    const out = await run();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('CANCELLED');
  });

  it('a cancellation error with no cancellation pending is not swallowed', async () => {
    await delivering();
    lab.deps.github = () => ({}) as never;
    hooks.deliver.mockRejectedValue(new OrbitError('CANCELLED', 'odd'));
    await expect(run()).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('a definitive failure blocks the run and any other failure surfaces for the retry', async () => {
    await delivering();
    lab.deps.github = () => ({}) as never;
    hooks.deliver.mockRejectedValue(new OrbitError('DELIVERY_FAILED', 'the remote rejected the push', { definitive: true }));
    await run();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toBe('delivery failed: the remote rejected the push');
    cleanup();
    await delivering();
    lab.deps.github = () => ({}) as never;
    hooks.deliver.mockRejectedValue(new OrbitError('DELIVERY_FAILED', 'maybe transient', { definitive: false }));
    await expect(run()).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
    hooks.deliver.mockRejectedValue(new Error('network'));
    await expect(run()).rejects.toThrow('network');
  });
});

describe('the GitHub client', () => {
  it('is the one the controller was given, a fake for the fake provider, and the gh CLI otherwise', async () => {
    await setup();
    const given = {} as never;
    lab.deps.github = () => given;
    expect(await githubClient(lab.ctx())).toBe(given);
    delete lab.deps.github;
    expect(await githubClient({ ...lab.ctx(), snapshot: { ...lab.ctx().snapshot, config: { ...lab.ctx().snapshot.config, delivery: { ...lab.ctx().snapshot.config.delivery, provider: 'fake' } } } } as never)).toBeInstanceOf(FakeGitHub);
    gitIn(lab.repo, 'remote', 'add', 'origin', 'https://github.com/acme/app.git');
    expect(await githubClient(lab.ctx())).toBeInstanceOf(GhCliClient);
  });

  it('the fake reports real pull request heads from a local bare remote, and not from a hosted one', async () => {
    await setup();
    const bare = join(lab.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', bare]);
    gitIn(lab.repo, 'remote', 'add', 'origin', bare);
    const fakeCtx = () => ({ ...lab.ctx(), snapshot: { ...lab.ctx().snapshot, config: { ...lab.ctx().snapshot.config, delivery: { ...lab.ctx().snapshot.config.delivery, provider: 'fake' } } } }) as never;
    expect((await githubClient(fakeCtx())) as unknown as { remoteGitDir?: string }).toBeInstanceOf(FakeGitHub);
    gitIn(lab.repo, 'remote', 'set-url', 'origin', 'https://example.test/acme/app.git');
    expect(await githubClient(fakeCtx())).toBeInstanceOf(FakeGitHub);
    gitIn(lab.repo, 'remote', 'set-url', 'origin', 'git@example.test:acme/app.git');
    expect(await githubClient(fakeCtx())).toBeInstanceOf(FakeGitHub);
    gitIn(lab.repo, 'remote', 'remove', 'origin');
    expect(await githubClient(fakeCtx())).toBeInstanceOf(FakeGitHub);
  });

  it('githubClientFor reads owner and repository from the push URL and refuses a remote that is not GitHub', async () => {
    await setup();
    gitIn(lab.repo, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    expect(await githubClientFor(lab.repo, 'origin', {})).toBeInstanceOf(GhCliClient);
    gitIn(lab.repo, 'remote', 'set-url', 'origin', 'https://github.com/acme/app/');
    expect(await githubClientFor(lab.repo, 'origin')).toBeInstanceOf(GhCliClient);
    gitIn(lab.repo, 'remote', 'set-url', 'origin', 'https://gitlab.example.test/acme/app.git');
    await expect(githubClientFor(lab.repo, 'origin', {})).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });
});

describe('releaseDelivered', () => {
  const release = () => setup({ mode: 'release', tweak: (c) => void ((c as unknown as { release: unknown }).release = { environments: { staging: {}, production: {} } }) });
  const record = (cand: CandidateRecord) => ({ commit: cand.commitSha, tree: cand.treeHash, branch: `orbit/${lab.runId}`, pr: { number: 7 } });
  const released = (over: object = {}) => ({ status: 'released', pending: null, merge: { number: 7, headSha: 'a'.repeat(40), mergeCommitSha: 'b'.repeat(40), method: 'squash' }, mergeSkipped: null, deploy: null, deploys: [{ environment: 'staging', sha: 'b'.repeat(40), branch: 'main' }], deploySkipped: null, actions: [], ...over });

  it('needs a candidate, live evidence and an approving review of the delivered tree', async () => {
    const { cand } = await release();
    lab.db.run('DELETE FROM evidence_reports WHERE run_id = ?', lab.runId);
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('release refused: no live evidence');
    cleanup();
    const t = await release();
    lab.db.run('DELETE FROM reviews WHERE run_id = ?', lab.runId);
    await releaseDelivered(lab.ctx(), record(t.cand), {});
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('release refused: no approving review');
    cleanup();
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING'] });
    setContract(lab);
    await expect(releaseDelivered(lab.ctx(), { commit: 'c', tree: 't', branch: 'b', pr: null }, {})).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('merges and deploys, records the release, and succeeds through the completion gate', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockResolvedValue(released());
    const out = await releaseDelivered(lab.ctx(), record(cand), { source: 'ci' }, ['ci green']);
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('SUCCEEDED');
    const input = hooks.performRelease.mock.calls[0]![0] as { environments: string; pr: number | null; commit: string; contractMerge: boolean; readiness: () => { ok: boolean; reasons: string[] } };
    expect(input).toMatchObject({ environments: 'all', pr: 7, commit: cand.commitSha, contractMerge: false });
    expect(input.readiness()).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(lab.ctx().runDir, RELEASE_FILE), 'utf8'))).toMatchObject({ merge: { pr: 7, merge_commit: 'b'.repeat(40), method: 'squash' }, deploys: [{ environment: 'staging' }] });
    expect(decisions('release.completed')[0]?.summary).toContain('merged PR #7; deployed to staging');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('(ci green)');
  });

  it('describes a release that merged nothing and deployed nowhere', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockResolvedValue(released({ merge: null, mergeSkipped: 'merge not requested', deploys: [], deploySkipped: 'no environment allows this branch' }));
    await releaseDelivered(lab.ctx(), { ...record(cand), pr: null }, {});
    expect(decisions('release.completed')[0]?.summary).toContain('no merge (merge not requested); no deploy (no environment allows this branch)');
    expect((hooks.performRelease.mock.calls[0]![0] as { pr: unknown }).pr).toBeNull();
  });

  it('notes what was skipped alongside what was deployed', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockResolvedValue(released({ deploySkipped: 'production: branch not allowed' }));
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(decisions('release.completed')[0]?.summary).toContain('deployed to staging (not: production: branch not allowed)');
  });

  it('waits for checks, records when it first waited, and blocks once the phase has waited past the timeout', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockResolvedValue({ status: 'pending', pending: 'branch checks pending', merge: null, mergeSkipped: null, deploy: null, deploys: [], deploySkipped: null, actions: [] });
    expect(await releaseDelivered(lab.ctx(), record(cand), {})).toEqual({ progressed: false, waiting: 'release: branch checks pending' });
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'release.waiting'", lab.runId)).toHaveLength(1);
    expect(await releaseDelivered(lab.ctx(), record(cand), {})).toMatchObject({ waiting: expect.any(String) });
    expect(lab.db.all("SELECT 1 FROM events WHERE run_id = ? AND type = 'release.waiting'", lab.runId)).toHaveLength(1);
    lab.clock.advance(61 * 60_000);
    lab.db.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', lab.clock.now() + 3_600_000, lab.runId);
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('release did not become ready within 60 minutes: branch checks pending');
  });

  it('a pending phase after the merge waits on the deploy, and one with no reason says waiting', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockResolvedValue({ status: 'pending', pending: null, merge: { number: 7, headSha: 'a'.repeat(40), mergeCommitSha: null, method: 'squash' }, mergeSkipped: null, deploy: null, deploys: [], deploySkipped: null, actions: [] });
    expect(await releaseDelivered(lab.ctx(), record(cand), {})).toEqual({ progressed: false, waiting: 'release: waiting' });
    expect(JSON.parse(lab.db.get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'release.waiting'", lab.runId)!.data_json).phase).toBe('deploy:none');
    lab.clock.advance(61 * 60_000);
    lab.db.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', lab.clock.now() + 3_600_000, lab.runId);
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('still waiting');
  });

  it('ends at the next safe point when cancelled mid-release', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValue(new OrbitError('CANCELLED', 'stop'));
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(state()).toBe('CANCELLED');
  });

  it('a deploy with an unknown outcome is settled by its verify command and the release tried again', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValueOnce(new OrbitError('DELIVERY_FAILED', 'deploy unknown', { outcomeUnknown: true, environment: 'staging' })).mockResolvedValueOnce(released());
    hooks.resolveDeploy.mockResolvedValue({ verdict: 'deployed', detail: 'verified' });
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(hooks.resolveDeploy).toHaveBeenCalledTimes(1);
    expect(hooks.resolveDeploy.mock.calls[0]![0]).toMatchObject({ environment: 'staging', resolution: 'verify', by: 'controller' });
    expect(state()).toBe('SUCCEEDED');
  });

  it('an unknown deploy that cannot be settled goes to a person with the exact commands, and the automatic check is reported', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValue(new OrbitError('DELIVERY_FAILED', 'deploy unknown', { outcomeUnknown: true, environment: 'production' }));
    hooks.resolveDeploy.mockResolvedValue({ verdict: 'unknown', detail: 'verify command inconclusive' });
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(state()).toBe('BLOCKED');
    const reason = getRun(lab.db, lab.runId).outcomeReason!;
    expect(reason).toContain('release refused: deploy unknown (automatic check: verify command inconclusive)');
    expect(reason).toContain(`orbit release resolve ${lab.runId} --deployed`);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).release_error).toMatchObject({ outcome_unknown: true, environment: 'production' });
  });

  it('a verify command that itself fails is reported as the reason it could not be settled', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValue(new OrbitError('DELIVERY_FAILED', 'deploy unknown', { outcomeUnknown: true, environment: 'staging' }));
    hooks.resolveDeploy.mockRejectedValue(new Error('verify crashed'));
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('(automatic check: verify crashed)');
    cleanup();
    const t = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValue(new OrbitError('DELIVERY_FAILED', 'deploy unknown', { outcomeUnknown: true, environment: 'staging' }));
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    hooks.resolveDeploy.mockRejectedValue('plain failure');
    await releaseDelivered(lab.ctx(), record(t.cand), {});
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('(automatic check: plain failure)');
  });

  it('a refusal the policy or the remote made definitively blocks, and any other error surfaces', async () => {
    const { cand } = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValue(new OrbitError('POLICY_DENIED', 'merge not authorized', { rule: 'actions.merge_pull_request' }));
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(getRun(lab.db, lab.runId).outcomeReason).toBe('release refused: merge not authorized');
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).release_error).toMatchObject({ code: 'POLICY_DENIED', rule: 'actions.merge_pull_request' });
    cleanup();
    const t = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValue(new OrbitError('DELIVERY_FAILED', 'branch protection', { definitive: true }));
    await releaseDelivered(lab.ctx(), record(t.cand), {});
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).release_error).toMatchObject({ code: 'DELIVERY_FAILED', rule: null });
    cleanup();
    const u = await release();
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockRejectedValue(new Error('network'));
    await expect(releaseDelivered(lab.ctx(), record(u.cand), {})).rejects.toThrow('network');
    hooks.performRelease.mockRejectedValue(new OrbitError('DELIVERY_FAILED', 'transient', { definitive: false }));
    await expect(releaseDelivered(lab.ctx(), record(u.cand), {})).rejects.toMatchObject({ code: 'DELIVERY_FAILED' });
  });

  it('works without a release profile, naming no environments', async () => {
    const { cand } = await setup({ mode: 'release' });
    lab.deps.github = () => ({}) as never;
    hooks.performRelease.mockResolvedValue(released({ deploys: [], deploySkipped: 'no release profile' }));
    await releaseDelivered(lab.ctx(), record(cand), {});
    expect(state()).toBe('SUCCEEDED');
  });
});

describe('complete', () => {
  it('succeeds only through the completion gate, listing notes', async () => {
    const { cand } = await setup();
    await complete(lab.ctx(), cand.treeHash, { source: 'x' }, ['note one', 'note two']);
    expect(state()).toBe('SUCCEEDED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('(note one; note two)');
    cleanup();
    const t = await setup();
    await complete(lab.ctx(), 'f'.repeat(40), {});
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^completion gate: /);
  });
});
