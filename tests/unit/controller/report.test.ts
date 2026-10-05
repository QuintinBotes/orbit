import { describe, expect, it } from 'vitest';
import { renderMarkdown, type FinalReport } from '../../../src/controller/report.ts';

function report(over: Partial<FinalReport> = {}): FinalReport {
  return {
    schema: 'orbit.final/1',
    run_id: 'orb-20261005-000000-acme01',
    outcome: 'SUCCEEDED',
    outcome_reason: 'all mandatory requirements hold',
    mode: 'autonomous',
    original_goal: 'Add mul.',
    objective: 'Add a mul function.',
    criteria: [{ id: 'AC-1', statement: 'mul multiplies', mandatory: true, status: 'supported', artifacts: ['unit.log'] }],
    checks: [{ id: 'unit', status: 'PASSED', exit_code: 0, flaky: false, log: 'evidence/1/unit.log' }],
    evidence: { report_id: 'evr-1', verdict: 'PASS', tree_hash: 't1', candidate_revision: 'c1' },
    reviews: [{ id: 'rev-1', provider: 'codex', model: 'gpt-6-astra', verdict: 'APPROVE', tree_hash: 't1', findings: 0 }],
    decisions: [{ kind: 'route', summary: 'implement:1: sonnet', at: 1 }],
    assumptions: [],
    repairs: [{ attempt: 2, source: 'diagnosis', fingerprint: 'fp:1' }],
    revision: { base: 'b1', candidate: 'c1', tree: 't1', branch: 'orbit/orb-1', delivered_commit: null, pull_request: null },
    budget: { counters: [{ counter: 'implementation_attempts', used: 2, allowance: 2, hard_cap: 12, remaining: 0 }], cost_measurement: 'spend reported by providers', cost_usd: 0.0246, cost_complete: true, tokens: { input: 1, output: 2, cache_read: 3, cache_write: 4 } },
    unverified: ['static analysis (SAST) is unverified: the policy defines no SAST check'],
    residual_risks: ['no isolation'],
    next_action: 'Inspect the local branch orbit/orb-1.',
    generated_at: 0,
    ...over,
  };
}

describe('final report', () => {
  it('has every section spec section 19 asks for', () => {
    const md = renderMarkdown(report());
    for (const h of ['## Outcome', '## Original goal', '## Delivered behaviour', '## Criterion evidence', '## Checks', '## Decisions', '## Assumptions', '## Repairs', '## Revision, branch and pull request', '## Budget consumption', '## Not verified', '## Residual risks', '## Next action']) {
      expect(md).toContain(h);
    }
    expect(md).toContain('implementation_attempts: 2 used of 2 allowed (hard cap 12)');
    expect(md).toContain('AC-1 [supported]: mul multiplies');
    expect(md).toContain('attempt 2: diagnosis brief for fp:1');
  });

  it('states unmeasured spend instead of implying a number, and redacts secrets', () => {
    const token = ['ghp', '_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('');
    const md = renderMarkdown(report({ outcome: 'BLOCKED', outcome_reason: `push refused with ${token}`, budget: { counters: [], cost_measurement: 'spend is unmeasured: no provider reported cost', cost_usd: 0, cost_complete: false, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 } } }));
    expect(md).toContain('incomplete: some usage has no cost');
    expect(md).toContain('spend is unmeasured');
    expect(md).not.toContain(token);
  });
});
