import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { resetFaults } from '../../../src/core/faults.ts';

type Release = typeof import('../../../src/delivery/release.ts');
type CandMod = typeof import('../../../src/evidence/candidate.ts');
type CleanupHook = (...args: Parameters<CandMod['cleanupCandidateCheckout']>) => boolean | Promise<boolean>;
const hooks = vi.hoisted(() => ({ performRelease: vi.fn(), cleanup: null as null | CleanupHook }));
vi.mock('../../../src/delivery/release.ts', async (orig) => ({ ...(await orig<Release>()), performRelease: hooks.performRelease }));
vi.mock('../../../src/evidence/candidate.ts', async (orig) => {
  const actual = await orig<CandMod>();
  return {
    ...actual,
    cleanupCandidateCheckout: async (...a: Parameters<CandMod['cleanupCandidateCheckout']>) => {
      if (hooks.cleanup && (await hooks.cleanup(...a))) return;
      return actual.cleanupCandidateCheckout(...a);
    },
  };
});

const { awaitingCiStep, baseConflict, baseMovement } = await import('../../../src/controller/steps/awaiting-ci.ts');
const { amendBaseline } = await import('../../../src/controller/steps/baseline-amendment.ts');
const { DELIVERY_FILE } = await import('../../../src/controller/steps/delivering.ts');
const { briefPath } = await import('../../../src/controller/steps/implementing.ts');
const { getRun, requestCancel } = await import('../../../src/controller/run-store.ts');
const { snapshotCandidate } = await import('../../../src/evidence/candidate.ts');
const { BASELINE_FILE, runBaseline } = await import('../../../src/evidence/baseline.ts');
const { currentEvidenceReport, listCheckRuns } = await import('../../../src/evidence/store.ts');
const { listDecisions } = await import('../../../src/storage/decisions.ts');
const { recordReview } = await import('../../../src/review/store.ts');
const { OrbitError } = await import('../../../src/core/errors.ts');
const { addEvidence, giveRepository, gitIn, initLedger, makeUnitLab, setContract } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type CandidateRecord = import('../../../src/evidence/store.ts').CandidateRecord;
type OrbitConfig = import('../../../src/policy/types.ts').OrbitConfig;
type CheckInfo = import('../../../src/delivery/github.ts').CheckInfo;

let lab: UnitLab;
function cleanup(): void {
  lab?.cleanup();
}
beforeEach(() => {
  hooks.performRelease.mockReset();
  hooks.cleanup = null;
});
afterEach(() => {
  delete process.env.ORBIT_FAULTS;
  resetFaults();
  lab?.cleanup();
});

const check = (name: string, bucket: CheckInfo['bucket'], runId: string | null = null): CheckInfo => ({ name, bucket, state: bucket.toUpperCase(), link: null, workflow: null, runId, jobId: null, startedAt: null, completedAt: null, description: null });

interface Checks {
  checks?: CheckInfo[];
  absent?: boolean;
  headSha?: string | null;
  logs?: { status: 'ok' | 'expired' | 'not-found'; text: string; failedSteps: { job: string; step: string }[] };
  error?: Error;
}
let ci: Checks = {};
const client = () => ({
  listChecks: async () => {
    if (ci.error) throw ci.error;
    return { checks: ci.checks ?? [], absent: ci.absent ?? (ci.checks ?? []).length === 0, headSha: ci.headSha ?? null };
  },
  failedLogs: async () => ci.logs ?? { status: 'ok', text: 'unit\tstep\t2026-01-01T00:00:00Z AssertionError: mul is not a function', failedSteps: [] },
});

interface Setup {
  mode?: 'autonomous-delivery' | 'release';
  tweak?: (c: OrbitConfig) => void;
  pr?: number | null;
}

