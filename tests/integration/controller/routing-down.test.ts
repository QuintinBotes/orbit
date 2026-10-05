// Routing back down once the hard diagnosis is solved (spec section 8; docs/gaps.md G12): the attempt after a
// failure escalates with recorded evidence, that escalated attempt fixes the fault, and the routine follow-up
// (a review repair) routes back to the starting tier with the escalated route recorded as superseded.
import { afterEach, describe, expect, it } from 'vitest';
import { Controller } from '../../../src/controller/loop.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { APPROVE, baseScenario, DIAGNOSIS, IMPLEMENTER_OUTPUT, implementMul, labDeps, makeLab, MUL_TEST, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

interface RouteData {
  purpose: string;
  model: string;
  family: string;
  escalated_from?: { model: string };
  down_routed_from?: { model: string };
  reason: string;
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
const REVIEW_REPAIR = {
  edits: [
    { op: 'write', path: 'apps/calc.mjs', content: "export const add = (a, b) => a + b;\nexport const mul = (a, b) => {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('mul takes numbers');\n  return a * b;\n};\n" },
    { op: 'write', path: 'tests/mul.test.mjs', content: MUL_TEST },
    { op: 'write', path: 'tests/mul-input.test.mjs', content: INPUT_TEST },
  ],
  structured: { ...IMPLEMENTER_OUTPUT, evidence_refs: [{ criterion_id: null, ref: 'tests/mul-input.test.mjs', note: 'validation for finding COR-1' }] },
};

describe.skipIf(!canStripTypes)('controller: routing back down after a solved diagnosis', () => {
  it('the escalated attempt fixes the fault, and the routine follow-up routes back to the starting tier with the superseded route recorded', async () => {
    // At threshold 1 one failure is the repeated equivalent failure that justifies escalation.
    const l = makeLab({ tweak: (c) => void (c.scheduler.repeated_failure_threshold = 1) });
    labs.push(l);
    writeScenario(
      l,
      baseScenario({
        implementer: [implementMul('+'), implementMul('*'), REVIEW_REPAIR],
        verifier: [DIAGNOSIS],
        reviewer: [REPAIR_REQUIRED, APPROVE],
        inquisitor: [{ structured: { mode: 'diagnose', summary: 'nothing to add', facts: [], assumptions: [], unknowns: [], interpretations: [], questions: [], decisions: [], experiments: [], amendments: [], blocked_criteria: [], continuing_criteria: [] } }],
      }),
    );
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const routes = new Map(listDecisions(l.db(), run.id, { kind: 'route' }).map((d) => [(d.data as RouteData).purpose, d.data as RouteData]));
    const first = routes.get('implement:1')!;
    const second = routes.get('implement:2')!;
    const third = routes.get('implement:3')!;
    expect(second.escalated_from?.model).toBe(first.model);
    expect(second.family).not.toBe(first.family);
    // Attempt 3 is review follow-up on a solved diagnosis: back at the starting tier, the escalated route superseded.
    expect(third.family).toBe(first.family);
    expect(third.escalated_from).toBeUndefined();
    expect(third.down_routed_from?.model).toBe(second.model);
    expect(third.reason).toMatch(/hard diagnosis is solved, so routine follow-up routes down/);
    const workers = listWorkers(l.db(), { runId: run.id, role: 'implementer' });
    expect(workers.map((w) => w.model)).toEqual([first.model, second.model, third.model]);
  }, 120_000);
});
