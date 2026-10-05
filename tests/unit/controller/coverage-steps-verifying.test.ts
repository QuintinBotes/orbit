import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

type Collect = typeof import('../../../src/controller/verification.ts');
type Scope = typeof import('../../../src/policy/scope.ts');
type Cand = typeof import('../../../src/evidence/candidate.ts');
type Git = typeof import('../../../src/evidence/git.ts');
type Trig = typeof import('../../../src/inquisition/triggers.ts');

const hooks = vi.hoisted(() => ({
  collect: vi.fn(),
  inspectScope: vi.fn(),
  materializeCandidate: vi.fn(),
  cleanupCandidateCheckout: vi.fn(),
  git: vi.fn(),
  detectTriggers: vi.fn(),
}));
vi.mock('../../../src/controller/verification.ts', async (orig) => ({ ...(await orig<Collect>()), collectVerificationEvidence: hooks.collect }));
vi.mock('../../../src/policy/scope.ts', async (orig) => ({ ...(await orig<Scope>()), inspectScope: hooks.inspectScope }));
vi.mock('../../../src/evidence/candidate.ts', async (orig) => ({ ...(await orig<Cand>()), materializeCandidate: hooks.materializeCandidate, cleanupCandidateCheckout: hooks.cleanupCandidateCheckout }));
vi.mock('../../../src/evidence/git.ts', async (orig) => ({ ...(await orig<Git>()), git: hooks.git }));
vi.mock('../../../src/inquisition/triggers.ts', async (orig) => ({ ...(await orig<Trig>()), detectTriggers: hooks.detectTriggers }));

const { verifyingStep, handledTriggerKeys, pendingTrigger } = await import('../../../src/controller/steps/verifying.ts');
const { PLANNER_FILE } = await import('../../../src/controller/steps/contracting.ts');
const { getRun, requestCancel } = await import('../../../src/controller/run-store.ts');
const { getCandidate, listFailures, currentEvidenceReport, listEvidenceReports } = await import('../../../src/evidence/store.ts');
const { evaluateEvidence } = await import('../../../src/evidence/report.ts');
const { listDecisions } = await import('../../../src/storage/decisions.ts');
const { planWorker, finishWorker, markWorkerRunning } = await import('../../../src/storage/workers.ts');
const { setQuestionAnswer } = await import('../../../src/inquisition/store.ts');
const { APPROVE_ONCE, DENY } = await import('../../../src/controller/authorization.ts');
const { PLANNER_OUTPUT, IMPLEMENTER_OUTPUT } = await import('../../integration/controller/harness.ts');
const { addCandidate, addEvidence, cleanScope, makeUnitLab, setContract, OWNER } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type Trigger = import('../../../src/inquisition/types.ts').Trigger;

let lab: UnitLab;
beforeEach(() => {
  for (const f of Object.values(hooks)) f.mockReset();
  hooks.detectTriggers.mockReturnValue([]);
  hooks.git.mockResolvedValue('');
  hooks.cleanupCandidateCheckout.mockResolvedValue(undefined);
  hooks.materializeCandidate.mockImplementation(async (_r: string, _c: string, dir: string) => {
    mkdirSync(dir, { recursive: true });
    return dir;
  });
});
afterEach(() => lab?.cleanup());

const trigger = (key = 'oracle_weakening:1', kind: Trigger['kind'] = 'oracle_weakening'): Trigger => ({ kind, mode: 'challenge', summary: 'tests were weakened', evidence: ['tests/a.test.ts'], subjects: ['AC-1'], key });

function setup(opts: { supervised?: boolean; lockfile?: boolean; tweak?: Parameters<typeof makeUnitLab>[0] extends infer O ? (O extends { tweak?: infer T } ? T : never) : never } = {}) {
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'].slice(0, 0) as never[],
    tweak: (c) => {
      if (opts.supervised) c.mode = 'supervised';
      opts.tweak?.(c);
    },
  });
  lab.walk(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING']);
  setContract(lab);
  const cand = addCandidate(lab);
  lab.db.run("UPDATE runs SET base_revision = ? WHERE id = ?", 'a'.repeat(40), lab.runId);
  hooks.inspectScope.mockResolvedValue(cleanScope());
  return { cand, ctx: lab.ctx() };
}

