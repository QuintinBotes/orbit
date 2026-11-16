/**
 * Issue #166, FR-002: the lab scenarios of two reports about attempts spent on something no repair could change.
 *
 * #144: an implementer that ran into its turn cap left a half-finished candidate, the diagnosis read it as finished
 * work, and a long fail-before pass looked like a hang. #157: a candidate that had to carry a large generated file
 * was denied for size without a word about which file was heavy, and the run spent its attempts on the same tree.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getRun } from '../../src/controller/run-store.ts';
import { listCandidates } from '../../src/evidence/store.ts';
import { buildTimeline } from '../../src/observability/timeline.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, implementer, planner, REGRESSION_DIAGNOSIS, scenario, SRC_FIX_REGRESSION, SRC_REGRESSION, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

describe.skipIf(!READY)('acceptance: attempts are not spent on what no repair can change (issues #144 and #157)', () => {
  it('issue #144: a diagnosis after a session that ended at its turn cap is told so, and the fail-before pass shows on the timeline', async () => {
    const l = lab();
    // Attempt 1 changes the source only and runs into its turn cap, as the reported first candidate did.
    const capped = { ...(implementer([SRC_REGRESSION]) as object), outcome: 'max_turns' };
    writeScenario(l, scenario({ implementer: [capped, implementer([SRC_FIX_REGRESSION, TEST_TEXT])], verifier: [REGRESSION_DIAGNOSIS] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [first] = listWorkers(db, { runId: run.id, role: 'implementer' });
    expect(first).toMatchObject({ state: 'FAILED', resultStatus: 'max_turns' });
    // What the diagnosis worker was asked: the half-finished candidate is not presented as finished work.
    const [verifier] = listWorkers(db, { runId: run.id, role: 'verifier' });
    const prompt = readFileSync(join(verifier!.workerDir, 'prompt.md'), 'utf8');
    expect(prompt).toMatch(/Session end: the implementer session of attempt 1 ended at its turn cap \(\d+ model requests\) before it finished, so the candidate may be unfinished\./);
    expect(prompt).toContain('One competing hypothesis must be that the task did not fit one session');
    // The fail-before pass is on the timeline, so a quiet VERIFYING step shows what is running.
    const probes = buildTimeline(db, getRun(db, run.id)).entries.filter((e) => e.kind.startsWith('check.fail-before-probe-')).map((e) => e.text);
    expect(probes.some((t) => /^fail-before probe of unit started on tree [0-9a-f]{12} \(attempt 1\)$/.test(t))).toBe(true);
    expect(probes.some((t) => /^fail-before probe of unit FAILED \(exit 1\) on tree [0-9a-f]{12} \(attempt 1\)$/.test(t))).toBe(true);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('issue #157: a size denial names the files that carry the lines, and the same tree denied again blocks on a person naming the limit', async () => {
    const l = lab({ tweak: (c) => void (c.scheduler.hard_limits.changed_lines = 100) });
    const bundle = { op: 'write' as const, path: 'src/generated/bundle.js', content: Array.from({ length: 300 }, (_, i) => `export const line${i} = ${i};`).join('\n') + '\n' };
    writeScenario(
      l,
      scenario({
        planner: [planner({ allowed: ['src/server.ts', 'src/generated/**', 'tests/unit/**'], files: [['src/server.ts', 'modify', 'new not-found text'], ['tests/unit/server.test.ts', 'modify', 'assert the text'], ['src/generated/bundle.js', 'add', 'the generated bundle']] })],
        // The second attempt can only reproduce the tree: the task needs the generated file.
        implementer: [implementer([SRC_TEXT, TEST_TEXT, bundle]), implementer([])],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    // The first denial: the gate and the brief for the next attempt say which file is heavy, and ask for no revert.
    const gate = listDecisions(db, run.id).find((d) => /over the size limits/.test(d.summary));
    expect(gate?.summary, `${done.state}: ${done.outcomeReason ?? ''}`).toContain('the largest changes: src/generated/bundle.js (300 lines)');
    const { brief } = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-2.json'), 'utf8')) as { brief: { hypotheses: { statement: string }[]; scoped_fix: string } };
    expect(brief.hypotheses.map((h) => h.statement).join('\n')).toContain('its largest changes are src/generated/bundle.js (300 lines)');
    expect(JSON.stringify(brief)).not.toContain('Revert the out-of-scope changes');

    // The second denial of the same tree: a person decides, and no further attempt is spent.
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/over scheduler\.hard_limits\.changed_lines again \(\d+ lines against a limit of 100\)/);
    expect(done.outcomeReason).toContain('The largest changes: src/generated/bundle.js (300 lines)');
    expect(done.outcomeReason).toContain(`orbit resume ${run.id} --force`);
    expect(JSON.parse(done.outcomeJson!)).toMatchObject({ frozen_policy: { setting: 'scheduler.hard_limits.changed_lines' } });
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(new Set(listCandidates(db, run.id).map((c) => c.treeHash)).size).toBe(1);
    expect(transitions(db, run.id).at(-1)).toBe('BLOCKED');
    assertRunInvariants(l, run.id);
  }, 240_000);
});
