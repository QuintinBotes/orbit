// A review finding a repair addressed is resolved by the repair's test only when the test discriminates (ADR 0015): the
// required command checks of category test that passed on the repaired tree, and cleanly on the pre-repair candidate,
// run on two probe trees built from the pre-repair candidate's tree: a control tree with the repair's test-owned files
// but the tests named for findings, and the finding's tree, the control tree with the tests named for the finding. The
// finding is resolved only by a check that PASSED on the control tree, FAILED on the finding's tree on every attempt
// with no environment signal, and PASSED on the repaired tree, so the failure is the finding's own tests'. Exit statuses
// alone decide: nothing reads the test output to tell which tests ran. A lint, typecheck or build check never resolves
// a finding (the 0.3.0 retest closed a high test-quality finding on "new_test lint PASSED"), and a reviewer who raises
// the finding again on a tree that has the repair's test is not overridden by it. These replace the log-reading rules
// of 0.3.1, which three adversarial reviews broke, and close the holes a fourth found in the first probe rule: a skipped
// test credited with another test's failure, a check that never runs the named test, a pre-repair tree that fails on
// its own, TEST-1 matched inside TEST-10, and a test a later review held insufficient credited on a later tree.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const { snapshotCandidate } = await import('../../../src/evidence/candidate.ts');
const { listFindings, listReviews, recordReview } = await import('../../../src/review/store.ts');
const { planWorker } = await import('../../../src/storage/workers.ts');
const { listDecisions } = await import('../../../src/storage/decisions.ts');
const { getRun } = await import('../../../src/controller/run-store.ts');
const { REVIEW_REPAIR_EVENT, reviewingStep } = await import('../../../src/controller/steps/reviewing.ts');
const { listProbeAttempts } = await import('../../../src/evidence/fail-before.ts');
const { listCheckRuns } = await import('../../../src/evidence/store.ts');
const { defaultCheck } = await import('../../../src/policy/config.ts');
const { addEvidence, giveRepository, initLedger, makeUnitLab, okResult, OWNER, scriptedAdapter, setContract, validateModels } = await import('./coverage-helpers.ts');
type UnitLab = import('./coverage-helpers.ts').UnitLab;
type IngestedFinding = import('../../../src/review/types.ts').IngestedFinding;
type ProviderAdapter = import('../../../src/adapters/types.ts').ProviderAdapter;
type CheckCategory = import('../../../src/policy/types.ts').CheckCategory;
type CandidateRecord = import('../../../src/evidence/store.ts').CandidateRecord;

let lab: UnitLab;
afterEach(() => {
  if (lab && existsSync(lab.base)) execFileSync('chmod', ['-R', 'u+w', lab.base]);
  lab?.cleanup();
});

const claude = (): ProviderAdapter =>
  ({
    id: 'claude',
    discoverCapabilities: async () => ({ provider: 'claude', available: true, version: '1', models: [], structuredOutput: true, readOnlySandbox: true, usageReporting: 'full', costReporting: true, detail: '' }),
    validateCredentials: async () => ({ state: 'valid', method: 'api_key', detail: 'ok' }),
  }) as unknown as ProviderAdapter;

const TEST_1: IngestedFinding = {
  externalId: 'TEST-1',
  severity: 'high',
  category: 'correctness',
  location: 'apps/calc.mjs:2',
  path: 'apps/calc.mjs',
  line: 2,
  claim: 'mul accepts a string and returns NaN instead of throwing a TypeError (TEST-1)',
  evidence: 'mul("a", 2) evaluates "a" * 2, which is NaN',
  suggestedValidation: 'Add a test asserting that mul("a", 2) throws a TypeError',
};
const TEST_2: IngestedFinding = { ...TEST_1, externalId: 'TEST-2', claim: 'mul accepts null and returns 0 instead of throwing a TypeError (TEST-2)', evidence: 'mul(null, 2) is 0', suggestedValidation: 'Add a test asserting that mul(null, 2) throws a TypeError' };

const revisionOf = (prompt: string): string => prompt.match(/candidate revision ([0-9a-f]{40})/)?.[1] ?? '0'.repeat(40);

const ADD_TEST = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../../apps/calc.mjs';\ntest('add(2, 3) is 5', () => assert.equal(add(2, 3), 5));\n";
/** The base revision: add and its test, run by `node --test`. */
const BASE_FILES = { 'apps/calc.mjs': 'export const add = (a, b) => a + b;\n', 'tests/unit/add.test.mjs': ADD_TEST };
/** The reviewed candidate: mul takes anything. */
const PRE_REPAIR = 'export const add = (a, b) => a + b;\nexport const mul = (a, b) => a * b;\n';
/** The repair: mul throws a TypeError for anything but numbers. */
const REPAIRED = "export const add = (a, b) => a + b;\nexport const mul = (a, b) => {\n  if (typeof a !== 'number' || typeof b !== 'number') throw new TypeError('mul takes numbers');\n  return a * b;\n};\n";

