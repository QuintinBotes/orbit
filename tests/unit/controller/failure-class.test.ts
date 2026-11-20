// Issue #167: every terminal run stores one failure class from a fixed list, set by deterministic rules from what the
// run recorded (its end state, the structured outcome, the transition's data and the worker-ended events), never from a
// model call and never from the wording of a reason.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FAILURE_CLASSES, TURN_CAP_EVENT, classifyRunEnd, isFailureClass, type FailureClass, type RunEndEvidence } from '../../../src/controller/failure-class.ts';
import { WORKER_ENDED_EVENT } from '../../../src/controller/steps/implementing.ts';
import { TERMINAL_STATES } from '../../../src/core/run-states.ts';

const end = (e: Partial<RunEndEvidence> & Pick<RunEndEvidence, 'state'>): [FailureClass | null, FailureClass | null] => {
  const c = classifyRunEnd({ outcome: null, data: null, cause: null, turnCapSessions: 0, ...e });
  return [c.failureClass, c.secondary];
};

describe('the published list (FR-005)', () => {
  it('schemas/failure-class.schema.json lists exactly the classes the controller stores', () => {
    const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../../../schemas/failure-class.schema.json', import.meta.url)), 'utf8')) as { enum: unknown[] };
    expect(schema.enum).toEqual([...FAILURE_CLASSES]);
    expect([...FAILURE_CLASSES]).toEqual(['environment', 'check-misconfigured', 'gate-deadlock', 'awaiting-decision', 'scope', 'budget', 'turn-cap', 'model', 'review-dispute', 'credentials', 'cancelled']);
  });

  it('recognises its own values and nothing else', () => {
    for (const c of FAILURE_CLASSES) expect(isFailureClass(c)).toBe(true);
    for (const x of ['', 'unknown', 'none', 'Environment', null, undefined, 3]) expect(isFailureClass(x)).toBe(false);
  });

  it('reads the turn cap from the event the implementing step writes', () => {
    expect(TURN_CAP_EVENT).toBe(WORKER_ENDED_EVENT);
  });
});

describe('the end states', () => {
  it('a run that succeeds has no class (US1 scenario 2)', () => {
    expect(end({ state: 'SUCCEEDED', outcome: { tree: 't', evidence_id: 'ev-1' } })).toEqual([null, null]);
    // Not even with turn-capped sessions or a cause the step named on the way.
    expect(end({ state: 'SUCCEEDED', turnCapSessions: 2, cause: 'environment' })).toEqual([null, null]);
  });

  it('a cancelled run is cancelled, whatever the step had decided, and that is not a failure with a second cause', () => {
    expect(end({ state: 'CANCELLED' })).toEqual(['cancelled', null]);
    expect(end({ state: 'CANCELLED', outcome: { state: 'CANCELLED', decided: 'BLOCKED', environment_failures: [{ check_id: 'unit' }] }, turnCapSessions: 1 })).toEqual(['cancelled', null]);
  });

  it('every terminal state gets an answer from the list, or none only for success', () => {
    for (const state of TERMINAL_STATES) {
      const [cls] = end({ state });
      if (state === 'SUCCEEDED') expect(cls).toBeNull();
      else expect(isFailureClass(cls), state).toBe(true);
    }
  });

  it('refuses a state that is not terminal', () => {
    expect(() => end({ state: 'VERIFYING' })).toThrow(/not a terminal state/);
  });
});

