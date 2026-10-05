import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { loadRunContext, type ControllerDeps } from '../../../src/controller/context.ts';
import { acquireLease } from '../../../src/controller/run-store.ts';
import { step } from '../../../src/controller/steps/index.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { answerDecisionId } from '../../../src/inquisition/actors.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listAmendments, listQuestions, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import { listDecisions, recordDecision } from '../../../src/storage/decisions.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from '../../integration/controller/harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

// A mandatory check that already fails on the base revision, the same way every time, and that the change under test
// never touches. The criterion is proven by the passing `unit` check, so excepting `legacy` leaves it provable.
const LEGACY = 'console.error("legacy report exporter is broken");\nprocess.exit(1);\n';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!canStripTypes)('a baseline failure becomes a decision, and an approved answer reaches the run contract (S6.6, G27)', () => {
  it('PREFLIGHT raises the question; Approve puts the recorded fingerprint in the contract; the evidence honours it for that failure and the run succeeds', async () => {
    const l = makeLab({
      files: { 'tools/legacy-check.mjs': LEGACY },
      tweak: (c) => {
        c.checks.legacy = { ...c.checks.unit!, id: 'legacy', command: [process.execPath, 'tools/legacy-check.mjs'], mandatory: true };
      },
    });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);

    // Drive to PLANNING: preflight (with its baseline) and contracting are done, the implementer has not started.
    for (let i = 0; i < 1_200 && runState(l, run.id).state !== 'PLANNING'; i++) {
      await step(deps, run.id, new AbortController().signal);
      if (runState(l, run.id).state !== 'PLANNING') await sleep(25);
    }
    expect(runState(l, run.id).state).toBe('PLANNING');

    const requests = listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' });
    expect(requests).toHaveLength(1);
    const req = requests[0]!.data as { question_id: string; check_id: string; fingerprint: string };
    expect(req.check_id).toBe('legacy');
    const [question] = listQuestions(l.db(), run.id, { status: 'open' });
    expect(question).toMatchObject({ id: req.question_id, material: false, mode: 'decision-record' });
    // Asking did not except anything.
    expect(loadRunContext(deps, run.id, new AbortController().signal).contract!.baseline_exceptions).toBeUndefined();

    const runDir = join(l.repo, '.orbit', 'runs', run.id);
    const answer = answerQuestion(l.db(), runDir, question!.id, 'Approve', 'alice', systemClock);
    expect(answer.baselineException?.status).toBe('applied');
    const contract = loadRunContext(deps, run.id, new AbortController().signal).contract!;
    expect(contract.baseline_exceptions).toEqual([expect.objectContaining({ check_id: 'legacy', fingerprint: req.fingerprint })]);
    expect(listAmendments(l.db(), run.id, { status: 'applied' }).map((a) => a.record.field)).toEqual(['baseline_exceptions']);

    // The rest of the run is the ordinary loop.
    for (let i = 0; i < 2_400 && !['SUCCEEDED', 'BLOCKED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED'].includes(runState(l, run.id).state); i++) {
      await step(deps, run.id, new AbortController().signal);
      await sleep(25);
    }
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [ev] = listEvidenceReports(l.db(), run.id);
    expect(ev?.verdict).toBe('PASS');
    expect(ev?.report.unverified.join('\n')).toMatch(/baseline exception; accepted/);
    expect(ev?.report.checks.find((c) => c.id === 'legacy')?.status).toBe('FAILED');
    expect(ev?.report.checks.find((c) => c.id === 'unit')?.status).toBe('PASSED');
    const final = JSON.parse(readFileSync(join(runDir, 'final.json'), 'utf8')) as { unverified: string[]; decisions: { kind: string }[] };
    expect(final.unverified.join('\n')).toMatch(/baseline exception; accepted/);
    expect(final.decisions.map((d) => d.kind)).toEqual(expect.arrayContaining(['baseline.exception-request', 'contract.baseline-exception']));
  }, 180_000);
  it('an approval recorded after planning, whose apply step never ran, is applied when VERIFYING starts (G55): the failure is accepted and the run never enters DIAGNOSING', async () => {
    const l = makeLab({
      files: { 'tools/legacy-check.mjs': LEGACY },
      tweak: (c) => {
        c.checks.legacy = { ...c.checks.unit!, id: 'legacy', command: [process.execPath, 'tools/legacy-check.mjs'], mandatory: true };
      },
    });
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    const deps: ControllerDeps = { ...labDeps(l), ownerId: 'controller-a' };
    acquireLease(l.db(), run.id, 'controller-a', 3_600_000, systemClock);
    const signal = new AbortController().signal;

    // Drive to IMPLEMENTING: PLANNING has run, so it did not see an answer (there was none), and VERIFYING has not.
    for (let i = 0; i < 1_200 && runState(l, run.id).state !== 'IMPLEMENTING'; i++) {
      await step(deps, run.id, signal);
      if (runState(l, run.id).state !== 'IMPLEMENTING') await sleep(25);
    }
    expect(runState(l, run.id).state).toBe('IMPLEMENTING');
    expect(loadRunContext(deps, run.id, signal).contract!.baseline_exceptions).toBeUndefined();

    // The person's answer is recorded (the row and the decision), but the process died before the apply step ran.
    const req = listDecisions(l.db(), run.id, { kind: 'baseline.exception-request' })[0]!.data as { question_id: string };
    const runDir = join(l.repo, '.orbit', 'runs', run.id);
    setQuestionAnswer(l.db(), req.question_id, 'Approve', 'alice', systemClock);
    recordDecision(
      l.db(),
      runDir,
      { id: answerDecisionId(req.question_id), runId: run.id, kind: 'inquisition.answer', summary: 'chose "Approve"', data: { question_id: req.question_id, answer: 'Approve', chosen_option: 'Approve', free_text: false, answered_by: 'alice', material: false, affected: [] } },
      systemClock,
      { actor: 'alice' },
    );
    expect(listAmendments(l.db(), run.id, { status: 'applied' })).toEqual([]);
    expect(loadRunContext(deps, run.id, signal).contract!.baseline_exceptions).toBeUndefined();

    const states = new Set<string>();
    for (let i = 0; i < 2_400 && !['SUCCEEDED', 'BLOCKED', 'EXHAUSTED', 'IMPOSSIBLE', 'CANCELLED'].includes(runState(l, run.id).state); i++) {
      await step(deps, run.id, signal);
      states.add(runState(l, run.id).state);
      await sleep(25);
    }
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(states.has('DIAGNOSING')).toBe(false);
    expect(listAmendments(l.db(), run.id, { status: 'applied' }).map((a) => a.record.field)).toEqual(['baseline_exceptions']);
    const reports = listEvidenceReports(l.db(), run.id);
    expect(reports).toHaveLength(1);
    expect(reports[0]?.verdict).toBe('PASS');
    expect(reports[0]?.report.unverified.join('\n')).toMatch(/baseline exception; accepted/);
  }, 180_000);
});