const nodeTest = (title: string, body: string, opts = '') => `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { mul } from '../../apps/calc.mjs';\ntest(${JSON.stringify(title)},${opts ? ` ${opts},` : ''} () => ${body});\n`;
/** Fails on the pre-repair tree (no TypeError) and passes on the repaired one. */
const DISCRIMINATING = nodeTest('mul rejects a string (TEST-1)', "assert.throws(() => mul('a', 2), TypeError)");
/** The same test, skipped: node:test exits 0 on any tree. */
const SKIPPED = nodeTest('mul rejects a string (TEST-1)', "assert.throws(() => mul('a', 2), TypeError)", '{ skip: true }');

interface Unit {
  category?: CheckCategory;
  cwd?: string;
  command?: string[];
}

/** How a check's latest run ended on a candidate: a flaky pass is a pass that needed a rerun. */
type Ran = 'PASSED' | 'FAILED' | 'flaky';

interface Setup {
  unit?: Unit;
  /** More required test checks, by id. */
  more?: Record<string, Unit>;
  /** apps/calc.mjs on the reviewed, pre-repair tree; PRE_REPAIR when absent. */
  calc?: string;
  /** Other files of the pre-repair tree, by path. */
  files?: Record<string, string>;
  /** How each check's latest run ended on the pre-repair candidate; a clean pass when absent. */
  before?: Record<string, Ran>;
}

type Repo = Awaited<ReturnType<typeof giveRepository>>;
let checkIds: string[] = [];

/** The checks: lint first, so a resolution that takes the first passing required check takes lint. */
async function setup(o: Setup = {}) {
  const tests: Record<string, Unit> = { unit: o.unit ?? {}, ...(o.more ?? {}) };
  lab = makeUnitLab({
    path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING', 'VERIFYING', 'REVIEWING'],
    deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } },
    tweak: (c) => {
      c.providers.codex = { ...c.providers.codex!, data_policy_eligible: true, model: 'gpt-6-astra' };
      c.checks = { lint: { ...defaultCheck('lint'), command: [process.execPath, '-e', '0'], timeout_seconds: 60, category: 'lint' } };
      for (const [id, u] of Object.entries(tests)) c.checks[id] = { ...defaultCheck(id), command: u.command ?? [process.execPath, '--test'], timeout_seconds: 60, category: u.category ?? 'test', cwd: u.cwd ?? '.' };
    },
  });
  const reviewer = scriptedAdapter(lab, ({ spec }: { spec: { prompt: string } }) => okResult({ verdict: 'APPROVE', candidate_revision: revisionOf(spec.prompt), findings: [] }));
  lab.deps.adapters = { claude: claude(), codex: reviewer };
  validateModels(lab);
  for (const e of lab.deps.registry.list()) if (e.provider === 'codex') lab.deps.registry.markAvailability(e.modelId, 'codex-cli', true, 'test');
  const repo = await giveRepository(lab, BASE_FILES);
  checkIds = ['lint', ...Object.keys(tests)];
  setContract(lab, { baseline_revision: repo.base, allowed_paths: ['apps/calc.mjs', 'tests/**'], required_check_ids: checkIds, acceptance_criteria: [{ id: 'AC-1', statement: 'mul(a, b) returns the product', proof: ['tests/unit/mul.test.mjs'], mandatory: true, check_ids: Object.keys(tests) }] });
  initLedger(lab);
  const cand = await candidate(repo, 1, { 'apps/calc.mjs': o.calc ?? PRE_REPAIR, ...(o.files ?? {}) }, Object.fromEntries(checkIds.map((id) => [id, o.before?.[id] ?? 'PASSED'])));
  return { cand, repo };
}

/** The candidate of `attempt` with `files` written, and the latest run of each check in `ran` on its tree. */
async function candidate(repo: Repo, attempt: number, files: Record<string, string>, ran: Record<string, Ran>): Promise<CandidateRecord> {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo.worktree, path)), { recursive: true });
    writeFileSync(join(repo.worktree, path), text);
  }
  const c = await snapshotCandidate({ db: lab.db, clock: lab.clock, repoRoot: lab.repo, worktree: repo.worktree, runId: lab.runId, baseRev: repo.base, attempt, workerId: null });
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.attempt', 'x', ?)", lab.runId, attempt, JSON.stringify({ attempt }));
  lab.db.run("INSERT INTO events (run_id, ts, type, actor, data_json) VALUES (?, ?, 'implementation.candidate', 'x', ?)", lab.runId, attempt, JSON.stringify({ attempt, candidate_id: c.id }));
  addEvidence(lab, c, { attempt, checks: checkIds.map((id) => ({ id, status: 'PASSED' as const, exit_code: 0, flaky: false, log: `evidence/${attempt}/${id}.log` })) });
  lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
  for (const [i, [id, how]] of Object.entries(ran).entries()) {
    lab.db.run(
      "INSERT INTO check_runs (id, run_id, candidate_id, check_id, kind, tree_hash, check_config_hash, policy_hash, command_json, cwd, isolation, status, exit_code, flaky, log_path, log_sha256, started_at) VALUES (?, ?, ?, ?, 'command', ?, 'c', 'p', '[]', '.', 'none', ?, ?, ?, NULL, ?, ?)",
      `cr-${attempt}-${id}`,
      lab.runId,
      c.id,
      id,
      c.treeHash,
      how === 'FAILED' ? 'FAILED' : 'PASSED',
      how === 'FAILED' ? 1 : 0,
      how === 'flaky' ? 1 : 0,
      `${i + 1}`.repeat(64),
      attempt * 10 + i,
    );
  }
  return c;
}