async function setup(o: Setup = {}): Promise<{ cand: CandidateRecord }> {
  ci = {};
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING', 'DELIVERING', 'AWAITING_CI'],
    tweak: (c) => {
      c.mode = o.mode ?? 'autonomous-delivery';
      Object.assign(c.actions, { commit: true, push_task_branch: true, open_pull_request: true, read_ci_logs: true, repair_ci: true });
      o.tweak?.(c);
    },
  });
  lab.deps.github = (() => client()) as never;
  lab.deps.timing = { ...lab.deps.timing, ciAbsentGraceMs: 60_000 };
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base, allowed_paths: ['apps/calc.mjs'] });
  initLedger(lab);
  writeFileSync(join(repo.worktree, 'apps', 'calc.mjs'), 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n');
  const cand = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt: 1, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  addEvidence(lab, cand);
  recordReview(lab.db, { id: 'rev-1', runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: 1, provider: 'codex', model: null, workerId: null, verdict: 'APPROVE', packetSha256: null, findings: [] }, lab.clock);
  const pr = o.pr === undefined ? 7 : o.pr;
  writeFileSync(join(lab.ctx().runDir, DELIVERY_FILE), JSON.stringify({ commit: cand.commitSha, tree: cand.treeHash, branch: `orbit/${lab.runId}`, pr: pr === null ? null : { number: pr }, delivered_at: lab.clock.now() }));
  return { cand };
}

const run = () => awaitingCiStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const reason = () => getRun(lab.db, lab.runId).outcomeReason ?? '';
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });

/** Record the old-base baseline a real run has before it reaches AWAITING_CI. */
async function recordBaseline(baseRevision: string): Promise<void> {
  const ctx = lab.ctx();
  await runBaseline({
    db: lab.db,
    run: { id: lab.runId, policyHash: ctx.run.policyHash },
    repoRoot: lab.repo,
    baseRev: baseRevision,
    snapshot: ctx.snapshot,
    isolation: ctx.isolation(),
    runDir: ctx.runDir,
    clock: lab.clock,
    signal: ctx.signal,
    pollMs: ctx.timing.checkPollMs,
    killGraceMs: ctx.timing.killGraceMs,
  });
}

function baseline(): { baseRevision: string; baseTree: string; checkIds: string[] } {
  return JSON.parse(readFileSync(join(lab.ctx().runDir, BASELINE_FILE), 'utf8')) as { baseRevision: string; baseTree: string; checkIds: string[] };
}

describe('preconditions', () => {
  it('stops at a safe point and needs the delivery record and the ledger', async () => {
    await setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await run()).toMatchObject({ done: true });
    lab.cleanup();
    await setup();
    execFileSync('rm', [join(lab.ctx().runDir, DELIVERY_FILE)]);
    await expect(run()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('AWAITING_CI without a delivery record') });
  });
});

describe('what CI says', () => {
  it('green CI completes the run through the completion gate', async () => {
    const { cand } = await setup();
    ci.checks = [check('unit', 'pass'), check('lint', 'pass')];
    expect(await run()).toMatchObject({ done: true });
    expect(state()).toBe('SUCCEEDED');
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ ci: 'passed', commit: cand.commitSha, pr: 7, branch: `orbit/${lab.runId}` });
  });

  it('green CI of a delivery without a pull request records pr as null', async () => {
    await setup({ pr: null });
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).pr).toBeNull();
  });

  it('a green CI in release mode goes on to merge and deploy', async () => {
    const { cand } = await setup({ mode: 'release' });
    ci.checks = [check('unit', 'pass')];
    hooks.performRelease.mockResolvedValue({ status: 'released', pending: null, merge: { number: 7, headSha: cand.commitSha, mergeCommitSha: 'b'.repeat(40), method: 'squash' }, mergeSkipped: null, deploy: null, deploys: [], deploySkipped: 'no profile', actions: [] });
    await run();
    expect(hooks.performRelease).toHaveBeenCalledTimes(1);
    expect(state()).toBe('SUCCEEDED');
    expect(existsSync(join(lab.ctx().runDir, 'release.json'))).toBe(true);
  });

  it('a cancelled CI blocks the run until it is re-run', async () => {
    const { cand } = await setup();
    ci.checks = [check('unit', 'cancel')];
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toBe(`CI was cancelled on ${cand.commitSha.slice(0, 12)}; re-run it and resume the run`);
  });

  it('pending checks wait, naming them, and time out after the configured minutes', async () => {
    const { cand } = await setup();
    ci.checks = [check('unit', 'pending'), check('lint', 'pending')];
    expect(await run()).toEqual({ progressed: false, waiting: `CI pending on ${cand.commitSha.slice(0, 12)} (unit, lint)` });
    lab.clock.advance(61 * 60_000);
    lab.db.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', lab.clock.now() + 3_600_000, lab.runId);
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toBe('CI did not finish within 60 minutes (pending: unit, lint)');
  });

  it('checks of another commit are not attributed to this one', async () => {
    await setup();
    ci.checks = [check('unit', 'pass')];
    ci.headSha = 'e'.repeat(40);
    const out = await run();
    expect(out.progressed).toBe(false);
    expect(out.waiting).toMatch(/^CI pending on [0-9a-f]{12}$/);
  });

  it('a CI that never reported on this commit and ran out of time says its pending checks are unknown', async () => {
    await setup();
    ci.checks = [check('unit', 'pass')];
    ci.headSha = 'e'.repeat(40);
    lab.clock.advance(61 * 60_000);
    lab.db.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', lab.clock.now() + 3_600_000, lab.runId);
    await run();
    expect(reason()).toBe('CI did not finish within 60 minutes (pending: unknown)');
  });

  it('a timeout reports unknown when nothing is pending by name', async () => {
    await setup();
    ci.checks = [check('x', 'skipping')];
    ci.absent = false;
    const out = await run();
    expect(state()).toBe('SUCCEEDED');
  });

  it('an error from the host surfaces for the retry policy', async () => {
    await setup();
    ci.error = new OrbitError('AUTH_EXPIRED', 'gh token expired');
    await expect(run()).rejects.toMatchObject({ code: 'AUTH_EXPIRED' });
  });
});

