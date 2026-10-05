// Fault: exhausted budgets (spec sections 7, 14 and 17: "Budget exhaustion: stop workers; preserve
// artifacts; report"). Hard caps come from the frozen policy; the run ends EXHAUSTED with its
// worktree, candidate, evidence and final report intact.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listActiveWorkers, listWorkers } from '../../src/storage/workers.ts';
import { listCandidates, listEvidenceReports } from '../../src/evidence/store.ts';
import { baseScenario, calls, canStripTypes, DIAGNOSIS, drive, git, implementMul, runState, startLabRun, tracker, writeScenario } from './helpers.ts';

const t = tracker();
afterEach(() => t.cleanup());

function expectPreserved(l: ReturnType<typeof t.lab>, runId: string, opts: { candidate: boolean }): void {
  const done = runState(l, runId);
  const runDir = join(l.repo, '.orbit', 'runs', runId);
  expect(listActiveWorkers(l.db(), runId)).toEqual([]);
  expect(existsSync(join(done.worktreePath!, 'tests', 'mul.test.mjs'))).toBe(true);
  if (opts.candidate) {
    const [cand] = listCandidates(l.db(), runId);
    expect(git(l.repo, 'rev-parse', `${cand!.commitSha}^{tree}`)).toBe(cand!.treeHash);
  }
  // Every worker's transcript stays with the run.
  for (const w of listWorkers(l.db(), { runId })) expect(existsSync(join(w.workerDir, 'log.jsonl'))).toBe(true);
  expect(readFileSync(join(runDir, 'final.md'), 'utf8')).toMatch(/EXHAUSTED/);
  const report = JSON.parse(readFileSync(join(runDir, 'final.json'), 'utf8')) as { outcome: string };
  expect(report.outcome).toBe('EXHAUSTED');
  expect(existsSync(join(runDir, 'policy.json'))).toBe(true);
}

describe.skipIf(!canStripTypes)('fault: exhausted budgets', () => {
  it('the implementation attempt cap ends the run EXHAUSTED with the failing evidence and the worktree preserved', async () => {
    const l = t.lab({ tweak: (c) => void (c.scheduler.hard_limits.implementation_attempts = 1) });
    writeScenario(l, baseScenario({ implementer: [implementMul('+')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/hard cap/);
    expect(calls(l, 'implementer')).toHaveLength(1);
    const [ev] = listEvidenceReports(l.db(), run.id);
    expect(ev?.verdict).toBe('FAIL');
    expect(existsSync(ev!.reportPath!)).toBe(true);
    expectPreserved(l, run.id, { candidate: true });
  }, 30_000);

  it('a model cost cap reached by reported spend ends the run EXHAUSTED before any further worker starts', async () => {
    const l = t.lab({ tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 12) });
    writeScenario(l, baseScenario({ implementer: [{ ...implementMul('+'), usage: { costUSD: 11.5 } }, implementMul('*')], verifier: [DIAGNOSIS] }));
    const run = startLabRun(l);
    await drive(l, run.id);

    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('EXHAUSTED');
    expect(done.outcomeReason).toMatch(/cost/);
    // Nothing more was started once the cap was reached.
    expect(calls(l, 'implementer')).toHaveLength(1);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' })).toEqual([]);
    // The spend was charged when the implementer finished, before its edits became a candidate; the edits stay in the worktree.
    expectPreserved(l, run.id, { candidate: false });
  }, 30_000);
});