/** The fingerprint each finding was sent to repair under, by external id. */
function fingerprints(): Map<string, string> {
  const rows = lab.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, REVIEW_REPAIR_EVENT);
  return new Map(rows.flatMap((r) => (JSON.parse(r.data_json) as { findings: { external_id: string; fingerprint: string }[] }).findings.map((f) => [f.external_id, f.fingerprint] as const)));
}

/** The implementer's report of `attempt`, naming the given tests for each finding (by external id) as the brief asks. */
function report(repo: Repo, attempt: number, named: Record<string, string[]>): void {
  const fps = fingerprints();
  const refs = Object.entries(named).flatMap(([ext, paths]) => paths.map((path) => ({ path, note: `validation for finding ${ext} (${fps.get(ext)})` })));
  reportAs(repo, attempt, refs, refs.map((r) => ({ path: r.path, name: r.note })));
}

/** The implementer's report of `attempt` with these evidence_refs and tests_added, written as given. */
function reportAs(repo: Repo, attempt: number, refs: { path: string; note: string }[], tests: { path: string; name: string }[]): void {
  const w = planWorker(lab.db, { id: `wrk-impl-${attempt}`, runId: lab.runId, role: 'implementer', provider: 'claude', workerDir: join(lab.base, `wi${attempt}`), cwd: repo.worktree, attempt }, lab.clock, OWNER);
  const out = {
    summary: 's',
    changed_paths: [...new Set([...refs, ...tests].map((r) => r.path))].map((path) => ({ path, change: 'add', purpose: 'validation test' })),
    tests_added: tests.map((t) => ({ path: t.path, name: t.name, kind: 'unit', criterion_ids: [] })),
    checks_run: [],
    evidence_refs: refs.map((r) => ({ criterion_id: null, ref: r.path, note: r.note })),
    remaining_issues: [],
    next_action: { kind: 'request-verification', detail: 'd' },
  };
  lab.db.run("UPDATE workers SET state = 'SUCCEEDED', result_json = ? WHERE id = ?", JSON.stringify({ structured: out }), w.id);
}

const run = () => reviewingStep(lab.ctx());
const state = () => getRun(lab.db, lab.runId).state;
const blocking = (f: { resolutionJson: unknown }): unknown => (f.resolutionJson as { blocking?: unknown } | null)?.blocking;

function record(cand: { id: string; treeHash: string }, verdict: 'APPROVE' | 'REPAIR_REQUIRED', findings: IngestedFinding[] = []) {
  const n = listReviews(lab.db, lab.runId, { includeInvalidated: true }).length + 1;
  return recordReview(lab.db, { id: `rev-${n}`, runId: lab.runId, candidateId: cand.id, treeHash: cand.treeHash, round: n, provider: 'codex', model: null, workerId: null, verdict, packetSha256: null, findings }, lab.clock);
}

interface Flow {
  setup?: Setup;
  /** What round 1 raises, every finding sent to repair. */
  findings: IngestedFinding[];
  /** The repair's files by path; apps/calc.mjs is REPAIRED unless given. */
  files: Record<string, string>;
  /** The tests the repair names, by finding external id. */
  named: Record<string, string[]>;
  /** The checks that passed on the repaired tree, in the order they ran; every check when absent. */
  passed?: string[];
  /** Round 2 raises these again on the repaired tree (REPAIR_REQUIRED); it approves when absent. */
  again?: IngestedFinding[];
}

/** Round 1 asks for a repair of `findings`; the repair writes `files` and names `named`; round 2 reviews the repaired tree. */
async function repairFlow(f: Flow) {
  const { cand: c1, repo } = await setup(f.setup);
  record(c1, 'REPAIR_REQUIRED', f.findings);
  await run();
  expect(state()).toBe('REPAIRING');
  const c2 = await candidate(repo, 2, { 'apps/calc.mjs': REPAIRED, ...f.files }, Object.fromEntries((f.passed ?? checkIds).map((id) => [id, 'PASSED' as const])));
  report(repo, 2, f.named);
  record(c2, f.again ? 'REPAIR_REQUIRED' : 'APPROVE', f.again ?? []);
  await run();
  return { c2, raised: (ext: string) => listFindings(lab.db, lab.runId).find((x) => x.externalId === ext && x.reviewId === 'rev-1')! };
}

interface Repair {
  /** The checks that passed on the repaired tree, in the order they ran. */
  passed?: string[];
  /** The test the repair writes and names for TEST-1. */
  test?: string;
  /** The test file's text; a discriminating test when absent. */
  source?: string;
  /** The repaired apps/calc.mjs; REPAIRED when absent. */
  calc?: string;
  /** Other files the repair writes, by path. */
  files?: Record<string, string>;
  /** Other files of the pre-repair tree, by path. */
  before?: Record<string, string>;
  /** The second round's verdict: REPAIR_REQUIRED raises TEST-1 again on the repaired tree. */
  round2?: 'APPROVE' | 'REPAIR_REQUIRED';
}

/**
 * Round 1 asks for a repair of TEST-1; the repair fixes mul, adds `test` and names it for the finding; `passed` lists
 * the checks that passed on the repaired tree, in the order they ran; round 2 approves without raising TEST-1 again,
 * unless `round2` says otherwise. Returns TEST-1 as round 1 raised it, and the repaired candidate.
 */
