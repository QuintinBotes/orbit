import { OrbitError } from '../core/errors.ts';
import type { DifficultyClass } from '../scheduling/types.ts';
import { FAMILY_TIER, tierOf } from './registry.ts';
import { roundUsd } from './pricing.ts';
import {
  WORK_KINDS,
  type CostBasis,
  type CostBreakdown,
  type EligibilityAssessment,
  type EligibilityRequirements,
  type ModelEntry,
  type ModelPricing,
  type RouteAlternative,
  type RouteDecision,
  type RouteJustification,
  type RouteRef,
  type RouteSignals,
  type RouteStat,
  type RoutingPolicy,
  type Surface,
  type WorkKind,
} from './types.ts';

/**
 * Model routing (spec section 8). The starting tier comes from the spec
 * table; a route moves up only on observed difficulty (repeated equivalent
 * failures with references to their failure records, a strong attempt that
 * failed with recorded evidence, measured outcomes) or on the task properties
 * the table's escalation column names (coupling, ambiguity, security-sensitive
 * interpretation, visual complexity), never on what a worker says about
 * itself. A predicted difficulty class raises effort, not the tier. A route
 * moves back down for routine follow-up once the hard diagnosis is solved, and
 * safety review never drops below its quality floor.
 *
 * Expected cost per verified task = execution + likely repairs + verification
 * + review + coordination. Measured route outcomes are used when present;
 * otherwise the priors below apply, and every decision says which basis it
 * used. The priors are planning assumptions, not calibrated probabilities.
 *
 * route() is pure: it reads the registry and the outcomes it is given and
 * returns a JSON-ready decision for the controller to record.
 */

export interface RegistryView {
  assess(req: EligibilityRequirements): EligibilityAssessment;
  get(modelOrAlias: string): ModelEntry | null;
}

export interface RouteRequest {
  workKind: WorkKind;
  signals: RouteSignals;
  registry: RegistryView;
  policy: RoutingPolicy;
  outcomes?: readonly RouteStat[];
}

const TIER_NAME: Readonly<Record<number, string>> = { 1: 'haiku', 2: 'sonnet', 3: 'opus', 4: 'fable' };
const FABLE_TIER = 4;
const SAFETY_FLOOR_TIER = 3;

const PROVIDER_SURFACE: Readonly<Record<string, Surface>> = { claude: 'claude-cli', codex: 'codex-cli' };

const EFFORT_ORDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** `max` is left to explicit configuration: it buys little on routine work and can run very long. */
const EFFORT_CEILING = 'xhigh';

type Output = 'candidate' | 'diagnosis' | 'interpretation' | 'review';

interface WorkProfile {
  startTier: number;
  baseEffort: string;
  output: Output;
  /** Rough token profile of one attempt, used only to price a route before outcomes are measured. */
  tokens: { input: number; output: number; cacheReadShare: number; cacheWriteShare: number };
  vision?: boolean;
  /** Follow-up work of this kind may route back down after a solved diagnosis. */
  routine: boolean;
}

/** Spec section 8 starting tiers. Curation (the learning layer's curator) is bounded summarization, so it starts like extraction. */
const PROFILES: Readonly<Record<WorkKind, WorkProfile>> = {
  extraction: { startTier: 1, baseEffort: 'low', output: 'interpretation', tokens: { input: 20_000, output: 2_000, cacheReadShare: 0, cacheWriteShare: 0 }, routine: true },
  'log-classification': { startTier: 1, baseEffort: 'low', output: 'interpretation', tokens: { input: 15_000, output: 1_000, cacheReadShare: 0, cacheWriteShare: 0 }, routine: true },
  'routine-code': { startTier: 2, baseEffort: 'medium', output: 'candidate', tokens: { input: 400_000, output: 20_000, cacheReadShare: 0.8, cacheWriteShare: 0.1 }, routine: true },
  'focused-tests': { startTier: 2, baseEffort: 'medium', output: 'candidate', tokens: { input: 300_000, output: 15_000, cacheReadShare: 0.8, cacheWriteShare: 0.1 }, routine: true },
  architecture: { startTier: 3, baseEffort: 'high', output: 'diagnosis', tokens: { input: 250_000, output: 30_000, cacheReadShare: 0.6, cacheWriteShare: 0.15 }, routine: false },
  'complex-diagnosis': { startTier: 3, baseEffort: 'high', output: 'diagnosis', tokens: { input: 500_000, output: 30_000, cacheReadShare: 0.8, cacheWriteShare: 0.1 }, routine: false },
  'long-horizon': { startTier: 4, baseEffort: 'high', output: 'candidate', tokens: { input: 1_500_000, output: 80_000, cacheReadShare: 0.85, cacheWriteShare: 0.08 }, routine: false },
  screenshot: { startTier: 1, baseEffort: 'medium', output: 'interpretation', tokens: { input: 10_000, output: 1_000, cacheReadShare: 0, cacheWriteShare: 0 }, vision: true, routine: true },
  'safety-review': { startTier: SAFETY_FLOOR_TIER, baseEffort: 'high', output: 'review', tokens: { input: 150_000, output: 10_000, cacheReadShare: 0.5, cacheWriteShare: 0.2 }, routine: false },
  curation: { startTier: 1, baseEffort: 'low', output: 'interpretation', tokens: { input: 20_000, output: 3_000, cacheReadShare: 0, cacheWriteShare: 0 }, routine: true },
};

