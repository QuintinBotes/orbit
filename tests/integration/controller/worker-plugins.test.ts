// Issue #9: on a machine whose Claude Code has organisation-managed plugins (scope managed, loaded whatever the
// setting sources), every worker session loaded a plugin that is not a Claude Code built-in and was refused, so
// the run blocked at CONTRACTING. The policy keys agents.allowed_plugins and agents.allow_managed_plugins admit
// such a plugin explicitly; the default stays strict, and a run that admitted one says so in its report.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import type { FinalReport } from '../../../src/controller/report.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const MANAGED = { id: 'acme-guard@acme-it', scope: 'managed', enabled: true };
const USER = { id: 'acme-notes@acme', scope: 'user', enabled: true };

async function runWith(tweak: (c: OrbitConfig) => void): Promise<{ l: Lab; runId: string }> {
  const l = makeLab({ tweak });
  labs.push(l);
  writeScenario(l, { ...baseScenario({ implementer: [implementMul('*')] }), plugins: [MANAGED, USER] });
  const run = startLabRun(l);
  await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
  return { l, runId: run.id };
}

describe.skipIf(!canStripTypes)('controller: plugins loaded into worker sessions (issue #9)', () => {
  it('by default refuses a managed plugin, naming it and the config line that would allow it', async () => {
    const { l, runId } = await runWith(() => {});
    const done = runState(l, runId);
    expect(done.state).toBe('BLOCKED');
    const planner = listWorkers(l.db(), { runId, role: 'planner' })[0]!;
    expect(planner.error).toContain('acme-guard@acme-it');
    expect(planner.error).toContain('agents.allowed_plugins: ["acme-guard@acme-it"]');
    expect(planner.error).toContain('agents.allow_managed_plugins: true');
    // A user-scope plugin never loads into a worker (--setting-sources ""), so it is not named.
    expect(planner.error).not.toContain('acme-notes@acme');
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
