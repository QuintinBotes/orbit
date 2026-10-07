import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { applyBaselineExceptionAnswers, raiseBaselineExceptionQuestions } from '../../../src/inquisition/baseline-exception.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listAmendments } from '../../../src/inquisition/store.ts';
import { check, config, contract as baseContract } from '../contract/fixtures.ts';

// Issue #23: a misconfigured check is never a baseline exception. PREFLIGHT raises no question for one; this is the
// guard behind that, for a question raised before the classification existed (an earlier Orbit) and answered with
// "Approve" through `orbit decide` or a remote answer (ADR 0008), which both apply the answer here.

const RUN = 'run-1';
const FP = 'fp:1b2c3d4e5f607182';
const MSB1008 = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/misconfigured/dotnet-msb1008-one-project.log'), 'utf8');

interface Env {
  db: OrbitDb;
  clock: ManualClock;
  runDir: string;
  contractRow(): GoalContract | null;
  cleanup(): void;
}

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

/** A run whose `lint` check runs `command`, with a contract and a baseline in which lint failed with `log` and `exit`. */
function setup(command: string[], log: string, exit: number, classification?: 'environment' | 'misconfigured' | 'missing-target'): Env {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-baseline-misconfigured-'));
  const runDir = join(dir, 'run');
  mkdirSync(runDir, { recursive: true });
  const clock = new ManualClock();
  const cfg = config();
  cfg.checks.lint = check('lint', { mandatory: true, command });
  const frozen = snapshotPolicy(cfg, { runId: RUN, repoRoot: dir, runDir, clock });
  const db = openDb(join(dir, 'state.sqlite'));
  createRun(db, { id: RUN, repoRoot: dir, goal: 'Add CSV export', mode: 'autonomous', policyHash: frozen.hash, policyPath: frozen.path }, clock);
  const contract = baseContract(frozen.snapshot, { policy_hash: frozen.hash });
  db.run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ?', JSON.stringify(contract), hashObject(contract), RUN);
  const logPath = join(runDir, 'baseline', 'lint.log');
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, log);
  const excerpt = log.split('\n')[0]!;
  writeFileSync(
    join(runDir, 'baseline.json'),
    JSON.stringify({
      schema: 'orbit.baseline/1',
      runId: RUN,
      complete: true,
      checks: [{ checkId: 'lint', mandatory: true, status: 'FAILED', exitCode: exit, flaky: false, fingerprint: FP, excerpt, log: logPath }],
      failures: [{ checkId: 'lint', fingerprint: FP, excerpt, ...(classification ? { classification } : {}) }],
    }),
  );
  raiseBaselineExceptionQuestions({ db, clock, runId: RUN, runDir }, { failures: [{ checkId: 'lint', fingerprint: FP, excerpt }], baseRevision: 'a'.repeat(40) });
  return {
    db,
    clock,
    runDir,
    contractRow() {
      const row = db.get<{ contract_json: string | null }>('SELECT contract_json FROM runs WHERE id = ?', RUN);
      return row?.contract_json ? (JSON.parse(row.contract_json) as GoalContract) : null;
    },
    cleanup() {
      db.close();
      chmodSync(frozen.path, 0o644);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const questionId = (e: Env): string => e.db.get<{ id: string }>('SELECT id FROM questions WHERE run_id = ?', RUN)!.id;

describe('a baseline exception for a misconfigured check is refused', () => {
  for (const [how, by] of [
    ['orbit decide', 'alice'],
    ['a remote answer', 'github:acme-dev'],
  ] as const) {
    it(`refuses an approval given through ${how}, records the refusal, and leaves the contract as it was`, () => {
      env = setup(['dotnet', 'build', 'A.csproj', 'B.csproj'], MSB1008, 1);
      const before = env.contractRow();
      const res = answerQuestion(env.db, env.runDir, questionId(env), 'Approve', by, env.clock);
      expect(res.baselineException).toMatchObject({ checkId: 'lint', status: 'refused' });
      expect(res.baselineException!.detail).toMatch(/^check lint is misconfigured on the base revision/);
      expect(res.baselineException!.detail).toContain('MSBUILD : error MSB1008: Only one project can be specified.');
      expect(res.baselineException!.detail).toContain('checks.lint.command');
      expect(env.contractRow()).toEqual(before);
      expect(listAmendments(env.db, RUN, { status: 'rejected' })).toHaveLength(1);
      // The refusal is final: a later step does not apply it after all.
      expect(applyBaselineExceptionAnswers({ db: env.db, clock: env.clock, runId: RUN, runDir: env.runDir }).outcomes).toEqual([expect.objectContaining({ status: 'refused' })]);
      expect(env.contractRow()!.baseline_exceptions).toBeUndefined();
    });
  }

  it('refuses one PREFLIGHT recorded as misconfigured or as not able to run, whatever the log says now', () => {
    env = setup(['npm', 'run', 'lint'], 'src/export.ts:12 error: unused variable\n', 1, 'misconfigured');
    expect(answerQuestion(env.db, env.runDir, questionId(env), 'Approve', 'alice', env.clock).baselineException).toMatchObject({ status: 'refused', detail: expect.stringMatching(/^check lint is misconfigured on the base revision/) });
    env.cleanup();
    env = setup(['npm', 'run', 'lint'], 'src/export.ts:12 error: unused variable\n', 1, 'environment');
    expect(answerQuestion(env.db, env.runDir, questionId(env), 'Approve', 'alice', env.clock).baselineException).toMatchObject({ status: 'refused', detail: expect.stringMatching(/^check lint could not run on the base revision/) });
  });

  it('refuses a missing target, which PREFLIGHT does ask about so the contract can expect it to flip: it would make a meaningless check green', () => {
    for (const how of ['alice', 'github:acme-dev']) {
      env = setup(['npm', 'run', 'lint'], 'npm error Missing script: "lint"\n', 1);
      const before = env.contractRow();
      const res = answerQuestion(env.db, env.runDir, questionId(env), 'Approve', how, env.clock);
      expect(res.baselineException).toMatchObject({ checkId: 'lint', status: 'refused' });
      expect(res.baselineException!.detail).toMatch(/^check lint names something that does not exist on the base revision: npm could not find what the check's command names/);
      expect(res.baselineException!.detail).toContain('would make a meaningless check green');
      expect(res.baselineException!.detail).toContain('checks.lint.command');
      // The same causes the CONTRACTING block names, and a new run for the two the goal does not settle: never a forced resume.
      expect(res.baselineException!.detail).toContain('otherwise start a new run, after installing or restoring it when a tool that is not there yet provides it (a cargo plugin, a dotnet local tool, a pytest plugin), or after correcting checks.lint.command in .orbit/config.yaml when the command is wrong');
      expect(res.baselineException!.detail).not.toMatch(/--force/);
      expect(env.contractRow()).toEqual(before);
      expect(listAmendments(env.db, RUN, { status: 'rejected' })).toHaveLength(1);
      env.cleanup();
      env = null;
    }
    // Marked by PREFLIGHT, whatever the log says now.
    env = setup(['npm', 'run', 'lint'], 'src/export.ts:12 error: unused variable\n', 1, 'missing-target');
    expect(answerQuestion(env.db, env.runDir, questionId(env), 'Approve', 'alice', env.clock).baselineException).toMatchObject({ status: 'refused', detail: expect.stringMatching(/^check lint names something that does not exist on the base revision, so/) });
  });

  it('refuses a program that was not found where the check runs (exit 127): the check never ran', () => {
    env = setup(['dotnett', 'build'], 'env: dotnett: No such file or directory\n', 127);
    expect(answerQuestion(env.db, env.runDir, questionId(env), 'Approve', 'alice', env.clock).baselineException).toMatchObject({ status: 'refused', detail: expect.stringMatching(/^check lint could not run on the base revision/) });
  });

  // Review: a question raised before ADR 0010 (an in-flight run) for an issue #10 failure was still approved: only a usage
  // error and a program not found were read again from the log. The environment's readings are read again too.
  it('refuses a failure the environment stopped before it ran anything of the repository, read again from the log', () => {
    const environment = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', name), 'utf8');
    for (const name of ['dotnet-test-msbuild-node-pipe-eacces.log', 'dotnet-build-nuget-cookiecontainer.log', 'dotnet-build-nuget-ssl.log', 'dotnet-format-restore-node-denied.log']) {
      env = setup(['dotnet', 'test'], environment(name), 1);
      const before = env.contractRow();
      const res = answerQuestion(env.db, env.runDir, questionId(env), 'Approve', 'alice', env.clock);
      expect(res.baselineException, name).toMatchObject({ status: 'refused', detail: expect.stringMatching(/^check lint could not run on the base revision/) });
      expect(env.contractRow()).toEqual(before);
      env.cleanup();
      env = null;
    }
    // A denial on a path, with no recorded run to say where the check's checkout was, is not read: it may be the code's.
    env = setup(['npm', 'test'], "Error: EACCES: permission denied, open '/home/acme/checkout/dist/out.js'\n", 1);
    expect(answerQuestion(env.db, env.runDir, questionId(env), 'Approve', 'alice', env.clock).baselineException).toMatchObject({ status: 'applied' });
  });

  it('still applies an approved exception for a failure of the repository\'s code', () => {
    env = setup(['npm', 'run', 'lint'], 'src/export.ts:12 error: unused variable\n', 1);
    expect(answerQuestion(env.db, env.runDir, questionId(env), 'Approve', 'alice', env.clock).baselineException).toMatchObject({ status: 'applied' });
    expect(env.contractRow()!.baseline_exceptions).toEqual([expect.objectContaining({ check_id: 'lint', fingerprint: FP })]);
  });
});
