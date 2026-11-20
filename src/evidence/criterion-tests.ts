/**
 * Fail-before per criterion (issue #200, FR-003 and FR-004; the ADR 0014 addendum of 2026-11-20). Under
 * `verification.fail_before: required`, a contract whose plan maps tests to criteria has each criterion judged by its own
 * tests, never by a check-wide run: each mapped test file runs alone, through its check's trusted `tests_command` with
 * the path appended, so the outcome is still read from an exit status alone (ADR 0014's constraint). It runs on the base
 * revision with the candidate's test-owned paths (CRITERION_PROBE) and on the candidate (CRITERION_CANDIDATE).
 *
 * - change (the default): each mapped test fails on the base tree and passes on the candidate.
 * - keep: each mapped test passes on both trees; it shows that behaviour held before and still holds.
 * - person: no test can prove it; it is never probed and never counts as proven by a test.
 *
 * A criterion with no mapped test, or a test no check can run alone, is not established: only a person may accept it.
 */
import { sha256 } from '../core/hash.ts';
import type { AcceptanceCriterion, CriterionKind, GoalContract } from '../contract/types.ts';
import { safeTestPath } from '../contract/validate.ts';
import type { CheckDefinition, FailBeforeMode, PolicySnapshot } from '../policy/types.ts';
import { acceptableCause, checkDir, isTestCommandCheck, listedPaths, underCheck, type CheckProbe, type NotEstablishedCause } from './fail-before.ts';
import type { CriterionFailBefore } from './types.ts';

export function criterionKind(c: Pick<AcceptanceCriterion, 'kind'>): CriterionKind {
  return c.kind ?? 'change';
}

/** Whether the contract's plan maps tests to criteria: then, under `required`, each criterion's fail-before is its own. */
export function mapsTests(contract: Pick<GoalContract, 'acceptance_criteria'>): boolean {
  return contract.acceptance_criteria.some((c) => c.tests !== undefined);
}

/** One mapped test of a criterion: the check that runs it alone (its probe unit), or why none can. */
export interface CriterionTest {
  path: string;
  checkId: string | null;
  /** The id the test's run alone is recorded under (unitIdFor); null when it cannot run. */
  unitId: string | null;
  problem: string | null;
}

export interface CriterionTests {
  criterionId: string;
  kind: CriterionKind;
  tests: CriterionTest[];
}

/** A check id for one test file run alone: the check's id and a hash of the path, safe in a file name. */
export function unitIdFor(checkId: string, path: string): string {
  return `${checkId.slice(0, 40)}.t-${sha256(path).slice(0, 12)}`;
}

/** Each criterion's mapped tests, with the check that runs each alone. Person-checked criteria have none to run. */
export function criterionTests(contract: Pick<GoalContract, 'acceptance_criteria'>, snapshot: Pick<PolicySnapshot, 'config'>, isTestOwned: (path: string) => boolean): CriterionTests[] {
  return contract.acceptance_criteria.map((c) => {
    const kind = criterionKind(c);
    if (kind === 'person') return { criterionId: c.id, kind, tests: [] };
    const tests = [...new Set(c.tests ?? [])].map((path): CriterionTest => {
      if (!safeTestPath(path)) return { path, checkId: null, unitId: null, problem: `${path} is not a repository-relative path` };
      if (!isTestOwned(path)) return { path, checkId: null, unitId: null, problem: `${path} is not a test file, so it cannot prove ${c.id} on its own` };
      const runners = (c.check_ids ?? []).filter((id) => {
        const def = snapshot.config.checks[id];
        return isTestCommandCheck(def) && (def.tests_command?.length ?? 0) > 0 && underCheck(path, def);
      });
      // The argument is the path relative to the check's cwd, so it is that path that must not read as an option.
      const checkId = runners.find((id) => safeTestPath(relativeToCheck(snapshot.config.checks[id]!, path)));
      if (checkId === undefined) {
        const problem = runners.length > 0 ? `${path} is "${relativeToCheck(snapshot.config.checks[runners[0]!]!, path)}" in check ${runners[0]}'s directory, which its tests_command would read as an option` : `no check ${c.id} cites has a tests_command that runs ${path} alone`;
        return { path, checkId: null, unitId: null, problem };
      }
      return { path, checkId, unitId: unitIdFor(checkId, path), problem: null };
    });
    return { criterionId: c.id, kind, tests };
  });
}

/** The definition that runs one test file alone: the check's own, with its tests_command and the path relative to its cwd. */
export function criterionTestDefinition(def: CheckDefinition, unitId: string, path: string): CheckDefinition {
  return { ...def, id: unitId, command: [...def.tests_command!, relativeToCheck(def, path)], shell: false, flaky_reruns: 0 };
}

function relativeToCheck(def: Pick<CheckDefinition, 'cwd'>, path: string): string {
  const dir = checkDir(def);
  return dir === '' ? path : path.slice(dir.length + 1);
}

