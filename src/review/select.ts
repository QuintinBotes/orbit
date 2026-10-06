import type { CredentialStatus, ProviderCapabilities } from '../adapters/types.ts';
import { OrbitError, type OrbitErrorCode } from '../core/errors.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { preferredReviewProvider, reviewFallback, reviewProviderOrder, type ReviewAvailabilitySettings } from '../policy/review.ts';
import { allowMatch, tierOf } from '../routing/registry.ts';
import type { EligibilityAssessment, EligibilityRequirements, ModelEntry, Surface } from '../routing/types.ts';

/**
 * Reviewer selection (spec section 12; docs/decisions/0007-reviewer-availability.md). The independent providers
 * of review.providers are tried in their order; the first that is installed, logged in, data-policy eligible and
 * has a qualified model reviews. When none is usable, review.when_unavailable decides:
 *
 * - `claude`: the implementer's provider reviews in a separate reviewer session at or above the quality floor
 *   (opus-class), never routed down, and the selection says it is not independent and why;
 * - `ask`: the same selection, marked as needing a person's yes before the review runs;
 * - `block`: BLOCK carrying each provider's reason.
 *
 * "If another provider is mandatory and unavailable, block or report incomplete verification; do not silently
 * substitute an equivalent label." A same-provider review is never presented as independent: `independent` is
 * false and `independentUnavailable` names why the independent reviewer could not be used.
 */

/** The decision a person's yes to a same-provider review becomes (review.when_unavailable: ask). */
export const SAME_PROVIDER_APPROVED_KIND = 'review.same-provider-approved';

/** Opus-class, matching routing's safety-review floor. */
export const REVIEW_QUALITY_FLOOR_TIER = 3;

const PROVIDER_SURFACE: Readonly<Record<string, Surface>> = { claude: 'claude-cli', codex: 'codex-cli' };

/** The slice of the model registry selection reads. ModelRegistry satisfies it. */
export interface ReviewerRegistry {
  assess(req: EligibilityRequirements): EligibilityAssessment;
  get(modelOrAlias: string): ModelEntry | null;
}

export interface SelectReviewerInput {
  snapshot: Pick<PolicySnapshot, 'config'>;
  /** What each provider's adapter reported from discoverCapabilities(), by provider id. */
  capabilities: Readonly<Record<string, ProviderCapabilities | undefined>>;
  /** What each adapter reported from validateCredentials(), by provider id. */
  credentials: Readonly<Record<string, CredentialStatus | undefined>>;
  /** Who produced the candidate. */
  implementer: { provider: string; model: string | null };
  /** Needed to qualify models and to pick a different tier; without it only a model named in providers.<id>.model can be chosen. */
  registry?: ReviewerRegistry;
}

export interface RejectedReviewer {
  provider: string;
  model: string | null;
  reason: string;
}

export type QualificationBasis = 'configured' | 'evaluation' | 'provider-default' | 'tier';

export interface ReviewerSelected {
  decision: 'SELECT';
  provider: string;
  /** null: the provider's own configured default (nothing resolvable to name). */
  model: string | null;
  effort: string | null;
  /** The reviewer is not the implementer's provider. */
  independent: boolean;
  /** For a same-provider review: why no independent reviewer could be used. Null for an independent review; absent in selections recorded before decision 0007. */
  independentUnavailable?: string | null;
  /** review.when_unavailable is ask: a person must say yes before this same-provider review runs. Absent (false) in older records. */
  needsApproval?: boolean;
  basis: QualificationBasis;
  /** True when preferred_provider could not be used and another independent provider was. Recorded, never hidden. */
  substitutedForPreferred: boolean;
  readOnlySandbox: boolean;
  reason: string;
  alternatives: RejectedReviewer[];
}

export interface ReviewerBlocked {
  decision: 'BLOCK';
  /** AUTH_EXPIRED and AUTH_MISSING for credential problems; PROVIDER_UNAVAILABLE otherwise. */
  code: OrbitErrorCode;
  /** Truthful and specific: which requirement, which provider, why. */
  reason: string;
  alternatives: RejectedReviewer[];
}

export type ReviewerSelection = ReviewerSelected | ReviewerBlocked;

interface Usable {
  provider: string;
  model: string | null;
  basis: QualificationBasis;
  detail: string;
}

/** The decisions-table shape for a selection. A same-provider review says it is not independent, and why. */
export function selectionDecisionRecord(sel: ReviewerSelection): { kind: string; summary: string; data: ReviewerSelection } {
  return {
    kind: 'review.select',
    summary: (sel.decision === 'SELECT' ? `reviewer ${reviewerLabel(sel)}` : `review blocked: ${sel.reason}`).slice(0, 300),
    data: sel,
  };
}

