// Timeouts are diagnosed as performance or environment problems, never fixed by waiting longer (spec section 14;
// docs/gaps.md G36), and a diagnosis that pins the fault to a changed file localizes it (spec section 7; G44).
import { describe, expect, it } from 'vitest';
import { localizedFault, raisesTimeout, timeoutContext, timeoutPromptLines, withTimeoutHypothesis, type TimeoutContext } from '../../../src/controller/steps/diagnosing.ts';
import type { DiagnosisOutput } from '../../../src/contract/model-outputs.ts';
import type { RepairBrief } from '../../../src/evidence/types.ts';
import type { RunContext } from '../../../src/controller/context.ts';

const BRIEF: RepairBrief = {
  fingerprint: 'fp-timeout',
  evidence: ['unit timed out after 120 s'],
  hypotheses: [{ statement: 'the new loop never terminates for empty input', supporting: 'the test with [] is the one that hangs' }],
  experiment: 'Run the unit suite with only the empty-input test',
  expected_observation: 'it hangs when the loop does not terminate',
  scoped_fix: 'Return early from sum in apps/calc.mjs when the list is empty',
  post_fix_checks: ['unit'],
  preserved_constraints: ['Keep the empty-input test'],
};

const T: TimeoutContext = { checks: [{ checkId: 'unit', durationMs: 120_400, timeoutSeconds: 120, baselineMs: 3_100 }], machine: { cores: 8, loadAvg1m: 7.5, freeMemMb: 900 } };

describe('timeout diagnosis', () => {
  it('names the timed-out check, its baseline and the machine load, and makes an environment hypothesis mandatory', () => {
    const lines = timeoutPromptLines(T).join('\n');
    expect(lines).toContain('unit timed out after 120 s (limit 120 s; 3 s on the base revision)');
    expect(lines).toContain('8 core(s), load average 7.5, 900 MB free');
    expect(lines).toMatch(/One competing hypothesis must be an environment or performance cause/);
    expect(lines).toMatch(/never the scoped fix/);
  });

  it('adds the environment or performance hypothesis and the no-raised-timeout constraint to a brief that lacks them, once', () => {
    const b = withTimeoutHypothesis(BRIEF, T);
    expect(b.hypotheses).toHaveLength(2);
    expect(b.hypotheses[1]!.statement).toMatch(/environment or a performance regression/);
    expect(b.hypotheses[1]!.supporting).toContain('load average 7.5');
    expect(b.preserved_constraints).toContain('Do not raise, extend or remove any check or test timeout');
    expect(withTimeoutHypothesis(b, T)).toEqual(b);
    const already = { ...BRIEF, hypotheses: [...BRIEF.hypotheses, { statement: 'machine load slows the suite past its limit', supporting: 'load average 7.5' }] };
    expect(withTimeoutHypothesis(already, T).hypotheses).toHaveLength(2);
  });

  it('recognizes a fix that buys time instead of finding the cause', () => {
    for (const fix of ['Increase the unit check timeout to 600 seconds', 'Raise the test timeout', 'make the timeout longer in tests/run.mjs', 'Remove the per-test timeout', 'bump jest timeouts']) expect(raisesTimeout(fix), fix).toBe(true);
    for (const fix of [BRIEF.scoped_fix, 'Fix the deadlock in the queue drain so the suite finishes within its timeout']) expect(raisesTimeout(fix), fix).toBe(false);
  });

  it('reads the timed-out checks of a candidate with their baseline durations', () => {
    const rows = [
      { checkId: 'unit', candidateId: 'cand-1', status: 'TIMEOUT', timedOut: true, startedAt: 1_000, endedAt: 121_400 },
      { checkId: 'lint', candidateId: 'cand-1', status: 'PASSED', timedOut: false, startedAt: 1_000, endedAt: 2_000 },
      { checkId: 'unit', candidateId: null, status: 'PASSED', timedOut: false, startedAt: 0, endedAt: 3_100 },
    ];
    const db = {
      all: (_sql: string, ...params: unknown[]) => {
        const [runId, cand] = params;
        void runId;
        return rows
          .filter((r) => (cand === undefined ? r.candidateId === null : r.candidateId === cand))
          .map((r) => ({ id: `${r.checkId}-${r.candidateId}`, run_id: 'run-1', candidate_id: r.candidateId, check_id: r.checkId, kind: 'command', tree_hash: 't', check_config_hash: 'c', policy_hash: 'p', command_json: '[]', cwd: '/', isolation: 'none', status: r.status, exit_code: null, timed_out: r.timedOut ? 1 : 0, cancelled: 0, flaky: 0, rerun_of: null, pid: null, log_path: null, log_sha256: null, fingerprint: null, excerpt: null, artifacts_json: null, meta_json: null, started_at: r.startedAt, ended_at: r.endedAt }));
      },
    };
    const ctx = { db, run: { id: 'run-1' }, snapshot: { config: { checks: { unit: { timeout_seconds: 120 } } } } } as unknown as RunContext;
    const t = timeoutContext(ctx, 'cand-1', { cores: 4, loadAvg1m: null, freeMemMb: 2048 });
    expect(t).toEqual({ checks: [{ checkId: 'unit', durationMs: 120_400, timeoutSeconds: 120, baselineMs: 3_100 }], machine: { cores: 4, loadAvg1m: null, freeMemMb: 2048 } });
    rows[0]!.status = 'FAILED';
    rows[0]!.timedOut = false;
    expect(timeoutContext(ctx, 'cand-1', { cores: 4, loadAvg1m: null, freeMemMb: 2048 })).toBeNull();
  });
});

describe('fault localization', () => {
  const out = (over: Partial<DiagnosisOutput> = {}): DiagnosisOutput =>
    ({
      repair_brief: BRIEF,
      fingerprint_comparison: { current: 'fp', previous: [], relation: 'first-occurrence', progress: 'unknown', explanation: 'first' },
      competing_hypotheses: [{ id: 'H1', statement: 'the loop never terminates for empty input', supporting_evidence: ['the [] test hangs'], refuting_evidence: [], discriminating_experiment: 'run it alone', expected_if_true: 'it hangs', status: 'leading', previously_tested: false }],
      chosen_hypothesis_id: 'H1',
      confidence: 'high',
      ...over,
    }) as DiagnosisOutput;

  it('is the changed file the scoped fix names, with the chosen hypothesis', () => {
    expect(localizedFault(out(), BRIEF, ['apps/calc.mjs', 'tests/sum.test.mjs'])).toBe('apps/calc.mjs: the loop never terminates for empty input');
  });

  it('is nothing when the fix names no changed file, the confidence is low, or the hypothesis has no support', () => {
    expect(localizedFault(out(), BRIEF, ['apps/other.mjs'])).toBeNull();
    expect(localizedFault(out({ confidence: 'low' } as Partial<DiagnosisOutput>), BRIEF, ['apps/calc.mjs'])).toBeNull();
    const unsupported = out();
    unsupported.competing_hypotheses[0]!.supporting_evidence = [];
    expect(localizedFault(unsupported, BRIEF, ['apps/calc.mjs'])).toBeNull();
  });
});
