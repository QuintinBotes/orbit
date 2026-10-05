import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import {
  eliminatedHypothesisIds,
  isNewHypothesis,
  normalizeHypothesis,
  normalizeText,
  proposeHypothesis,
  recordExperiment,
  recordExperimentResult,
  toPrior,
  type PriorHypothesis,
} from '../../../src/inquisition/hypotheses.ts';
import { getHypothesis, listHypotheses } from '../../../src/inquisition/store.ts';
import { RUN, addCheckRun, setup, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const FP = 'fp-pagination';

function prior(over: Partial<PriorHypothesis> = {}): PriorHypothesis {
  return {
    id: 'hyp-1',
    statement: 'The export query applies the page limit before the filter, so rows beyond page one are dropped.',
    fingerprint: FP,
    experiment: 'Run the export against a fixture with 250 matching rows and count the returned rows.',
    expectedObservation: 'Only 100 rows come back instead of 250.',
    status: 'testing',
    ...over,
  };
}

describe('normalization', () => {
  it('ignores case, stop words, hedges and inflection', () => {
    const a = normalizeText('The export query probably applies the page limit before the filter');
    const b = normalizeText('Export queries apply page limits before filtering, I think');
    // Hedges and inflection drop out: both reduce to the same stems.
    expect(a.tokens).toEqual(['apply', 'before', 'export', 'filter', 'limit', 'page', 'query']);
    expect(b.tokens).toEqual(a.tokens);
    expect(b.tokens).not.toContain('probably');
    expect(a.negated).toBe(false);
  });

  it('keeps identifiers and numbers as anchors', () => {
    const n = normalizeText('`applyLimit` runs at page 3 in src/api/export.ts');
    expect(n.anchors).toEqual(expect.arrayContaining(['applylimit', '3', 'src/api/export.ts']));
  });

  it('marks absence words as negation, however many appear', () => {
    expect(normalizeText('The cache key omits the tenant id').negated).toBe(true);
    expect(normalizeText('The cache key is omitting the tenant id and the lookup is missing').negated).toBe(true);
    expect(normalizeText('The cache key includes the tenant id').negated).toBe(false);
  });

  it('gives pure rewordings the same hash and different fingerprints different hashes', () => {
    const a = normalizeHypothesis({ statement: 'The cache key omits the tenant id', fingerprint: FP });
    const b = normalizeHypothesis({ statement: 'Cache keys are omitting tenant ids', fingerprint: FP });
    expect(a.hash).toBe(b.hash);
    expect(normalizeHypothesis({ statement: 'The cache key omits the tenant id', fingerprint: 'other' }).hash).not.toBe(a.hash);
  });
});

describe('isNewHypothesis: changing wording is not a new causal hypothesis', () => {
  it('a rewording with the same test is a duplicate', () => {
    const v = isNewHypothesis(
      {
        statement: 'Rows past the first page are lost because the limit is applied before the filter in the export query.',
        fingerprint: FP,
        experiment: 'Run the export against a fixture with 250 matching rows and count how many rows are returned.',
        expectedObservation: 'Only 100 rows are returned rather than 250.',
      },
      [prior()],
    );
    expect(v).toMatchObject({ isNew: false, kind: 'duplicate', matchedId: 'hyp-1' });
  });

  it('a reworded cause with the identical experiment and observation is still a duplicate', () => {
    const v = isNewHypothesis(
      { statement: 'Pagination truncates the result set early.', fingerprint: FP, experiment: prior().experiment, expectedObservation: prior().expectedObservation },
      [prior()],
    );
    expect(v).toMatchObject({ isNew: false, kind: 'duplicate' });
    expect(v.reason).toContain('same experiment and expected observation');
  });

  it('padding with hedges and filler does not make it new', () => {
    const v = isNewHypothesis({ statement: 'Probably, I think, the export query actually applies the page limit before the filter so rows beyond page one are dropped.', fingerprint: FP }, [prior()]);
    expect(v.isNew).toBe(false);
  });

  it('flipping the polarity is a different cause even with most words shared', () => {
    const p = prior({ statement: 'The cache key includes the tenant id when building the report lookup', experiment: null, expectedObservation: null });
    const v = isNewHypothesis({ statement: 'The cache key omits the tenant id when building the report lookup', fingerprint: FP }, [p]);
    expect(v).toMatchObject({ isNew: true, kind: 'new' });
  });

  it('a different identifier or number is a different cause', () => {
    const p = prior({ statement: 'The loop is off by one at page 2 of the export', experiment: null, expectedObservation: null });
    expect(isNewHypothesis({ statement: 'The loop is off by one at page 3 of the export', fingerprint: FP }, [p]).isNew).toBe(true);
    const q = prior({ statement: 'The `buildQuery` helper drops the filter', experiment: null, expectedObservation: null });
    expect(isNewHypothesis({ statement: 'The `buildFilter` helper drops the filter', fingerprint: FP }, [q]).isNew).toBe(true);
  });

  it('the same words about a different failure fingerprint are new', () => {
    const v = isNewHypothesis({ statement: prior().statement, fingerprint: 'fp-other', experiment: prior().experiment }, [prior()]);
    expect(v).toMatchObject({ isNew: true });
    expect(v.reason).toContain('different failures');
  });

  it('the same experiment expecting a different observation is a different hypothesis', () => {
    const v = isNewHypothesis(
      { statement: 'The export serializer escapes quotes twice.', fingerprint: FP, experiment: prior().experiment, expectedObservation: 'All 250 rows return but the quoted fields contain doubled quote characters.' },
      [prior()],
    );
    expect(v.isNew).toBe(true);
  });

  it('an unrelated cause is new', () => {
    expect(isNewHypothesis({ statement: 'The CSV writer closes the stream before the last chunk is flushed.', fingerprint: FP, experiment: 'Add a flush log line and run the export of 250 rows.', expectedObservation: 'The flush log appears after the stream closed message.' }, [prior()]).isNew).toBe(true);
  });

  it('no earlier hypothesis means new', () => {
    expect(isNewHypothesis({ statement: 'anything at all', fingerprint: FP }, [])).toMatchObject({ isNew: true, reason: 'no earlier hypothesis' });
  });

  it('a different experiment for the same cause is a duplicate unless the earlier test was inconclusive', () => {
    const same = { statement: prior().statement, fingerprint: FP, experiment: 'Add tracing around the limit call and print the query text.', expectedObservation: 'The traced query text shows the limit clause before the where clause.' };
    expect(isNewHypothesis(same, [prior({ status: 'eliminated' })])).toMatchObject({ isNew: false, kind: 'duplicate' });
    expect(isNewHypothesis(same, [prior({ status: 'proposed' })])).toMatchObject({ isNew: false, kind: 'duplicate' });
    const retest = isNewHypothesis(same, [prior({ status: 'inconclusive' })]);
    expect(retest).toMatchObject({ isNew: false, kind: 'retest', matchedId: 'hyp-1' });
  });

  it('when no test is stated on either side, the cause alone decides', () => {
    const bare = prior({ experiment: null, expectedObservation: null });
    expect(isNewHypothesis({ statement: 'The export query applies the page limit before the filter so rows beyond page one drop.', fingerprint: FP }, [bare]).isNew).toBe(false);
  });

  it('a duplicate anywhere beats a retest elsewhere', () => {
    const priors = [prior({ id: 'hyp-1', status: 'inconclusive' }), prior({ id: 'hyp-2', status: 'eliminated', experiment: 'Print the generated query for the export.', expectedObservation: 'Limit precedes where in the printed query.' })];
    const v = isNewHypothesis({ statement: prior().statement, fingerprint: FP, experiment: 'Print the generated query for the export.', expectedObservation: 'Limit precedes where in the printed query.' }, priors);
    expect(v).toMatchObject({ kind: 'duplicate', matchedId: 'hyp-2' });
  });
});

describe('hypothesis records and experiments', () => {
  it('stores a new hypothesis and refuses to store a duplicate', () => {
    env = setup();
    const a = proposeHypothesis(env.db, RUN, { statement: prior().statement, fingerprint: FP }, env.clock);
    expect(a.novelty.isNew).toBe(true);
    expect(a.record).toMatchObject({ status: 'proposed', fingerprint: FP });
    const b = proposeHypothesis(env.db, RUN, { statement: 'The page limit is applied before the filter in the export query, dropping later rows.', fingerprint: FP }, env.clock);
    expect(b.record).toBeNull();
    expect(b.novelty.matchedId).toBe(a.record!.id);
    expect(listHypotheses(env.db, RUN)).toHaveLength(1);
  });

  it('needs a statement and a fingerprint', () => {
    env = setup();
    expect(() => proposeHypothesis(env!.db, RUN, { statement: ' ', fingerprint: FP }, env!.clock)).toThrow(/statement/);
    expect(() => proposeHypothesis(env!.db, RUN, { statement: 'x y z', fingerprint: '' }, env!.clock)).toThrow(/fingerprint/);
  });

  it('records the expectation before the result and requires evidence to support or eliminate', () => {
    env = setup();
    const { record } = proposeHypothesis(env.db, RUN, { statement: prior().statement, fingerprint: FP }, env.clock);
    const id = record!.id;
    // Result before experiment
    try {
      recordExperimentResult(env.db, id, { outcome: 'eliminated', observation: 'x', evidence: ['chk-1'] }, env.clock);
      throw new Error('expected rejection');
    } catch (err) {
      expect(isOrbitError(err, 'TRANSITION_INVALID')).toBe(true);
    }
    expect(() => recordExperiment(env!.db, id, { experiment: 'count rows', expectedObservation: ' ' }, env!.clock)).toThrow(/expected observation/);
    const testing = recordExperiment(env.db, id, { experiment: prior().experiment!, expectedObservation: prior().expectedObservation! }, env.clock);
    expect(testing.status).toBe('testing');
    expect(() => recordExperimentResult(env!.db, id, { outcome: 'eliminated', observation: '250 rows came back', evidence: [] }, env!.clock)).toThrow(/with evidence/);
    expect(() => recordExperimentResult(env!.db, id, { outcome: 'supported', observation: '', evidence: ['chk-1'] }, env!.clock)).toThrow(/observation/);
    addCheckRun(env.db, 'chk-9', 'reports-tests');
    const done = recordExperimentResult(env.db, id, { outcome: 'eliminated', observation: '250 rows came back, so the limit is not applied early', evidence: ['chk-9'] }, env.clock);
    expect(done).toMatchObject({ status: 'eliminated', outcome: { evidence: ['chk-9'] } });
    expect(eliminatedHypothesisIds(env.db, RUN)).toEqual([id]);
    // Settled hypotheses are final.
    expect(() => recordExperiment(env!.db, id, { experiment: 'again', expectedObservation: 'same' }, env!.clock)).toThrow(/already eliminated/);
  });

  it('an inconclusive result may be followed by another experiment, which then needs no evidence of its own', () => {
    env = setup();
    const id = proposeHypothesis(env.db, RUN, { statement: prior().statement, fingerprint: FP }, env.clock).record!.id;
    recordExperiment(env.db, id, { experiment: 'first try', expectedObservation: 'first expectation' }, env.clock);
    const inc = recordExperimentResult(env.db, id, { outcome: 'inconclusive', observation: 'the fixture was too small to tell', evidence: [] }, env.clock);
    expect(inc.status).toBe('inconclusive');
    expect(recordExperiment(env.db, id, { experiment: 'second try with 250 rows', expectedObservation: 'second expectation' }, env.clock).status).toBe('testing');
    // And a retest of the same cause is accepted as a new record, though not "new" for budget purposes.
    const r = proposeHypothesis(env.db, RUN, { statement: prior().statement, fingerprint: FP, experiment: 'Trace the generated SQL text.', expectedObservation: 'LIMIT appears before WHERE in the trace.' }, env.clock);
    expect(r.novelty.kind).toBe('duplicate');
  });

  it('toPrior maps rows for the novelty check', () => {
    env = setup();
    const rec = proposeHypothesis(env.db, RUN, { statement: 'abc def ghi', fingerprint: FP, experiment: 'e', expectedObservation: 'o' }, env.clock).record!;
    expect(toPrior(getHypothesis(env.db, rec.id))).toMatchObject({ id: rec.id, fingerprint: FP, experiment: 'e', expectedObservation: 'o', status: 'proposed' });
  });
});
