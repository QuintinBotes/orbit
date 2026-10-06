import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OrbitError } from '../../../src/core/errors.ts';
import { insertQuestion } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { markWorkerRunning, planWorker, getWorker } from '../../../src/storage/workers.ts';
import type { BudgetLedger } from '../../../src/scheduling/budget.ts';
import { getRun, requestCancel, setPaused, transition } from '../../../src/controller/run-store.ts';
import {
  MAX_REGENERATIONS,
  WORKER_RETRY_EVENT,
  assertContract,
  blockOnAuth,
  blockOnOpenQuestions,
  decide,
  finishRun,
  handleWorkerFailure,
  move,
  note,
  outcomeForError,
  policySummary,
  progress,
  retryAfterHintMs,
  retryWait,
  safePoint,
  scheduleTransientRetry,
} from '../../../src/controller/steps/common.ts';
import { createdStep, recoveringStep } from '../../../src/controller/steps/recovering.ts';
import { initLedger, makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const events = (type: string): { data_json: string | null }[] => lab.db.all('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, type);

describe('move, progress, note, decide', () => {
  it('moves the run, reports DONE for a terminal target and MOVED otherwise, and applies the patch and data', () => {
    lab = makeUnitLab();
    const ctx = lab.ctx();
    expect(move(ctx, 'PREFLIGHT', 'start', { data: { why: 'x' } })).toEqual({ progressed: true });
    expect(ctx.run.state).toBe('PREFLIGHT');
    expect(move(ctx, 'CANCELLED', 'stop', { patch: { outcomeReason: 'because' } })).toEqual({ progressed: true, done: true });
    expect(getRun(lab.db, lab.runId)).toMatchObject({ state: 'CANCELLED', outcomeReason: 'because' });
  });

  it('refuses to move a run that is no longer where the step found it', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    transition(lab.db, { runId: lab.runId, to: 'CONTRACTING', ownerId: OWNER, reason: 'someone else' }, lab.clock);
    expect(() => move(ctx, 'CONTRACTING', 'again')).toThrow(/expected PREFLIGHT/);
  });

  it('records progress, notes and decisions against the run, bounding the decision summary', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    progress(ctx, 'checks_passed', { n: 1 });
    note(ctx, 'custom.note', { a: 1 });
    expect(events('custom.note')).toHaveLength(1);
    const d = decide(ctx, { kind: 'test.kind', summary: 'x'.repeat(2000), data: { k: 1 } });
    expect(d.summary).toHaveLength(1000);
    expect(listDecisions(lab.db, lab.runId).some((x) => x.kind === 'test.kind')).toBe(true);
    expect(getRun(lab.db, lab.runId).lastProgressAt).not.toBeNull();
  });
});

describe('finishRun', () => {
  it('stops workers, records the outcome, moves the run and writes the final report', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const out = await finishRun(ctx, 'EXHAUSTED', 'out of budget', { data: { counter: 'cost_usd' }, outcome: { extra: 1 } });
    expect(out).toEqual({ progressed: true, done: true });
    const run = getRun(lab.db, lab.runId);
    expect(run).toMatchObject({ state: 'EXHAUSTED', outcomeReason: 'out of budget' });
    expect(JSON.parse(run.outcomeJson!)).toEqual({ state: 'EXHAUSTED', reason: 'out of budget', extra: 1 });
    expect(existsSync(join(ctx.runDir, 'final.md'))).toBe(true);
    expect(readFileSync(join(ctx.runDir, 'final.json'), 'utf8')).toContain('"outcome": "EXHAUSTED"');
  });

  it('a durable cancellation outranks the outcome the step decided, and says so', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    await finishRun(ctx, 'BLOCKED', 'needs a person');
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('CANCELLED');
    expect(run.outcomeReason).toBe('cancelled by request (the step had decided BLOCKED: needs a person)');
    expect(JSON.parse(run.outcomeJson!)).toMatchObject({ state: 'CANCELLED', decided: 'BLOCKED' });
  });

  it('names the workers that could not be stopped, in an event and in the outcome', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const w = planWorker(lab.db, { id: 'wrk-stuck', runId: lab.runId, role: 'planner', provider: 'claude', workerDir: join(lab.base, 'w'), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, w.id, { pid: process.pid, pgid: process.pid, procStart: null }, lab.clock, OWNER);
    await finishRun(lab.ctx(), 'BLOCKED', 'stuck');
    expect(events('workers.stop-failed')).toHaveLength(1);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!).workers_not_stopped).toHaveLength(1);
    expect(getWorker(lab.db, w.id).state).toBe('RUNNING');
  });
});

