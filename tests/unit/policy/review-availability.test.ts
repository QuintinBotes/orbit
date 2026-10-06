// Reviewer availability (issues #6 and #8, docs/decisions/0007-reviewer-availability.md): review.providers lists
// the independent providers in preference order, review.when_unavailable says what happens when none is usable,
// and the two legacy keys keep working by mapping onto it.
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig } from '../../../src/policy/config.ts';
import { describeReviewPolicy, isSupportedReviewProvider, legacyReviewFallback, preferredReviewProvider, reviewFallback, reviewProviderOrder } from '../../../src/policy/review.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';

function problems(yaml: string): string[] {
  try {
    parseConfig(`version: 1\n${yaml}`);
  } catch (err) {
    expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONFIG_INVALID');
}

const review = (yaml: string) => parseConfig(`version: 1\n${yaml}`).review;

describe('review.providers and review.when_unavailable', () => {
  it('default to Codex as the independent reviewer and a disclosed Claude review when it is unusable', () => {
    const r = review('');
    expect(r.providers).toEqual(['codex']);
    expect(r.when_unavailable).toBe('claude');
    expect(reviewFallback(r)).toBe('claude');
    expect(reviewProviderOrder(r)).toEqual(['codex']);
    expect(defaultConfig().review).toMatchObject({ providers: ['codex'], when_unavailable: 'claude' });
  });

  it.each(['claude', 'ask', 'block'] as const)('accepts when_unavailable: %s', (mode) => {
    expect(reviewFallback(review(`review: {when_unavailable: ${mode}}\n`))).toBe(mode);
  });

  it('refuses any other when_unavailable value, naming the allowed ones', () => {
    expect(problems('review: {when_unavailable: skip}\n').join('\n')).toMatch(/review\.when_unavailable: must be one of "claude", "ask", "block", got "skip"/);
  });

  it('keeps the preference order as written', () => {
    const r = review('providers:\n  codex: {data_policy_eligible: true}\n  codex-review: {command: codex, data_policy_eligible: true}\nreview: {providers: [codex-review, codex]}\n');
    expect(reviewProviderOrder(r)).toEqual(['codex-review', 'codex']);
    expect(preferredReviewProvider(r)).toBe('codex-review');
  });

  it('allows an empty list (no independent provider) with a fallback, and refuses it with block', () => {
    expect(review('review: {providers: []}\n').providers).toEqual([]);
    expect(problems('review: {providers: [], when_unavailable: block}\n').join('\n')).toMatch(/review\.providers: is empty and review\.when_unavailable is block, so every run would block/);
  });

  it('refuses an unsupported provider such as gemini, naming the supported ones', () => {
    const p = problems('providers:\n  gemini: {command: gemini, data_policy_eligible: true}\nreview: {providers: [gemini]}\n');
    expect(p.join('\n')).toMatch(/review\.providers\[0\]: "gemini" is not a supported independent review provider; supported: codex/);
  });

  it('refuses the implementer provider as an independent reviewer', () => {
    expect(problems('review: {providers: [claude]}\n').join('\n')).toMatch(/review\.providers\[0\]: "claude" is not a supported independent review provider; supported: codex/);
  });

  it('refuses a supported provider id that is not defined under providers', () => {
    expect(problems('review: {providers: [codex-two]}\n').join('\n')).toMatch(/review\.providers\[0\]: "codex-two" is not defined under providers/);
  });

  it('refuses a provider listed twice', () => {
    expect(problems('review: {providers: [codex, codex]}\n').join('\n')).toMatch(/review\.providers/);
  });
});

describe('the legacy keys map onto when_unavailable', () => {
  it('independent_provider_required: true without the fallback is block', () => {
    expect(reviewFallback(review('review: {independent_provider_required: true}\n'))).toBe('block');
    expect(reviewFallback(review('review: {independent_provider_required: true, fallback_same_provider_allowed: false}\n'))).toBe('block');
    expect(review('review: {independent_provider_required: true}\n').when_unavailable).toBe('block');
  });

  it('any other combination allows the disclosed Claude review', () => {
    expect(reviewFallback(review('review: {independent_provider_required: false}\n'))).toBe('claude');
    expect(reviewFallback(review('review: {independent_provider_required: false, fallback_same_provider_allowed: true}\n'))).toBe('claude');
    expect(reviewFallback(review('review: {fallback_same_provider_allowed: true}\n'))).toBe('claude');
  });

  it('a legacy key that agrees with when_unavailable is accepted', () => {
    expect(reviewFallback(review('review: {independent_provider_required: true, when_unavailable: block}\n'))).toBe('block');
    expect(reviewFallback(review('review: {independent_provider_required: false, when_unavailable: claude}\n'))).toBe('claude');
  });

  it('a legacy key that contradicts when_unavailable is a configuration error', () => {
    const p = problems('review: {independent_provider_required: true, when_unavailable: claude}\n');
    expect(p.join('\n')).toMatch(/review\.when_unavailable: "claude" contradicts the legacy setting independent_provider_required: true, which means "block"; remove the legacy keys/);
    expect(problems('review: {fallback_same_provider_allowed: true, when_unavailable: block}\n').join('\n')).toMatch(/review\.when_unavailable: "block" contradicts the legacy setting/);
    expect(problems('review: {independent_provider_required: false, when_unavailable: ask}\n').join('\n')).toMatch(/review\.when_unavailable: "ask" contradicts/);
  });

  it('the legacy pair that contradicts itself is still refused', () => {
    expect(problems('review: {independent_provider_required: true, fallback_same_provider_allowed: true}\n').join('\n')).toMatch(/review: independent_provider_required and fallback_same_provider_allowed contradict each other/);
  });

  it('a legacy preferred_provider becomes the preference list', () => {
    const r = review('providers:\n  codex-review: {command: codex, data_policy_eligible: true}\nreview: {preferred_provider: codex-review}\n');
    expect(r.providers).toEqual(['codex-review']);
    expect(reviewProviderOrder(r)).toEqual(['codex-review']);
  });

  it('a legacy preferred_provider that disagrees with the list is a configuration error', () => {
    expect(problems('review: {providers: [codex], preferred_provider: claude}\n').join('\n')).toMatch(/review\.preferred_provider: "claude" contradicts review\.providers/);
  });

  it('a frozen snapshot written before the new keys reads through the helpers', () => {
    const old = { independent_provider_required: true, preferred_provider: 'codex', fallback_same_provider_allowed: false };
    expect(reviewFallback(old)).toBe('block');
    expect(reviewProviderOrder(old)).toEqual(['codex']);
    expect(reviewFallback({ independent_provider_required: false, preferred_provider: 'codex', fallback_same_provider_allowed: false })).toBe('claude');
    expect(legacyReviewFallback({})).toBeNull();
    // The pair that contradicts itself is refused on load; in memory it reads as the old code read it.
    expect(legacyReviewFallback({ independent_provider_required: true, fallback_same_provider_allowed: true })).toBe('claude');
  });
});

describe('helpers', () => {
  it('knows which ids are supported independent reviewers', () => {
    expect(isSupportedReviewProvider('codex')).toBe(true);
    expect(isSupportedReviewProvider('codex-review')).toBe(true);
    expect(isSupportedReviewProvider('codex_ci')).toBe(true);
    expect(isSupportedReviewProvider('gemini')).toBe(false);
    expect(isSupportedReviewProvider('claude')).toBe(false);
    expect(isSupportedReviewProvider('codexy')).toBe(false);
  });

  it('describes each mode in one line', () => {
    expect(describeReviewPolicy({ providers: ['codex'], when_unavailable: 'claude' })).toMatch(/independent reviewers codex .*review\.when_unavailable: claude.*Claude reviews in a separate session.*not independent/);
    expect(describeReviewPolicy({ providers: ['codex'], when_unavailable: 'ask' })).toMatch(/asks a person/);
    expect(describeReviewPolicy({ providers: [], when_unavailable: 'block' })).toMatch(/independent reviewers none .*the run blocks/);
  });
});
