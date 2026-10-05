import { describe, expect, it } from 'vitest';
import { findingFingerprint, splitLocation } from '../../../src/review/types.ts';

describe('splitLocation', () => {
  it('has no path for an empty or blank location', () => {
    expect(splitLocation('')).toEqual({ path: null, line: null });
    expect(splitLocation('   ')).toEqual({ path: null, line: null });
    expect(splitLocation(null)).toEqual({ path: null, line: null });
  });

  it('reads path, path:line and path:line:col, and strips a leading ./', () => {
    expect(splitLocation('./src/a.ts')).toEqual({ path: 'src/a.ts', line: null });
    expect(splitLocation('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', line: 42 });
  });

  it('treats prose as no location', () => {
    expect(splitLocation('the whole change')).toEqual({ path: null, line: null });
    expect(splitLocation(`${'x'.repeat(513)}`)).toEqual({ path: null, line: null });
  });
});

describe('findingFingerprint', () => {
  it('is stable without a category or location, and differs from a finding that has them', () => {
    const bare = findingFingerprint({ category: null, location: null, claim: 'Export omits tenant scope.' });
    expect(bare).toBe(findingFingerprint({ category: null, location: null, claim: 'export OMITS tenant scope' }));
    expect(bare).toMatch(/^fp-[0-9a-f]{16}$/);
    expect(bare).not.toBe(findingFingerprint({ category: 'authorization', location: 'src/export.ts:42', claim: 'Export omits tenant scope.' }));
    // The line does not matter, the file and the category (case-insensitively) do.
    expect(findingFingerprint({ category: ' Authorization ', location: 'src/export.ts:1', claim: 'c' })).toBe(findingFingerprint({ category: 'authorization', location: 'src/export.ts:99', claim: 'c' }));
  });
});