describe('blockOnAuth', () => {
  it('blocks the run on the credential, with the blocker as the outcome, and writes the report', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    const out = await blockOnAuth(ctx, 'claude', 'expired', 'token expired');
    expect(out).toEqual({ progressed: true, done: true });
    expect(getRun(lab.db, lab.runId).state).toBe('BLOCKED');
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('claude credentials');
    expect(existsSync(join(ctx.runDir, 'final.md'))).toBe(true);
    // Blocked again for the same provider: nothing more to record.
    expect(await blockOnAuth(lab.ctx(), 'claude', 'expired', null)).toEqual({ progressed: true, done: true });
  });

  it("advises from the controller's host environment, not the test process's: an exported key there means unset it, none means log in", async () => {
    // The controller's process.env is not what the workers get: the deps' host environment is (start.ts hostEnv).
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
    try {
      lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { hostEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'sk-ant-acme-not-valid' } } });
      await blockOnAuth(lab.ctx(), 'claude', 'auth_failed', null);
      const reason = getRun(lab.db, lab.runId).outcomeReason ?? '';
      expect(reason).toContain('ANTHROPIC_API_KEY is set');
      expect(reason).not.toContain('Run `claude auth login`');
      lab.cleanup();

      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-acme-in-the-test-process');
      lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { hostEnv: { PATH: process.env.PATH } } });
      await blockOnAuth(lab.ctx(), 'claude', 'auth_failed', null);
      const second = getRun(lab.db, lab.runId).outcomeReason ?? '';
      expect(second).toContain('Run `claude auth login`');
      expect(second).not.toContain('ANTHROPIC_API_KEY is set');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('a pending cancellation wins over the block', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    await blockOnAuth(lab.ctx(), 'claude', 'missing', null);
    expect(getRun(lab.db, lab.runId).state).toBe('CANCELLED');
  });
});

describe('safePoint', () => {
  it('stops an aborted step without touching the run', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ac = new AbortController();
    ac.abort();
    expect(await safePoint(lab.ctx(ac.signal))).toEqual({ progressed: false, done: true });
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
  });

  it('reports a run that already ended, and one that is paused, as nothing to do', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    setPaused(lab.db, lab.runId, true, 'user', lab.clock);
    expect(await safePoint(ctx)).toEqual({ progressed: false, done: true, waiting: 'paused' });
    setPaused(lab.db, lab.runId, false, 'user', lab.clock);
    transition(lab.db, { runId: lab.runId, to: 'CANCELLED', ownerId: OWNER, reason: 'x' }, lab.clock);
    expect(await safePoint(lab.ctx())).toEqual({ progressed: false, done: true });
  });

  it('turns a cancellation request into CANCELLED', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    expect(await safePoint(lab.ctx())).toEqual({ progressed: true, done: true });
    expect(getRun(lab.db, lab.runId).state).toBe('CANCELLED');
  });

  it('lets a healthy run through, and ends it EXHAUSTED when the wall-time or cost hard cap is reached', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    expect(await safePoint(lab.ctx())).toBeNull();
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE run_id = ? AND counter = 'cost_usd'", lab.runId);
    expect(await safePoint(lab.ctx())).toEqual({ progressed: true, done: true });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('EXHAUSTED');
    expect(run.outcomeReason).toMatch(/^model cost hard cap reached \(/);
  });

  it('a wall-time budget already at its cap refuses the sync with BUDGET_EXHAUSTED, which the step runner maps to EXHAUSTED', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = hard_cap WHERE run_id = ? AND counter = 'wall_ms'", lab.runId);
    const ctx = lab.ctx();
    const err = await safePoint(ctx).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'BUDGET_EXHAUSTED' });
    expect(await outcomeForError(ctx, err)).toEqual({ progressed: true, done: true });
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
  });

  it('prints fractional amounts with two decimals', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = hard_cap + 0.5 WHERE run_id = ? AND counter = 'cost_usd'", lab.runId);
    await safePoint(lab.ctx());
    expect(getRun(lab.db, lab.runId).outcomeReason).toBe('model cost hard cap reached (30.50 of 30)');
  });
});

