import { describe, expect, it } from 'vitest';
import { clipAtWord } from '../../../src/core/text.ts';

describe('clipAtWord', () => {
  it('returns text that fits unchanged', () => {
    expect(clipAtWord('a short claim', 40)).toBe('a short claim');
    expect(clipAtWord('two\nlines', 9)).toBe('two\nlines');
  });

  it('cuts at the last whole word that fits, with an ellipsis, never mid-word', () => {
    const claim = 'The fail-before evidence for AC-1, AC-2 and AC-3 shows only a load failure. It does not show that any assertion about the criteria failed.';
    for (let max = 20; max < claim.length; max += 7) {
      const out = clipAtWord(claim, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(out.endsWith('...')).toBe(true);
      const kept = out.slice(0, -3);
      // Whatever is kept is a prefix of whole words of the original.
      expect(claim.startsWith(kept)).toBe(true);
      expect(/[\s,;:]/.test(claim[kept.length] ?? ' ')).toBe(true);
    }
  });

  it('does not end on a dangling separator and collapses whitespace once it cuts', () => {
    expect(clipAtWord('alpha beta,\n  gamma delta', 16)).toBe('alpha beta...');
  });

  it('cuts a single token longer than the limit where it must', () => {
    expect(clipAtWord('x'.repeat(50), 10)).toBe(`${'x'.repeat(7)}...`);
  });
});
