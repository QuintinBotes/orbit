// Issue #9: on a machine whose Claude Code has organisation-managed plugins (scope managed, loaded whatever the
// setting sources), every worker session loaded a plugin that is not a Claude Code built-in and was refused, so
// the run blocked at CONTRACTING. The policy keys agents.allowed_plugins and agents.allow_managed_plugins admit
// such a plugin explicitly; the default stays strict, and a run that admitted one says so in its report.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import type { FinalReport } from '../../../src/controller/report.ts';
import { BASELINE_FILE } from '../../../src/evidence/baseline.ts';
import { listQuestions } from '../../../src/inquisition/store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { argvCalls, baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const MANAGED = { id: 'acme-guard@acme-it', scope: 'managed', enabled: true };
const USER = { id: 'acme-notes@acme', scope: 'user', enabled: true };

async function runWith(tweak: (c: OrbitConfig) => void, opts: { plugins?: object[]; files?: Record<string, string> } = {}): Promise<{ l: Lab; runId: string }> {
  const l = makeLab({ tweak, ...(opts.files ? { files: opts.files } : {}) });
  labs.push(l);
  writeScenario(l, { ...baseScenario({ implementer: [implementMul('*')] }), plugins: opts.plugins ?? [MANAGED, USER] });
  const run = startLabRun(l);
  await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
  return { l, runId: run.id };
}

