import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { route, type RegistryView } from '../../../src/routing/router.ts';
import type { EligibilityAssessment, EligibilityRequirements, ModelEntry, ModelPricing, RouteStat, WorkKind } from '../../../src/routing/types.ts';
import { policy, setup, signals } from './fixtures.ts';

const price = (k: number): ModelPricing => ({ input: 3 * k, output: 15 * k, cache_write_5m: 3.75 * k, cache_write_1h: 6 * k, cache_read: 0.3 * k });

interface ModelOptions {
  provider?: string;
  k?: number;
  pricing?: ModelPricing | null;
  effort?: string[];
  providerDefault?: boolean;
  qualifiedFor?: string[];
  justified?: string[];
}

function model(id: string, family: string | null, o: ModelOptions = {}): ModelEntry {
  return {
    modelId: id,
    provider: o.provider ?? 'claude',
    family,
    displayName: id,
    surfaces: [],
    capabilities: { tools: true, structuredOutput: true, vision: true, effortLevels: o.effort ?? ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: null },
    limits: null,
    pricing: o.pricing === undefined ? price(o.k ?? 1) : o.pricing,
    eligibility: { aliases: [], cliAlias: null, minCliVersion: null, requiresExplicitPolicy: false, providerDefault: o.providerDefault ?? false, notes: [], provenance: {} },
    evaluation: { observedCost: null, qualifiedFor: o.qualifiedFor ?? [], justifiedWorkKinds: o.justified ?? [] },
    latencyMs: null,
    available: true,
    refreshedAt: null,
  };
}

/** A registry that answers with exactly the models it is given. */
function fake(models: ModelEntry[], excluded: { model: ModelEntry; reasons: string[] }[] = []): RegistryView {
  return {
    assess(req: EligibilityRequirements): EligibilityAssessment {
      const matches = (m: ModelEntry) => !req.provider || m.provider === req.provider;
      return { eligible: models.filter(matches), excluded: excluded.filter((e) => matches(e.model)) };
    },
    get(id: string) {
      return [...models, ...excluded.map((e) => e.model)].find((m) => m.modelId === id) ?? null;
    },
  };
}

function stat(workKind: WorkKind, m: ModelEntry, verified: number, failed: number, meanCostUsd: number | null, costSamples = verified + failed): RouteStat {
  const judged = verified + failed;
  return { workKind, provider: m.provider, modelId: m.modelId, samples: judged, verified, failed, rejected: 0, errors: 0, successRate: judged ? verified / judged : null, meanCostUsd, costSamples, meanTokens: null };
}

const haiku = model('h-1', 'haiku', { k: 0.3 });
const sonnet = model('s-1', 'sonnet', { k: 1 });
const opus = model('o-1', 'opus', { k: 2 });
const fable = model('f-1', 'fable', { k: 4 });

describe('request handling', () => {
  it('uses a threshold of two when the policy has no scheduler section', () => {
    const { registry } = setup();
    const p = { ...policy(), scheduler: undefined };
    const d = route({ workKind: 'routine-code', signals: signals({ repeatedFingerprints: 2, evidence: ['fail-1'] }), registry, policy: p });
    expect(d.model).toContain('opus');
    expect(d.justification.signals.map((s) => s.signal)).toEqual(['repeated-equivalent-failures']);
    // A configured threshold below one is clamped to one.
    const low = route({ workKind: 'routine-code', signals: signals({ repeatedFingerprints: 1, evidence: ['fail-1'] }), registry, policy: { ...policy(), scheduler: { repeated_failure_threshold: 0 } } });
    expect(low.model).toContain('opus');
  });

  it('records worker claims of every kind as ignored, and nothing for an empty claim', () => {
    const reg = fake([sonnet]);
    const claimed = route({ workKind: 'routine-code', signals: signals({ workerClaims: { confidence: 0.9, requestedModel: 'o-1', requestedEscalation: false } }), registry: reg, policy: policy() });
    expect(claimed.justification.ignored).toEqual(['worker claims (confidence 0.9, requested model o-1, requested escalation false) recorded and ignored: routing escalates on observed difficulty only']);
    const empty = route({ workKind: 'routine-code', signals: signals({ workerClaims: {} }), registry: reg, policy: policy() });
    expect(empty.justification.ignored).toEqual([]);
  });
});

