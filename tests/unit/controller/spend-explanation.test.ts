// One spend explanation in the report, the timeline footer and status (0.3.0 retest): the budget's charge is named as
// the figure the cost cap is checked against, with what it adds to the reported spend; a run that stopped before
// PLANNING created the budget says its spend is measured and not charged, and why, instead of "has not reached planning".
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { buildRunStatus, renderRunStatus } from '../../../src/cli/commands/status.ts';
import { buildFinalReport, renderMarkdown } from '../../../src/controller/report.ts';
import { buildTimeline } from '../../../src/observability/timeline.ts';
import { recordUsage } from '../../../src/routing/usage.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import type { TaskResult, UsageReport } from '../../../src/adapters/types.ts';
import { accountWorker } from '../../../src/controller/workers.ts';
import { spendBreakdown } from '../../../src/scheduling/budget.ts';
import { finishWorker, markWorkerRunning, planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { initLedger, makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = (cost: number | null, provider = 'claude'): UsageReport => ({ provider, model: null, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: cost, costSource: cost === null ? 'unavailable' : 'reported' });
const record = (workerId: string, cost: number | null, provider = 'claude') => recordUsage(lab.db, { runId: lab.runId, workerId, provider, model: null, usage: usage(cost, provider), durationMs: 1, pricing: null }, lab.clock);

function demoRun(): void {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
  const ledger = initLedger(lab);
  for (const [id, cost] of [['wrk-impl', 1.33], ['wrk-plan', 0.22]] as const) {
    ledger.consumeCost({ costUsd: cost, costSource: 'reported' }, 'implementer', { workerId: id });
    record(id, cost);
  }
  ledger.consumeCost({ costUsd: null }, 'reviewer', { phase: 'final', workerId: 'wrk-rev', tokenEstimate: { costUsd: 0.53, basis: 'dearest listed pricing', model: 'gpt-6.1-sol' } });
  record('wrk-rev', null, 'codex');
}

const EXPLAINED = '$2.08 charged to the cost budget (the figure the cost cap is checked against): $1.55 reported by providers (2 sessions) + $0.53 estimated from tokens for 1 session that reported no cost';

describe('the spend explanation', () => {
  it('the report names the charge and what it adds, instead of a separate unexplained model cost', () => {
    demoRun();
    const ctx = lab.ctx();
    const report = buildFinalReport(lab.db, ctx.run, { runDir: ctx.runDir, clock: lab.clock, snapshot: ctx.snapshot });
    expect(report.budget?.spend?.explanation).toBe(EXPLAINED);
    expect(report.budget?.cost_usd).toBeCloseTo(1.55, 6);
    const md = renderMarkdown(report);
    expect(md).toContain(`- spend: ${EXPLAINED}\n`);
    expect(md).not.toContain('model cost:');
  });

  it('the timeline footer gives the same explanation', () => {
    demoRun();
    const t = buildTimeline(lab.db, getRun(lab.db, lab.runId));
    expect(t.cost.note).toBe(EXPLAINED);
    expect(t.cost).toMatchObject({ charged_usd: 2.08, measured_usd: 1.55, estimated_usd: 0.53, reported_records: 2, estimated_records: 1, unavailable_records: 0 });
  });

  it('status gives it too', () => {
    demoRun();
    const s = buildRunStatus({ clock: lab.clock }, lab.db, getRun(lab.db, lab.runId));
    expect(s.spend?.explanation).toBe(EXPLAINED);
    expect(renderRunStatus(s, lab.clock.now())).toContain(`  spend: ${EXPLAINED}\n`);
  });
});

describe('spend before the budget exists (dotnet orb-20261013-083637-c332cc, blocked at PLANNING)', () => {
  function blockedAtPlanning(): void {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'BLOCKED'] });
    record('wrk-plan', 0.0456);
    record('orb-unit-curator-1', 0.011);
  }

  const BLOCKED_SPEND = 'nothing charged to the cost budget: the run blocked before PLANNING created the budget, so this spend is measured and not charged; PLANNING charges it if the run is resumed: $0.06 reported by providers (2 sessions)';

  it('status does not say the run has not reached planning, and reports the spend as measured and not charged, with the reason', () => {
    blockedAtPlanning();
    const s = buildRunStatus({ clock: lab.clock }, lab.db, getRun(lab.db, lab.runId));
    expect(s.budgets).toBeNull();
    expect(s.spend).toMatchObject({ charged_usd: null, reported_usd: 0.0566, uncharged_usd: 0.0566, uncharged_reason: 'the run blocked before PLANNING created the budget' });
    const text = renderRunStatus(s, lab.clock.now());
    expect(text).not.toContain('has not reached planning');
    expect(text).not.toContain('not initialized yet');
    expect(text).toContain('budgets:   none: the run blocked before PLANNING created them; PLANNING creates them if the run is resumed\n');
    expect(text).toContain(`  spend: ${BLOCKED_SPEND}\n`);
  });

  it('the report says the same', () => {
    blockedAtPlanning();
    const ctx = lab.ctx();
    const md = renderMarkdown(buildFinalReport(lab.db, ctx.run, { runDir: ctx.runDir, clock: lab.clock, snapshot: ctx.snapshot }));
    expect(md).toContain(`- spend: ${BLOCKED_SPEND}\n`);
  });

  it('the timeline footer says the same', () => {
    blockedAtPlanning();
    expect(buildTimeline(lab.db, getRun(lab.db, lab.runId)).cost).toMatchObject({ charged_usd: null, note: BLOCKED_SPEND });
  });

  it('a run that ended before PLANNING created the budget says its spend was never charged', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'CANCELLED'] });
    record('wrk-plan', 0.0456);
    const s = buildRunStatus({ clock: lab.clock }, lab.db, getRun(lab.db, lab.runId));
    expect(s.spend).toMatchObject({ charged_usd: null, uncharged_usd: 0.0456, uncharged_reason: 'the run ended CANCELLED before PLANNING created the budget' });
    const text = renderRunStatus(s, lab.clock.now());
    expect(text).toContain('budgets:   none: the run ended before PLANNING created them\n');
    expect(text).toContain('  spend: nothing charged to the cost budget: the run ended CANCELLED before PLANNING created the budget, so this spend was measured and never charged: $0.05 reported by providers (1 session)\n');
  });

  it('a run still on its way to PLANNING says the budget is not created yet', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'] });
    record('wrk-plan', 0.0456);
    const s = buildRunStatus({ clock: lab.clock }, lab.db, getRun(lab.db, lab.runId));
    expect(s.spend).toMatchObject({ uncharged_reason: 'PLANNING has not created the budget yet' });
    const text = renderRunStatus(s, lab.clock.now());
    expect(text).toContain('budgets:   not created yet: PLANNING creates them when it completes\n');
    expect(text).toContain('  spend: nothing charged to the cost budget yet: PLANNING creates it and then charges what was spent before; spent so far: $0.05 reported by providers (1 session)\n');
  });

  it('once the budget exists nothing is uncharged for want of it', () => {
    demoRun();
    expect(buildRunStatus({ clock: lab.clock }, lab.db, getRun(lab.db, lab.runId)).spend).toMatchObject({ uncharged_usd: 0, uncharged_reason: null });
  });
});

