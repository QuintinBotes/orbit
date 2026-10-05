// Review findings drive a repair loop (spec sections 12 and 14), pinned by tests that failed before it:
// a REPAIR_REQUIRED review with a blocking finding goes REVIEWING -> REPAIRING with a repair brief, the
// repaired tree is verified and reviewed again, and the finding is closed only by the passing test written
// for it; the review_rounds cap ends the run EXHAUSTED with the open findings; a finding about financial
// semantics goes to the Inquisition instead of being repaired on a guess.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { listFindings, listReviews } from '../../../src/review/store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { APPROVE, baseScenario, IMPLEMENTER_OUTPUT, implementMul, labDeps, makeLab, MUL_TEST, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

async function drive(l: Lab, runId: string): Promise<void> {
  const c = new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 });
  await c.start();
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

const FINDING = {
  id: 'COR-1',
  severity: 'high',
  category: 'correctness',
  location: 'apps/calc.mjs:2',
  claim: 'mul accepts non-numeric arguments and returns NaN instead of throwing a TypeError.',
  evidence: 'mul("a", 2) evaluates "a" * 2, which is NaN; nothing checks the argument types.',
  suggested_validation: 'Add a test asserting that mul("a", 2) throws a TypeError.',
};
const REPAIR_REQUIRED = { structured: { verdict: 'REPAIR_REQUIRED', candidate_revision: '$CANDIDATE', findings: [FINDING] } };

const INPUT_TEST = "import { mul } from '../apps/calc.mjs';\nlet threw = false;\ntry { mul('a', 2); } catch (e) { threw = e instanceof TypeError; }\nif (!threw) { console.error('mul(\"a\", 2) must throw a TypeError'); process.exit(1); }\n";

/** The repair: mul checks its arguments, and the validation test is written and named for the finding. */
const REPAIR = {
  edits: [
    { op: 'write', path: 'apps/calc.mjs', content: "export const add = (a, b) => a + b;\nexport const mul = (a, b) => {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('mul takes numbers');\n  return a * b;\n};\n" },
    { op: 'write', path: 'tests/mul.test.mjs', content: MUL_TEST },
    { op: 'write', path: 'tests/mul-input.test.mjs', content: INPUT_TEST },
  ],
  structured: {
    ...IMPLEMENTER_OUTPUT,
    summary: 'mul rejects non-numeric arguments; validation test added',
    changed_paths: [...IMPLEMENTER_OUTPUT.changed_paths, { path: 'tests/mul-input.test.mjs', change: 'add', purpose: 'validation for COR-1' }],
    evidence_refs: [{ criterion_id: null, ref: 'tests/mul-input.test.mjs', note: 'validation for finding COR-1' }],
  },
};

describe.skipIf(!canStripTypes)('controller: the review repair loop', () => {
  it('a REPAIR_REQUIRED review with a blocking finding is repaired, verified and reviewed again, and the finding closed by its passing test', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*'), REPAIR], reviewer: [REPAIR_REQUIRED, APPROVE] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const path = transitions(l, run.id);
    const firstReview = path.indexOf('REVIEWING');
    expect(path.slice(firstReview, firstReview + 5)).toEqual(['REVIEWING', 'REPAIRING', 'VERIFYING', 'REVIEWING', 'DELIVERING']);
    expect(path).not.toContain('INQUISITION');
    expect(path).not.toContain('BLOCKED');

    // The brief is the spec section 14 shape, built from the finding.
    const stored = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'briefs', 'attempt-2.json'), 'utf8')) as { source: string; fingerprint: string; brief: { fingerprint: string; hypotheses: { statement: string }[]; experiment: string; post_fix_checks: string[]; preserved_constraints: string[] } };
    const [finding] = listFindings(l.db(), run.id);
    expect(stored.source).toBe('review');
    expect(stored.brief.fingerprint).toBe((finding!.resolutionJson as { fingerprint: string }).fingerprint);
    expect(stored.brief.hypotheses[0]!.statement).toBe(FINDING.claim);
    expect(stored.brief.experiment).toMatch(/test that fails on the current candidate.*mul\("a", 2\) throws a TypeError/);
    expect(stored.brief.post_fix_checks).toEqual(['unit']);
    expect(stored.brief.preserved_constraints.join('\n')).toMatch(/Do not weaken/);

    // Closed by the passing validation test on the repaired tree, not by the second reviewer's approval.
    expect(finding).toMatchObject({ externalId: 'COR-1', status: 'resolved' });
    expect(finding!.resolution).toMatch(/tests\/mul-input\.test\.mjs/);
    const reviews = listReviews(l.db(), run.id, { includeInvalidated: true });
    expect(reviews.map((r) => r.verdict)).toEqual(['REPAIR_REQUIRED', 'APPROVE']);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(2);
    const report = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', run.id, 'final.json'), 'utf8')) as { budget: { counters: { counter: string; used: number }[] } };
    expect(report.budget.counters.find((c) => c.counter === 'review_rounds')?.used).toBe(2);
  }, 120_000);

  it('a finding the repair did not cover stays open and the run ends EXHAUSTED at the review_rounds cap, naming the open finding', async () => {
    const l = lab({ tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 2) });
    // The second attempt changes something, but names no test for the finding, so nothing closes it.
    writeScenario(l, baseScenario({ implementer: [implementMul('*'), implementMul('*', [{ op: 'write', path: 'tests/extra.test.mjs', content: '// unrelated\n' }])], reviewer: [REPAIR_REQUIRED, REPAIR_REQUIRED] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/review_rounds hard cap reached \(2 of 2\).*COR-1/);
    const outcome = JSON.parse(done.outcomeJson!) as { open_findings: { external_id: string; status: string }[] };
    expect(outcome.open_findings.map((f) => f.external_id)).toContain('COR-1');
    expect(listFindings(l.db(), run.id).every((f) => f.status !== 'rejected' && f.status !== 'resolved')).toBe(true);
    expect(transitions(l, run.id).filter((s) => s === 'REPAIRING')).toHaveLength(1);
  }, 120_000);

  it('a blocking finding about financial semantics goes to the Inquisition before any repair', async () => {
    const l = lab();
    const billing = { ...FINDING, id: 'COR-2', claim: 'mul is used to compute invoice charges and rounds refunds the wrong way.', evidence: 'refund amounts lose cents', suggested_validation: 'Add a test for refund rounding.' };
    writeScenario(l, baseScenario({ implementer: [implementMul('*')], reviewer: [{ structured: { verdict: 'REPAIR_REQUIRED', candidate_revision: '$CANDIDATE', findings: [billing] } }] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const path = transitions(l, run.id);
    const firstReview = path.indexOf('REVIEWING');
    // Nothing is repaired before the Inquisition has looked at it; what it settles may then be repaired.
    expect(path[firstReview + 1], path.join(' ')).toBe('INQUISITION');
    expect(path.indexOf('REPAIRING') === -1 || path.indexOf('REPAIRING') > firstReview + 1).toBe(true);
    const entered = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION'", run.id)!;
    expect((JSON.parse(entered.data_json) as { data: { trigger: { kind: string; summary: string } } }).data.trigger).toMatchObject({ kind: 'hidden_decision', summary: expect.stringMatching(/financial/) });
  }, 120_000);
});
