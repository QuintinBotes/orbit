import type { CredentialStatus, ProviderCapabilities } from '../adapters/types.ts';
import { OrbitError, type OrbitErrorCode } from '../core/errors.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { allowMatch, tierOf } from '../routing/registry.ts';
import type { EligibilityAssessment, EligibilityRequirements, ModelEntry, Surface } from '../routing/types.ts';

/**
 * Reviewer selection (spec section 12). Applies review.independent_provider_required,
 * preferred_provider and fallback_same_provider_allowed, and answers with
 * either a reviewer or a BLOCK that says exactly why.
 *
 * "If another provider is mandatory and unavailable, block or report
 * incomplete verification; do not silently substitute an equivalent label."
 * So when the independent provider cannot be used, nothing stands in for it:
 * the answer is BLOCK carrying each provider's reason, and a same-provider
 * review happens only when policy allows it, at a different model tier than
 * the implementer's and at or above the quality floor (opus-class).
 */

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

/** The decisions-table shape for a selection. */
export function selectionDecisionRecord(sel: ReviewerSelection): { kind: string; summary: string; data: ReviewerSelection } {
  return {
    kind: 'review.select',
    summary: sel.decision === 'SELECT' ? `reviewer ${sel.provider}/${sel.model ?? 'default'} (${sel.independent ? 'independent' : 'same provider'})` : `review blocked: ${sel.reason}`.slice(0, 300),
    data: sel,
  };
}

export function selectReviewer(input: SelectReviewerInput): ReviewerSelection {
  const { config } = input.snapshot;
  const review = config.review;
  const impl = input.implementer.provider;
  const alternatives: RejectedReviewer[] = [];

  const ids = new Set<string>([...Object.keys(config.providers), ...Object.keys(input.capabilities), impl, review.preferred_provider]);
  // Preferred first, then the rest in a stable order.
  const order = [...ids].sort((a, b) => Number(b === review.preferred_provider) - Number(a === review.preferred_provider) || a.localeCompare(b));

  // Why a provider cannot review at all, independent of model choice.
  const providerProblem = (p: string): { reason: string; code: OrbitErrorCode } | null => {
    const cap = input.capabilities[p];
    if (!cap) return { reason: `no adapter capabilities were reported for "${p}"`, code: 'PROVIDER_UNAVAILABLE' };
    if (!cap.available) return { reason: `provider "${p}" is not available: ${cap.detail || 'adapter reported unavailable'}`, code: 'PROVIDER_UNAVAILABLE' };
    if (!cap.structuredOutput) return { reason: `provider "${p}" cannot return schema-constrained output, which review findings require`, code: 'PROVIDER_UNAVAILABLE' };
    const cred = input.credentials[p];
    if (!cred) return { reason: `credentials for "${p}" were not validated`, code: 'PROVIDER_UNAVAILABLE' };
    if (cred.state === 'expired') return { reason: `credentials for "${p}" are expired${cred.detail ? ` (${cred.detail})` : ''}`, code: 'AUTH_EXPIRED' };
    if (cred.state === 'invalid') return { reason: `credentials for "${p}" are invalid${cred.detail ? ` (${cred.detail})` : ''}`, code: 'AUTH_EXPIRED' };
    if (cred.state === 'missing') return { reason: `no credentials for "${p}"${cred.detail ? ` (${cred.detail})` : ''}`, code: 'AUTH_MISSING' };
    if (cred.state !== 'valid') return { reason: `credentials for "${p}" could not be validated (${cred.state})${cred.detail ? `: ${cred.detail}` : ''}`, code: 'PROVIDER_UNAVAILABLE' };
    // Sending the diff to a provider other than the implementer's needs the user's attestation.
    if (p !== impl && config.providers[p]?.data_policy_eligible !== true) {
      return { reason: `providers.${p}.data_policy_eligible is not true, so the review packet may not be sent to it`, code: 'POLICY_DENIED' };
    }
    return null;
  };

  const problems = new Map<string, { reason: string; code: OrbitErrorCode }>();
  const usableProviders: string[] = [];
  for (const p of order) {
    const prob = providerProblem(p);
    if (prob) {
      problems.set(p, prob);
      alternatives.push({ provider: p, model: null, reason: prob.reason });
    } else usableProviders.push(p);
  }

  // Independent candidates, preferred first.
  let substituted = false;
  for (const p of usableProviders.filter((x) => x !== impl)) {
    const m = qualifiedModel(p, input, alternatives);
    if (!m) continue;
    substituted = p !== review.preferred_provider;
    return finish(input, m, true, substituted, alternatives, substituted ? `preferred provider "${review.preferred_provider}" is unusable (${problems.get(review.preferred_provider)?.reason ?? 'not selected'}); "${p}" is an independent, qualified provider` : `independent reviewer "${p}" (implementer: "${impl}")`);
  }

  // No independent reviewer. Same-provider review only when policy allows it.
  const sameAllowed = !review.independent_provider_required || review.fallback_same_provider_allowed;
  if (!sameAllowed) {
    const independentIds = order.filter((p) => p !== impl);
    const detail = independentIds.length === 0
      ? `no provider other than "${impl}" is configured`
      : independentIds.map((p) => problems.get(p)?.reason ?? `"${p}" has no model qualified for review`).join('; ');
    const preferredProblem = problems.get(review.preferred_provider);
    const code: OrbitErrorCode = review.preferred_provider !== impl && preferredProblem ? preferredProblem.code : 'PROVIDER_UNAVAILABLE';
    return {
      decision: 'BLOCK',
      code,
      reason: `independent review is required (review.independent_provider_required=true, fallback_same_provider_allowed=false) and no independent reviewer is usable: ${detail}. Review is not being substituted by "${impl}" or any equivalent label; verification is incomplete until an independent provider is available.`,
      alternatives,
    };
  }

  if (problems.has(impl)) {
    return {
      decision: 'BLOCK',
      code: problems.get(impl)!.code,
      reason: `no independent reviewer is usable and same-provider review is allowed, but "${impl}" cannot review: ${problems.get(impl)!.reason}`,
      alternatives,
    };
  }
  const same = sameProviderModel(input, alternatives);
  if (!same.ok) {
    return { decision: 'BLOCK', code: 'PROVIDER_UNAVAILABLE', reason: `no independent reviewer is usable and same-provider review is allowed, but ${same.reason}`, alternatives };
  }
  return finish(
    input,
    same.usable,
    false,
    false,
    alternatives,
    `no independent reviewer is usable; policy allows same-provider review, so "${impl}" reviews with ${same.usable.model} (${same.usable.detail}) at a different tier than the implementer`,
  );
}

