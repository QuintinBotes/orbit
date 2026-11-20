// Issue #200: the judgement of the proof gate, from the answers of its fresh sessions and the candidate's files. Each
// rule here is Orbit's own (FR-002, FR-003, FR-006, FR-008, FR-011): no model answer can turn it.
import { describe, expect, it } from 'vitest';
import { auditAnswer, changedLines, declaredFunction, enclosingFunction, judgeCriterion, judgeProof, judgeRequirement, parseRange, quoteMismatch, type CriterionInput, type ProofAnswer, type RequirementInput } from '../../../src/review/proof.ts';
import type { CriterionFailBefore } from '../../../src/evidence/types.ts';

const audit = (verdict: ProofAnswer['verdict'], severity: string, claim = 'the assertion on the body would fail'): ProofAnswer => ({ verdict, findings: [{ id: 'AUDIT-1', severity, category: 'criterion-audit', location: 'tests/a.test.ts:3', claim, evidence: 'assert.equal(x, 1)' }], missing: null });
const NO = audit('APPROVE', 'info');
const YES = audit('REPAIR_REQUIRED', 'high', 'the test performs the merge itself, so it passes whether or not the queue merges');

function fb(outcome: CriterionFailBefore['outcome'], over: Partial<CriterionFailBefore> = {}): CriterionFailBefore {
  return { mode: 'required', outcome, checks: [], probe_tree: 'tree-p', test_paths: { paths: ['tests/a.test.ts'], count: 1 }, reason: `${outcome} reason`, tests: [{ path: 'tests/a.test.ts', check_id: 'unit', base: 'failed', candidate: 'passed', reason: 'r' }], ...over };
}
const criterion = (over: Partial<CriterionInput> = {}): CriterionInput => ({ id: 'AC-1', statement: 'The queue never merges.', kind: 'change', tests: ['tests/a.test.ts'], failBefore: fb('failed-before'), audit: NO, ...over });

describe('the auditor\'s answer (FR-002)', () => {
  it('reads APPROVE with an info AUDIT-1 as "no" and REPAIR_REQUIRED with a blocking AUDIT-1 as "yes", each with its reason', () => {
    expect(auditAnswer(NO)).toEqual({ answer: 'no', reason: 'the assertion on the body would fail' });
    expect(auditAnswer(YES)).toEqual({ answer: 'yes', reason: 'the test performs the merge itself, so it passes whether or not the queue merges' });
  });

  it('reads anything else as no answer: a missing or extra finding, a verdict that contradicts the severity, a session that failed', () => {
    expect(auditAnswer({ verdict: 'APPROVE', findings: [], missing: null }).answer).toBeNull();
    expect(auditAnswer({ ...NO, findings: [...NO.findings, { ...NO.findings[0]!, id: 'TEST-1' }] }).answer).toBeNull();
    expect(auditAnswer(audit('APPROVE', 'high')).answer).toBeNull();
    expect(auditAnswer(audit('REPAIR_REQUIRED', 'info')).answer).toBeNull();
    expect(auditAnswer({ verdict: null, findings: [], missing: 'the test is too long' })).toEqual({ answer: null, reason: 'the test is too long' });
  });
});

