// One fresh review of a tree a review asked to repair only through notes (ADR 0014, 0.3.1 addendum, item 3), end to end
// through the controller with the fake adapters and the lab's real check.
//
// The .NET stall of the 0.3.0 retest (orb-20261013-083016-84a30d): Claude reviewed Claude's work (Codex was not eligible,
// review.when_unavailable: claude) and returned REPAIR_REQUIRED with one high finding, TEST-1, "the fail-before evidence
// shows only a load failure", plus two info findings. The finding disputes the outcome Orbit recorded for the base
// revision, which no repair can change, so it is a note. Item 3 then ended the run BLOCKED, and resume came back to the
// same BLOCKED. Now the tree gets exactly one fresh review, told the outcome is not a finding: its APPROVE lets the run
// succeed, anything else ends it BLOCKED naming the findings, and with no review round left none starts.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { newRunNeeded, resumeTarget } from '../../../src/controller/resume.ts';
import { acquireLease, getRun, releaseLease, transition } from '../../../src/controller/run-store.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { listReviews } from '../../../src/review/store.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { appendEvent } from '../../../src/storage/events.ts';
import { APPROVE, baseScenario, IMPLEMENTER_OUTPUT, implementMul, labDeps, makeLab, MUL_TEST, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

/** Claude reviews Claude's work in a separate session, as in the .NET runs: Codex is not eligible. */
function lab(tweak?: (c: OrbitConfig) => void): Lab {
  const l = makeLab({
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: false };
      c.review.when_unavailable = 'claude';
      tweak?.(c);
    },
  });
  labs.push(l);
  return l;
}

