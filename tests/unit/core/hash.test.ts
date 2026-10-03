import { describe, expect, it } from 'vitest';
import { canonicalJson, hashObject, sha256 } from '../../../src/core/hash.ts';

describe('canonicalJson', () => {
  it('sorts object keys at every depth and leaves no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } })).toBe('{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('gives identical bytes for semantically equal values built in different orders', () => {
    const one = { policy: { checks: ['lint', 'test'], mode: 'autonomous' }, run: 'r1' };
    const two = { run: 'r1', policy: { mode: 'autonomous', checks: ['lint', 'test'] } };
    expect(canonicalJson(one)).toBe(canonicalJson(two));
    expect(hashObject(one)).toBe(hashObject(two));
  });

  it('preserves array order, because order is meaningful in arrays', () => {
    expect(canonicalJson([2, 1])).not.toBe(canonicalJson([1, 2]));
    expect(hashObject({ checks: ['a', 'b'] })).not.toBe(hashObject({ checks: ['b', 'a'] }));
  });

  it('drops undefined members so an absent and an undefined field hash the same', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
    expect(hashObject({ a: 1, b: undefined })).toBe(hashObject({ a: 1 }));
  });

  it('keeps null distinct from absent', () => {
    expect(hashObject({ a: null })).not.toBe(hashObject({}));
  });

  it('renders undefined inside arrays as null, like JSON', () => {
    expect(canonicalJson([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('handles scalars, unicode and empty containers', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(1.5)).toBe('1.5');
    expect(canonicalJson(true)).toBe('true');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson({})).toBe('{}');
    expect(canonicalJson([])).toBe('[]');
    expect(canonicalJson({ 'é': 'ü', a: '\u0000' })).toBe('{"a":"\\u0000","é":"ü"}');
  });

  it('sorts keys by code unit, independent of insertion order and locale', () => {
    expect(canonicalJson({ b: 1, B: 2, a: 3, _: 4, '1': 5 })).toBe('{"1":5,"B":2,"_":4,"a":3,"b":1}');
  });

  it('distinguishes values whose naive concatenation would collide', () => {
    expect(hashObject({ a: 'b,c' })).not.toBe(hashObject({ a: 'b', c: undefined, 'b,c': undefined }));
    expect(hashObject(['ab', 'c'])).not.toBe(hashObject(['a', 'bc']));
  });

  // KNOWN DEFECT, reported to the owner of src/core/hash.ts: sortValue
  // rebuilds every object from Object.keys, so a Date (no own keys) becomes
  // {} and two different dates hash identically. Flip to `it` once fixed.
  it('serializes Dates through toJSON so different dates hash differently', () => {
    expect(hashObject({ at: new Date(1) })).not.toBe(hashObject({ at: new Date(2) }));
  });
});

describe('sha256 and hashObject', () => {
  it('matches the FIPS 180-2 test vectors', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('hashes bytes and the equivalent string identically', () => {
    expect(sha256(new TextEncoder().encode('héllo'))).toBe(sha256('héllo'));
  });

  it('prefixes the algorithm and hashes the canonical form', () => {
    const h = hashObject({ b: 2, a: 1 });
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(h).toBe(`sha256:${sha256('{"a":1,"b":2}')}`);
  });

  it('changes when any nested value changes', () => {
    const base = { policy: { paths: ['src/**'], budget: { attempts: 3 } } };
    const changed = { policy: { paths: ['src/**'], budget: { attempts: 4 } } };
    expect(hashObject(base)).not.toBe(hashObject(changed));
  });
});
