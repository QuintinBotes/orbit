// Issue #9: the final report lists every non-built-in plugin a worker loaded, and a run that allowed one says so.
import { describe, expect, it } from 'vitest';
import { renderMarkdown, workerPluginsOf, type FinalReport } from '../../../src/controller/report.ts';

const REPORT_BASE: FinalReport = {
  schema: 'orbit.final/1',
  run_id: 'orb-1',
  outcome: 'SUCCEEDED',
  outcome_reason: null,
  mode: 'autonomous',
  original_goal: 'Add mul.',
  objective: null,
  criteria: [],
  checks: [],
  evidence: null,
  reviews: [],
  decisions: [],
  assumptions: [],
  repairs: [],
  revision: { base: null, candidate: null, tree: null, branch: null, delivered_commit: null, pull_request: null },
  budget: null,
  unverified: [],
  residual_risks: [],
  next_action: 'none',
  generated_at: 0,
};

const GUARD = { id: 'acme-guard@acme-it', name: 'acme-guard', scope: 'managed', allowed_by: 'agents.allow_managed_plugins' };
const NOTES = { id: 'acme-notes@acme', name: 'acme-notes', scope: null, allowed_by: null };

describe('worker plugins in the final report', () => {
  it('groups the plugins recorded in worker results, counting the workers that loaded each', () => {
    const rows = [
      { resultJson: JSON.stringify({ status: 'succeeded', plugins: [GUARD] }) },
      { resultJson: JSON.stringify({ status: 'failed', plugins: [GUARD, NOTES] }) },
      { resultJson: JSON.stringify({ status: 'succeeded' }) },
      { resultJson: null },
      { resultJson: 'not json' },
      { resultJson: JSON.stringify({ status: 'succeeded', plugins: 'junk' }) },
      { resultJson: JSON.stringify({ status: 'succeeded', plugins: [null, { id: 7 }] }) },
    ];
    const listed = workerPluginsOf(rows);
    expect(listed.plugins).toEqual([
      { id: 'acme-guard@acme-it', scope: 'managed', allowed_by: 'agents.allow_managed_plugins', workers: 2 },
      { id: 'acme-notes@acme', scope: null, allowed_by: null, workers: 1 },
      { id: null, scope: null, allowed_by: null, workers: 1 },
    ]);
    expect(listed.risks).toEqual(['worker plugin acme-guard@acme-it (scope managed) was allowed by agents.allow_managed_plugins and loaded into 2 worker session(s); a plugin can add hooks and tools to a worker']);
    expect(workerPluginsOf([]).plugins).toEqual([]);
  });

  it('renders a section only when a worker loaded a plugin, marking refused ones', () => {
    const md = renderMarkdown({
      ...REPORT_BASE,
      worker_plugins: [
        { id: 'acme-guard@acme-it', scope: 'managed', allowed_by: 'agents.allow_managed_plugins', workers: 2 },
        { id: 'acme-notes@acme', scope: null, allowed_by: null, workers: 1 },
        { id: null, scope: null, allowed_by: null, workers: 1 },
      ],
    });
    expect(md).toContain('## Worker plugins');
    expect(md).toContain('- acme-guard@acme-it (scope managed): allowed by agents.allow_managed_plugins, loaded by 2 worker(s)');
    expect(md).toContain('- acme-notes@acme (scope unknown): refused, so the output of 1 worker(s) was not used');
    expect(md).toContain('- an unidentified plugin (scope unknown): refused, so the output of 1 worker(s) was not used');
    expect(renderMarkdown(REPORT_BASE)).not.toContain('## Worker plugins');
    expect(renderMarkdown({ ...REPORT_BASE, worker_plugins: [] })).not.toContain('## Worker plugins');
  });
});
