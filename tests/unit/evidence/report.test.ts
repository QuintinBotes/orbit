import { describe, expect, it } from 'vitest';
import { aggregateCheckConfigHash, buildEvidenceReport, evaluateEvidence, type BuildReportInput } from '../../../src/evidence/report.ts';
import { snapshotHash } from '../../../src/policy/snapshot.ts';
import { checkDef } from './fixtures.ts';
import { CANDIDATE, CLEAN_SCOPE, contract, fakeSnapshot, result, standardChecks } from './report-fixtures.ts';

const snapshot = fakeSnapshot(standardChecks());

function build(over: Partial<BuildReportInput> = {}) {
  return buildEvidenceReport({
    contract: contract(),
    candidate: CANDIDATE,
    checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')],
    scope: CLEAN_SCOPE,
    snapshot,
    ...over,
  });
}

describe('buildEvidenceReport: the PASS path', () => {
  it('passes only with every mandatory check clean, every mandatory criterion supported and scope clean', () => {
    const r = build();
    expect(r.verdict).toBe('PASS');
    expect(r.unverified).toEqual([]);
    expect(r.acceptance_evidence).toEqual([
      { criterion_id: 'AC-1', status: 'supported', artifacts: ['tests.log'] },
      { criterion_id: 'AC-2', status: 'supported', artifacts: ['tests.log', 'lint.log'] },
    ]);
    expect(r).toMatchObject({ task_id: 'ORB-001', run_id: 'orb-test-1', attempt: 1, candidate_revision: 'c0ffee', tree_hash: 'tree-a', policy_hash: snapshotHash(snapshot) });
    expect(r.checks).toEqual([
      { id: 'lint', status: 'PASSED', exit_code: 0, flaky: false, log: 'lint.log' },
      { id: 'tests', status: 'PASSED', exit_code: 0, flaky: false, log: 'tests.log' },
    ]);
    expect(r.check_config_hash).toBe(aggregateCheckConfigHash(snapshot, ['tests', 'lint']));
  });

  it('is deterministic', () => {
    expect(JSON.stringify(build())).toBe(JSON.stringify(build()));
  });
});

describe('buildEvidenceReport: unverified criteria never become supported', () => {
  it('blocks PASS for a mandatory criterion with no mapped check, and says so', () => {
    const c = contract({ acceptance_criteria: [...contract().acceptance_criteria, { id: 'AC-3', statement: 'prose only', proof: ['someone looked at it'], mandatory: true }] });
    const r = build({ contract: c });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.acceptance_evidence.find((e) => e.criterion_id === 'AC-3')).toMatchObject({ status: 'unverified' });
    expect(r.unverified.join('\n')).toContain('criterion AC-3: unverified');
  });

  it('lists an optional unverified criterion without blocking PASS', () => {
    const c = contract({ acceptance_criteria: [...contract().acceptance_criteria, { id: 'AC-9', statement: 'nice to have', proof: [], mandatory: false }] });
    const r = build({ contract: c });
    expect(r.verdict).toBe('PASS');
    expect(r.unverified.join('\n')).toContain('optional criterion AC-9');
  });

  it('marks a criterion whose mapped check never ran as unverified, and one whose check failed as unsupported', () => {
    const missing = build({ checkResults: [result(snapshot, 'lint')] });
    expect(missing.acceptance_evidence[0]).toMatchObject({ criterion_id: 'AC-1', status: 'unverified' });
    expect(missing.verdict).toBe('INCOMPLETE');
    const failed = build({ checkResults: [result(snapshot, 'tests', 'FAILED'), result(snapshot, 'lint')] });
    expect(failed.acceptance_evidence.map((e) => e.status)).toEqual(['unsupported', 'unsupported']);
    expect(failed.verdict).toBe('FAIL');
  });

  it('marks a criterion blocked when its check errored or was cancelled', () => {
    const r = build({ checkResults: [result(snapshot, 'tests', 'ERROR'), result(snapshot, 'lint')] });
    expect(r.acceptance_evidence[0]).toMatchObject({ status: 'blocked' });
    expect(r.verdict).toBe('INCOMPLETE');
  });

  it('does not let a UI criterion pass on command checks alone', () => {
    const c = contract({ acceptance_criteria: [{ id: 'AC-UI', statement: 'button works', proof: [], mandatory: true, ui: true }], required_check_ids: ['tests'] });
    const r = build({ contract: c });
    expect(r.acceptance_evidence[0]).toMatchObject({ status: 'unverified' });
    expect(r.acceptance_evidence[0]!.note).toContain('browser');
    expect(r.verdict).toBe('INCOMPLETE');
  });
});

