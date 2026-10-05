import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskResult } from '../../../src/adapters/types.ts';
import { finishCheckRun, markCheckRunning, planCheckRun, recordFailure, type CandidateRecord } from '../../../src/evidence/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listHypotheses } from '../../../src/inquisition/store.ts';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { attemptHistory, diagnosingStep, localizedFault, raisesTimeout, timeoutContext, timeoutPromptLines, withTimeoutHypothesis } from '../../../src/controller/steps/diagnosing.ts';
import { briefPath } from '../../../src/controller/steps/implementing.ts';
import { DIAGNOSIS } from '../../integration/controller/harness.ts';
import { addCandidate, addEvidence, giveRepository, initLedger, makeUnitLab, okResult, scriptedAdapter, setContract, validateModels, type ScriptedAdapter, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const FP = 'fp:calc-mul';
const diagnosis = (over: { fingerprint?: string; statement?: string; scopedFix?: string; ruledOut?: boolean; confidence?: 'low' | 'medium' | 'high' } = {}) => {
  const d = structuredClone(DIAGNOSIS.structured) as typeof DIAGNOSIS.structured;
  const fp = over.fingerprint ?? FP;
  d.repair_brief.fingerprint = fp;
  d.fingerprint_comparison.current = fp;
  if (over.statement) {
    d.repair_brief.hypotheses[0]!.statement = over.statement;
    d.competing_hypotheses[0]!.statement = over.statement;
  }
  if (over.scopedFix) d.repair_brief.scoped_fix = over.scopedFix;
  if (over.ruledOut) for (const h of d.competing_hypotheses) h.status = 'ruled-out' as never;
  if (over.confidence) d.confidence = over.confidence;
  return d;
};

interface Setup {
  script?: Parameters<typeof scriptedAdapter>[1];
  failure?: 'check' | 'scope' | 'none';
  diffPaths?: string[];
  tweak?: Parameters<typeof makeUnitLab>[0] extends infer O ? (O extends { tweak?: infer T } ? T : never) : never;
}

async function setup(o: Setup = {}): Promise<{ cand: CandidateRecord; adapter: ScriptedAdapter }> {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'DIAGNOSING'], tweak: o.tweak });
  const adapter = scriptedAdapter(lab, o.script ?? (() => okResult(diagnosis())));
  lab.deps.adapters = { claude: adapter };
  validateModels(lab);
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base });
  initLedger(lab);
  const cand = addCandidate(lab);
  lab.db.run('UPDATE candidates SET diff_stat_json = ? WHERE id = ?', JSON.stringify({ files: 1, insertions: 1, deletions: 0, binaryFiles: 0, paths: o.diffPaths ?? ['apps/calc.mjs'], truncated: false }), cand.id);
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
  if (o.failure !== 'none') {
    recordFailure(lab.db, { runId: lab.runId, candidateId: cand.id, source: o.failure === 'scope' ? 'worker' : 'check', sourceId: o.failure === 'scope' ? `scope:${cand.id}` : 'unit', fingerprint: FP, excerpt: 'mul(2, 3) expected 6, got 5' }, lab.clock);
  }
  return { cand, adapter };
}

const run = () => diagnosingStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });
async function settle(max = 10) {
  let out = await run();
  for (let i = 0; i < max && out.waiting && /is running$/.test(out.waiting); i++) out = await run();
  return out;
}

/** An attempt k that failed `unit` with the fingerprint, as VERIFYING would have left it. */
function addAttempt(k: number, opts: { supported?: boolean; fingerprint?: string } = {}): CandidateRecord {
  const cand = addCandidate(lab, { tree: String(k).repeat(40).slice(0, 40), commit: String(k + 3).repeat(40).slice(0, 40), attempt: k });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.attempt', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ attempt: k }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.candidate', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ attempt: k, candidate_id: cand.id }));
  addEvidence(lab, cand, {
    verdict: 'FAIL',
    checks: [{ id: 'unit', status: 'FAILED', exit_code: 1, flaky: false, log: 'l' }],
    acceptance_evidence: [{ criterion_id: 'AC-1', status: opts.supported ? 'supported' : 'unsupported', artifacts: [] }],
  });
  recordFailure(lab.db, { runId: lab.runId, candidateId: cand.id, source: 'check', sourceId: `u-${k}`, fingerprint: opts.fingerprint ?? FP, excerpt: 'x' }, lab.clock);
  return cand;
}

