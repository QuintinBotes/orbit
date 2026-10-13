// The clauses the fail-before classifiers ask one by one (ADR 0014, 0.3.1 addendum): a review finding is a note, and a
// planner criterion is dropped, only when every clause is about the one thing, so no part of a statement may be lost.
import { describe, expect, it } from 'vitest';
import { clausesOf } from '../../../src/core/clauses.ts';

describe('clausesOf', () => {
  it('splits at sentences, semicolons, colons and the conjunctions that join clauses', () => {
    expect(clausesOf('The log is a load failure. It shows nothing; the tests omit ties: see AC-2.')).toEqual(['The log is a load failure', 'It shows nothing', 'the tests omit ties', 'see AC-2']);
    expect(clausesOf('A fails and B passes, but C hangs; however, D. Although E, F while G whereas H and also I.')).toEqual(['A fails', 'B passes', 'C hangs', 'D', 'E, F', 'G', 'H', 'I']);
  });

  it('splits at commas only when asked', () => {
    expect(clausesOf('Although E, F', { commas: true })).toEqual(['E', 'F']);
  });

  it('keeps an aside in parentheses as clauses of its own, after the clause it sits in, nested ones included', () => {
    expect(clausesOf('The new tests fail on the base revision (ImportError for round_price) and pass with the change.')).toEqual(['The new tests fail on the base revision', 'ImportError for round_price', 'pass with the change']);
    expect(clausesOf('The new tests (which cover ties (and negatives)) fail.')).toEqual(['The new tests fail', 'which cover ties', 'negatives']);
    expect(clausesOf('It fails (unclosed aside and more')).toEqual(['It fails', 'unclosed aside', 'more']);
  });

  it('keeps the parentheses of a call, a decimal point and a path within their clause', () => {
    expect(clausesOf('round_price(2.675) returns 2.68 for tests/test_pricing.py:3.')).toEqual(['round_price(2.675) returns 2.68 for tests/test_pricing.py:3']);
  });

  it('keeps a list of criterion ids within its clause', () => {
    for (const ids of ['AC-1, AC-2 and AC-3', 'AC-1 to AC-4', 'AC-1, AC-2, AC-3 and AC-4', 'AC-1 through AC-7 and AC-9', 'AC-1 and AC-2']) {
      expect(clausesOf(`The evidence for ${ids} is a load failure.`, { commas: true }), ids).toEqual([`The evidence for ${ids} is a load failure`]);
    }
    expect(clausesOf('The evidence for AC-1 and the tests omit ties.')).toEqual(['The evidence for AC-1', 'the tests omit ties']);
  });

  it('leaves out a part that names only criterion ids or an abbreviation, and nothing else', () => {
    expect(clausesOf('A load failure (AC-2, AC-3).')).toEqual(['A load failure']);
    // Only a criterion id says nothing: another code is something the statement says.
    expect(clausesOf('The tests fail (HTTP-403).')).toEqual(['The tests fail', 'HTTP-403']);
    expect(clausesOf('A load failure (e.g. ImportError).')).toEqual(['A load failure', 'ImportError']);
    expect(clausesOf('f(0) = 1')).toEqual(['f(0) = 1']);
  });
});
