import { describe, expect, it } from 'vitest';
import { completionGate } from '../../../src/controller/gates.ts';
import { aggregateCheckConfigHash, saveEvidenceReport } from '../../../src/evidence/report.ts';
import { invalidateEvidence } from '../../../src/evidence/freshness.ts';
import { snapshotHash } from '../../../src/policy/snapshot.ts';
import { recordReview } from '../../../src/review/store.ts';
import { insertQuestion, setQuestionAnswer } from '../../../src/inquisition/store.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { COMMIT_A, TREE_A, TREE_B, candidateOf, dbFixture, evidenceReport, snapshotOf } from '../review/fixtures.ts';

const CANDIDATE = { id: candidateOf(TREE_A), runId: 'run-1', seq: 1, treeHash: TREE_A, commitSha: COMMIT_A };

function setup(opts: { approve?: boolean; evidence?: boolean } = {}) {
  const fx = dbFixture();
  const snapshot: PolicySnapshot = snapshotOf((c) => {
    c.checks = { unit: { ...c.checks.unit!, id: 'unit', kind: 'command', command: ['node', 't.mjs'], mandatory: true } } as typeof c.checks;
  });
  if (opts.evidence !== false) {
    const report = evidenceReport(TREE_A, { policy_hash: snapshotHash(snapshot), check_config_hash: aggregateCheckConfigHash(snapshot, ['unit']) });
    saveEvidenceReport({ db: fx.db, runDir: fx.runDir, candidate: CANDIDATE as never, report, clock: fx.clock });
  }
  if (opts.approve !== false) {
    recordReview(fx.db, { id: 'rev-1', runId: 'run-1', candidateId: CANDIDATE.id, treeHash: TREE_A, round: 1, provider: 'codex', model: 'codex-alpha', workerId: null, verdict: 'APPROVE', packetSha256: null, findings: [] }, fx.clock);
  }
  const gate = (deliveredTree: string | null = TREE_A) => completionGate(fx.db, { run: { id: 'run-1' }, snapshot, candidate: CANDIDATE, implementerProvider: 'claude', deliveredTree, now: fx.clock.now() });
  return { ...fx, snapshot, gate };
}

function materialQuestion(db: ReturnType<typeof dbFixture>['db'], clock: ReturnType<typeof dbFixture>['clock'], affected: string[]) {
  return insertQuestion(
    db,
    {
      runId: 'run-1',
      mode: 'clarify',
      question: 'Should unknown /api paths answer with a JSON error body, and with which fields?',
      evidence: ['the planner could not settle the error body from the repository'],
      options: [
        { label: 'json', description: 'Answer with a JSON error body', consequences: 'API clients can parse the error' },
        { label: 'text', description: 'Keep the plain text body', consequences: 'API clients keep string matching' },
      ],
      changes: ['implementation', 'proof'],
      recommendation: { option: 'json', reason: 'API clients expect structured errors' },
      safeDefault: { exists: false, option: null, reason: 'either answer changes observable behaviour' },
      material: true,
      affected,
      unblocked: ['AC-1'],
    },
    clock,
  );
}

describe('completion gate', () => {
  it('passes with fresh PASS evidence, an APPROVE review of the tree and the delivered tree equal to it', () => {
    const { gate } = setup();
    const g = gate();
    expect(g.reasons).toEqual([]);
    expect(g.passed).toBe(true);
    expect(g.details).toMatchObject({ reviewId: 'rev-1', blockedCriteria: [] });
  });

  it('fails while a material question blocks a criterion, naming the criterion and the question, and passes once it is answered', () => {
    const { db, clock, gate } = setup();
    const q = materialQuestion(db, clock, ['AC-2']);
    const blocked = gate();
    expect(blocked.passed).toBe(false);
    expect(blocked.onFailure).toBe('no-success');
    expect(blocked.details.blockedCriteria).toEqual(['AC-2']);
    expect(blocked.reasons.join(' ')).toContain(`AC-2 is blocked by open question(s) ${q.id}`);
    setQuestionAnswer(db, q.id, 'json', 'acme-dev', clock);
    expect(gate().passed).toBe(true);
  });

  it('a non-material open question does not block completion', () => {
    const { db, clock, gate } = setup();
    db.run('UPDATE questions SET material = 0 WHERE id = ?', materialQuestion(db, clock, ['AC-2']).id);
    expect(gate().passed).toBe(true);
  });

  it('fails on stale evidence', () => {
    const { db, clock, gate } = setup();
    invalidateEvidence(db, 'run-1', 'the policy changed', clock);
    const g = gate();
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/no live evidence report/);
  });

  it('fails on evidence bound to another policy', () => {
    const fx = setup({ evidence: false });
    const report = evidenceReport(TREE_A, { policy_hash: 'sha256:another-policy', check_config_hash: aggregateCheckConfigHash(fx.snapshot, ['unit']) });
    saveEvidenceReport({ db: fx.db, runDir: fx.runDir, candidate: CANDIDATE as never, report, clock: fx.clock });
    const g = fx.gate();
    expect(g.passed).toBe(false);
    expect(g.reasons.join(' ')).toMatch(/the evidence is stale: policy snapshot changed/);
  });

  it('fails without an APPROVE review of the tree', () => {
    const { gate } = setup({ approve: false });
    const g = gate();
    expect(g.passed).toBe(false);
    expect(g.reasons).toContain(`no APPROVE review of tree ${TREE_A}`);
  });

  it('fails when the delivered tree is not the reviewed tree, or nothing was delivered', () => {
    const { gate } = setup();
    expect(gate(TREE_B).reasons).toContain(`the delivered tree ${TREE_B} is not the reviewed tree ${TREE_A}`);
    expect(gate(null).reasons).toContain('no delivered commit to compare with the reviewed tree');
  });
});
