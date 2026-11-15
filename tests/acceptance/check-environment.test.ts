/**
 * Issue #166, User Story 1 ("checks run in a checkout that can run them") and the issues behind it:
 * #133 and #158 (a check checkout made again had no installed dependencies, and its check failed with
 * ERR_MODULE_NOT_FOUND, which cost an attempt and a diagnosis) and #132 (the implementer's worktree had no
 * dependencies, so the worker's own check runs were denied installs).
 *
 * User Story 2 ("an environment fault is never briefed as a code defect") and FR-003 follow: a check that dies on a
 * missing module or a missing toolchain is recorded as an environment failure, and no implementer session is started
 * to repair it.
 *
 * The lab repository gets a check that really imports an installed package, so a checkout without the
 * install fails it with node's own ERR_MODULE_NOT_FOUND, not with a line a test printed.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultCheck } from '../../src/policy/config.ts';
import type { OrbitConfig } from '../../src/policy/types.ts';
import { listCandidates, listCheckRuns, listEvidenceReports } from '../../src/evidence/store.ts';
import { listDecisions } from '../../src/storage/decisions.ts';
import { listWorkers } from '../../src/storage/workers.ts';
import { drive, git, makeLab, READY, startLabRun, writeScenario, type Lab } from './helpers/lab.ts';
import { diagnosis, GOAL, GOOD_IMPLEMENTATION, implementer, scenario, SRC_TEXT, TEST_TEXT } from './helpers/scenarios.ts';
import { assertNoVerifiedCandidateExhausted, assertRunInvariants, transitions } from './helpers/invariants.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}

/** A check that cannot run without the dependency install: it imports a package of the lockfile. */
const NEEDS_DEP = "import 'typescript';\nconsole.log('the installed dependency was imported');\n";

/** Put `extra` in front of the demo's own checks, so they are the first to run in a checkout. */
function withChecks(c: OrbitConfig, extra: Record<string, string[]>): void {
  const added = Object.fromEntries(Object.entries(extra).map(([id, command]) => [id, { ...defaultCheck(id), command, category: 'build' as const, timeout_seconds: 120 }]));
  c.checks = { ...added, ...c.checks };
}

function checkLogs(l: Lab, runId: string): string {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.log')) out.push(readFileSync(p, 'utf8'));
    }
  };
  walk(l.runDir(runId));
  return out.join('\n');
}

