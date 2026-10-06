/**
 * Spec section 10 and scenario 4 on the review-repair path (e2e re-test NB1): a review finding about a
 * criterion an open material question blocks is not repaired on a guess. The run goes BLOCKED with the
 * question, so `orbit decide` can answer it, instead of spending every attempt reproducing the same tree
 * and ending EXHAUSTED with "the authorized budget is spent".
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkers } from '../../src/storage/workers.ts';
import { listQuestions } from '../../src/inquisition/store.ts';
import { drive, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, implementer, NOT_FOUND_TEXT, planner, review, scenario, SRC_TEXT, TEST_TEXT, type Criterion } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}

const TEXT: Criterion = { key: 'text', statement: `A request for an unknown path answers 404 with the plain text body "${NOT_FOUND_TEXT}".` };
const JSON_404: Criterion = { key: 'json', statement: 'A request for an unknown path under /api answers 404 with a JSON error body.' };
const QUESTION = 'Should unknown /api paths answer with a JSON error body, and with which fields?';

/** The reviewer finds the blocked criterion unmet: it names AC-2, which waits for a person. */
const API_FINDING = {
  id: 'API-1',
  severity: 'high',
  category: 'correctness',
  location: 'src/server.ts:28',
  claim: 'Unknown /api paths still answer the plain text body, so AC-2 is not met.',
  evidence: "handle('/api/nope') returns type text/plain; no JSON body is produced.",
  suggested_validation: "Add a test asserting that handle('/api/nope') answers 404 with a JSON error body.",
};

describe.skipIf(!READY)('acceptance: an open material question stops the review-repair loop (NB1)', () => {
  it('a finding on a criterion blocked by an open material question ends BLOCKED naming the question, after one attempt', async () => {
    const l = lab();
    writeScenario(
      l,
      scenario({
        planner: [planner({ criteria: [TEXT, JSON_404], decisions: [{ question: QUESTION, options: ['{"error":"not found"}', 'keep plain text'], recommendation: null, material: true, affected_criteria: ['json'] }] })],
        // The independent criterion is done in attempt 1; a second attempt would change nothing (it must not guess AC-2).
        implementer: [implementer([SRC_TEXT, TEST_TEXT]), implementer([])],
        reviewer: [review('REPAIR_REQUIRED', [API_FINDING])],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    const open = listQuestions(db, run.id, { status: 'open' }).filter((q) => q.material);
    expect(open).toHaveLength(1);
    const qid = open[0]!.id;
    expect(done.outcomeReason).toContain(qid);
    expect(done.outcomeReason).toContain('API-1');
    // Nothing was repaired on a guess: one attempt, no repair brief sent for the blocked finding.
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(transitions(db, run.id)).not.toContain('REPAIRING');
    const report = JSON.parse(readFileSync(join(l.runDir(run.id), 'final.json'), 'utf8')) as { next_action: string; outcome: string };
    expect(report.outcome).toBe('BLOCKED');
    expect(report.next_action).toContain(qid);
    expect(report.next_action).toMatch(/orbit decide/);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('a finding that does not name the blocked criterion is repaired once; when the repair changes nothing the open question, not EXHAUSTED, ends the run', async () => {
    const l = lab();
    const unnamed = { ...API_FINDING, claim: 'Unknown /api paths still answer the plain text body instead of a JSON error.' };
    writeScenario(
      l,
      scenario({
        planner: [planner({ criteria: [TEXT, JSON_404], decisions: [{ question: QUESTION, options: ['{"error":"not found"}', 'keep plain text'], recommendation: null, material: true, affected_criteria: ['json'] }] })],
        implementer: [implementer([SRC_TEXT, TEST_TEXT]), implementer([])],
        reviewer: [review('REPAIR_REQUIRED', [unnamed])],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    const qid = listQuestions(db, run.id, { status: 'open' }).find((q) => q.material)!.id;
    expect(done.outcomeReason).toContain(qid);
    expect(done.outcomeReason).toMatch(/non-progress: attempt 2 reproduced tree/);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(transitions(db, run.id).filter((s) => s === 'REPAIRING')).toHaveLength(1);
    // The repair brief told the implementer not to guess the blocked criterion.
    const brief = JSON.parse(readFileSync(join(l.runDir(run.id), 'briefs', 'attempt-2.json'), 'utf8')) as { brief: { preserved_constraints: string[] } };
    expect(brief.brief.preserved_constraints.join('\n')).toContain(`Do not implement or guess AC-2`);
    assertRunInvariants(l, run.id);
  }, 180_000);
});