/**
 * Prior probability that one attempt is verified, by tier and difficulty
 * class. Planning assumptions only; measured outcomes replace them.
 */
const PRIOR_SUCCESS: Readonly<Record<number, Record<DifficultyClass, number>>> = {
  1: { simple: 0.8, medium: 0.55, complex: 0.3 },
  2: { simple: 0.9, medium: 0.75, complex: 0.5 },
  3: { simple: 0.93, medium: 0.85, complex: 0.7 },
  4: { simple: 0.94, medium: 0.88, complex: 0.78 },
};
/** Prior that a qualified reviewer returns a valid review in one pass. */
const PRIOR_REVIEW_SUCCESS = 0.9;
/** Pseudo-count weight of the prior when blending with measured outcomes. */
const PRIOR_WEIGHT = 4;
/** Outcomes needed before a route counts as measured and may override the table. */
export const MIN_MEASURED_SAMPLES = 5;
/** A measured alternative must be this much cheaper per verified task to displace the table's choice. */
const CALIBRATION_MARGIN = 0.1;
/** Screenshot routes escalate when measured accuracy falls below this. */
const ACCURACY_FLOOR = 0.7;
const MIN_SUCCESS = 0.05;
/** A repair attempt is narrower than the first attempt. */
const REPAIR_COST_FRACTION = 0.6;
/** One verifier pass: about 40k prompt and 4k output tokens at Sonnet-class list pricing. */
const VERIFICATION_USD_PER_ATTEMPT = 0.12;
/** One independent review round: about 150k prompt (half cached) and 10k output tokens at Sonnet-class list pricing. */
const REVIEW_USD_PER_TASK = 0.3;
/** A compact handoff packet the next model reads uncached when the route changes model. */
const HANDOFF_TOKENS = 20_000;

interface RouteCost {
  total: number | null;
  breakdown: CostBreakdown | null;
  basis: CostBasis;
  success: number;
}

interface Ctx {
  workKind: WorkKind;
  profile: WorkProfile;
  signals: RouteSignals;
  policy: RoutingPolicy;
  registry: RegistryView;
  outcomes: readonly RouteStat[];
  threshold: number;
  evidence: string[];
  ignored: string[];
  previous: ModelEntry | null;
  previousTier: number | null;
}

/** Properties of the task rather than failures observed during it. */
const STATIC_SIGNALS: ReadonlySet<string> = new Set(['coupled-change', 'ambiguity', 'security-sensitive-interpretation', 'visual-complexity']);

interface Trigger {
  signal: string;
  detail: string;
  evidence: string[];
}

export function route(req: RouteRequest): RouteDecision {
  if (!(WORK_KINDS as readonly string[]).includes(req.workKind)) throw new OrbitError('SCHEMA_INVALID', `unknown work kind ${String(req.workKind)}`);
  const s = req.signals;
  if (!['simple', 'medium', 'complex'].includes(s.difficulty)) throw new OrbitError('SCHEMA_INVALID', `unknown difficulty ${String(s.difficulty)}`);
  if (!Number.isInteger(s.attempt) || s.attempt < 1) throw new OrbitError('SCHEMA_INVALID', 'attempt must be a positive integer');
  if (!Number.isFinite(s.repeatedFingerprints) || s.repeatedFingerprints < 0) throw new OrbitError('SCHEMA_INVALID', 'repeatedFingerprints must be a non-negative number');

  const previous = s.previousRoute ? req.registry.get(s.previousRoute.model) : null;
  const ctx: Ctx = {
    workKind: req.workKind,
    profile: PROFILES[req.workKind],
    signals: s,
    policy: req.policy,
    registry: req.registry,
    outcomes: req.outcomes ?? [],
    threshold: Math.max(1, req.policy.scheduler?.repeated_failure_threshold ?? 2),
    evidence: uniq([...(s.evidence ?? []), ...(s.previousRoute?.evidence ?? [])]),
    ignored: workerClaimNotes(s),
    previous,
    previousTier: previous && previous.provider === 'claude' ? tierOf(previous) : null,
  };
  return req.workKind === 'safety-review' ? routeSafetyReview(ctx) : routeLadder(ctx);
}

/** The decisions-table shape: kind, one-line summary, and the full decision as data. */
export function toDecisionRecord(d: RouteDecision): { kind: string; summary: string; data: RouteDecision } {
  return { kind: d.kind, summary: d.summary, data: d };
}

// ---------------------------------------------------------------------------
// Claude ladder: haiku -> sonnet -> opus -> fable