function collected(over: { verdict?: 'PASS' | 'FAIL' | 'INCOMPLETE'; security?: 'pass' | 'fail'; findings?: object[] } = {}) {
  return async (ctx: { run: { id: string } }, cand: ReturnType<typeof addCandidate>) => {
    const real = evaluateEvidence({ contract: lab.ctx().contract!, candidate: cand, checkResults: [], scope: cleanScope(), snapshot: lab.ctx().snapshot });
    const report = { ...real.report, verdict: over.verdict ?? 'PASS' };
    return { evidence: { report, evaluation: { ...real, report }, security: { status: over.security ?? 'pass', reasons: [], notes: [], evidence: [], gate: 'static_security', passed: (over.security ?? 'pass') === 'pass', onFailure: 'repair-or-block', details: {} }, scan: { findings: over.findings ?? [] } } };
  };
}

const runStep = () => verifyingStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;

describe('preconditions and fresh evidence', () => {
  it('stops at a safe point, and a candidate-less run is an internal error', async () => {
    setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await runStep()).toMatchObject({ done: true });
    lab.cleanup();
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING'] as never });
    setContract(lab);
    await expect(runStep()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('VERIFYING without a candidate') });
  });

  it.each([
    ['PASS', 'REVIEWING'],
    ['FAIL', 'DIAGNOSING'],
    ['INCOMPLETE', 'BLOCKED'],
  ] as const)('a fresh %s report acts on it without redoing the work: %s', async (verdict, to) => {
    const { cand } = setup();
    addEvidence(lab, cand, { verdict, unverified: ['SAST is unverified', 'a', 'b', 'c', 'd', 'e'] });
    await runStep();
    expect(state()).toBe(to);
    expect(hooks.inspectScope).not.toHaveBeenCalled();
    if (verdict === 'INCOMPLETE') expect(getRun(lab.db, lab.runId).outcomeReason).toContain('mandatory verification is unavailable for candidate 1: SAST is unverified; a; b; c; d');
  });

  it('a green candidate that trips a proof-blocking trigger goes to inquiry, and an incomplete one with any trigger too', async () => {
    const { cand } = setup();
    addEvidence(lab, cand, { verdict: 'PASS' });
    hooks.detectTriggers.mockReturnValue([trigger('green:1', 'green_without_proof'), trigger('other:1', 'scope_pressure')]);
    await runStep();
    expect(state()).toBe('INQUISITION');
    lab.cleanup();
    const t = setup();
    addEvidence(lab, t.cand, { verdict: 'INCOMPLETE' });
    hooks.detectTriggers.mockReturnValue([trigger('other:2', 'scope_pressure')]);
    await runStep();
    expect(state()).toBe('INQUISITION');
    expect(getRun(lab.db, lab.runId).resumeState).toBe('VERIFYING');
  });

  it('a trigger inquired into already does not fire again, and a non-proof trigger does not stop a PASS', async () => {
    const { cand } = setup();
    addEvidence(lab, cand, { verdict: 'PASS' });
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'inquisition.completed', 'x', ?)", lab.runId, JSON.stringify({ key: 'oracle_weakening:1' }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'inquisition.completed', 'x', NULL)", lab.runId);
    hooks.detectTriggers.mockReturnValue([trigger('oracle_weakening:1'), trigger('scope:1', 'scope_pressure')]);
    await runStep();
    expect(state()).toBe('REVIEWING');
    expect([...handledTriggerKeys(lab.ctx())]).toEqual(['oracle_weakening:1']);
  });
});