// SC-001: one row per scenario of issues #130 to #158 that ends a run, with the class a maintainer would pick.
describe('the scenarios of issues #130 to #158 (SC-001)', () => {
  const rows: { issue: string; what: string; evidence: Partial<RunEndEvidence> & Pick<RunEndEvidence, 'state'>; cls: FailureClass; secondary: FailureClass | null }[] = [
    { issue: '#130', what: 'the review gate cleared no approval and no blocking finding was left to repair', evidence: { state: 'BLOCKED', outcome: { review_gate: ['no approving review'], open_findings: [] } }, cls: 'gate-deadlock', secondary: null },
    { issue: '#131', what: 'the service controller had no provider credential', evidence: { state: 'BLOCKED', outcome: { blocker: { kind: 'authentication', provider: 'claude', state: 'missing' } }, data: { kind: 'authentication', provider: 'claude', state: 'missing' } }, cls: 'credentials', secondary: null },
    { issue: '#132', what: 'the worker sessions were refused by their own environment', evidence: { state: 'BLOCKED', outcome: { worker_refusal: { kind: 'session', what: 'attempt 1' } } }, cls: 'environment', secondary: null },
    { issue: '#133', what: 'a check environment had no dependencies, on the candidate', evidence: { state: 'BLOCKED', outcome: { candidate_id: 'c1', environment_failures: [{ check_id: 'dist-check', signals: ['module-not-found'] }] } }, cls: 'environment', secondary: null },
    { issue: '#140', what: 'workers could not build in their sandbox tier, so the provider kept failing and the retries ran out', evidence: { state: 'EXHAUSTED', data: { counter: 'infrastructure_retries' } }, cls: 'environment', secondary: 'budget' },
    { issue: '#141', what: 'every baseline check failed for one environment reason', evidence: { state: 'BLOCKED', outcome: { base_revision: 'a', environment_failures: [{ check_id: 'unit' }, { check_id: 'lint' }] } }, cls: 'environment', secondary: null },
    { issue: '#142', what: 'a baseline check could not complete because its dependency cache was missing', evidence: { state: 'BLOCKED', outcome: { base_revision: 'a', incomplete_checks: [{ check_id: 'test' }] } }, cls: 'environment', secondary: null },
    { issue: '#142', what: 'a baseline check named a target the base revision does not have', evidence: { state: 'BLOCKED', outcome: { base_revision: 'a', misconfigured_checks: [{ check_id: 'e2e' }] } }, cls: 'check-misconfigured', secondary: null },
    { issue: '#143', what: 'a step kept failing on the state database until the retries ran out', evidence: { state: 'BLOCKED', data: { code: 'INTERNAL' }, cause: 'environment' }, cls: 'environment', secondary: null },
    { issue: '#144', what: 'five attempts were spent while implementer sessions ended at their turn cap', evidence: { state: 'EXHAUSTED', outcome: { fingerprint: 'fp:1' }, turnCapSessions: 3 }, cls: 'turn-cap', secondary: 'budget' },
    { issue: '#144', what: 'the attempt allowance was spent on turn-capped sessions and no extension was granted', evidence: { state: 'EXHAUSTED', outcome: { extension: { granted: false } }, turnCapSessions: 1 }, cls: 'turn-cap', secondary: 'budget' },
    { issue: '#156', what: 'a review finding stuck in claim_pending looped until non-progress', evidence: { state: 'EXHAUSTED', outcome: { non_progress: { terminate: true }, open_findings: [{ id: 'f1', status: 'claim_pending' }] } }, cls: 'review-dispute', secondary: 'budget' },
    { issue: '#156', what: 'the review rounds ran out with findings open', evidence: { state: 'EXHAUSTED', outcome: { open_findings: [{ id: 'f1' }] }, data: { counter: 'review_rounds', used: 4, hard_cap: 4 } }, cls: 'review-dispute', secondary: 'budget' },
    { issue: '#157', what: 'the same tree was denied for size twice', evidence: { state: 'BLOCKED', outcome: { non_progress: { terminate: true }, frozen_policy: { setting: 'scheduler.hard_limits.changed_lines' }, largest_changes: [{ path: 'plugin/dist/orbit.mjs', lines: 9000 }] } }, cls: 'scope', secondary: null },
    { issue: '#157', what: 'a candidate changed a path outside the policy scope', evidence: { state: 'BLOCKED', outcome: { candidate_id: 'c1', scope: { within_scope: false } } }, cls: 'scope', secondary: null },
    { issue: '#158', what: 'mandatory verification could not run in the check checkout', evidence: { state: 'BLOCKED', outcome: { report_id: 'ev-1' }, cause: 'environment' }, cls: 'environment', secondary: null },
  ];
  it.each(rows)('$issue: $what is $cls', ({ evidence, cls, secondary }) => {
    expect(end(evidence)).toEqual([cls, secondary]);
  });
});