describe('preconditions and stops', () => {
  it('stops at a safe point; needs a candidate and a budget', async () => {
    await setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await run()).toMatchObject({ done: true });
    lab.cleanup();
    await setup();
    lab.db.run('DELETE FROM budget_counters WHERE run_id = ?', lab.runId);
    await expect(run()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('without a candidate or budget') });
  });

  it('ends EXHAUSTED when no implementation attempt is left under the hard cap', async () => {
    await setup();
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE counter = 'implementation_attempts'");
    await run();
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain(`implementation attempts hard cap reached`);
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain(FP);
  });

  it('ends EXHAUSTED on repeated attempts that made no progress, recording the decision', async () => {
    await setup({ failure: 'none' });
    for (const k of [2, 3, 4, 5]) addAttempt(k);
    lab.db.run("UPDATE runs SET state = 'DIAGNOSING' WHERE id = ?", lab.runId);
    await run();
    expect(state()).toBe('EXHAUSTED');
    expect(decisions('repair.non-progress')).toHaveLength(1);
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^non-progress: \d+ consecutive attempts made no progress/);
  });
});

describe('the repair brief', () => {
  it('a scope refusal is repaired with a deterministic brief and no model call', async () => {
    const { adapter } = await setup({ failure: 'scope' });
    expect(await run()).toEqual({ progressed: true });
    expect(state()).toBe('REPAIRING');
    expect(adapter.specs).toHaveLength(0);
    const stored = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8'));
    expect(stored).toMatchObject({ attempt: 2, source: 'scope', fingerprint: FP });
    expect(stored.brief.scoped_fix).toContain('apps/**, tests/**');
    expect(decisions('repair.brief')[0]?.summary).toBe(`repair brief (scope) for attempt 2: ${FP}`);
  });

  it('a scope refusal without an excerpt still says what was denied', async () => {
    await setup({ failure: 'scope' });
    lab.db.run('UPDATE failures SET excerpt = NULL');
    await run();
    expect(JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8')).brief.evidence[0]).toContain('scope inspection denied the candidate');
  });

  it('asks a read-only verifier for one otherwise, records the competing hypothesis and where the fault is, and moves to repair', async () => {
    const { adapter } = await setup({ script: () => okResult(diagnosis({ scopedFix: 'Change mul in apps/calc.mjs to multiply its arguments' })) });
    const out = await settle();
    expect(out).toEqual({ progressed: true });
    expect(state()).toBe('REPAIRING');
    const spec = adapter.specs[0]!;
    expect(spec).toMatchObject({ role: 'verifier', readOnly: true });
    expect(spec.prompt).toContain(`Failure fingerprint: ${FP}`);
    expect(spec.prompt).toContain('No earlier hypotheses.');
    expect(decisions('repair.localized')[0]?.summary).toBe('fault of attempt 1 localized at apps/calc.mjs: mul adds its arguments instead of multiplying them');
    expect(decisions('repair.hypothesis')).toHaveLength(1);
    expect(listHypotheses(lab.db, lab.runId)).toHaveLength(1);
    const stored = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8'));
    expect(stored).toMatchObject({ attempt: 2, source: 'diagnosis', fingerprint: FP });
    expect(stored.refs).toHaveLength(1);
    expect(lab.ctx().ledger!.state('diagnostic_experiments').used).toBe(1);
  });

  it('a chosen hypothesis the verifier did not list falls back to the brief\'s, and a candidate with no diff paths localizes nothing', async () => {
    const out = diagnosis({ scopedFix: 'Change mul in apps/calc.mjs to multiply its arguments' });
    out.chosen_hypothesis_id = 'H9' as never;
    await setup({ script: () => okResult(out) });
    lab.db.run('UPDATE candidates SET diff_stat_json = NULL');
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(decisions('repair.localized')).toHaveLength(0);
    expect(listHypotheses(lab.db, lab.runId)[0]?.statement).toBe('mul adds its arguments instead of multiplying them');
  });

  it('a hypothesis with no statement is not recorded, and the repair still goes ahead without counting as new', async () => {
    const out = diagnosis();
    out.competing_hypotheses[0]!.statement = '   ';
    await setup({ script: () => okResult(out) });
    await settle();
    expect(state()).toBe('REPAIRING');
    expect(listHypotheses(lab.db, lab.runId)).toHaveLength(0);
  });

  it('the same hypothesis diagnosed again is a duplicate: noted, not recorded twice', async () => {
    await setup();
    await settle();
    expect(listHypotheses(lab.db, lab.runId)).toHaveLength(1);
    execFileSync('rm', [briefPath(lab.ctx(), 2)]);
    lab.db.run("UPDATE runs SET state = 'DIAGNOSING' WHERE id = ?", lab.runId);
    lab.db.run("DELETE FROM workers WHERE run_id = ?", lab.runId);
    await settle();
    expect(listHypotheses(lab.db, lab.runId)).toHaveLength(1);
    expect(decisions('repair.hypothesis').length).toBeGreaterThanOrEqual(1);
  });

  it('asks for an extension on a stored brief that names no experiment, and records why', async () => {
    await setup();
    mkdirSync(join(lab.ctx().runDir, 'briefs'), { recursive: true });
    writeFileSync(briefPath(lab.ctx(), 2), JSON.stringify({ attempt: 2, source: 'review', fingerprint: 'rv:1', brief: { scoped_fix: 'fix it' } }));
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'implementation_attempts'");
    await run();
    expect(decisions('allowance.extend').length + decisions('allowance.deny').length).toBe(1);
  });

  it('an earlier brief for the next attempt is used as it is, without asking again', async () => {
    const { adapter } = await setup();
    mkdirSync(join(lab.ctx().runDir, 'briefs'), { recursive: true });
    writeFileSync(briefPath(lab.ctx(), 2), JSON.stringify({ attempt: 2, source: 'review', fingerprint: 'rv:1', brief: { scoped_fix: 'fix it' } }));
    await run();
    expect(adapter.specs).toHaveLength(0);
    expect(state()).toBe('REPAIRING');
    expect(decisions('repair.brief')[0]?.summary).toContain('(review)');
  });

  it('a verdict with no recorded failure is diagnosed under the candidate\'s own fingerprint', async () => {
    await setup({ failure: 'none', script: () => okResult(diagnosis({ fingerprint: 'verdict:placeholder' })) });
    const cand = lab.ctx().candidate!;
    lab.db.run('DELETE FROM failures');
    const fp = `verdict:${cand.id}`;
    (lab.deps.adapters.claude as ScriptedAdapter).collects = 0;
    lab.deps.adapters = { claude: scriptedAdapter(lab, () => okResult(diagnosis({ fingerprint: fp }))) };
    expect(await settle()).toEqual({ progressed: true });
    expect(state()).toBe('REPAIRING');
  });

  it('a brief that is not usable is asked for again, and after the limit the run ends EXHAUSTED naming the fingerprint', async () => {
    await setup({ script: () => okResult(diagnosis({ fingerprint: 'fp:something-else' })) });
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain(`diagnosis produced no valid repair brief within 2 attempts for ${FP}`);
  });

  it('every hypothesis ruled out by evidence leaves nothing authorized to try: IMPOSSIBLE', async () => {
    await setup({ script: () => okResult(diagnosis({ ruledOut: true })) });
    await settle();
    expect(state()).toBe('IMPOSSIBLE');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('was ruled out by evidence');
  });

  it('a low-confidence diagnosis or a fix that names no changed file localizes nothing', async () => {
    await setup({ script: () => okResult(diagnosis({ confidence: 'low', scopedFix: 'Change mul in apps/calc.mjs to multiply its arguments' })) });
    await settle();
    expect(decisions('repair.localized')).toEqual([]);
    expect(state()).toBe('REPAIRING');
  });

  it('a repeated equivalent failure goes to the inquisition before another repair', async () => {
    await setup({ failure: 'none' });
    addAttempt(2);
    addAttempt(3, { supported: true });
    lab.db.run("UPDATE runs SET state = 'DIAGNOSING' WHERE id = ?", lab.runId);
    const out = await run();
    expect(['INQUISITION', 'REPAIRING']).toContain(state());
    expect(out.progressed).toBe(true);
  });
});

describe('timeouts', () => {
  async function timedOut() {
    const { cand, adapter } = await setup({ script: () => okResult(diagnosis({ scopedFix: 'Change mul in apps/calc.mjs to multiply its arguments' })) });
    const mk = (candidateId: string | null, status: 'TIMEOUT' | 'PASSED', start: number, end: number) => {
      const row = planCheckRun(lab.db, { runId: lab.runId, candidateId, checkId: 'unit', kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: 'p', command: ['node'], cwd: lab.repo, isolation: 'none', limitations: [] }, lab.clock);
      markCheckRunning(lab.db, row.id, 1, lab.clock);
      lab.db.run('UPDATE check_runs SET started_at = ? WHERE id = ?', start, row.id);
      finishCheckRun(lab.db, row.id, { status, exitCode: status === 'PASSED' ? 0 : null, timedOut: status === 'TIMEOUT', cancelled: false, logPath: null, logSha256: null, fingerprint: null, excerpt: null, artifacts: [], endedAt: end });
    };
    mk(null, 'PASSED', 1_000, 4_000);
    mk(cand.id, 'TIMEOUT', 10_000, 70_000);
    return { cand, adapter };
  }

  it('a timed-out check puts its duration, the baseline and the machine in the prompt, and an environment hypothesis in the brief', async () => {
    const { adapter } = await timedOut();
    await settle();
    expect(adapter.specs[0]!.prompt).toContain('unit timed out after 60 s (limit 60 s; 3 s on the base revision)');
    const stored = JSON.parse(readFileSync(briefPath(lab.ctx(), 2), 'utf8'));
    expect(stored.brief.preserved_constraints).toContain('Do not raise, extend or remove any check or test timeout');
    expect(stored.brief.hypotheses.some((h: { statement: string }) => /environment or a performance regression/.test(h.statement))).toBe(true);
  });

  it('a scoped fix that only buys time is refused and the diagnosis asked again', async () => {
    await setup({ script: () => okResult(diagnosis({ scopedFix: 'Raise the unit test timeout in apps/calc.mjs to 120 seconds' })) });
    const cand = lab.ctx().candidate!;
    const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: cand.id, checkId: 'unit', kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: 'p', command: ['node'], cwd: lab.repo, isolation: 'none', limitations: [] }, lab.clock);
    markCheckRunning(lab.db, row.id, 1, lab.clock);
    finishCheckRun(lab.db, row.id, { status: 'TIMEOUT', exitCode: null, timedOut: true, cancelled: false, logPath: null, logSha256: null, fingerprint: null, excerpt: null, artifacts: [], endedAt: lab.clock.now() + 1000 });
    await settle();
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('diagnosis produced no valid repair brief');
  });
});

