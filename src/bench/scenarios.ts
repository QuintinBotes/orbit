/**
 * The lab tier of `orbit bench`: one scenario per issue Orbit fixed, each replaying the failure the issue reported on the
 * demo app with the fake providers, and each stating how the run ends now that the issue is fixed. A scenario passes when
 * the run ends that way; a fixed failure that comes back fails the scenario that names its issue. No model is called.
 *
 * Every issue fixed from #172 on adds a scenario here (FR-002 of #172).
 */
import { availableParallelism } from 'node:os';
import type { OrbitConfig } from '../policy/types.ts';
import { TERMINAL_STATES, type RunState } from '../core/run-states.ts';
import { isFailureClass, type FailureClass } from '../controller/failure-class.ts';
import type { ControllerDeps } from '../controller/context.ts';
import { listDecisions } from '../storage/decisions.ts';
import { LabHost, writeLabScenario } from './lab.ts';
import { defaultCheck } from '../policy/config.ts';
import { addAssertion, APPROVE, diagnosis, GOAL, GOOD_IMPLEMENTATION, implementer, NOT_FOUND_TEXT, planner, REGRESSION_DIAGNOSIS, review, scenario, SRC_FIX_REGRESSION, SRC_REGRESSION, SRC_TEXT, TEST_TEXT, TEXT_CRITERION } from './script.ts';
import type { ScenarioRow } from './scorecard.ts';

/** How the run ends now that the issue is fixed. */
export interface LabExpectation {
  state: RunState;
  /** The failure class the run records; null (the default) for a run that ended without one. */
  failureClass?: FailureClass | null;
  /** Implementation attempts the run uses, when the fix is about how many. */
  attempts?: number;
  /** Text the outcome reason contains. */
  reason?: string;
  /** Kinds of decision the run records. */
  decisions?: string[];
}

export interface LabScenario {
  id: string;
  /** The closed Orbit issue the scenario replays. */
  issue: number;
  title: string;
  goal?: string;
  /** The fake providers' steps, by role (tests/fakes/README.md); roles left out get script.ts defaults. */
  roles: Record<string, object[]>;
  auth?: Parameters<typeof scenario>[1];
  files?: Record<string, string>;
  tweak?: (c: OrbitConfig) => void;
  expect: LabExpectation;
}

const LOW = {
  id: 'COR-1',
  severity: 'low',
  category: 'correctness',
  location: 'tests/unit/server.test.ts:20',
  claim: 'The new text is asserted for one unknown path only; a nested unknown path is not covered.',
  evidence: "The unit test calls handle('/nope') and no other unknown path.",
  suggested_validation: "Assert the text for handle('/nope/deeper') as well.",
};
const TEST_1 = {
  id: 'TEST-1',
  severity: 'high',
  category: 'test-adequacy',
  location: 'tests/unit/server.test.ts:20',
  claim: 'The assertions do not establish that every unknown path answers the new text.',
  evidence: 'Only literal paths are asserted; nothing asserts the property for an arbitrary unknown path.',
  suggested_validation: 'Add a test that establishes the property for unknown paths in general.',
};
const DOC_1 = {
  id: 'DOC-1',
  severity: 'medium',
  category: 'documentation',
  location: 'README.md:1',
  claim: 'The README still describes the old not-found text.',
  evidence: 'README.md mentions "not found" as the body of unknown paths.',
  suggested_validation: 'Update the README sentence about unknown paths.',
};
/** The proof checks before delivery under fail_before required (#200): the auditor says the test fails if the criterion were false. */
const AUDIT_FAILS_IF_FALSE = review('APPROVE', [{ id: 'AUDIT-1', severity: 'info', category: 'criterion-audit', location: 'tests/unit/server.test.ts:28', claim: 'The body assertion fails for any other not-found text, so the test would fail if the criterion were false.', evidence: 'assert.equal(...body, ...)', suggested_validation: null }]);
const BUNDLE = { op: 'write' as const, path: 'src/generated/bundle.js', content: `${Array.from({ length: 300 }, (_, i) => `export const line${i} = ${i};`).join('\n')}\n` };

/** A check that cannot run without the dependency install: it imports a package of the lockfile. */
const NEEDS_DEP = "import 'typescript';\nconsole.log('the installed dependency was imported');\n";