describe('no checks reported', () => {
  it('waits during the grace period, then completes with a note that CI is unverified', async () => {
    await setup();
    expect(await run()).toMatchObject({ progressed: false });
    expect(state()).toBe('AWAITING_CI');
    lab.clock.advance(lab.ctx().timing.ciAbsentGraceMs + 1);
    await run();
    expect(state()).toBe('SUCCEEDED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('CI is unverified');
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).ci).toBe('none reported');
  });

  it('with require_ci waits, then blocks at the timeout', async () => {
    await setup({ tweak: (c) => void (c.delivery.require_ci = true) });
    lab.clock.advance(lab.ctx().timing.ciAbsentGraceMs + 1);
    expect(await run()).toEqual({ progressed: false, waiting: 'no CI checks reported yet' });
    lab.clock.advance(61 * 60_000);
    lab.db.run('UPDATE leases SET expires_at = ? WHERE run_id = ?', lab.clock.now() + 3_600_000, lab.runId);
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('delivery.require_ci is true');
  });

  it('in release mode releases with the unverified-CI note', async () => {
    await setup({ mode: 'release' });
    lab.clock.advance(lab.ctx().timing.ciAbsentGraceMs + 1);
    hooks.performRelease.mockResolvedValue({ status: 'released', pending: null, merge: null, mergeSkipped: 'none', deploy: null, deploys: [], deploySkipped: 'none', actions: [] });
    await run();
    expect(hooks.performRelease).toHaveBeenCalledTimes(1);
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('CI is unverified');
  });
});

