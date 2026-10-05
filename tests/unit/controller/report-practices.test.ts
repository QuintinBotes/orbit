import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Controller } from '../../../src/controller/loop.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { renderMarkdown, type FinalReport } from '../../../src/controller/report.ts';
import { baseScenario, implementMul, labDeps, makeLab, runState, startLabRun, writeScenario, type Lab } from '../../integration/controller/harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

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

describe('engineering practices in the final report (S5.40)', () => {
  it('renders the selection, marking omissions with their reason, and no section when none is recorded', () => {
    const md = renderMarkdown({ ...REPORT_BASE, practices: [
      { practice: 'behavior-tests', applicable: true, justification: 'unit tests for the new function' },
      { practice: 'accessibility', applicable: false, justification: 'no user interface is touched' },
    ] });
    expect(md).toContain('## Engineering practices');
    expect(md).toContain('- behavior-tests [selected]: unit tests for the new function');
    expect(md).toContain('- accessibility [omitted]: no user interface is touched');
    expect(renderMarkdown(REPORT_BASE)).not.toContain('## Engineering practices');
    expect(renderMarkdown({ ...REPORT_BASE, practices: [] })).not.toContain('## Engineering practices');
  });

  it.skipIf(!canStripTypes)('a run records planning.practices and carries the selection into final.json and final.md', async () => {
    const l = makeLab();
    labs.push(l);
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const run = startLabRun(l);
    await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
    const done = runState(l, run.id);
    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');

    const [decision] = listDecisions(l.db(), run.id, { kind: 'planning.practices' });
    expect(decision?.summary).toMatch(/2 selected, 7 omitted with a reason/);
    const dir = join(l.repo, '.orbit', 'runs', run.id);
    const final = JSON.parse(readFileSync(join(dir, 'final.json'), 'utf8')) as FinalReport;
    expect(final.practices).toHaveLength(9);
    expect(final.practices!.filter((p) => p.applicable).map((p) => p.practice)).toEqual(['behavior-tests', 'compatibility-and-public-interfaces']);
    const contract = JSON.parse(readFileSync(join(dir, 'contract.json'), 'utf8')) as { practices: unknown[] };
    expect(contract.practices).toHaveLength(9);
    expect(readFileSync(join(dir, 'final.md'), 'utf8')).toContain('- accessibility [omitted]: ');
  }, 120_000);
});
