// Cost accounting honesty (e2e retest NB2, NB3/P15): a session that never reached a model costs a measured zero,
// and the spend cap of a new session is priced from what that session can really put in one request, so a small
// cost cap still admits work and a cap that truly cannot fund a session says so in numbers.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskResult, UsageReport, WorkerRole } from '../../../src/adapters/types.ts';
import { BudgetLedger, ROLE_COST_CEILING_USD } from '../../../src/scheduling/budget.ts';
import { planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { accountWorker, recordSpendCap, sessionSpendCap, unfundedSessionReason } from '../../../src/controller/workers.ts';
import { worstCaseRequestUsd } from '../../../src/routing/registry.ts';
import { makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const SONNET = 'claude-sonnet-5-5';
const OPUS = 'claude-opus-5-5';
const usage = (over: Partial<UsageReport> = {}): UsageReport => ({ provider: 'claude', model: null, inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, costUsd: null, costSource: 'unavailable', ...over });
const result = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'failed', structured: null, text: null, error: 'exited 1 without a result', exitCode: 1, usage: usage(), durationMs: 50, ...over });

function setup(cap: number): void {
  lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = cap) });
  lab.deps.registry.seed();
  new BudgetLedger(lab.db, lab.clock).init(lab.runId, lab.ctx().snapshot, 'medium');
}

function worker(role: WorkerRole, purpose: string, provider = 'claude', log?: string): WorkerRecord {
  const w = planWorker(lab.db, { id: `wrk-${purpose.replace(/\W/g, '_')}`, runId: lab.runId, role, purpose, provider, model: null, workerDir: join(lab.base, 'w', purpose.replace(/\W/g, '_')), cwd: lab.repo }, lab.clock, OWNER);
  if (log !== undefined) {
    mkdirSync(w.workerDir, { recursive: true });
    writeFileSync(join(w.workerDir, 'log.jsonl'), log);
  }
  return w;
}

const lines = (...events: object[]): string => events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
const used = (): number => lab.ctx().ledger!.state('cost_usd').used;
const zeroEvents = (): unknown[] => lab.db.all("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.cost-zero-no-model'", lab.runId);

describe('NB2: a session that never reached the model is charged nothing', () => {
  it('a failed session with no usage and an empty transcript is a measured zero, recorded as such', () => {
    setup(30);
    const ctx = lab.ctx();
    recordSpendCap(ctx, 'review:r1#1', 9, 3);
    accountWorker(ctx, worker('reviewer', 'review:r1#1', 'codex', ''), result(), 'final');
    expect(used()).toBe(0);
    expect(zeroEvents()).toHaveLength(1);
    expect(lab.db.get('SELECT cost_usd, cost_source FROM usage WHERE run_id = ?', lab.runId)).toMatchObject({ cost_usd: 0, cost_source: 'reported' });
  });

  it('a Claude session that exited before any result line with only its init and an API error message is a zero', () => {
    setup(30);
    const log = lines({ type: 'system', subtype: 'init', model: SONNET }, { type: 'assistant', error: 'overloaded', is_api_error_message: true, message: { content: [{ type: 'text', text: 'API Error: 529' }] } });
    accountWorker(lab.ctx(), worker('implementer', 'implement:1#1', 'claude', log), result({ status: 'transient_error' }));
    expect(used()).toBe(0);
    expect(zeroEvents()).toHaveLength(1);
  });

  it('a session that never launched (no transcript at all) is a zero', () => {
    setup(30);
    accountWorker(lab.ctx(), worker('planner', 'plan:1'), result());
    expect(used()).toBe(0);
  });

  it('a failed session whose transcript shows model output is still charged its cap plus one request', () => {
    setup(30);
    const ctx = lab.ctx();
    recordSpendCap(ctx, 'implement:1#1', 2, 0.5);
    const log = lines({ type: 'system', subtype: 'init' }, { type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } });
    accountWorker(ctx, worker('implementer', 'implement:1#1', 'claude', log), result());
    expect(used()).toBeCloseTo(2.5, 6);
    expect(zeroEvents()).toEqual([]);
  });

  it('a Codex session that produced items before failing is charged, not zeroed', () => {
    setup(30);
    const log = lines({ type: 'thread.started' }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } });
    accountWorker(lab.ctx(), worker('reviewer', 'review:r2#1', 'codex', log), result(), 'final');
    expect(used()).toBeCloseTo(ROLE_COST_CEILING_USD.reviewer, 6);
  });

  it('a Codex session that only reported an error item and a failed turn is a zero', () => {
    setup(30);
    const log = lines({ type: 'thread.started' }, { type: 'turn.started' }, { type: 'item.completed', item: { type: 'error', message: 'stream error' } }, { type: 'turn.failed', error: { message: 'unexpected status 503' } });
    accountWorker(lab.ctx(), worker('reviewer', 'review:r3#1', 'codex', log), result(), 'final');
    expect(used()).toBe(0);
  });

  it('a session with reported tokens, a lost session and a timed-out session are never zeroed', () => {
    setup(30);
    accountWorker(lab.ctx(), worker('planner', 'plan:a', 'claude', ''), result({ usage: usage({ inputTokens: 10 }) }));
    accountWorker(lab.ctx(), worker('planner', 'plan:b', 'claude', ''), result({ status: 'lost' }));
    accountWorker(lab.ctx(), worker('planner', 'plan:c', 'claude', ''), result({ status: 'timeout' }));
    expect(used()).toBeGreaterThan(0);
    expect(zeroEvents()).toEqual([]);
  });

  it('an earlier archived attempt that did reach the model keeps the session charged', () => {
    setup(30);
    const w = worker('implementer', 'implement:1#1', 'claude', '');
    mkdirSync(join(w.workerDir, 'attempts', '1'), { recursive: true });
    writeFileSync(join(w.workerDir, 'attempts', '1', 'log.jsonl'), lines({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }));
    accountWorker(lab.ctx(), w, result());
    expect(used()).toBeGreaterThan(0);
  });

  it('a budget exhaustion message rounds dollars instead of printing float noise', () => {
    setup(10);
    const ledger = lab.ctx().ledger!;
    ledger.consumeCost({ costUsd: 0.1 + 0.2, costSource: 'reported' }, 'planner');
    let message = '';
    try {
      ledger.consumeCost({ costUsd: 12.236264899999998, costSource: 'reported' }, 'reviewer', { phase: 'final' });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/cost_usd exhausted at the hard cap \$10\.00: used \$12\.54, requested \$12\.24/);
  });
});