describe('buildEvidenceReport: mandatory checks', () => {
  it('is INCOMPLETE when a mandatory check did not run, and the gap is listed', () => {
    const r = build({ checkResults: [result(snapshot, 'tests')] });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.unverified).toContain('check lint: mandatory but not executed for this candidate');
  });

  it('is FAIL when a mandatory check fails or times out, even if something else is missing', () => {
    expect(build({ checkResults: [result(snapshot, 'tests', 'FAILED'), result(snapshot, 'lint')] }).verdict).toBe('FAIL');
    expect(build({ checkResults: [result(snapshot, 'tests', 'TIMEOUT'), result(snapshot, 'lint')] }).verdict).toBe('FAIL');
    expect(build({ checkResults: [result(snapshot, 'tests', 'FAILED')] }).verdict).toBe('FAIL');
  });

  it('is INCOMPLETE, not FAIL, when a check was cancelled or errored', () => {
    expect(build({ checkResults: [result(snapshot, 'tests', 'CANCELLED'), result(snapshot, 'lint')] }).verdict).toBe('INCOMPLETE');
    expect(build({ checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint', 'ERROR')] }).verdict).toBe('INCOMPLETE');
  });

  it('enforces checks the policy marks mandatory even when the contract does not list them', () => {
    const snap = fakeSnapshot([...standardChecks(), checkDef('build')]);
    const r = build({ snapshot: snap, checkResults: [result(snap, 'tests'), result(snap, 'lint')] });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.unverified).toContain('check build: mandatory but not executed for this candidate');
  });

  it('does not let an optional check decide the verdict, but discloses its failure', () => {
    const snap = fakeSnapshot([...standardChecks(), checkDef('extra', { mandatory: false })]);
    const r = build({ snapshot: snap, checkResults: [result(snap, 'tests'), result(snap, 'lint'), result(snap, 'extra', 'FAILED')] });
    expect(r.verdict).toBe('PASS');
    expect(r.unverified).toContain('optional check extra failed');
  });

  it('uses the latest result when a check ran more than once', () => {
    const older = result(snapshot, 'tests', 'ERROR', { endedAt: 1000 });
    const newer = result(snapshot, 'tests', 'PASSED', { endedAt: 5000, id: 'later' });
    expect(build({ checkResults: [newer, older, result(snapshot, 'lint')] }).verdict).toBe('PASS');
  });
});

describe('buildEvidenceReport: flaky passes', () => {
  const flaky = () => [result(snapshot, 'tests', 'PASSED', { flaky: true }), result(snapshot, 'lint')];

  it('discloses a flaky pass and makes the verdict INCOMPLETE', () => {
    const r = build({ checkResults: flaky() });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.checks.find((c) => c.id === 'tests')).toMatchObject({ status: 'PASSED', flaky: true });
    expect(r.unverified.join('\n')).toContain('check tests: passed only after a rerun');
    expect(r.acceptance_evidence[0]!.status).toBe('unverified');
  });

  it('accepts it when the policy snapshot allows it, still disclosing it', () => {
    const lenient = fakeSnapshot(standardChecks(), (c) => {
      c.verification.allow_flaky_pass = true;
    });
    const r = build({ snapshot: lenient, checkResults: [result(lenient, 'tests', 'PASSED', { flaky: true }), result(lenient, 'lint')] });
    expect(r.verdict).toBe('PASS');
    expect(r.unverified.join('\n')).toContain('accepted by policy');
    expect(r.acceptance_evidence[0]!.status).toBe('supported');
  });
});

