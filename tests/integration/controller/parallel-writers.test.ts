// Parallel writers within one run (spec section 8; docs/gaps.md G14): criteria the planner mapped to disjoint
// files run as separate implementers in separate worktrees, admitted with a merge-overhead cost, integrated
// serially into the run's worktree with evidence invalidated; a conflict serializes the unit.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkers } from '../../../src/storage/workers.ts';
import { listCandidates, listEvidenceReports } from '../../../src/evidence/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { APPROVE, baseScenario, canStripTypes, drive, events, FIXED_PROBE, IMPLEMENTER_OUTPUT, MUL_TEST, PLANNER_OUTPUT, runState, startLabRun, tracker, writeScenario } from '../../fault-injection/helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

const SHOUT_TEST = "import { shout } from '../apps/strings.mjs';\nif (shout('hi') !== 'HI!') { console.error('shout expected HI!'); process.exit(1); }\n";
const CALC = 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n';
const STRINGS = "export const shout = (s) => `${s.toUpperCase()}!`;\n";

const PLANNER = {
  structured: {
    ...PLANNER_OUTPUT,
    objective: 'Add mul to the calculator and a shout helper.',
    criteria: [
      { ...PLANNER_OUTPUT.criteria[0]!, changes: [{ path: 'apps/calc.mjs', summary: 'add mul' }] },
      { key: 'shout', statement: 'shout(s) returns s in upper case followed by an exclamation mark.', mandatory: true, ui: false, proof: ['tests/shout.test.mjs asserts shout("hi") === "HI!"'], check_ids: ['unit'], changes: [{ path: 'apps/strings.mjs', summary: 'add shout' }] },
    ],
    expected_changed_files: [...PLANNER_OUTPUT.expected_changed_files, { path: 'apps/strings.mjs', change: 'add', reason: 'shout' }, { path: 'tests/shout.test.mjs', change: 'add', reason: 'behaviour test' }],
  },
};

const unitStep = (edits: object[], sleepMs: number) => ({ edits, structured: IMPLEMENTER_OUTPUT, sleepMs });
const MUL_UNIT = [{ op: 'write', path: 'apps/calc.mjs', content: CALC }, { op: 'write', path: 'tests/mul.test.mjs', content: MUL_TEST }];
const SHOUT_UNIT = [{ op: 'write', path: 'apps/strings.mjs', content: STRINGS }, { op: 'write', path: 'tests/shout.test.mjs', content: SHOUT_TEST }];

const lab = (parallelism = 2) => t.lab({ tweak: (c) => void (c.agents = { ...c.agents, default_parallelism: parallelism }) });