describe.skipIf(!READY)('acceptance: checks run in a checkout prepared like the baseline (issue #166, User Story 1)', () => {
  it('issue #133, issue #158: a check checkout that is made again gets its dependencies installed again, so no attempt is lost to a missing module', async () => {
    const l = lab({
      files: { 'scripts/needs-dep.mjs': NEEDS_DEP },
      tweak: (c) =>
        withChecks(c, {
          // What the reported runs had: a check that rewrites a tracked file in the candidate's checkout, which makes
          // the controller throw that checkout away and verify in a new one.
          // (the reported repository's `build` rewrote its committed bundle, and its `dist-check` then found no esbuild).
          build: ['sh', '-c', 'case "$PWD" in */check-*) echo "// rewritten by a check" >> src/main.ts ;; esac'],
          'dist-check': ['node', 'scripts/needs-dep.mjs'],
        }),
    });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    // The first candidate was verified: one implementer session, no diagnosis, no repair.
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(listWorkers(db, { runId: run.id, role: 'verifier' })).toHaveLength(0);
    expect(transitions(db, run.id)).not.toContain('DIAGNOSING');
    const [cand] = listCandidates(db, run.id);
    // The checkout really was made again, and the install ran in each of the two.
    const installs = listCheckRuns(db, { runId: run.id, candidateId: cand!.id, checkId: 'orbit-install' }).filter((r) => r.rerunOf === null);
    expect(installs.map((r) => r.status)).toEqual(['PASSED', 'PASSED']);
    expect(listCheckRuns(db, { runId: run.id, candidateId: cand!.id, checkId: 'dist-check' }).map((r) => r.status)).toEqual(['PASSED']);
    expect(listEvidenceReports(db, run.id).at(-1)!.report.verdict).toBe('PASS');
    expect(checkLogs(l, run.id)).not.toMatch(/ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/);
    assertNoVerifiedCandidateExhausted(l.db(), run.id);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('issue #132: the dependencies are installed in the implementer worktree before the worker starts, and never enter the candidate', async () => {
    const l = lab();
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    const [install] = listCheckRuns(db, { runId: run.id, candidateId: null, checkId: 'orbit-worktree-install' });
    expect(install, 'the install plan of the baseline ran in the worktree').toBeDefined();
    expect(install).toMatchObject({ status: 'PASSED', cwd: done.worktreePath });
    const [worker] = listWorkers(db, { runId: run.id, role: 'implementer' });
    expect(install!.startedAt < worker!.spawnedAt!, 'the install ran before the implementer session started').toBe(true);
    expect(listDecisions(db, run.id, { kind: 'preflight.worktree-install' })).toEqual([]);
    // What a worker needs to run the checks it is told to run.
    if (existsSync(done.worktreePath!)) expect(existsSync(join(done.worktreePath!, 'node_modules', 'typescript'))).toBe(true);
    const [cand] = listCandidates(db, run.id);
    expect(git(l.repo, 'ls-tree', '-r', '--name-only', cand!.commitSha).split('\n').filter((p) => p.startsWith('node_modules'))).toEqual([]);
    assertNoVerifiedCandidateExhausted(l.db(), run.id);
    assertRunInvariants(l, run.id);
  }, 180_000);
});

function decisionChecks(l: Lab, runId: string, kind: string): { check_id: string; signals: string[] }[] {
  return listDecisions(l.db(), runId, { kind }).flatMap((d) => ((d.data as { checks?: { check_id: string; signals: string[] }[] } | null)?.checks ?? []));
}

describe.skipIf(!READY)('acceptance: an environment fault is never briefed as a code defect (issue #166, User Stories 1 and 2)', () => {
  it('User Story 1, scenario 2 (issue #141): a baseline where every check fails for one environmental reason blocks at PREFLIGHT and names that reason, before any session starts', async () => {
    const l = lab({
      files: { 'scripts/needs-dep.mjs': NEEDS_DEP },
      tweak: (c) => {
        // Nothing installs the dependencies in a checkout, and every check needs them.
        c.dependencies = { ...c.dependencies, install_existing_lockfile: false, install_command: null };
        c.checks = {};
        withChecks(c, { bundle: ['node', 'scripts/needs-dep.mjs'], 'dist-check': ['node', 'scripts/needs-dep.mjs'] });
      },
    });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(db, run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    expect(done.outcomeReason).toContain('Checks bundle, dist-check could not run on the base revision');
    expect(done.outcomeReason).toContain('the package "typescript" the check imports is not installed where the check runs');
    expect(done.outcomeReason).toContain("Cannot find package 'typescript' imported from");
    expect(done.outcomeReason).toContain('dependencies.install_command');
    expect(decisionChecks(l, run.id, 'baseline.environment-failure').map((c) => [c.check_id, c.signals])).toEqual([['bundle', ['module-not-found']], ['dist-check', ['module-not-found']]]);
    // No attempt was started, and no model was asked anything.
    expect(listWorkers(db, { runId: run.id })).toEqual([]);
    expect(listCandidates(db, run.id)).toEqual([]);
    assertNoVerifiedCandidateExhausted(l.db(), run.id);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('User Story 2: a check that dies with ERR_MODULE_NOT_FOUND on a candidate that did not bring it is an environment failure, and no implementer session is started for it', async () => {
    const l = lab({
      files: { 'scripts/needs-dep.mjs': NEEDS_DEP },
      tweak: (c) =>
        withChecks(c, {
          // The injected fault: the installed dependencies vanish from the candidate's checkout before dist-check runs.
          'clean-cache': ['sh', '-c', 'case "$PWD" in */check-*) rm -f node_modules ;; esac'],
          'dist-check': ['node', 'scripts/needs-dep.mjs'],
        }),
    });
    // A second implementer and a diagnosis are scripted, so a run that briefed the fault as a defect would use them.
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION(), implementer([])], verifier: [diagnosis({ evidence: 'dist-check: Cannot find package typescript', hypothesis: 'the bundle is stale', experiment: 'rebuild', expected: 'dist-check passes', fix: 'rebuild the bundle' })] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(done.outcomeReason).toContain('Check dist-check could not execute on candidate 1, and the output shows an environment cause, not a defect in the change');
    expect(done.outcomeReason).toContain('the package "typescript" the check imports is not installed where the check runs');
    expect(done.outcomeReason).toContain('No repair attempt was spent');
    expect(decisionChecks(l, run.id, 'verification.environment-failure').map((c) => [c.check_id, c.signals])).toEqual([['dist-check', ['module-not-found']]]);
    // The one session that wrote the candidate; none for the fault, and no diagnosis of it.
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(1);
    expect(listWorkers(db, { runId: run.id, role: 'verifier' })).toHaveLength(0);
    const path = transitions(db, run.id);
    expect(path).not.toContain('DIAGNOSING');
    expect(path).not.toContain('REPAIRING');
    // The candidate is not marked defective: no failure of it was diagnosed, and it is kept.
    expect(listCandidates(db, run.id)).toHaveLength(1);
    assertNoVerifiedCandidateExhausted(l.db(), run.id);
    assertRunInvariants(l, run.id);
  }, 180_000);

  it('User Story 2, the other side: a missing module the change itself brought stays a defect and is repaired', async () => {
    const l = lab({
      files: { 'src/build-info.mjs': "console.log('build info');\n" },
      tweak: (c) => withChecks(c, { 'dist-check': ['node', 'src/build-info.mjs'] }),
    });
    const breaks = { op: 'write' as const, path: 'src/build-info.mjs', content: "import 'a-package-nothing-declares';\nconsole.log('build info');\n" };
    const mends = { op: 'write' as const, path: 'src/build-info.mjs', content: "console.log('build info');\n" };
    writeScenario(
      l,
      scenario({
        implementer: [implementer([SRC_TEXT, TEST_TEXT, breaks]), implementer([mends])],
        verifier: [diagnosis({ evidence: "dist-check: Cannot find package 'a-package-nothing-declares'", hypothesis: 'src/build-info.mjs imports a package the repository does not declare', experiment: 'node src/build-info.mjs', expected: 'ERR_MODULE_NOT_FOUND', fix: 'Remove the import from src/build-info.mjs' })],
      }),
    );
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
    expect(listDecisions(db, run.id, { kind: 'verification.environment-failure' })).toEqual([]);
    expect(transitions(db, run.id)).toContain('DIAGNOSING');
    expect(listWorkers(db, { runId: run.id, role: 'implementer' })).toHaveLength(2);
    assertNoVerifiedCandidateExhausted(l.db(), run.id);
    assertRunInvariants(l, run.id);
  }, 240_000);

  it('User Story 2: a check whose toolchain is not installed blocks at PREFLIGHT as an environment failure naming the program', async () => {
    const l = lab({ tweak: (c) => withChecks(c, { 'rust-build': ['sh', '-c', 'cargo-is-not-installed-here build'] }) });
    writeScenario(l, scenario({ implementer: [GOOD_IMPLEMENTATION()] }));
    const run = startLabRun(l, GOAL);
    const done = await drive(l, run.id);
    const db = l.db();

    expect(done.state, done.outcomeReason ?? '').toBe('BLOCKED');
    expect(transitions(db, run.id)).toEqual(['PREFLIGHT', 'BLOCKED']);
    expect(done.outcomeReason).toContain('the program "cargo-is-not-installed-here" was not found where the check runs (exit 127)');
    expect(decisionChecks(l, run.id, 'baseline.environment-failure').map((c) => [c.check_id, c.signals])).toEqual([['rust-build', ['program-not-found']]]);
    expect(listWorkers(db, { runId: run.id })).toEqual([]);
    assertNoVerifiedCandidateExhausted(l.db(), run.id);
    assertRunInvariants(l, run.id);
  }, 180_000);
});