async function repairThenApprove(r: Repair = {}) {
  const test = r.test ?? 'tests/unit/mul-input.test.mjs';
  const { c2, raised } = await repairFlow({
    setup: { unit: currentUnit, files: r.before ?? {} },
    findings: [TEST_1],
    files: { [test]: r.source ?? DISCRIMINATING, ...(r.calc ? { 'apps/calc.mjs': r.calc } : {}), ...(r.files ?? {}) },
    named: { 'TEST-1': [test] },
    ...(r.passed ? { passed: r.passed } : {}),
    ...(r.round2 === 'REPAIR_REQUIRED' ? { again: [TEST_1] } : {}),
  });
  return { finding: raised('TEST-1'), c2 };
}

let currentUnit: Unit = {};
afterEach(() => {
  currentUnit = {};
});

const probes = () => listProbeAttempts(lab.db, lab.runId);
const NOT_APART = "the repair's test passes on the pre-repair tree too, so it does not tell the trees apart";
const notTied = (id: string) => `${id} fails on the pre-repair tree without the finding's tests too, so its failure cannot be tied to them`;
const FAILED_WITH = "unit failed on the pre-repair tree with the tests named for the finding (exit 1, 2 attempts)";
const PASSED_WITHOUT = 'unit passed on the pre-repair tree without the tests named for findings';
const PASSED_REPAIRED = 'unit passed on the repaired tree in the probe checkout';

describe('a repaired finding is resolved by a test only when the test fails on the pre-repair tree and passes after (ADR 0015)', () => {
  it('a test that fails on the pre-repair tree, where the check passes without it, and passes on the repaired tree resolves it, citing the test check, never lint', async () => {
    const { finding, c2 } = await repairThenApprove();
    expect(finding.status).toBe('resolved');
    expect(finding.resolution).toContain('new_test unit PASSED');
    expect(finding.resolution).toContain('tests/unit/mul-input.test.mjs');
    expect(finding.resolution).toContain(`${FAILED_WITH}, ${PASSED_WITHOUT}, and ${PASSED_REPAIRED}`);
    expect(finding.resolution).toContain('repaired in attempt 2');
    expect(finding.resolution).not.toMatch(/lint (PASSED|passed)/);
    expect(state()).toBe('DELIVERING');
    // The probe's attempts are its own: never the run's check runs or failures. The control tree passes once, the repaired
    // tree in the probe checkout passes once, and the finding's tree fails twice.
    expect(probes().map((a) => [a.checkId, a.attempt, a.status, a.candidateId])).toEqual([
      ['unit', 1, 'PASSED', c2.id],
      ['unit', 1, 'PASSED', c2.id],
      ['unit', 1, 'FAILED', c2.id],
      ['unit', 2, 'FAILED', c2.id],
    ]);
    expect(listCheckRuns(lab.db, { runId: lab.runId }).map((c) => c.id)).toEqual(['cr-1-lint', 'cr-1-unit', 'cr-2-lint', 'cr-2-unit']);
    expect(lab.db.all('SELECT * FROM failures WHERE run_id = ?', lab.runId)).toEqual([]);
    expect(listDecisions(lab.db, lab.runId, { kind: 'review.repair-probe' }).map((d) => d.summary)).toEqual([`${PASSED_WITHOUT}: TEST-1`, `${PASSED_REPAIRED}: TEST-1`, `${FAILED_WITH}: TEST-1`]);
    expect(probes()[0]!.logPath).toMatch(new RegExp(`evidence/${c2.seq}/repair-probe/unit\\.log$`));
  });

  it('a lint check that passed on the repaired tree does not resolve it, and nothing is probed', async () => {
    const { finding } = await repairThenApprove({ passed: ['lint'] });
    expect(finding.status).not.toBe('resolved');
    expect(finding.resolution ?? '').not.toMatch(/new_test lint/);
    expect(finding.resolution).toContain('no required command check of category test passed on tree');
    expect(probes()).toEqual([]);
  });

  it('a check of category typecheck or build does not resolve it either', async () => {
    currentUnit = { category: 'typecheck' };
    expect((await repairThenApprove()).finding.status).not.toBe('resolved');
    expect(probes()).toEqual([]);
    lab.cleanup();
    currentUnit = { category: 'build' };
    expect((await repairThenApprove()).finding.status).not.toBe('resolved');
  });

  it('a test check whose directory does not hold the new test does not resolve it', async () => {
    currentUnit = { cwd: 'packages/other' };
    const { finding } = await repairThenApprove();
    expect(finding.status).not.toBe('resolved');
    expect(finding.resolution).toContain('holds tests/unit/mul-input.test.mjs under its directory');
  });
});