describe('outcomeForError', () => {
  it('has no outcome for an error that is not an Orbit error or has no mapping', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    expect(await outcomeForError(ctx, new Error('plain'))).toBeNull();
    expect(await outcomeForError(ctx, 'text')).toBeNull();
    expect(await outcomeForError(ctx, new OrbitError('GIT_FAILED', 'git broke'))).toBeNull();
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
  });

  it('ends the run EXHAUSTED on a spent budget, carrying the details', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await outcomeForError(lab.ctx(), new OrbitError('BUDGET_EXHAUSTED', 'cost_usd used up', { counter: 'cost_usd' }));
    expect(getRun(lab.db, lab.runId)).toMatchObject({ state: 'EXHAUSTED', outcomeReason: 'cost_usd used up' });
    lab.cleanup();
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await outcomeForError(lab.ctx(), new OrbitError('BUDGET_EXHAUSTED', 'no details'));
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
  });

  it.each([
    ['AUTH_EXPIRED', { provider: 'codex' }, 'codex'],
    ['AUTH_MISSING', undefined, 'claude'],
    ['AUTH_EXPIRED', { provider: 7 }, 'claude'],
  ] as const)('%s blocks the run on the provider\'s credentials (%j)', async (code, details, provider) => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await outcomeForError(lab.ctx(), new OrbitError(code, 'rejected', details as never));
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toContain(`${provider} credentials`);
    expect(run.outcomeReason).toContain(code === 'AUTH_MISSING' ? 'are missing' : 'are expired');
  });

  it.each(['POLICY_TAMPERED', 'POLICY_DENIED', 'SCOPE_VIOLATION', 'ISOLATION_UNAVAILABLE', 'CONFIG_INVALID', 'CONTRACT_INVALID', 'PROVIDER_UNAVAILABLE'] as const)('%s blocks the run for a person', async (code) => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await outcomeForError(lab.ctx(), new OrbitError(code, 'cannot proceed'));
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    // A tampered snapshot or invalid configuration is in the run's frozen policy: resuming cannot clear it, so the reason also names a new run (P12).
    if (code === 'POLICY_TAMPERED' || code === 'CONFIG_INVALID') {
      expect(run.outcomeReason).toMatch(new RegExp(`^${code}: cannot proceed\. This comes from the run's frozen policy`));
      expect(run.outcomeReason).toMatch(/start a new run/);
    } else expect(run.outcomeReason).toBe(`${code}: cannot proceed`);
    lab.cleanup();
  });
});

describe('blockOnOpenQuestions', () => {
  const question = (over: { id: string; material: boolean; affected: string[] }) =>
    insertQuestion(
      lab.db,
      { id: over.id, runId: lab.runId, mode: 'clarify', question: `Which behaviour for ${over.id}?`, evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: over.material, affected: over.affected, unblocked: [] },
      lab.clock,
    );

  it('lets a run through when no material question blocks a criterion', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    question({ id: 'q-1', material: false, affected: ['AC-1'] });
    question({ id: 'q-2', material: true, affected: ['free text work item'] });
    expect(await blockOnOpenQuestions(lab.ctx(), 'delivery')).toBeNull();
  });

  it('blocks the run, naming one waiting criterion and its question, and how to resume', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    question({ id: 'q-1', material: true, affected: ['AC-2'] });
    const out = await blockOnOpenQuestions(lab.ctx(), 'delivery');
    expect(out).toEqual({ progressed: true, done: true });
    const reason = getRun(lab.db, lab.runId).outcomeReason!;
    expect(reason).toContain('AC-2 waits for a decision before delivery');
    expect(reason).toContain('q-1: Which behaviour for q-1?');
    expect(reason).toContain(`orbit resume ${lab.runId}`);
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ blocked_criteria: ['AC-2'], questions: ['q-1'] });
  });

  it('says "wait" for several criteria and lists at most five questions', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    for (let i = 1; i <= 7; i++) question({ id: `q-${i}`, material: true, affected: [`AC-${i}`] });
    await blockOnOpenQuestions(lab.ctx(), 'success');
    const reason = getRun(lab.db, lab.runId).outcomeReason!;
    expect(reason).toContain('wait for a decision before success');
    expect(reason.match(/q-\d: /g)).toHaveLength(5);
  });
});

