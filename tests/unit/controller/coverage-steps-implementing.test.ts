import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskResult } from '../../../src/adapters/types.ts';
import { insertQuestion, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import { listDecisions, recordDecision } from '../../../src/storage/decisions.ts';
import { listCandidates, recordFailure } from '../../../src/evidence/store.ts';
import { listWorkers, markWorkerRunning, planWorker, getWorker } from '../../../src/storage/workers.ts';
import { getRun, requestCancel } from '../../../src/controller/run-store.ts';
import { APPROVE_ONCE, DENY } from '../../../src/controller/authorization.ts';
import { ATTEMPT_EVENT, AUTHORIZATION_RETRY_EVENT, LOST_RESTART_EVENT, briefPath, currentAttempt, attemptCandidateId, implementingStep, routeSignals, runningUnits } from '../../../src/controller/steps/implementing.ts';
import { CANDIDATE_EVENT } from '../../../src/controller/context.ts';
import { addCandidate, addEvidence, giveRepository, initLedger, makeUnitLab, okResult, OWNER, scriptedAdapter, setContract, validateModels, type ScriptedAdapter, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const IMPL = { summary: 's', changed_paths: [], tests_added: [], checks_run: [], evidence_refs: [], remaining_issues: [], next_action: { kind: 'request-verification', detail: 'd' } };
const edit = (rel: string, text: string) => (cwd: string) => {
  mkdirSync(join(cwd, rel, '..'), { recursive: true });
  writeFileSync(join(cwd, rel), text);
};

interface Setup {
  script?: Parameters<typeof scriptedAdapter>[1];
  onStart?: Parameters<typeof scriptedAdapter>[2];
  supervised?: boolean;
  tweak?: Parameters<typeof makeUnitLab>[0] extends infer O ? (O extends { tweak?: infer T } ? T : never) : never;
  probe?: { availableParallelism: () => number; freemem: () => number };
}

async function setup(o: Setup = {}): Promise<{ adapter: ScriptedAdapter }> {
  const holder: { adapter?: ScriptedAdapter } = {};
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'],
    deps: { schedulerProbe: o.probe ?? { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } },
    tweak: (c) => {
      if (o.supervised) c.mode = 'supervised';
      o.tweak?.(c);
    },
  });
  holder.adapter = scriptedAdapter(lab, o.script ?? (() => okResult(IMPL)), o.onStart);
  lab.deps.adapters = { claude: holder.adapter };
  validateModels(lab);
  const repo = await giveRepository(lab);
  setContract(lab, { baseline_revision: repo.base });
  initLedger(lab);
  return { adapter: holder.adapter };
}

const run = () => implementingStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const events = (type: string) => lab.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, type).map((e) => JSON.parse(e.data_json));
const decisions = (kind: string) => listDecisions(lab.db, lab.runId, { kind });

/** Run the step until it stops waiting for a worker. */
async function settle(max = 10) {
  let out = await run();
  for (let i = 0; i < max && out.waiting && /is running$/.test(out.waiting); i++) out = await run();
  return out;
}

