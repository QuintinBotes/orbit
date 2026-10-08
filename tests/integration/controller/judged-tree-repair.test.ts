// A repair attempt that ends on a tree an earlier attempt already produced, judged again with the same verdict (issue #32,
// docs/decisions/0012-contract-checks-and-judged-trees.md). The candidate is the same candidate, its recorded check results
// are reused and its evidence says what it said, so the next diagnosis and repair would start from exactly what the last
// one started from. The repair loop kept dispatching implementers that returned such a tree until the non-progress
// threshold or the attempt budget ended it; now the first such repair ends the loop, with the reason.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import { listCandidates, listEvidenceReports } from '../../../src/evidence/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

/** A second diagnosis of the same failure with a cause of its own, as a real verifier would give after an unfinished repair. */
const AFTER_UNFINISHED_REPAIR = (() => {
  const d = structuredClone(DIAGNOSIS) as { structured: { repair_brief: Record<string, unknown>; competing_hypotheses: Record<string, unknown>[] } };
  const statement = 'the previous repair session ended before it edited apps/calc.mjs, so mul still returns the sum';
  d.structured.repair_brief.hypotheses = [{ statement, supporting: 'apps/calc.mjs is unchanged since attempt 1 and mul(2, 3) still returns 5', refuting: null }];
  d.structured.repair_brief.experiment = 'Compare apps/calc.mjs in the candidate with the tree attempt 1 produced';
  d.structured.repair_brief.expected_observation = 'the two files are byte for byte identical';
  d.structured.competing_hypotheses[0] = { ...d.structured.competing_hypotheses[0]!, statement, discriminating_experiment: 'Diff apps/calc.mjs against attempt 1' };
  return d;
})();

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

describe.skipIf(!canStripTypes)('a repair that ends on an already judged tree with the same verdict ends the repair loop (issue #32)', () => {
  it('stops after the first such repair, EXHAUSTED as non-progress, instead of dispatching more implementers on it', async () => {
    const l = makeLab();
    labs.push(l);
    // Every implementer session writes the same wrong mul: the repair returns the tree attempt 1 produced.
    writeScenario(l, baseScenario({ implementer: [implementMul('+')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    const [cand] = listCandidates(l.db(), run.id);
    expect(listCandidates(l.db(), run.id)).toHaveLength(1);
    expect(done.outcomeReason).toBe(
      `non-progress: attempt 2 ended on tree ${cand!.treeHash.slice(0, 12)}, the tree attempt 1 produced, and verification judged it FAIL again as it did then (failing: unit): the same evidence, diagnosis and repair brief would follow, so no further attempt is dispatched on it`,
    );
    // One implementation, one diagnosis, one repair: no second diagnosis, no third implementer, no inquiry.
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(listWorkers(l.db(), { runId: run.id, role: 'verifier' })).toHaveLength(1);
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'DIAGNOSING', 'REPAIRING', 'VERIFYING', 'DIAGNOSING', 'EXHAUSTED']);
    // The verdict was reused, not judged again from new check runs.
    expect(listEvidenceReports(l.db(), run.id)).toHaveLength(1);
    const [stop] = listDecisions(l.db(), run.id, { kind: 'repair.non-progress' });
    expect(stop?.data).toMatchObject({ terminate: true, attempt: 2, same_tree_as: 1, tree_hash: cand!.treeHash, verdict: 'FAIL', failing_checks: ['unit'] });
    const outcome = JSON.parse(done.outcomeJson!) as { non_progress?: { terminate: boolean } };
    expect(outcome.non_progress?.terminate).toBe(true);
    const report = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'final.json'), 'utf8')) as { next_action: string };
    expect(report.next_action).toMatch(/no measurable progress/);
    expect(done.outcomeReason).not.toMatch(/[\u2013\u2014]/);
  }, 180_000);

  it('a repair session that stopped before it finished is not a stall: the loop goes on and the next attempt is dispatched', async () => {
    // A third attempt within the allowance, so the existing rules, not the stall, decide whether it runs.
    const l = makeLab({ tweak: (c) => void (c.scheduler.initial_allowances = { simple_attempts: 3, medium_attempts: 4, complex_attempts: 6 }) });
    labs.push(l);
    // Attempt 2's session runs out of turns before any edit, so its tree is attempt 1's; it never judged that tree.
    writeScenario(l, baseScenario({ implementer: [implementMul('+'), { outcome: 'max_turns' }, implementMul('*')], verifier: [DIAGNOSIS, AFTER_UNFINISHED_REPAIR] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' }).map((w) => w.resultStatus)).toEqual(['succeeded', 'max_turns', 'succeeded']);
    expect(listCandidates(l.db(), run.id)).toHaveLength(2);
    expect(listDecisions(l.db(), run.id, { kind: 'repair.non-progress' })).toEqual([]);
  }, 180_000);

  it('a repair that changes the tree keeps the existing loop: the second attempt is verified and the run succeeds', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('+'), implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listCandidates(l.db(), run.id)).toHaveLength(2);
    expect(listDecisions(l.db(), run.id, { kind: 'repair.non-progress' })).toEqual([]);
  }, 180_000);
});
