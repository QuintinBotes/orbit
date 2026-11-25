/** Issue #235: a partner's instruction-file edit is cleared only by an independent review, whatever review.when_unavailable says. */
import { describe, expect, it } from 'vitest';
import { selectReviewer } from '../../../src/review/select.ts';
import { SONNET, setup } from '../routing/fixtures.ts';
import { cap, cred, snapshotOf } from './fixtures.ts';

function input(when: 'claude' | 'ask', independentUsable: boolean) {
  const { registry } = setup();
  return {
    snapshot: snapshotOf((c) => void (c.review.when_unavailable = when)),
    capabilities: independentUsable ? { claude: cap('claude'), codex: cap('codex') } : { claude: cap('claude') },
    credentials: independentUsable ? { claude: cred('valid'), codex: cred('valid') } : { claude: cred('valid') },
    implementer: { provider: 'claude', model: SONNET },
    implementers: ['claude'],
    registry,
  };
}

describe('selectReviewer requireIndependent (#235)', () => {
  for (const when of ['claude', 'ask'] as const) {
    it(`blocks when no independent reviewer is usable (review.when_unavailable: ${when})`, () => {
      expect(selectReviewer({ ...input(when, false), requireIndependent: true })).toMatchObject({ decision: 'BLOCK', reason: expect.stringMatching(/independent review is required/) });
    });

    it(`control: without the requirement the policy's own fallback stands (${when})`, () => {
      expect(selectReviewer(input(when, false))).toMatchObject({ decision: 'SELECT', independent: false });
    });
  }

  it('control: with an independent reviewer usable, the requirement changes nothing', () => {
    expect(selectReviewer({ ...input('claude', true), requireIndependent: true })).toMatchObject({ decision: 'SELECT', provider: 'codex', independent: true });
  });
});
