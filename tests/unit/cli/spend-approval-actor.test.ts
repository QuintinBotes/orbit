/** Issue #254: only a person approves more spend; each later block asks for one more increment of the original cap. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { outcomeForError, safePoint } from '../../../src/controller/steps/common.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { initLedger, makeUnitLab, type UnitLab } from '../controller/coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const files = (): string[] => {
  const dir = join(lab.base, 'userhome', '.local', 'state', 'stack', 'inbox', 'spend');
  return existsSync(dir) ? readdirSync(dir) : [];
};

async function spend(usd: number): Promise<void> {
  try {
    lab.ctx().ledger!.consumeCost({ costUsd: usd, costSource: 'reported' }, 'implementer');
  } catch (err) {
    await outcomeForError(lab.ctx(), err);
  }
}

describe('who may approve more spend', () => {
  it('refuses a worker process and a model or subsystem name, changing nothing; a person raises the cap and a later block asks once more', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'], tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 12) });
    initLedger(lab);
    await spend(11);
    expect(lab.ctx().run.state).toBe('BLOCKED');
    const [q] = listQuestions(lab.db, lab.runId, { status: 'open' });

    const io = memoryIo('');
    const code = await main(['decide', lab.runId, q!.id, 'approve'], { io, cwd: lab.repo, env: { ORBIT_WORKER: '1' }, user: 'acme', homeDir: lab.base, orbitHome: lab.home });
    expect(code).not.toBe(0);
    for (const by of ['implementer', 'claude', 'controller', 'orbit:service']) {
      expect(() => answerQuestion(lab.db, lab.ctx().runDir, q!.id, 'approve', by, lab.clock), by).toThrow(/cannot answer/);
    }
    expect(lab.ctx().ledger!.state('cost_usd').hard_cap).toBe(12);
    expect(listQuestions(lab.db, lab.runId, { status: 'open' })).toHaveLength(1);
    expect(files()).toEqual([`orbit-${lab.runId}-24.json`]);

    answerQuestion(lab.db, lab.ctx().runDir, q!.id, 'approve', 'acme', lab.clock);
    lab.walk(['PREFLIGHT']);
    expect(await safePoint(lab.ctx())).toBeNull();
    expect(lab.ctx().ledger!.state('cost_usd').hard_cap).toBe(24);
    expect(lab.ctx().ledger!.reserve().cost_usd).toBeCloseTo(24 * lab.config.scheduler.final_reserve_fraction, 6);
    expect(files()).toEqual([]);

    await spend(12);
    expect(lab.ctx().run.state).toBe('BLOCKED');
    expect(files()).toEqual([`orbit-${lab.runId}-36.json`]);
  });
});