describe('buildEvidenceReport: results must be bound to this candidate', () => {
  it.each([
    ['another candidate', (r: ReturnType<typeof result>) => ({ ...r, binding: { ...r.binding, candidateId: 'cand-0' } }), 'a different candidate'],
    ['another tree', (r: ReturnType<typeof result>) => ({ ...r, binding: { ...r.binding, treeHash: 'tree-b' } }), 'a different tree'],
    ['another policy', (r: ReturnType<typeof result>) => ({ ...r, binding: { ...r.binding, policyHash: 'sha256:other' } }), 'a different policy snapshot'],
    ['another check configuration', (r: ReturnType<typeof result>) => ({ ...r, binding: { ...r.binding, checkConfigHash: 'sha256:old' } }), 'a different check configuration'],
  ])('ignores a result bound to %s', (_name, mutate, why) => {
    const r = build({ checkResults: [mutate(result(snapshot, 'tests')), result(snapshot, 'lint')] });
    expect(r.verdict).toBe('INCOMPLETE');
    expect(r.unverified).toContain(`check tests: result is bound to ${why} and was ignored`);
    expect(r.checks.map((c) => c.id)).toEqual(['lint']);
  });
});

describe('buildEvidenceReport: scope', () => {
  it.each([
    ['forbidden path', { forbidden_paths_changed: ['.github/workflows/ci.yml'], allowed_paths_pass: false }, 'scope: forbidden path changed: .github/workflows/ci.yml'],
    ['out of scope path', { out_of_scope_paths_changed: ['infra/x.tf'], allowed_paths_pass: false }, 'scope: out-of-scope path changed: infra/x.tf'],
    ['size limit', { within_size_limits: false, changed_files: 999 }, 'scope: change exceeds the size limits'],
    ['escaping symlink', { symlinks_escaping: ['link'] }, 'scope: symlink escapes the repository: link'],
    ['lockfile change', { lockfile_changed: true }, 'scope: a lockfile changed and policy does not allow lockfile changes'],
    ['manifest change', { dependency_manifest_changed: ['package.json'] }, 'scope: dependency manifests changed and policy does not allow adding packages: package.json'],
  ])('fails on %s', (_name, patch, reason) => {
    const r = build({ scope: { ...CLEAN_SCOPE, ...patch } });
    expect(r.verdict).toBe('FAIL');
    expect(r.scope).toMatchObject(patch);
    expect(evaluateEvidence({ contract: contract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: { ...CLEAN_SCOPE, ...patch }, snapshot }).failReasons.join('\n')).toContain(reason);
  });

  it('allows lockfile and manifest changes when policy allows them', () => {
    const snap = fakeSnapshot(standardChecks(), (c) => {
      c.dependencies.change_lockfile = true;
      c.dependencies.add_packages = true;
    });
    const r = build({ snapshot: snap, checkResults: [result(snap, 'tests'), result(snap, 'lint')], scope: { ...CLEAN_SCOPE, lockfile_changed: true, dependency_manifest_changed: ['package.json'] } });
    expect(r.verdict).toBe('PASS');
  });

  it('needs review (INCOMPLETE) for weakening signals and visual baseline changes', () => {
    const weak = build({ scope: { ...CLEAN_SCOPE, weakening_signals: [{ path: 'a.test.ts', signal: 'skip-added', detail: 'it.skip' }] } });
    expect(weak.verdict).toBe('INCOMPLETE');
    expect(weak.unverified.join('\n')).toContain('possible test weakening in a.test.ts');
    const visual = build({ scope: { ...CLEAN_SCOPE, visual_baseline_changes: ['shots/home.png'] } });
    expect(visual.verdict).toBe('INCOMPLETE');
  });
});

