/** Issue #254 changes cost only: the other counters end a run as before and ask nobody for anything. */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OrbitError } from '../../../src/core/errors.ts';
import { outcomeForError, safePoint } from '../../../src/controller/steps/common.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { initLedger, makeUnitLab, OWNER, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

function expectEnded(): void {
  expect(lab.ctx().run.state).toBe('EXHAUSTED');
  expect(listQuestions(lab.db, lab.runId)).toEqual([]);
  expect(existsSync(join(lab.base, 'userhome', '.local', 'state', 'stack'))).toBe(false);
}

function setup(): void {
  lab = makeUnitLab({ path: ['PREFLIGHT'] });
  initLedger(lab);
}

describe('other counters', () => {
  it('wall time at its hard cap ends the run', async () => {
    setup();
    lab.clock.advance(lab.config.scheduler.hard_limits.wall_minutes * 60_000);
    // The test's lease ran out with the clock; the controller would have renewed it.
    acquireLease(lab.db, lab.runId, OWNER, 3_600_000, lab.clock);
    const ctx = lab.ctx();
    // The wall sync refuses, and the step runner maps the refusal to the run's end.
    await outcomeForError(ctx, await safePoint(ctx).catch((e: unknown) => e));
    expectEnded();
  });

  it.each(['implementation_attempts', 'recovery_attempts', 'review_rounds'])('%s exhausted ends the run', async (counter) => {
    setup();
    await outcomeForError(lab.ctx(), new OrbitError('BUDGET_EXHAUSTED', `${counter} exhausted`, { counter }));
    expectEnded();
  });
});