/** Put `extra` in front of the demo's own checks, so they are the first to run in a checkout. */
function withChecks(c: OrbitConfig, extra: Record<string, string[]>, mandatory = true): void {
  const added = Object.fromEntries(Object.entries(extra).map(([id, command]) => [id, { ...defaultCheck(id), command, category: 'build' as const, timeout_seconds: 120, mandatory }]));
  c.checks = { ...added, ...c.checks };
}

const STATUS_LINE = "    assert.equal(handle('/nope', new URLSearchParams()).status, 404);\n";
/** A new assertion that holds on the base revision too, so it cannot show the change. */
const TEST_TAUTOLOGY = { op: 'replace' as const, path: 'tests/unit/server.test.ts', find: STATUS_LINE, replace: `${STATUS_LINE}    assert.equal(handle('/nope/again', new URLSearchParams()).status, 404);\n` };

const NEW_TEST_FILE = 'tests/unit/not-found.test.ts';
/** A new test file whose import carries a line-local, import-style lint directive (issue #64). */
const NEW_TEST_WITH_DIRECTIVE = {
  op: 'write' as const,
  path: NEW_TEST_FILE,
  content: `import assert from 'node:assert/strict';\nimport { it } from 'node:test';\nimport { handle } from '../../src/server.ts'; // eslint-disable-line import/first\n\nit('answers unknown paths with the not-found text', () => {\n  assert.equal(handle('/nope', new URLSearchParams()).status, 404);\n  assert.equal(handle('/nope', new URLSearchParams()).body, '${NOT_FOUND_TEXT}');\n});\n`,
};

/** What the demo's checks leave alone but scope inspection never lets through: the policy file and the manifest. */
const WIDEN_POLICY = { op: 'replace' as const, path: '.orbit/config.yaml', find: 'allowed_paths: ["src/**", "tests/**"]', replace: 'allowed_paths: ["**"]' };
const WEAKEN_MANIFEST = { op: 'replace' as const, path: 'package.json', find: '"lint": "tsc --noEmit"', replace: '"lint": "true"' };

/** The review list and fallback alone: the demo's legacy review keys would otherwise decide the fallback. */
function reviewers(c: OrbitConfig, providers: string[], whenUnavailable: 'claude' | 'ask' | 'block'): void {
  c.review = { ...c.review, providers, when_unavailable: whenUnavailable };
  delete c.review.preferred_provider;
  delete c.review.independent_provider_required;
  delete c.review.fallback_same_provider_allowed;
}

/** A reviewer session that exits without an answer. */
const REVIEWER_EXIT = { outcome: 'no_result', exitCode: 1 };
/** The re-reviewer of TEST-1 finds the defect gone. */
const TEST_1_GONE = review('APPROVE', [{ ...TEST_1, severity: 'info', claim: 'TEST-1 no longer holds.', evidence: 'tests/unit/server.test.ts:22 asserts the text for a nested unknown path as well.', suggested_validation: null }]);