/** `codex/model (independent)`, or `claude/model (same provider, not independent: <why>)`. */
export function reviewerLabel(sel: Pick<ReviewerSelected, 'provider' | 'model' | 'independent' | 'independentUnavailable'>): string {
  const who = `${sel.provider}/${sel.model ?? 'default'}`;
  if (sel.independent) return `${who} (independent)`;
  return `${who} (same provider, not independent: ${sel.independentUnavailable ?? 'no independent reviewer was usable'})`;
}

export function selectReviewer(input: SelectReviewerInput): ReviewerSelection {
  const { config } = input.snapshot;
  const review = config.review;
  const impl = input.implementer.provider;
  const alternatives: RejectedReviewer[] = [];
  const fallback = reviewFallback(review);
  const order = reviewProviderOrder(review);
  const preferred = order[0] ?? null;

  // Why a provider cannot review at all, independent of model choice.
  // `unverifiedOk`: the implementer's own provider is judged as the environment gate judges the implementer, where a
  // credential that is present but unverified until a request succeeds is enough.
  const providerProblem = (p: string, unverifiedOk = false): { reason: string; code: OrbitErrorCode } | null => {
    const cap = input.capabilities[p];
    if (!cap) return { reason: `no adapter capabilities were reported for "${p}"`, code: 'PROVIDER_UNAVAILABLE' };
    if (!cap.available) return { reason: `provider "${p}" is not available: ${cap.detail || 'adapter reported unavailable'}`, code: 'PROVIDER_UNAVAILABLE' };
    if (!cap.structuredOutput) return { reason: `provider "${p}" cannot return schema-constrained output, which review findings require`, code: 'PROVIDER_UNAVAILABLE' };
    const cred = input.credentials[p];
    if (!cred) return { reason: `credentials for "${p}" were not validated`, code: 'PROVIDER_UNAVAILABLE' };
    if (cred.state === 'expired') return { reason: `credentials for "${p}" are expired${cred.detail ? ` (${cred.detail})` : ''}`, code: 'AUTH_EXPIRED' };
    if (cred.state === 'invalid') return { reason: `credentials for "${p}" are invalid${cred.detail ? ` (${cred.detail})` : ''}`, code: 'AUTH_EXPIRED' };
    if (cred.state === 'missing') return { reason: `no credentials for "${p}"${cred.detail ? ` (${cred.detail})` : ''}`, code: 'AUTH_MISSING' };
    if (cred.state !== 'valid' && !(unverifiedOk && cred.state === 'unknown')) return { reason: `credentials for "${p}" could not be validated (${cred.state})${cred.detail ? `: ${cred.detail}` : ''}`, code: 'PROVIDER_UNAVAILABLE' };
    // Sending the diff to a provider other than the implementer's needs the user's attestation.
    if (p !== impl && config.providers[p]?.data_policy_eligible !== true) {
      return { reason: `providers.${p}.data_policy_eligible is not true, so the review packet may not be sent to it`, code: 'POLICY_DENIED' };
    }
    return null;
  };

  // The listed independent providers that are configured, in their order. Only listed providers are asked.
  const independentIds = order.filter((p) => p !== impl && (Object.hasOwn(config.providers, p) || input.capabilities[p] !== undefined));
  const problems = new Map<string, { reason: string; code: OrbitErrorCode }>();
  const unusable = new Map<string, string>();
  for (const p of independentIds) {
    const prob = providerProblem(p);
    if (prob) {
      problems.set(p, prob);
      unusable.set(p, prob.reason);
      alternatives.push({ provider: p, model: null, reason: prob.reason });
      continue;
    }
    const m = qualifiedModel(p, input, alternatives);
    if (!m) {
      unusable.set(p, `"${p}" has no model qualified for review`);
      continue;
    }
    const substituted = p !== preferred;
    return finish(
      input,
      m,
      { independent: true, substitutedForPreferred: substituted, independentUnavailable: null, needsApproval: false },
      alternatives,
      substituted ? `preferred provider "${preferred}" is unusable (${problems.get(preferred ?? '')?.reason ?? 'not selected'}); "${p}" is an independent, qualified provider` : `independent reviewer "${p}" (implementer: "${impl}")`,
    );
  }

  // No independent reviewer is usable: why, in one line, for every report that follows.
  const detail =
    independentIds.length === 0
      ? order.length === 0
        ? 'no independent review provider is listed in review.providers'
        : `no provider other than "${impl}" is configured`
      : independentIds.map((p) => unusable.get(p) ?? `"${p}" has no model qualified for review`).join('; ');

  if (fallback === 'block') {
    const preferredProblem = preferred !== null ? problems.get(preferred) : undefined;
    const code: OrbitErrorCode = preferred !== impl && preferredProblem ? preferredProblem.code : 'PROVIDER_UNAVAILABLE';
    return {
      decision: 'BLOCK',
      code,
      reason: `independent review is required (review.when_unavailable: block) and no independent reviewer is usable: ${detail}. Review is not being substituted by "${impl}" or any equivalent label; verification is incomplete until an independent provider is available.`,
      alternatives,
    };
  }

  const implProblem = providerProblem(impl, true);
  if (implProblem) {
    alternatives.push({ provider: impl, model: null, reason: implProblem.reason });
    return {
      decision: 'BLOCK',
      code: implProblem.code,
      reason: `no independent reviewer is usable (${detail}) and review.when_unavailable is ${fallback}, but "${impl}" cannot review: ${implProblem.reason}`,
      alternatives,
    };
  }
  const same = sameProviderModel(input, alternatives);
  if (!same.ok) {
    return { decision: 'BLOCK', code: 'PROVIDER_UNAVAILABLE', reason: `no independent reviewer is usable (${detail}) and review.when_unavailable is ${fallback}, but ${same.reason}`, alternatives };
  }
  const why = `no independent reviewer was usable: ${detail}`;
  return finish(
    input,
    same.usable,
    { independent: false, substitutedForPreferred: false, independentUnavailable: why, needsApproval: fallback === 'ask' },
    alternatives,
    `${why}; review.when_unavailable is ${fallback}, so "${impl}" reviews with ${same.usable.model} in a separate reviewer session (${same.usable.detail})${fallback === 'ask' ? ' once a person says yes' : ''}. This review is not independent.`,
  );
}

