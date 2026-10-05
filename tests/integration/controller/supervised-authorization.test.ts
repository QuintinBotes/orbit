// Supervised mode asks before refusing what the policy does not authorize (spec section 5; docs/gaps.md G15):
// a dependency change becomes a persisted authorization question and the run blocks; approve-once from a person
// authorizes that change for that candidate only; deny sends it back to repair; a model identity cannot answer.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { acquireLease, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listQuestions, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { loadRunContext } from '../../../src/controller/context.ts';
import { deniedDependencyOperations, grantFor } from '../../../src/controller/authorization.ts';
import { baseScenario, IMPLEMENTER_OUTPUT, implementMul, labDeps, makeLab, MUL_TEST, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

/** mul, its test, and a lockfile change the policy does not authorize (dependencies.change_lockfile is false). */
const WITH_LOCKFILE = {
  edits: [
    { op: 'write', path: 'apps/calc.mjs', content: 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n' },
    { op: 'write', path: 'tests/mul.test.mjs', content: MUL_TEST },
    { op: 'write', path: 'apps/package-lock.json', content: '{ "lockfileVersion": 3 }\n' },
  ],
  structured: IMPLEMENTER_OUTPUT,
};

function supervisedLab(): Lab {
  const l = makeLab({ tweak: (c) => void (c.mode = 'supervised') });
  labs.push(l);
  return l;
}

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

/** What `orbit resume` does for a blocked run: back to the stage it stopped in. */
function resume(l: Lab, runId: string): void {
  const run = runState(l, runId);
  acquireLease(l.db(), runId, 'person-resume', 60_000, systemClock);
  transition(l.db(), { runId, to: run.resumeState!, ownerId: 'person-resume', reason: 'resumed after a decision', actor: 'acme-dev', expectedFrom: 'BLOCKED' }, systemClock);
  releaseLease(l.db(), runId, 'person-resume');
}

describe.skipIf(!canStripTypes)('controller: supervised one-shot authorization', () => {
  it('a lockfile change blocks on a persisted authorization question; approve-once from a person lets that candidate through', async () => {
    const l = supervisedLab();
    writeScenario(l, baseScenario({ implementer: [WITH_LOCKFILE] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const blocked = runState(l, run.id);
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/needs a person's authorization/);
    const [q] = listQuestions(l.db(), run.id, { status: 'open' });
    expect(q).toMatchObject({ material: true, changes: ['authority'] });
    expect(q!.options.map((o) => o.label)).toEqual(['approve-once', 'deny']);
    expect(q!.evidence.join(' ')).toMatch(/"change":"change_lockfile"/);
    const [req] = listDecisions(l.db(), run.id, { kind: 'authorization.request' });
    expect(req?.data).toMatchObject({ question_id: q!.id, operation: { kind: 'dependency', change: 'change_lockfile' } });
    // Nothing was decided on the change while the question was open: no evidence report, no repair.
    expect(listEvidenceReports(l.db(), run.id)).toEqual([]);

    // A model identity cannot answer it.
    let refused = false;
    try {
      answerQuestion(l.db(), l.repo, q!.id, 'approve-once', 'implementer', systemClock);
    } catch (err) {
      refused = isOrbitError(err, 'POLICY_DENIED');
    }
    expect(refused).toBe(true);

    answerQuestion(l.db(), join(l.repo, '.orbit', 'runs', run.id), q!.id, 'approve-once', 'acme-dev', systemClock);
    resume(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [grant] = listDecisions(l.db(), run.id, { kind: 'authorization.grant' });
    expect(grant?.data).toMatchObject({ question_id: q!.id, approved_by: 'acme-dev', tree_hash: listEvidenceReports(l.db(), run.id).at(-1)!.treeHash });
    expect(listEvidenceReports(l.db(), run.id).at(-1)!.report.unverified.join(' ')).toMatch(/authorized once by acme-dev/);
    // One implementer: the change was authorized, not repaired away.
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(1);
    // The snapshot did not widen: the policy still refuses the operation itself.
    const ctx = loadRunContext({ ...labDeps(l), ownerId: 'x' }, run.id, new AbortController().signal);
    expect(ctx.snapshot.config.dependencies.change_lockfile).toBe(false);
  }, 120_000);

  it('deny sends the change back to the implementer as a scope repair', async () => {
    const l = supervisedLab();
    writeScenario(l, baseScenario({ implementer: [WITH_LOCKFILE, implementMul('*', [{ op: 'delete', path: 'apps/package-lock.json' }])] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const [q] = listQuestions(l.db(), run.id, { status: 'open' });
    answerQuestion(l.db(), join(l.repo, '.orbit', 'runs', run.id), q!.id, 'deny', 'acme-dev', systemClock);
    resume(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listDecisions(l.db(), run.id, { kind: 'authorization.grant' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'policy.deny' }).length).toBeGreaterThanOrEqual(1);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(2);
  }, 120_000);

  it('an approve-once recorded under a non-human identity is not a grant, and a grant names one tree only', async () => {
    const l = supervisedLab();
    writeScenario(l, baseScenario({ implementer: [WITH_LOCKFILE] }));
    const run = startLabRun(l);
    await drive(l, run.id);
    const [q] = listQuestions(l.db(), run.id, { status: 'open' });
    setQuestionAnswer(l.db(), q!.id, 'approve-once', 'claude', systemClock);
    const ctx = loadRunContext({ ...labDeps(l), ownerId: 'x' }, run.id, new AbortController().signal);
    const [op] = deniedDependencyOperations(ctx.candidate!.scope!, ctx.snapshot);
    expect(grantFor(ctx, op!, ctx.candidate!.treeHash).state).toBe('denied');
    expect(grantFor(ctx, op!, 'f'.repeat(40)).state).toBe('none');
  }, 120_000);
});