describe('contract and policy helpers', () => {
  it('assertContract refuses a run with no contract', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(() => assertContract(lab.ctx())).toThrow(/reached PREFLIGHT without a contract/);
  });

  it('summarises the worker\'s authority from the policy, then from the contract scope', () => {
    lab = makeUnitLab({
      path: ['PREFLIGHT'],
      tweak: (c) => {
        c.network = { ...c.network, allowed_hosts: ['registry.example.test'] };
        c.dependencies = { ...c.dependencies, add_packages: true, change_lockfile: false };
        c.checks = {};
      },
    });
    const ctx = lab.ctx();
    const ro = policySummary(ctx, { readOnly: true });
    expect(ro).toContain('you are read-only: do not edit any file');
    expect(ro).toContain('you may edit only: apps/**, tests/**');
    expect(ro).toContain('network: registry.example.test');
    expect(ro).toContain('add packages allowed; lockfile changes not allowed');
    expect(ro).toContain('trusted checks (run by the controller, not you): none');
    const rw = policySummary(ctx, { readOnly: false });
    expect(rw).not.toContain('read-only');
    ctx.contract = { allowed_paths: ['apps/calc.mjs'] } as never;
    expect(policySummary(ctx, { readOnly: false })).toContain('you may edit only: apps/calc.mjs');
  });

  it('says there is no network and lists every check when the policy has them', () => {
    lab = makeUnitLab({
      path: ['PREFLIGHT'],
      tweak: (c) => {
        c.network = { ...c.network, allowed_hosts: [] };
      },
    });
    const text = policySummary(lab.ctx(), { readOnly: false });
    expect(text).toContain('network: none');
    expect(text).toContain('trusted checks (run by the controller, not you): unit');
  });
});

describe('retry-after hints', () => {
  it.each([
    [null, null],
    ['', null],
    ['no hint here', null],
    ['retry after 30s', 30_000],
    ['Retry-After: 1500 ms', 1_500],
    ['retry-after=2 seconds', 2_000],
    ['retry after 1.5 secs', 1_500],
    ['retry after 250 milliseconds', 250],
    ['retry after 12', 12_000],
    ['retry after 0.0004 ms', 0],
  ])('reads %j as %j', (text, ms) => {
    expect(retryAfterHintMs(text)).toBe(ms);
  });
});

describe('scheduleTransientRetry', () => {
  const failed = (purpose = 'implement:1#1', error: string | null = 'overloaded') => ({ base: 'implement:1', purpose, what: 'implementation 1', status: 'transient_error', error });

  it('without a ledger charges nothing, records the wait once per failed worker and honours the provider\'s retry-after', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { random: () => 0 } });
    const ctx = lab.ctx();
    expect(await scheduleTransientRetry(ctx, failed('p1', 'retry after 5s'))).toBeNull();
    const [rec] = events(WORKER_RETRY_EVENT).map((e) => JSON.parse(e.data_json!));
    expect(rec).toMatchObject({ base: 'implement:1', purpose: 'p1', retry: 1, delay_ms: 5000, retry_after_ms: 5000, not_before: ctx.clock.now() + 5000 });
    // The same failure seen again after waiting neither waits nor charges twice.
    expect(await scheduleTransientRetry(ctx, failed('p1'))).toBeNull();
    expect(events(WORKER_RETRY_EVENT)).toHaveLength(1);
    // A second failed worker of the family is the second retry.
    expect(await scheduleTransientRetry(ctx, failed('p2'))).toBeNull();
    expect(events(WORKER_RETRY_EVENT).map((e) => JSON.parse(e.data_json!).retry)).toEqual([1, 2]);
  });

  it('with a ledger spends one infrastructure retry per scheduled wait', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { random: () => 0.5 } });
    initLedger(lab);
    const ctx = lab.ctx();
    const before = ctx.ledger!.state('infrastructure_retries').used;
    expect(await scheduleTransientRetry(ctx, failed('p1', null))).toBeNull();
    expect(ctx.ledger!.state('infrastructure_retries').used).toBe(before + 1);
    expect(JSON.parse(events(WORKER_RETRY_EVENT)[0]!.data_json!).retry_after_ms).toBeNull();
  });

  it('ends the run EXHAUSTED when no infrastructure retry is left', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE run_id = ? AND counter = 'infrastructure_retries'", lab.runId);
    const out = await scheduleTransientRetry(lab.ctx(), failed('p1', 'x'.repeat(500)));
    expect(out).toEqual({ progressed: true, done: true });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('EXHAUSTED');
    expect(run.outcomeReason).toContain('the provider kept failing transiently');
    expect(JSON.parse(run.outcomeJson!).reason.length).toBeLessThan(500);
  });

  it('ends the run EXHAUSTED when waiting would outlast the wall budget', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { random: () => 0.99 } });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = hard_cap - 1 WHERE run_id = ? AND counter = 'wall_ms'", lab.runId);
    const out = await scheduleTransientRetry(lab.ctx(), failed('p1', 'retry after 10s'));
    expect(out).toEqual({ progressed: true, done: true });
    expect(JSON.parse(getRun(lab.db, lab.runId).outcomeJson!)).toMatchObject({ state: 'EXHAUSTED' });
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
  });

  it('blocks the run for a person when the attempt limit binds, naming the last error or status', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    for (let i = 1; i <= 4; i++) expect(await scheduleTransientRetry(ctx, failed(`p${i}`, null))).toBeNull();
    const out = await scheduleTransientRetry(ctx, failed('p5', null));
    expect(out).toEqual({ progressed: true, done: true });
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toContain('last: transient_error');
  });

  it('a retry-after longer than Orbit waits blocks with the provider\'s own words', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await scheduleTransientRetry(lab.ctx(), failed('p1', 'quota: retry after 7200s'));
    const run = getRun(lab.db, lab.runId);
    expect(run.state).toBe('BLOCKED');
    expect(run.outcomeReason).toContain('last: quota: retry after 7200s');
  });

  it('a budget that refuses the charge after the check passed ends the run EXHAUSTED and records no wait', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    const ctx = lab.ctx();
    const real = ctx.ledger!;
    ctx.ledger = Object.assign(Object.create(real), {
      consume: () => {
        throw new OrbitError('BUDGET_EXHAUSTED', 'infrastructure_retries refused', { counter: 'infrastructure_retries' });
      },
    }) as BudgetLedger;
    const out = await scheduleTransientRetry(ctx, failed('p1'));
    expect(out).toEqual({ progressed: true, done: true });
    expect(getRun(lab.db, lab.runId).outcomeReason).toContain('infrastructure_retries refused');
    expect(events(WORKER_RETRY_EVENT)).toHaveLength(0);
  });

  it('any other failure of the ledger surfaces', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    const ctx = lab.ctx();
    ctx.ledger = Object.assign(Object.create(ctx.ledger!), {
      consume: () => {
        throw new Error('ledger down');
      },
    }) as BudgetLedger;
    await expect(scheduleTransientRetry(ctx, failed('p1'))).rejects.toThrow('ledger down');
  });
});