interface Independence {
  independent: boolean;
  substitutedForPreferred: boolean;
  independentUnavailable: string | null;
  needsApproval: boolean;
}

function finish(input: SelectReviewerInput, u: Usable, how: Independence, alternatives: RejectedReviewer[], reason: string): ReviewerSelected {
  const cap = input.capabilities[u.provider];
  return {
    decision: 'SELECT',
    provider: u.provider,
    model: u.model,
    effort: input.snapshot.config.providers[u.provider]?.reasoning_effort ?? null,
    independent: how.independent,
    independentUnavailable: how.independentUnavailable,
    needsApproval: how.needsApproval,
    basis: u.basis,
    substitutedForPreferred: how.substitutedForPreferred,
    readOnlySandbox: cap?.readOnlySandbox === true,
    reason,
    alternatives,
  };
}

/**
 * A model of a provider other than the implementer's. Claude models qualify by
 * tier (opus-class and up); other providers by an explicit providers.<id>.model,
 * a recorded safety-review evaluation, or being the provider's recommended
 * model, the same bases routing uses.
 */
function qualifiedModel(provider: string, input: SelectReviewerInput, alternatives: RejectedReviewer[]): Usable | null {
  const cfg = input.snapshot.config;
  const cap = input.capabilities[provider];
  const configured = cfg.providers[provider]?.model ?? null;
  const offered = (m: string): boolean => !cap || cap.models.length === 0 || cap.models.includes(m);

  if (configured !== null) {
    if (!offered(configured)) {
      alternatives.push({ provider, model: configured, reason: `providers.${provider}.model "${configured}" is not offered by the adapter` });
      return null;
    }
    return { provider, model: configured, basis: 'configured', detail: `providers.${provider}.model names it` };
  }
  const reg = input.registry;
  const surface = PROVIDER_SURFACE[provider];
  if (reg && surface) {
    const a = reg.assess({ surface, provider, allowedModels: [...cfg.routing.allowed_models, `${provider}:*`], structuredOutput: true });
    const ranked = a.eligible.filter((e) => offered(e.modelId));
    if (provider === 'claude') {
      const tiered = ranked.filter((e) => (tierOf(e) ?? 0) >= REVIEW_QUALITY_FLOOR_TIER && allowMatch(e, cfg.routing.allowed_models) !== null);
      const pick = tiered[0];
      if (pick) return { provider, model: pick.modelId, basis: 'tier', detail: `${pick.family} meets the opus-class floor` };
    } else {
      const evaluated = ranked.find((e) => e.evaluation.qualifiedFor.includes('safety-review'));
      if (evaluated) return { provider, model: evaluated.modelId, basis: 'evaluation', detail: 'a recorded safety-review evaluation' };
      const recommended = ranked.find((e) => e.eligibility.providerDefault);
      if (recommended) return { provider, model: recommended.modelId, basis: 'provider-default', detail: `it is ${provider}'s recommended model` };
    }
  }
  alternatives.push({ provider, model: null, reason: `no model of "${provider}" is qualified for review: none is named in providers.${provider}.model, evaluated for safety review, or recommended by the provider${provider === 'claude' ? ', and none is opus-class or above' : ''}` });
  return null;
}

