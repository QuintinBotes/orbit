import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertQuestion, listQuestions } from '../../../src/inquisition/store.ts';
import { runWorktreeRoot } from '../../../src/controller/context.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { requestCancel } from '../../../src/controller/run-store.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const events = (type: string): { data_json: string | null }[] => lab.db.all('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, type);

const ask = (id: string): void => {
  insertQuestion(
    lab.db,
    { id, runId: lab.runId, mode: 'clarify', question: `Which behaviour for ${id}?`, evidence: [], options: [], changes: [], recommendation: { option: 'a', reason: 'r' }, safeDefault: { exists: false, option: null, reason: 'none' }, material: true, affected: ['AC-1'], unblocked: [] },
    lab.clock,
  );
};

describe('cancelling a run closes its open questions', () => {
  it('withdraws every open question when the run ends CANCELLED, so status lists none as open', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    ask('q-baseline-1');
    ask('q-other');
    await finishRun(lab.ctx(), 'CANCELLED', 'cancelled by test (orbit cancel)');
    expect(listQuestions(lab.db, lab.runId, { status: 'open' })).toEqual([]);
    expect(listQuestions(lab.db, lab.runId, { status: 'withdrawn' }).map((q) => q.id).sort()).toEqual(['q-baseline-1', 'q-other']);
    expect(events('question.withdrawn')).toHaveLength(2);
  });

  it('closes them when a durable cancellation outranks the outcome the step decided', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    ask('q-baseline-1');
    requestCancel(lab.db, lab.runId, 'user', lab.clock);
    await finishRun(lab.ctx(), 'BLOCKED', 'needs a person');
    expect(listQuestions(lab.db, lab.runId, { status: 'open' })).toEqual([]);
  });

  it('leaves the questions of a BLOCKED run open, as it resumes', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    ask('q-baseline-1');
    await finishRun(lab.ctx(), 'BLOCKED', 'needs a person');
    expect(listQuestions(lab.db, lab.runId, { status: 'open' })).toHaveLength(1);
  });
});

describe('a finished run releases its worktrees', () => {
  const withCheckout = (): string => {
    const dir = join(runWorktreeRoot(lab.ctx()), 'wrk-implementer');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'file.txt'), 'x');
    return dir;
  };

  for (const state of ['SUCCEEDED', 'CANCELLED', 'EXHAUSTED', 'IMPOSSIBLE'] as const) {
    it(`removes them when the run ends ${state}, with a worktrees.released event`, async () => {
      lab = makeUnitLab({ path: state === 'SUCCEEDED' ? ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'] : ['PREFLIGHT'] });
      const dir = withCheckout();
      await finishRun(lab.ctx(), state, 'done');
      expect(existsSync(dir)).toBe(false);
      expect(events('worktrees.released')).toHaveLength(1);
    });
  }

  it('keeps them when the run ends BLOCKED, which may resume', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const dir = withCheckout();
    await finishRun(lab.ctx(), 'BLOCKED', 'needs a person');
    expect(existsSync(dir)).toBe(true);
    expect(events('worktrees.released')).toHaveLength(0);
  });
});