function routeLadder(ctx: Ctx): RouteDecision {
  const { profile, signals, policy } = ctx;
  const assessment = ctx.registry.assess({
    surface: 'claude-cli',
    provider: 'claude',
    allowedModels: policy.routing.allowed_models,
    structuredOutput: true,
    ...(profile.vision ? { vision: true } : {}),
  });
  const byTier = groupByTier(assessment.eligible);
  const notes: string[] = [];

  let startTier = profile.startTier;
  let preferred: string | null = null;
  const override = policy.routing.overrides[ctx.workKind];
  if (override) {
    const r = resolveOverride(override, ctx.registry);
    if (r && r.provider === 'claude' && r.tier !== null) {
      startTier = r.tier;
      preferred = r.modelId;
      notes.push(`routing.overrides.${ctx.workKind} sets the starting point to ${override}`);
    } else {
      ctx.ignored.push(`routing.overrides.${ctx.workKind}=${override} names no claude-cli model or family; ignored`);
    }
  }

  const triggers = observedDifficulty(ctx, startTier);
  const dynamic = triggers.filter((t) => !STATIC_SIGNALS.has(t.signal));
  // A repeating failure means the diagnosis is not solved, whether or not the
  // count came with evidence references; it may not escalate without them,
  // but it always blocks routing back down.
  const stillRepeating = signals.repeatedFingerprints >= ctx.threshold;
  let active = triggers;
  const prevTier = ctx.previousTier;
  let base = startTier;
  let downRoutedFrom: RouteRef | undefined;
  if (prevTier !== null && prevTier > startTier) {
    if (signals.diagnosisSolved && dynamic.length === 0 && !stillRepeating && profile.routine) {
      downRoutedFrom = ref(ctx.previous as ModelEntry);
      notes.push(`the hard diagnosis is solved, so routine follow-up routes down from ${TIER_NAME[prevTier]} to ${TIER_NAME[startTier]}`);
      if (triggers.length) {
        ctx.ignored.push(`${triggers.map((t) => t.signal).join(', ')} superseded by the solved diagnosis`);
        active = [];
      }
    } else {
      base = prevTier;
      const why = !signals.diagnosisSolved
        ? 'no solved diagnosis is recorded'
        : !profile.routine
          ? `${ctx.workKind} is not routine follow-up work`
          : 'equivalent failures still repeat, so the diagnosis is not treated as solved';
      notes.push(`stays at ${TIER_NAME[prevTier]}, where the previous attempt ran, because ${why}`);
    }
  } else if (signals.diagnosisSolved && prevTier !== null) {
    notes.push('diagnosis solved; already at the starting tier');
  }

  // Failures observed since the last route move one tier above where that
  // route ran. Properties of the task itself (coupling, ambiguity, security
  // relevance, visual complexity) only lift the starting point by one tier,
  // so they never compound across attempts. When the tier cannot rise (top of the ladder,
  // Fable not justified, nothing eligible above), effort rises instead.
  let effortBump = 0;
  const activeDynamic = active.some((t) => !STATIC_SIGNALS.has(t.signal));
  let target = activeDynamic ? Math.min(base + 1, FABLE_TIER) : active.length ? Math.max(base, Math.min(startTier + 1, FABLE_TIER)) : base;
  if (activeDynamic && base >= FABLE_TIER) {
    effortBump += 1;
    notes.push('already at the top tier, so observed difficulty raises effort instead');
  }
  const rising = target > base;

  let gate: FableGate | null = null;
  if (target === FABLE_TIER) {
    gate = fableGate(ctx, byTier, assessment);
    if (gate.ok) {
      notes.push(`Fable justified: ${gate.basis}`);
    } else {
      notes.push(`Fable not chosen: ${gate.why}`);
      target = FABLE_TIER - 1;
      if (rising) effortBump += 1;
    }
  }

  const allowFable = gate?.ok === true;
  const tier = nearestTier(target, byTier, allowFable);
  if (tier === null) {
    throw new OrbitError('PROVIDER_UNAVAILABLE', `no eligible claude-cli model for ${ctx.workKind}`, {
      work_kind: ctx.workKind,
      excluded: assessment.excluded.map((e) => ({ model: e.model.modelId, reasons: e.reasons })),
    });
  }
  if (tier !== target) {
    notes.push(`no eligible ${TIER_NAME[target]} model; nearest eligible tier is ${TIER_NAME[tier]}`);
    if (rising && tier <= base) effortBump += 1;
  }

  const estimates = new Map<string, RouteCost>();
  const costOf = (m: ModelEntry): RouteCost => {
    let c = estimates.get(m.modelId);
    if (!c) {
      c = estimateRoute(m, ctx);
      estimates.set(m.modelId, c);
    }
    return c;
  };

  let chosen = pickInTier(byTier.get(tier) ?? [], preferred, costOf);
  const justification: RouteJustification = { signals: active.map((t) => ({ ...t })), evidence: [...ctx.evidence], ignored: ctx.ignored };

  // Screenshot accuracy is measured per route; a low measured hit rate is observed difficulty.
  if (ctx.workKind === 'screenshot' && active.length === 0 && tier < FABLE_TIER - 1) {
    const stat = statFor(ctx, chosen);
    const judged = stat ? stat.verified + stat.failed + stat.rejected : 0;
    if (stat && judged >= MIN_MEASURED_SAMPLES && stat.successRate !== null && stat.successRate < ACCURACY_FLOOR) {
      const up = pickInTier(byTier.get(tier + 1) ?? [], null, costOf);
      if (up) {
        justification.signals.push({ signal: 'measured-accuracy', detail: `measured accuracy ${pct(stat.successRate)} over ${judged} outcomes is below ${pct(ACCURACY_FLOOR)}`, evidence: [] });
        notes.push(`measured screenshot accuracy of ${chosen.modelId} is below the floor`);
        return finish(ctx, startTier, up, chosen, profile.baseEffort, effortBump, notes, justification, assessment, costOf, ref(chosen), downRoutedFrom);
      }
    }
  }

  // Calibration: with enough measured outcomes, an adjacent tier that is
  // clearly cheaper per verified task displaces the table's choice. Never
  // while difficulty is being escalated, and never into Fable (gated above).
  if (active.length === 0 && !downRoutedFrom) {
    const mine = costOf(chosen);
    if (mine.basis === 'measured' && mine.total !== null) {
      let best: { m: ModelEntry; c: RouteCost } | null = null;
      for (const t of [tier - 1, tier + 1]) {
        if (t < 1 || t >= FABLE_TIER) continue;
        for (const m of byTier.get(t) ?? []) {
          const c = costOf(m);
          if (c.basis !== 'measured' || c.total === null) continue;
          if (c.total < mine.total * (1 - CALIBRATION_MARGIN) && (!best || (best.c.total as number) > c.total)) best = { m, c };
        }
      }
      if (best) {
        const detail = `measured expected cost per verified task $${fmt(best.c.total)} for ${best.m.modelId} vs $${fmt(mine.total)} for ${chosen.modelId}`;
        notes.push(`calibrated by measured outcomes: ${detail}`);
        if ((tierOf(best.m) ?? 0) > tier) justification.signals.push({ signal: 'measured-outcomes', detail, evidence: [] });
        chosen = best.m;
      }
    }
  }

  const escalatedFrom = rising && (tierOf(chosen) ?? 0) > base ? escalationOrigin(ctx, byTier, base, costOf) : undefined;
  return finish(ctx, startTier, chosen, null, profile.baseEffort, effortBump, notes, justification, assessment, costOf, escalatedFrom, downRoutedFrom);
}