export const LAB_SCENARIOS: readonly LabScenario[] = [
  {
    id: 'advisory-finding-repaired',
    issue: 130,
    title: 'a review that asks for repair through an advisory finding only is repaired, and the repaired tree is delivered on an APPROVE',
    roles: {
      implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')], { refs: [{ criterion_id: null, ref: 'tests/unit/server.test.ts', note: 'validation for finding COR-1' }] })],
      reviewer: [review('REPAIR_REQUIRED', [LOW]), APPROVE],
    },
    expect: { state: 'SUCCEEDED', attempts: 2 },
  },
  {
    id: 'turn-cap-diagnosed',
    issue: 144,
    title: 'an attempt whose session ended at its turn cap is diagnosed as unfinished and repaired in the next attempt',
    roles: { implementer: [{ ...(implementer([SRC_REGRESSION]) as object), outcome: 'max_turns' }, implementer([SRC_FIX_REGRESSION, TEST_TEXT])], verifier: [REGRESSION_DIAGNOSIS] },
    expect: { state: 'SUCCEEDED', attempts: 2 },
  },
  {
    id: 'size-denial-blocks',
    issue: 157,
    title: 'the same tree denied for size twice blocks on a person naming the limit instead of spending attempts on it',
    tweak: (c) => void (c.scheduler.hard_limits.changed_lines = 100),
    roles: {
      planner: [planner({ allowed: ['src/server.ts', 'src/generated/**', 'tests/unit/**'], files: [['src/server.ts', 'modify', 'new not-found text'], ['tests/unit/server.test.ts', 'modify', 'assert the text'], ['src/generated/bundle.js', 'add', 'the generated bundle']] })],
      implementer: [implementer([SRC_TEXT, TEST_TEXT, BUNDLE]), implementer([])],
    },
    expect: { state: 'BLOCKED', failureClass: 'scope', attempts: 2, reason: 'The largest changes: src/generated/bundle.js (300 lines)' },
  },
  {
    id: 'verified-candidate-offered',
    issue: 169,
    title: 'a run whose candidate passed verification and that stops on its review round cap ends BLOCKED offering the candidate',
    tweak: (c) => void (c.scheduler.hard_limits.review_rounds = 1),
    roles: { implementer: [GOOD_IMPLEMENTATION()], reviewer: [review('REPAIR_REQUIRED', [TEST_1, DOC_1])] },
    expect: { state: 'BLOCKED', failureClass: 'review-dispute', attempts: 1, reason: 'review_rounds hard cap reached (1 of 1)' },
  },
  {
    id: 'carried-finding-rereviewed',
    issue: 156,
    title: 'a high finding no test settles, carried to the next candidate, gets one re-review; still present with no review round left, the run ends BLOCKED naming it',
    roles: {
      implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')]), implementer([addAssertion('/nope/deepest')])],
      reviewer: [review('REPAIR_REQUIRED', [TEST_1, DOC_1]), review('REPAIR_REQUIRED', [TEST_1, DOC_1]), review('REPAIR_REQUIRED', [TEST_1, DOC_1])],
    },
    expect: { state: 'BLOCKED', failureClass: 'review-dispute', attempts: 2, reason: 'review_rounds hard cap reached (3 of 3) with 2 open finding(s): TEST-1', decisions: ['review.finding-rereview', 'review.finding-rereview.answer'] },
  },
  {
    id: 'rereview-drops-gone-finding',
    issue: 166,
    title: 'a carried finding whose one re-review finds it gone is dropped, the low finding beside it is repaired, and the run delivers on the next APPROVE',
    tweak: (c) => {
      c.scheduler.hard_limits.review_rounds = 4;
      c.scheduler.initial_allowances = { simple_attempts: 4, medium_attempts: 4, complex_attempts: 6 };
    },
    roles: {
      implementer: [GOOD_IMPLEMENTATION(), implementer([addAssertion('/nope/deeper')]), implementer([addAssertion('/nope/deeper/still')])],
      reviewer: [review('REPAIR_REQUIRED', [TEST_1]), review('REPAIR_REQUIRED', [TEST_1, LOW]), TEST_1_GONE, APPROVE],
    },
    expect: { state: 'SUCCEEDED', attempts: 3, decisions: ['review.finding-rereview', 'review.finding.rejected'] },
  },
  {
    id: 'check-checkout-reinstalled',
    issue: 133,
    title: 'a check checkout that is made again gets its dependencies installed again, so the first candidate is verified without losing an attempt',
    files: { 'scripts/needs-dep.mjs': NEEDS_DEP },
    // A check rewrites a tracked file in the candidate's checkout, so the controller verifies in a new one (#133, #158).
    tweak: (c) => withChecks(c, { build: ['sh', '-c', 'case "$PWD" in */check-*) echo "// rewritten by a check" >> src/main.ts ;; esac'], 'dist-check': ['node', 'scripts/needs-dep.mjs'] }),
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'SUCCEEDED', attempts: 1 },
  },
  {
    id: 'baseline-environment-blocks',
    issue: 141,
    title: 'a baseline where every check fails for one environmental reason blocks at PREFLIGHT naming that reason, before any session starts',
    files: { 'scripts/needs-dep.mjs': NEEDS_DEP },
    tweak: (c) => {
      c.dependencies = { ...c.dependencies, install_existing_lockfile: false, install_command: null };
      c.checks = {};
      withChecks(c, { bundle: ['node', 'scripts/needs-dep.mjs'], 'dist-check': ['node', 'scripts/needs-dep.mjs'] });
    },
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'BLOCKED', failureClass: 'environment', attempts: 0, reason: 'could not run on the base revision', decisions: ['baseline.environment-failure'] },
  },
  {
    id: 'missing-module-of-change-repaired',
    issue: 166,
    title: 'a missing module the change itself brought is briefed as the change\'s defect, not the environment\'s, and is repaired',
    files: { 'src/build-info.mjs': "console.log('build info');\n" },
    tweak: (c) => withChecks(c, { 'dist-check': ['node', 'src/build-info.mjs'] }),
    roles: {
      implementer: [
        implementer([SRC_TEXT, TEST_TEXT, { op: 'write', path: 'src/build-info.mjs', content: "import 'a-package-nothing-declares';\nconsole.log('build info');\n" }]),
        implementer([{ op: 'write', path: 'src/build-info.mjs', content: "console.log('build info');\n" }]),
      ],
      verifier: [diagnosis({ evidence: "dist-check: Cannot find package 'a-package-nothing-declares'", hypothesis: 'src/build-info.mjs imports a package the repository does not declare', experiment: 'node src/build-info.mjs', expected: 'ERR_MODULE_NOT_FOUND', fix: 'Remove the import from src/build-info.mjs' })],
    },
    expect: { state: 'SUCCEEDED', attempts: 2 },
  },
  {
    id: 'next-listed-reviewer',
    issue: 116,
    title: 'an independent reviewer that fails at run time is replaced by the next listed reviewer, and the run delivers on its review',
    tweak: (c) => {
      c.providers['codex-b'] = { ...c.providers.codex! };
      reviewers(c, ['codex', 'codex-b'], 'block');
    },
    roles: { implementer: [GOOD_IMPLEMENTATION()], reviewer: [REVIEWER_EXIT, REVIEWER_EXIT, APPROVE] },
    expect: { state: 'SUCCEEDED', attempts: 1, decisions: ['review.reviewer-failed'] },
  },
  {
    id: 'claude-reviews-when-none-independent',
    issue: 8,
    title: 'with no usable independent reviewer and when_unavailable claude, Claude reviews in its own session instead of the run blocking',
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: false };
      reviewers(c, ['codex'], 'claude');
    },
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'SUCCEEDED', attempts: 1, decisions: ['review.select'] },
  },
  {
    id: 'ask-when-none-independent',
    issue: 6,
    title: 'with no usable independent reviewer and when_unavailable ask, the run asks a person instead of failing or substituting',
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: false };
      reviewers(c, ['codex'], 'ask');
    },
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'BLOCKED', failureClass: 'environment', attempts: 1, reason: 'review.when_unavailable is ask, so question' },
  },
  {
    id: 'misconfigured-check-not-an-exception',
    issue: 23,
    title: 'a check whose command names a script the repository does not have is blocked as misconfigured, not offered as a baseline exception',
    tweak: (c) => withChecks(c, { 'type-check': ['npm', 'run', 'tset'] }),
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'BLOCKED', failureClass: 'check-misconfigured', attempts: 0, decisions: ['baseline.check-misconfigured'] },
  },
  {
    id: 'incomplete-base-check-blocks',
    issue: 48,
    title: 'a check whose process vanished on the base revision is reported as not completed, never offered as a pre-existing failure',
    tweak: (c) => withChecks(c, { vanish: ['sh', '-c', 'kill -9 $PPID'] }),
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'BLOCKED', failureClass: 'environment', attempts: 0, reason: 'did not complete on the base revision', decisions: ['baseline.incomplete-check'] },
  },
  {
    id: 'contract-check-unstartable-blocks',
    issue: 36,
    title: 'an optional check the contract requires that cannot start on the base revision blocks at PLANNING, before any implementer session',
    tweak: (c) => withChecks(c, { format: ['acme-formatter-not-installed', '--check'] }, false),
    roles: { planner: [planner({ criteria: [{ ...TEXT_CRITERION, checks: ['lint', 'unit', 'format'] }] })], implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'BLOCKED', failureClass: 'environment', attempts: 0 },
  },
  {
    id: 'judged-tree-not-repaired-again',
    issue: 32,
    title: 'a repair that returns a tree an earlier attempt produced, judged the same, ends the run instead of dispatching another attempt on it',
    roles: { implementer: [implementer([SRC_REGRESSION, TEST_TEXT]), implementer([])], verifier: [REGRESSION_DIAGNOSIS] },
    expect: { state: 'EXHAUSTED', failureClass: 'model', attempts: 2, reason: 'no further attempt is dispatched on it', decisions: ['repair.non-progress'] },
  },
  {
    id: 'import-directive-not-weakening',
    issue: 64,
    title: 'a line-local import-style lint directive on an import in a new test file is not oracle weakening and costs no repair attempt',
    roles: {
      planner: [
        planner({
          criteria: [{ ...TEXT_CRITERION, changes: [['src/server.ts', 'new body text'], [NEW_TEST_FILE, 'assert the text']] }],
          files: [['src/server.ts', 'modify', 'new not-found text'], [NEW_TEST_FILE, 'add', 'assert the text']],
        }),
      ],
      implementer: [implementer([SRC_TEXT, NEW_TEST_WITH_DIRECTIVE], { tests: [[NEW_TEST_FILE, 'answers unknown paths with the not-found text']], changed: [['src/server.ts', 'modify'], [NEW_TEST_FILE, 'add']] })],
    },
    expect: { state: 'SUCCEEDED', attempts: 1 },
  },
  {
    id: 'fail-before-required',
    issue: 65,
    title: 'under fail_before required, new tests that pass on the base revision do not support the criterion, and the repair whose tests fail there does',
    tweak: (c) => void (c.verification.fail_before = 'required'),
    roles: { implementer: [implementer([SRC_TEXT, TEST_TAUTOLOGY]), implementer([TEST_TEXT])], auditor: [AUDIT_FAILS_IF_FALSE], artifacts: [APPROVE] },
    expect: { state: 'SUCCEEDED', attempts: 2, decisions: ['verification.criterion-probe'] },
  },
  {
    id: 'expired-credentials-classified',
    issue: 167,
    title: 'credentials already expired at the start block in PREFLIGHT before any model spend, recorded with the failure class credentials',
    auth: { loggedIn: false },
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'BLOCKED', failureClass: 'credentials', attempts: 0 },
  },
  {
    id: 'cost-cap-classified',
    issue: 167,
    title: 'a model-cost cap too small for an honest completion stops EXHAUSTED before the implementer starts, recorded with the failure class budget',
    tweak: (c) => void (c.scheduler.hard_limits.model_cost_usd = 0.05),
    roles: { implementer: [GOOD_IMPLEMENTATION()] },
    expect: { state: 'EXHAUSTED', failureClass: 'budget', attempts: 0 },
  },
  {
    id: 'protected-edit-classified',
    issue: 167,
    title: 'a candidate that edits the policy file and the manifest is rejected outright, not repaired, and recorded with the failure class scope',
    roles: { implementer: [implementer([SRC_TEXT, TEST_TEXT, WIDEN_POLICY, WEAKEN_MANIFEST])] },
    expect: { state: 'BLOCKED', failureClass: 'scope', attempts: 1, reason: 'policy violation', decisions: ['policy.deny'] },
  },
];

