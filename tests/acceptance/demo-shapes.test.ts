/**
 * Spec section 2, "Demonstrate three unattended runs" with mock providers on
 * examples/demo-app and its own goals: a simple task on a low-cost route
 * (driven end to end by the real `orbit run --foreground` CLI as a child
 * process), and a difficult task with evidence-backed escalation. The third
 * run (a UI task that fails browser checks, repairs, passes independent
 * review and opens a draft PR) is scenario 17 in ui.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { listEvidenceReports, listFailures } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { DEMO_DIR, drive, git, makeLab, orbit, READY, seedRegistry, startLabRun, waitFor, writeScenario, type Lab } from './helpers/lab.ts';
import { assertRunInvariants } from './helpers/invariants.ts';
import { scenarioFor } from '../../scripts/demo/mock/scenarios.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(): Lab {
  const l = makeLab();
  labs.push(l);
  return l;
}
const goal = (name: string): string => readFileSync(join(DEMO_DIR, 'goals', `${name}.md`), 'utf8').trim();

interface RouteData {
  purpose: string;
  family: string;
  model: string;
  escalated_from?: { model: string };
  justification: { signals: { signal: string; evidence: string[] }[] };
}

describe.skipIf(!READY)('acceptance: the demo runs of spec section 2', () => {
  it('demo 1: a simple task runs unattended through `orbit run --foreground` on a low-cost route in one attempt and opens a draft PR', async () => {
    const l = lab();
    writeScenario(l, scenarioFor('simple'));
    // What `orbit doctor` records on a machine with the CLIs installed.
    seedRegistry(l.db());
    const child = orbit(l, ['run', '--goal', goal('simple'), '--foreground', '--policy', l.configPath]);
    const runId = await waitFor(() => /run (orb-\S+) started/.exec(child.output())?.[1], 60_000);
    // CI reports green on the delivered commit, as GitHub would.
    await waitFor(() => existsSync(join(l.runDir(runId), 'delivery.json')) || child.exitCode !== null, 180_000, 100);
    if (existsSync(join(l.runDir(runId), 'delivery.json'))) {
      const { commit } = JSON.parse(readFileSync(join(l.runDir(runId), 'delivery.json'), 'utf8')) as { commit: string };
      l.github().scriptCi(commit, [[{ name: 'ci', bucket: 'pass' }]]);
    }
    const code = await child.exited();
    expect(code, child.output().slice(-3000)).toBe(0);
    expect(child.output()).toContain(`run ${runId} ended SUCCEEDED`);

    const db = l.db();
    const run = db.get<{ state: string; difficulty: string; outcome_json: string }>('SELECT state, difficulty, outcome_json FROM runs WHERE id = ?', runId)!;
    expect(run.state).toBe('SUCCEEDED');
    expect(run.difficulty).toBe('simple');
    expect(JSON.parse(run.outcome_json)).toMatchObject({ ci: 'passed' });
    const impl = listDecisions(db, runId, { kind: 'route' }).map((d) => d.data as RouteData).find((r) => r.purpose === 'implement:1')!;
    expect(['haiku', 'sonnet']).toContain(impl.family);
    expect(impl.escalated_from).toBeUndefined();
    expect(listWorkers(db, { runId, role: 'implementer' })).toHaveLength(1);
    expect(listEvidenceReports(db, runId).map((e) => e.verdict)).toEqual(['PASS']);
    expect(listReviews(db, runId).map((r) => `${r.provider}:${r.verdict}`)).toEqual(['codex:APPROVE']);
    const gh = l.github().state;
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]).toMatchObject({ isDraft: true, headRefName: `orbit/${runId}` });
    expect(git(l.remote, 'show', `refs/heads/orbit/${runId}:src/server.ts`)).toContain('Page not found. Try /reports.');
    assertRunInvariants(l, runId);
  }, 300_000);

  it('demo 2: a difficult task fails its new tests, is diagnosed, escalates with recorded evidence, is repaired and opens a draft PR', async () => {
    const l = lab();
    writeScenario(l, scenarioFor('difficult'));
    const run = startLabRun(l, goal('difficult'));
    const done = await drive(l, run.id);

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const db = l.db();
    expect(listEvidenceReports(db, run.id).map((e) => e.verdict)).toEqual(['FAIL', 'PASS']);
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    expect(listDecisions(db, run.id, { kind: 'repair.brief' })).toHaveLength(1);
    // Every escalation is recorded with its observed difficulty: the coupled change the contract describes
    // (a task property the spec's routing table names), or failures backed by this run's failure records.
    const routes = listDecisions(db, run.id, { kind: 'route' }).map((d) => d.data as RouteData);
    const escalated = routes.filter((r) => r.escalated_from);
    expect(escalated.length).toBeGreaterThanOrEqual(1);
    const failures = new Set(listFailures(db, run.id).map((f) => `failure:${f.id}`));
    for (const r of escalated) {
      expect(r.justification.signals.length, r.purpose).toBeGreaterThan(0);
      for (const sig of r.justification.signals) {
        if (sig.signal === 'coupled-change') continue;
        expect(sig.evidence.length, `${r.purpose}: ${sig.signal}`).toBeGreaterThan(0);
        expect(sig.evidence.every((e) => failures.has(e)), `${r.purpose}: ${sig.signal}`).toBe(true);
      }
    }
    // The routine planner was not escalated.
    expect(routes.find((r) => r.purpose === 'plan')?.escalated_from).toBeUndefined();
    expect(listReviews(db, run.id).map((r) => `${r.provider}:${r.verdict}`)).toEqual(['codex:APPROVE']);
    const gh = l.github().state;
    expect(gh.prs).toHaveLength(1);
    expect(gh.prs[0]!.isDraft).toBe(true);
    const report = readFileSync(join(l.runDir(run.id), 'final.md'), 'utf8');
    expect(report).toMatch(/## Repairs\n\n- attempt 2: /);
    expect(report).toMatch(/escalated from/);
    assertRunInvariants(l, run.id);
  }, 300_000);
});