/**
 * Observed difficulty, per the spec table's escalation column. Each trigger
 * comes from durable records (failure fingerprints, evidence ids) or from a
 * task property the spec table names, so it can be replayed.
 */
function observedDifficulty(ctx: Ctx, startTier: number): Trigger[] {
  const s = ctx.signals;
  const out: Trigger[] = [];
  // A bare count is not recorded justification: escalation on repeated
  // failures needs references to the failure records it was counted from
  // (architecture: "Opus after repeated equivalent failures with evidence").
  const repeatedCount = s.repeatedFingerprints >= ctx.threshold;
  const repeated = repeatedCount && ctx.evidence.length > 0;
  if (repeatedCount && !repeated) {
    ctx.ignored.push(`${s.repeatedFingerprints} repeated equivalent failures reported without evidence references; not acted on`);
  }
  const prev = s.previousRoute;
  const strongFailed = prev?.outcome === 'failed' && ctx.evidence.length > 0 && ctx.previousTier !== null && ctx.previousTier >= startTier;
  const repeatedT: Trigger = { signal: 'repeated-equivalent-failures', detail: `${s.repeatedFingerprints} equivalent failures, threshold ${ctx.threshold}`, evidence: ctx.evidence };
  const strongT: Trigger = {
    signal: 'strong-attempt-failed',
    detail: `attempt ${s.attempt - 1 > 0 ? s.attempt - 1 : 'before this'} on ${prev?.model ?? 'unknown'} failed with recorded evidence`,
    evidence: ctx.evidence,
  };
  switch (ctx.workKind) {
    case 'extraction':
    case 'log-classification':
    case 'curation':
      if (s.ambiguity) out.push({ signal: 'ambiguity', detail: 'the material is ambiguous', evidence: ctx.evidence });
      if (s.criticalSecurity) out.push({ signal: 'security-sensitive-interpretation', detail: 'interpretation affects a security decision', evidence: ctx.evidence });
      if (repeated) out.push(repeatedT);
      if (strongFailed) out.push(strongT);
      break;
    case 'routine-code':
    case 'focused-tests':
      // Spec escalation column: coupled changes or difficult causal failures.
      // A complex classification is a prediction, not observed difficulty, so
      // it raises effort (see finish) rather than the tier.
      if (s.coupled) out.push({ signal: 'coupled-change', detail: 'the change couples several subsystems', evidence: ctx.evidence });
      if (repeated) out.push(repeatedT);
      if (strongFailed) out.push(strongT);
      break;
    case 'architecture':
    case 'complex-diagnosis':
      // Spec: escalate only when a strong attempt still leaves hard, evidence-backed difficulty.
      if (strongFailed) out.push(strongT);
      else if (repeated && ctx.previousTier !== null && ctx.previousTier >= startTier) out.push(repeatedT);
      break;
    case 'long-horizon':
      if (repeated) out.push(repeatedT);
      if (strongFailed) out.push(strongT);
      break;
    case 'screenshot':
      if (s.visualComplexity === 'high') out.push({ signal: 'visual-complexity', detail: 'the screenshot is visually complex', evidence: ctx.evidence });
      if (repeated) out.push(repeatedT);
      if (strongFailed) out.push(strongT);
      break;
    case 'safety-review':
      break;
  }
  return out;
}

interface FableGate {
  ok: boolean;
  basis: string;
  why: string;
}

