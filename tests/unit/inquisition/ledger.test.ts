import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError, type OrbitErrorCode } from '../../../src/core/errors.ts';
import { recordDecision } from '../../../src/storage/decisions.ts';
import { addAssumption, blockingAssumptions, entriesFromWorker, ledgerCounts, transitionAssumption, unverifiedAssumptions } from '../../../src/inquisition/ledger.ts';
import { answerQuestion, persistQuestion } from '../../../src/inquisition/questions.ts';
import { getLedgerEntry, insertLedgerEntry, type NewLedgerEntry } from '../../../src/inquisition/store.ts';
import { RUN, addCheckRun, goodQuestion, inquisitorOutput, setup, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function expectCode(fn: () => unknown, code: OrbitErrorCode): void {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, code), String(err)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

const BASE: Omit<NewLedgerEntry, 'evidence'> = {
  runId: RUN,
  claim: 'Exports use the existing report query.',
  source: 'apps/api/reports.ts:40',
  confidence: 'medium',
  consequence: 'Exports would disagree with the on-screen report.',
  reversibility: 'reversible',
  experiment: 'Compare export rows with the report query on a fixture.',
};

describe('addAssumption', () => {
  it('stores an unverified entry with qualitative confidence', () => {
    env = setup();
    const e = addAssumption(env.db, BASE, env.clock);
    expect(e).toMatchObject({ status: 'unverified', confidence: 'medium', reversibility: 'reversible', evidence: [] });
  });

  it('rejects missing fields and invented confidence values', () => {
    env = setup();
    expectCode(() => addAssumption(env!.db, { ...BASE, claim: ' ' }, env!.clock), 'SCHEMA_INVALID');
    expectCode(() => addAssumption(env!.db, { ...BASE, consequence: null }, env!.clock), 'SCHEMA_INVALID');
    expectCode(() => addAssumption(env!.db, { ...BASE, confidence: 0.93 as never }, env!.clock), 'SCHEMA_INVALID');
    expectCode(() => addAssumption(env!.db, { ...BASE, reversibility: 'maybe' as never }, env!.clock), 'SCHEMA_INVALID');
  });

  it('cannot start supported or rejected without settling evidence', () => {
    env = setup();
    expectCode(() => addAssumption(env!.db, { ...BASE, status: 'supported' }, env!.clock), 'SCHEMA_INVALID');
    expectCode(() => addAssumption(env!.db, { ...BASE, status: 'rejected', evidence: [{ kind: 'review', ref: 'rev-1' }] }, env!.clock), 'SCHEMA_INVALID');
    addCheckRun(env.db, 'chk-1', 'reports-tests');
    const ok = addAssumption(env.db, { ...BASE, status: 'supported', evidence: [{ kind: 'check', ref: 'chk-1' }] }, env.clock);
    expect(ok.status).toBe('supported');
    expect(ok.evidence[0]).toMatchObject({ kind: 'check', ref: 'chk-1', at: env.clock.now() });
  });

  it('a costly or irreversible claim that cannot be tested is a needs-decision, not a working assumption', () => {
    env = setup();
    expect(addAssumption(env.db, { ...BASE, reversibility: 'irreversible', experiment: null }, env.clock).status).toBe('needs-decision');
    expect(addAssumption(env.db, { ...BASE, claim: 'Second claim here.', reversibility: 'costly-to-reverse', experiment: ' ' }, env.clock).status).toBe('needs-decision');
    expect(addAssumption(env.db, { ...BASE, claim: 'Third claim here.', reversibility: 'irreversible' }, env.clock).status).toBe('unverified');
  });
});

describe('transitionAssumption: only on evidence', () => {
  function entry(over: Partial<Omit<NewLedgerEntry, 'evidence'>> = {}) {
    return addAssumption(env!.db, { ...BASE, ...over }, env!.clock);
  }

  it('needs evidence and a settling kind', () => {
    env = setup();
    const e = entry();
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [], env!.clock), 'SCHEMA_INVALID');
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'review', ref: 'rev-9' }], env!.clock), 'SCHEMA_INVALID');
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'claim' as never, ref: 'worker said so' }], env!.clock), 'SCHEMA_INVALID');
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'experiment', ref: '  ' }], env!.clock), 'SCHEMA_INVALID');
    expect(getLedgerEntry(env.db, e.id).status).toBe('unverified');
  });

  it('records the evidence with the transition and keeps earlier evidence', () => {
    env = setup();
    const e = entry();
    addCheckRun(env.db, 'chk-1', 'reports-tests');
    const supported = transitionAssumption(env.db, e.id, 'supported', [{ kind: 'check', ref: 'chk-1', note: 'rows match' }, { kind: 'inspection', ref: 'apps/api/reports.ts:40' }], env.clock);
    expect(supported.status).toBe('supported');
    expect(supported.evidence.map((x) => x.ref)).toEqual(['chk-1', 'apps/api/reports.ts:40']);
    addCheckRun(env.db, 'chk-2', 'reports-tests');
    const rejected = transitionAssumption(env.db, e.id, 'rejected', [{ kind: 'experiment', ref: 'chk-2', note: 'a later fixture disagreed' }], env.clock);
    expect(rejected.status).toBe('rejected');
    expect(rejected.evidence).toHaveLength(3);
    expect(env.db.all("SELECT type FROM events WHERE type = 'ledger.transition'")).toHaveLength(2);
  });

  it('fabricated check or decision references are refused', () => {
    env = setup();
    const e = entry();
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'check', ref: 'chk-ghost' }], env!.clock), 'NOT_FOUND');
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'decision', ref: 'dec-ghost' }], env!.clock), 'NOT_FOUND');
  });

  it('same-status calls are no-ops and impossible edges are refused', () => {
    env = setup();
    const e = entry();
    expect(transitionAssumption(env.db, e.id, 'unverified', [], env.clock).evidence).toEqual([]);
    addCheckRun(env.db, 'chk-1', 'reports-tests');
    transitionAssumption(env.db, e.id, 'rejected', [{ kind: 'experiment', ref: 'chk-1' }], env.clock);
    expectCode(() => transitionAssumption(env!.db, e.id, 'needs-decision', [{ kind: 'inspection', ref: 'x' }], env!.clock), 'TRANSITION_INVALID');
    expectCode(() => transitionAssumption(env!.db, e.id, 'unverified', [{ kind: 'inspection', ref: 'x' }], env!.clock), 'TRANSITION_INVALID');
  });

  it('supported goes back to unverified when its evidence goes stale', () => {
    env = setup();
    const e = entry();
    transitionAssumption(env.db, e.id, 'supported', [{ kind: 'inspection', ref: 'a.ts:1' }], env.clock);
    expect(transitionAssumption(env.db, e.id, 'unverified', [{ kind: 'check', ref: addCheckRunId('chk-stale') }], env.clock).status).toBe('unverified');
  });

  function addCheckRunId(id: string): string {
    addCheckRun(env!.db, id, 'lint');
    return id;
  }

  it('needs-decision only resolves through a human answer', () => {
    env = setup();
    const e = entry({ reversibility: 'irreversible', experiment: null });
    expect(e.status).toBe('needs-decision');
    // An inspection or a model-recorded decision is not enough.
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'inspection', ref: 'a.ts:1' }], env!.clock), 'POLICY_DENIED');
    const modelDecision = recordDecision(env.db, env.runDir, { runId: RUN, kind: 'inquisition.resolve', summary: 'model chose' }, env.clock);
    expectCode(() => transitionAssumption(env!.db, e.id, 'supported', [{ kind: 'decision', ref: modelDecision.id }], env!.clock), 'POLICY_DENIED');
    const q = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    const answered = answerQuestion(env.db, env.runDir, q.id, 'Current page', 'alice', env.clock);
    const settled = transitionAssumption(env.db, e.id, 'supported', [{ kind: 'decision', ref: answered.decision.id }], env.clock);
    expect(settled.status).toBe('supported');
  });

  it('counts and lists by status', () => {
    env = setup();
    entry();
    entry({ claim: 'Another claim here.', reversibility: 'irreversible', experiment: null });
    expect(ledgerCounts(env.db, RUN)).toEqual({ unverified: 1, supported: 0, rejected: 0, 'needs-decision': 1 });
    expect(blockingAssumptions(env.db, RUN)).toHaveLength(1);
    expect(unverifiedAssumptions(env.db, RUN)).toHaveLength(1);
  });
});

