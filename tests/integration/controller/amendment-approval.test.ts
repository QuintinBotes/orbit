// A contract amendment only a person may approve (spec section 10): the Inquisition stores it pending, with a
// q-amd-<id> question, and the run blocks. "Approve" through `orbit decide` applies it to the run's contract
// and "Reject" closes it; after `orbit resume` the controller works on the amended (or unchanged) contract
// instead of re-checking the stale state and blocking again.
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { loadRunContext, type ControllerDeps } from '../../../src/controller/context.ts';
import { acquireLease, releaseLease } from '../../../src/controller/run-store.ts';
import { finishRun } from '../../../src/controller/steps/common.ts';
import { step } from '../../../src/controller/steps/index.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import { processAmendments } from '../../../src/inquisition/engine.ts';
import { getAmendment } from '../../../src/inquisition/store.ts';
import { loadInquisitionSnapshot } from '../../../src/inquisition/triggers.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { join } from 'node:path';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const NON_GOAL = 'mul does not accept bigint arguments';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function cli(l: Lab, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo('');
  const code = await main(argv, { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome }, user: 'acme' });
  return { code, out: io.stdout, err: io.stderr };
}

/** A run BLOCKED on the approval question for a pending `add_non_goal` amendment (which needs a person). */
async function blockedOnAmendment(): Promise<{ l: Lab; runId: string; amendmentId: string; questionId: string; deps: ControllerDeps }> {
  const l = makeLab();
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
  const run = startLabRun(l);
  const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
  acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
  for (let i = 0; i < 1_200 && runState(l, run.id).contractJson === null; i++) {
    const r = await step(deps, run.id, new AbortController().signal);
    if (r.done) break;
    if (runState(l, run.id).contractJson === null) await sleep(25);
  }
  expect(runState(l, run.id).contractJson).not.toBeNull();
  const ctx = loadRunContext(deps, run.id, new AbortController().signal);
  const out = processAmendments(
    { db: ctx.db, clock: ctx.clock, runId: run.id, runDir: ctx.runDir, snapshot: ctx.snapshot, contract: ctx.contract!, inquiry: loadInquisitionSnapshot(ctx.db, run.id) },
    'clarify',
    [{ change: { op: 'add_non_goal', non_goal: NON_GOAL }, evidence: 'calc.mjs multiplies with *, which throws a TypeError when bigint and number mix', reason: 'keep bigint support out of this change' }],
  );
  expect(out.outcomes.pending).toHaveLength(1);
  const amendmentId = out.outcomes.pending[0]!.id;
  const questionId = out.questions[0]!.id;
  expect(questionId).toBe(`q-amd-${amendmentId}`);
  await finishRun(ctx, 'BLOCKED', `contract change needs a decision; open questions: ${questionId}`);
  releaseLease(l.db(), run.id, 'controller-a');
  expect(runState(l, run.id).state).toBe('BLOCKED');
  return { l, runId: run.id, amendmentId, questionId, deps };
}

async function resumeAndStep(l: Lab, runId: string, deps: ControllerDeps): Promise<void> {
  const resumed = await cli(l, ['resume', runId, '--detach']);
  expect(resumed.code, resumed.err).toBe(0);
  acquireLease(l.db(), runId, deps.ownerId, 3_600_000, systemClock);
  await step(deps, runId, new AbortController().signal);
  releaseLease(l.db(), runId, deps.ownerId);
}

describe.skipIf(!canStripTypes)('controller: approved contract amendments', () => {
  it('"Approve" applies the pending amendment to the run contract, and the run continues on the amended contract', async () => {
    const { l, runId, amendmentId, questionId, deps } = await blockedOnAmendment();
    const decided = await cli(l, ['decide', runId, questionId, 'Approve']);
    expect(decided.code, decided.err).toBe(0);
    await resumeAndStep(l, runId, deps);

    expect(getAmendment(l.db(), amendmentId).status).toBe('applied');
    const contract = JSON.parse(runState(l, runId).contractJson!) as GoalContract;
    expect(contract.non_goals).toContain(NON_GOAL);
    expect(runState(l, runId).state).not.toBe('BLOCKED');
  }, 120_000);

  it('an approval recorded without being applied (an interrupted decide) is applied by the controller at its next step', async () => {
    const { l, runId, amendmentId, questionId, deps } = await blockedOnAmendment();
    answerQuestion(l.db(), join(l.repo, '.orbit', 'runs', runId), questionId, 'Approve', 'acme', systemClock);
    expect(getAmendment(l.db(), amendmentId).status).toBe('pending-approval');
    await resumeAndStep(l, runId, deps);

    expect(getAmendment(l.db(), amendmentId).status).toBe('applied');
    expect((JSON.parse(runState(l, runId).contractJson!) as GoalContract).non_goals).toContain(NON_GOAL);
  }, 120_000);

  it('"Reject" marks the amendment rejected and leaves the contract as it was', async () => {
    const { l, runId, amendmentId, questionId, deps } = await blockedOnAmendment();
    const before = runState(l, runId).contractJson;
    const decided = await cli(l, ['decide', runId, questionId, 'Reject']);
    expect(decided.code, decided.err).toBe(0);
    await resumeAndStep(l, runId, deps);

    expect(getAmendment(l.db(), amendmentId).status).toBe('rejected');
    expect(runState(l, runId).contractJson).toBe(before);
    expect(runState(l, runId).state).not.toBe('BLOCKED');
  }, 120_000);
});