/** What is wrong with a scenario's definition; a scenario with problems is invalid and is not run. */
export function labScenarioProblems(s: LabScenario): string[] {
  const p: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id)) p.push(`id ${JSON.stringify(s.id)} is not lower-case words joined by hyphens`);
  if (!Number.isInteger(s.issue) || s.issue <= 0) p.push('issue is not an issue number');
  if (!s.title.trim()) p.push('title is empty');
  if (!TERMINAL_STATES.has(s.expect.state)) p.push(`expected state ${s.expect.state} is not a terminal state`);
  if (s.expect.failureClass != null && !isFailureClass(s.expect.failureClass)) p.push(`expected failure class ${String(s.expect.failureClass)} is not one of the failure classes`);
  if (s.expect.attempts !== undefined && (!Number.isInteger(s.expect.attempts) || s.expect.attempts < 0)) p.push('expected attempts is not a whole number');
  if (Object.keys(s.roles).length === 0) p.push('no provider steps');
  return p;
}

/** Problems of the catalog as a whole: duplicate ids. Each scenario's own problems make only that scenario invalid. */
export function labCatalogProblems(list: readonly LabScenario[]): string[] {
  const seen = new Set<string>();
  const dup = list.filter((s) => (seen.has(s.id) ? true : (seen.add(s.id), false))).map((s) => s.id);
  return dup.length > 0 ? [`duplicate scenario ids: ${[...new Set(dup)].join(', ')}`] : [];
}