describe('the other ways a run ends', () => {
  it('the budget: a cost or wall cap, an admission refusal, and nothing else known', () => {
    expect(end({ state: 'EXHAUSTED', data: { counter: 'cost_usd', used: 5, hard_cap: 5 } })).toEqual(['budget', null]);
    expect(end({ state: 'EXHAUSTED', data: { counter: 'wall_ms' } })).toEqual(['budget', null]);
    expect(end({ state: 'EXHAUSTED', data: { admission: 'not admitted by budget' } })).toEqual(['budget', null]);
    expect(end({ state: 'EXHAUSTED' })).toEqual(['budget', null]);
  });

  it('a crash: the recovery attempts ran out after lost workers or a watchdog abandonment', () => {
    expect(end({ state: 'EXHAUSTED', data: { counter: 'recovery_attempts', trigger: 'watchdog: no heartbeat' }, outcome: { state: 'EXHAUSTED', limit: 'recovery_attempts' } })).toEqual(['environment', 'budget']);
    // The watchdog found a recovery that did not finish: the step names the cause, the records carry no marker.
    expect(end({ state: 'BLOCKED', cause: 'environment' })).toEqual(['environment', null]);
  });

  it('the model: the same failure repeated, no hypothesis left, or no usable output, with nothing else to explain it', () => {
    expect(end({ state: 'EXHAUSTED', outcome: { non_progress: { terminate: true } } })).toEqual(['model', 'budget']);
    expect(end({ state: 'IMPOSSIBLE', outcome: { hypotheses: ['a', 'b'] } })).toEqual(['model', null]);
    expect(end({ state: 'BLOCKED' })).toEqual(['model', null]);
    expect(end({ state: 'BLOCKED', outcome: { problems: ['contract: AC-1 names no proof'] } })).toEqual(['model', null]);
    expect(end({ state: 'EXHAUSTED', cause: 'model' })).toEqual(['model', 'budget']);
  });

  it('a gate nothing the run holds can open: delivery and completion, a review gate, a declined ledger entry', () => {
    expect(end({ state: 'BLOCKED', outcome: { gate: ['no live evidence'], code: 'STALE' } })).toEqual(['gate-deadlock', null]);
    expect(end({ state: 'BLOCKED', outcome: { review_gate: ['r'], shallow_reviews: ['rv-1'] } })).toEqual(['gate-deadlock', null]);
    // A declined entry needs a new run (resume.ts newRunNeeded): its questions were answered, nothing waits on them.
    expect(end({ state: 'BLOCKED', outcome: { ledger_entries: ['l-1'], questions: ['q-2'], ledger_declined: [{ question_id: 'q-2', entries: ['l-1'] }] } })).toEqual(['gate-deadlock', null]);
  });

  it('issue #190: a run that waits for a decision a person gives with orbit decide is awaiting-decision, not a deadlock', () => {
    expect(end({ state: 'BLOCKED', outcome: { blocked_criteria: ['AC-1'], questions: ['q-1'] } })).toEqual(['awaiting-decision', null]);
    expect(end({ state: 'BLOCKED', outcome: { authorization: ['q-auth-1'] } })).toEqual(['awaiting-decision', null]);
    expect(end({ state: 'BLOCKED', outcome: { ledger_entries: ['l-1'], questions: ['q-2'] } })).toEqual(['awaiting-decision', null]);
    expect(end({ state: 'BLOCKED', outcome: { candidate_id: 'c1', fail_before: { passed_before: ['AC-1'] } } })).toEqual(['awaiting-decision', null]);
    // A gate that does not clear comes first; the question is what the run then waits on.
    expect(end({ state: 'BLOCKED', outcome: { review_gate: ['r'], questions: ['q-3'] } })).toEqual(['gate-deadlock', 'awaiting-decision']);
    // An empty list is no marker.
    expect(end({ state: 'BLOCKED', outcome: { questions: [], blocked_criteria: [] } })).toEqual(['model', null]);
  });

  it('a gate by its name: the environment and baseline gates are the environment, the intake gate on a contract is the planner', () => {
    expect(end({ state: 'BLOCKED', outcome: { gate: { gate: 'environment', reasons: ['git is missing'] } } })).toEqual(['environment', null]);
    expect(end({ state: 'BLOCKED', outcome: { gate: { gate: 'baseline', reasons: ['the locked dependency install failed'] } } })).toEqual(['environment', null]);
    expect(end({ state: 'BLOCKED', outcome: { gate: { gate: 'intake', reasons: ['contract: no criterion'] } } })).toEqual(['model', null]);
    expect(end({ state: 'BLOCKED', outcome: { gate: { gate: 'intake', reasons: ['repository does not exist'] } }, cause: 'environment' })).toEqual(['environment', null]);
  });

  it('credentials: a blocker, credentials in the git configuration, an authentication error code', () => {
    expect(end({ state: 'BLOCKED', outcome: { git_credentials: ['remote.origin.url carries a token'] } })).toEqual(['credentials', null]);
    expect(end({ state: 'BLOCKED', data: { code: 'AUTH_EXPIRED' } })).toEqual(['credentials', null]);
  });

  it('error codes: scope and policy denials are scope, a broken setup is the environment', () => {
    expect(end({ state: 'BLOCKED', data: { code: 'SCOPE_VIOLATION' } })).toEqual(['scope', null]);
    expect(end({ state: 'BLOCKED', data: { code: 'POLICY_DENIED' } })).toEqual(['scope', null]);
    for (const code of ['ISOLATION_UNAVAILABLE', 'PROVIDER_UNAVAILABLE', 'POLICY_TAMPERED', 'CONFIG_INVALID', 'CONTRACT_INVALID']) expect(end({ state: 'BLOCKED', data: { code } }), code).toEqual(['environment', null]);
    expect(end({ state: 'BLOCKED', outcome: { attempt: 2, ungranted: ['npm ci'] } })).toEqual(['scope', null]);
  });

  it('issue #190: scope at intake comes from a structured marker, never from a setting a reason was matched to', () => {
    // The planner's paths all lie outside the policy scope (contract/draft.ts), and a policy that allows no paths (the intake gate).
    expect(end({ state: 'BLOCKED', outcome: { problems: { adjustments: [] }, scope: { allowed_paths: ['apps/**'] } } })).toEqual(['scope', null]);
    expect(end({ state: 'BLOCKED', outcome: { gate: { gate: 'intake', reasons: ['x'], details: { problems: [], scope: { allowed_paths: [] } } } }, cause: 'environment' })).toEqual(['scope', null]);
    // finishRun finds frozen_policy.setting by matching the reason's wording (common.ts frozenPolicyCause), so no class reads it.
    expect(end({ state: 'BLOCKED', outcome: { frozen_policy: { setting: 'scope.allowed_paths' } } })).toEqual(['model', null]);
    expect(end({ state: 'BLOCKED', outcome: { frozen_policy: { setting: 'checks.unit.command' } } })).toEqual(['model', null]);
    expect(end({ state: 'BLOCKED', outcome: { frozen_policy: { setting: 'checks.unit.command' }, misconfigured_checks: [{ check_id: 'unit' }] } })).toEqual(['check-misconfigured', null]);
  });

  it('what the records say outranks the cause the step names as a fallback', () => {
    expect(end({ state: 'BLOCKED', data: { code: 'SCOPE_VIOLATION' }, cause: 'environment' })).toEqual(['scope', null]);
  });

  it('issue #169: a run that ran out holding a verified candidate ends BLOCKED and keeps the class it would have had as EXHAUSTED', () => {
    const held = { decided: 'EXHAUSTED', verified_candidate: { candidate_id: 'c1', seq: 1 } };
    expect(end({ state: 'BLOCKED', outcome: held, data: { counter: 'cost_usd', used: 5, hard_cap: 5 } })).toEqual(['budget', null]);
    expect(end({ state: 'BLOCKED', outcome: { ...held, open_findings: [{ id: 'f1' }] }, data: { counter: 'review_rounds' } })).toEqual(['review-dispute', 'budget']);
    expect(end({ state: 'BLOCKED', outcome: { ...held, non_progress: { terminate: true } } })).toEqual(['model', 'budget']);
    expect(end({ state: 'BLOCKED', outcome: held, turnCapSessions: 1, data: { counter: 'implementation_attempts' } })).toEqual(['turn-cap', 'budget']);
    // Any other block is judged as a block: only the step's own EXHAUSTED decision makes a block a run that ran out.
    expect(end({ state: 'BLOCKED', outcome: { decided: 'BLOCKED' } })).toEqual(['model', null]);
    expect(end({ state: 'CANCELLED', outcome: held })).toEqual(['cancelled', null]);
  });
});