describe('a first attempt', () => {
  it('is counted, routed, funded and given to an implementer in the run\'s worktree, then snapshotted into a candidate and sent to verification', async () => {
    const { adapter } = await setup({ onStart: (s) => edit('apps/calc.mjs', 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n')(s.cwd) });
    const first = await run();
    expect(first.waiting).toMatch(/^implementer wrk-.+ \(attempt 1\) is running$/);
    expect(currentAttempt(lab.ctx())).toBe(1);
    expect(events(ATTEMPT_EVENT)).toHaveLength(1);
    const spec = adapter.specs[0]!;
    expect(spec).toMatchObject({ role: 'implementer', readOnly: false, cwd: getRun(lab.db, lab.runId).worktreePath });
    expect(spec.prompt).toContain('Implement the contract below in this worktree.');
    expect(listWorkers(lab.db, { runId: lab.runId })[0]?.ownedPaths).toEqual(['apps/**', 'tests/**']);
    const done = await settle();
    expect(done).toEqual({ progressed: true });
    expect(state()).toBe('VERIFYING');
    const cands = listCandidates(lab.db, lab.runId);
    expect(cands).toHaveLength(1);
    expect(events(CANDIDATE_EVENT)[0]).toMatchObject({ attempt: 1, candidate_id: cands[0]!.id, reused: false });
    expect(attemptCandidateId(lab.ctx(), 1)).toBe(cands[0]!.id);
  });

  it('a worker that ended badly still has its edits snapshotted and verified, with a note', async () => {
    await setup({ script: () => okResult(null, { status: 'failed', error: 'crashed after editing' }), onStart: (s) => edit('apps/x.mjs', 'x\n')(s.cwd) });
    await settle();
    expect(state()).toBe('VERIFYING');
    expect(events('implementation.worker-ended')[0]).toMatchObject({ attempt: 1, status: 'failed', error: 'crashed after editing' });
  });

  it('the same tree twice is the same candidate, and the transition says so', async () => {
    await setup();
    await settle();
    const first = listCandidates(lab.db, lab.runId)[0]!;
    // The attempt's candidate is verified and the run comes back to implement with the tree unchanged.
    addEvidence(lab, first);
    lab.db.run("UPDATE runs SET state = 'IMPLEMENTING' WHERE id = ?", lab.runId);
    await settle();
    expect(listCandidates(lab.db, lab.runId)).toHaveLength(1);
    expect(events(CANDIDATE_EVENT).at(-1)).toMatchObject({ attempt: 2, reused: true });
    expect(getRun(lab.db, lab.runId).state).toBe('VERIFYING');
  });

  it('resumes a candidate that awaits verification without starting a worker', async () => {
    await setup();
    await settle();
    const before = listWorkers(lab.db, { runId: lab.runId }).length;
    lab.db.run("UPDATE runs SET state = 'IMPLEMENTING' WHERE id = ?", lab.runId);
    expect(await run()).toEqual({ progressed: true });
    expect(state()).toBe('VERIFYING');
    expect(listWorkers(lab.db, { runId: lab.runId })).toHaveLength(before);
  });

  it('stops at a safe point and refuses a run with no budget or worktree', async () => {
    await setup();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    expect(await run()).toMatchObject({ done: true });
    lab.cleanup();
    await setup();
    lab.db.run('DELETE FROM budget_counters WHERE run_id = ?', lab.runId);
    await expect(run()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('without budget counters') });
    lab.cleanup();
    await setup();
    lab.db.run('UPDATE runs SET worktree_path = NULL WHERE id = ?', lab.runId);
    await expect(run()).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('no worktree or base revision') });
  });
});

describe('admission of an attempt', () => {
  it('waits when the machine has no capacity, saying why', async () => {
    await setup({ probe: { availableParallelism: () => 1, freemem: () => 64_000 * 1024 * 1024 } });
    // Another run's live writer takes the only slot.
    lab.db.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('orb-other', ?, 'g', 'autonomous', 'IMPLEMENTING', 'h', '/p', 1, 1)", lab.repo);
    lab.db.run("INSERT INTO workers (id, run_id, role, purpose, provider, state, worker_dir, cwd, created_at) VALUES ('wrk-other', 'orb-other', 'implementer', 'implement:1#1', 'claude', 'RUNNING', '/wd', '/wt', 1)");
    const out = await run();
    expect(out.progressed).toBe(false);
    expect(out.waiting).toMatch(/^attempt 1 deferred: /);
    expect(currentAttempt(lab.ctx())).toBe(0);
  });

  it('ends EXHAUSTED when the budget cannot support an honest completion', async () => {
    await setup();
    lab.db.run("UPDATE budget_counters SET used = hard_cap - 0.0001 WHERE counter = 'cost_usd'");
    const out = await run();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toMatch(/^attempt 1 not admitted|^attempt 1 not started/);
  });
});