describe('retryWait', () => {
  it('waits while the newest backoff is in the future and then lets the step go on', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], deps: { random: () => 0.9 } });
    const ctx = lab.ctx();
    expect(retryWait(ctx, 'implement:1')).toBeNull();
    await scheduleTransientRetry(ctx, { base: 'implement:1', purpose: 'p1', what: 'implementation 1', status: 'transient_error', error: 'retry after 3s' });
    const wait = retryWait(ctx, 'implement:1');
    expect(wait?.waiting).toBe('implementation 1: backing off 3000 ms after a transient failure (retry 1)');
    expect(retryWait(ctx, 'other:1')).toBeNull();
    lab.clock.advance(3_000);
    expect(retryWait(ctx, 'implement:1')).toBeNull();
  });

  it('ignores a stored record that holds no data or no wait', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const ctx = lab.ctx();
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, ?, 'x', NULL)", lab.runId, lab.clock.now(), WORKER_RETRY_EVENT);
    lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, ?, 'x', ?)", lab.runId, lab.clock.now(), WORKER_RETRY_EVENT, JSON.stringify({ base: 'b' }));
    expect(retryWait(ctx, 'b')).toBeNull();
  });
});

describe('handleWorkerFailure', () => {
  const opts = { attemptsUsed: 1, maxAttempts: 3, what: 'planning' };

  it('blocks on an authentication failure at once', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const out = await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'auth_failed', error: 'rejected' }, opts);
    expect(out).toMatchObject({ retry: false, result: { done: true } });
    expect(getRun(lab.db, lab.runId).state).toBe('BLOCKED');
  });

  it('a cancelled worker in a run that is being cancelled ends the step, and otherwise is regenerated', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'cancelled', error: null }, opts)).toEqual({ retry: true });
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    const out = await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'cancelled', error: null }, opts);
    expect(out).toMatchObject({ retry: false, result: { done: true } });
    expect(getRun(lab.db, lab.runId).state).toBe('CANCELLED');
  });

  it('a transient failure schedules a backoff and retries, naming the work unit by default and by purpose when given', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'transient_error', error: 'overloaded' }, opts)).toEqual({ retry: true });
    expect(await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'transient_error', error: 'overloaded' }, { ...opts, base: 'plan', purpose: 'plan:1' })).toEqual({ retry: true });
    const recs = events(WORKER_RETRY_EVENT).map((e) => JSON.parse(e.data_json!));
    expect(recs.map((r) => [r.base, r.purpose])).toEqual([
      ['planning', 'planning#1'],
      ['plan', 'plan:1'],
    ]);
  });

  it('a transient failure with no retry left returns the terminal result', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    lab.db.run("UPDATE budget_counters SET used = allowance WHERE run_id = ? AND counter = 'infrastructure_retries'", lab.runId);
    const out = await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'transient_error', error: 'overloaded' }, opts);
    expect(out).toMatchObject({ retry: false, result: { done: true } });
    expect(getRun(lab.db, lab.runId).state).toBe('EXHAUSTED');
  });

  it('regenerates a failed or malformed result within the attempt limit, recording why', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    expect(await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'malformed_output', error: 'e'.repeat(500) }, opts)).toEqual({ retry: true });
    expect(await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'failed', error: null }, opts)).toEqual({ retry: true });
    const [a, b] = events('worker.regenerate').map((e) => JSON.parse(e.data_json!));
    expect(a.error).toHaveLength(300);
    expect(b.error).toBeNull();
    expect(MAX_REGENERATIONS).toBe(2);
  });

  it('past the limit it runs the caller\'s outcome, or else blocks naming the last status and error', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const custom = await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'failed', error: null }, { ...opts, attemptsUsed: 3, exhausted: async () => ({ progressed: true, waiting: 'custom' }) });
    expect(custom).toEqual({ retry: false, result: { progressed: true, waiting: 'custom' } });
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
    const blocked = await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'failed', error: 'boom' }, { ...opts, attemptsUsed: 3 });
    expect(blocked).toMatchObject({ retry: false, result: { done: true } });
    expect(getRun(lab.db, lab.runId).outcomeReason).toBe('planning: no usable result after 3 attempt(s) (last: failed, boom)');
  });

  it('without an error text the block names only the status', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await handleWorkerFailure(lab.ctx(), { provider: 'claude', status: 'timeout', error: null }, { ...opts, attemptsUsed: 3 });
    expect(getRun(lab.db, lab.runId).outcomeReason).toBe('planning: no usable result after 3 attempt(s) (last: timeout)');
  });
});