describe('NB3 (P15): the spend cap is priced from what one session can really put in a request', () => {
  it('a $5 cap funds a Sonnet implementer session, and the cap plus its worst request stays inside the budget', () => {
    setup(5);
    const ctx = lab.ctx();
    const ledger = ctx.ledger!;
    ledger.consumeCost({ costUsd: 0.1, costSource: 'reported' }, 'planner');
    const s = sessionSpendCap(ctx, SONNET, 'implementer');
    expect(s.capUsd).toBeGreaterThan(0.5);
    const available = 5 - ledger.reserve().cost_usd - 0.1;
    expect(s.capUsd! + s.worstCaseUsd).toBeLessThanOrEqual(available + 1e-9);
  });

  it('a $5 cap funds an Opus implementer session too', () => {
    setup(5);
    const s = sessionSpendCap(lab.ctx(), OPUS, 'implementer');
    expect(s.capUsd).toBeGreaterThan(0);
  });

  it('the worst request is bounded by the context the cap can buy, by the session output cap, and never above the full window', () => {
    setup(30);
    const sonnet = lab.deps.registry.get(SONNET)!;
    const full = worstCaseRequestUsd(sonnet)!;
    // The whole window at the dearest prompt rate plus the CLI's own output cap is still the bound with nothing else known.
    expect(full).toBeCloseTo(5.28, 6);
    const small = worstCaseRequestUsd(sonnet, { capUsd: 0.5, outputTokens: 32_000 })!;
    expect(small).toBeLessThan(full);
    expect(worstCaseRequestUsd(sonnet, { capUsd: 1_000, outputTokens: 32_000 })).toBeCloseTo((1_000_000 * 4 + 32_000 * 10) / 1_000_000, 6);
    // A larger cap can only make the worst request dearer.
    expect(worstCaseRequestUsd(sonnet, { capUsd: 1, outputTokens: 32_000 })!).toBeGreaterThan(small);
  });

  it('a cap that cannot fund one session says by how much, in dollars', () => {
    setup(1);
    const why = unfundedSessionReason(lab.ctx(), SONNET, 'implementer');
    expect(why).toMatch(/^cap \$1\.00 is below one session's worst case \$\d+\.\d\d/);
    expect(sessionSpendCap(lab.ctx(), SONNET, 'implementer').capUsd).toBe(0);
  });

  it('a cap that could fund a session but is already spent says what is left', () => {
    setup(5);
    const ledger = lab.ctx().ledger!;
    lab.db.run("UPDATE budget_counters SET used = 3.9 WHERE run_id = ? AND counter = 'cost_usd'", lab.runId);
    expect(sessionSpendCap(lab.ctx(), SONNET, 'implementer').capUsd).toBe(0);
    expect(unfundedSessionReason(lab.ctx(), SONNET, 'implementer')).toMatch(/^no model budget left: \$0\.10 of the \$5\.00 cap remains after \$3\.90 spent and the \$1\.00 closing reserve, below one session's worst case \$\d+\.\d\d/);
    expect(ledger.reserve().cost_usd).toBe(1);
  });
});