export interface CriterionProbes {
  mode: FailBeforeMode;
  /** The base-tree probe's results by unit id, and its tree; null when it did not run. */
  base: { tree: string | null; checks: ReadonlyMap<string, CheckProbe> } | null;
  /** The candidate probe's results by unit id; null when it did not run. */
  candidate: ReadonlyMap<string, CheckProbe> | null;
  /** Why no probe ran, when none did. */
  skipped: { cause: NotEstablishedCause; reason: string } | null;
  accepted: readonly { criterionId: string; questionId: string; by: string }[];
}

type TestOutcome = 'failed' | 'passed' | 'not-established';

const onTree = (p: CheckProbe | undefined): TestOutcome => (p === undefined || p.outcome === 'not-established' ? 'not-established' : p.outcome === 'failed-before' ? 'failed' : 'passed');

/**
 * A criterion's own fail-before entry: failed-before (change) or kept (keep) when each mapped test did what its kind
 * needs on both trees; passed-before when one decisively did not (a change test passed on the base tree or failed on the
 * candidate, a keep test failed on either), which goes to repair; otherwise not established, which only a person may accept.
 */
export function criterionProofEntry(c: CriterionTests, p: CriterionProbes): CriterionFailBefore {
  const accepted = p.accepted.find((a) => a.criterionId === c.criterionId);
  const acceptance = accepted ? { accepted: { question_id: accepted.questionId, by: accepted.by } } : {};
  const base = { mode: p.mode, probe_tree: p.base?.tree ?? null, test_paths: listedPaths(c.tests.map((t) => t.path)) };
  if (c.kind === 'person') return { ...base, outcome: 'not-applicable', checks: [], reason: `${c.criterionId} is person-checked: no test can prove it, and it waits on a person` };
  if (c.tests.length === 0) return { ...base, outcome: 'not-established', cause: 'not-probed', checks: [], tests: [], reason: `no test is mapped to ${c.criterionId}, so nothing shows that it fails without the change`, ...acceptance };
  const checks: CriterionFailBefore['checks'] = [];
  const tests: NonNullable<CriterionFailBefore['tests']> = [];
  const decisive: string[] = [];
  const open: { reason: string; cause: NotEstablishedCause }[] = [];
  for (const t of c.tests) {
    if (t.problem !== null || t.unitId === null) {
      tests.push({ path: t.path, check_id: t.checkId, base: 'not-established', candidate: 'not-established', reason: t.problem ?? `${t.path} cannot run alone` });
      open.push({ reason: t.problem ?? `${t.path} cannot run alone`, cause: 'not-probed' });
      continue;
    }
    const b = p.base?.checks.get(t.unitId);
    const k = p.candidate?.get(t.unitId);
    if (b) checks.push({ id: `${t.checkId}:${t.path}`, outcome: b.outcome, ...(b.cause ? { cause: b.cause } : {}), attempts: b.attempts.map((a) => ({ status: a.status, exit_code: a.exitCode, log: a.log })) });
    const onBase = onTree(b);
    const onCandidate = onTree(k);
    const want: TestOutcome = c.kind === 'keep' ? 'passed' : 'failed';
    let reason: string;
    if (onBase !== 'not-established' && onBase !== want) {
      reason = c.kind === 'keep' ? `${t.path} fails on the base revision, so ${c.criterionId} is not behaviour that held before` : `${t.path} passes on the base revision with the new tests, so it does not show the change`;
      decisive.push(reason);
    } else if (onCandidate === 'failed') {
      reason = `${t.path} fails on the candidate when it runs alone`;
      decisive.push(reason);
    } else if (onBase === 'not-established' || onCandidate === 'not-established') {
      const why = onBase === 'not-established' ? (b?.reason ?? p.skipped?.reason ?? `${t.path} was not run on the base revision`) : (k?.reason ?? p.skipped?.reason ?? `${t.path} was not run on the candidate`);
      const cause = (onBase === 'not-established' ? b?.cause : k?.cause) ?? p.skipped?.cause ?? 'not-probed';
      reason = why;
      open.push({ reason: why, cause });
    } else {
      reason = c.kind === 'keep' ? `${t.path} passes on the base revision and on the candidate` : `${t.path} fails on the base revision with the new tests and passes on the candidate`;
    }
    tests.push({ path: t.path, check_id: t.checkId, base: onBase, candidate: onCandidate, reason });
  }
  if (decisive.length > 0) return { ...base, outcome: 'passed-before', checks, tests, reason: `the mapped tests do not show ${c.criterionId}: ${decisive.join('; ')}`, ...acceptance };
  if (open.length > 0) {
    const cause = open.map((o) => o.cause).find((x) => !acceptableCause(x)) ?? open[0]!.cause;
    return { ...base, outcome: 'not-established', cause, checks, tests, reason: [...new Set(open.map((o) => o.reason))].join('; '), ...(open.every((o) => acceptableCause(o.cause)) ? acceptance : {}) };
  }
  return { ...base, outcome: c.kind === 'keep' ? 'kept' : 'failed-before', checks, tests, reason: tests.map((t) => t.reason).join('; ') };
}