describe('a test that does not tell the trees apart leaves the finding open and blocking', () => {
  const open = (f: { status: string; resolution: string | null; resolutionJson: unknown }) => {
    expect(f.status).not.toBe('resolved');
    expect(blocking(f)).toBe(true);
    expect(f.resolution ?? '').not.toMatch(/new_test unit/);
    expect(state()).toBe('REPAIRING');
  };

  it('a skipped test (node:test exits 0 with the test skipped, on both trees)', async () => {
    const { finding } = await repairThenApprove({ source: SKIPPED });
    open(finding);
    expect(finding.resolution).toContain(NOT_APART);
    expect(probes().map((a) => a.status)).toEqual(['PASSED', 'PASSED', 'PASSED']);
  });

  it("a test the check's command excludes (node --test tests/unit/*.test.mjs never runs tests/integration)", async () => {
    currentUnit = { command: [process.execPath, '--test', 'tests/unit/*.test.mjs'] };
    const { finding } = await repairThenApprove({ test: 'tests/integration/mul-input.test.mjs' });
    open(finding);
    expect(finding.resolution).toContain(NOT_APART);
  });

  it('a test that does not check the fix (it passes on the pre-repair tree as well)', async () => {
    const { finding } = await repairThenApprove({ source: nodeTest('mul(2, 3) is 6 (TEST-1)', 'assert.equal(mul(2, 3), 6)') });
    open(finding);
    expect(finding.resolution).toContain(NOT_APART);
    expect(finding.resolution).toContain('unit passed on the pre-repair tree with the tests named for the finding');
    // Resolved again on the same tree (a restart, a return from the Inquisition): the decisive results are reused by
    // tree, nothing runs.
    lab.db.run("UPDATE runs SET state = 'REVIEWING' WHERE id = ?", lab.runId);
    await run();
    expect(probes()).toHaveLength(3);
    expect(listDecisions(lab.db, lab.runId, { kind: 'review.repair-probe' })).toHaveLength(3);
  });
});

describe("a failure counts only when the finding's own tests make the check fail", () => {
  it('a skipped test named for the finding is not credited with an unnamed test change that fails on the pre-repair tree', async () => {
    // The repair also adds a test to the existing add test file, named for nothing: it, not the skipped test, fails there.
    const add = `${ADD_TEST}import { mul } from '../../apps/calc.mjs';\ntest('mul(true, 1) throws', () => assert.throws(() => mul(true, 1), TypeError));\n`;
    const { raised } = await repairFlow({ findings: [TEST_1], files: { 'tests/unit/mul-input.test.mjs': SKIPPED, 'tests/unit/add.test.mjs': add }, named: { 'TEST-1': ['tests/unit/mul-input.test.mjs'] } });
    const f = raised('TEST-1');
    expect(f.status).not.toBe('resolved');
    expect(blocking(f)).toBe(true);
    expect(f.resolution).toContain(`tests/unit/mul-input.test.mjs: ${notTied('unit')}`);
    expect(f.resolution ?? '').not.toMatch(/new_test unit/);
    expect(state()).toBe('REPAIRING');
  });

  it("a skipped test named for one finding is not credited with another finding's test, which resolves its own", async () => {
    const { raised } = await repairFlow({
      findings: [TEST_1, TEST_2],
      files: { 'tests/unit/mul-input.test.mjs': SKIPPED, 'tests/unit/mul-null.test.mjs': nodeTest('mul rejects null (TEST-2)', 'assert.throws(() => mul(null, 2), TypeError)') },
      named: { 'TEST-1': ['tests/unit/mul-input.test.mjs'], 'TEST-2': ['tests/unit/mul-null.test.mjs'] },
    });
    expect(raised('TEST-2').status).toBe('resolved');
    expect(raised('TEST-2').resolution).toContain('tests/unit/mul-null.test.mjs');
    const f = raised('TEST-1');
    expect(f.status).not.toBe('resolved');
    expect(f.resolution).toContain(`tests/unit/mul-input.test.mjs: ${NOT_APART}`);
    expect(f.resolution ?? '').not.toContain('mul-null');
  });

  it('two findings whose tests each tell the trees apart under one check are both resolved', async () => {
    const { raised } = await repairFlow({
      findings: [TEST_1, TEST_2],
      files: { 'tests/unit/mul-input.test.mjs': DISCRIMINATING, 'tests/unit/mul-null.test.mjs': nodeTest('mul rejects null (TEST-2)', 'assert.throws(() => mul(null, 2), TypeError)') },
      named: { 'TEST-1': ['tests/unit/mul-input.test.mjs'], 'TEST-2': ['tests/unit/mul-null.test.mjs'] },
    });
    expect(raised('TEST-1').status).toBe('resolved');
    expect(raised('TEST-1').resolution).not.toContain('mul-null');
    expect(raised('TEST-2').status).toBe('resolved');
    expect(raised('TEST-2').resolution).not.toContain('mul-input');
    // One control tree for both, then each finding's tree.
    expect(listDecisions(lab.db, lab.runId, { kind: 'review.repair-probe' }).map((d) => d.summary)).toEqual([`${PASSED_WITHOUT}: TEST-1, TEST-2`, `${PASSED_REPAIRED}: TEST-1, TEST-2`, `${FAILED_WITH}: TEST-1`, `${FAILED_WITH}: TEST-2`]);
  });

  it('a check that never runs the named test is not credited with another test change it runs', async () => {
    const { raised } = await repairFlow({
      setup: { unit: { command: [process.execPath, '--test', 'tests/unit/*.test.mjs'] }, more: { integ: { command: [process.execPath, '--test', 'tests/integration/*.test.mjs'] } } },
      findings: [TEST_1],
      // Named for TEST-1 and skipped, run only by unit; named for nothing, run only by integ, and failing before the repair.
      files: { 'tests/unit/mul-input.test.mjs': SKIPPED, 'tests/integration/other.test.mjs': nodeTest('other', "assert.throws(() => mul('x', 1), TypeError)") },
      named: { 'TEST-1': ['tests/unit/mul-input.test.mjs'] },
    });
    const f = raised('TEST-1');
    expect(f.status).not.toBe('resolved');
    expect(f.resolution ?? '').not.toMatch(/new_test (unit|integ)/);
    expect(f.resolution).toContain(`tests/unit/mul-input.test.mjs: ${notTied('integ')}`);
    expect(f.resolution).toContain(`tests/unit/mul-input.test.mjs: ${NOT_APART}`);
  });
});