// The session whose charge crosses the reserve or the hard cap is the one a person most needs explained (verifier,
// fix/031-budget): accountWorker charged the ledger and rethrew before recording its usage, so the spend line put its
// cost under "charged beyond the recorded sessions (a session charged again after a controller restart)", which never
// happened, and dropped it from what providers reported.
describe('the session whose charge exhausts the cost budget', () => {
  function implementer(id: string, cost: number): { row: WorkerRecord; result: TaskResult } {
    planWorker(lab.db, { id, runId: lab.runId, role: 'implementer', purpose: `implement:${id}`, provider: 'claude', model: null, workerDir: join(lab.base, 'w', id), cwd: lab.repo }, lab.clock, OWNER);
    markWorkerRunning(lab.db, id, { pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x' }, lab.clock, OWNER);
    const result: TaskResult = { status: 'succeeded', structured: {}, text: null, error: null, exitCode: 0, usage: { ...usage(cost), inputTokens: 10, outputTokens: 10 }, durationMs: 1 };
    return { row: finishWorker(lab.db, id, { state: 'SUCCEEDED', exitCode: 0, resultStatus: 'succeeded', result, error: null }, lab.clock, OWNER), result };
  }

  it('is recorded with its usage, so the spend line names it as reported and asserts no restart', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
    initLedger(lab);
    const a = implementer('wrk-a', 5);
    accountWorker(lab.ctx(), a.row, a.result);
    const b = implementer('wrk-b', 22);
    expect(() => accountWorker(lab.ctx(), b.row, b.result)).toThrow(/cost_usd exhausted at the hard cap \$30\.00 less the closing reserve/);
    expect(lab.db.all('SELECT worker_id, cost_usd FROM usage WHERE run_id = ? ORDER BY id', lab.runId)).toEqual([{ worker_id: 'wrk-a', cost_usd: 5 }, { worker_id: 'wrk-b', cost_usd: 22 }]);
    const s = spendBreakdown(lab.db, lab.runId);
    expect(s).toMatchObject({ charged_usd: 27, reported_usd: 27, reported_sessions: 2, unmatched_usd: 0 });
    expect(s.explanation).toBe('$27.00 charged to the cost budget (the figure the cost cap is checked against): $27.00 reported by providers (2 sessions)');
    // Accounted once: a later pass over the same session charges nothing more.
    accountWorker(lab.ctx(), b.row, b.result);
    expect(lab.ctx().ledger!.state('cost_usd').used).toBe(27);
  });
});
