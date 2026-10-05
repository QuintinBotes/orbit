import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import {
  AMENDMENT_STATUSES,
  HYPOTHESIS_STATUSES,
  LEDGER_EVIDENCE_KINDS,
  LEDGER_STATUSES,
  QUESTION_STATUSES,
  amendmentHistory,
  findHypothesis,
  fingerprintOccurrences,
  getAmendment,
  insertHypothesis,
  insertAmendment,
  listAmendments,
  listFailures,
  resolveAmendment,
  withdrawQuestion,
  writeHypothesis,
  getQuestion,
} from '../../../src/inquisition/store.ts';
import { persistQuestion } from '../../../src/inquisition/questions.ts';
import { RUN, addFailure, goodQuestion, setup, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const REC = { field: 'acceptance_criteria[AC-1].proof', old_value: ['a'], new_value: ['a', 'b'], evidence: 'e', reason: 'r', approval_required: false, affected_verification: ['AC-1'] };

describe('status vocabularies (exported for the knowledge extractor)', () => {
  it('are the spec values', () => {
    expect(QUESTION_STATUSES).toEqual(['open', 'answered', 'withdrawn']);
    expect(LEDGER_STATUSES).toEqual(['unverified', 'supported', 'rejected', 'needs-decision']);
    expect(AMENDMENT_STATUSES).toEqual(['applied', 'pending-approval', 'rejected']);
    expect(HYPOTHESIS_STATUSES).toEqual(['proposed', 'testing', 'supported', 'eliminated', 'inconclusive']);
    expect(LEDGER_EVIDENCE_KINDS).not.toContain('claim');
  });
});

describe('questions', () => {
  it('an open question can be withdrawn once; an unknown run or id is NOT_FOUND', () => {
    env = setup();
    const q = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    expect(withdrawQuestion(env.db, q.id, 'superseded', env.clock).status).toBe('withdrawn');
    expect(withdrawQuestion(env.db, q.id, 'again', env.clock).status).toBe('withdrawn');
    try {
      getQuestion(env.db, 'q-none');
    } catch (err) {
      expect(isOrbitError(err, 'NOT_FOUND')).toBe(true);
    }
    try {
      persistQuestion(env.db, 'no-such-run', 'clarify', goodQuestion(), env.clock);
      throw new Error('expected NOT_FOUND');
    } catch (err) {
      expect(isOrbitError(err, 'NOT_FOUND')).toBe(true);
    }
  });
});

describe('hypothesis fingerprint', () => {
  const NEW = { runId: RUN, statement: 'Pagination truncates the result set early.', normalizedHash: 'sha256:h1', fingerprint: 'fp-0123456789abcdef' };
  const column = (env: Env, id: string) => env.db.get<{ fingerprint: string | null; result: string | null }>('SELECT fingerprint, result FROM hypotheses WHERE id = ?', id)!;

  it('is stored in the fingerprint column and not inside the result JSON', () => {
    env = setup();
    const h = insertHypothesis(env.db, NEW, env.clock);
    expect(h.fingerprint).toBe(NEW.fingerprint);
    const row = column(env, h.id);
    expect(row.fingerprint).toBe(NEW.fingerprint);
    expect(JSON.parse(row.result!)).toEqual({ outcome: null });

    writeHypothesis(env.db, h.id, { status: 'testing', experiment: 'Run the export with 3 pages' }, env.clock);
    writeHypothesis(env.db, h.id, { status: 'eliminated', outcome: { status: 'eliminated', observation: 'all rows present', evidence: ['unit.log'], at: 1 } }, env.clock);
    const after = column(env, h.id);
    expect(after.fingerprint).toBe(NEW.fingerprint);
    expect(Object.keys(JSON.parse(after.result!))).toEqual(['outcome']);
    expect(findHypothesis(env.db, h.id)).toMatchObject({ fingerprint: NEW.fingerprint, status: 'eliminated' });
  });

  it('is read from the column, whatever an old result blob says', () => {
    env = setup();
    const h = insertHypothesis(env.db, NEW, env.clock);
    env.db.run('UPDATE hypotheses SET result = ? WHERE id = ?', JSON.stringify({ fingerprint: 'fp-stale', outcome: null }), h.id);
    expect(getHypothesisFingerprint(env, h.id)).toBe(NEW.fingerprint);
  });

  it('still reads a row written before the column existed, and moves it onto the column when updated', () => {
    env = setup();
    const h = insertHypothesis(env.db, NEW, env.clock);
    env.db.run('UPDATE hypotheses SET fingerprint = NULL, result = ? WHERE id = ?', JSON.stringify({ fingerprint: 'fp-legacy', outcome: null }), h.id);
    expect(getHypothesisFingerprint(env, h.id)).toBe('fp-legacy');
    writeHypothesis(env.db, h.id, { status: 'testing' }, env.clock);
    expect(column(env, h.id)).toMatchObject({ fingerprint: 'fp-legacy' });
  });
});

function getHypothesisFingerprint(env: Env, id: string): string | undefined {
  return findHypothesis(env.db, id)?.fingerprint;
}

describe('amendments', () => {
  it('keeps the proposed change so an approval can re-apply it, and exposes applied ones as history', () => {
    env = setup();
    const change = { op: 'add_proof' as const, criterion_id: 'AC-1', proof: ['b'] };
    const a = insertAmendment(env.db, { runId: RUN, record: REC, change, status: 'applied' }, env.clock);
    insertAmendment(env.db, { runId: RUN, record: { ...REC, approval_required: true }, change, status: 'pending-approval', note: 'removes proof' }, env.clock);
    expect(getAmendment(env.db, a.id)).toMatchObject({ change, status: 'applied', record: REC });
    expect(amendmentHistory(env.db, RUN)).toEqual([REC]);
    expect(listAmendments(env.db, RUN)).toHaveLength(2);
    expect(listAmendments(env.db, RUN, { status: 'pending-approval' })[0]!.note).toBe('removes proof');
  });

  it('pending -> applied or rejected exactly once', () => {
    env = setup();
    const a = insertAmendment(env.db, { runId: RUN, record: { ...REC, approval_required: true }, change: null, status: 'pending-approval' }, env.clock);
    expect(resolveAmendment(env.db, a.id, 'rejected', 'dec-1', env.clock).status).toBe('rejected');
    expect(resolveAmendment(env.db, a.id, 'rejected', 'dec-1', env.clock).status).toBe('rejected');
    try {
      resolveAmendment(env.db, a.id, 'applied', 'dec-2', env.clock);
      throw new Error('expected rejection');
    } catch (err) {
      expect(isOrbitError(err, 'TRANSITION_INVALID')).toBe(true);
    }
  });
});

describe('failures (read-only view)', () => {
  it('lists failures in order and counts distinct candidates per fingerprint', () => {
    env = setup();
    addFailure(env.db, 'fp-a', 'c1', 'first');
    addFailure(env.db, 'fp-a', 'c1', 'second');
    addFailure(env.db, 'fp-a', 'c2', 'third');
    addFailure(env.db, 'fp-b', null, 'x');
    addFailure(env.db, 'fp-b', null, 'y');
    const all = listFailures(env.db, RUN);
    expect(all.map((f) => f.excerpt)).toEqual(['first', 'second', 'third', 'x', 'y']);
    const occ = fingerprintOccurrences(all);
    expect(occ.get('fp-a')).toMatchObject({ candidates: ['c1', 'c2'], rows: 3, excerpt: 'third' });
    // Failures with no candidate cannot be shown to be the same attempt, so each counts on its own.
    expect(occ.get('fp-b')?.candidates).toHaveLength(2);
  });
});