describe('failures of a session', () => {
  it('an authentication failure blocks the run on credentials', async () => {
    await setup({ script: () => okResult(null, { status: 'auth_failed', error: 'expired' }) });
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('BLOCKED');
  });

  it('a transient failure backs off and starts a new session of the same attempt, and a stray cancellation is retried the same way', async () => {
    let n = 0;
    await setup({
      script: ({ purpose }) => {
        if (purpose === 'implement:1#1') return okResult(null, { status: 'transient_error', error: 'overloaded; retry after 3s' });
        if (purpose === 'implement:1#2') return okResult(null, { status: 'cancelled' });
        n++;
        return okResult(IMPL);
      },
    });
    lab.deps.random = () => 0;
    const out = await settle();
    expect(out.waiting).toMatch(/backing off/);
    for (let i = 0; i < 8 && state() === 'IMPLEMENTING'; i++) {
      lab.clock.advance(120_000);
      await settle();
    }
    expect(state()).toBe('VERIFYING');
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'implementer' }).map((w) => w.purpose)).toEqual(['implement:1#1', 'implement:1#2', 'implement:1#3']);
    expect(n).toBeGreaterThan(0);
  });

  it('a session whose response exceeded the output cap is retried once in the same attempt with the cap doubled, and the decision is recorded (P29)', async () => {
    const { adapter } = await setup({
      script: ({ purpose }) =>
        purpose === 'implement:1#1'
          ? okResult(null, { status: 'failed', error: "API Error: Claude's response exceeded the 8000 output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable." })
          : okResult(IMPL),
    });
    const out = await settle();
    for (let i = 0; i < 8 && state() === 'IMPLEMENTING'; i++) await settle();
    expect(out).toBeDefined();
    expect(state()).toBe('VERIFYING');
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'implementer' }).map((w) => w.purpose)).toEqual(['implement:1#1', 'implement:1#2']);
    expect(adapter.specs.map((sp) => sp.outputTokens)).toEqual([undefined, 16000]);
    expect(decisions('worker.output-cap-raised')).toHaveLength(1);
  });

  it('a cancellation that arrives while the session runs ends the step at the next safe point', async () => {
    await setup({
      script: () => {
        requestCancel(lab.db, lab.runId, 'u', lab.clock);
        return okResult(null, { status: 'cancelled' });
      },
    });
    await run();
    const out = await run();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('CANCELLED');
  });

  it('an attempt already recorded (a crash after counting it) is not counted again', async () => {
    await setup();
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, ?, 'x', ?)", lab.runId, ATTEMPT_EVENT, JSON.stringify({ attempt: 1 }));
    const before = lab.ctx().ledger!.state('implementation_attempts').used;
    await run();
    expect(lab.ctx().ledger!.state('implementation_attempts').used).toBe(before);
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })).toHaveLength(1);
  });

  it('a lost worker already restarted is not restarted, or charged, again', async () => {
    await setup({ script: ({ purpose }) => (purpose === 'implement:1#1' ? okResult(null, { status: 'lost' }) : okResult(IMPL)) });
    await run();
    const w = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })[0]!;
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, ?, 'x', ?)", lab.runId, LOST_RESTART_EVENT, JSON.stringify({ worker_id: w.id, attempt: 1 }));
    await run();
    expect(lab.db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'recovery_attempts'", lab.runId)?.used).toBe(0);
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'implementer' }).length).toBeGreaterThan(1);
  });

  it('a cancellation of the run itself ends the step instead of retrying', async () => {
    await setup({ script: () => okResult(null, { status: 'cancelled' }) });
    await run();
    requestCancel(lab.db, lab.runId, 'u', lab.clock);
    const out = await run();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('CANCELLED');
  });

  it('a transient failure with no retry left ends the run EXHAUSTED', async () => {
    await setup({ script: () => okResult(null, { status: 'transient_error', error: 'overloaded' }) });
    await run();
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'infrastructure_retries'");
    const out = await settle();
    expect(out).toMatchObject({ done: true });
    expect(state()).toBe('EXHAUSTED');
  });
});