async function drive(l: Lab, runId: string): Promise<void> {
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

/** What `orbit resume` does: the CLI records run.resumed and moves the run to its resume target. */
function resume(l: Lab, runId: string): void {
  acquireLease(l.db(), runId, 'person-resume', 60_000, systemClock);
  const target = resumeTarget(l.db(), getRun(l.db(), runId));
  l.db().tx(() => appendEvent(l.db(), runId, 'run.resumed', 'acme-dev', { from: 'BLOCKED', to: target, forced: false }, systemClock.now()));
  transition(l.db(), { runId, to: target, ownerId: 'person-resume', reason: 'resumed', actor: 'acme-dev', expectedFrom: 'BLOCKED' }, systemClock);
  releaseLease(l.db(), runId, 'person-resume');
}

/** The next_action of the run's final report, as `orbit report` and final.json give it. */
function nextAction(l: Lab, runId: string): string {
  const p = join(l.repo, '.orbit', 'runs', runId, 'final.json');
  expect(existsSync(p)).toBe(true);
  return (JSON.parse(readFileSync(p, 'utf8')) as { next_action: string }).next_action;
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

function reviewerPurposes(l: Lab, runId: string): string[] {
  return l.db().all<{ purpose: string }>("SELECT purpose FROM workers WHERE run_id = ? AND role = 'reviewer' ORDER BY created_at, rowid", runId).map((w) => w.purpose.replace(/:cand-[0-9a-f]+#/, ':cand#'));
}

/**
 * The .NET run's findings, told of the calculator: TEST-1 disputes the recorded outcome, filed under the category
 * evidence-classification as the reviewer brief now asks; the info findings are remarks.
 */
const TEST_1 = {
  id: 'TEST-1',
  severity: 'high',
  category: 'evidence-classification',
  location: 'tests/mul.test.mjs:1',
  claim: 'The fail-before evidence for AC-1 shows only a load failure. It does not show that any assertion about the criterion failed. The new test depends on mul existing, but the probe does not prove that it checks its behavior.',
  evidence: "In the fail-before log the only error is SyntaxError: The requested module '../apps/calc.mjs' does not provide an export named 'mul'. No assertion ran on the base revision.",
  suggested_validation: 'Rerun the fail-before probe on the base revision with a stub mul that loads but behaves wrongly.',
};
const COR_1 = { id: 'COR-1', severity: 'info', category: 'correctness', location: 'apps/calc.mjs:2', claim: 'Reading the code, the implementation appears to meet AC-1.', evidence: 'calc.mjs:2 multiplies its arguments.', suggested_validation: null };
const PRAC_1 = { id: 'PRAC-1', severity: 'info', category: 'scope', location: null, claim: 'The justifications for the omitted practices are sound for a pure two-argument function.', evidence: 'calc.mjs has no I/O.', suggested_validation: null };

const review = (verdict: string, findings: object[]) => ({ structured: { verdict, candidate_revision: '$CANDIDATE', findings } });
const STALL = review('REPAIR_REQUIRED', [TEST_1, COR_1, PRAC_1]);

describe.skipIf(!canStripTypes)('one fresh review of a tree a review asked to repair only through notes', () => {
  it('the .NET stall shape: one fresh review, and its approval lets the run succeed', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul()], reviewer: [STALL, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(reviewerPurposes(l, run.id)).toEqual(['review:cand#1', 'review-fresh:cand#1']);
    expect(listDecisions(l.db(), run.id, { kind: 'review.fresh' })).toHaveLength(1);
    expect(transitions(l, run.id)).not.toContain('REPAIRING');
    expect(transitions(l, run.id)).not.toContain('INQUISITION');
    // The approval on the delivered tree is the fresh reviewer's; the first review is kept, superseded.
    const reviews = listReviews(l.db(), run.id, { includeInvalidated: true });
    expect(reviews.map((r) => [r.verdict, r.invalidatedAt === null])).toEqual([
      ['REPAIR_REQUIRED', false],
      ['APPROVE', true],
    ]);
    expect(listDecisions(l.db(), run.id, { kind: 'review.finding.noted' }).map((d) => d.summary)).toEqual([expect.stringMatching(/^TEST-1 \(high\) noted: /)]);
  });

  it('a fresh review that disputes the outcome again ends the run BLOCKED naming it, and resuming starts no second one', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul()], reviewer: [STALL, review('REPAIR_REQUIRED', [TEST_1]), APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    let done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/the one fresh review of this tree \([^)]*REPAIR_REQUIRED\)[^;]*did not approve it either: TEST-1 \(high, a note\)/);
    expect(reviewerPurposes(l, run.id)).toEqual(['review:cand#1', 'review-fresh:cand#1']);
    expect(transitions(l, run.id)).not.toContain('REPAIRING');
    // A resume comes back to this BLOCKED, so nothing tells the person to resume.
    expect(newRunNeeded(l.db(), done)).toBe('the tree had its one fresh review, and a resume starts no other');
    expect(nextAction(l, run.id)).toMatch(/Resuming would only block again \(the tree had its one fresh review, and a resume starts no other\): cancel this run \(orbit cancel orb-\S+\) and start a new run with orbit run\.$/);
    expect(nextAction(l, run.id)).not.toMatch(/Resolve that, then run/);

    resume(l, run.id);
    await drive(l, run.id);
    done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(reviewerPurposes(l, run.id)).toEqual(['review:cand#1', 'review-fresh:cand#1']);
  });

  it('a fresh review that reports a real defect of the candidate sends it to repair like any review, not to BLOCKED', async () => {
    // A defect of the candidate (not a dispute of the recorded outcome): the fresh review is an ordinary review, so the
    // defect is repaired, verified and reviewed again (the same shape as review-repair.test.ts).
    const DEFECT = { id: 'COR-2', severity: 'high', category: 'correctness', location: 'apps/calc.mjs:2', claim: 'mul accepts non-numeric arguments and returns NaN instead of throwing a TypeError.', evidence: 'mul("a", 2) evaluates "a" * 2, which is NaN.', suggested_validation: 'Add a test asserting that mul("a", 2) throws a TypeError.' };
    const INPUT_TEST = "import { mul } from '../apps/calc.mjs';\nlet threw = false;\ntry { mul('a', 2); } catch (e) { threw = e instanceof TypeError; }\nif (!threw) process.exit(1);\n";
    const REPAIR = {
      edits: [
        { op: 'write', path: 'apps/calc.mjs', content: "export const add = (a, b) => a + b;\nexport const mul = (a, b) => {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('mul takes numbers');\n  return a * b;\n};\n" },
        { op: 'write', path: 'tests/mul.test.mjs', content: MUL_TEST },
        { op: 'write', path: 'tests/mul-input.test.mjs', content: INPUT_TEST },
      ],
      structured: {
        ...IMPLEMENTER_OUTPUT,
        summary: 'mul rejects non-numeric arguments; validation test added',
        changed_paths: [...IMPLEMENTER_OUTPUT.changed_paths, { path: 'tests/mul-input.test.mjs', change: 'add', purpose: 'validation for COR-2' }],
        evidence_refs: [{ criterion_id: null, ref: 'tests/mul-input.test.mjs', note: 'validation for finding COR-2' }],
      },
    };
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul(), REPAIR], reviewer: [STALL, review('REPAIR_REQUIRED', [DEFECT]), APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listDecisions(l.db(), run.id, { kind: 'review.fresh' })).toHaveLength(1);
    expect(transitions(l, run.id)).toContain('REPAIRING');
    expect(reviewerPurposes(l, run.id).filter((p) => p.startsWith('review-fresh'))).toEqual(['review-fresh:cand#1']);
  });

  it('with no review round left, no fresh review starts and the run ends BLOCKED naming the note', async () => {
    const l = lab((c) => {
      c.scheduler.hard_limits.review_rounds = 1;
    });
    writeScenario(l, baseScenario({ implementer: [implementMul()], reviewer: [STALL, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/TEST-1 \(high\)/);
    expect(done.outcomeReason).toMatch(/no fresh review of the tree was started: review_rounds hard cap reached \(1 of 1\)/);
    expect(reviewerPurposes(l, run.id)).toEqual(['review:cand#1']);
    expect(listDecisions(l.db(), run.id, { kind: 'review.fresh' })).toEqual([]);
    // The cap is the run's frozen policy: a resume blocks again, so the report says to start a new run.
    expect(newRunNeeded(l.db(), done)).toBe('review_rounds is at its hard cap, so a resume starts no fresh review of the tree');
    expect(nextAction(l, run.id)).toMatch(/Resuming would only block again \(review_rounds is at its hard cap[^)]*\): cancel this run/);
    expect(nextAction(l, run.id)).not.toMatch(/Resolve that, then run/);
  });
});