/**
 * Same-provider review: a model at or above the quality floor (opus-class), never below it. A tier different
 * from the implementer's is preferred, since it is a different model; when none is allowed the same tier reviews,
 * in its own session. Before the implementer's model is known (preflight) the best model at the floor is named.
 */
function sameProviderModel(input: SelectReviewerInput, alternatives: RejectedReviewer[]): { ok: true; usable: Usable } | { ok: false; reason: string } {
  const impl = input.implementer;
  const cfg = input.snapshot.config;
  const reg = input.registry;
  if (!reg) return { ok: false, reason: 'no model registry was supplied, so a reviewer model at the quality floor cannot be chosen' };
  const implEntry = impl.model ? reg.get(impl.model) : null;
  const implTier = implEntry ? tierOf(implEntry) : null;
  const surface = PROVIDER_SURFACE[impl.provider];
  if (!surface) return { ok: false, reason: `"${impl.provider}" has no tiered models, so a same-provider review at the quality floor is not defined` };
  const cap = input.capabilities[impl.provider];
  const a = reg.assess({ surface, provider: impl.provider, allowedModels: cfg.routing.allowed_models, structuredOutput: true });
  // A model is validated on its first use (as routing does for the implementer), so one whose only gap is that no
  // run has used it yet still qualifies; a model known to be unavailable, or outside the policy, does not.
  const unvalidated = (ex: { reasons: string[] }): boolean => ex.reasons.length > 0 && ex.reasons.every((r) => /not yet validated/.test(r));
  const pending: ModelEntry[] = [];
  for (const ex of a.excluded) {
    if (ex.model.provider !== impl.provider) continue;
    if (unvalidated(ex)) pending.push(ex.model);
    else alternatives.push({ provider: impl.provider, model: ex.model.modelId, reason: `ineligible: ${ex.reasons.join('; ')}` });
  }
  const atFloor = [...a.eligible, ...pending].filter((e) => {
    const t = tierOf(e);
    if (t === null) return false;
    if (cap && cap.models.length > 0 && !cap.models.includes(e.modelId)) return false;
    if (t < REVIEW_QUALITY_FLOOR_TIER) {
      alternatives.push({ provider: impl.provider, model: e.modelId, reason: `${e.family} is below the review quality floor (opus-class)` });
      return false;
    }
    return true;
  });
  const otherTier = implTier === null ? undefined : atFloor.find((e) => tierOf(e) !== implTier);
  if (otherTier) {
    for (const e of atFloor) if (tierOf(e) === implTier) alternatives.push({ provider: impl.provider, model: e.modelId, reason: `same tier (${e.family}) as the implementer's model; a different tier is preferred` });
    return { ok: true, usable: { provider: impl.provider, model: otherTier.modelId, basis: 'tier', detail: `${otherTier.family} is at or above the opus-class floor and a different tier than the implementer's ${implEntry?.family}` } };
  }
  const pick = atFloor[0];
  if (!pick) return { ok: false, reason: `no allowed ${impl.provider} model is at or above the opus-class floor` };
  const detail =
    implTier === null
      ? `${pick.family} meets the opus-class floor; the implementer's model is not known yet`
      : `${pick.family} is at the opus-class floor, the same tier as the implementer's model; it reviews in a separate session`;
  return { ok: true, usable: { provider: impl.provider, model: pick.modelId, basis: 'tier', detail } };
}

/**
 * The review provider a run cannot do without: the first listed independent provider when review.when_unavailable
 * is block (its credentials are then judged by the environment gate), otherwise none, since a same-provider review
 * can stand in for it.
 */
export function mandatoryReviewProvider(review: ReviewAvailabilitySettings, implementer: string): string | null {
  if (reviewFallback(review) !== 'block') return null;
  const first = preferredReviewProvider(review);
  return first !== null && first !== implementer ? first : null;
}

/** Throw the BLOCK as an OrbitError, for callers that propagate rather than record. */
export function assertReviewerSelected(sel: ReviewerSelection): ReviewerSelected {
  if (sel.decision === 'SELECT') return sel;
  throw new OrbitError(sel.code, sel.reason, { alternatives: sel.alternatives });
}
