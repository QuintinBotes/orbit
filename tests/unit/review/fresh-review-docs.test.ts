// The user docs on a review that asked for repair only through notes (ADR 0014, 0.3.1 addendum, item 3). They said such
// a review stops the run BLOCKED, while the run first gets one fresh review of the tree, charged to review_rounds, whose
// APPROVE lets it go on. The plugin's copies are the build's (npm run check:dist compares them).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (p: string): string => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');

describe('the docs on a review that asked for repair only through notes', () => {
  it.each(['docs/configuration.md', 'docs/operations.md'])('%s describes the one fresh review before the run ends BLOCKED', (p) => {
    const doc = read(p);
    expect(doc).not.toMatch(/only through such notes approves nothing, so the run stops `BLOCKED`/);
    expect(doc).not.toMatch(/only through such notes, the run ends `BLOCKED` naming them/);
    expect(doc).toMatch(/one fresh review/);
    expect(doc).toContain('`review.fresh`');
    expect(doc).toMatch(/charged to `review_rounds`/);
    expect(doc).toMatch(/`APPROVE` lets the run go on/);
    expect(doc).toMatch(/at the `review_rounds` cap, the run ends `BLOCKED` naming the findings/);
  });
});
