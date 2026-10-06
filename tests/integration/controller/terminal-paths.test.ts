// Terminal paths and budget decisions that had code but no test (docs/gaps.md G10 and G44): a dirty start is
// refused unless the policy allows it, a diagnosis that rules out every hypothesis ends IMPOSSIBLE (exit 12),
// a mandatory check that cannot run blocks with the reason, and a localized fault with a new hypothesis earns
// one more attempt through a recorded allowance extension.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { exitCodeForState } from '../../../src/cli/exit.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

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
  await new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
}

function transitions(l: Lab, runId: string): string[] {
  return l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition' ORDER BY id", runId).map((r) => r.to_state);
}

function finalReport(l: Lab, runId: string): string {
  return readFileSync(join(l.repo, '.orbit', 'runs', runId, 'final.md'), 'utf8');
}

/** A diagnosis whose every competing hypothesis was ruled out by evidence: nothing authorized is left to try. */
const ALL_RULED_OUT = (() => {
  const d = structuredClone(DIAGNOSIS) as { structured: { competing_hypotheses: { status: string; refuting_evidence: string[] }[]; confidence: string } };
  for (const h of d.structured.competing_hypotheses) {
    h.status = 'ruled-out';
    h.refuting_evidence = ['the experiment recorded for it showed the opposite of what it predicts'];
  }
  d.structured.confidence = 'low';
  return d;
})();

describe.skipIf(!canStripTypes)('controller: terminal paths', () => {
  it('a dirty start is refused by default, naming the uncommitted path, and nothing is spent', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    writeFileSync(join(l.repo, 'apps/notes.txt'), 'uncommitted work in progress\n');
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toContain('apps/notes.txt');
    expect(done.outcomeReason).toMatch(/uncommitted changes.*allow_dirty_start/);
    expect(transitions(l, run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
    expect(exitCodeForState(done.state)).toBe(10);
  }, 60_000);

  it('with repository.allow_dirty_start the run proceeds from HEAD, records the decision, and leaves the uncommitted file alone', async () => {
    const l = lab({ tweak: (c) => void (c.repository.allow_dirty_start = true) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    writeFileSync(join(l.repo, 'apps/notes.txt'), 'uncommitted work in progress\n');
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [dirty] = listDecisions(l.db(), run.id, { kind: 'preflight.dirty-start' });
    expect(dirty?.data).toMatchObject({ paths: ['apps/notes.txt'] });
    expect(readFileSync(join(l.repo, 'apps/notes.txt'), 'utf8')).toBe('uncommitted work in progress\n');
  }, 60_000);

  it('a diagnosis that rules out every hypothesis ends IMPOSSIBLE with the hypotheses, a final report and exit code 12', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('+'), implementMul('*')], verifier: [ALL_RULED_OUT] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('IMPOSSIBLE');
    expect(done.outcomeReason).toMatch(/every hypothesis for .* was ruled out by evidence and no authorized experiment remains/);
    const outcome = JSON.parse(done.outcomeJson!) as { hypotheses: string[] };
    expect(outcome.hypotheses).toEqual(['mul adds its arguments instead of multiplying them', 'the test runner imports a stale copy of calc.mjs']);
    // No repair was started on a diagnosis that has nothing left standing.
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(transitions(l, run.id).slice(-2)).toEqual(['DIAGNOSING', 'IMPOSSIBLE']);
    expect(finalReport(l, run.id)).toMatch(/IMPOSSIBLE/);
    expect(exitCodeForState(done.state)).toBe(12);
  }, 60_000);

  it('a mandatory check that cannot start leaves verification incomplete, and the run blocks as an environment failure, naming the cause', async () => {
    const l = lab({ tweak: (c) => void (c.checks.unit = { ...c.checks.unit!, command: ['/nonexistent/acme/bin/run-tests'] }) });
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    // A check that could not execute at all is the environment's (or the check definition's), not a defect in the change.
    expect(done.outcomeReason).toMatch(/^Check unit could not execute on candidate 1, and the output shows an environment cause/);
    expect(done.outcomeReason).toMatch(/the check could not be started/);
    expect(done.outcomeReason).toMatch(/\. No repair attempt was spent/);
    const [report] = listEvidenceReports(l.db(), run.id);
    expect(report?.verdict).toBe('INCOMPLETE');
    expect(report?.report.checks.find((c) => c.id === 'unit')?.status).toBe('ERROR');
    expect(transitions(l, run.id)).not.toContain('REVIEWING');
    expect(transitions(l, run.id)).not.toContain('INQUISITION');
    expect(transitions(l, run.id)).not.toContain('DIAGNOSING');
  }, 60_000);

  it('attempt 1 fails, the diagnosis localizes the fault with a new hypothesis, and the allowance is extended by one with a recorded decision', async () => {
    const l = lab({ tweak: (c) => void (c.scheduler.initial_allowances = { simple_attempts: 1, medium_attempts: 1, complex_attempts: 1 }) });
    writeScenario(l, baseScenario({ implementer: [implementMul('+'), implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [localized] = listDecisions(l.db(), run.id, { kind: 'repair.localized' });
    expect(localized?.data).toMatchObject({ attempt: 1, location: expect.stringMatching(/^apps\/calc\.mjs: mul adds its arguments/) });
    const [ext] = listDecisions(l.db(), run.id, { kind: 'allowance.extend' });
    expect(ext, JSON.stringify(listDecisions(l.db(), run.id, { kind: 'allowance.deny' }))).toBeDefined();
    const d = ext!.data as { counter: string; previous_allowance: number; new_allowance: number; hypothesis_is_new: boolean; progress: { localized_fault: string | null } };
    expect(d.counter).toBe('implementation_attempts');
    expect(d.new_allowance).toBe(d.previous_allowance + 1);
    expect(d.previous_allowance).toBe(1);
    expect(d.hypothesis_is_new).toBe(true);
    expect(d.progress.localized_fault).toMatch(/^apps\/calc\.mjs/);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(2);
  }, 60_000);
});
