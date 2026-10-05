/**
 * Fake-provider scripts for acceptance scenarios on examples/demo-app. The
 * running feature is the demo's simple goal: unknown paths answer 404 with
 * the text "Page not found. Try /reports." Variants of it exercise repair,
 * weak proof, scope violations, ambiguity, review and security handling.
 *
 * `$CANDIDATE` and `$FINGERPRINT` are resolved by the fakes from the prompt.
 */
import { ENGINEERING_PRACTICES } from '../../../src/contract/practices.ts';

export const NOT_FOUND_TEXT = 'Page not found. Try /reports.';
export const GOAL = 'Make the not-found response friendlier: unknown paths answer 404 with the plain text "Page not found. Try /reports." Add a unit test for the text.';

export const CHECKS = ['lint', 'unit'];

export interface Criterion {
  key: string;
  statement: string;
  ui?: boolean;
  checks?: string[];
  changes?: [string, string][];
}

export interface Decision {
  question: string;
  options: string[];
  recommendation: string | null;
  material: boolean;
  affected_criteria: string[];
}

const TEXT_CRITERION: Criterion = {
  key: 'text',
  statement: `A request for an unknown path answers 404 with the plain text body "${NOT_FOUND_TEXT}".`,
  changes: [
    ['src/server.ts', 'new body text'],
    ['tests/unit/server.test.ts', 'assert the text'],
  ],
};

export function planner(opts: { criteria?: Criterion[]; decisions?: Decision[]; allowed?: string[]; files?: [string, 'add' | 'modify', string][]; risks?: object[] } = {}): object {
  const criteria = opts.criteria ?? [TEXT_CRITERION];
  return {
    structured: {
      objective: `Answer unknown paths with the text "${NOT_FOUND_TEXT}" (still 404, still plain text).`,
      current_behavior: [{ statement: 'unknown paths get the plain text body "not found"', evidence: ['src/server.ts:28'] }],
      criteria: criteria.map((c) => ({
        key: c.key,
        statement: c.statement,
        mandatory: true,
        ui: c.ui === true,
        proof: [`A unit test asserts: ${c.statement}`],
        check_ids: c.checks ?? CHECKS,
        changes: (c.changes ?? [['src/server.ts', c.key]]).map(([path, summary]) => ({ path, summary })),
      })),
      expected_changed_files: (
        opts.files ?? [
          ['src/server.ts', 'modify', 'new not-found text'],
          ['tests/unit/server.test.ts', 'modify', 'assert the text'],
        ]
      ).map(([path, change, reason]) => ({ path, change, reason })),
      allowed_paths: opts.allowed ?? ['src/server.ts', 'tests/unit/**'],
      required_check_ids: CHECKS,
      non_goals: ['Change the status code or content type', 'Touch the reports page'],
      risks: opts.risks ?? [],
      assumptions: [],
      unresolved_decisions: opts.decisions ?? [],
      material_topics: [],
      practices: ENGINEERING_PRACTICES.map((practice) => ({
        practice,
        applicable: practice === 'behavior-tests' || practice === 'input-validation-and-authorization',
        justification: practice === 'behavior-tests' || practice === 'input-validation-and-authorization' ? 'covered by the planned tests and the existing checks' : `a small handler change does not involve ${practice}`,
      })),
    },
  };
}

export interface Edit {
  op: 'write' | 'replace' | 'delete';
  path: string;
  content?: string;
  find?: string;
  replace?: string;
}

/** The change itself: the new body text. */
export const SRC_TEXT: Edit = { op: 'replace', path: 'src/server.ts', find: "body: 'not found'", replace: `body: '${NOT_FOUND_TEXT}'` };

/** A regression: the new text, but the status becomes 200 (the existing 404 test catches it). */
export const SRC_REGRESSION: Edit = {
  op: 'replace',
  path: 'src/server.ts',
  find: "return { status: 404, type: 'text/plain; charset=utf-8', body: 'not found' };",
  replace: `return { status: 200, type: 'text/plain; charset=utf-8', body: '${NOT_FOUND_TEXT}' };`,
};

/** The repair of SRC_REGRESSION, applied on top of it in the same worktree: status 404 again, text kept. */
export const SRC_FIX_REGRESSION: Edit = { op: 'replace', path: 'src/server.ts', find: SRC_REGRESSION.replace!, replace: `return { status: 404, type: 'text/plain; charset=utf-8', body: '${NOT_FOUND_TEXT}' };` };

const STATUS_LINE = "    assert.equal(handle('/nope', new URLSearchParams()).status, 404);\n";

/** The behaviour test: the existing 404 assertion stays, the text is asserted next to it. */
export const TEST_TEXT: Edit = {
  op: 'replace',
  path: 'tests/unit/server.test.ts',
  find: STATUS_LINE,
  replace: `${STATUS_LINE}    assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n`,
};