describe('escalation triggers per work kind', () => {
  const repeatedWithEvidence = { repeatedFingerprints: 2, evidence: ['fail-1'] };

  it('extraction acts on repeated failures and on a failed strong attempt together', () => {
    const d = route({
      workKind: 'extraction',
      signals: signals({ ...repeatedWithEvidence, attempt: 3, previousRoute: { provider: 'claude', model: 'h-1', outcome: 'failed' } }),
      registry: fake([haiku, sonnet, opus]),
      policy: policy(),
    });
    expect(d.justification.signals.map((s) => s.signal)).toEqual(['repeated-equivalent-failures', 'strong-attempt-failed']);
    expect(d.justification.signals[1]?.detail).toBe('attempt 2 on h-1 failed with recorded evidence');
    expect(d.model).toBe('s-1');
    expect(d.escalated_from).toMatchObject({ model: 'h-1' });
  });

  it('describes a failed strong attempt on a first attempt without inventing an attempt number', () => {
    const d = route({
      workKind: 'extraction',
      signals: signals({ evidence: ['fail-1'], attempt: 1, previousRoute: { provider: 'claude', model: 'h-1', outcome: 'failed' } }),
      registry: fake([haiku, sonnet]),
      policy: policy(),
    });
    expect(d.justification.signals[0]?.detail).toBe('attempt before this on h-1 failed with recorded evidence');
  });

  it('architecture escalates on repeated failures after an opus-class attempt even when it was not marked failed', () => {
    const d = route({
      workKind: 'architecture',
      signals: signals({ ...repeatedWithEvidence, previousRoute: { provider: 'claude', model: 'o-1', outcome: 'rejected' } }),
      registry: fake([sonnet, opus, fable]),
      policy: policy(),
    });
    expect(d.justification.signals.map((s) => s.signal)).toEqual(['repeated-equivalent-failures']);
    expect(d.reason).toMatch(/Fable not chosen: no recorded evidence justifies the added expense/);
    expect(d.model).toBe('o-1');
  });

  it('architecture ignores repeated failures from a lower tier than its starting point', () => {
    const d = route({
      workKind: 'architecture',
      signals: signals({ ...repeatedWithEvidence, previousRoute: { provider: 'claude', model: 's-1', outcome: 'rejected' } }),
      registry: fake([sonnet, opus]),
      policy: policy(),
    });
    expect(d.justification.signals).toEqual([]);
    expect(d.model).toBe('o-1');
  });

  it('long-horizon on Fable that keeps failing raises effort because there is no tier above', () => {
    const d = route({
      workKind: 'long-horizon',
      signals: signals({ ...repeatedWithEvidence, attempt: 3, previousRoute: { provider: 'claude', model: 'f-1', outcome: 'failed' } }),
      registry: fake([sonnet, opus, fable]),
      policy: policy(),
    });
    expect(d.justification.signals.map((s) => s.signal)).toEqual(['repeated-equivalent-failures', 'strong-attempt-failed']);
    expect(d.model).toBe('f-1');
    expect(d.effort).toBe('xhigh');
    expect(d.reason).toMatch(/already at the top tier, so observed difficulty raises effort instead/);
  });

  it('screenshots act on repeated failures and a failed strong attempt', () => {
    const d = route({
      workKind: 'screenshot',
      signals: signals({ ...repeatedWithEvidence, previousRoute: { provider: 'claude', model: 'h-1', outcome: 'failed' } }),
      registry: fake([haiku, sonnet]),
      policy: policy(),
    });
    expect(d.justification.signals.map((s) => s.signal)).toEqual(['repeated-equivalent-failures', 'strong-attempt-failed']);
    expect(d.model).toBe('s-1');
  });

  it('safety-review is routed by its own path, so ladder signals never apply to it', () => {
    const d = route({
      workKind: 'safety-review',
      signals: signals({ ...repeatedWithEvidence, previousRoute: { provider: 'claude', model: 'o-1', outcome: 'failed' } }),
      registry: fake([opus]),
      policy: policy({ review: { independent_provider_required: false, preferred_provider: 'claude', fallback_same_provider_allowed: true } }),
    });
    expect(d.justification.signals).toEqual([]);
    expect(d.model).toBe('o-1');
  });
});