describe('a lost implementer', () => {
  it('is restarted in the preserved worktree under the recovery budget, once per lost worker', async () => {
    await setup({ script: ({ purpose }) => (purpose === 'implement:1#1' ? okResult(null, { status: 'lost', error: 'shim vanished' }) : okResult(IMPL)) });
    let out = await settle();
    for (let i = 0; i < 6 && state() === 'IMPLEMENTING'; i++) out = await settle();
    expect(state()).toBe('VERIFYING');
    expect(events(LOST_RESTART_EVENT)).toHaveLength(1);
    expect(events(LOST_RESTART_EVENT)[0]).toMatchObject({ attempt: 1, next_purpose: 'implement:1#2', live_controller: true });
    expect(lab.db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'recovery_attempts'", lab.runId)?.used).toBe(1);
    expect(out).toBeDefined();
  });

  it('ends EXHAUSTED when the recovery budget refuses the restart', async () => {
    await setup({ script: () => okResult(null, { status: 'lost' }) });
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE counter = 'recovery_attempts'");
    await settle();
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('recovery_attempts exhausted: lost implementer');
  });

  it('waits when the lost worker\'s process cannot be confirmed stopped, and does not restart yet', async () => {
    await setup({ script: () => okResult(null, { status: 'lost' }) });
    await run();
    const w = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })[0]!;
    // The row names a live process that cannot be verified as the worker.
    lab.db.run('UPDATE workers SET pid = ?, pgid = ?, proc_start = NULL WHERE id = ?', process.pid, process.pid, w.id);
    const out = await run();
    expect(out.waiting).toContain('its process could not be confirmed stopped; not restarting yet');
    expect(events(LOST_RESTART_EVENT)).toEqual([]);
  });

  it('a restart that finds no funded session left ends EXHAUSTED', async () => {
    await setup({ script: () => okResult(null, { status: 'lost', usage: { provider: 'claude', model: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0, costSource: 'reported' } }) });
    await run();
    // Spend right up to the line the closing reserve draws under the hard cap.
    const reserve = lab.ctx().ledger!.reserve().cost_usd;
    lab.db.run("UPDATE budget_counters SET used = hard_cap - ? WHERE counter = 'cost_usd'", reserve + 0.01);
    await run();
    expect(state()).toBe('EXHAUSTED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('not restarted: no model budget left');
  });
});

