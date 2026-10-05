import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertDeliverable, assertRecordedBindings, verifyCandidateTree, type DeliveryCandidate, type GateInput } from '../../../src/delivery/gate.ts';
import { makeLab, type Lab } from '../../integration/delivery/harness.ts';

let lab: Lab;
let cand: DeliveryCandidate;
beforeEach(() => {
  lab = makeLab();
  cand = lab.candidate('widget\n');
});
afterEach(() => lab.cleanup());

type Bindings = Pick<GateInput, 'run' | 'candidate' | 'evidence' | 'review' | 'snapshot'>;
function bindings(over: Partial<Bindings> = {}): Bindings {
  return { run: lab.deliveryRun, candidate: cand, evidence: lab.evidenceFor(cand), review: lab.reviewFor(cand), snapshot: lab.snapshot, ...over };
}
function problemsOf(b: Bindings): string[] {
  try {
    assertRecordedBindings(lab.db, b);
  } catch (err) {
    return (err as { details?: { problems?: string[] } }).details?.problems ?? [`unexpected: ${String(err)}`];
  }
  return [];
}

describe('assertRecordedBindings: run level', () => {
  it('accepts matching recorded evidence and review', () => {
    expect(() => assertRecordedBindings(lab.db, bindings())).not.toThrow();
  });

  it('refuses a run that has no row', () => {
    const b = bindings();
    expect(() => assertRecordedBindings(lab.db, { ...b, run: { ...b.run, id: 'orb-missing' } })).toThrow(expect.objectContaining({ code: 'NOT_FOUND', message: expect.stringContaining('orb-missing') }));
  });

  it('refuses when a cancellation was recorded after the objects were read', () => {
    const b = bindings();
    lab.db.run('UPDATE runs SET cancel_requested = 1 WHERE id = ?', lab.runId);
    expect(() => assertRecordedBindings(lab.db, b)).toThrow(expect.objectContaining({ code: 'CANCELLED' }));
  });

  it('refuses when the run row records another policy hash', () => {
    const b = bindings();
    lab.db.run("UPDATE runs SET policy_hash = 'sha256:other' WHERE id = ?", lab.runId);
    expect(() => assertRecordedBindings(lab.db, b)).toThrow(expect.objectContaining({ code: 'POLICY_TAMPERED' }));
  });
});

describe('assertRecordedBindings: recorded evidence', () => {
  it('names a missing report by id when one was given and by candidate when not', () => {
    const b = bindings();
    expect(problemsOf({ ...b, evidence: { ...b.evidence, id: 'ev-nope' } })).toContain('no recorded evidence ev-nope');
    const noId = { ...b.evidence };
    delete noId.id;
    lab.db.run('DELETE FROM evidence_reports');
    expect(problemsOf({ ...b, evidence: noId })).toContain(`no recorded evidence for candidate ${cand.id}`);
  });

  it('re-reads the newest report for the tree when the caller gave no id', () => {
    const b = bindings();
    const noId = { ...b.evidence };
    delete noId.id;
    expect(problemsOf({ ...b, evidence: noId })).toEqual([]);
    lab.evidenceFor(cand, { verdict: 'FAIL' });
    lab.clock.advance(1);
    expect(problemsOf({ ...b, evidence: noId }).join(';')).toMatch(/has verdict FAIL, not PASS/);
  });

  it('reports an invalidated report with its reason, or without one', () => {
    const b = bindings();
    lab.db.run("UPDATE evidence_reports SET invalidated_at = 5, invalidated_reason = 'worktree changed' WHERE id = ?", b.evidence.id!);
    expect(problemsOf(b)).toContain(`recorded evidence ${b.evidence.id} was invalidated: worktree changed`);
    lab.db.run('UPDATE evidence_reports SET invalidated_reason = NULL WHERE id = ?', b.evidence.id!);
    expect(problemsOf(b)).toContain(`recorded evidence ${b.evidence.id} was invalidated`);
  });

  it('refuses a verdict other than PASS, another tree, another policy and another check configuration', () => {
    const b = bindings();
    const id = b.evidence.id!;
    lab.db.run("UPDATE evidence_reports SET verdict = 'FAIL' WHERE id = ?", id);
    expect(problemsOf(b)).toContain(`recorded evidence ${id} has verdict FAIL, not PASS`);
    lab.db.run("UPDATE evidence_reports SET verdict = 'PASS', tree_hash = ? WHERE id = ?", 'f'.repeat(40), id);
    expect(problemsOf(b)).toContain(`recorded evidence ${id} covers another candidate or tree`);
    lab.db.run("UPDATE evidence_reports SET tree_hash = ?, candidate_id = 'cand-other' WHERE id = ?", cand.treeHash, id);
    expect(problemsOf(b)).toContain(`recorded evidence ${id} covers another candidate or tree`);
    lab.db.run("UPDATE evidence_reports SET candidate_id = ?, policy_hash = 'sha256:old' WHERE id = ?", cand.id, id);
    expect(problemsOf(b)).toContain(`recorded evidence ${id} was produced under a different policy snapshot`);
    lab.db.run('UPDATE evidence_reports SET policy_hash = ? WHERE id = ?', lab.policyHash, id);
    expect(problemsOf({ ...b, evidence: { ...b.evidence, checkConfigHash: 'sha256:changed' } })).toContain(`recorded evidence ${id} has a different check configuration`);
    expect(problemsOf({ ...b, evidence: { ...b.evidence, checkConfigHash: 'sha256:checks' } })).toEqual([]);
  });
});