describe('a criterion is proven only by its own fail-before and the auditor\'s "no" (FR-002, FR-003)', () => {
  it('US1.3: a test that fails on the base tree, passes on the candidate and gets "no" proves its criterion, and both results are kept', () => {
    const p = judgeCriterion(criterion());
    expect(p.status).toBe('proven');
    expect(p.audit).toEqual({ answer: 'no', reason: 'the assertion on the body would fail' });
    expect(p.fail_before).toEqual({ outcome: 'failed-before', reason: 'failed-before reason' });
  });

  it('US1.1: "yes" leaves the criterion unproven with the auditor\'s reason, whatever its fail-before showed', () => {
    const p = judgeCriterion(criterion({ audit: YES }));
    expect(p.status).toBe('unproven');
    expect(p.reason).toContain('the auditor answered yes');
    expect(p.reason).toContain('performs the merge itself');
  });

  it('US1.2: a mapped test that passes on the base tree leaves the criterion unproven, even with "no"', () => {
    expect(judgeCriterion(criterion({ failBefore: fb('passed-before') }))).toMatchObject({ status: 'unproven', reason: 'fail-before: passed-before: passed-before reason' });
  });

  it('US1.4: a criterion with no fail-before outcome of its own (a check-wide one, or none) is never proven by green checks', () => {
    const { tests: _t, ...checkWide } = fb('failed-before');
    expect(judgeCriterion(criterion({ failBefore: checkWide })).reason).toBe('it has no fail-before outcome of its own');
    expect(judgeCriterion(criterion({ failBefore: null })).status).toBe('unproven');
  });

  it('a UI criterion is judged by the browser probe of its journeys (ADR 0016), which is check-wide, with the auditor\'s "no"', () => {
    const { tests: _t, ...journeys } = fb('failed-before');
    expect(judgeCriterion(criterion({ ui: true, failBefore: journeys })).status).toBe('proven');
    expect(judgeCriterion(criterion({ ui: true, failBefore: { ...journeys, outcome: 'passed-before' } })).status).toBe('unproven');
  });

  it('edge case: an auditor that cannot answer (too long, unreadable, failed) leaves the criterion unproven, never proven', () => {
    const p = judgeCriterion(criterion({ audit: { verdict: null, findings: [], missing: 'over the auditor\'s limit' } }));
    expect(p).toMatchObject({ status: 'unproven', reason: "no audit verdict: over the auditor's limit" });
  });

  it('edge case: a keep criterion is proven by passing on both trees and "no", not by failing before', () => {
    expect(judgeCriterion(criterion({ kind: 'keep', failBefore: fb('kept') })).status).toBe('proven');
    expect(judgeCriterion(criterion({ kind: 'keep', failBefore: fb('passed-before') })).status).toBe('unproven');
  });

  it('edge case: a person-checked criterion is neither audited nor probed, waits on that person, and is never proven', () => {
    const p = judgeCriterion(criterion({ kind: 'person', tests: [], failBefore: null, audit: null }));
    expect(p).toMatchObject({ status: 'waiting-on-person', audit: null, fail_before: null });
  });

  it('a criterion a person accepted without fail-before is proven only with the auditor\'s "no", and says who accepted it', () => {
    const accepted = fb('not-established', { accepted: { question_id: 'q-1', by: 'person:ana' } });
    expect(judgeCriterion(criterion({ failBefore: accepted })).reason).toContain('accepted without fail-before by person:ana');
    expect(judgeCriterion(criterion({ failBefore: accepted, audit: YES })).status).toBe('unproven');
  });

  it('a criterion with no mapped test is unproven', () => {
    expect(judgeCriterion(criterion({ tests: [], failBefore: fb('not-established') })).reason).toContain('no test is mapped to it');
  });
});

describe('quotes are checked byte for byte (FR-006)', () => {
  const file = ['export function stopQueue(runs) {', '  if (failedIssues >= 2) return true;', '  return false;', '}', ''].join('\n');

  it('parses the locations a conformance answer gives', () => {
    expect(parseRange('src/queue.ts:2-3')).toEqual({ path: 'src/queue.ts', start: 2, end: 3 });
    expect(parseRange('./src/queue.ts:2')).toEqual({ path: 'src/queue.ts', start: 2, end: 2 });
    expect(parseRange('src/queue.ts#L2-L3')).toEqual({ path: 'src/queue.ts', start: 2, end: 3 });
    expect(parseRange('src/queue.ts')).toBeNull();
    expect(parseRange('src/queue.ts:3-2')).toBeNull();
  });

  it('accepts the exact lines, with or without one final newline', () => {
    expect(quoteMismatch(file, { path: 'q', start: 2, end: 3 }, '  if (failedIssues >= 2) return true;\n  return false;')).toBeNull();
    expect(quoteMismatch(file, { path: 'q', start: 2, end: 2 }, '  if (failedIssues >= 2) return true;\n')).toBeNull();
  });

  it('US2.2: a quote that is not in the candidate exactly as quoted does not match', () => {
    expect(quoteMismatch(file, { path: 'q', start: 2, end: 2 }, 'if (failedIssues >= 2) return true;')).toMatch(/is not lines 2-2 of q/);
    expect(quoteMismatch(file, { path: 'q', start: 2, end: 2 }, '  if (failedRuns >= 2) return true;')).not.toBeNull();
    expect(quoteMismatch(file, { path: 'q', start: 9, end: 9 }, '}')).toMatch(/fewer than 9/);
    expect(quoteMismatch(null, { path: 'q', start: 1, end: 1 }, 'x')).toBe('q is not in the candidate');
  });
});

