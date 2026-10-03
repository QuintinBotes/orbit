import { describe, expect, it } from 'vitest';
import { openDb } from '../../../src/storage/db.ts';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { aggregateMetrics, buildReplaySuite, compareMetrics, evaluateOverlay, type CaseResult, type EvalRunner } from '../../../src/knowledge/evals.ts';
import type { PromptOverlay } from '../../../src/knowledge/types.ts';

function runDb() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  const add = (id: string, state: string, contract: unknown, base: string | null, created: number) => {
    createRun(db, { id, repoRoot: '/work/acme', goal: `goal ${id}`, mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
    db.run('UPDATE runs SET state = ?, contract_json = ?, contract_hash = ?, base_revision = ?, created_at = ? WHERE id = ?', state, contract === null ? null : typeof contract === 'string' ? contract : JSON.stringify(contract), 'sha256:c', base, created, id);
  };
  add('r1', 'SUCCEEDED', { version: '1.0', required_check_ids: ['unit', 'lint', 'unit'] }, 'base1', 1);
  add('r2', 'SUCCEEDED', { version: '1.0', required_check_ids: ['e2e'] }, 'base2', 2);
  add('r3', 'EXHAUSTED', { version: '1.0', required_check_ids: ['unit'] }, 'base3', 3);
  add('r4', 'SUCCEEDED', '{not json', 'base4', 4);
  add('r5', 'SUCCEEDED', { version: '1.0', required_check_ids: ['unit'] }, null, 5);
  add('r6', 'SUCCEEDED', null, 'base6', 6);
  return { db, clock };
}

describe('buildReplaySuite', () => {
  it('builds cases from successful runs with a contract and base revision only', () => {
    const { db, clock } = runDb();
    const suite = buildReplaySuite(db, { role: 'implementer' }, clock);
    expect(suite.cases.map((c) => c.run_id)).toEqual(['r1', 'r2']);
    expect(suite.cases[0]).toMatchObject({ goal: 'goal r1', base_revision: 'base1', check_ids: ['lint', 'unit'], contract_hash: 'sha256:c' });
    expect(suite.cases[0]!.id).toMatch(/^case-[0-9a-f]{12}$/);
    expect(suite.role).toBe('implementer');
    expect(suite.id).toBe(buildReplaySuite(db, {}, clock).id);
    expect(buildReplaySuite(db, { limit: 1 }, clock).cases.map((c) => c.run_id)).toEqual(['r2']);
  });
});

const r = (id: string, verified: boolean, attempts: number, cost: number | null, falsePass = false): CaseResult => ({ case_id: id, verified, attempts, cost_usd: cost, false_pass: falsePass });

describe('aggregateMetrics', () => {
  it('computes rates, mean attempts and cost per accepted case', () => {
    const m = aggregateMetrics([r('a', true, 1, 2), r('b', false, 3, 1, true), r('c', true, 2, 3), r('d', true, 2, 2)]);
    expect(m).toEqual({ verified_pass_rate: 0.75, mean_attempts: 2, mean_cost_usd: 8 / 3, false_pass_rate: 0.25 });
  });

  it('never reports an unknown cost as zero', () => {
    expect(aggregateMetrics([r('a', true, 1, null), r('b', true, 1, 1)]).mean_cost_usd).toBeNull();
    expect(aggregateMetrics([r('a', false, 1, 1)]).mean_cost_usd).toBeNull();
    expect(aggregateMetrics([])).toEqual({ verified_pass_rate: 0, mean_attempts: 0, mean_cost_usd: null, false_pass_rate: 0 });
  });
});

describe('compareMetrics', () => {
  const base = { verified_pass_rate: 0.5, mean_attempts: 2, mean_cost_usd: 1, false_pass_rate: 0.1 };
  it('classifies each metric in its own direction', () => {
    expect(compareMetrics(base, { verified_pass_rate: 0.6, mean_attempts: 2.5, mean_cost_usd: 1, false_pass_rate: 0.05 })).toEqual({
      improvements: ['verified_pass_rate', 'false_pass_rate'],
      regressions: ['mean_attempts'],
      ties: ['mean_cost_usd'],
      unmeasured: [],
    });
  });

  it('handles unmeasured cost conservatively', () => {
    expect(compareMetrics(base, { ...base, mean_cost_usd: null }).regressions).toEqual(['mean_cost_usd']);
    expect(compareMetrics({ ...base, mean_cost_usd: null }, base).unmeasured).toEqual(['mean_cost_usd']);
  });
});

describe('evaluateOverlay', () => {
  const overlay = (id: string): PromptOverlay => ({ id, role: 'implementer', scope: 'repo', version: 1, content: 'x', lesson_ids: [], status: 'evaluating', parent_id: null, eval: null, created_at: '2026-10-03T00:00:00.000Z', activated_at: null });

  it('replays every case under baseline and candidate in order', async () => {
    const { db, clock } = runDb();
    const suite = buildReplaySuite(db, {}, clock);
    const calls: string[] = [];
    const runner: EvalRunner = {
      async runCase(_s, c, o) {
        calls.push(`${c.run_id}:${o?.id ?? 'none'}`);
        return r(c.id, o !== null, 1, 1);
      },
    };
    const res = await evaluateOverlay(runner, suite, null, overlay('ovl-cand'));
    expect(calls).toEqual(['r1:none', 'r1:ovl-cand', 'r2:none', 'r2:ovl-cand']);
    expect(res).toMatchObject({ suite_id: suite.id, cases: 2 });
    expect(res.baseline.verified_pass_rate).toBe(0);
    expect(res.candidate.verified_pass_rate).toBe(1);
  });

  it('refuses malformed runner results', async () => {
    const { db, clock } = runDb();
    const suite = buildReplaySuite(db, {}, clock);
    const runner: EvalRunner = { runCase: async (_s, c) => ({ ...r(c.id, true, -1, 1) }) };
    await expect(evaluateOverlay(runner, suite, null, overlay('o'))).rejects.toSatisfy((err: unknown) => isOrbitError(err, 'MALFORMED_OUTPUT'));
    const wrongCase: EvalRunner = { runCase: async () => r('other', true, 1, 1) };
    await expect(evaluateOverlay(wrongCase, suite, null, overlay('o'))).rejects.toThrow(/invalid result/);
  });
});
