import { describe, expect, it } from 'vitest';
import { amendmentSentence, baselineBlockReason, type BlockedCheck, type MisconfiguredBlock } from '../../../src/controller/environment-block.ts';
import { checksToAmend } from '../../../src/controller/steps/baseline-amendment.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import type { BaselineAmendment, BaselineReport } from '../../../src/evidence/baseline.ts';
import { checkDef } from '../evidence/fixtures.ts';
import { fakeSnapshot } from '../evidence/report-fixtures.ts';
import { BASE_REV } from './coverage-helpers.ts';

// Issue #32 (ADR 0012): a check the contract requires that the baseline has no result for is run on the base revision
// before any candidate is judged.

const snapshot = fakeSnapshot([checkDef('unit'), checkDef('format', { mandatory: false }), checkDef('lint', { mandatory: false }), checkDef('journeys', { kind: 'playwright', mandatory: false })]);

function baseline(over: Partial<BaselineReport> = {}): BaselineReport {
  return {
    schema: 'orbit.baseline/1',
    runId: 'orb-1',
    baseRevision: BASE_REV,
    baseTree: 'b'.repeat(40),
    policyHash: 'sha256:p',
    checkIds: ['unit'],
    install: { skipped: true, reason: null, ok: false },
    checks: [{ checkId: 'unit', mandatory: true, status: 'PASSED', exitCode: 0, flaky: false, fingerprint: null, excerpt: null, log: 'unit.log' }],
    failures: [],
    complete: true,
    recordedAt: 1,
    ...over,
  };
}

const contract = (required: string[]): GoalContract => ({ required_check_ids: required, acceptance_criteria: [] }) as unknown as GoalContract;
const judged = (): boolean => true;

describe('checksToAmend', () => {
  it('is the command checks the contract requires that the baseline has no result for, in id order', () => {
    expect(checksToAmend({ snapshot }, contract(['unit', 'lint', 'format', 'journeys']), baseline(), judged)).toEqual(['format', 'lint']);
    expect(checksToAmend({ snapshot }, contract(['unit']), baseline(), judged)).toEqual([]);
    expect(checksToAmend({ snapshot }, contract(['unit', 'format']), baseline({ checkIds: ['format', 'unit'] }), judged)).toEqual([]);
  });

  it('runs again a check an earlier amendment found could not run or was misconfigured, and nothing PREFLIGHT judged', () => {
    const amendments = [{ checkIds: ['format', 'lint'], stage: 'PLANNING', recordedAt: 2 }];
    const failures: BaselineReport['failures'] = [
      { checkId: 'format', fingerprint: 'fp:1', excerpt: null, classification: 'environment', signals: ['pipe-denied'] },
      { checkId: 'lint', fingerprint: 'fp:2', excerpt: null, classification: 'missing-target' },
    ];
    expect(checksToAmend({ snapshot }, contract(['unit', 'format', 'lint']), baseline({ checkIds: ['format', 'lint', 'unit'], failures, amendments }), judged)).toEqual(['format']);
    expect(checksToAmend({ snapshot }, contract(['unit', 'lint']), baseline({ checkIds: ['format', 'lint', 'unit'], failures: [{ ...failures[1]!, classification: 'misconfigured' }], amendments }), judged)).toEqual(['lint']);
    // A mandatory check PREFLIGHT classified blocked there; a resume runs PREFLIGHT's baseline again, not an amendment.
    expect(checksToAmend({ snapshot }, contract(['unit']), baseline({ failures: [{ checkId: 'unit', fingerprint: 'fp:3', excerpt: null, classification: 'environment' }] }), judged)).toEqual([]);
  });

  it('runs again a check whose latest amendment was never judged, and not one a later amendment judged', () => {
    const passed = (id: string) => ({ checkId: id, mandatory: false, status: 'PASSED' as const, exitCode: 0, flaky: false, fingerprint: null, excerpt: null, log: `${id}.log` });
    const failures: BaselineReport['failures'] = [{ checkId: 'lint', fingerprint: 'fp:2', excerpt: 'apps/calc.mjs: missing export mul' }];
    const report = baseline({ checkIds: ['format', 'lint', 'unit'], checks: [...baseline().checks, passed('format')], failures });
    const cut = { checkIds: ['lint'], stage: 'VERIFYING', recordedAt: 3 };
    const onlyCut = (a: BaselineAmendment): boolean => a !== cut;
    // Cut short after its baseline was written: its pre-existing failure was never asked about, so lint runs again.
    expect(checksToAmend({ snapshot }, contract(['unit', 'lint', 'format']), { ...report, amendments: [{ checkIds: ['format'], stage: 'PLANNING', recordedAt: 2 }, cut] }, onlyCut)).toEqual(['lint']);
    // Run again and judged by a later amendment: the earlier, unjudged one no longer counts.
    expect(checksToAmend({ snapshot }, contract(['unit', 'lint', 'format']), { ...report, amendments: [cut, { checkIds: ['lint'], stage: 'VERIFYING', recordedAt: 4 }] }, onlyCut)).toEqual([]);
  });
});