describe('assertRecordedBindings: recorded review', () => {
  it('names a missing review by id when one was given and by candidate when not', () => {
    const b = bindings();
    expect(problemsOf({ ...b, review: { ...b.review, id: 'rv-nope' } })).toContain('no recorded review rv-nope');
    const noId = { ...b.review };
    delete noId.id;
    lab.db.run('DELETE FROM reviews');
    expect(problemsOf({ ...b, review: noId })).toContain(`no recorded review of candidate ${cand.id}`);
  });

  it('ignores an invalidated review when no id was given, and reports it when the id was', () => {
    const b = bindings();
    const noId = { ...b.review };
    delete noId.id;
    lab.db.run('UPDATE reviews SET invalidated_at = 9 WHERE id = ?', b.review.id!);
    expect(problemsOf({ ...b, review: noId })).toContain(`no recorded review of candidate ${cand.id}`);
    expect(problemsOf(b)).toContain(`recorded review ${b.review.id} was invalidated`);
  });

  it('refuses a verdict other than APPROVE and another candidate or tree', () => {
    const b = bindings();
    const id = b.review.id!;
    lab.db.run("UPDATE reviews SET verdict = 'REQUEST_CHANGES' WHERE id = ?", id);
    expect(problemsOf(b)).toContain(`recorded review ${id} has verdict REQUEST_CHANGES, not APPROVE`);
    lab.db.run("UPDATE reviews SET verdict = 'APPROVE', tree_hash = ? WHERE id = ?", 'e'.repeat(40), id);
    expect(problemsOf(b)).toContain(`recorded review ${id} covers another candidate or tree`);
    lab.db.run("UPDATE reviews SET tree_hash = ?, candidate_id = 'cand-other' WHERE id = ?", cand.treeHash, id);
    expect(problemsOf(b)).toContain(`recorded review ${id} covers another candidate or tree`);
  });

  it('collects every problem into one STALE_EVIDENCE refusal', () => {
    const b = bindings();
    lab.db.run("UPDATE evidence_reports SET verdict = 'FAIL'");
    lab.db.run("UPDATE reviews SET verdict = 'BLOCK'");
    expect(() => assertRecordedBindings(lab.db, b)).toThrow(expect.objectContaining({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/not PASS.*not APPROVE/) }));
  });
});

describe('assertDeliverable: objects in hand', () => {
  const run = (over: Partial<GateInput> = {}): GateInput => ({ ...bindings(), ...over });

  it('refuses a durable cancellation and a policy snapshot that no longer hashes to the run', () => {
    expect(() => assertDeliverable(run({ run: { ...lab.deliveryRun, cancelRequested: true } }))).toThrow(expect.objectContaining({ code: 'CANCELLED' }));
    expect(() => assertDeliverable(run({ run: { ...lab.deliveryRun, policyHash: 'sha256:x' } }))).toThrow(expect.objectContaining({ code: 'POLICY_TAMPERED' }));
  });

  it('lists every violated binding, and shortens a tree that is not even a string', () => {
    const input = run();
    input.candidate = { ...cand, treeHash: 'nothex' };
    input.evidence = { ...input.evidence, verdict: 'ERROR', invalidatedAt: 3, candidateId: 'other', treeHash: undefined as unknown as string, policyHash: 'sha256:old', checkConfigHash: 'sha256:a' };
    input.review = { ...input.review, verdict: 'BLOCK', invalidatedAt: 4, candidateId: 'other', treeHash: 'f'.repeat(40) };
    input.expectedCheckConfigHash = 'sha256:b';
    input.currentTree = 'd'.repeat(40);
    let problems: string[] = [];
    try {
      assertDeliverable(input);
    } catch (err) {
      problems = (err as { details: { problems: string[] } }).details.problems;
    }
    expect(problems).toEqual([
      'the candidate has no valid tree hash',
      'evidence verdict is ERROR, not PASS',
      'evidence was invalidated',
      'evidence belongs to a different candidate',
      'evidence covers tree undefined, the candidate is nothex',
      'evidence was produced under a different policy snapshot',
      'evidence was produced with a different check configuration',
      'review verdict is BLOCK, not APPROVE',
      'the review was invalidated',
      'the review belongs to a different candidate',
      `the review covers tree ${'f'.repeat(12)}, the candidate is nothex`,
      `the worktree now has tree ${'d'.repeat(12)}, not the reviewed nothex`,
    ]);
  });
});

describe('verifyCandidateTree', () => {
  it('accepts a commit that carries the reviewed tree', async () => {
    await expect(verifyCandidateTree(lab.work, cand)).resolves.toBeUndefined();
  });

  it('refuses a commit id that is not an object id', async () => {
    await expect(verifyCandidateTree(lab.work, { ...cand, commitSha: 'main' })).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('no valid commit') });
  });

  it('refuses a commit the repository does not have and a commit with another tree', async () => {
    await expect(verifyCandidateTree(lab.work, { ...cand, commitSha: '1'.repeat(40) })).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining('has tree') });
    await expect(verifyCandidateTree(lab.work, { ...cand, treeHash: '2'.repeat(40) })).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringContaining(`the reviewed tree is ${'2'.repeat(12)}`) });
  });
});