describe('createdStep and recoveringStep', () => {
  it('starts a created run by moving it to PREFLIGHT, unless a safe point stops it', async () => {
    lab = makeUnitLab();
    expect(await createdStep(lab.ctx())).toEqual({ progressed: true });
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
    setPaused(lab.db, lab.runId, true, 'user', lab.clock);
    expect(await createdStep(lab.ctx())).toMatchObject({ progressed: false, waiting: 'paused' });
  });

  it('resumes the stage the crash interrupted: the recorded one, else verification with a candidate, planning with a contract, preflight otherwise', async () => {
    const cases: [string, (l: UnitLab) => void, string][] = [
      ['the recorded resume state', () => {}, 'IMPLEMENTING'],
    ];
    for (const [, prepare, expected] of cases) {
      lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING'] });
      prepare(lab);
      expect(await recoveringStep(lab.ctx())).toEqual({ progressed: true });
      expect(getRun(lab.db, lab.runId).state).toBe(expected);
      lab.cleanup();
    }
    // With no resume state recorded the stage is inferred from what exists.
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING'] });
    lab.db.run('UPDATE runs SET resume_state = NULL WHERE id = ?', lab.runId);
    let ctx = lab.ctx();
    expect(ctx.contract).toBeNull();
    await recoveringStep(ctx);
    expect(getRun(lab.db, lab.runId).state).toBe('PREFLIGHT');
    lab.cleanup();

    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING'] });
    lab.db.run('UPDATE runs SET resume_state = NULL WHERE id = ?', lab.runId);
    ctx = lab.ctx();
    ctx.contract = {} as never;
    await recoveringStep(ctx);
    expect(getRun(lab.db, lab.runId).state).toBe('PLANNING');
    lab.cleanup();

    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING'] });
    lab.db.run('UPDATE runs SET resume_state = NULL WHERE id = ?', lab.runId);
    ctx = lab.ctx();
    ctx.contract = {} as never;
    ctx.candidate = {} as never;
    await recoveringStep(ctx);
    expect(getRun(lab.db, lab.runId).state).toBe('VERIFYING');
  });

  it('does not move a recovering run that was cancelled', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'RECOVERING'] });
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    expect(await recoveringStep(lab.ctx())).toMatchObject({ done: true });
    expect(getRun(lab.db, lab.runId).state).toBe('CANCELLED');
  });
});