describe('two causes (edge case 1)', () => {
  it('records the one that stopped progress first and lists the other as secondary', () => {
    // No reviewer was usable, and then the question that asks for a same-provider review waited for a person.
    expect(end({ state: 'BLOCKED', outcome: { reviewer: { ok: false }, questions: ['q-review-1'] } })).toEqual(['environment', 'awaiting-decision']);
    // Blocking findings stayed open, and so the review gate did not clear.
    expect(end({ state: 'BLOCKED', outcome: { review_gate: ['blocking findings open'], open_findings: [{ id: 'f1' }] } })).toEqual(['review-dispute', 'gate-deadlock']);
    // Misconfigured and environment failures on one baseline: the definition comes first.
    expect(end({ state: 'BLOCKED', outcome: { misconfigured_checks: [{ check_id: 'a' }], environment_failures: [{ check_id: 'b' }] } })).toEqual(['check-misconfigured', 'environment']);
    // Sessions ended at the turn cap long before the wall clock ran out.
    expect(end({ state: 'EXHAUSTED', data: { counter: 'wall_ms' }, turnCapSessions: 1 })).toEqual(['turn-cap', 'budget']);
  });

  it('issue #190: a harness the records mark as broken comes before the turn cap its sessions then ran into', () => {
    // Workers that could not build in their sandbox spin until their cap: the environment stopped the work, not the cap.
    expect(end({ state: 'EXHAUSTED', data: { counter: 'infrastructure_retries' }, turnCapSessions: 1 })).toEqual(['environment', 'turn-cap']);
    expect(end({ state: 'IMPOSSIBLE', outcome: { environment_failures: [{ check_id: 'unit' }], hypotheses: ['a'] }, turnCapSessions: 2 })).toEqual(['environment', 'turn-cap']);
    expect(end({ state: 'EXHAUSTED', outcome: { blocker: { kind: 'authentication' } }, turnCapSessions: 1 })).toEqual(['credentials', 'turn-cap']);
    expect(end({ state: 'EXHAUSTED', outcome: { misconfigured_checks: [{ check_id: 'e2e' }] }, turnCapSessions: 1 })).toEqual(['check-misconfigured', 'turn-cap']);
    // What the work ran into after that still comes after the cap.
    expect(end({ state: 'EXHAUSTED', outcome: { scope: { within_scope: false } }, turnCapSessions: 1 })).toEqual(['turn-cap', 'scope']);
  });

  it('never repeats the primary as the secondary, and keeps one secondary', () => {
    const [cls, secondary] = end({ state: 'EXHAUSTED', outcome: { open_findings: [{ id: 'f1' }], review_gate: ['x'], questions: ['q-1'] }, data: { counter: 'review_rounds' }, turnCapSessions: 2 });
    expect(cls).toBe('turn-cap');
    expect(secondary).toBe('review-dispute');
  });

  it('is deterministic: the same evidence gives the same answer', () => {
    const evidence = { state: 'EXHAUSTED' as const, outcome: { non_progress: { terminate: true }, open_findings: [{ id: 'f' }] }, data: { counter: 'implementation_attempts' }, cause: null, turnCapSessions: 0 };
    expect(classifyRunEnd(evidence)).toEqual(classifyRunEnd(structuredClone(evidence)));
  });
});