/** Fable only when policy names it AND recorded evidence justifies the added expense. */
function fableGate(ctx: Ctx, byTier: Map<number, ModelEntry[]>, assessment: EligibilityAssessment): FableGate {
  const fables = byTier.get(FABLE_TIER) ?? [];
  if (fables.length === 0) {
    const ex = assessment.excluded.find((e) => tierOf(e.model) === FABLE_TIER);
    return { ok: false, basis: '', why: ex ? `${ex.model.modelId} is ineligible (${ex.reasons.join('; ')})` : 'no Fable model is registered' };
  }
  const prev = ctx.signals.previousRoute;
  if (prev?.outcome === 'failed' && ctx.previousTier !== null && ctx.previousTier >= FABLE_TIER - 1 && ctx.evidence.length > 0) {
    return { ok: true, basis: `an opus-class attempt on ${prev.model} failed with recorded evidence (${ctx.evidence.join(', ')})`, why: '' };
  }
  const evaluated = fables.find((f) => f.evaluation.justifiedWorkKinds.includes(ctx.workKind));
  if (evaluated) return { ok: true, basis: `a recorded evaluation justifies ${evaluated.modelId} for ${ctx.workKind}`, why: '' };
  for (const f of fables) {
    const fc = estimateRoute(f, ctx);
    if (fc.basis !== 'measured' || fc.total === null) continue;
    for (const o of byTier.get(FABLE_TIER - 1) ?? []) {
      const oc = estimateRoute(o, ctx);
      if (oc.basis === 'measured' && oc.total !== null && fc.total <= oc.total) {
        return { ok: true, basis: `measured outcomes give ${f.modelId} $${fmt(fc.total)} per verified task against $${fmt(oc.total)} for ${o.modelId}`, why: '' };
      }
    }
  }
  return {
    ok: false,
    basis: '',
    why: 'no recorded evidence justifies the added expense (needs a failed opus-class attempt with evidence, a recorded evaluation, or measured outcomes)',
  };
}

function escalationOrigin(ctx: Ctx, byTier: Map<number, ModelEntry[]>, base: number, costOf: (m: ModelEntry) => RouteCost): RouteRef | undefined {
  if (ctx.previous && ctx.previousTier === base) return ref(ctx.previous);
  if (ctx.signals.previousRoute) return { provider: ctx.signals.previousRoute.provider, model: ctx.signals.previousRoute.model, family: ctx.previous?.family ?? null };
  const at = byTier.get(base);
  if (at?.length) return ref(pickInTier(at, null, costOf));
  return { provider: 'claude', model: TIER_NAME[base] ?? String(base), family: TIER_NAME[base] ?? null };
}

// ---------------------------------------------------------------------------
// Independent safety and correctness review

type QualBasis = 'configured' | 'evaluation' | 'provider-default' | 'tier';
const BASIS_RANK: Readonly<Record<QualBasis, number>> = { configured: 0, evaluation: 1, 'provider-default': 2, tier: 3 };