describe('tier selection with an incomplete registry', () => {
  it('raises effort when the tier it wanted is missing and it falls back to the lower one', () => {
    const d = route({ workKind: 'routine-code', signals: signals({ coupled: true }), registry: fake([haiku, sonnet]), policy: policy() });
    expect(d.model).toBe('s-1');
    expect(d.reason).toMatch(/no eligible opus model; nearest eligible tier is sonnet/);
    expect(d.effort).toBe('high');
  });

  it('names the nearest model it can find when the starting tier has no eligible model at all', () => {
    const d = route({ workKind: 'routine-code', signals: signals({ coupled: true }), registry: fake([haiku, opus]), policy: policy() });
    expect(d.model).toBe('o-1');
    expect(d.escalated_from).toEqual({ provider: 'claude', model: 'sonnet', family: 'sonnet' });
  });

  it('reports an unknown previous model as the origin of an escalation, by name only', () => {
    const d = route({
      workKind: 'routine-code',
      signals: signals({ coupled: true, previousRoute: { provider: 'claude', model: 'retired-model-x', outcome: 'failed' } }),
      registry: fake([sonnet, opus]),
      policy: policy(),
    });
    expect(d.escalated_from).toEqual({ provider: 'claude', model: 'retired-model-x', family: null });
    expect(d.summary).toBe('route routine-code -> claude/o-1 (escalated from retired-model-x)');
  });

  it('ignores a model whose family has no tier when grouping, but lists it among the alternatives', () => {
    const odd = model('mystery-1', 'mystery');
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([haiku, sonnet, opus, odd]), policy: policy() });
    expect(d.model).toBe('s-1');
    expect(d.alternatives_considered.find((a) => a.model === 'mystery-1')?.rejected_because).toMatch(/below the sonnet tier/);
  });

  it('fails with the exclusion reasons when no model is eligible at all', () => {
    try {
      route({ workKind: 'routine-code', signals: signals(), registry: fake([], [{ model: sonnet, reasons: ['not allowed'] }]), policy: policy() });
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'PROVIDER_UNAVAILABLE')).toBe(true);
      expect((err as { details: { excluded: unknown[] } }).details.excluded).toEqual([{ model: 's-1', reasons: ['not allowed'] }]);
    }
  });
});

describe('Fable gate', () => {
  it('says why an ineligible Fable model was passed over', () => {
    const d = route({
      workKind: 'long-horizon',
      signals: signals(),
      registry: fake([sonnet, opus], [{ model: fable, reasons: ['not in routing.allowed_models'] }]),
      policy: policy(),
    });
    expect(d.model).toBe('o-1');
    expect(d.reason).toMatch(/Fable not chosen: f-1 is ineligible \(not in routing.allowed_models\)/);
  });

  it('admits Fable on a recorded evaluation for that kind of work', () => {
    const evaluated = model('f-1', 'fable', { k: 4, justified: ['long-horizon'] });
    const d = route({ workKind: 'long-horizon', signals: signals(), registry: fake([opus, evaluated]), policy: policy() });
    expect(d.model).toBe('f-1');
    expect(d.reason).toMatch(/a recorded evaluation justifies f-1 for long-horizon/);
  });

  it('does not admit a measured Fable when there is no opus-class model to compare with', () => {
    const outcomes = [stat('long-horizon', fable, 8, 2, 0.5)];
    const d = route({ workKind: 'long-horizon', signals: signals(), registry: fake([sonnet, fable]), policy: policy(), outcomes });
    expect(d.model).toBe('s-1');
    expect(d.reason).toMatch(/Fable not chosen: no recorded evidence/);
  });

  it('admits Fable when its measured cost per verified task is no worse than the opus-class one', () => {
    const outcomes = [stat('long-horizon', fable, 9, 1, 0.2), stat('long-horizon', opus, 5, 5, 3)];
    const d = route({ workKind: 'long-horizon', signals: signals(), registry: fake([opus, fable]), policy: policy(), outcomes });
    expect(d.model).toBe('f-1');
    expect(d.reason).toMatch(/measured outcomes give f-1/);
  });

  it('keeps Opus when Fable is measured but costs more per verified task', () => {
    const outcomes = [stat('long-horizon', fable, 9, 1, 9), stat('long-horizon', opus, 9, 1, 0.1)];
    const d = route({ workKind: 'long-horizon', signals: signals(), registry: fake([opus, fable]), policy: policy(), outcomes });
    expect(d.model).toBe('o-1');
  });
});

