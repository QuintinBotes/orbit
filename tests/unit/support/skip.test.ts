import { describe, expect, it } from 'vitest';
import { onCi, requiredOnCi, skipOrFailOnCi } from '../../support/skip.ts';

// Review of #204: a test that needs ps, Chromium or srt skips where they are missing, but fails under CI, which
// provides them all, so a runner that lost one never passes by skipping.
describe('skipping for a missing capability', () => {
  const ctx = () => {
    const skipped: (string | undefined)[] = [];
    return { skipped, skip: (condition: boolean, note?: string) => void (condition && skipped.push(note)) };
  };

  it('skips with the reason outside CI, and does nothing when nothing is missing', () => {
    const c = ctx();
    skipOrFailOnCi(c, 'ps cannot run here', {});
    skipOrFailOnCi(c, null, { CI: 'true' });
    expect(c.skipped).toEqual(['ps cannot run here']);
  });

  it('fails with the reason under CI instead of skipping', () => {
    const c = ctx();
    expect(() => skipOrFailOnCi(c, 'Chromium cannot start here', { CI: 'true' })).toThrow(/^Chromium cannot start here; CI provides it/);
    expect(c.skipped).toEqual([]);
  });

  it('passes an srt probe through outside CI, and throws its detail under CI when it is unavailable', () => {
    const down = { ok: false, detail: 'srt could not start a sandboxed command' };
    expect(requiredOnCi(down, {})).toBe(down);
    expect(() => requiredOnCi(down, { CI: '1' })).toThrow(/^srt could not start a sandboxed command; CI provides it/);
    const up = { ok: true, detail: 'srt 0.0.78' };
    expect(requiredOnCi(up, { CI: 'true' })).toBe(up);
  });

  it('reads CI the way CI services set it', () => {
    expect([onCi({ CI: 'true' }), onCi({ CI: '1' }), onCi({}), onCi({ CI: '' }), onCi({ CI: 'false' }), onCi({ CI: '0' })]).toEqual([true, true, false, false, false, false]);
  });
});