describe('the implementation scope gate', () => {
  it('a protected path or escaping symlink is a policy violation: the candidate is invalidated and the run blocks', async () => {
    const { cand } = setup();
    hooks.inspectScope.mockResolvedValue(cleanScope({ forbidden_paths_changed: ['.github/ci.yml'] }));
    const out = await runStep();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
    expect(getCandidate(lab.db, cand.id).status).toBe('INVALIDATED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('policy violation in candidate 1: protected paths changed: .github/ci.yml');
    expect(listFailures(lab.db, lab.runId)).toHaveLength(1);
    expect(listDecisions(lab.db, lab.runId, { kind: 'policy.deny' })).toHaveLength(1);
    expect(listEvidenceReports(lab.db, lab.runId)).toHaveLength(1);
    expect(getCandidate(lab.db, cand.id).scope).not.toBeNull();
  });

  it('a repairable scope problem is diagnosed instead, with a stable failure fingerprint', async () => {
    const { cand } = setup();
    hooks.inspectScope.mockResolvedValue(cleanScope({ out_of_scope_paths_changed: ['docs/x.md'], lockfile_changed: true }));
    await runStep();
    expect(state()).toBe('DIAGNOSING');
    const [f] = listFailures(lab.db, lab.runId);
    expect(f?.fingerprint).toMatch(/^scope:[0-9a-f]{16}$/);
    expect(currentEvidenceReport(lab.db, lab.runId, cand.id)?.verdict).not.toBe('PASS');
  });

  it('reuses the scope inspection recorded with the candidate', async () => {
    const { cand } = setup();
    lab.db.run('UPDATE candidates SET scope_json = ? WHERE id = ?', JSON.stringify(cleanScope({ out_of_scope_paths_changed: ['docs/x.md'] })), cand.id);
    await verifyingStep(lab.ctx());
    expect(hooks.inspectScope).not.toHaveBeenCalled();
    expect(state()).toBe('DIAGNOSING');
  });
});

describe('supervised authorization of dependency changes', () => {
  const lock = () => hooks.inspectScope.mockResolvedValue(cleanScope({ lockfile_changed: true }));

  it('asks a person, blocks until the answer, and does not ask again while it is pending', async () => {
    setup({ supervised: true });
    lock();
    await runStep();
    expect(state()).toBe('BLOCKED');
    const reason = getRun(lab.db, lab.runId).outcomeReason!;
    expect(reason).toContain("needs a person's authorization");
    expect(reason).toContain('change the dependency lockfile');
    const q = lab.db.all<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', lab.runId);
    expect(q).toHaveLength(1);
  });

  it('an authorization still pending is not asked again, and the run blocks on the same question', async () => {
    setup({ supervised: true });
    lock();
    await runStep();
    lab.db.run("UPDATE runs SET state = 'VERIFYING', outcome_reason = NULL WHERE id = ?", lab.runId);
    await verifyingStep(lab.ctx());
    expect(state()).toBe('BLOCKED');
    expect(lab.db.all('SELECT 1 FROM questions WHERE run_id = ?', lab.runId)).toHaveLength(1);
  });

  it('proceeds with the grant recorded as a disclosure once a person approved exactly this operation', async () => {
    const { cand } = setup({ supervised: true });
    lock();
    await runStep();
    const [{ id }] = lab.db.all<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', lab.runId) as [{ id: string }];
    setQuestionAnswer(lab.db, id, APPROVE_ONCE, 'quintin', lab.clock);
    lab.db.run("UPDATE runs SET state = 'VERIFYING' WHERE id = ?", lab.runId);
    let seen: string[] = [];
    hooks.collect.mockImplementation(async (c: never, k: never, o: { notes: string[] }) => ((seen = o.notes), collected()(c, k)));
    await verifyingStep(lab.ctx());
    expect(seen[0]).toContain('authorized once by quintin');
    expect(state()).toBe('REVIEWING');
  });

  it('a refusal goes back to the implementer as a scope repair', async () => {
    setup({ supervised: true });
    lock();
    await runStep();
    const [{ id }] = lab.db.all<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', lab.runId) as [{ id: string }];
    setQuestionAnswer(lab.db, id, DENY, 'quintin', lab.clock);
    lab.db.run("UPDATE runs SET state = 'VERIFYING' WHERE id = ?", lab.runId);
    await verifyingStep(lab.ctx());
    expect(state()).toBe('DIAGNOSING');
  });

  it('asks about nothing when the refusal is not made only of askable dependency changes', async () => {
    setup({ supervised: true });
    hooks.inspectScope.mockResolvedValue(cleanScope({ lockfile_changed: true, out_of_scope_paths_changed: ['docs/x.md'] }));
    await runStep();
    expect(state()).toBe('DIAGNOSING');
    expect(lab.db.all('SELECT 1 FROM questions WHERE run_id = ?', lab.runId)).toHaveLength(0);
    lab.cleanup();
    setup({ supervised: true });
    hooks.inspectScope.mockResolvedValue(cleanScope({ out_of_scope_paths_changed: ['docs/x.md'] }));
    await runStep();
    expect(lab.db.all('SELECT 1 FROM questions WHERE run_id = ?', lab.runId)).toHaveLength(0);
    lab.cleanup();
    setup({ supervised: true });
    hooks.inspectScope.mockResolvedValue(cleanScope({ forbidden_paths_changed: ['.github/x'], lockfile_changed: true }));
    await runStep();
    expect(state()).toBe('BLOCKED');
    expect(lab.db.all('SELECT 1 FROM questions WHERE run_id = ?', lab.runId)).toHaveLength(0);
  });

  it('with the policy allowing the change nothing is asked, and an unattended run is never asked', async () => {
    setup({ tweak: (c) => void (c.dependencies = { ...c.dependencies, change_lockfile: true }) });
    lock();
    hooks.collect.mockImplementation(collected());
    await runStep();
    expect(state()).toBe('REVIEWING');
    lab.cleanup();
    setup();
    lock();
    await runStep();
    expect(state()).toBe('DIAGNOSING');
  });
});

describe('verification in a clean checkout', () => {
  it('materializes the candidate, collects evidence, records the gates and the report, and removes the checkout', async () => {
    const { cand } = setup();
    hooks.collect.mockImplementation(collected());
    expect(await runStep()).toEqual({ progressed: true });
    expect(state()).toBe('REVIEWING');
    expect(hooks.materializeCandidate).toHaveBeenCalledTimes(1);
    expect(hooks.materializeCandidate.mock.calls[0]![1]).toBe(cand.commitSha);
    expect(hooks.cleanupCandidateCheckout).toHaveBeenCalledTimes(1);
    expect(currentEvidenceReport(lab.db, lab.runId, cand.id)?.verdict).toBe('PASS');
    expect(hooks.collect.mock.calls[0]![2]).toMatchObject({ exploration: true, notes: [] });
  });

  it('a secret finding is recorded as a failure of the candidate before the report', async () => {
    setup();
    hooks.collect.mockImplementation(collected({ verdict: 'FAIL', security: 'fail', findings: [{ file: 'apps/a.mjs', line: 3, rule: 'github-pat' }, { file: 'b.txt', line: null, rule: 'generic' }] }));
    await runStep();
    expect(state()).toBe('DIAGNOSING');
    expect(listFailures(lab.db, lab.runId).map((f) => f.fingerprint).sort()).toEqual(['secret-scan:generic:b.txt', 'secret-scan:github-pat:apps/a.mjs']);
    expect(listFailures(lab.db, lab.runId)[0]?.excerpt).toContain('value redacted');
  });

  it('a checkout that cannot be removed afterwards does not fail the step', async () => {
    setup();
    hooks.collect.mockImplementation(collected());
    hooks.cleanupCandidateCheckout.mockRejectedValue(new Error('busy'));
    await runStep();
    expect(state()).toBe('REVIEWING');
  });

  it('a candidate with no recorded diff has no changed files to report, and an incomplete verdict with nothing unverified says so', async () => {
    const { cand } = setup();
    lab.db.run('UPDATE candidates SET diff_stat_json = NULL WHERE id = ?', cand.id);
    addEvidence(lab, cand, { verdict: 'INCOMPLETE', unverified: [] });
    await runStep();
    expect(state()).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('the evidence is incomplete');
    expect((hooks.detectTriggers.mock.calls[0]![0] as { changedFiles: string[] }).changedFiles).toEqual([]);
  });

  it('hands back a stop from a safe point inside the collection, and leaves the checkout of an interrupted step', async () => {
    setup();
    hooks.collect.mockResolvedValue({ stopped: { progressed: false, waiting: 'paused' } });
    expect(await runStep()).toEqual({ progressed: false, waiting: 'paused' });
    expect(hooks.cleanupCandidateCheckout).toHaveBeenCalledTimes(1);
    hooks.cleanupCandidateCheckout.mockClear();
    const ac = new AbortController();
    hooks.collect.mockImplementation(async () => {
      ac.abort();
      return { stopped: { progressed: false } };
    });
    await verifyingStep(lab.ctx(ac.signal));
    expect(hooks.cleanupCandidateCheckout).not.toHaveBeenCalled();
  });

  it('a checkout already made of this exact tree is reused; a different or dirty one is replaced; an unusable one too', async () => {
    const { cand } = setup();
    hooks.collect.mockImplementation(collected());
    const dir = join(lab.home, 'worktrees');
    const populate = () => {
      const checkout = (hooks.materializeCandidate.mock.calls.at(-1) ?? [])[2] as string | undefined;
      return checkout;
    };
    await runStep();
    const checkout = populate()!;
    hooks.materializeCandidate.mockClear();
    hooks.cleanupCandidateCheckout.mockClear();
    // Leave something in the checkout so it counts as existing, as an interrupted step would.
    for (const [tree, status, expectMaterialize] of [
      [cand.treeHash, '', false],
      ['other-tree', '', true],
      [cand.treeHash, ' M apps/a.mjs', true],
    ] as const) {
      lab.db.run("UPDATE runs SET state = 'VERIFYING' WHERE id = ?", lab.runId);
      lab.db.run('DELETE FROM evidence_reports WHERE run_id = ?', lab.runId);
      writeFileSync(join(checkout, 'x'), 'x');
      hooks.git.mockImplementation(async (_d: string, args: string[]) => (args[0] === 'rev-parse' ? `${tree}\n` : `${status}\n`));
      hooks.materializeCandidate.mockClear();
      await verifyingStep(lab.ctx());
      expect(hooks.materializeCandidate.mock.calls.length > 0, `${tree} ${status}`).toBe(expectMaterialize);
    }
    hooks.git.mockRejectedValue(new Error('not a git checkout'));
    lab.db.run("UPDATE runs SET state = 'VERIFYING' WHERE id = ?", lab.runId);
    lab.db.run('DELETE FROM evidence_reports WHERE run_id = ?', lab.runId);
    writeFileSync(join(checkout, 'y'), 'y');
    hooks.materializeCandidate.mockClear();
    await verifyingStep(lab.ctx());
    expect(hooks.materializeCandidate).toHaveBeenCalledTimes(1);
  });
});

describe('pendingTrigger', () => {
  it('feeds the stored plan, the claims of the newest successful implementer and the thresholds into the detection', () => {
    const { cand } = setup();
    mkdirSync(lab.ctx().runDir, { recursive: true });
    writeFileSync(join(lab.ctx().runDir, PLANNER_FILE), JSON.stringify({ worker_id: 'w', output: PLANNER_OUTPUT }));
    const w = planWorker(lab.db, { id: 'wrk-i', runId: lab.runId, role: 'implementer', provider: 'claude', workerDir: join(lab.base, 'wi'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    finishWorker(lab.db, w.id, { state: 'SUCCEEDED', resultStatus: 'succeeded', result: { status: 'succeeded', structured: IMPLEMENTER_OUTPUT, text: null, error: null, exitCode: 0, usage: { provider: 'claude', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' }, durationMs: 1 } }, lab.clock, OWNER);
    const t = trigger('k1');
    hooks.detectTriggers.mockReturnValue([t]);
    expect(pendingTrigger(lab.ctx(), cand, null)).toEqual(t);
    const snapshot = hooks.detectTriggers.mock.calls[0]![0] as { expectedChangedFiles: string[]; claims: unknown };
    expect(snapshot.expectedChangedFiles).toEqual(PLANNER_OUTPUT.expected_changed_files.map((f) => f.path));
    expect(snapshot.claims).not.toBeNull();
  });

  it('has no plan or claims to feed when none exist or they cannot be read, and filters by kind', () => {
    const { cand } = setup();
    hooks.detectTriggers.mockReturnValue([trigger('a', 'scope_pressure'), trigger('b', 'oracle_weakening')]);
    expect(pendingTrigger(lab.ctx(), cand, ['oracle_weakening'])?.key).toBe('b');
    expect(pendingTrigger(lab.ctx(), cand, ['green_without_proof'])).toBeNull();
    expect((hooks.detectTriggers.mock.calls[0]![0] as { claims: unknown }).claims).toBeNull();
    const w = planWorker(lab.db, { id: 'wrk-bad', runId: lab.runId, role: 'implementer', provider: 'claude', workerDir: join(lab.base, 'wb'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    finishWorker(lab.db, w.id, { state: 'SUCCEEDED', resultStatus: 'succeeded', result: { status: 'succeeded', structured: { not: 'an implementer output' }, text: null, error: null, exitCode: 0, usage: { provider: 'claude', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable' }, durationMs: 1 } }, lab.clock, OWNER);
    pendingTrigger(lab.ctx(), cand, null);
    expect((hooks.detectTriggers.mock.calls.at(-1)![0] as { claims: unknown }).claims).toBeNull();
  });
});