describe('measured outcomes', () => {
  it('moves to a clearly cheaper higher tier and says it was measured outcomes', () => {
    const outcomes = [stat('routine-code', sonnet, 5, 5, 6), stat('routine-code', opus, 10, 0, 0.5)];
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([haiku, sonnet, opus]), policy: policy(), outcomes });
    expect(d.model).toBe('o-1');
    expect(d.justification.signals.map((s) => s.signal)).toEqual(['measured-outcomes']);
    expect(d.escalated_from).toBeUndefined();
    expect(d.alternatives_considered.find((a) => a.model === 's-1')?.rejected_because).toMatch(/higher expected cost|escalated|below/);
  });

  it('picks the cheapest of several cheaper neighbours', () => {
    const outcomes = [stat('routine-code', sonnet, 5, 5, 6), stat('routine-code', haiku, 10, 0, 0.2), stat('routine-code', opus, 10, 0, 0.5)];
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([haiku, sonnet, opus]), policy: policy(), outcomes });
    expect(d.model).toBe('h-1');
    expect(d.reason).toMatch(/calibrated by measured outcomes/);
    // A cheaper lower tier is not an escalation, so no outcome signal is recorded.
    expect(d.justification.signals).toEqual([]);
  });

  it('keeps the first cheaper neighbour when a later one is not cheaper still', () => {
    const outcomes = [stat('routine-code', sonnet, 5, 5, 6), stat('routine-code', haiku, 10, 0, 0.2), stat('routine-code', opus, 10, 0, 0.9)];
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([haiku, sonnet, opus]), policy: policy(), outcomes });
    expect(d.model).toBe('h-1');
  });

  it('skips neighbours that were never measured, and never calibrates into Fable', () => {
    const outcomes = [stat('routine-code', sonnet, 5, 5, 6), stat('routine-code', opus, 1, 0, 0.01)];
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([sonnet, opus, fable]), policy: policy(), outcomes });
    expect(d.model).toBe('s-1');
  });

  it('screenshots with poor measured accuracy and nowhere higher to go stay put', () => {
    const outcomes = [stat('screenshot', haiku, 1, 9, 0.1)];
    const d = route({ workKind: 'screenshot', signals: signals(), registry: fake([haiku]), policy: policy(), outcomes });
    expect(d.model).toBe('h-1');
    expect(d.justification.signals).toEqual([]);
  });

  it('screenshots move up when measured accuracy is poor and a higher tier exists', () => {
    const outcomes = [stat('screenshot', haiku, 1, 9, 0.1)];
    const d = route({ workKind: 'screenshot', signals: signals(), registry: fake([haiku, sonnet]), policy: policy(), outcomes });
    expect(d.model).toBe('s-1');
    expect(d.justification.signals[0]?.signal).toBe('measured-accuracy');
    expect(d.alternatives_considered.find((a) => a.model === 'h-1')?.rejected_because).toBe('measured accuracy below the floor');
  });

  it('prices a route as blended on a few outcomes or a measured cost alone, and unavailable without pricing', () => {
    const few = route({ workKind: 'routine-code', signals: signals(), registry: fake([sonnet]), policy: policy(), outcomes: [stat('routine-code', sonnet, 1, 1, 2)] });
    expect(few.cost_basis).toBe('blended');
    const costOnly = route({ workKind: 'routine-code', signals: signals(), registry: fake([sonnet]), policy: policy(), outcomes: [stat('routine-code', sonnet, 0, 0, 2, 3)] });
    expect(costOnly.cost_basis).toBe('blended');
    const unpriced = route({ workKind: 'routine-code', signals: signals(), registry: fake([model('s-np', 'sonnet', { pricing: null })]), policy: policy() });
    expect(unpriced.cost_basis).toBe('unavailable');
    expect(unpriced.expected_cost_per_verified_task).toBeNull();
    expect(unpriced.reason).toMatch(/expected cost per verified task unavailable/);
  });
});