function routeSafetyReview(ctx: Ctx): RouteDecision {
  const { policy, signals } = ctx;
  const implementer = signals.implementerProvider ?? 'claude';
  const notes: string[] = [];
  const rejected: RouteAlternative[] = [];
  const candidates: { entry: ModelEntry; basis: QualBasis; detail: string; independent: boolean }[] = [];
  const costOf = (m: ModelEntry): RouteCost => estimateRoute(m, ctx);
  let fableGateResult: FableGate | null = null;

  // A reviewer model named in trusted provider configuration is an explicit
  // choice by the user, so it counts as allowed even though codex models are
  // resolved at runtime and rarely listed in routing.allowed_models.
  const configuredReviewers = Object.entries(policy.providers)
    .filter(([p, cfg]) => p !== 'claude' && cfg.data_policy_eligible === true && typeof cfg.model === 'string' && cfg.model.length > 0)
    .map(([, cfg]) => cfg.model as string);
  const allowedModels = [...policy.routing.allowed_models, ...configuredReviewers];
  for (const [provider, surface] of Object.entries(PROVIDER_SURFACE)) {
    const a = ctx.registry.assess({ surface, provider, allowedModels, structuredOutput: true });
    for (const ex of a.excluded) {
      if (ex.model.provider === provider) rejected.push(alternative(ex.model, false, null, `ineligible: ${ex.reasons.join('; ')}`));
    }
    for (const e of a.eligible) {
      if (provider !== 'claude' && policy.providers[provider]?.data_policy_eligible !== true) {
        rejected.push(alternative(e, true, costOf(e), `data policy: providers.${provider}.data_policy_eligible is not true`));
        continue;
      }
      const tier = tierOf(e);
      if (tier !== null) {
        if (tier < SAFETY_FLOOR_TIER) {
          rejected.push(alternative(e, true, costOf(e), `${e.family} is below the safety review quality floor (opus-class)`));
          continue;
        }
        if (tier === FABLE_TIER) {
          fableGateResult ??= fableGate(ctx, groupByTier(a.eligible), a);
          if (!fableGateResult.ok) {
            rejected.push(alternative(e, true, costOf(e), `Fable not chosen: ${fableGateResult.why}`));
            continue;
          }
        }
        candidates.push({ entry: e, basis: 'tier', detail: `${e.family} meets the opus-class floor`, independent: provider !== implementer });
        continue;
      }
      const q = qualifyOtherProvider(e, policy);
      if (!q) {
        rejected.push(alternative(e, true, costOf(e), 'not qualified for safety review: no recorded evaluation, not configured in providers, not the provider default'));
        continue;
      }
      candidates.push({ entry: e, basis: q.basis, detail: q.detail, independent: provider !== implementer });
    }
  }

  let preferred: string | null = null;
  const override = policy.routing.overrides['safety-review'];
  if (override) {
    const r = resolveOverride(override, ctx.registry);
    const hit = r?.modelId ? candidates.find((c) => c.entry.modelId === r.modelId) : r?.tier ? candidates.find((c) => tierOf(c.entry) === r.tier) : undefined;
    if (hit) {
      preferred = hit.entry.modelId;
      notes.push(`routing.overrides.safety-review prefers ${override}`);
    } else {
      ctx.ignored.push(`routing.overrides.safety-review=${override} is not a qualified reviewer at or above the quality floor; ignored`);
    }
  }

  const rank = (c: (typeof candidates)[number]): number[] => [
    c.entry.modelId === preferred ? 0 : 1,
    c.entry.provider === policy.review.preferred_provider ? 0 : 1,
    BASIS_RANK[c.basis],
    tierOf(c.entry) ?? 0,
    costOf(c.entry).total ?? Number.POSITIVE_INFINITY,
  ];
  const sorted = [...candidates].sort((x, y) => compareTuples(rank(x), rank(y)) || x.entry.modelId.localeCompare(y.entry.modelId));
  const independent = sorted.filter((c) => c.independent);
  let chosen = independent[0];
  if (chosen) {
    notes.push(`independent reviewer from ${chosen.entry.provider} (implementer: ${implementer}); qualified by ${chosen.detail}`);
  } else {
    const sameAllowed = !policy.review.independent_provider_required || policy.review.fallback_same_provider_allowed;
    const same = sorted.filter((c) => !c.independent);
    if (!sameAllowed || same.length === 0) {
      throw new OrbitError(
        'PROVIDER_UNAVAILABLE',
        sameAllowed
          ? 'no qualified reviewer at or above the safety review quality floor is eligible'
          : `independent review is required but no qualified reviewer from a provider other than ${implementer} is eligible`,
        {
          work_kind: 'safety-review',
          implementer_provider: implementer,
          independent_provider_required: policy.review.independent_provider_required,
          fallback_same_provider_allowed: policy.review.fallback_same_provider_allowed,
          alternatives_considered: rejected,
        },
      );
    }
    chosen = same[0] as (typeof candidates)[number];
    notes.push(
      policy.review.independent_provider_required
        ? `no qualified independent reviewer; policy allows same-provider review at the opus-class floor (${chosen.detail})`
        : `independent review not required and none qualified; same-provider review at the opus-class floor (${chosen.detail})`,
    );
  }

  for (const c of sorted) {
    if (c === chosen) continue;
    const why = c.independent === chosen.independent ? `ranked below ${chosen.entry.modelId} (override, preferred provider, qualification basis, tier, then cost)` : 'same provider as the implementer; an independent reviewer is preferred';
    rejected.push(alternative(c.entry, true, costOf(c.entry), why));
  }

  const configured = policy.providers[chosen.entry.provider]?.reasoning_effort ?? null;
  const effortSteps = signals.criticalSecurity ? 1 : 0;
  let effort = chooseEffort(chosen.entry, ctx.profile.baseEffort, effortSteps);
  if (configured && effort !== null && chosen.entry.capabilities.effortLevels.includes(configured) && effortRank(configured) > effortRank(effort)) effort = configured;
  if (signals.criticalSecurity) notes.push('critical security impact raises review effort');

  const cost = costOf(chosen.entry);
  const decision: RouteDecision = {
    kind: 'route',
    summary: `route safety-review -> ${chosen.entry.provider}/${chosen.entry.modelId}`,
    work_kind: 'safety-review',
    provider: chosen.entry.provider,
    model: chosen.entry.modelId,
    surface: PROVIDER_SURFACE[chosen.entry.provider] ?? 'claude-cli',
    family: chosen.entry.family,
    effort,
    reason: `safety-review: quality floor is opus-class or a qualified other-provider model; ${notes.join('; ')}; ${costText(cost)}`,
    justification: { signals: [], evidence: [...ctx.evidence], ignored: ctx.ignored },
    alternatives_considered: rejected,
    expected_cost_per_verified_task: cost.total,
    expected_cost_breakdown: cost.breakdown,
    cost_basis: cost.basis,
    success_probability: round3(cost.success),
    attempt: signals.attempt,
    difficulty: signals.difficulty,
  };
  return decision;
}

function qualifyOtherProvider(e: ModelEntry, policy: RoutingPolicy): { basis: QualBasis; detail: string } | null {
  if (policy.providers[e.provider]?.model === e.modelId) return { basis: 'configured', detail: `providers.${e.provider}.model names it` };
  if (e.evaluation.qualifiedFor.includes('safety-review')) return { basis: 'evaluation', detail: 'a recorded safety-review evaluation' };
  if (e.eligibility.providerDefault) return { basis: 'provider-default', detail: `it is ${e.provider}'s recommended model in the live catalog` };
  return null;
}

// ---------------------------------------------------------------------------
// Expected cost