/** Weak proof: the existing 404 assertions are deleted and nothing asserts the new text. Green, and proves nothing. */
export const TEST_WEAKENED: Edit = {
  op: 'replace',
  path: 'tests/unit/server.test.ts',
  find: `${STATUS_LINE}    assert.equal(handle('/static/../server.ts', new URLSearchParams()).status, 404);\n`,
  replace: "    handle('/nope', new URLSearchParams());\n",
};

export function implementer(edits: Edit[], opts: { summary?: string; tests?: [string, string][]; refs?: object[]; changed?: [string, string][]; extra?: Record<string, unknown> } = {}): object {
  const tests = opts.tests ?? [['tests/unit/server.test.ts', 'answers 404 for anything else']];
  return {
    edits,
    ...(opts.extra ?? {}),
    structured: {
      summary: opts.summary ?? 'Changed the 404 body and asserted it in the existing server unit test.',
      changed_paths: (opts.changed ?? [...new Set(edits.map((e) => e.path))].map((p) => [p, 'modify'] as [string, string])).map(([path, change]) => ({ path, change, purpose: 'the not-found text' })),
      tests_added: tests.map(([path, name]) => ({ path, name, kind: 'unit', criterion_ids: ['AC-1'] })),
      checks_run: [],
      evidence_refs: opts.refs ?? [],
      remaining_issues: [],
      next_action: { kind: 'request-verification', detail: 'run the trusted checks' },
    },
  };
}

export const GOOD_IMPLEMENTATION = (): object => implementer([SRC_TEXT, TEST_TEXT]);

export const APPROVE = { structured: { verdict: 'APPROVE', candidate_revision: '$CANDIDATE', findings: [] } };

export function review(verdict: 'APPROVE' | 'REPAIR_REQUIRED' | 'REJECT', findings: object[]): object {
  return { structured: { verdict, candidate_revision: '$CANDIDATE', findings } };
}

export function diagnosis(p: { evidence: string; hypothesis: string; alternative?: string; experiment: string; expected: string; fix: string; ruledOut?: boolean }): object {
  const status = p.ruledOut ? 'ruled-out' : 'leading';
  return {
    structured: {
      repair_brief: {
        fingerprint: '$FINGERPRINT',
        evidence: [p.evidence],
        hypotheses: [{ statement: p.hypothesis, supporting: p.evidence, refuting: null }],
        experiment: p.experiment,
        expected_observation: p.expected,
        scoped_fix: p.fix,
        post_fix_checks: CHECKS,
        preserved_constraints: ['Keep every existing assertion in tests/unit/server.test.ts'],
      },
      fingerprint_comparison: { current: '$FINGERPRINT', previous: [], relation: 'first-occurrence', progress: 'unknown', explanation: 'first failure of this kind' },
      competing_hypotheses: [
        { id: 'H1', statement: p.hypothesis, supporting_evidence: [p.evidence], refuting_evidence: [], discriminating_experiment: p.experiment, expected_if_true: p.expected, status, previously_tested: false },
        {
          id: 'H2',
          statement: p.alternative ?? 'the test runner loads a stale copy of src/server.ts',
          supporting_evidence: [],
          refuting_evidence: [p.evidence],
          discriminating_experiment: 'Rerun the failing check on the base revision',
          expected_if_true: 'the same failure on the base revision',
          status: p.ruledOut ? 'ruled-out' : 'alternative',
          previously_tested: false,
        },
      ],
      chosen_hypothesis_id: 'H1',
      confidence: 'high',
    },
  };
}

export const REGRESSION_DIAGNOSIS = diagnosis({
  evidence: "tests/unit/server.test.ts 'answers 404 for anything else': expected 404, got 200",
  hypothesis: 'the not-found branch of handle() now returns status 200 instead of 404',
  experiment: "Call handle('/nope') and read the status",
  expected: 'status 200 where the test expects 404',
  fix: 'Restore status 404 in the not-found branch of handle() in src/server.ts and keep the new text',
});

export const INQUISITOR_EMPTY = { structured: { mode: 'clarify', summary: 'nothing to add', facts: [], assumptions: [], unknowns: [], interpretations: [], questions: [], decisions: [], experiments: [], amendments: [], blocked_criteria: [], continuing_criteria: [] } };

export function scenario(roles: Record<string, object[]>, auth: Partial<{ loggedIn: boolean; authMethod: string; method: string; valid: boolean }> = {}): object {
  return {
    auth: { loggedIn: true, authMethod: 'api_key', method: 'api_key', valid: true, ...auth },
    roles: { planner: [planner()], reviewer: [APPROVE], inquisitor: [INQUISITOR_EMPTY], ...roles },
  };
}