describe('the reason of a block on an amended check', () => {
  const format: BlockedCheck = { checkId: 'format', fingerprint: null, signals: ['pipe-denied'], cause: 'the sandbox refused a .NET process the named pipe it binds under /tmp', lines: ['Unhandled exception: System.TimeoutException: The operation has timed out.'], questionId: null };

  it('says, second, which criteria cite the check and that the policy does not mark it mandatory', () => {
    expect(amendmentSentence([{ checkId: 'format', citedBy: ['AC-2'], mandatory: false }])).toBe('The contract requires check format (criterion AC-2 cites it as evidence), which the policy does not mark mandatory, so it was run on the base revision before any change was judged (a baseline amendment)');
    expect(amendmentSentence([{ checkId: 'format', citedBy: ['AC-2', 'AC-3'], mandatory: false }, { checkId: 'lint', citedBy: [], mandatory: true }])).toBe(
      'The contract requires checks format (criteria AC-2, AC-3 cite it as evidence), lint (the contract lists it among its required checks), so they were run on the base revision before any change was judged (a baseline amendment)',
    );
    const reason = baselineBlockReason({ runId: 'orb-1', baseRevision: BASE_REV, environment: [format], misconfigured: [], amended: [{ checkId: 'format', citedBy: ['AC-2'], mandatory: false }] });
    const sentences = reason.split(/(?<=[a-z0-9)"\]])\. (?=[A-Z])/);
    expect(sentences[0]).toMatch(/^Check format could not run on the base revision aaaaaaaaaaaa/);
    expect(sentences[1]).toBe('The contract requires check format (criterion AC-2 cites it as evidence), which the policy does not mark mandatory, so it was run on the base revision before any change was judged (a baseline amendment)');
    expect(reason).not.toMatch(/mandatory: false/);
  });

  it('keeps a misconfigured check first, so the reason still names the policy setting it comes from', () => {
    const lint: MisconfiguredBlock = { checkId: 'lint', kind: 'argument', signature: 'go-flag', tool: 'go', cause: 'go rejected a flag the command passes', lines: ['flag provided but not defined: -acme'], configKey: 'checks.lint.command' };
    const reason = baselineBlockReason({ runId: 'orb-1', baseRevision: BASE_REV, environment: [], misconfigured: [lint], amended: [{ checkId: 'lint', citedBy: ['AC-1'], mandatory: false }, { checkId: 'unrelated', citedBy: [], mandatory: false }] });
    expect(reason).toMatch(/^Check lint is misconfigured, not a pre-existing failure: /);
    expect(reason).toContain('. The contract requires check lint (criterion AC-1 cites it as evidence), which the policy does not mark mandatory, so it was run on the base revision before any change was judged (a baseline amendment). ');
    expect(reason).not.toContain('unrelated');
    // Without an amendment the reason is PREFLIGHT's, unchanged.
    expect(baselineBlockReason({ runId: 'orb-1', baseRevision: BASE_REV, environment: [format], misconfigured: [] })).not.toMatch(/baseline amendment/);
  });
});
