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

// The lead's decision after three rounds of adversarial review: a note is structure (the finding's category), never the
// wording of its claim, and the contract draft removes no criterion. The docs said a note was recognised clause by clause
// and that the draft dropped a criterion with a `contract.criterion-dropped` decision.
describe('the docs on what makes a finding a note, and on criteria about fail-before', () => {
  it.each(['docs/configuration.md', 'docs/operations.md', 'docs/decisions/0014-fail-before.md'])('%s describes the structural rule, not the text rules', (p) => {
    const doc = read(p);
    expect(doc).toContain('`evidence-classification`');
    expect(doc).not.toMatch(/matches whole one of a few fixed statements/);
    expect(doc).not.toMatch(/contract\.criterion-dropped/);
    expect(doc).not.toMatch(/the contract draft drops/i);
  });

  it('the ADR addendum says why the text rules were dropped', () => {
    const adr = read('docs/decisions/0014-fail-before.md');
    expect(adr).toMatch(/three rounds of adversarial review/i);
    expect(adr).toMatch(/Orbit never removes a criterion/);
  });
});
