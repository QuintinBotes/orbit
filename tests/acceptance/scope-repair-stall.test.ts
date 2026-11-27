/**
 * Issue #280: an implementer that writes the out-of-scope file every time. The restore does not help, so the repair that
 * comes back with the denied tree is the last: the run blocks naming the path.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listCandidates } from '../../src/evidence/store.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, makeLab, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, implementer, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('acceptance: a repair that writes the out-of-scope path again blocks (issue #280)', () => {
  it.each([
    ['within the size limits', 800],
    ['over the size limits as well', 100],
  ])('%s: BLOCKED naming the path after two implementer sessions', async (_what, changedLines) => {
    const l = makeLab({ tweak: (c) => void (c.scheduler.hard_limits.changed_lines = changedLines) });
    labs.push(l);
    const outside = { op: 'write' as const, path: 'build/output.txt', content: Array.from({ length: 300 }, (_, i) => `line ${i}`).join('\n') + '\n' };
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT, outside]), implementer([outside])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toContain('changes paths outside the authorized scope again: build/output.txt.');
    expect(done.outcomeReason).toContain(`orbit resume ${run.id} --force`);
    expect(done.outcomeReason!.includes('It is also over the size limits')).toBe(changedLines === 100);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(new Set(listCandidates(db, run.id).map((c) => c.treeHash)).size).toBe(1);
    expect(transitions(db, run.id).at(-1)).toBe('BLOCKED');
    assertRunInvariants(l, run.id);
  }, 240_000);
});