describe.skipIf(!canStripTypes)('controller: parallel writers within a run', () => {
  it('runs two disjoint work units at once in their own worktrees, integrates both serially and verifies one candidate', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ planner: [PLANNER], 'implementer@u1': [unitStep(MUL_UNIT, 1_500)], 'implementer@u2': [unitStep(SHOUT_UNIT, 1_500)], reviewer: [APPROVE] }));
    const run = startLabRun(l, 'Add mul to the calculator and a shout helper.');
    await drive(l, run.id, { schedulerProbe: FIXED_PROBE });

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const ws = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(ws.map((w) => w.purpose).sort()).toEqual(['implement:1/u1#1', 'implement:1/u2#1']);
    // At the same time, each in its own worktree, never the run's.
    const [a, b] = ws;
    expect(a!.spawnedAt!).toBeLessThan(b!.endedAt!);
    expect(b!.spawnedAt!).toBeLessThan(a!.endedAt!);
    expect(new Set([a!.cwd, b!.cwd, done.worktreePath]).size).toBe(3);
    expect(ws.find((w) => w.purpose === 'implement:1/u2#1')!.ownedPaths).toEqual(['apps/strings.mjs']);
    const prompt = readFileSync(join(ws.find((w) => w.purpose === 'implement:1/u1#1')!.workerDir, 'prompt.md'), 'utf8');
    expect(prompt).toMatch(/You are work unit u1 of 2 parallel writers/);
    expect(prompt).toMatch(/Do not touch what the other units own: apps\/strings\.mjs/);
    // The plan, the merge overhead charged to the second writer, and both serial integrations are recorded.
    expect(listDecisions(l.db(), run.id, { kind: 'scheduling.work-units' })).toHaveLength(1);
    const merge = events(l, run.id, 'scheduler.merge-overhead');
    expect(merge).toHaveLength(1);
    expect(JSON.parse(merge[0]!.data_json!)).toMatchObject({ attempt: 1, unit: 'u2', alongside: ['implement:1/u1'] });
    const integrated = events(l, run.id, 'implementation.unit-integrated').map((e) => JSON.parse(e.data_json!) as { unit: string; paths: string[] });
    expect(integrated.map((e) => e.unit).sort()).toEqual(['u1', 'u2']);
    expect(integrated.find((e) => e.unit === 'u2')!.paths).toEqual(['apps/strings.mjs', 'tests/shout.test.mjs']);
    // One candidate holds both units' work; its evidence passed.
    const cands = listCandidates(l.db(), run.id);
    expect(cands).toHaveLength(1);
    expect(cands[0]!.diffStat?.paths.sort()).toEqual(['apps/calc.mjs', 'apps/strings.mjs', 'tests/mul.test.mjs', 'tests/shout.test.mjs']);
    expect(listEvidenceReports(l.db(), run.id).at(-1)!.report.verdict).toBe('PASS');
    expect(events(l, run.id, 'implementation.unit-serialized')).toEqual([]);
  }, 120_000);

  it('a unit that touches a file the integrated work changed is serialized: one implementer finishes it on the integrated tree', async () => {
    const l = lab();
    // u2 strays into apps/calc.mjs, which u1 (finishing first) changed.
    const stray = [...SHOUT_UNIT, { op: 'write', path: 'apps/calc.mjs', content: `${CALC}// shout was here\n` }];
    const serial = { edits: [...MUL_UNIT, ...SHOUT_UNIT], structured: IMPLEMENTER_OUTPUT };
    writeScenario(l, baseScenario({ planner: [PLANNER], 'implementer@u1': [unitStep(MUL_UNIT, 200)], 'implementer@u2': [unitStep(stray, 2_500)], implementer: [serial], reviewer: [APPROVE] }));
    const run = startLabRun(l, 'Add mul to the calculator and a shout helper.');
    await drive(l, run.id, { schedulerProbe: FIXED_PROBE });

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [ser] = events(l, run.id, 'implementation.unit-serialized').map((e) => JSON.parse(e.data_json!) as { unit: string; reason: string; criteria: string[] });
    expect(ser).toMatchObject({ unit: 'u2', criteria: ['AC-2'] });
    expect(ser!.reason).toMatch(/^conflict: apps\/calc\.mjs already changed by integrated work/);
    const ws = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(ws.map((w) => w.purpose).sort()).toEqual(['implement:1#1', 'implement:1/u1#1', 'implement:1/u2#1']);
    const serialPrompt = readFileSync(join(ws.find((w) => w.purpose === 'implement:1#1')!.workerDir, 'prompt.md'), 'utf8');
    expect(serialPrompt).toMatch(/Work unit u2 \(AC-2\) could not be integrated in parallel \(conflict: apps\/calc\.mjs/);
    expect(ws.find((w) => w.purpose === 'implement:1#1')!.cwd).toBe(done.worktreePath);
    // Still one attempt and one candidate.
    expect(l.db().get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'implementation_attempts'", run.id)?.used).toBe(1);
    expect(listCandidates(l.db(), run.id)).toHaveLength(1);
    expect(readFileSync(join(done.worktreePath!, 'apps/calc.mjs'), 'utf8')).toBe(CALC);
  }, 120_000);

  it('keeps one writer when the policy asks for no parallelism', async () => {
    const l = lab(1);
    writeScenario(l, baseScenario({ planner: [PLANNER], implementer: [{ edits: [...MUL_UNIT, ...SHOUT_UNIT], structured: IMPLEMENTER_OUTPUT }], reviewer: [APPROVE] }));
    const run = startLabRun(l, 'Add mul to the calculator and a shout helper.');
    await drive(l, run.id, { schedulerProbe: FIXED_PROBE });
    expect(runState(l, run.id).state).toBe('SUCCEEDED');
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' }).map((w) => w.purpose)).toEqual(['implement:1#1']);
    expect(events(l, run.id, 'implementation.units')).toEqual([]);
  }, 120_000);
});