describe('a failure the finding\'s own test file cannot be tied to (review of the second probe rule)', () => {
  it('a test file named for two findings resolves neither: a failure in it cannot be tied to one of them', async () => {
    // A skipped TEST-1 test and a discriminating TEST-2 test in one file, named for both: TEST-2's failure is not TEST-1's.
    const both = `${nodeTest('mul rejects a string (TEST-1)', "assert.throws(() => mul('a', 2), TypeError)", '{ skip: true }')}test('mul rejects null (TEST-2)', () => assert.throws(() => mul(null, 2), TypeError));\n`;
    const { raised } = await repairFlow({ findings: [TEST_1, TEST_2], files: { 'tests/unit/mul.test.mjs': both }, named: { 'TEST-1': ['tests/unit/mul.test.mjs'], 'TEST-2': ['tests/unit/mul.test.mjs'] } });
    for (const [ext, other] of [['TEST-1', 'TEST-2'], ['TEST-2', 'TEST-1']] as const) {
      const f = raised(ext);
      expect(f.status).not.toBe('resolved');
      expect(blocking(f)).toBe(true);
      expect(f.resolution).toContain(`tests/unit/mul.test.mjs is named for ${other} too, so a failure in it cannot be tied to this finding`);
    }
    expect(probes()).toEqual([]);
    expect(state()).toBe('REPAIRING');
  });

  it("a test titled only with an id another review also used is named for the finding whose fingerprint its file cites", async () => {
    // Review 1's TEST-1 (strings) and review 2's TEST-1 (null) are different findings, both sent to the second repair. It
    // cites review 2's fingerprint for its file in evidence_refs and titles the test with the id alone: the file is
    // named for that finding only, not shared with review 1's TEST-1.
    const STRINGS_ONLY = "export const add = (a, b) => a + b;\nexport const mul = (a, b) => {\n  if (typeof a === 'string' || typeof b === 'string') throw new TypeError('mul takes numbers');\n  return a * b;\n};\n";
    const { cand: c1, repo } = await setup();
    record(c1, 'REPAIR_REQUIRED', [TEST_1]);
    await run();
    const c2 = await candidate(repo, 2, { 'apps/calc.mjs': STRINGS_ONLY }, { lint: 'PASSED', unit: 'PASSED' });
    report(repo, 2, {});
    record(c2, 'REPAIR_REQUIRED', [{ ...TEST_2, externalId: 'TEST-1' }]);
    await run();
    expect(state()).toBe('REPAIRING');
    const later = listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1' && x.reviewId === 'rev-2')!;
    const test = 'tests/unit/mul-null.test.mjs';
    const c3 = await candidate(repo, 3, { 'apps/calc.mjs': REPAIRED, [test]: nodeTest('mul rejects null (TEST-1)', 'assert.throws(() => mul(null, 2), TypeError)') }, { lint: 'PASSED', unit: 'PASSED' });
    const sent = lab.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', lab.runId, REVIEW_REPAIR_EVENT).flatMap((r) => (JSON.parse(r.data_json) as { findings: { fingerprint: string; finding_id: string; member_ids: string[] }[] }).findings);
    const fingerprint = sent.find((x) => x.finding_id === later.id || x.member_ids.includes(later.id))!.fingerprint;
    expect(new Set(sent.filter((x) => x.fingerprint !== fingerprint).map((x) => x.fingerprint)).size).toBeGreaterThan(0);
    reportAs(repo, 3, [{ path: test, note: `validation for finding TEST-1 (${fingerprint})` }], [{ path: test, name: 'mul rejects null (TEST-1)' }]);
    record(c3, 'APPROVE');
    await run();
    const f = listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1' && x.reviewId === 'rev-2')!;
    expect(f.resolution ?? '').not.toContain('is named for');
    expect(f.status).toBe('resolved');
    expect(f.resolution).toContain(test);
  });

  it("a file whose note cites one finding's fingerprint and whose test title names another finding's id is named for both", async () => {
    const { cand: c1, repo } = await setup();
    record(c1, 'REPAIR_REQUIRED', [TEST_1, TEST_2]);
    await run();
    const fps = fingerprints();
    const test = 'tests/unit/mul.test.mjs';
    const both = `${nodeTest('mul rejects a string', "assert.throws(() => mul('a', 2), TypeError)", '{ skip: true }')}test('mul rejects null', () => assert.throws(() => mul(null, 2), TypeError));\n`;
    const c2 = await candidate(repo, 2, { 'apps/calc.mjs': REPAIRED, [test]: both }, Object.fromEntries(checkIds.map((id) => [id, 'PASSED' as const])));
    reportAs(repo, 2, [{ path: test, note: `validation for finding TEST-1 (${fps.get('TEST-1')})` }], [{ path: test, name: 'mul rejects strings and null (TEST-2)' }]);
    record(c2, 'APPROVE');
    await run();
    const f = listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1' && x.reviewId === 'rev-1')!;
    expect(f.status).not.toBe('resolved');
    expect(f.resolution).toContain(`${test} is named for TEST-2 too`);
  });

  it('a test that fails only in the probe checkout, by its path, does not resolve it: the repaired tree runs there too', async () => {
    const byPath = nodeTest('mul rejects a string (TEST-1)', "assert.ok(!process.cwd().includes('repair-probe-'))");
    const { finding } = await repairThenApprove({ source: byPath });
    expect(finding.status).not.toBe('resolved');
    expect(blocking(finding)).toBe(true);
    expect(finding.resolution).toContain('tests/unit/mul-input.test.mjs: unit did not pass on the repaired tree in the probe checkout');
    expect(state()).toBe('REPAIRING');
  });
});

