/**
 * Spec section 2, "Demonstrate safe stops for unauthorized actions, stale
 * evidence, repeated non-progress, exhausted budgets, expired credentials,
 * and unavailable mandatory reviewers." Each stop is a terminal state (or,
 * for stale evidence, a refused action) with a truthful reason, nothing
 * unauthorized leaves the repository, and the artifacts a person needs are
 * kept. Repeated non-progress is scenario 6 (proof-and-progress.test.ts);
 * stale evidence is scenario 10 (policy-and-evidence.test.ts), where the
 * stale binding refuses the next external action and the run re-verifies.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { listWorkers } from '../../src/storage/workers.ts';
import { repoKey } from '../../src/controller/context.ts';
import { listEvidenceReports } from '../../src/evidence/store.ts';
import { listReviews } from '../../src/review/store.ts';
import { argvCalls, drive, git, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { GOAL, GOOD_IMPLEMENTATION, scenario } from './helpers/scenarios.ts';
import { assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

/** What every safe stop leaves behind: the frozen policy, the run directory and a report that names the stop. */
function assertPreserved(l: Lab, runId: string, state: string, reason: RegExp): string {
  const run = l.db().get<{ state: string; outcome_reason: string; policy_path: string }>('SELECT state, outcome_reason, policy_path FROM runs WHERE id = ?', runId)!;
  expect(run.state, run.outcome_reason).toBe(state);
  expect(run.outcome_reason).toMatch(reason);
  expect(existsSync(run.policy_path)).toBe(true);
  const report = readFileSync(join(l.runDir(runId), 'final.md'), 'utf8');
  expect(report).toMatch(new RegExp(`^# Orbit run ${runId}: ${state}`));
  expect(report).toContain('## Next action');
  return report;
}

describe.skipIf(!READY)('acceptance: safe stops (spec section 2)', () => {
  it('unauthorized action: a delivery the policy does not authorize (push disabled) stops BLOCKED before anything leaves the repository', async () => {
    const l = lab({ tweak: (c) => void (c.actions = { ...c.actions, push_task_branch: false, open_pull_request: false }) });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    await drive(l, run.id);

    assertPreserved(l, run.id, 'BLOCKED', /POLICY_DENIED|not authorized|push/i);
    expect(git(l.remote, 'for-each-ref', 'refs/heads/orbit/')).toBe('');
    expect(l.github().state.prs).toEqual([]);
    expect(l.db().all("SELECT 1 FROM actions WHERE run_id = ? AND kind IN ('push', 'pr_create') AND state = 'SUCCEEDED'", run.id)).toEqual([]);
    // The verified and reviewed candidate is kept for a person to deliver by hand.
    expect(listEvidenceReports(l.db(), run.id).at(-1)?.verdict).toBe('PASS');
    expect(listReviews(l.db(), run.id).at(-1)?.verdict).toBe('APPROVE');
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('exhausted budget: a model-cost cap too small for an honest completion stops EXHAUSTED before the implementer starts', async () => {
    const l = lab({ tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 0.05) });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    const report = assertPreserved(l, run.id, 'EXHAUSTED', /budget|cost|hard cap/i);
    expect(report).toMatch(/## Budget consumption/);
    expect(listWorkers(l.db(), { runId: run.id, role: 'implementer' })).toEqual([]);
    // Spend never passed the cap, and the contract and worktree are kept.
    const cost = l.db().get<{ used: number; hard_cap: number }>("SELECT used, hard_cap FROM budget_counters WHERE run_id = ? AND counter = 'cost_usd'", run.id)!;
    expect(cost.used).toBeLessThanOrEqual(cost.hard_cap);
    expect(existsSync(join(l.runDir(run.id), 'contract.json'))).toBe(true);
    expect(existsSync(done.worktreePath!)).toBe(true);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('expired credentials: a provider that is logged out stops BLOCKED at preflight with the login command and the resume command', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }, { loggedIn: false }));
    const run = startLabRun(l, GOAL);
    await drive(l, run.id);

    assertPreserved(l, run.id, 'BLOCKED', new RegExp(`credentials[\\s\\S]*Run \`[^\`]+\`[\\s\\S]*orbit resume ${run.id}`));
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
    expect(existsSync(join(l.runDir(run.id), 'environment.json'))).toBe(true);
    assertRunInvariants(l, run.id);
  }, 120_000);

  it('unavailable mandatory reviewer: with no usable independent provider and no same-provider fallback, the run stops BLOCKED before spending on work', async () => {
    const l = lab({ tweak: (c) => void (c.providers.codex = { ...c.providers.codex!, command: '/nonexistent/acme/codex' }) });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    await drive(l, run.id);

    assertPreserved(l, run.id, 'BLOCKED', /review|codex|independent/i);
    expect(transitions(l.db(), run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    expect(listWorkers(l.db(), { runId: run.id })).toEqual([]);
    expect(argvCalls(l)).toEqual([]);
    const env = JSON.parse(readFileSync(join(l.runDir(run.id), 'environment.json'), 'utf8')) as { gate: { passed: boolean; reasons: string[] } };
    expect(env.gate.passed).toBe(false);
    expect(env.gate.reasons.join(' ')).toMatch(/review|codex/i);
    assertRunInvariants(l, run.id);
  }, 120_000);

  it('unavailable mandatory reviewer mid-run: a reviewer that keeps failing stops the run without approving the tree and without a same-provider substitute', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()], reviewer: [{ outcome: 'model_rejected' }] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);

    expect(['BLOCKED', 'EXHAUSTED']).toContain(done.state);
    expect(done.outcomeReason).toMatch(/review/i);
    expect(listReviews(l.db(), run.id, { includeInvalidated: true }).filter((r) => r.verdict === 'APPROVE')).toEqual([]);
    expect(listWorkers(l.db(), { runId: run.id, role: 'reviewer' }).every((w) => w.provider === 'codex')).toBe(true);
    expect(l.github().state.prs).toEqual([]);
    expect(listEvidenceReports(l.db(), run.id).at(-1)?.verdict).toBe('PASS');
    // The read-only review checkout does not outlive the stop (the implementer's worktree does, for a person).
    expect(existsSync(join(l.orbitHome, 'worktrees', repoKey(l.repo), run.id, 'review-1'))).toBe(false);
    expect(existsSync(done.worktreePath!)).toBe(true);
    assertPreserved(l, run.id, done.state, /review/i);
    assertRunInvariants(l, run.id);
  }, 180_000);
});