describe('supervised mode', () => {
  const denyWrite = (workerId: string, command: string, rule = 'actions.change_permissions') =>
    recordDecision(lab.db, lab.ctx().runDir, { id: `dec-deny-${workerId}`, runId: lab.runId, kind: 'policy.deny', summary: 'denied', data: { source: 'guard-hook', worker_id: workerId, tool: 'Bash', rule, target: command, reason: 'not authorized' } }, lab.clock);

  it('asks a person about what the guard denied, blocks until answered, then retries the attempt with exactly the answers', async () => {
    await setup({ supervised: true });
    await run();
    const w = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })[0]!;
    denyWrite(w.id, 'chmod +x apps/run.sh');
    await run();
    expect(state()).toBe('BLOCKED');
    const reason = getRun(lab.db, lab.runId).outcomeReason!;
    expect(reason).toContain('implementation attempt 1 was denied operations the policy does not authorize');
    const [q] = lab.db.all<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', lab.runId);
    setQuestionAnswer(lab.db, q!.id, APPROVE_ONCE, 'quintin', lab.clock);
    lab.db.run("UPDATE runs SET state = 'IMPLEMENTING', outcome_reason = NULL WHERE id = ?", lab.runId);
    await run();
    const retry = events(AUTHORIZATION_RETRY_EVENT)[0];
    expect(retry).toMatchObject({ attempt: 1, after: 1, next: 2 });
    expect(retry.granted).toHaveLength(1);
    const next = await settle();
    expect(next.waiting ?? '').not.toContain('blocked');
    const second = lab.db.get<{ purpose: string }>("SELECT purpose FROM workers WHERE purpose = 'implement:1#2'");
    expect(second).toBeTruthy();
    const spec = (lab.deps.adapters.claude as ScriptedAdapter).specs.at(-1)!;
    expect(spec.prompt).toContain('Authorized once, for this attempt only');
    // The retried session is not widened: the controller ran the approved command, the worker keeps the frozen policy.
    expect(spec.policyPath).toBe(getRun(lab.db, lab.runId).policyPath);
    expect(spec.prompt).toContain('The controller ran exactly this command once, in isolation, on your behalf');
    expect(lab.db.all("SELECT state FROM actions WHERE run_id = ? AND kind = 'approved_command'", lab.runId)).toEqual([{ state: 'SUCCEEDED' }]);
  });

  it('a refused operation is retried as a scope repair, and each operation is retried at most once', async () => {
    await setup({ supervised: true });
    await run();
    const w = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })[0]!;
    denyWrite(w.id, 'chmod +x apps/run.sh');
    await run();
    const [q] = lab.db.all<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', lab.runId);
    setQuestionAnswer(lab.db, q!.id, DENY, 'quintin', lab.clock);
    lab.db.run("UPDATE runs SET state = 'IMPLEMENTING', outcome_reason = NULL WHERE id = ?", lab.runId);
    await run();
    expect(events(AUTHORIZATION_RETRY_EVENT)[0]).toMatchObject({ granted: [], refused: [expect.anything()] });
    await settle();
    const spec = (lab.deps.adapters.claude as ScriptedAdapter).specs.at(-1)!;
    expect(spec.prompt).toContain('Refused by a person');
    // The second session is not asked about the same operation again.
    expect(events(AUTHORIZATION_RETRY_EVENT)).toHaveLength(1);
  });

  it('a session under a grant that also did what no grant names is a policy violation, never verified', async () => {
    await setup({ supervised: true });
    await run();
    const w = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })[0]!;
    denyWrite(w.id, 'chmod +x apps/run.sh');
    await run();
    const [q] = lab.db.all<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', lab.runId);
    setQuestionAnswer(lab.db, q!.id, APPROVE_ONCE, 'quintin', lab.clock);
    lab.db.run("UPDATE runs SET state = 'IMPLEMENTING', outcome_reason = NULL WHERE id = ?", lab.runId);
    await run();
    const w2 = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' }).find((x) => x.purpose === 'implement:1#2')!;
    // The second session ran a permission change nobody authorized.
    appendFileSync(join(w2.workerDir, 'log.jsonl'), `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'chmod 777 apps/other.sh' } }] } })}\n`);
    const out = await run();
    expect(out).toMatchObject({ done: true });
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('policy violation in attempt 1: under a one-shot grant the implementer also ran what the policy denies');
    expect(decisions('policy.deny').some((d) => (d.data as { source?: string }).source === 'grant-check')).toBe(true);
    expect(getWorker(lab.db, w2.id).state).toBeDefined();
  });

  it('an unattended run never asks', async () => {
    await setup();
    await run();
    const w = listWorkers(lab.db, { runId: lab.runId, role: 'implementer' })[0]!;
    denyWrite(w.id, 'chmod +x apps/run.sh');
    await settle();
    expect(lab.db.all('SELECT 1 FROM questions WHERE run_id = ?', lab.runId)).toHaveLength(0);
    expect(state()).toBe('VERIFYING');
  });
});