describe('a check that does not pass on the pre-repair tree on its own', () => {
  // add is broken on the pre-repair tree, so the existing add test fails there whatever the repair's tests are (a run
  // reaches review that way through a baseline exception); the repair fixes add and mul and adds only a skipped test.
  const BROKEN_ADD = 'export const add = (a, b) => a - b;\nexport const mul = (a, b) => a * b;\n';

  it.each([['FAILED' as const], ['flaky' as const]])('is not probed when its run on the pre-repair candidate ended %s', async (how) => {
    const { raised } = await repairFlow({ setup: { calc: BROKEN_ADD, before: { unit: how } }, findings: [TEST_1], files: { 'tests/unit/mul-input.test.mjs': SKIPPED }, named: { 'TEST-1': ['tests/unit/mul-input.test.mjs'] } });
    const f = raised('TEST-1');
    expect(f.status).not.toBe('resolved');
    expect(f.resolution).toContain('unit is not probed: it did not pass cleanly on the pre-repair tree');
    expect(f.resolution).toContain(how === 'FAILED' ? 'its run there ended FAILED' : 'its pass there needed a rerun');
    expect(probes()).toEqual([]);
  });

  it('a pre-repair tree that fails the check in the probe though its run passed: the control tree shows it', async () => {
    const { raised } = await repairFlow({ setup: { calc: BROKEN_ADD }, findings: [TEST_1], files: { 'tests/unit/mul-input.test.mjs': SKIPPED }, named: { 'TEST-1': ['tests/unit/mul-input.test.mjs'] } });
    const f = raised('TEST-1');
    expect(f.status).not.toBe('resolved');
    expect(f.resolution).toContain(`tests/unit/mul-input.test.mjs: ${notTied('unit')}`);
  });
});

describe('a test is named for a finding by its whole id', () => {
  it('a test named only for TEST-10 does not resolve TEST-1', async () => {
    const OVERFLOW: IngestedFinding = { ...TEST_1, externalId: 'TEST-1', claim: 'add ignores overflow handling entirely (TEST-1)', evidence: 'add(MAX, 1) wraps', suggestedValidation: 'Add a test for add overflow' };
    const MUL_10: IngestedFinding = { ...TEST_1, externalId: 'TEST-10', claim: 'mul accepts a string and returns NaN instead of throwing a TypeError (TEST-10)' };
    const { raised } = await repairFlow({ findings: [OVERFLOW, MUL_10], files: { 'tests/unit/mul10.test.mjs': nodeTest('mul rejects a string (TEST-10)', "assert.throws(() => mul('a', 2), TypeError)") }, named: { 'TEST-10': ['tests/unit/mul10.test.mjs'] } });
    expect(raised('TEST-10').status).toBe('resolved');
    expect(raised('TEST-1').status).not.toBe('resolved');
    expect(raised('TEST-1').resolution ?? '').not.toContain('mul10');
  });
});

