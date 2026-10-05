/**
 * P18: when the goal's own criteria target the check that already fails on the base revision (the failing test IS the
 * goal), that check is expected to flip, not an exception to ask a person about. The run ends with no open question,
 * and a failing check the goal does not target is still asked about.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { baseScenario, implementMul, labDeps, makeLab, MUL_TEST, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ['SUCCEEDED', 'BLOCKED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED'];

async function drive(l: Lab, runId: string, deps: ControllerDeps): Promise<void> {
  for (let i = 0; i < 2_400 && !TERMINAL.includes(runState(l, runId).state); i++) {
    await step(deps, runId, new AbortController().signal);
    await sleep(25);
  }
}

describe.skipIf(!canStripTypes)('a failing baseline check that the goal targets is expected to flip (P18)', () => {
  it('asks no baseline exception question when the failing test is the goal, and the run succeeds with 0 open questions', async () => {
    // tests/mul.test.mjs is already in the repository and fails (mul is not exported): making it pass is the goal.
    const l = makeLab({ files: { 'tests/mul.test.mjs': MUL_TEST } });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l, 'Make tests/mul.test.mjs pass by adding mul to the calculator.');
    const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    await drive(l, run.id, deps);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listQuestions(l.db(), run.id, { status: 'open' })).toEqual([]);
    expect(listQuestions(l.db(), run.id).filter((q) => q.status !== 'withdrawn')).toEqual([]);
    const flips = listDecisions(l.db(), run.id, { kind: 'baseline.expected-to-flip' });
    expect(flips).toHaveLength(1);
    expect(flips[0]!.data).toMatchObject({ check_id: 'unit', criteria: ['AC-1'] });
    // Nothing was excepted: the check passes on the candidate.
    expect(listEvidenceReports(l.db(), run.id)[0]?.report.checks.find((c) => c.id === 'unit')?.status).toBe('PASSED');
    const final = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'final.json'), 'utf8')) as { residual_risks?: string[]; unverified: string[] };
    expect(JSON.stringify(final)).not.toMatch(/open question/);
  }, 180_000);

  it('a mandatory check that fails on the base and that the goal does not target is still asked about', async () => {
    const l = makeLab({
      files: { 'tools/legacy-check.mjs': 'console.error("legacy report exporter is broken");\nprocess.exit(1);\n' },
      tweak: (c) => {
        c.checks.legacy = { ...c.checks.unit!, id: 'legacy', command: [process.execPath, 'tools/legacy-check.mjs'], mandatory: true };
      },
    });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    for (let i = 0; i < 1_200 && runState(l, run.id).state !== 'PLANNING'; i++) {
      await step(deps, run.id, new AbortController().signal);
      if (runState(l, run.id).state !== 'PLANNING') await sleep(25);
    }
    expect(runState(l, run.id).state).toBe('PLANNING');
    expect(listQuestions(l.db(), run.id, { status: 'open' })).toHaveLength(1);
    expect(listDecisions(l.db(), run.id, { kind: 'baseline.expected-to-flip' })).toEqual([]);
  }, 180_000);
});