describe('the function a quoted line lies in, by search (FR-008)', () => {
  it('recognizes declarations in the languages it searches, and not control flow', () => {
    expect(declaredFunction('export function routeFor(goal: Goal): Route {')).toBe('routeFor');
    expect(declaredFunction('export const routeFor = async (goal) => {')).toBe('routeFor');
    expect(declaredFunction('def route_for(goal):')).toBe('route_for');
    expect(declaredFunction('func (r *Router) RouteFor(goal Goal) Route {')).toBe('RouteFor');
    expect(declaredFunction('pub fn route_for(goal: &Goal) -> Route {')).toBe('route_for');
    expect(declaredFunction('  async routeFor(goal: Goal): Promise<Route> {')).toBe('routeFor');
    expect(declaredFunction('  if (goal.kind === "bug") {')).toBeNull();
  });

  it('finds the nearest declaration above the line and where it ends', () => {
    const text = ['import x from "y";', 'export function a() {', '  return 1;', '}', 'export function b() {', '  return 2;', '}'].join('\n');
    expect(enclosingFunction(text, 3)).toEqual({ name: 'a', start: 2, end: 4 });
    expect(enclosingFunction(text, 6)).toEqual({ name: 'b', start: 5, end: 7 });
    expect(enclosingFunction(text, 1)).toBeNull();
  });

  it('reads the changed lines of a zero-context diff', () => {
    const diff = ['diff --git a/x b/x', '@@ -3 +3 @@', '-a', '+b', '@@ -10,0 +11,2 @@', '+c', '+d', '@@ -20,2 +22,0 @@'].join('\n');
    expect([...changedLines(diff)]).toEqual([3, 11, 12]);
  });
});

describe('conformance records (FR-005 to FR-008)', () => {
  const text = ['export function stopQueue(failedIssues) {', '  return failedIssues >= 2;', '}', ''].join('\n');
  const requirement = (answer: ProofAnswer, over: Partial<RequirementInput> = {}): RequirementInput => ({
    id: 'FR-004',
    wording: 'The queue MUST stop after two consecutive failed runs.',
    answer,
    file: (p) => (p === 'src/queue.ts' ? text : null),
    callers: (p, start) => (p === 'src/queue.ts' && start === 2 ? { function: 'stopQueue (src/queue.ts:1)', callers: ['src/planner.ts:9', 'src/inquisitor.ts:14'] } : null),
    ...over,
  });
  const quote = (severity: string, evidence: string, claim = 'counts failed runs'): ProofAnswer => ({ verdict: severity === 'info' ? 'APPROVE' : 'REPAIR_REQUIRED', findings: [{ id: 'FR-004', severity, category: 'conformance', location: 'src/queue.ts:2', claim, evidence }], missing: null });

  it('US2.4: a MUST quoted and matched is met, with its file, line range and the callers of its changed function', () => {
    const r = judgeRequirement(requirement(quote('info', '  return failedIssues >= 2;')));
    expect(r).toMatchObject({ id: 'FR-004', status: 'met', quotes: [{ path: 'src/queue.ts', start: 2, end: 2 }], callers: [{ function: 'stopQueue (src/queue.ts:1)', callers: ['src/planner.ts:9', 'src/inquisitor.ts:14'] }] });
  });

  it('US2.1: a MUST the reviewer finds unmet keeps its wording and the quoted line side by side', () => {
    const r = judgeRequirement(requirement(quote('high', '  return failedIssues >= 2;', 'it counts failed issues where the requirement says failed runs')));
    expect(r).toMatchObject({ status: 'unmet', wording: 'The queue MUST stop after two consecutive failed runs.', quotes: [{ path: 'src/queue.ts', start: 2, end: 2, text: '  return failedIssues >= 2;' }] });
    expect(r.reason).toBe('unmet: it counts failed issues where the requirement says failed runs');
  });

  it('US2.2: a MUST whose quote is not in the candidate as quoted is unmet, whatever the reviewer said', () => {
    const r = judgeRequirement(requirement(quote('info', '  return failedRuns >= 2;')));
    expect(r.status).toBe('unmet');
    expect(r.reason).toMatch(/does not match the candidate byte for byte/);
  });

  it('a MUST with no answer, or an answer with no finding for it or no line range, is unmet', () => {
    expect(judgeRequirement(requirement({ verdict: null, findings: [], missing: 'the session failed' })).reason).toBe('no conformance answer: the session failed');
    expect(judgeRequirement(requirement({ verdict: 'APPROVE', findings: [], missing: null })).reason).toBe('the conformance answer has no finding FR-004');
    expect(judgeRequirement(requirement({ verdict: 'APPROVE', findings: [{ ...quote('info', 'x').findings[0]!, location: 'src/queue.ts' }], missing: null })).reason).toBe('the answer quotes no file and line range');
  });

  it('US2.3: a changed behaviour at a caller no requirement covers is an open finding, raised once however many answers name it', () => {
    const caller = { id: 'CALLER-1', severity: 'high', category: 'scope', location: 'src/planner.ts:9', claim: 'the planner now routes bug goals to the inquisitor', evidence: 'route(goal)' };
    const answer: ProofAnswer = { verdict: 'REPAIR_REQUIRED', findings: [...quote('info', '  return failedIssues >= 2;').findings, caller], missing: null };
    const result = judgeProof({ treeHash: 't', criteria: [], requirements: [requirement(answer), requirement(answer, { id: 'FR-005' })], artifacts: { verdict: 'APPROVE', findings: [], missing: null } });
    expect(result.caller_findings).toEqual([{ from: 'FR-004', id: 'CALLER-1', location: 'src/planner.ts:9', sentence: 'route(goal)', claim: 'the planner now routes bug goals to the inquisitor' }]);
    expect(result.requirements[0]!.callers[0]!.callers).toEqual(['src/planner.ts:9', 'src/inquisitor.ts:14']);
    expect(result.open).toContain('CALLER-1 at src/planner.ts:9: the planner now routes bug goals to the inquisitor');
  });
});