describe('a reviewer who raises the finding again on a tree that has the repair test', () => {
  it("is not overridden by the repair's discriminating test: neither round's finding reads resolved, nothing is probed, and the run goes back to repair", async () => {
    const { finding } = await repairThenApprove({ round2: 'REPAIR_REQUIRED' });
    expect(finding.status).not.toBe('resolved');
    const again = listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1' && x.reviewId === 'rev-2')!;
    expect(again.status).not.toBe('resolved');
    expect(probes()).toEqual([]);
    expect(state()).toBe('REPAIRING');
  });

  it('keeps the test from resolving it on a later tree whose repair names no test', async () => {
    const { cand: c1, repo } = await setup();
    record(c1, 'REPAIR_REQUIRED', [TEST_1]);
    await run();
    // Attempt 2 writes a discriminating test, and the review of its tree raises TEST-1 again: the test does not satisfy it.
    const c2 = await candidate(repo, 2, { 'apps/calc.mjs': REPAIRED, 'tests/unit/mul-input.test.mjs': DISCRIMINATING }, { lint: 'PASSED', unit: 'PASSED' });
    report(repo, 2, { 'TEST-1': ['tests/unit/mul-input.test.mjs'] });
    record(c2, 'REPAIR_REQUIRED', [TEST_1]);
    await run();
    expect(state()).toBe('REPAIRING');
    // Attempt 3 changes a comment and names no test; the review of its tree approves.
    const c3 = await candidate(repo, 3, { 'apps/calc.mjs': `${REPAIRED}// touched\n` }, { lint: 'PASSED', unit: 'PASSED' });
    report(repo, 3, {});
    record(c3, 'APPROVE');
    await run();
    const all = listFindings(lab.db, lab.runId).filter((x) => x.externalId === 'TEST-1');
    expect(all.map((x) => x.status).filter((s) => s === 'resolved')).toEqual([]);
    expect(all.at(-1)!.resolution).toContain(`tests/unit/mul-input.test.mjs: a review of tree ${c2.treeHash.slice(0, 12)}, which already had it, raised the finding again`);
    expect(probes()).toEqual([]);
    expect(state()).toBe('REPAIRING');
  });

  it("a finding an earlier repair's test resolves on a later tree says that repair's attempt", async () => {
    const { cand: c1, repo } = await setup();
    record(c1, 'REPAIR_REQUIRED', [TEST_1]);
    await run();
    // Attempt 2 writes a discriminating test, but no test check passed on its tree, so nothing can resolve TEST-1 there.
    const c2 = await candidate(repo, 2, { 'apps/calc.mjs': REPAIRED, 'tests/unit/mul-input.test.mjs': DISCRIMINATING }, { lint: 'PASSED' });
    report(repo, 2, { 'TEST-1': ['tests/unit/mul-input.test.mjs'] });
    record(c2, 'APPROVE');
    await run();
    expect(state()).toBe('REPAIRING');
    // Attempt 3 names no test; on its tree the test written in attempt 2 is judged against the tree attempt 2 repaired.
    const c3 = await candidate(repo, 3, { 'apps/calc.mjs': `${REPAIRED}// touched\n` }, { lint: 'PASSED', unit: 'PASSED' });
    report(repo, 3, {});
    record(c3, 'APPROVE');
    await run();
    const f = listFindings(lab.db, lab.runId).find((x) => x.externalId === 'TEST-1' && x.reviewId === 'rev-1')!;
    expect(f.status).toBe('resolved');
    expect(f.resolution).toContain('repaired in attempt 2');
    expect(f.resolution).toContain(`pre-repair tree ${c1.treeHash.slice(0, 12)}`);
  });
});

describe('a probe that cannot establish discrimination leaves the finding open, with the cause', () => {
  // The check runs the test file itself, which the pre-repair tree has as an empty placeholder: the control tree passes.
  const placeholder = { 'tests/unit/mul-input.test.mjs': 'export {};\n' };

  it('an environment signal on the pre-repair tree', async () => {
    currentUnit = { command: [process.execPath, 'tests/unit/mul-input.test.mjs'] };
    const source = "import { mul } from '../../apps/calc.mjs';\nlet threw = false;\ntry { mul('a', 2); } catch { threw = true; }\nif (!threw) { console.error(\"Error: EPERM: operation not permitted, mkdir '/private/var/orbit-elsewhere/cache'\"); process.exit(1); }\n";
    const { finding } = await repairThenApprove({ source, before: placeholder });
    expect(finding.status).not.toBe('resolved');
    expect(finding.resolution).toContain('its output shows an environment cause (filesystem-denied)');
    expect(state()).toBe('REPAIRING');
  });

  it('a timeout on the pre-repair tree', async () => {
    // The check's own timeout: the lab's manual clock runs ahead while the runner polls, so the hanging run times out
    // soon, and the control tree's run ends before it would.
    currentUnit = { command: [process.execPath, 'tests/unit/mul-input.test.mjs'] };
    const source = "import { mul } from '../../apps/calc.mjs';\nlet threw = false;\ntry { mul('a', 2); } catch { threw = true; }\nif (!threw) await new Promise((r) => setTimeout(r, 60_000));\n";
    const { finding } = await repairThenApprove({ source, before: placeholder });
    expect(finding.status).not.toBe('resolved');
    expect(finding.resolution).toContain('unit timed out on the probe tree');
    expect(probes().map((a) => a.status)).toEqual(['PASSED', 'PASSED', 'TIMEOUT']);
  }, 30_000);

  it('a repair that changes a lockfile is not probed', async () => {
    const { finding } = await repairThenApprove({ files: { 'package-lock.json': '{ "lockfileVersion": 3 }\n' } });
    expect(finding.status).not.toBe('resolved');
    expect(finding.resolution).toContain('package-lock.json, a dependency manifest or lockfile outside test-owned paths');
    expect(probes()).toEqual([]);
  });
});

describe('the documented limit: a load failure counts', () => {
  it('a test that only imports a symbol the repair adds fails to load on the pre-repair tree, and resolves the finding', async () => {
    const calc = `${REPAIRED}export const assertNumber = (x) => { if (typeof x !== 'number') throw new TypeError('not a number'); };\n`;
    const source = "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { assertNumber } from '../../apps/calc.mjs';\ntest('assertNumber exists (TEST-1)', () => assert.equal(typeof assertNumber, 'function'));\n";
    const { finding } = await repairThenApprove({ calc, source });
    expect(finding.status).toBe('resolved');
    expect(finding.resolution).toContain(FAILED_WITH);
  });
});