describe('buildEvidenceReport: baseline exceptions', () => {
  const failingTests = (fingerprint = 'fp:known') => [result(snapshot, 'tests', 'FAILED', { fingerprint }), result(snapshot, 'lint')];
  const documented = (checkId = 'tests', fingerprint = 'fp:known') =>
    contract({
      acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: [], mandatory: true, check_ids: ['lint'] }],
      baseline_exceptions: [{ check_id: checkId, fingerprint, reason: 'the suite was already red on main' }],
    });

  it('fails without a recorded exception', () => {
    const c = contract({ acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: [], mandatory: true, check_ids: ['lint'] }] });
    expect(build({ contract: c, checkResults: failingTests() }).verdict).toBe('FAIL');
  });

  it('accepts the failure whose fingerprint equals the recorded one, and discloses that', () => {
    const r = build({ contract: documented(), checkResults: failingTests() });
    expect(r.verdict).toBe('PASS');
    expect(r.unverified.join('\n')).toContain('baseline exception');
  });

  it('does not accept a different failure of the same check, or one with no fingerprint', () => {
    const r = build({ contract: documented(), checkResults: failingTests('fp:new-breakage') });
    expect(r.verdict).toBe('FAIL');
    expect(r.unverified.join('\n')).toContain('not the one recorded');
    const unprinted = [result(snapshot, 'tests', 'FAILED'), result(snapshot, 'lint')];
    expect(build({ contract: documented(), checkResults: unprinted }).verdict).toBe('FAIL');
  });

  it('ignores an assumption that merely claims a baseline exception', () => {
    const c = contract({
      acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: [], mandatory: true, check_ids: ['lint'] }],
      assumptions: [{ id: 'AS-1', statement: 'baseline-exception: tests the suite was already red on main', status: 'supported' }],
    });
    expect(build({ contract: c, checkResults: failingTests() }).verdict).toBe('FAIL');
  });

  it('never lets an excepted failing check support a criterion', () => {
    const c = contract({
      acceptance_criteria: [{ id: 'AC-1', statement: 's', proof: [], mandatory: true, check_ids: ['tests'] }],
      baseline_exceptions: [{ check_id: 'tests', fingerprint: 'fp:known', reason: 'red on main' }],
    });
    const r = build({ contract: c, checkResults: failingTests() });
    expect(r.acceptance_evidence[0]!.status).toBe('unverified');
    expect(r.verdict).toBe('INCOMPLETE');
  });
});

describe('buildEvidenceReport: UI evidence', () => {
  const uiSnapshot = fakeSnapshot([...standardChecks(), checkDef('journey', { kind: 'playwright', command: ['npx', 'playwright', 'test'] })]);
  const uiContract = () =>
    contract({
      required_check_ids: ['tests', 'lint', 'journey'],
      acceptance_criteria: [{ id: 'AC-UI', statement: 'checkout works', proof: [], mandatory: true, ui: true, check_ids: ['journey'] }],
    });
  const base = () => ({ contract: uiContract(), snapshot: uiSnapshot, checkResults: [result(uiSnapshot, 'tests'), result(uiSnapshot, 'lint')], uiRequired: true });

  it('supports a UI criterion from a passing journey', () => {
    const r = build({ ...base(), uiResults: [{ journey: 'checkout', status: 'PASSED', artifacts: ['shots/checkout.png'], checkId: 'journey' }] });
    expect(r.verdict).toBe('PASS');
    expect(r.acceptance_evidence[0]).toMatchObject({ status: 'supported', artifacts: ['shots/checkout.png'] });
    expect(r.ui).toEqual([{ journey: 'checkout', status: 'PASSED', artifacts: ['shots/checkout.png'] }]);
  });

  it('is INCOMPLETE without journeys when UI proof is required, and FAIL when one fails', () => {
    expect(build({ ...base() }).verdict).toBe('INCOMPLETE');
    const failed = build({ ...base(), uiResults: [{ journey: 'checkout', status: 'FAILED', artifacts: [], checkId: 'journey' }] });
    expect(failed.verdict).toBe('FAIL');
    expect(failed.acceptance_evidence[0]!.status).toBe('unsupported');
  });

  it('treats a flaky journey like any other flaky pass', () => {
    const r = build({ ...base(), uiResults: [{ journey: 'checkout', status: 'PASSED', artifacts: [], checkId: 'journey', flaky: true }] });
    expect(r.verdict).toBe('INCOMPLETE');
  });
});

