// Reviewer availability end to end (issues #6 and #8, docs/decisions/0007-reviewer-availability.md): the independent
// reviewer (Codex) is unusable because it is not attested for data handling, and review.when_unavailable decides.
// claude: Claude reviews in a separate session and the run delivers, saying the review was not independent and why.
// ask: the run blocks on a material question and continues only after a person's yes. block: the run blocks.
import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { acquireLease, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listReviews } from '../../../src/review/store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import type { ReviewFallback } from '../../../src/policy/review.ts';
import { baseScenario, implementMul, labDeps, makeLab, readText, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

/** Codex is configured but not attested for data handling, so it cannot be sent the review packet. */
function lab(mode: ReviewFallback): Lab {
  const l = makeLab({
    tweak: (c) => {
      c.review = { ...c.review, providers: ['codex'], when_unavailable: mode };
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: false };
    },
  });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
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

const runDir = (l: Lab, runId: string): string => join(l.repo, '.orbit', 'runs', runId);
const visited = (l: Lab, runId: string, state: string): boolean =>
  l.db().get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = ? LIMIT 1", runId, state) !== undefined;

describe.skipIf(!canStripTypes)('controller: reviewer availability', () => {
  it('claude: Claude reviews in a separate session, the run delivers, and the report says the review was not independent and why', async () => {
    const l = lab('claude');
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(visited(l, run.id, 'DELIVERING')).toBe(true);
    const reviews = listReviews(l.db(), run.id);
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((r) => r.provider === 'claude')).toBe(true);
    // A separate reviewer session, not the implementer's.
    const reviewer = listWorkers(l.db(), { runId: run.id, role: 'reviewer' });
    const implementer = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(reviewer.length).toBeGreaterThan(0);
    expect(reviewer.map((w) => w.id)).not.toContain(implementer[0]!.id);
    expect(reviewer[0]!.provider).toBe('claude');
    expect(reviewer[0]!.model).toMatch(/opus/);

    const [select] = listDecisions(l.db(), run.id, { kind: 'review.select' });
    expect(select!.summary).toMatch(/same provider, not independent: .*data_policy_eligible is not true/);
    const final = readText(join(runDir(l, run.id), 'final.md'));
    expect(final).toMatch(/Reviewer: claude\/\S+ \(same provider, NOT independent: no independent reviewer was usable: .*providers\.codex\.data_policy_eligible is not true/);
    expect(final).not.toMatch(/Reviewer: claude\/\S+ \(independent\)/);
    const json = JSON.parse(readText(join(runDir(l, run.id), 'final.json'))) as { reviewer: { provider: string; independent: boolean; why_not_independent: string | null }; residual_risks: string[] };
    expect(json.reviewer).toMatchObject({ provider: 'claude', independent: false, why_not_independent: expect.stringMatching(/data_policy_eligible/) });
    expect(json.residual_risks.join('\n')).toMatch(/same-provider review: .*not independent/);
  }, 120_000);

  it('ask: the run blocks on a material question, and continues with a Claude review only after a person says yes', async () => {
    const l = lab('ask');
    const run = startLabRun(l);
    await drive(l, run.id);

    const blocked = runState(l, run.id);
    expect(blocked.state).toBe('BLOCKED');
    expect(blocked.resumeState).toBe('REVIEWING');
    expect(blocked.outcomeReason).toMatch(/no independent reviewer is usable; review\.when_unavailable is ask/);
    expect(blocked.outcomeReason).toMatch(/orbit decide/);
    // Not a frozen-policy block: a person's answer clears it, so orbit resume must not be refused.
    expect(blocked.outcomeJson ?? '').not.toContain('frozen_policy');
    expect(listReviews(l.db(), run.id)).toEqual([]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    const [q] = listQuestions(l.db(), run.id, { status: 'open' });
    expect(q).toMatchObject({ material: true });
    expect(q!.question).toMatch(/no independent reviewer is usable: allow a same-provider review for this run\?/i);
    expect(q!.options.map((o) => o.label)).toEqual(['yes', 'no']);
    expect(q!.evidence.join(' ')).toMatch(/data_policy_eligible is not true/);

    // A model identity cannot answer it.
    let refused = false;
    try {
      answerQuestion(l.db(), runDir(l, run.id), q!.id, 'yes', 'reviewer', systemClock);
    } catch (err) {
      refused = isOrbitError(err, 'POLICY_DENIED');
    }
    expect(refused).toBe(true);

    answerQuestion(l.db(), runDir(l, run.id), q!.id, 'yes', 'acme-dev', systemClock);
    resume(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listReviews(l.db(), run.id).every((r) => r.provider === 'claude')).toBe(true);
    const [approved] = listDecisions(l.db(), run.id, { kind: 'review.same-provider-approved' });
    expect(approved?.data).toMatchObject({ question_id: q!.id, approved_by: 'acme-dev' });
    expect(readText(join(runDir(l, run.id), 'final.md'))).toMatch(/NOT independent: no independent reviewer was usable: .*approved by acme-dev/);
  }, 120_000);

  it('ask: a no keeps the run blocked without any review', async () => {
    const l = lab('ask');
    const run = startLabRun(l);
    await drive(l, run.id);
    const [q] = listQuestions(l.db(), run.id, { status: 'open' });
    answerQuestion(l.db(), runDir(l, run.id), q!.id, 'no', 'acme-dev', systemClock);
    resume(l, run.id);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/acme-dev declined a same-provider review/);
    expect(listReviews(l.db(), run.id)).toEqual([]);
  }, 120_000);

  it('block: the run blocks before any work, naming why the independent reviewer is unusable', async () => {
    const l = lab('block');
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/independent review is required \(review\.when_unavailable: block\)/);
    expect(done.outcomeReason).toMatch(/providers\.codex\.data_policy_eligible is not true/);
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
    expect(listReviews(l.db(), run.id)).toEqual([]);
  }, 120_000);
});