function estimateRoute(m: ModelEntry, ctx: Ctx): RouteCost {
  const profile = ctx.profile;
  const tier = tierOf(m) ?? SAFETY_FLOOR_TIER;
  const prior = profile.output === 'review' ? PRIOR_REVIEW_SUCCESS : (PRIOR_SUCCESS[tier] as Record<DifficultyClass, number>)[ctx.signals.difficulty];
  const stat = statFor(ctx, m);
  const judged = stat ? stat.verified + stat.failed + stat.rejected : 0;
  const success = Math.max(MIN_SUCCESS, Math.min(1, ((stat?.verified ?? 0) + PRIOR_WEIGHT * prior) / (judged + PRIOR_WEIGHT)));
  const measuredCost = stat && stat.costSamples > 0 ? stat.meanCostUsd : null;
  const attemptCost = measuredCost ?? (m.pricing ? priceProfile(profile.tokens, m.pricing) : null);
  if (attemptCost === null) return { total: null, breakdown: null, basis: 'unavailable', success };
  const basis: CostBasis = judged >= MIN_MEASURED_SAMPLES && (stat?.costSamples ?? 0) >= MIN_MEASURED_SAMPLES ? 'measured' : judged > 0 || measuredCost !== null ? 'blended' : 'prior';
  const attempts = 1 / success;
  const handoff = ctx.signals.previousRoute && ctx.signals.previousRoute.model !== m.modelId && ctx.previous?.modelId !== m.modelId && m.pricing;
  const breakdown: CostBreakdown = {
    execution: roundUsd(attemptCost),
    likely_repairs: roundUsd((attempts - 1) * attemptCost * REPAIR_COST_FRACTION),
    verification: profile.output === 'candidate' || profile.output === 'diagnosis' ? roundUsd(attempts * VERIFICATION_USD_PER_ATTEMPT) : 0,
    review: profile.output === 'candidate' ? REVIEW_USD_PER_TASK : 0,
    coordination: handoff && m.pricing ? roundUsd((HANDOFF_TOKENS * m.pricing.input) / 1_000_000) : 0,
  };
  const total = roundUsd(breakdown.execution + breakdown.likely_repairs + breakdown.verification + breakdown.review + breakdown.coordination);
  return { total, breakdown, basis, success };
}

function priceProfile(t: WorkProfile['tokens'], p: ModelPricing): number {
  const cached = t.input * t.cacheReadShare;
  const written = t.input * t.cacheWriteShare;
  const uncached = Math.max(0, t.input - cached - written);
  return (uncached * p.input + cached * p.cache_read + written * p.cache_write_5m + t.output * p.output) / 1_000_000;
}

function statFor(ctx: Ctx, m: ModelEntry): RouteStat | undefined {
  return ctx.outcomes.find((s) => s.workKind === ctx.workKind && s.modelId === m.modelId && s.provider === m.provider);
}

// ---------------------------------------------------------------------------
// Helpers

function finish(
  ctx: Ctx,
  startTier: number,
  chosen: ModelEntry,
  displaced: ModelEntry | null,
  baseEffort: string,
  effortBump: number,
  notes: string[],
  justification: RouteJustification,
  assessment: EligibilityAssessment,
  costOf: (m: ModelEntry) => RouteCost,
  escalatedFrom: RouteRef | undefined,
  downRoutedFrom: RouteRef | undefined,
): RouteDecision {
  const s = ctx.signals;
  let steps = effortBump;
  if (s.difficulty === 'complex' && ctx.profile.output !== 'interpretation') {
    steps += 1;
    notes.push('complex classification raises effort, not tier');
  }
  if (s.criticalSecurity && ctx.profile.output !== 'interpretation') {
    steps += 1;
    notes.push('critical security impact raises effort');
  }
  const effort = chooseEffort(chosen, baseEffort, steps);
  const chosenTier = tierOf(chosen) ?? 0;
  const alternatives: RouteAlternative[] = [];
  for (const m of assessment.eligible) {
    if (m.modelId === chosen.modelId) continue;
    const t = tierOf(m) ?? 0;
    let why: string;
    if (displaced && m.modelId === displaced.modelId) why = 'measured accuracy below the floor';
    else if (t > chosenTier && t !== FABLE_TIER && chosenTier < startTier) why = `measured outcomes give ${chosen.modelId} a lower expected cost per verified task`;
    else if (t > chosenTier) why = t === FABLE_TIER ? 'Fable requires policy and recorded evidence of need; not justified for this decision' : 'higher tier than this work needs; no observed difficulty justifies it';
    else if (t < chosenTier && t < startTier) why = `below the ${TIER_NAME[startTier] ?? 'starting'} tier this work starts at`;
    else if (t < chosenTier) why = escalatedFrom ? 'escalated past this tier on observed difficulty' : `below the ${TIER_NAME[chosenTier] ?? 'chosen'} tier chosen for this work`;
    else why = `higher expected cost per verified task than ${chosen.modelId}`;
    alternatives.push(alternative(m, true, costOf(m), why));
  }
  for (const ex of assessment.excluded) alternatives.push(alternative(ex.model, false, null, `ineligible: ${ex.reasons.join('; ')}`));

  const cost = costOf(chosen);
  const start = `${ctx.workKind} starts at ${TIER_NAME[ctx.profile.startTier]} (spec section 8)`;
  const trig = justification.signals.length ? `observed difficulty: ${justification.signals.map((t) => `${t.signal} (${t.detail})`).join(', ')}` : 'no observed difficulty';
  const reason = [start, trig, ...notes, `chose ${chosen.modelId} at effort ${effort ?? 'n/a'}`, costText(cost)].join('; ');
  const decision: RouteDecision = {
    kind: 'route',
    summary: `route ${ctx.workKind} -> ${chosen.provider}/${chosen.modelId}${escalatedFrom ? ` (escalated from ${escalatedFrom.model})` : ''}${downRoutedFrom ? ` (down from ${downRoutedFrom.model})` : ''}`,
    work_kind: ctx.workKind,
    provider: chosen.provider,
    model: chosen.modelId,
    surface: PROVIDER_SURFACE[chosen.provider] ?? 'claude-cli',
    family: chosen.family,
    effort,
    reason,
    justification,
    alternatives_considered: alternatives,
    expected_cost_per_verified_task: cost.total,
    expected_cost_breakdown: cost.breakdown,
    cost_basis: cost.basis,
    success_probability: round3(cost.success),
    attempt: s.attempt,
    difficulty: s.difficulty,
  };
  if (escalatedFrom) decision.escalated_from = escalatedFrom;
  if (downRoutedFrom) decision.down_routed_from = downRoutedFrom;
  return decision;
}