describe('choosing within a tier', () => {
  const cheap = model('s-cheap', 'sonnet', { k: 1 });
  const dear = model('s-dear', 'sonnet', { k: 3 });

  it('takes the cheaper of two models in a tier and explains the other', () => {
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([dear, cheap]), policy: policy() });
    expect(d.model).toBe('s-cheap');
    expect(d.alternatives_considered.find((a) => a.model === 's-dear')?.rejected_because).toBe('higher expected cost per verified task than s-cheap');
  });

  it('falls back to id order when neither model has a price', () => {
    const a = model('s-b', 'sonnet', { pricing: null });
    const b = model('s-a', 'sonnet', { pricing: null });
    expect(route({ workKind: 'routine-code', signals: signals(), registry: fake([a, b]), policy: policy() }).model).toBe('s-a');
  });

  it('honours an override naming a model id, and ignores one that is not a claude model', () => {
    const p = policy();
    p.routing.overrides = { 'routine-code': 's-dear' };
    const d = route({ workKind: 'routine-code', signals: signals(), registry: fake([cheap, dear]), policy: p });
    expect(d.model).toBe('s-dear');
    expect(d.reason).toMatch(/routing.overrides.routine-code sets the starting point to s-dear/);
    const other = model('codex-x', null, { provider: 'codex' });
    p.routing.overrides = { 'routine-code': 'codex-x' };
    const ignored = route({ workKind: 'routine-code', signals: signals(), registry: fake([cheap, other]), policy: p });
    expect(ignored.justification.ignored.join(' ')).toMatch(/names no claude-cli model or family; ignored/);
  });

  it('chooses the lowest supported effort when every supported level is above the wanted one', () => {
    const picky = model('h-picky', 'haiku', { effort: ['high', 'max'] });
    const d = route({ workKind: 'extraction', signals: signals(), registry: fake([picky]), policy: policy() });
    expect(d.effort).toBe('high');
  });

  it('reports no effort for a model with no usable effort level', () => {
    const none = model('h-none', 'haiku', { effort: ['bogus'] });
    expect(route({ workKind: 'extraction', signals: signals(), registry: fake([none]), policy: policy() }).effort).toBeNull();
  });
});

describe('down-routing', () => {
  it('stays on the previous tier and says the diagnosis still looks unsolved when failures keep repeating', () => {
    const d = route({
      workKind: 'routine-code',
      signals: signals({ diagnosisSolved: true, repeatedFingerprints: 2, previousRoute: { provider: 'claude', model: 'o-1' } }),
      registry: fake([sonnet, opus]),
      policy: policy(),
    });
    expect(d.model).toBe('o-1');
    expect(d.reason).toMatch(/equivalent failures still repeat/);
  });

  it('notes that it is already at the starting tier when a solved diagnosis changes nothing', () => {
    const d = route({
      workKind: 'routine-code',
      signals: signals({ diagnosisSolved: true, previousRoute: { provider: 'claude', model: 's-1' } }),
      registry: fake([sonnet, opus]),
      policy: policy(),
    });
    expect(d.reason).toMatch(/diagnosis solved; already at the starting tier/);
  });

  it('does not treat a non-claude previous route as a tier', () => {
    const codex = model('codex-x', null, { provider: 'codex' });
    const d = route({ workKind: 'routine-code', signals: signals({ diagnosisSolved: true, previousRoute: { provider: 'codex', model: 'codex-x' } }), registry: fake([sonnet, codex]), policy: policy() });
    expect(d.model).toBe('s-1');
    expect(d.reason).not.toMatch(/stays at/);
  });
});

