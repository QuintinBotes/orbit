// Supervised mode asks before refusing what the policy does not authorize (spec section 5; docs/gaps.md G15):
// a dependency change becomes a persisted authorization question and the run blocks; approve-once from a person
// authorizes that change for that candidate only; deny sends it back to repair; a model identity cannot answer.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { acquireLease, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listQuestions, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import { listDecisions, recordDecision } from '../../../src/storage/decisions.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { stepTo, waitFor } from '../../fault-injection/helpers.ts';
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

/**
 * The implementer of attempt 1 runs and, inside its session, the guard denies `chmod +x apps/run.sh`
 * (actions.change_permissions is false). The fake CLI does not run the guard hook, so the denial is recorded
 * exactly as controller/denials records one from a transcript, while the session is finishing.
 */
async function deniedChmodRun(l: Lab): Promise<string> {
  writeScenario(l, baseScenario({ implementer: [implementMul('*'), implementMul('*')] }));
  const run = startLabRun(l);
  const deps = await stepTo(l, run.id, 'IMPLEMENTING');
  await step(deps, run.id, new AbortController().signal);
  const w = await waitFor(() => listWorkers(l.db(), { runId: run.id, role: 'implementer' })[0], 30_000);
  await waitFor(() => existsSync(join(w.workerDir, 'exit.json')), 60_000);
  recordDecision(
    l.db(),
    join(l.repo, '.orbit', 'runs', run.id),
    {
      id: `dec-${run.id}-deny-${w.id}-toolu_chmod`,
      runId: run.id,
      kind: 'policy.deny',
      summary: `implementer ${w.id}: Bash denied by the guard hook (actions.change_permissions) on chmod +x apps/run.sh`,
      data: { source: 'guard-hook', worker_id: w.id, role: 'implementer', provider: w.provider, tool: 'Bash', tool_use_id: 'toolu_chmod', rule: 'actions.change_permissions', target: 'chmod +x apps/run.sh', reason: 'chmod +x apps/run.sh changes file permissions, which this policy does not authorize' },
    },
    systemClock,
    { actor: 'guard' },
  );
  releaseLease(l.db(), run.id, 'controller-a');
  await drive(l, run.id);
  return run.id;
}

describe.skipIf(!canStripTypes)('controller: supervised authorization of operations denied inside a worker (G15)', () => {
  it('a denied chmod becomes a persisted question; approve-once retries the attempt under a grant for exactly that operation', async () => {
    const l = supervisedLab();
    const id = await deniedChmodRun(l);

    const blocked = runState(l, id);
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.outcomeReason).toMatch(/implementation attempt 1 was denied operations the policy does not authorize/);
    const [q] = listQuestions(l.db(), id, { status: 'open' });
    expect(q).toMatchObject({ material: true, changes: ['authority'] });
    expect(q!.options.map((o) => o.label)).toEqual(['approve-once', 'deny']);
    expect(q!.question).toMatch(/implementation attempt 1 run `chmod \+x apps\/run\.sh`/);
    const [req] = listDecisions(l.db(), id, { kind: 'authorization.request' });
    expect(req?.data).toMatchObject({ question_id: q!.id, attempt: 1, subject: 'attempt:1', operation: { kind: 'bash', command: 'chmod +x apps/run.sh' } });
    // Nothing was snapshotted or verified while the question was open.
    expect(listEvidenceReports(l.db(), id)).toEqual([]);

    answerQuestion(l.db(), join(l.repo, '.orbit', 'runs', id), q!.id, 'approve-once', 'acme-dev', systemClock);
    resume(l, id);
    await drive(l, id);

    const done = runState(l, id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [grant] = listDecisions(l.db(), id, { kind: 'authorization.grant' });
    expect(grant?.data).toMatchObject({ question_id: q!.id, approved_by: 'acme-dev', attempt: 1, operation: { kind: 'bash', command: 'chmod +x apps/run.sh' } });
    // The attempt was retried, not a new attempt counted: one attempt, two sessions.
    const ws = listWorkers(l.db(), { runId: id, role: 'implementer' });
    expect(ws.map((w) => w.purpose)).toEqual(['implement:1#1', 'implement:1#2']);
    // The retried session ran under the grant policy: the frozen snapshot widened by exactly change_permissions.
    const grantFile = join(ws[1]!.workerDir, 'policy-grant.json');
    const granted = JSON.parse(readFileSync(grantFile, 'utf8')) as { config: { actions: Record<string, boolean> } };
    const ctx = loadRunContext({ ...labDeps(l), ownerId: 'x' }, id, new AbortController().signal);
    expect(granted.config.actions).toEqual({ ...ctx.snapshot.config.actions, change_permissions: true });
    expect(existsSync(join(ws[0]!.workerDir, 'policy-grant.json'))).toBe(false);
    expect(readFileSync(join(ws[1]!.workerDir, 'prompt.md'), 'utf8')).toMatch(/Authorized once, for this attempt only: run `chmod \+x apps\/run\.sh`/);
    // The run's own policy did not widen.
    expect(ctx.snapshot.config.actions.change_permissions).toBe(false);
  }, 180_000);

  it('deny retries the attempt as a scope repair under the unchanged policy', async () => {
    const l = supervisedLab();
    const id = await deniedChmodRun(l);
    const [q] = listQuestions(l.db(), id, { status: 'open' });
    answerQuestion(l.db(), join(l.repo, '.orbit', 'runs', id), q!.id, 'deny', 'acme-dev', systemClock);
    resume(l, id);
    await drive(l, id);

    const done = runState(l, id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listDecisions(l.db(), id, { kind: 'authorization.grant' })).toEqual([]);
    const ws = listWorkers(l.db(), { runId: id, role: 'implementer' });
    expect(ws.map((w) => w.purpose)).toEqual(['implement:1#1', 'implement:1#2']);
    expect(existsSync(join(ws[1]!.workerDir, 'policy-grant.json'))).toBe(false);
    expect(readFileSync(join(ws[1]!.workerDir, 'prompt.md'), 'utf8')).toMatch(/Refused by a person: run `chmod \+x apps\/run\.sh`\. Do not try it again/);
  }, 180_000);

  it('autonomous mode only records the denial and asks nothing', async () => {
    const l = makeLab();
    labs.push(l);
    const id = await deniedChmodRun(l);
    expect(runState(l, id).state).toBe('SUCCEEDED');
    expect(listQuestions(l.db(), id)).toEqual([]);
    expect(listWorkers(l.db(), { runId: id, role: 'implementer' })).toHaveLength(1);
  }, 180_000);
});
