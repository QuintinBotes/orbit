/**
 * Reviewer availability (docs/decisions/0007-reviewer-availability.md).
 *
 * `review.providers` lists the independent providers Orbit may ask to review, in preference order, and
 * `review.when_unavailable` says what happens when none of them is usable at run time:
 *
 * - `claude` (the default): the implementer's provider reviews in a separate reviewer session at the safety-review
 *   quality floor, and every report says the review was not independent and why;
 * - `ask`: a person is asked first, and the same-provider review runs only on their yes;
 * - `block`: the run blocks.
 *
 * The two keys this replaced, `independent_provider_required` and `fallback_same_provider_allowed`, stay valid and
 * map onto `when_unavailable`. Frozen snapshots written before the new keys existed carry only the old ones (and
 * `preferred_provider`), so every reader goes through these helpers rather than reading the keys directly.
 */

export type ReviewFallback = 'claude' | 'ask' | 'block';

export const REVIEW_FALLBACKS: readonly ReviewFallback[] = Object.freeze(['claude', 'ask', 'block']);

export const DEFAULT_REVIEW_FALLBACK: ReviewFallback = 'claude';

/** Provider families Orbit has an independent review adapter for. A provider such as Gemini needs an adapter first. */
export const SUPPORTED_REVIEW_PROVIDERS: readonly string[] = Object.freeze(['codex']);

/** The review settings these helpers read; OrbitConfig['review'], RoutingPolicy['review'] and older snapshots all satisfy it. */
export interface ReviewAvailabilitySettings {
  providers?: readonly string[];
  when_unavailable?: ReviewFallback;
  preferred_provider?: string;
  independent_provider_required?: boolean;
  fallback_same_provider_allowed?: boolean;
}

/**
 * A provider id Orbit can use as an independent reviewer: a supported family (`codex`), or an id naming one
 * (`codex-review`, `codex_ci`), which is how a second Codex configuration is defined under `providers`.
 */
export function isSupportedReviewProvider(id: string): boolean {
  return SUPPORTED_REVIEW_PROVIDERS.some((family) => id === family || id.startsWith(`${family}-`) || id.startsWith(`${family}_`));
}

/**
 * What the legacy pair means: `independent_provider_required: true` without the fallback is `block`; any other
 * combination allowed a same-provider review, which is `claude`. Null when neither key is set. The pair that
 * contradicts itself (required and allowed to fall back at once) is refused when a config is loaded; it reads as
 * the old code read it, a same-provider review allowed.
 */
export function legacyReviewFallback(review: Pick<ReviewAvailabilitySettings, 'independent_provider_required' | 'fallback_same_provider_allowed'>): ReviewFallback | null {
  const required = review.independent_provider_required;
  const fallback = review.fallback_same_provider_allowed;
  if (required === undefined && fallback === undefined) return null;
  return required === true && fallback !== true ? 'block' : 'claude';
}

/**
 * What happens when no independent reviewer is usable. A loaded config never has a legacy key that disagrees with
 * when_unavailable (that is a configuration error), so the order only matters for a config built in memory, where
 * a legacy key that was set explicitly says more than a when_unavailable that came from the defaults.
 */
export function reviewFallback(review: ReviewAvailabilitySettings): ReviewFallback {
  return legacyReviewFallback(review) ?? review.when_unavailable ?? DEFAULT_REVIEW_FALLBACK;
}

/**
 * The independent providers, in preference order. A legacy `preferred_provider` goes first, as it did before the
 * list existed; a snapshot without the list has only that one.
 */
export function reviewProviderOrder(review: ReviewAvailabilitySettings): string[] {
  const list = [...(review.providers ?? [])];
  const preferred = review.preferred_provider;
  if (preferred === undefined) return list;
  return [preferred, ...list.filter((p) => p !== preferred)];
}

/** The first independent provider, the one a run needs when review.when_unavailable is block; null when none is listed. */
export function preferredReviewProvider(review: ReviewAvailabilitySettings): string | null {
  return reviewProviderOrder(review)[0] ?? null;
}

/** One line for `orbit policy show`, `orbit doctor` and the init output. */
export function describeReviewPolicy(review: ReviewAvailabilitySettings): string {
  const order = reviewProviderOrder(review);
  const providers = order.length > 0 ? order.join(', ') : 'none';
  const fallback = reviewFallback(review);
  const then =
    fallback === 'claude'
      ? 'Claude reviews in a separate session at the safety-review quality floor and the report says the review was not independent'
      : fallback === 'ask'
        ? 'the run asks a person before a same-provider review'
        : 'the run blocks';
  return `independent reviewers ${providers} (in preference order); when none is usable (review.when_unavailable: ${fallback}), ${then}`;
}