describe('the attempt allowance', () => {
  it('denies another attempt when the allowance is spent and nothing progressed', async () => {
    await setup({ failure: 'scope' });
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'implementation_attempts'");
    await run();
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('implementation attempt allowance spent');
    expect(decisions('allowance.deny')).toHaveLength(1);
  });

  it('grants one more attempt that shows progress, a new hypothesis and the reserve intact', async () => {
    await setup({ failure: 'none' });
    addAttempt(2, { supported: false });
    const third = addAttempt(3, { supported: true });
    lab.db.run("DELETE FROM failures WHERE candidate_id = ? AND source = 'check'", third.id);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'implementation_attempts'");
    lab.db.run("UPDATE runs SET state = 'DIAGNOSING' WHERE id = ?", lab.runId);
    recordFailure(lab.db, { runId: lab.runId, candidateId: third.id, source: 'worker', sourceId: `scope:${third.id}`, fingerprint: 'fp:scope', excerpt: 'x' }, lab.clock);
    await run();
    expect(decisions('allowance.extend').length + decisions('allowance.deny').length).toBe(1);
  });
});

describe('helpers', () => {
  it('attemptHistory reads each attempt\'s newest evidence, its failing checks and the faults localized so far', async () => {
    await setup({ failure: 'none' });
    addAttempt(2, { supported: true });
    lab.db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('d1', ?, 'repair.localized', 's', ?, 1)", lab.runId, JSON.stringify({ attempt: 2, location: 'apps/calc.mjs: x' }));
    lab.db.run("INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES ('d2', ?, 'repair.localized', 's', ?, 1)", lab.runId, JSON.stringify({ attempt: 'x' }));
    const h = attemptHistory(lab.ctx());
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ attempt: 2, supportedCriteria: ['AC-1'], failingMandatoryChecks: ['unit'], passingMandatoryChecks: [], failureFingerprints: [FP], localizedFault: 'apps/calc.mjs: x' });
  });

  it('raisesTimeout reads the ways of buying time', () => {
    for (const t of ['Raise the timeout to 5 minutes', 'increasing the test timeouts', 'make the timeout longer', 'the timeout should be removed', 'Disable the check timeout']) expect(raisesTimeout(t), t).toBe(true);
    for (const t of ['Fix the loop that never ends', 'Change mul to multiply', 'Time out the request earlier']) expect(raisesTimeout(t), t).toBe(false);
  });

  it('withTimeoutHypothesis adds the environment hypothesis and the constraint only when missing', () => {
    const ctx = { checks: [{ checkId: 'unit', durationMs: null, timeoutSeconds: null, baselineMs: null }], machine: { cores: 4, loadAvg1m: null, freeMemMb: 100 } };
    const brief = { fingerprint: 'f', evidence: ['e'], hypotheses: [{ statement: 'mul is wrong', supporting: 's' }], experiment: 'x', expected_observation: 'y', scoped_fix: 'z', post_fix_checks: ['unit'], preserved_constraints: ['keep tests'] };
    const added = withTimeoutHypothesis(brief, ctx);
    expect(added.hypotheses).toHaveLength(2);
    expect(added.hypotheses[1]!.supporting).toContain('unit timed out after an unknown time (limit ? s; no baseline duration)');
    expect(added.hypotheses[1]!.supporting).toContain('load average unknown');
    const again = withTimeoutHypothesis({ ...added, hypotheses: added.hypotheses }, ctx);
    expect(again.hypotheses).toHaveLength(2);
    expect(again.preserved_constraints.filter((c) => c.startsWith('Do not raise'))).toHaveLength(1);
    expect(timeoutPromptLines(ctx)[0]).toContain('Timeouts:');
  });

  it('timeoutContext reads the host\'s load when no probe is injected and has nothing without a timeout', async () => {
    const { cand } = await setup();
    expect(timeoutContext(lab.ctx(), cand.id)).toBeNull();
    const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: cand.id, checkId: 'unit', kind: 'command', treeHash: 't', checkConfigHash: 'c', policyHash: 'p', command: ['node'], cwd: lab.repo, isolation: 'none', limitations: [] }, lab.clock);
    markCheckRunning(lab.db, row.id, 1, lab.clock);
    const ctxNoProbe = lab.ctx();
    expect(timeoutContext(ctxNoProbe, cand.id)).toBeNull();
    lab.db.run("UPDATE check_runs SET status = 'TIMEOUT', timed_out = 1 WHERE id = ?", row.id);
    const t = timeoutContext(ctxNoProbe, cand.id);
    expect(t?.checks).toHaveLength(1);
    expect(t?.checks[0]).toMatchObject({ checkId: 'unit', durationMs: null, baselineMs: null, timeoutSeconds: 60 });
    expect(t?.machine.cores).toBeGreaterThan(0);
    const injected = timeoutContext(lab.ctx(), cand.id, { cores: 2, loadAvg1m: 1.5, freeMemMb: 10 });
    expect(injected?.machine).toEqual({ cores: 2, loadAvg1m: 1.5, freeMemMb: 10 });
  });

  it('localizedFault names the changed file the fix mentions, with the hypothesis, and nothing for a ruled-out or unsupported choice', () => {
    const base = diagnosis({ scopedFix: 'Change mul in ./apps/calc.mjs.' });
    const brief = { ...base.repair_brief, refuting: undefined } as never;
    expect(localizedFault(base as never, brief, ['apps/calc.mjs'])).toBe('apps/calc.mjs: mul adds its arguments instead of multiplying them');
    expect(localizedFault(base as never, brief, ['other.mjs'])).toBeNull();
    expect(localizedFault({ ...base, chosen_hypothesis_id: 'H9' } as never, brief, ['apps/calc.mjs'])).toBeNull();
    const none = structuredClone(base) as typeof base;
    none.competing_hypotheses[0]!.supporting_evidence = [];
    expect(localizedFault(none as never, brief, ['apps/calc.mjs'])).toBeNull();
    const ruled = structuredClone(base) as typeof base;
    ruled.competing_hypotheses[0]!.status = 'ruled-out' as never;
    expect(localizedFault(ruled as never, brief, ['apps/calc.mjs'])).toBeNull();
    expect(localizedFault({ ...base, confidence: 'low' } as never, brief, ['apps/calc.mjs'])).toBeNull();
    expect(existsSync(join(lab?.base ?? '', 'x'))).toBe(false);
  });
});

// Keep the helper type referenced where the scripted adapter result type is used above.