describe('routing signals', () => {
  it('has no escalation evidence on a clean first attempt', async () => {
    await setup();
    expect(routeSignals(lab.ctx(), 1)).toEqual({ difficulty: 'medium', attempt: 1, repeatedFingerprints: 0 });
  });

  it('counts equivalent failures on distinct candidates as evidence, remembers the previous route and reads a security-sensitive plan', async () => {
    await setup();
    lab.db.run('UPDATE runs SET difficulty = ?, difficulty_json = ? WHERE id = ?', 'complex', JSON.stringify({ factors: [{ factor: 'security_impact', value: true }] }), lab.runId);
    const a = addCandidate(lab, { tree: 'a'.repeat(40), commit: '1'.repeat(40) });
    const b = addCandidate(lab, { tree: 'b'.repeat(40), commit: '2'.repeat(40) });
    for (const c of [a, b]) recordFailure(lab.db, { runId: lab.runId, candidateId: c.id, source: 'check', sourceId: `s-${c.id}`, fingerprint: 'fp:same', excerpt: 'x' }, lab.clock);
    recordDecision(lab.db, lab.ctx().runDir, { id: `dec-route-${lab.runId}-implement_1`, runId: lab.runId, kind: 'route', summary: 'r', data: { provider: 'claude', model: 'claude-sonnet-x', effort: null } }, lab.clock);
    const s = routeSignals(lab.ctx(), 2);
    expect(s).toMatchObject({ difficulty: 'complex', attempt: 2, repeatedFingerprints: 2, criticalSecurity: true, previousRoute: { provider: 'claude', model: 'claude-sonnet-x', outcome: 'failed' } });
    expect(s.evidence).toHaveLength(2);
  });

  it('a malformed difficulty record is no security signal', async () => {
    await setup();
    lab.db.run("UPDATE runs SET difficulty_json = '{bad' WHERE id = ?", lab.runId);
    expect(routeSignals(lab.ctx(), 1)).not.toHaveProperty('criticalSecurity');
    lab.db.run("UPDATE runs SET difficulty_json = '{}' WHERE id = ?", lab.runId);
    expect(routeSignals(lab.ctx(), 1)).not.toHaveProperty('criticalSecurity');
  });

  it('lets routine follow-up route back down once the diagnosis that escalated an earlier attempt is solved', async () => {
    await setup();
    const a = addCandidate(lab, { tree: 'a'.repeat(40), commit: '1'.repeat(40) });
    const b = addCandidate(lab, { tree: 'b'.repeat(40), commit: '2'.repeat(40) });
    const c = addCandidate(lab, { tree: 'c'.repeat(40), commit: '3'.repeat(40) });
    const link = (n: number, cand: { id: string }) => lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.candidate', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ attempt: n, candidate_id: cand.id }));
    link(1, a);
    link(2, b);
    link(3, c);
    recordFailure(lab.db, { runId: lab.runId, candidateId: a.id, source: 'check', sourceId: 's-a', fingerprint: 'fp:old', excerpt: 'x' }, lab.clock);
    recordFailure(lab.db, { runId: lab.runId, candidateId: b.id, source: 'check', sourceId: 's-b', fingerprint: 'fp:old', excerpt: 'x' }, lab.clock);
    recordDecision(lab.db, lab.ctx().runDir, { id: `dec-route-${lab.runId}-implement_2`, runId: lab.runId, kind: 'route', summary: 'r', data: { provider: 'claude', model: 'claude-opus-x', effort: null, escalated_from: { model: 'claude-sonnet-x' } } }, lab.clock);
    recordDecision(lab.db, lab.ctx().runDir, { id: `dec-route-${lab.runId}-implement_3`, runId: lab.runId, kind: 'route', summary: 'r', data: { provider: 'claude', model: 'claude-opus-x', effort: null } }, lab.clock);
    for (const k of [1, 2, 3]) lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.attempt', 'x', ?)", lab.runId, lab.clock.now(), JSON.stringify({ attempt: k }));
    addEvidence(lab, a, { verdict: 'FAIL', checks: [{ id: 'unit', status: 'FAILED', exit_code: 1, flaky: false, log: 'l' }] });
    addEvidence(lab, b, { verdict: 'FAIL', checks: [{ id: 'unit', status: 'FAILED', exit_code: 1, flaky: false, log: 'l' }] });
    addEvidence(lab, c, { verdict: 'PASS', checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: false, log: 'l' }] });
    const s = routeSignals(lab.ctx(), 4);
    expect(s).toMatchObject({ attempt: 4, diagnosisSolved: true });
  });

  it('lists every live worker of the repository and the attempts other runs reserved without a worker yet', async () => {
    await setup();
    lab.db.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('orb-other', ?, 'g', 'autonomous', 'IMPLEMENTING', 'h', '/p', 1, 1)", lab.repo);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES ('orb-other', 1, 'implementation.attempt', 'x', ?)", JSON.stringify({ attempt: 1 }));
    lab.db.run("INSERT INTO runs (id, repo_root, goal, mode, state, policy_hash, policy_path, created_at, updated_at) VALUES ('orb-third', ?, 'g', 'autonomous', 'REPAIRING', 'h', '/p', 1, 1)", lab.repo);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES ('orb-third', 1, 'implementation.attempt', 'x', ?)", JSON.stringify({ attempt: 2 }));
    lab.db.run("INSERT INTO workers (id, run_id, role, purpose, provider, attempt, state, worker_dir, cwd, created_at) VALUES ('wrk-third', 'orb-third', 'implementer', 'implement:2#1', 'claude', 2, 'PLANNED', '/wd', '/wt', 1)");
    const w = planWorker(lab.db, { id: 'wrk-mine', runId: lab.runId, role: 'verifier', provider: 'claude', workerDir: join(lab.base, 'wm'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    const units = runningUnits(lab.ctx());
    expect(units.map((u) => u.unit.id).sort()).toEqual(['reserved:orb-other:1', 'wrk-mine', 'wrk-third']);
    expect(units.find((u) => u.unit.id === 'wrk-mine')!.unit.writer).toBe(false);
    expect(units.find((u) => u.unit.id === 'wrk-third')!.unit.writer).toBe(false);
  });
});