function alternative(m: ModelEntry, eligible: boolean, cost: RouteCost | null, why: string): RouteAlternative {
  return {
    provider: m.provider,
    model: m.modelId,
    family: m.family,
    eligible,
    expected_cost_per_verified_task: cost?.total ?? null,
    cost_basis: cost?.basis ?? 'unavailable',
    rejected_because: why,
  };
}

function groupByTier(models: ModelEntry[]): Map<number, ModelEntry[]> {
  const out = new Map<number, ModelEntry[]>();
  for (const m of models) {
    const t = tierOf(m);
    if (t === null) continue;
    const list = out.get(t) ?? [];
    list.push(m);
    out.set(t, list);
  }
  return out;
}

/** Prefer the target, then higher tiers (quality preserved), then lower ones. Fable only through its gate. */
function nearestTier(target: number, byTier: Map<number, ModelEntry[]>, allowFable: boolean): number | null {
  const top = allowFable ? FABLE_TIER : FABLE_TIER - 1;
  const order: number[] = [];
  for (let t = target; t <= top; t++) order.push(t);
  for (let t = Math.min(target, top + 1) - 1; t >= 1; t--) order.push(t);
  for (const t of order) if ((byTier.get(t) ?? []).length > 0) return t;
  return null;
}

function pickInTier(models: ModelEntry[], preferred: string | null, costOf: (m: ModelEntry) => RouteCost): ModelEntry {
  const hit = preferred ? models.find((m) => m.modelId === preferred) : undefined;
  if (hit) return hit;
  const sorted = [...models].sort((a, b) => {
    const ca = costOf(a).total ?? Number.POSITIVE_INFINITY;
    const cb = costOf(b).total ?? Number.POSITIVE_INFINITY;
    return ca - cb || a.modelId.localeCompare(b.modelId);
  });
  return sorted[0] as ModelEntry;
}

function resolveOverride(value: string, registry: RegistryView): { provider: string; tier: number | null; modelId: string | null } | null {
  const v = value.trim().toLowerCase();
  if (FAMILY_TIER[v] !== undefined) return { provider: 'claude', tier: FAMILY_TIER[v] as number, modelId: null };
  const e = registry.get(value.trim());
  return e ? { provider: e.provider, tier: tierOf(e), modelId: e.modelId } : null;
}

function chooseEffort(m: ModelEntry, base: string, steps: number): string | null {
  const supported = m.capabilities.effortLevels.filter((l) => effortRank(l) >= 0);
  if (supported.length === 0) return null;
  const desired = Math.min(effortRank(base) + steps, effortRank(EFFORT_CEILING));
  const atOrBelow = supported.filter((l) => effortRank(l) <= desired).sort((a, b) => effortRank(b) - effortRank(a));
  if (atOrBelow[0]) return atOrBelow[0];
  return [...supported].sort((a, b) => effortRank(a) - effortRank(b))[0] ?? null;
}

function effortRank(level: string): number {
  return (EFFORT_ORDER as readonly string[]).indexOf(level);
}

function workerClaimNotes(s: RouteSignals): string[] {
  const c = s.workerClaims;
  if (!c) return [];
  const parts: string[] = [];
  if (c.confidence !== undefined) parts.push(`confidence ${String(c.confidence)}`);
  if (c.requestedModel) parts.push(`requested model ${c.requestedModel}`);
  if (c.requestedEscalation !== undefined) parts.push(`requested escalation ${String(c.requestedEscalation)}`);
  return parts.length ? [`worker claims (${parts.join(', ')}) recorded and ignored: routing escalates on observed difficulty only`] : [];
}

function ref(m: ModelEntry): RouteRef {
  return { provider: m.provider, model: m.modelId, family: m.family };
}

function costText(c: RouteCost): string {
  return c.total === null ? 'expected cost per verified task unavailable (no pricing or measured cost)' : `expected cost per verified task $${fmt(c.total)} (${c.basis} basis, success ${pct(c.success)})`;
}

function compareTuples(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function fmt(n: number | null): string {
  return n === null ? 'n/a' : n.toFixed(4);
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
