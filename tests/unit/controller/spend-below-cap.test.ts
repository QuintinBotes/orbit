/** Issue #254: a cost refusal below the cap, nothing charged included, still ends the run and writes no spend file. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { initLedger, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

describe('a cost refusal below the cap', () => {
  it.each([
    ['nothing charged', 0.05, 0],
    ['below the limit', 12, 5],
  ])('%s ends EXHAUSTED', async (_name, cap, used) => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = cap) });
    initLedger(lab);
    if (used > 0) lab.ctx().ledger!.consumeCost({ costUsd: used, costSource: 'reported' }, 'planner');
    await finishRun(lab.ctx(), 'EXHAUSTED', 'attempt 1 not started: no model budget left', { costRefusal: true });
    expect(lab.ctx().run.state).toBe('EXHAUSTED');
    expect(listQuestions(lab.db, lab.runId)).toEqual([]);
    expect(existsSync(join(lab.base, 'userhome', '.local', 'state', 'stack'))).toBe(false);
  });
});
