import { describe, expect, it } from 'vitest';
import { missingTestRefutations, resolveFindings } from '../../../src/review/resolve.ts';
import { MISSING_TEST_CATEGORY } from '../../../src/review/types.ts';
import { TREE_A, rfinding, rreview, snapshotOf } from './fixtures.ts';

const covered = (path: string): string[] => (path === 'src/export.ts' ? ['tests/export.test.ts'] : []);

function resolve(findings: ReturnType<typeof rfinding>[], testsFor = covered, tree = TREE_A) {
  return resolveFindings({ findings, snapshot: snapshotOf(), evidence: missingTestRefutations(findings, testsFor, tree), treeHash: TREE_A, reviews: [rreview()] });
}

describe('a missing-test finding the repository map refutes (#144, #175 US1)', () => {
  it('is rejected when the map links a test of the candidate to the file it names, and blocks nothing', () => {
    const f = rfinding({ category: MISSING_TEST_CATEGORY, location: 'src/export.ts:42', claim: 'src/export.ts has no test.' });
    const r = resolve([f]);
    expect(r.rejected.map((d) => d.findingId)).toEqual([f.id]);
    expect(r.blocking).toEqual([]);
    expect(r.rejected[0]!.reason).toContain('repository map of tree');
    expect(r.rejected[0]!.reason).toContain('tests/export.test.ts');
  });

  it('stays open when the map links no test to the file', () => {
    const f = rfinding({ category: MISSING_TEST_CATEGORY, location: 'src/other.ts', claim: 'src/other.ts has no test.' });
    const r = resolve([f]);
    expect(r.rejected).toEqual([]);
    expect(r.blocking.map((d) => d.findingId)).toEqual([f.id]);
  });

  it('decides by the category and the location, never by the wording: a test-adequacy finding about the same file is not refuted', () => {
    const f = rfinding({ category: 'test-adequacy', location: 'src/export.ts:42', claim: 'There is no test for the tenant scope.' });
    expect(missingTestRefutations([f], covered, TREE_A)).toEqual([]);
    expect(resolve([f]).blocking.map((d) => d.findingId)).toEqual([f.id]);
  });

  it('a finding without a location is not refuted', () => {
    expect(missingTestRefutations([rfinding({ category: MISSING_TEST_CATEGORY, location: null })], covered, TREE_A)).toEqual([]);
  });

  it('evidence from the map of another tree does not count', () => {
    const f = rfinding({ category: MISSING_TEST_CATEGORY, location: 'src/export.ts' });
    const r = resolve([f], covered, 'c'.repeat(40));
    expect(r.rejected).toEqual([]);
    expect(r.ignoredEvidence[0]!.why).toMatch(/bound to tree/);
  });
});