describe('the implementer\'s prompt', () => {
  it('carries the repair brief and the evidence logs it cites, and tells a repair from a first attempt', async () => {
    const { adapter } = await setup();
    const cand = addCandidate(lab);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.candidate', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1, candidate_id: cand.id }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 1, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 1 }));
    const { planCheckRun, finishCheckRun, markCheckRunning } = await import('../../../src/evidence/store.ts');
    const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: cand.id, checkId: 'unit', kind: 'command', treeHash: cand.treeHash, checkConfigHash: 'c', policyHash: 'p', command: ['node'], cwd: lab.repo, isolation: 'none', limitations: [] }, lab.clock);
    markCheckRunning(lab.db, row.id, 1, lab.clock);
    finishCheckRun(lab.db, row.id, { status: 'FAILED', exitCode: 1, timedOut: false, cancelled: false, logPath: join(lab.ctx().runDir, 'evidence/1/unit.log'), logSha256: 'a'.repeat(64), fingerprint: 'fp:1', excerpt: 'expected 6 got 5', artifacts: [], endedAt: lab.clock.now() });
    mkdirSync(join(lab.ctx().runDir, 'briefs'), { recursive: true });
    writeFileSync(briefPath(lab.ctx(), 2), JSON.stringify({ attempt: 2, source: 'diagnosis', fingerprint: 'fp:1', brief: { scoped_fix: 'change mul' } }));
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, 2, 'implementation.attempt', 'x', ?)", lab.runId, JSON.stringify({ attempt: 2 }));
    lab.db.run("UPDATE runs SET state = 'REPAIRING' WHERE id = ?", lab.runId);
    insertQuestion(lab.db, { id: 'q-1', runId: lab.runId, mode: 'clarify', question: 'Which?', evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: ['AC-1'], unblocked: [] }, lab.clock);
    await run();
    const prompt = adapter.specs.at(-1)!.prompt;
    expect(prompt).toContain('Repair attempt 2: act on the repair brief below');
    expect(prompt).toContain('change mul');
    expect(prompt).toContain('unit FAILED on candidate 1');
    expect(prompt).toContain('Blocked, waiting for a person');
    expect(prompt).toContain('AC-1');
    expect(readFileSync(briefPath(lab.ctx(), 2), 'utf8')).toContain('diagnosis');
  });
});