describe('entriesFromWorker: a model cannot earn a status', () => {
  it('records asserted supported and rejected as unverified claims', () => {
    env = setup();
    const out = inquisitorOutput({
      ledger: [
        { claim: 'The report query is reused.', source: 'reports.ts', confidence: 'high', consequence_if_wrong: 'row mismatch', reversibility: 'reversible', validation_experiment: 'compare rows', status: 'supported' },
        { claim: 'Timezone is local.', source: 'docs', confidence: 'low', consequence_if_wrong: 'wrong dates', reversibility: 'costly-to-reverse', validation_experiment: null, status: 'needs-decision' },
        { claim: 'Rows are never deleted.', source: 'schema', confidence: 'medium', consequence_if_wrong: 'data loss', reversibility: 'irreversible', validation_experiment: null, status: 'unverified' },
        { claim: 'The export is stateless.', source: 'code', confidence: 'medium', consequence_if_wrong: 'caching bugs', reversibility: 'reversible', validation_experiment: 'two calls', status: 'rejected' },
      ],
    });
    const drafts = entriesFromWorker(RUN, out, 5);
    expect(drafts.map((d) => d.status)).toEqual(['unverified', 'needs-decision', 'needs-decision', 'unverified']);
    expect(drafts[0]?.evidence?.[0]).toMatchObject({ kind: 'asserted', ref: 'inquisitor-output' });
    expect(drafts[0]?.evidence?.[0]?.note).toContain('asserted "supported"');
    const stored = insertLedgerEntry(env.db, drafts[0]!, env.clock);
    expect(stored.status).toBe('unverified');
  });
});
