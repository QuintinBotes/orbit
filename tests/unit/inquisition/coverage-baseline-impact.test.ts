import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import type { GoalContract } from '../../../src/contract/types.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import { openDb, type OrbitDb } from '../../../src/storage/db.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { applyBaselineExceptionAnswers, raiseBaselineExceptionQuestions } from '../../../src/inquisition/baseline-exception.ts';
import { buildImpactRegister } from '../../../src/inquisition/impact.ts';
import { answerQuestion } from '../../../src/inquisition/questions.ts';
import { listAmendments } from '../../../src/inquisition/store.ts';
import { contract as baseContract, config } from '../contract/fixtures.ts';

const RUN = 'run-1';
const FP = 'test-failure:lint:9f2c41d07a33b2e1';

interface Env {
  db: OrbitDb;
  clock: ManualClock;
  runDir: string;
  policyPath: string;
  contract: GoalContract;
  baseline(failures: { checkId: string; fingerprint: string | null; excerpt: string | null }[]): void;
  contractRow(): GoalContract;
  cleanup(): void;
}

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function setup(): Env {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-baseline-cov-'));
  const runDir = join(dir, 'run');
  mkdirSync(runDir, { recursive: true });
  const clock = new ManualClock();
  const frozen = snapshotPolicy(config(), { runId: RUN, repoRoot: dir, runDir, clock });
  const db = openDb(join(dir, 'state.sqlite'));
  createRun(db, { id: RUN, repoRoot: dir, goal: 'Add CSV export', mode: 'autonomous', policyHash: frozen.hash, policyPath: frozen.path }, clock);
  const contract = baseContract(frozen.snapshot, { policy_hash: frozen.hash });
  db.run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ?', JSON.stringify(contract), hashObject(contract), RUN);
  return {
    db,
    clock,
    runDir,
    policyPath: frozen.path,
    contract,
    baseline: (failures) => writeFileSync(join(runDir, 'baseline.json'), JSON.stringify({ schema: 'orbit.baseline/1', runId: RUN, failures, complete: true })),
    contractRow: () => JSON.parse(db.get<{ contract_json: string }>('SELECT contract_json FROM runs WHERE id = ?', RUN)!.contract_json) as GoalContract,
    cleanup() {
      db.close();
      chmodSync(frozen.path, 0o644);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const FAILURE = { checkId: 'lint', fingerprint: FP, excerpt: 'src/export.ts:12 error: unused variable' };

function raise(e: Env): string {
  return raiseBaselineExceptionQuestions({ db: e.db, clock: e.clock, runId: RUN, runDir: e.runDir }, { failures: [FAILURE], baseRevision: 'a'.repeat(40) }).raised[0]!.question.id;
}

describe('applying a baseline exception, unusual states', () => {
  it('reports a run that does not exist', () => {
    env = setup();
    try {
      applyBaselineExceptionAnswers({ db: env.db, clock: env.clock, runId: 'ghost', runDir: env.runDir });
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'NOT_FOUND')).toBe(true);
    }
  });

  it('refuses, with a reason, when the frozen policy cannot be verified', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env);
    chmodSync(env.policyPath, 0o644);
    writeFileSync(env.policyPath, '{"tampered": true}');
    const answered = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(answered.baselineException?.status).toBe('refused');
    expect(answered.baselineException?.detail).toMatch(/policy snapshot could not be verified/);
    expect(env.contractRow().baseline_exceptions).toBeUndefined();
  });

  it('treats a contract that already carries the exception as applied, writing no amendment', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env);
    const carrying = { ...env.contract, baseline_exceptions: [{ check_id: 'lint', fingerprint: FP, reason: 'recorded by hand' }] };
    env.db.run('UPDATE runs SET contract_json = ?, contract_hash = ? WHERE id = ?', JSON.stringify(carrying), hashObject(carrying), RUN);
    const answered = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(answered.baselineException).toMatchObject({ status: 'already-applied', detail: 'the contract already carries this exception' });
    expect(listAmendments(env.db, RUN)).toEqual([]);
  });

  it('lets an unexpected failure through, and the answer path records it instead of losing the answer', () => {
    env = setup();
    env.baseline([FAILURE]);
    // A report that is valid JSON but not the shape the controller writes.
    writeFileSync(join(env.runDir, 'baseline.json'), '{}');
    const qid = raise(env);
    const answered = answerQuestion(env.db, env.runDir, qid, 'Approve', 'alice', env.clock);
    expect(answered.baselineException).toBeNull();
    expect(answered.question.status).toBe('answered');
    const events = env.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE type = 'baseline-exception.apply-failed'");
    expect(events).toHaveLength(1);
    expect(JSON.parse(events[0]!.data_json).question_id).toBe(qid);
    expect(() => applyBaselineExceptionAnswers({ db: env!.db, clock: env!.clock, runId: RUN, runDir: env!.runDir })).toThrow(TypeError);
  });

  it('retries when the contract changes under it, and gives up after a bounded number of attempts', () => {
    env = setup();
    env.baseline([FAILURE]);
    const qid = raise(env);
    const e = env;
    const original = e.db.run.bind(e.db);
    let interfere = 1;
    e.db.run = (sql: string, ...params: never[]) => {
      if (sql.startsWith('UPDATE runs SET contract_json') && interfere > 0) {
        interfere--;
        e.db.raw.exec("UPDATE runs SET contract_json = contract_json || ' '");
      }
      return original(sql, ...params);
    };
    // The first write loses the race, the second wins.
    const answered = answerQuestion(e.db, e.runDir, qid, 'Approve', 'alice', e.clock);
    expect(answered.baselineException?.status).toBe('applied');
    expect(e.contractRow().baseline_exceptions).toHaveLength(1);

    // A fresh run where every write loses.
    e.cleanup();
    env = setup();
    const f = env;
    f.baseline([FAILURE]);
    const qid2 = raise(f);
    const original2 = f.db.run.bind(f.db);
    f.db.run = (sql: string, ...params: never[]) => {
      if (sql.startsWith('UPDATE runs SET contract_json')) f.db.raw.exec("UPDATE runs SET contract_json = contract_json || ' '");
      return original2(sql, ...params);
    };
    const lost = answerQuestion(f.db, f.runDir, qid2, 'Approve', 'alice', f.clock);
    expect(lost.baselineException).toBeNull();
    expect(f.db.all("SELECT 1 FROM events WHERE type = 'baseline-exception.apply-failed'")).toHaveLength(1);
    expect(listDecisions(f.db, RUN, { kind: 'contract.baseline-exception' })).toHaveLength(0);
  });
});