function finish(input: SelectReviewerInput, u: Usable, independent: boolean, substitutedForPreferred: boolean, alternatives: RejectedReviewer[], reason: string): ReviewerSelected {
  const cap = input.capabilities[u.provider];
  return {
    decision: 'SELECT',
    provider: u.provider,
    model: u.model,
    effort: input.snapshot.config.providers[u.provider]?.reasoning_effort ?? null,
    independent,
    basis: u.basis,
    substitutedForPreferred,
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
 * Same-provider review: a model at or above the quality floor whose tier
 * differs from the implementer's. If the implementer's tier cannot be
 * established the difference cannot be shown, so there is no selection.
 */
function sameProviderModel(input: SelectReviewerInput, alternatives: RejectedReviewer[]): { ok: true; usable: Usable } | { ok: false; reason: string } {
  const impl = input.implementer;
  const cfg = input.snapshot.config;
  const reg = input.registry;
  if (!reg) return { ok: false, reason: 'no model registry was supplied, so a different-tier reviewer model cannot be chosen' };
  const implEntry = impl.model ? reg.get(impl.model) : null;
  const implTier = implEntry ? tierOf(implEntry) : null;
  if (implTier === null) {
    return { ok: false, reason: `the implementer's model tier is unknown (${impl.model ?? 'provider default'}), so a different-tier reviewer cannot be shown to differ` };
  }
  const surface = PROVIDER_SURFACE[impl.provider];
  if (!surface) return { ok: false, reason: `"${impl.provider}" has no tiered models, so a different-tier same-provider review is not defined` };
  const cap = input.capabilities[impl.provider];
  const a = reg.assess({ surface, provider: impl.provider, allowedModels: cfg.routing.allowed_models, structuredOutput: true });
  for (const ex of a.excluded) if (ex.model.provider === impl.provider) alternatives.push({ provider: impl.provider, model: ex.model.modelId, reason: `ineligible: ${ex.reasons.join('; ')}` });
  const candidates = a.eligible.filter((e) => {
    const t = tierOf(e);
    if (t === null) return false;
    if (cap && cap.models.length > 0 && !cap.models.includes(e.modelId)) return false;
    if (t < REVIEW_QUALITY_FLOOR_TIER) {
      alternatives.push({ provider: impl.provider, model: e.modelId, reason: `${e.family} is below the review quality floor (opus-class)` });
      return false;
    }
    if (t === implTier) {
      alternatives.push({ provider: impl.provider, model: e.modelId, reason: `same tier (${e.family}) as the implementer's model` });
      return false;
    }
    return true;
  });
  const pick = candidates[0];
  if (!pick) return { ok: false, reason: `no allowed ${impl.provider} model is at or above the opus-class floor and in a different tier than the implementer's ${implEntry?.family ?? impl.model}` };
  return { ok: true, usable: { provider: impl.provider, model: pick.modelId, basis: 'tier', detail: `${pick.family} is at or above the opus-class floor and differs from the implementer's ${implEntry?.family}` } };
}

/** Throw the BLOCK as an OrbitError, for callers that propagate rather than record. */
export function assertReviewerSelected(sel: ReviewerSelection): ReviewerSelected {
  if (sel.decision === 'SELECT') return sel;
  throw new OrbitError(sel.code, sel.reason, { alternatives: sel.alternatives });
}