describe('aggregateCheckConfigHash', () => {
  it('depends on the configuration of the named checks only, and not on their order', () => {
    const a = aggregateCheckConfigHash(snapshot, ['tests', 'lint']);
    expect(aggregateCheckConfigHash(snapshot, ['lint', 'tests', 'lint'])).toBe(a);
    const edited = fakeSnapshot([checkDef('tests', { timeout_seconds: 1 }), checkDef('lint')]);
    expect(aggregateCheckConfigHash(edited, ['tests', 'lint'])).not.toBe(a);
    expect(aggregateCheckConfigHash(edited, ['lint'])).toBe(aggregateCheckConfigHash(snapshot, ['lint']));
  });
});

// P2: a green check proves something about the change only when the change could have turned it green.
describe('buildEvidenceReport: green checks that prove nothing about the change', () => {
  const passedAtBase = [
    { checkId: 'tests', status: 'PASSED' as const },
    { checkId: 'lint', status: 'PASSED' as const },
  ];

  it('is INCOMPLETE, with no criterion supported, when the candidate tree is the base tree', () => {
    const e = evaluateEvidence({ contract: contract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot, base: { treeHash: CANDIDATE.treeHash, checks: passedAtBase, changedPaths: [] } });
    expect(e.report.verdict).toBe('INCOMPLETE');
    expect(e.incompleteReasons.join('\n')).toContain('the candidate makes no change');
    expect(e.report.acceptance_evidence.map((a) => a.status)).toEqual(['unverified', 'unverified']);
    expect(e.report.acceptance_evidence[0]!.note).toContain('makes no change');
  });

  it('does not count a check that already passed on the base revision when the candidate adds or changes no test', () => {
    const e = evaluateEvidence({ contract: contract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot, base: { treeHash: 'tree-base', checks: passedAtBase, changedPaths: ['apps/export.mjs'] } });
    expect(e.report.verdict).not.toBe('PASS');
    expect(e.report.acceptance_evidence[0]).toMatchObject({ criterion_id: 'AC-1', status: 'unverified' });
    expect(e.report.acceptance_evidence[0]!.note).toContain('already passed on the base revision');
    expect(e.incompleteReasons.join('\n')).toContain('criterion AC-1: unverified');
  });

  it('does not count a check with no failing result recorded on the base revision either, when no test changed', () => {
    const e = evaluateEvidence({ contract: contract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot, base: { treeHash: 'tree-base', checks: null, changedPaths: ['apps/export.mjs'] } });
    expect(e.report.verdict).toBe('INCOMPLETE');
    expect(e.report.acceptance_evidence.every((a) => a.status === 'unverified')).toBe(true);
    expect(e.report.acceptance_evidence[0]!.note).toContain('no failing result recorded on the base revision');
  });

  it('supports a criterion whose check failed on the base revision and passes now, with or without a test change', () => {
    const e = evaluateEvidence({
      contract: contract(),
      candidate: CANDIDATE,
      checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')],
      scope: CLEAN_SCOPE,
      snapshot,
      base: { treeHash: 'tree-base', checks: [{ checkId: 'tests', status: 'FAILED' }, { checkId: 'lint', status: 'PASSED' }], changedPaths: ['apps/export.mjs'] },
    });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence.map((a) => a.status)).toEqual(['supported', 'supported']);
  });

  it('supports a criterion when the candidate adds or changes a test, even though its checks passed on the base revision', () => {
    const e = evaluateEvidence({ contract: contract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot, base: { treeHash: 'tree-base', checks: passedAtBase, changedPaths: ['apps/export.mjs', 'tests/export.test.mjs'] } });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence.map((a) => a.status)).toEqual(['supported', 'supported']);
  });

  // Issue #30 (ADR 0011): test files of every mainstream language count, by the rules of its test runner.
  const judge = (base: Partial<NonNullable<BuildReportInput['base']>>) =>
    evaluateEvidence({ contract: contract(), candidate: CANDIDATE, checkResults: [result(snapshot, 'tests'), result(snapshot, 'lint')], scope: CLEAN_SCOPE, snapshot, base: { treeHash: 'tree-base', checks: passedAtBase, changedPaths: [], ...base } });
  const dotnet = { dotnetProjects: new Map([['src/Acme', false], ['tests/Acme.Tests', true]]), cargoManifests: new Map<string, boolean>() };

  it('supports a criterion when the candidate changes a file of a .NET test project (issue #30: xunit tests in C#)', () => {
    const e = judge({ changedPaths: ['src/Acme/Calculator.cs', 'tests/Acme.Tests/CalculatorTests.cs'], testLayout: dotnet });
    expect(e.report.verdict).toBe('PASS');
    expect(e.report.acceptance_evidence.map((a) => a.status)).toEqual(['supported', 'supported']);
  });

  it('does not count a test-named C# file of a production project, nor a C# file when the project layout is unknown', () => {
    for (const changedPaths of [['src/Acme/Calculator.cs', 'src/Acme/Test.cs'], ['src/Acme/Calculator.cs', 'src/Acme/CalculatorTests.cs']]) {
      const e = judge({ changedPaths, testLayout: dotnet });
      expect(e.report.verdict, changedPaths.join(' ')).toBe('INCOMPLETE');
      expect(e.report.acceptance_evidence[0]!.note).toContain('the candidate adds or changes no test');
    }
    expect(judge({ changedPaths: ['src/Acme/Calculator.cs', 'tests/Acme.Tests/CalculatorTests.cs'] }).report.verdict).toBe('INCOMPLETE');
  });

  it('supports a criterion when the candidate adds or changes a test by the path conventions of Java, Ruby, PHP, Swift, C++, Elixir and Dart', () => {
    for (const test of ['src/test/java/com/acme/CalculatorTest.java', 'spec/models/user_spec.rb', 'tests/Unit/CalculatorTest.php', 'Tests/AcmeTests/CalculatorTests.swift', 'src/parser_test.cc', 'test/acme/calculator_test.exs', 'test/calculator_test.dart']) {
      expect(judge({ changedPaths: ['src/calc', test] }).report.verdict, test).toBe('PASS');
    }
  });

  it('supports a criterion when a Rust change adds a #[test] function to a source file, or a test to a crate\'s tests/; not when it adds only code', () => {
    const crate = { dotnetProjects: new Map<string, boolean>(), cargoManifests: new Map([['', true]]) };
    const added = (lines: string[]) => ['diff --git a/src/lib.rs b/src/lib.rs', '--- a/src/lib.rs', '+++ b/src/lib.rs', '@@ -1,1 +1,4 @@', ...lines.map((l) => `+${l}`)].join('\n');
    expect(judge({ changedPaths: ['src/lib.rs'], testLayout: crate, diffs: new Map([['src/lib.rs', added(['#[test]', 'fn mul_works() { assert_eq!(mul(2, 3), 6); }'])]]) }).report.verdict).toBe('PASS');
    expect(judge({ changedPaths: ['src/lib.rs', 'tests/mul.rs'], testLayout: crate }).report.verdict).toBe('PASS');
    expect(judge({ changedPaths: ['src/lib.rs'], testLayout: crate, diffs: new Map([['src/lib.rs', added(['pub fn mul(a: i32, b: i32) -> i32 { a * b }'])]]) }).report.verdict).toBe('INCOMPLETE');
    expect(judge({ changedPaths: ['src/lib.rs'], testLayout: crate }).report.verdict).toBe('INCOMPLETE');
  });
});

// P27: evidence names a file a person can open, not a bare log name.
describe('buildEvidenceReport: artifact paths', () => {
  it('gives artifacts and check logs as paths relative to the run directory when it is known', () => {
    const r = build({ runDir: '/runs', uiResults: [] });
    expect(r.acceptance_evidence[0]!.artifacts).toEqual(['evidence/1/tests.log']);
    expect(r.checks.map((c) => c.log)).toEqual(['evidence/1/lint.log', 'evidence/1/tests.log']);
  });
});
