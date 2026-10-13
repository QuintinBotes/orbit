import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { insertQuestion, listQuestions } from '../../../src/inquisition/store.ts';
import { runWorktreeRoot } from '../../../src/controller/context.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { requestCancel } from '../../../src/controller/run-store.ts';
import { addCandidate, makeUnitLab, type UnitLab } from './coverage-helpers.ts';

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

describe('an EXHAUSTED run does not promise the worktree it just released', () => {
  const reasons: [string, string, Record<string, unknown>?][] = [
    ['attempt cap', 'implementation attempts hard cap reached (3 of 3); the last failure was fp:abc'],
    ['review round cap', 'review_rounds hard cap reached (4 of 4) with findings open'],
    ['non-progress', 'non-progress: attempt 2 reproduced tree 48a99696910f', { non_progress: { reason: 'same tree' } }],
    ['extension denied', 'implementation attempt allowance spent (3 of 3) and no extension: no new hypothesis'],
    ['provider outage', 'provider kept failing transiently until retries ran out'],
    ['budget', 'cost cap'],
    ['diagnosis', 'diagnosis produced no valid repair brief'],
    ['recovery', 'recovery_attempts exhausted: lost implementer'],
    ['ci', 'CI repair budget is spent'],
  ];
  for (const [name, reason, outcome] of reasons) {
    it(`${name}: next_action names the candidate ref and the evidence, not a preserved worktree`, async () => {
      lab = makeUnitLab({ path: ['PREFLIGHT'] });
      const cand = addCandidate(lab);
      const dir = join(runWorktreeRoot(lab.ctx()), 'wrk-implementer');
      mkdirSync(dir, { recursive: true });
      await finishRun(lab.ctx(), 'EXHAUSTED', reason, outcome ? { outcome } : {});
      expect(existsSync(dir)).toBe(false);
      const ctx = lab.ctx();
      const next = (JSON.parse(readFileSync(join(ctx.runDir, 'final.json'), 'utf8')) as { next_action: string }).next_action;
      expect(next).not.toMatch(/worktree and evidence are preserved|continue by hand from them|worktree is preserved/);
      expect(next).toContain(`refs/orbit/${lab.runId}/candidates/${cand.seq}`);
      expect(next).toContain(`.orbit/runs/${lab.runId}`);
    });
  }

  it('says no candidate was recorded when there is none', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    await finishRun(lab.ctx(), 'EXHAUSTED', 'implementation attempts hard cap reached (3 of 3)');
    const ctx = lab.ctx();
    const next = (JSON.parse(readFileSync(join(ctx.runDir, 'final.json'), 'utf8')) as { next_action: string }).next_action;
    expect(next).toContain('no candidate was recorded');
    expect(next).not.toMatch(/preserved/);
  });
});