describe.skipIf(!canStripTypes)('controller: plugins loaded into worker sessions (issue #9)', () => {
  it('by default refuses a managed plugin at PREFLIGHT, naming it and the config line that would allow it, before any worker', async () => {
    const { l, runId } = await runWith(() => {});
    const done = runState(l, runId);
    expect(done.state).toBe('BLOCKED');
    expect(done.outcomeReason).toContain('acme-guard@acme-it');
    expect(done.outcomeReason).toContain('agents.allowed_plugins: ["acme-guard@acme-it"]');
    expect(done.outcomeReason).toContain('agents.allow_managed_plugins: true');
    // A user-scope plugin never loads into a worker (--setting-sources ""), so it is not named.
    expect(done.outcomeReason).not.toContain('acme-notes@acme');
    expect(listWorkers(l.db(), { runId })).toEqual([]);
  }, 60_000);

  // Issue #22: doctor failed on claude.plugins, yet `orbit run` spent about ten minutes on the base revision's checks,
  // raised baseline-exception questions, started a planner and only then found every session refused.
  it('refuses before the base checks, the baseline questions, any worker or the curator, and names every plugin with the fix (issue #22)', async () => {
    const four = ['acme-audit@acme-it', 'acme-guard@acme-it', 'acme-lint@acme-it', 'acme-notes@acme-it'].map((id) => ({ id, scope: 'managed', enabled: true }));
    const { l, runId } = await runWith(
      (c) => {
        c.knowledge = { ...c.knowledge, enabled: true };
      },
      // The base revision fails its check, so a run that got as far as the baseline would ask whether to accept the failure.
      { plugins: four, files: { 'tests/add.test.mjs': 'process.exit(1);\n' } },
    );
    const done = runState(l, runId);
    expect(done.state).toBe('BLOCKED');
    const reason = done.outcomeReason ?? '';
    expect(reason).toContain('workers would load 4 plugin(s) the policy does not allow, so every worker session would be refused');
    for (const p of four) expect(reason).toContain(`${p.id} (scope managed)`);
    expect(reason).toContain(`agents.allowed_plugins: ${JSON.stringify(four.map((p) => p.id))}`);
    expect(reason).toContain('agents.allow_managed_plugins: true');
    // The policy is frozen with the run: the way out is a new run (or removing the plugin), and the line says so.
    expect(reason).toContain('frozen policy');
    expect(JSON.parse(done.outcomeJson ?? '{}')).toMatchObject({ frozen_policy: expect.anything(), worker_refusal: { kind: 'plugins', plugins: four.map((p) => p.id) } });

    const dir = join(l.repo, '.orbit', 'runs', runId);
    expect(existsSync(join(dir, BASELINE_FILE)), 'no check ran on the base revision').toBe(false);
    expect(listQuestions(l.db(), runId), 'no baseline-exception question').toEqual([]);
    expect(listWorkers(l.db(), { runId }), 'no planner and no curator').toEqual([]);
    expect(argvCalls(l), 'no model was called').toEqual([]);
    expect(l.db().get<{ n: number }>('SELECT COUNT(*) AS n FROM usage WHERE run_id = ?', runId)?.n).toBe(0);
  }, 60_000);

  // A plugin whose scope doctor cannot place ("may load", a warning) does not stop the run from starting, so a session
  // can still be refused after it started. That refusal is not transient: it ends the run once, in full, with no curator.
  it('a session refused after it started is not retried, is reported in full and is not followed by a curator (issue #22)', async () => {
    const synced = ['acme-audit@acme-it', 'acme-guard@acme-it', 'acme-lint@acme-it', 'acme-notes@acme-it'].map((id) => ({ id, scope: 'synced', enabled: true }));
    const { l, runId } = await runWith(
      (c) => {
        c.knowledge = { ...c.knowledge, enabled: true };
      },
      { plugins: synced },
    );
    const done = runState(l, runId);
    expect(done.state).toBe('BLOCKED');
    // One planner session, not "no usable result after 2 attempts".
    const planners = listWorkers(l.db(), { runId, role: 'planner' });
    expect(planners.map((w) => w.purpose)).toEqual(['plan#1']);
    expect(argvCalls(l).filter((c) => c.role === 'planner')).toHaveLength(1);
    // The outcome line names every plugin and the line that allows it, untruncated, and says where the cause is shown.
    const reason = done.outcomeReason ?? '';
    for (const p of synced) expect(reason).toContain(`${p.id} (scope synced; allow it with agents.allowed_plugins: ${JSON.stringify([p.id])})`);
    expect(reason).not.toContain('no usable result');
    expect(reason).toContain('orbit doctor');
    expect(JSON.parse(done.outcomeJson ?? '{}')).toMatchObject({ worker_refusal: expect.anything() });
    // The curator is a session in the same environment: it would be refused the same way, so it is not started.
    expect(listWorkers(l.db(), { runId, role: 'curator' })).toEqual([]);
    const learning = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', runId, 'learning.json'), 'utf8')) as { skipped: string | null };
    expect(learning.skipped).toMatch(/refused/);
  }, 60_000);

  it('with agents.allow_managed_plugins the run succeeds, and every worker and the final report record the plugin', async () => {
    const { l, runId } = await runWith((c) => {
      c.agents.allow_managed_plugins = true;
    });
    const done = runState(l, runId);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const claudeWorkers = listWorkers(l.db(), { runId }).filter((w) => w.provider === 'claude');
    expect(claudeWorkers.length).toBeGreaterThan(1);
    for (const w of claudeWorkers) {
      const result = JSON.parse(w.resultJson ?? '{}') as { plugins?: unknown };
      expect(result.plugins).toEqual([{ id: 'acme-guard@acme-it', name: 'acme-guard', scope: 'managed', allowed_by: 'agents.allow_managed_plugins' }]);
    }
    const dir = join(l.repo, '.orbit', 'runs', runId);
    const final = JSON.parse(readFileSync(join(dir, 'final.json'), 'utf8')) as FinalReport;
    expect(final.worker_plugins).toEqual([{ id: 'acme-guard@acme-it', scope: 'managed', allowed_by: 'agents.allow_managed_plugins', workers: claudeWorkers.length }]);
    expect(final.residual_risks.some((r) => r.includes('acme-guard@acme-it') && r.includes('agents.allow_managed_plugins'))).toBe(true);
    const md = readFileSync(join(dir, 'final.md'), 'utf8');
    expect(md).toContain('## Worker plugins');
    expect(md).toContain('- acme-guard@acme-it (scope managed): allowed by agents.allow_managed_plugins, loaded by');
  }, 60_000);

  it('agents.allowed_plugins admits the exact id', async () => {
    const { l, runId } = await runWith((c) => {
      c.agents.allowed_plugins = ['acme-guard@acme-it'];
    });
    const done = runState(l, runId);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const final = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', runId, 'final.json'), 'utf8')) as FinalReport;
    expect(final.worker_plugins?.map((p) => [p.id, p.allowed_by])).toEqual([['acme-guard@acme-it', 'agents.allowed_plugins']]);
  }, 60_000);
});
