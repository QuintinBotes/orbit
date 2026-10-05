import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { listReviews } from '../../../src/review/store.ts';
import { baseScenario, DIAGNOSIS, git, implementMul, makeLab, PLANNER_OUTPUT, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

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
  const { labDeps } = await import('./harness.ts');
  const c = new Controller({ mode: 'foreground', runId, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 });
  await c.start();
}

function runDir(l: Lab, runId: string): string {
  return join(l.repo, '.orbit', 'runs', runId);
}

describe.skipIf(!canStripTypes)('controller: complete runs with fake providers', () => {
  it('scenario 1: a scoped feature passes with behaviour tests and is left on a local branch', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    // Evidence and review bind the same tree, and the local branch carries exactly that tree.
    const [ev] = listEvidenceReports(l.db(), run.id);
    expect(ev?.verdict).toBe('PASS');
    const reviews = listReviews(l.db(), run.id);
    expect(reviews.map((r) => [r.provider, r.verdict])).toEqual([['codex', 'APPROVE']]);
    expect(reviews[0]!.treeHash).toBe(ev!.treeHash);
    expect(git(l.repo, 'rev-parse', `orbit/${run.id}^{tree}`)).toBe(ev!.treeHash);
    // No external action in autonomous mode; the user's checkout is untouched.
    expect(readFileSync(join(l.repo, 'apps/calc.mjs'), 'utf8')).not.toContain('mul');
    const report = JSON.parse(readFileSync(join(runDir(l, run.id), 'final.json'), 'utf8')) as { outcome: string; criteria: { id: string; status: string }[]; budget: { counters: { counter: string; used: number }[] } };
    expect(report.outcome).toBe('SUCCEEDED');
    expect(report.criteria).toEqual([expect.objectContaining({ id: 'AC-1', status: 'supported' })]);
    expect(report.budget.counters.find((c) => c.counter === 'implementation_attempts')?.used).toBe(1);
    expect(readFileSync(join(runDir(l, run.id), 'final.md'), 'utf8')).toContain('## Budget consumption');
    const kinds = listDecisions(l.db(), run.id).map((d) => d.kind);
    expect(kinds).toEqual(expect.arrayContaining(['route', 'planning.difficulty', 'gate.environment', 'gate.static_security', 'review.select', 'gate.delivery', 'gate.completion']));
    // The delivery gate is recorded before the completion gate (spec section 5 order).
    expect(kinds.indexOf('gate.delivery')).toBeLessThan(kinds.indexOf('gate.completion'));
    const security = listDecisions(l.db(), run.id, { kind: 'gate.static_security' })[0]!;
    expect(security.summary).toMatch(/unverified/);
  });

  it('scenario 2: a failing check is diagnosed and repaired in a second attempt', async () => {
    // Learning on: the repaired failure is something to learn from, and the curator runs at the end.
    const l = lab({ tweak: (c) => void (c.knowledge = { ...c.knowledge, enabled: true }) });
    writeScenario(l, baseScenario({ implementer: [implementMul('+'), implementMul('*')], verifier: [DIAGNOSIS], curator: [{ structured: { lessons: [], discarded: [] } }] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const reports = listEvidenceReports(l.db(), run.id);
    expect(reports.map((r) => r.verdict)).toEqual(['FAIL', 'PASS']);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(listWorkers(l.db(), { runId: run.id, role: 'verifier' })).toHaveLength(1);
    expect(existsSync(join(runDir(l, run.id), 'briefs', 'attempt-2.json'))).toBe(true);
    expect(listDecisions(l.db(), run.id).map((d) => d.kind)).toEqual(expect.arrayContaining(['repair.brief', 'repair.hypothesis']));
    const learning = JSON.parse(readFileSync(join(runDir(l, run.id), 'learning.json'), 'utf8')) as { learn: { observations: number } | null; skipped: string | null; settled: unknown };
    expect(learning.skipped).toBeNull();
    expect(learning.learn?.observations).toBeGreaterThan(0);
    expect(learning.settled).not.toBeNull();
  });

  it('scenario 9: a protected-path edit by the implementer is rejected by scope inspection', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: '.github/workflows/ci.yml', content: 'on: push\n' }])] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toMatch(/policy violation.*\.github\/workflows\/ci\.yml/);
    expect(listReviews(l.db(), run.id)).toEqual([]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    expect(listDecisions(l.db(), run.id, { kind: 'policy.deny' })).toHaveLength(1);
    expect(git(l.repo, 'branch', '--list', `orbit/${run.id}`)).toBe('');
  });

  it('scenario 4: a material question the planner cannot settle goes to the Inquisition and blocks unattended work', async () => {
    const l = lab();
    const planner = { ...PLANNER_OUTPUT, unresolved_decisions: [{ question: 'Should mul round fractional results or keep full precision?', options: ['round', 'keep'], recommendation: null, material: true, affected_criteria: ['mul'] }] };
    writeScenario(l, baseScenario({ planner: [{ structured: planner }], implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.resumeState).toBe('CONTRACTING');
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toEqual([]);
    const transitions = l.db().all<{ to_state: string }>("SELECT to_state FROM events WHERE run_id = ? AND type = 'state.transition'", run.id).map((r) => r.to_state);
    expect(transitions).toEqual(['PREFLIGHT', 'CONTRACTING', 'INQUISITION', 'BLOCKED']);
    expect(JSON.parse(done.contractJson!).assumptions).toEqual([expect.objectContaining({ status: 'needs-decision' })]);
  });

  it('stops EXHAUSTED when the attempt budget is spent, preserving the worktree and evidence', async () => {
    const l = lab({ tweak: (c) => void (c.scheduler.hard_limits.implementation_attempts = 1) });
    writeScenario(l, baseScenario({ implementer: [implementMul('+')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state).toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/hard cap/);
    // Nothing more was spent on a diagnosis that no attempt could use.
    expect(listWorkers(l.db(), { runId: run.id, role: 'verifier' })).toEqual([]);
    expect(existsSync(join(done.worktreePath!, 'tests', 'mul.test.mjs'))).toBe(true);
    const [ev] = listEvidenceReports(l.db(), run.id);
    expect(ev?.verdict).toBe('FAIL');
    expect(existsSync(ev!.reportPath!)).toBe(true);
    expect(readFileSync(join(runDir(l, run.id), 'final.md'), 'utf8')).toMatch(/EXHAUSTED[\s\S]*worktree and evidence are preserved/);
  });
});
