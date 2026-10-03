import { describe, expect, it } from 'vitest';
import { compareWording, normalizeEntry, wordTokens } from '../../../src/contract/wording.ts';

const base = 'Export all matching records, including records beyond the current page.';

describe('compareWording', () => {
  it.each([
    [base, base],
    [base, 'Export ALL matching records including records beyond the current page'],
    [base, 'Export all matching records, including all records beyond the current page, always.'],
    [base, 'Export all matching records, including the records beyond the current page, completely and correctly.'],
  ])('accepts a pure clarification: %s -> %s', (a, b) => {
    expect(compareWording(a, b)).toEqual({ clarification: true, reasons: [] });
  });

  // Each keeps every old word in order and adds no hedge, yet narrows what
  // must be delivered. A list of suspicious words cannot catch these, so any
  // added word outside the neutral list needs a human decision.
  it.each([
    `Export all matching records, including records beyond the current page, for the demo dataset.`,
    `Export all matching records, including records beyond the current page, in a mocked environment.`,
    `Export all matching records, including records beyond the current page, other than archived records.`,
    `Export all matching records, including records beyond the current page, archived records aside.`,
    `Export all matching records, including records beyond the current page, with archived records left out.`,
    `Export all matching records of the active tenant, including records beyond the current page.`,
    `Export all matching records, including records beyond the current page, as a stretch goal.`,
    `Export all matching records, including records beyond the current page, deferred to a follow-up.`,
    `Export all 100 matching records, including records beyond the current page.`,
  ])('treats a narrowing rewrite made of plain words as weakening: %s', (b) => {
    const v = compareWording(base, b);
    expect(v.clarification).toBe(false);
    expect(v.reasons.join(' ')).toContain('adds words that can narrow or redefine it');
  });

  it('lists a bounded number of added words', () => {
    const v = compareWording('Export records.', 'Export records one two three four five six seven eight nine ten.');
    expect(v.reasons).toEqual(['the new text adds words that can narrow or redefine it (one, two, three, four, five, six, seven, eight, and 2 more)']);
  });

  it.each([
    ['Export records on the current page.', 'drops or reorders'],
    ['Export all matching records.', 'drops or reorders'],
    ['Export all records matching, including records beyond the current page.', 'drops or reorders'],
    [`${base} Only for admins.`, 'only'],
    [`${base} If possible.`, 'if'],
    [`Export all matching records, including records beyond the current page, unless there are many.`, 'unless'],
    [`Export all matching records, including records beyond the current page, or the first page.`, 'first, or'],
    [`Export all matching records, including records beyond the current page, up to 1000 rows.`, 'up to'],
    [`Export all matching records, including records beyond the current page, but not archived ones.`, 'but, not'],
    [`Export all matching records, including records beyond the current page; this should work.`, 'should'],
    [`Export all matching records, including records beyond the current page, don't block.`, 'don'],
    ['', 'empty'],
  ])('treats %j as weakening (%s)', (b, hint) => {
    const v = compareWording(base, b);
    expect(v.clarification).toBe(false);
    expect(v.reasons.join(' ')).toContain(hint.split(',')[0]!);
  });

  it('only counts qualifiers the new text adds', () => {
    const old = 'Only admins can export all matching records.';
    expect(compareWording(old, 'Only admins can export all matching records correctly.').clarification).toBe(true);
    expect(compareWording(old, 'Only admins can export all matching records only once.').clarification).toBe(false);
  });

  it('tokenizes case- and punctuation-insensitively, folding compatibility forms', () => {
    expect(wordTokens('Ｅxport, ALL-records!')).toEqual(['export', 'all', 'records']);
    expect(normalizeEntry('  Header ordering; escaping tests PASS ')).toBe('header ordering escaping tests pass');
  });
});