describe('the artifact check and the whole judgement (FR-009, FR-010, FR-012)', () => {
  const DOC = { id: 'DOC-1', severity: 'high', category: 'documentation', location: 'docs/decisions/0019.md:12', claim: 'the code no longer retries on 409', evidence: 'A 409 is retried twice.' };

  it('US3.1: each sentence describing behaviour the candidate lacks is a finding with its file, the sentence and the reason', () => {
    const r = judgeProof({ treeHash: 't', criteria: [judgeInput()], requirements: [], artifacts: { verdict: 'REPAIR_REQUIRED', findings: [DOC, { ...DOC, id: 'DOC-2', location: 'PULL-REQUEST', evidence: 'Retries are logged.' }], missing: null } });
    expect(r.artifact_findings.map((f) => [f.id, f.location, f.sentence, f.claim])).toEqual([
      ['DOC-1', 'docs/decisions/0019.md:12', 'A 409 is retried twice.', 'the code no longer retries on 409'],
      ['DOC-2', 'PULL-REQUEST', 'Retries are logged.', 'the code no longer retries on 409'],
    ]);
    expect(r.open).toHaveLength(2);
  });

  it('US3.3: documents that match the candidate give no finding, and with every criterion proven nothing is open', () => {
    const r = judgeProof({ treeHash: 't', criteria: [judgeInput()], requirements: [], artifacts: { verdict: 'APPROVE', findings: [], missing: null } });
    expect(r.artifact_findings).toEqual([]);
    expect(r.open).toEqual([]);
  });

  it('an artifact check that gave no answer is open, never passed', () => {
    expect(judgeProof({ treeHash: 't', criteria: [], requirements: [], artifacts: { verdict: null, findings: [], missing: 'the session failed' } }).open).toEqual(['the artifact check gave no answer: the session failed']);
  });

  it('a person-checked criterion is listed as waiting and opens nothing', () => {
    const r = judgeProof({ treeHash: 't', criteria: [judgeInput({ id: 'AC-2', kind: 'person', tests: [], failBefore: null, audit: null })], requirements: [], artifacts: { verdict: 'APPROVE', findings: [], missing: null } });
    expect(r.criteria[0]!.status).toBe('waiting-on-person');
    expect(r.open).toEqual([]);
  });

  function judgeInput(over: Partial<CriterionInput> = {}): CriterionInput {
    return criterion(over);
  }
});