describe('safety review selection', () => {
  const codexA = model('cx-a', null, { provider: 'codex', pricing: null, effort: ['low', 'medium', 'high', 'xhigh'], qualifiedFor: ['safety-review'] });
  const codexB = model('cx-b', null, { provider: 'codex', pricing: null, effort: ['low', 'medium', 'high', 'xhigh'], qualifiedFor: ['safety-review'] });
  const independent = policy({ review: { independent_provider_required: true, preferred_provider: 'codex', fallback_same_provider_allowed: false } });

  it('orders equally ranked reviewers by model id', () => {
    const d = route({ workKind: 'safety-review', signals: signals(), registry: fake([opus, codexB, codexA]), policy: independent });
    expect(d.model).toBe('cx-a');
    expect(d.alternatives_considered.find((a) => a.model === 'cx-b')?.rejected_because).toMatch(/ranked below cx-a/);
    expect(d.alternatives_considered.find((a) => a.model === 'o-1')?.rejected_because).toBe('same provider as the implementer; an independent reviewer is preferred');
  });

  it('lifts effort to a configured reasoning effort only when the model supports it and it is higher', () => {
    const p = policy({ providers: { codex: { model: null, data_policy_eligible: true, reasoning_effort: 'xhigh' } } });
    expect(route({ workKind: 'safety-review', signals: signals(), registry: fake([codexA]), policy: p }).effort).toBe('xhigh');
    const unsupported = policy({ providers: { codex: { model: null, data_policy_eligible: true, reasoning_effort: 'max' } } });
    expect(route({ workKind: 'safety-review', signals: signals(), registry: fake([codexA]), policy: unsupported }).effort).toBe('high');
    const lower = policy({ providers: { codex: { model: null, data_policy_eligible: true, reasoning_effort: 'low' } } });
    expect(route({ workKind: 'safety-review', signals: signals(), registry: fake([codexA]), policy: lower }).effort).toBe('high');
  });

  it('honours an override by model id or by family, and ignores one that is not a candidate', () => {
    const byId = policy({ review: { independent_provider_required: false, preferred_provider: 'claude', fallback_same_provider_allowed: true } });
    byId.routing.overrides = { 'safety-review': 'cx-b' };
    const d1 = route({ workKind: 'safety-review', signals: signals(), registry: fake([opus, codexA, codexB]), policy: byId });
    expect(d1.model).toBe('cx-b');
    expect(d1.reason).toMatch(/routing.overrides.safety-review prefers cx-b/);
    byId.routing.overrides = { 'safety-review': 'opus' };
    const d2 = route({ workKind: 'safety-review', signals: signals({ implementerProvider: 'codex' }), registry: fake([opus, codexA]), policy: byId });
    expect(d2.model).toBe('o-1');
    expect(d2.reason).toMatch(/prefers opus/);
    byId.routing.overrides = { 'safety-review': 'nonexistent-model' };
    const d3 = route({ workKind: 'safety-review', signals: signals(), registry: fake([opus]), policy: byId });
    expect(d3.justification.ignored.join(' ')).toMatch(/nonexistent-model is not a qualified reviewer/);
  });

  it('allows same-provider review without independence required, and says so', () => {
    const p = policy({ review: { independent_provider_required: false, preferred_provider: 'claude', fallback_same_provider_allowed: false } });
    const d = route({ workKind: 'safety-review', signals: signals(), registry: fake([opus]), policy: p });
    expect(d.model).toBe('o-1');
    expect(d.reason).toMatch(/independent review not required and none qualified; same-provider review/);
  });

  it('blocks with a plain message when nothing at all is eligible and fallback is allowed', () => {
    const p = policy({ review: { independent_provider_required: false, preferred_provider: 'claude', fallback_same_provider_allowed: false } });
    try {
      route({ workKind: 'safety-review', signals: signals(), registry: fake([sonnet]), policy: p });
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'PROVIDER_UNAVAILABLE')).toBe(true);
      expect((err as Error).message).toBe('no qualified reviewer at or above the safety review quality floor is eligible');
    }
  });

  it('keeps Fable out of review unless evidence justifies it', () => {
    const p = policy({ review: { independent_provider_required: false, preferred_provider: 'claude', fallback_same_provider_allowed: true } });
    const without = route({ workKind: 'safety-review', signals: signals(), registry: fake([opus, fable]), policy: p });
    expect(without.model).toBe('o-1');
    expect(without.alternatives_considered.find((a) => a.model === 'f-1')?.rejected_because).toMatch(/^Fable not chosen: /);
    const withEvidence = route({
      workKind: 'safety-review',
      signals: signals({ evidence: ['fail-9'], previousRoute: { provider: 'claude', model: 'o-1', outcome: 'failed' } }),
      registry: fake([opus, fable]),
      policy: p,
    });
    // Both qualify; the lower tier ranks first, the other is only an alternative.
    expect(withEvidence.model).toBe('o-1');
    expect(withEvidence.alternatives_considered.find((a) => a.model === 'f-1')?.rejected_because).toMatch(/ranked below o-1/);
  });

  it('records ineligible models of each provider with their reasons', () => {
    const p = policy({ review: { independent_provider_required: false, preferred_provider: 'claude', fallback_same_provider_allowed: true } });
    const d = route({ workKind: 'safety-review', signals: signals(), registry: fake([opus], [{ model: model('cx-off', null, { provider: 'codex' }), reasons: ['hidden'] }]), policy: p });
    expect(d.alternatives_considered.find((a) => a.model === 'cx-off')).toMatchObject({ eligible: false, rejected_because: 'ineligible: hidden' });
  });
});
