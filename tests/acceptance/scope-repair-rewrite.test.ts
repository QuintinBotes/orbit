/**
 * Issue #300: an implementer that changes an in-scope file differently on each attempt and also rewrites the out-of-scope
 * file Orbit restored before it. Every tree is new, so the same-tree rule cannot end the run; the second denial for the
 * restored paths blocks it, naming the file, instead of spending the attempts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { listCandidates } from '../../src/evidence/store.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, makeLab, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, implementer, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('acceptance: a repair that rewrites the restored out-of-scope path with a new tree blocks (issue #300)', () => {
  it('BLOCKED naming the path after the second implementer session; a third never runs', async () => {
    const l = makeLab();
    labs.push(l);
    const outside = (n: number) => ({ op: 'write' as const, path: 'build/output.txt', content: `bundle build ${n}\n` });
    const inScope = (n: number) => ({ op: 'write' as const, path: 'tests/unit/notes.txt', content: `note ${n}\n` });
    writeScenario(l, scenario({ implementer: [implementer([SRC_TEXT, TEST_TEXT, outside(1)]), implementer([inScope(2), outside(2)]), implementer([inScope(3), outside(3)])] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toContain('changes paths outside the authorized scope again: build/output.txt.');
    expect(done.outcomeReason).toContain('Orbit restored exactly these paths before attempt 2, and the attempt wrote them again');
    expect(done.outcomeReason).toContain(`orbit resume ${run.id}.`);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(new Set(listCandidates(db, run.id).map((c) => c.treeHash)).size).toBe(2);
    expect(transitions(db, run.id).at(-1)).toBe('BLOCKED');
    assertRunInvariants(l, run.id);
  }, 240_000);
});