const counter = (db: ReturnType<import('./lab.ts').Lab['db']>, runId: string, name: string): number => db.get<{ used: number }>('SELECT used FROM budget_counters WHERE run_id = ? AND counter = ?', runId, name)?.used ?? 0;

/** Run one scenario in a lab of `host` and judge it against its expectation. */
export async function runLabScenario(host: LabHost, s: LabScenario, extra: Partial<ControllerDeps> = {}, tweak?: (c: OrbitConfig) => void): Promise<ScenarioRow> {
  const row: ScenarioRow = { id: s.id, issue: `#${s.issue}`, title: s.title, result: 'invalid', failure_class: null, end_state: null, attempts: 0, spend_usd: 0, wall_ms: null, delivered: false, problems: labScenarioProblems(s) };
  if (row.problems.length > 0) return row;
  const lab = host.make({
    ...(s.files ? { files: s.files } : {}),
    tweak: (c) => {
      s.tweak?.(c);
      tweak?.(c);
    },
  });
  try {
    writeLabScenario(lab, scenario(s.roles, s.auth));
    const run = await host.run(lab, s.goal ?? GOAL, extra);
    const db = lab.db();
    const e = s.expect;
    const prs = lab.github().state.prs.length;
    Object.assign(row, { failure_class: run.failureClass, end_state: run.state, attempts: counter(db, run.id, 'implementation_attempts'), spend_usd: counter(db, run.id, 'cost_usd'), delivered: run.state === 'SUCCEEDED' });
    const p: string[] = [];
    if (run.state !== e.state) p.push(`ended ${run.state}, expected ${e.state}: ${run.outcomeReason ?? ''}`);
    if (run.failureClass !== (e.failureClass ?? null)) p.push(`failure class ${run.failureClass ?? 'none'}, expected ${e.failureClass ?? 'none'}`);
    if (prs !== (e.state === 'SUCCEEDED' ? 1 : 0)) p.push(`${prs} pull request(s) opened, expected ${e.state === 'SUCCEEDED' ? 1 : 0}`);
    if (e.attempts !== undefined && row.attempts !== e.attempts) p.push(`${row.attempts} implementation attempt(s), expected ${e.attempts}`);
    if (e.reason !== undefined && !(run.outcomeReason ?? '').includes(e.reason)) p.push(`the outcome reason does not say "${e.reason}": ${run.outcomeReason ?? '(none)'}`);
    const kinds = new Set(listDecisions(db, run.id).map((d) => d.kind));
    for (const k of e.decisions ?? []) if (!kinds.has(k)) p.push(`no ${k} decision was recorded`);
    row.problems = p;
    row.result = p.length === 0 ? 'pass' : 'fail';
  } catch (err) {
    row.result = 'fail';
    row.problems = [`the run could not be driven: ${err instanceof Error ? err.message : String(err)}`];
  } finally {
    lab.close();
  }
  return row;
}