describe('impact register details', () => {
  const policy = config();
  const trigger = { key: 'hidden_decision:abc' };

  it('names the authorizations that fit a category, and says a person must decide when none do', () => {
    const reg = buildImpactRegister({ changedFiles: ['src/api/v2/orders.ts', 'src/billing/charge.ts'], diff: null }, policy, trigger);
    const compat = reg.entries.find((e) => e.category === 'compatibility')!;
    expect(compat.authorizations_available).toEqual(['build', 'typecheck']);
    expect(compat.authorization_needed).toBe('one of: build, typecheck');
    const billing = reg.entries.find((e) => e.category === 'billing')!;
    expect(billing.reversibility).toBe('costly-to-reverse');
    expect(billing.authorization_needed).toMatch(/^a person's decision/);
  });

  it('marks a destructive data change irreversible and a plain one costly to reverse', () => {
    const destructive = ['diff --git a/db/migrations/001.sql b/db/migrations/001.sql', '--- a/db/migrations/001.sql', '+++ b/db/migrations/001.sql', '+DROP TABLE exports;', ''].join('\n');
    const reg = buildImpactRegister({ changedFiles: ['db/migrations/001.sql'], diff: destructive }, policy, trigger);
    expect(reg.entries.find((e) => e.category === 'data')?.reversibility).toBe('irreversible');
    const plain = buildImpactRegister({ changedFiles: ['db/migrations/002.sql'], diff: null }, policy, trigger);
    expect(plain.entries.find((e) => e.category === 'data')?.reversibility).toBe('costly-to-reverse');
  });

  it('skips a diff chunk with no destination file and reads privacy paths', () => {
    const removed = ['diff --git a/old.ts b/old.ts', '--- a/old.ts', '+++ /dev/null', '-gone', ''].join('\n');
    const reg = buildImpactRegister({ changedFiles: ['src/privacy/consent.ts'], diff: removed }, policy, trigger);
    expect(reg.entries.map((e) => e.category)).toEqual(['privacy']);
    expect(reg.entries[0]?.reversibility).toBe('costly-to-reverse');
    expect(reg.trigger).toBe('hidden_decision:abc');
  });
});
