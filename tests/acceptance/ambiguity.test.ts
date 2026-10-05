/**
 * Spec section 17, scenarios 3 and 4 (spec section 10, Orbit Inquisition):
 * a reversible ambiguity is resolved unattended and recorded as a decision;
 * a material ambiguity blocks the work it affects while independent work
 * continues, and the run never guesses the material answer.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listEvidenceReports } from '../../src/evidence/store.ts';
import { listQuestions } from '../../src/inquisition/store.ts';
import { drive, makeLab, READY, runState, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, planner, scenario, SRC_TEXT, TEST_TEXT, type Criterion } from './helpers/scenarios.ts';
import { assertRunInvariants, events, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

const TEXT: Criterion = { key: 'text', statement: `A request for an unknown path answers 404 with the plain text body "${NOT_FOUND_TEXT}".` };
const JSON_404: Criterion = { key: 'json', statement: 'A request for an unknown path under /api answers 404 with a JSON error body.' };

describe.skipIf(!READY)('acceptance: ambiguity (Orbit Inquisition)', () => {
  it('scenario 3: a reversible ambiguity is resolved unattended from the planner recommendation and recorded as a decision', async () => {
    const l = lab();
    const question = 'Should the not-found text keep its trailing period?';
    writeScenario(
      l,
      scenario({
        planner: [planner({ decisions: [{ question, options: ['keep the period', 'drop the period'], recommendation: 'keep the period', material: false, affected_criteria: ['text'] }] })],
        implementer: [GOOD_IMPLEMENTATION()],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const db = l.db();
    // Resolved without a person and without stopping: no question, no Inquisition stop, no BLOCKED.
    const resolved = listDecisions(db, run.id, { kind: 'inquisition.resolve' });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.summary).toContain(question);
    expect(resolved[0]!.data).toMatchObject({ question, choice: 'keep the period', basis: expect.stringMatching(/reversible/) });
    expect(listQuestions(db, run.id)).toEqual([]);
    expect(transitions(db, run.id)).not.toContain('BLOCKED');
    // The decision is durable in both places and reported.
    const mirror = readFileSync(join(l.runDir(run.id), 'decisions.jsonl'), 'utf8');
    expect(mirror).toContain(resolved[0]!.id);
    expect(readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8')).toMatch(/## Decisions[\s\S]*inquisition\.resolve: reversible choice/);
    expect(l.github().state.prs).toHaveLength(1);
    assertRunInvariants(l, run.id);
  }, 180_000);

  const question = 'Should unknown /api paths answer with a JSON error body, and with which fields?';
  async function materialRun(): Promise<{ l: Lab; runId: string }> {
    const l = lab();
    writeScenario(
      l,
      scenario({
        planner: [planner({ criteria: [TEXT, JSON_404], decisions: [{ question, options: ['{"error":"not found"}', 'keep plain text'], recommendation: null, material: true, affected_criteria: ['json'] }] })],
        implementer: [implementer([SRC_TEXT, TEST_TEXT])],
      }),
    );
    const run = startLabRun(l, GOAL);
    await drive(l, run.id);
    return { l, runId: run.id };
  }

  it('scenario 4: a material ambiguity goes to the Inquisition, blocks the criterion it affects, and the independent criterion is implemented and verified', async () => {
    const { l, runId } = await materialRun();
    const db = l.db();
    const done = runState(l, runId);
    // The Inquisition ran on the planner's trigger before any implementation.
    expect(transitions(db, runId).slice(0, 3)).toEqual(['PREFLIGHT', 'CONTRACTING', 'INQUISITION']);
    const settled = events(db, runId, 'inquisition.completed').map((e) => JSON.parse(e.data_json!) as { disposition: string; blocked: string[] });
    expect(settled[0]).toMatchObject({ disposition: 'continue-partial', blocked: ['AC-2'] });
    // Never a guessed answer: the material question stays a needs-decision assumption in the contract.
    expect(listDecisions(db, runId, { kind: 'inquisition.resolve' }).filter((d) => JSON.stringify(d.data).includes('/api'))).toEqual([]);
    const contract = JSON.parse(done.contractJson!) as { assumptions: { statement: string; status: string }[] };
    expect(contract.assumptions).toEqual([expect.objectContaining({ statement: question, status: 'needs-decision' })]);
    // Independent work continued: AC-1 was implemented, checked and supported by evidence.
    const implementers = listWorkers(db, { runId, role: 'implementer' });
    expect(implementers).toHaveLength(1);
    // The implementer was told which criterion waits for a decision, so it does not guess it.
    expect(readFileSync(join(implementers[0]!.workerDir, 'prompt.md'), 'utf8')).toContain("Blocked, waiting for a person's decision (do not implement or guess them): AC-2.");
    const ev = listEvidenceReports(db, runId).at(-1);
    expect(ev?.report.acceptance_evidence.find((a) => a.criterion_id === 'AC-1')?.status).toBe('supported');
    assertRunInvariants(l, runId);
  }, 180_000);

  it('scenario 4: the blocked criterion keeps the run from success and delivery, and its question waits for a person', async () => {
    const { l, runId } = await materialRun();
    const db = l.db();
    const done = runState(l, runId);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/AC-2|decision|question/i);
    expect(l.github().state.prs).toEqual([]);
    const open = listQuestions(db, runId, { status: 'open' });
    expect(open.some((q) => q.material && q.question.includes('/api'))).toBe(true);
    assertRunInvariants(l, runId);
  }, 180_000);
});