export interface LabTierOptions {
  scenarios?: readonly LabScenario[];
  /** Extra controller dependencies and a policy change for every scenario: how a stage is turned off. */
  deps?: Partial<ControllerDeps>;
  tweak?: (c: OrbitConfig) => void;
  /** Scenarios run at once; each has its own repository, state and fake providers. */
  parallel?: number;
  root?: string;
  onRow?: (row: ScenarioRow) => void;
}

/** Run the scenarios, a few at once, and return their rows in catalog order. */
export async function runLabTier(opts: LabTierOptions = {}): Promise<ScenarioRow[]> {
  const list = opts.scenarios ?? LAB_SCENARIOS;
  const catalog = labCatalogProblems(list);
  if (catalog.length > 0) throw new Error(`the lab catalog is invalid: ${catalog.join('; ')}`);
  const host = new LabHost(opts.root);
  const rows: ScenarioRow[] = new Array(list.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < list.length) {
      const i = next++;
      rows[i] = await runLabScenario(host, list[i]!, opts.deps, opts.tweak);
      opts.onRow?.(rows[i]!);
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.parallel ?? defaultParallel(), list.length)) }, worker));
  } finally {
    host.dispose();
  }
  return rows;
}

/** Each lab runs two checks (a type check and a test run) per verification; more than a few at once only queue on the CPU. */
export function defaultParallel(): number {
  return Math.max(1, Math.min(4, availableParallelism() - 1));
}