describe('a failing CI', () => {
  const failing = () => {
    ci.checks = [check('unit', 'fail', '123')];
  };

  it('becomes a CI repair brief for the next attempt, counts one cycle, and goes to diagnosis', async () => {
    const { cand } = await setup();
    failing();
    expect(await run()).toMatchObject({ progressed: true });
    expect(state()).toBe('DIAGNOSING');
    const stored = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8'));
    expect(stored).toMatchObject({ attempt: 2, source: 'ci' });
    expect(stored.brief.text).toContain('mul is not a function');
    expect(lab.ctx().ledger!.state('ci_repair_cycles').used).toBe(1);
    expect(decisions('ci.repair-decision')[0]?.summary).toBe(`CI failed on ${cand.commitSha.slice(0, 12)}: repair allowed`);
    expect(lab.db.all("SELECT 1 FROM failures WHERE run_id = ? AND source = 'ci'", lab.runId)).toHaveLength(1);
  });

  it('a cycle already counted for this commit is not counted twice, and a repeated failure is noted', async () => {
    const { cand } = await setup();
    failing();
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'ci.repair-cycle', 'x', ?)", lab.runId, JSON.stringify({ commit: cand.commitSha, fingerprint: 'other', attempt: 2 }));
    await run();
    expect(state()).toBe('DIAGNOSING');
    expect(lab.ctx().ledger!.state('ci_repair_cycles').used).toBe(0);
  });

  it('a repeated fingerprint is allowed but said to repeat', async () => {
    await setup();
    failing();
    await run();
    // The same failure arrives again on a later delivery: forget the first commit's records but keep its fingerprint.
    lab.db.run("DELETE FROM decisions WHERE run_id = ? AND kind = 'ci.repair-decision'", lab.runId);
    lab.db.run("UPDATE runs SET state = 'AWAITING_CI' WHERE id = ?", lab.runId);
    lab.db.run("UPDATE events SET data_json = json_set(data_json, '$.commit', 'old') WHERE type = 'ci.repair-cycle'");
    await run();
    expect(decisions('ci.repair-decision').at(-1)?.summary).toContain('repair allowed, but this failure repeats an earlier cycle');
  });

  it('a failure on a delivery without a pull request is repaired from the commit alone, and with no candidate the failure is recorded without one', async () => {
    await setup({ pr: null });
    failing();
    const ctx = lab.ctx();
    ctx.candidate = null;
    await awaitingCiStep(ctx);
    expect(state()).toBe('DIAGNOSING');
    expect(lab.db.get<{ candidate_id: string | null }>("SELECT candidate_id FROM failures WHERE run_id = ? AND source = 'ci'", lab.runId)?.candidate_id).toBeNull();
  });

  it('with the repair budget spent the run is EXHAUSTED', async () => {
    await setup();
    failing();
    lab.db.run("UPDATE budget_counters SET used = hard_cap, allowance = hard_cap WHERE counter = 'ci_repair_cycles'");
    await run();
    expect(state()).toBe('EXHAUSTED');
    expect(reason()).toContain('CI failed and the CI repair budget is spent');
  });

  it('when repair is not authorized the run is BLOCKED with the reason', async () => {
    await setup({ tweak: (c) => void (c.actions.repair_ci = false) });
    failing();
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('CI failed and repair is not authorized');
  });

  it('a failure with no log still yields a brief, and the excerpt is simply empty', async () => {
    await setup();
    ci.checks = [check('unit', 'fail', null)];
    await run();
    expect(state()).toBe('DIAGNOSING');
    expect(lab.db.get<{ excerpt: string | null }>("SELECT excerpt FROM failures WHERE run_id = ? AND source = 'ci'", lab.runId)?.excerpt).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('a moved base branch', () => {
  interface Remote {
    bare: string;
    tip: string;
  }
  /** A bare remote holding main at the run's base, then main moved by one commit that edits `file`. */
  function moveBase(file: string, text: string, edit = true): Remote {
    const bare = join(lab.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', bare]);
    gitIn(lab.repo, 'remote', 'add', 'origin', bare);
    gitIn(lab.repo, 'push', '-q', 'origin', 'main:refs/heads/main');
    if (!edit) return { bare, tip: gitIn(lab.repo, 'rev-parse', 'HEAD') };
    const clone = join(lab.base, 'clone');
    execFileSync('git', ['clone', '-q', '--branch', 'main', bare, clone]);
    gitIn(clone, 'config', 'user.email', 'dev@example.test');
    gitIn(clone, 'config', 'user.name', 'dev');
    mkdirSync(dirname(join(clone, file)), { recursive: true });
    writeFileSync(join(clone, file), text);
    gitIn(clone, 'add', '-A');
    gitIn(clone, 'commit', '-q', '-m', 'move');
    gitIn(clone, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    return { bare, tip: gitIn(clone, 'rev-parse', 'HEAD') };
  }
  const allowRebase = (c: OrbitConfig) => void (c.actions.rebase_task_branch = true);

  it('a base that did not move, or has no recorded revision, is no movement', async () => {
    const { cand } = await setup();
    moveBase('x', '', false);
    expect(await baseMovement(lab.ctx(), { commit: cand.commitSha })).toBeNull();
    lab.db.run('UPDATE runs SET base_revision = NULL WHERE id = ?', lab.runId);
    expect(await baseMovement(lab.ctx(), { commit: cand.commitSha })).toBeNull();
  });

  it('an unreadable remote is not a conflict', async () => {
    const { cand } = await setup();
    gitIn(lab.repo, 'remote', 'add', 'origin', join(lab.base, 'missing.git'));
    expect(await baseMovement(lab.ctx(), { commit: cand.commitSha })).toBeNull();
    expect(await baseConflict(lab.ctx(), { commit: cand.commitSha })).toBeNull();
  });

  it('a hosted remote the policy does not allow is not contacted', async () => {
    const { cand } = await setup();
    gitIn(lab.repo, 'remote', 'add', 'origin', 'https://blocked.example.test/acme/app.git');
    expect(await baseMovement(lab.ctx(), { commit: cand.commitSha })).toBeNull();
  });

  it('a base that moved without touching the same lines is no obstacle', async () => {
    const { cand } = await setup();
    const r = moveBase('docs/notes.md', 'notes\n');
    const m = await baseMovement(lab.ctx(), { commit: cand.commitSha });
    expect(m).toMatchObject({ baseBranch: 'main', to: r.tip, conflicts: [] });
    expect(await baseConflict(lab.ctx(), { commit: cand.commitSha })).toBeNull();
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('SUCCEEDED');
  });

  const conflictText = 'export const add = (a, b) => a + b + 0;\n';

  it('a conflict without permission to rebase blocks naming the key that would allow it', async () => {
    const { cand } = await setup();
    const r = moveBase('apps/calc.mjs', conflictText);
    expect(await baseConflict(lab.ctx(), { commit: cand.commitSha })).toMatchObject({ baseBranch: 'main', to: r.tip, files: ['apps/calc.mjs'] });
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('Rebasing the task branch is not authorized (actions.rebase_task_branch');
    expect(decisions('delivery.base-conflict')).toHaveLength(1);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).base_conflict).toMatchObject({ files: ['apps/calc.mjs'] });
  });

  it('with permission a conflict blocks naming the paths', async () => {
    await setup({ tweak: allowRebase });
    moveBase('apps/calc.mjs', conflictText);
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('rebasing the task branch onto it conflicts in apps/calc.mjs');
  });

  it('with permission a clean move is rebased into a new candidate and verification starts again', async () => {
    const { cand } = await setup({ tweak: allowRebase });
    const r = moveBase('docs/notes.md', 'notes\n');
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('VERIFYING');
    const after = getRun(lab.db, lab.runId);
    expect(after.baseRevision).toBe(r.tip);
    expect(lab.ctx().candidate!.id).not.toBe(cand.id);
    expect(lab.ctx().candidate!.parentSha).toBe(r.tip);
    expect(decisions('delivery.rebased')).toHaveLength(1);
    expect(currentEvidenceReport(lab.db, lab.runId, cand.id)).toBeNull();
  });

  it('remeasures the contract baseline on the new base before verifying the rebased candidate', async () => {
    const { cand } = await setup({ tweak: allowRebase });
    await recordBaseline(cand.parentSha);
    const old = baseline();
    const r = moveBase('docs/notes.md', 'notes\n');
    ci.checks = [check('unit', 'pass')];

    await run();

    expect(state()).toBe('VERIFYING');
    const refreshed = baseline();
    expect(refreshed).toMatchObject({ baseRevision: r.tip, baseTree: gitIn(lab.repo, 'rev-parse', `${r.tip}^{tree}`), checkIds: ['unit'] });
    expect(refreshed.baseRevision).not.toBe(old.baseRevision);
    expect(listCheckRuns(lab.db, { runId: lab.runId, candidateId: null, checkId: 'unit', rootsOnly: true }).map((row) => row.status)).toEqual(['PASSED', 'PASSED']);
    const recorded = lab.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'baseline.recorded' ORDER BY id", lab.runId).map((row) => (JSON.parse(row.data_json) as { base_revision: string }).base_revision);
    expect(recorded).toEqual([old.baseRevision, r.tip]);
    expect(decisions('baseline.rebased')[0]?.data).toMatchObject({ base_revision: r.tip, check_ids: ['unit'] });
  });

  it('finishes judging a rebased baseline after a fault immediately after its durable write', async () => {
    const { cand } = await setup({ tweak: allowRebase });
    await recordBaseline(cand.parentSha);
    const r = moveBase('docs/notes.md', 'notes\n');
    ci.checks = [check('unit', 'pass')];
    process.env.ORBIT_FAULTS = 'controller.baseline-rebase.after-write=throw';
    resetFaults();

    await expect(run()).rejects.toThrow('fault injected at controller.baseline-rebase.after-write');
    expect(state()).toBe('VERIFYING');
    expect(baseline().baseRevision).toBe(r.tip);
    expect(decisions('baseline.rebased')).toEqual([]);

    delete process.env.ORBIT_FAULTS;
    resetFaults();
    const ctx = lab.ctx();
    expect(await amendBaseline(ctx, ctx.contract!)).toBeNull();
    expect(decisions('baseline.rebased')).toHaveLength(1);
    // The persisted complete baseline was judged, not measured a third time.
    expect(listCheckRuns(lab.db, { runId: lab.runId, candidateId: null, checkId: 'unit', rootsOnly: true }).map((row) => row.status)).toEqual(['PASSED', 'PASSED']);
  });

  it('blocks the rebased baseline when an optional check the contract requires cannot start on the new base', async () => {
    const { cand } = await setup({
      tweak: (c) => {
        allowRebase(c);
        c.checks.lint = { ...c.checks.unit!, id: 'lint', command: ['orbit-missing-rebase-linter', '--check'], mandatory: false };
      },
    });
    setContract(lab, { baseline_revision: cand.parentSha, required_check_ids: ['unit', 'lint'] });
    await recordBaseline(cand.parentSha);
    const r = moveBase('docs/notes.md', 'notes\n');
    ci.checks = [check('unit', 'pass')];

    await run();

    expect(state()).toBe('BLOCKED');
    const refreshed = baseline();
    expect(refreshed.baseRevision).toBe(r.tip);
    expect((JSON.parse(readFileSync(join(lab.ctx().runDir, BASELINE_FILE), 'utf8')) as { failures: { checkId: string; classification?: string; signals?: string[] }[] }).failures).toContainEqual(expect.objectContaining({ checkId: 'lint', classification: 'environment', signals: ['start-failed'] }));
    expect(decisions('baseline.rebased')).toEqual([]);
  });

  it('a run that already rebased three times does not rebase again onto a further move', async () => {
    const { cand } = await setup({ tweak: allowRebase });
    moveBase('docs/notes.md', 'notes\n');
    for (const to of ['1', '2', '3']) lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'delivery.rebased', 'x', ?)", lab.runId, JSON.stringify({ from: 'a', to: to.repeat(40) }));
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('already rebased onto a moved base 3 times');
  });

  it('a candidate that cannot be loaded for the rebase is an internal error', async () => {
    await setup({ tweak: allowRebase });
    moveBase('docs/notes.md', 'notes\n');
    ci.checks = [check('unit', 'pass')];
    const ctx = lab.ctx();
    ctx.candidate = null;
    await expect(awaitingCiStep(ctx)).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('AWAITING_CI without a candidate') });
  });

  it('a rebase that git cannot complete and cannot explain by conflicts is a git failure', async () => {
    const { cand } = await setup({ tweak: allowRebase });
    moveBase('docs/notes.md', 'notes\n');
    ci.checks = [check('unit', 'pass')];
    // The candidate's parent is not an ancestor git can use for the rebase range.
    lab.db.run('UPDATE candidates SET parent_sha = ? WHERE id = ?', 'd'.repeat(40), cand.id);
    await expect(run()).rejects.toMatchObject({ code: expect.stringMatching(/GIT_FAILED|INTERNAL/) });
  });

  it('a merge computation that fails for another reason than a conflict is no movement', async () => {
    const { cand } = await setup();
    moveBase('docs/notes.md', 'notes\n');
    const real = execFileSync('which', ['git']).toString().trim();
    const bin = join(lab.base, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nif [ "$3" = merge-tree ] || [ "$1" = merge-tree ]; then echo boom >&2; exit 2; fi\nexec ${real} "$@"\n`, { mode: 0o755 });
    lab.deps.hostEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    expect(await baseMovement(lab.ctx(), { commit: cand.commitSha })).toBeNull();
  });

  const gitShim = (script: string): void => {
    const real = execFileSync('which', ['git']).toString().trim();
    const bin = join(lab.base, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'git'), `#!/bin/sh\n${script.replaceAll('REAL', real)}\nexec ${real} "$@"\n`, { mode: 0o755 });
    lab.deps.hostEnv = { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
  };
  const hasArg = (a: string) => `for x in "$@"; do [ "$x" = ${a} ] && f=1; done`;

  it('a conflict git cannot name is reported without paths', async () => {
    const { cand } = await setup();
    moveBase('apps/calc.mjs', conflictText);
    gitShim(`${hasArg('merge-tree')}\nif [ "$f" = 1 ]; then echo deadbeef; exit 1; fi`);
    expect(await baseMovement(lab.ctx(), { commit: cand.commitSha })).toMatchObject({ conflicts: ['(unknown paths)'] });
    expect(await baseConflict(lab.ctx(), { commit: cand.commitSha })).toMatchObject({ files: [] });
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('conflicts in unknown paths');
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).base_conflict.files).toEqual([]);
  });

  it('with permission, a conflict git cannot name is reported without paths too', async () => {
    const { cand } = await setup({ tweak: allowRebase });
    moveBase('apps/calc.mjs', conflictText);
    gitShim(`${hasArg('merge-tree')}\nif [ "$f" = 1 ]; then echo deadbeef; exit 1; fi`);
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(reason()).toContain('rebasing the task branch onto it conflicts in unknown paths');
  });

  it('a rebase that conflicts although the merge looked clean blocks naming the paths', async () => {
    await setup({ tweak: allowRebase });
    moveBase('apps/calc.mjs', conflictText);
    gitShim(`${hasArg('merge-tree')}\nif [ "$f" = 1 ]; then echo deadbeef; exit 0; fi`);
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('BLOCKED');
    expect(reason()).toContain('conflicts in apps/calc.mjs');
    expect(lab.db.all("SELECT 1 FROM decisions WHERE run_id = ? AND kind = 'delivery.base-conflict'", lab.runId)).toHaveLength(1);
  });

  it('a rebase that fails with nothing unmerged is a git failure that carries git\'s message', async () => {
    await setup({ tweak: allowRebase });
    moveBase('docs/notes.md', 'notes\n');
    gitShim(`${hasArg('rebase')}\nif [ "$f" = 1 ]; then echo "fatal: cannot rebase" >&2; exit 1; fi`);
    ci.checks = [check('unit', 'pass')];
    await expect(run()).rejects.toMatchObject({ code: 'GIT_FAILED', message: expect.stringContaining('fatal: cannot rebase') });
  });

  it('rebases using the process environment when the controller was given none, and follows with the worktree it has', async () => {
    const { cand } = await setup({ tweak: allowRebase });
    const r = moveBase('docs/notes.md', 'notes\n');
    delete lab.deps.hostEnv;
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('VERIFYING');
    expect(gitIn(getRun(lab.db, lab.runId).worktreePath!, 'rev-parse', 'HEAD')).toBe(lab.ctx().candidate!.commitSha);
    expect(lab.ctx().candidate!.parentSha).toBe(r.tip);
  });

  it('a run worktree that cannot be moved, or that is gone, does not undo the rebase', async () => {
    await setup({ tweak: allowRebase });
    moveBase('docs/notes.md', 'notes\n');
    const empty = join(lab.base, 'not-a-repo');
    mkdirSync(empty, { recursive: true });
    lab.db.run('UPDATE runs SET worktree_path = ? WHERE id = ?', empty, lab.runId);
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('VERIFYING');
    cleanup();
    await setup({ tweak: allowRebase });
    moveBase('docs/notes.md', 'notes\n');
    lab.db.run('UPDATE runs SET worktree_path = ? WHERE id = ?', join(lab.base, 'gone'), lab.runId);
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('VERIFYING');
  });

  it('a checkout that cannot be removed does not fail the rebase', async () => {
    await setup({ tweak: allowRebase });
    moveBase('apps/calc.mjs', conflictText);
    hooks.cleanup = async (_repo, dir) => {
      if (dir.includes('rebase-')) throw new Error('busy');
      return false;
    };
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('BLOCKED');
    cleanup();
    await setup({ tweak: allowRebase });
    moveBase('docs/notes.md', 'notes\n');
    hooks.cleanup = async (_repo, dir) => {
      if (dir.includes('rebase-')) throw new Error('busy');
      return false;
    };
    ci.checks = [check('unit', 'pass')];
    await run();
    expect(state()).toBe('VERIFYING');
  });
});
