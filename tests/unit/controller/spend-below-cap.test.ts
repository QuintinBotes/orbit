/** Issue #254: a cost refusal asks for more spend once something is charged; with nothing charged it ends the run as before. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { initLedger, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

describe('a cost refusal below the cap', () => {
  it('with nothing charged ends EXHAUSTED and writes no spend file', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 0.05) });
    initLedger(lab);
    await finishRun(lab.ctx(), 'EXHAUSTED', 'attempt 1 not started: no model budget left', { costRefusal: true });
    expect(lab.ctx().run.state).toBe('EXHAUSTED');
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    expect(existsSync(join(lab.base, 'userhome', '.local', 'state', 'stack'))).toBe(false);
  });

  // Sessions are funded below the limit (one worst-case request is held back), so a run that money stops usually stops
  // here, with charged cost under the cap less the reserve: it asks, as one at the limit does (owner's decision, #254).
  it('with something charged blocks and asks for more spend', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 12) });
    initLedger(lab);
    lab.ctx().ledger!.consumeCost({ costUsd: 5, costSource: 'reported' }, 'planner');
    await finishRun(lab.ctx(), 'EXHAUSTED', 'attempt 1 not started: no model budget left', { costRefusal: true });
    expect(lab.ctx().run.state).toBe('BLOCKED');
    expect(listQuestions(lab.db, lab.runId, { status: 'open' }).map((q) => q.id)).toEqual([expect.stringMatching(/^q-spend-/)]);
  });

  it('an end that is not a refusal and is below the limit still ends EXHAUSTED', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 12) });
    initLedger(lab);
    lab.ctx().ledger!.consumeCost({ costUsd: 5, costSource: 'reported' }, 'planner');
    await finishRun(lab.ctx(), 'EXHAUSTED', 'implementation attempts hard cap reached', { data: { counter: 'implementation_attempts' } });
    expect(lab.ctx().run.state).toBe('EXHAUSTED');
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
  });
});
