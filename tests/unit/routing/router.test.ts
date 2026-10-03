import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { route, toDecisionRecord, MIN_MEASURED_SAMPLES } from '../../../src/routing/router.ts';
import type { RouteStat, WorkKind } from '../../../src/routing/types.ts';
import { FABLE, HAIKU, OPUS, SONNET, policy, setup, signals } from './fixtures.ts';

function stat(workKind: WorkKind, modelId: string, verified: number, failed: number, meanCostUsd: number, provider = 'claude'): RouteStat {
  const judged = verified + failed;
  return {
    workKind,
    provider,
    modelId,
    samples: judged,
    verified,
    failed,
    rejected: 0,
    errors: 0,
    successRate: judged ? verified / judged : null,
    meanCostUsd,
    costSamples: judged,
    meanTokens: null,
  };
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return isOrbitError(err) ? err.code : String(err);
  }
  return undefined;
}

describe('scenario 13: simple work uses a low-cost eligible route', () => {
  it('routes bounded extraction to Haiku with no effort flag and records the pricier alternatives', () => {
    const { registry } = setup();
    const d = route({ workKind: 'extraction', signals: signals(), registry, policy: policy() });
    expect(d.model).toBe(HAIKU);
    expect(d.provider).toBe('claude');
    expect(d.surface).toBe('claude-cli');
    expect(d.effort).toBeNull();
    expect(d.escalated_from).toBeUndefined();
    expect(d.justification.signals).toEqual([]);
    expect(d.cost_basis).toBe('prior');
    const opus = d.alternatives_considered.find((a) => a.model === OPUS)!;
    expect(opus.rejected_because).toMatch(/higher tier than this work needs/);
    expect(opus.expected_cost_per_verified_task!).toBeGreaterThan(d.expected_cost_per_verified_task!);
    const fable = d.alternatives_considered.find((a) => a.model === FABLE)!;
    expect(fable.eligible).toBe(false);
    expect(fable.rejected_because).toMatch(/not in routing.allowed_models/);
  });

  it('routes simple routine code to Sonnet at medium effort, not Opus or Fable', () => {
    const { registry } = setup();
    const d = route({ workKind: 'routine-code', signals: signals(), registry, policy: policy({ allowed: [HAIKU, SONNET, OPUS, FABLE] }) });
    expect(d.model).toBe(SONNET);
    expect(d.effort).toBe('medium');
    expect(d.reason).toMatch(/routine-code starts at sonnet/);
    expect(d.reason).toMatch(/no observed difficulty/);
    expect(d.alternatives_considered.find((a) => a.model === FABLE)?.rejected_because).toMatch(/Fable requires policy and recorded evidence/);
    const b = d.expected_cost_breakdown!;
    expect(b.execution + b.likely_repairs + b.verification + b.review + b.coordination).toBeCloseTo(d.expected_cost_per_verified_task!, 6);
    expect(b.review).toBeGreaterThan(0);
    expect(b.verification).toBeGreaterThan(0);
  });

  it('routes screenshots to the cheapest eligible vision model and curation to Haiku', () => {
    const { registry } = setup();
    expect(route({ workKind: 'screenshot', signals: signals(), registry, policy: policy() }).model).toBe(HAIKU);
    expect(route({ workKind: 'curation', signals: signals(), registry, policy: policy() }).model).toBe(HAIKU);
    expect(route({ workKind: 'log-classification', signals: signals(), registry, policy: policy() }).model).toBe(HAIKU);
    expect(route({ workKind: 'focused-tests', signals: signals(), registry, policy: policy() }).model).toBe(SONNET);
    expect(route({ workKind: 'architecture', signals: signals(), registry, policy: policy() }).model).toBe(OPUS);
  });

  it('moves up, not down, when the starting tier is not allowed, and fails when nothing is eligible', () => {
    const { registry } = setup();
    const d = route({ workKind: 'extraction', signals: signals(), registry, policy: policy({ allowed: [SONNET, OPUS] }) });
    expect(d.model).toBe(SONNET);
    expect(d.reason).toMatch(/no eligible haiku model; nearest eligible tier is sonnet/);
    expect(code(() => route({ workKind: 'extraction', signals: signals(), registry, policy: policy({ allowed: [] }) }))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('only routes to models validated on the CLI surface', () => {
    const { registry } = setup({ available: [SONNET, OPUS] });
    const d = route({ workKind: 'extraction', signals: signals(), registry, policy: policy() });
    expect(d.model).toBe(SONNET);
    expect(d.alternatives_considered.find((a) => a.model === HAIKU)?.rejected_because).toMatch(/not yet validated/);
  });

  it('calibrates down to a cheaper tier only on measured outcomes', () => {
    const { registry } = setup();
    const n = MIN_MEASURED_SAMPLES + 5;
    const outcomes = [stat('routine-code', HAIKU, n, 0, 0.05), stat('routine-code', SONNET, n - 2, 2, 0.6)];
    const d = route({ workKind: 'routine-code', signals: signals(), registry, policy: policy(), outcomes });
    expect(d.model).toBe(HAIKU);
    expect(d.cost_basis).toBe('measured');
    expect(d.reason).toMatch(/calibrated by measured outcomes/);
    const few = [stat('routine-code', HAIKU, 3, 0, 0.05), stat('routine-code', SONNET, n, 0, 0.6)];
    expect(route({ workKind: 'routine-code', signals: signals(), registry, policy: policy(), outcomes: few }).model).toBe(SONNET);
  });

  it('honours routing.overrides as a starting point and ignores ones it cannot resolve', () => {
    const { registry } = setup();
    const p = policy();
    p.routing.overrides = { 'routine-code': 'opus', extraction: 'not-a-model' };
    expect(route({ workKind: 'routine-code', signals: signals(), registry, policy: p }).model).toBe(OPUS);
    const d = route({ workKind: 'extraction', signals: signals(), registry, policy: p });
    expect(d.model).toBe(HAIKU);
    expect(d.justification.ignored.join(' ')).toMatch(/routing.overrides.extraction=not-a-model/);
  });
});

describe('scenario 14: difficult work escalates only with recorded justification', () => {
  it('ignores worker confidence and requests', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'routine-code',
      signals: signals({ attempt: 2, workerClaims: { confidence: 'low', requestedEscalation: true, requestedModel: OPUS } }),
      registry,
      policy: policy(),
    });
    expect(d.model).toBe(SONNET);
    expect(d.escalated_from).toBeUndefined();
    expect(d.justification.signals).toEqual([]);
    expect(d.justification.ignored[0]).toMatch(/worker claims .* recorded and ignored/);
  });

  it('does not escalate below the repeated-failure threshold or on a failure without evidence', () => {
    const { registry } = setup();
    expect(route({ workKind: 'routine-code', signals: signals({ repeatedFingerprints: 1 }), registry, policy: policy() }).model).toBe(SONNET);
    const noEvidence = route({
      workKind: 'routine-code',
      signals: signals({ attempt: 2, previousRoute: { provider: 'claude', model: SONNET, outcome: 'failed' } }),
      registry,
      policy: policy(),
    });
    expect(noEvidence.model).toBe(SONNET);
  });

  it('escalates repeated equivalent failures one tier and records the signal and evidence', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'routine-code',
      signals: signals({
        attempt: 3,
        repeatedFingerprints: 2,
        evidence: ['failure:fp-7f3a'],
        previousRoute: { provider: 'claude', model: SONNET, effort: 'medium', outcome: 'failed', evidence: ['evidence:report-2'] },
      }),
      registry,
      policy: policy(),
    });
    expect(d.model).toBe(OPUS);
    expect(d.escalated_from).toEqual({ provider: 'claude', model: SONNET, family: 'sonnet' });
    expect(d.justification.signals.map((s) => s.signal)).toEqual(['repeated-equivalent-failures', 'strong-attempt-failed']);
    expect(d.justification.evidence).toEqual(['failure:fp-7f3a', 'evidence:report-2']);
    expect(d.summary).toBe(`route routine-code -> claude/${OPUS} (escalated from ${SONNET})`);
    // Switching models costs a handoff.
    expect(d.expected_cost_breakdown?.coordination).toBeGreaterThan(0);
  });

  it('escalates coupled code changes from the start; a complex classification raises effort only', () => {
    const { registry } = setup();
    const complex = route({ workKind: 'routine-code', signals: signals({ difficulty: 'complex' }), registry, policy: policy() });
    expect(complex.model).toBe(SONNET);
    expect(complex.effort).toBe('high');
    expect(complex.escalated_from).toBeUndefined();
    const both = route({ workKind: 'routine-code', signals: signals({ difficulty: 'complex', coupled: true }), registry, policy: policy() });
    expect(both.model).toBe(OPUS);
    expect(both.effort).toBe('high');
    expect(both.escalated_from?.model).toBe(SONNET);
    expect(both.justification.signals.map((s) => s.signal)).toEqual(['coupled-change']);
    const coupled = route({ workKind: 'focused-tests', signals: signals({ coupled: true }), registry, policy: policy() });
    expect(coupled.model).toBe(OPUS);
    expect(coupled.justification.signals[0]?.signal).toBe('coupled-change');
  });

  it('lets task properties lift the starting point once, never compounding across attempts', () => {
    const { registry } = setup();
    const p = policy({ allowed: [HAIKU, SONNET, OPUS, FABLE] });
    const again = route({
      workKind: 'routine-code',
      signals: signals({ difficulty: 'complex', attempt: 2, previousRoute: { provider: 'claude', model: OPUS, outcome: 'verified' } }),
      registry,
      policy: p,
    });
    expect(again.model).toBe(OPUS);
    expect(again.escalated_from).toBeUndefined();
    expect(again.effort).toBe('high');
    const ambiguous = route({
      workKind: 'extraction',
      signals: signals({ ambiguity: true, attempt: 2, previousRoute: { provider: 'claude', model: SONNET, outcome: 'failed' } }),
      registry,
      policy: p,
    });
    expect(ambiguous.model).toBe(SONNET);
  });

  it('escalates extraction on ambiguity or security-sensitive interpretation', () => {
    const { registry } = setup();
    expect(route({ workKind: 'extraction', signals: signals({ ambiguity: true }), registry, policy: policy() }).model).toBe(SONNET);
    const sec = route({ workKind: 'log-classification', signals: signals({ criticalSecurity: true }), registry, policy: policy() });
    expect(sec.model).toBe(SONNET);
    expect(sec.justification.signals[0]?.signal).toBe('security-sensitive-interpretation');
  });

  it('raises effort, not tier, for security-critical code', () => {
    const { registry } = setup();
    const d = route({ workKind: 'routine-code', signals: signals({ criticalSecurity: true }), registry, policy: policy() });
    expect(d.model).toBe(SONNET);
    expect(d.effort).toBe('high');
  });

  it('keeps architecture on Opus when Fable is not in policy, raising effort instead', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'complex-diagnosis',
      signals: signals({ difficulty: 'complex', attempt: 2, evidence: ['failure:fp-1'], previousRoute: { provider: 'claude', model: OPUS, outcome: 'failed' } }),
      registry,
      policy: policy(),
    });
    expect(d.model).toBe(OPUS);
    expect(d.escalated_from).toBeUndefined();
    expect(d.effort).toBe('xhigh');
    expect(d.reason).toMatch(/Fable not chosen: claude-fable-5-1 is ineligible \(not in routing.allowed_models\)/);
    expect(d.justification.signals[0]?.signal).toBe('strong-attempt-failed');
  });

  it('uses Fable only when allowed AND a strong attempt failed with recorded evidence', () => {
    const { registry } = setup();
    const p = policy({ allowed: [HAIKU, SONNET, OPUS, FABLE] });
    const first = route({ workKind: 'architecture', signals: signals({ difficulty: 'complex' }), registry, policy: p });
    expect(first.model).toBe(OPUS);
    const unproven = route({
      workKind: 'architecture',
      signals: signals({ difficulty: 'complex', attempt: 2, previousRoute: { provider: 'claude', model: OPUS, outcome: 'failed' } }),
      registry,
      policy: p,
    });
    expect(unproven.model).toBe(OPUS);
    const proven = route({
      workKind: 'architecture',
      signals: signals({ difficulty: 'complex', attempt: 2, previousRoute: { provider: 'claude', model: OPUS, outcome: 'failed', evidence: ['experiment:h-3'] } }),
      registry,
      policy: p,
    });
    expect(proven.model).toBe(FABLE);
    expect(proven.escalated_from).toEqual({ provider: 'claude', model: OPUS, family: 'opus' });
    expect(proven.reason).toMatch(/Fable justified: an opus-class attempt on claude-opus-5-5 failed with recorded evidence \(experiment:h-3\)/);
  });

  it('never lets a wildcard allow Fable even with evidence', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'architecture',
      signals: signals({ attempt: 2, previousRoute: { provider: 'claude', model: OPUS, outcome: 'failed', evidence: ['e1'] } }),
      registry,
      policy: policy({ allowed: ['claude:*'] }),
    });
    expect(d.model).toBe(OPUS);
    expect(d.reason).toMatch(/explicit routing.allowed_models entry/);
  });

  it('starts long-horizon work on Opus unless an evaluation or measured outcomes justify Fable', () => {
    const { registry } = setup();
    const p = policy({ allowed: [HAIKU, SONNET, OPUS, FABLE] });
    const unjustified = route({ workKind: 'long-horizon', signals: signals({ difficulty: 'complex' }), registry, policy: p });
    expect(unjustified.model).toBe(OPUS);
    expect(unjustified.reason).toMatch(/no recorded evidence justifies the added expense/);

    const n = MIN_MEASURED_SAMPLES + 1;
    const measured = route({
      workKind: 'long-horizon',
      signals: signals({ difficulty: 'complex' }),
      registry,
      policy: p,
      outcomes: [stat('long-horizon', FABLE, n, 0, 3), stat('long-horizon', OPUS, 2, n - 2, 2)],
    });
    expect(measured.model).toBe(FABLE);
    expect(measured.reason).toMatch(/measured outcomes give claude-fable-5-1/);

    registry.recordEvaluation(FABLE, { justifiedWorkKinds: ['long-horizon'] });
    const evaluated = route({ workKind: 'long-horizon', signals: signals({ difficulty: 'complex' }), registry, policy: p });
    expect(evaluated.model).toBe(FABLE);
    expect(evaluated.reason).toMatch(/recorded evaluation justifies/);
  });

  it('escalates screenshots on visual complexity or measured low accuracy', () => {
    const { registry } = setup();
    expect(route({ workKind: 'screenshot', signals: signals({ visualComplexity: 'high' }), registry, policy: policy() }).model).toBe(SONNET);
    const n = MIN_MEASURED_SAMPLES + 1;
    const d = route({ workKind: 'screenshot', signals: signals(), registry, policy: policy(), outcomes: [stat('screenshot', HAIKU, 2, n - 2, 0.01)] });
    expect(d.model).toBe(SONNET);
    expect(d.escalated_from?.model).toBe(HAIKU);
    expect(d.justification.signals[0]?.signal).toBe('measured-accuracy');
    expect(d.alternatives_considered.find((a) => a.model === HAIKU)?.rejected_because).toMatch(/accuracy below the floor/);
  });
});

describe('down-routing after a solved diagnosis', () => {
  it('routes routine follow-up back down once the diagnosis is solved', () => {
    const { registry } = setup();
    const prev = { provider: 'claude', model: OPUS, outcome: 'verified' as const };
    const down = route({ workKind: 'routine-code', signals: signals({ attempt: 4, previousRoute: prev, diagnosisSolved: true }), registry, policy: policy() });
    expect(down.model).toBe(SONNET);
    expect(down.down_routed_from).toEqual({ provider: 'claude', model: OPUS, family: 'opus' });
    expect(down.summary).toMatch(/down from claude-opus-5-5/);
    const sticky = route({ workKind: 'routine-code', signals: signals({ attempt: 4, previousRoute: prev }), registry, policy: policy() });
    expect(sticky.model).toBe(OPUS);
    expect(sticky.reason).toMatch(/no solved diagnosis is recorded/);
  });

  it('down-routes routine follow-up of a coupled task, recording the superseded task property', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'routine-code',
      signals: signals({ difficulty: 'complex', coupled: true, attempt: 3, diagnosisSolved: true, previousRoute: { provider: 'claude', model: OPUS, outcome: 'verified' } }),
      registry,
      policy: policy(),
    });
    expect(d.model).toBe(SONNET);
    expect(d.down_routed_from?.model).toBe(OPUS);
    expect(d.justification.signals).toEqual([]);
    expect(d.justification.ignored).toContain('coupled-change superseded by the solved diagnosis');
  });

  it('does not down-route when equivalent failures repeat after the diagnosis', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'routine-code',
      signals: signals({ attempt: 5, diagnosisSolved: true, repeatedFingerprints: 3, previousRoute: { provider: 'claude', model: OPUS, outcome: 'failed' } }),
      registry,
      policy: policy(),
    });
    expect(d.model).toBe(OPUS);
    expect(d.down_routed_from).toBeUndefined();
  });

  it('never down-routes non-routine work such as architecture', () => {
    const { registry } = setup();
    const d = route({
      workKind: 'architecture',
      signals: signals({ diagnosisSolved: true, previousRoute: { provider: 'claude', model: OPUS, outcome: 'verified' } }),
      registry,
      policy: policy(),
    });
    expect(d.model).toBe(OPUS);
  });
});

describe('safety review routing', () => {
  it('prefers a qualified other-provider reviewer at high effort', () => {
    const { registry } = setup();
    const d = route({ workKind: 'safety-review', signals: signals(), registry, policy: policy() });
    expect(d.provider).toBe('codex');
    expect(d.model).toBe('codex-alpha');
    expect(d.surface).toBe('codex-cli');
    expect(d.effort).toBe('high');
    expect(d.expected_cost_per_verified_task).toBeNull();
    expect(d.cost_basis).toBe('unavailable');
    expect(d.reason).toMatch(/codex's recommended model/);
    const haiku = d.alternatives_considered.find((a) => a.model === HAIKU)!;
    expect(haiku.rejected_because).toMatch(/below the safety review quality floor/);
    expect(d.alternatives_considered.find((a) => a.model === 'codex-beta')?.rejected_because).toMatch(/not qualified for safety review/);
  });

  it('raises effort for critical security but never to the subagent effort', () => {
    const { registry } = setup();
    const d = route({ workKind: 'safety-review', signals: signals({ criticalSecurity: true }), registry, policy: policy() });
    expect(d.effort).toBe('xhigh');
  });

  it('uses the configured codex model, or one qualified by a recorded evaluation', () => {
    const { registry } = setup();
    const configured = policy({ providers: { codex: { model: 'codex-beta', data_policy_eligible: true, reasoning_effort: null } } });
    expect(route({ workKind: 'safety-review', signals: signals(), registry, policy: configured }).model).toBe('codex-beta');
    registry.recordEvaluation('codex-beta', { qualifiedFor: ['safety-review'] });
    const d = route({ workKind: 'safety-review', signals: signals(), registry, policy: policy() });
    expect(d.model).toBe('codex-beta');
    expect(d.reason).toMatch(/recorded safety-review evaluation/);
  });

  it('blocks rather than substituting when an independent reviewer is required but unavailable', () => {
    const { registry } = setup();
    const noData = policy({ providers: { codex: { model: null, data_policy_eligible: false, reasoning_effort: null } } });
    let err: unknown;
    try {
      route({ workKind: 'safety-review', signals: signals(), registry, policy: noData });
    } catch (e) {
      err = e;
    }
    expect(isOrbitError(err, 'PROVIDER_UNAVAILABLE')).toBe(true);
    const alts = (err as { details: { alternatives_considered: { model: string; rejected_because: string }[] } }).details.alternatives_considered;
    expect(alts.find((a) => a.model === 'codex-alpha')?.rejected_because).toMatch(/data_policy_eligible/);
    const noCodex = setup({ codex: false }).registry;
    expect(code(() => route({ workKind: 'safety-review', signals: signals(), registry: noCodex, policy: policy() }))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('falls back to same-provider review only at the opus-class floor when policy allows', () => {
    const { registry } = setup({ codex: false });
    const p = policy({ review: { independent_provider_required: true, preferred_provider: 'codex', fallback_same_provider_allowed: true } });
    p.routing.overrides = { 'safety-review': 'haiku' };
    const d = route({ workKind: 'safety-review', signals: signals(), registry, policy: p });
    expect(d.model).toBe(OPUS);
    expect(d.reason).toMatch(/policy allows same-provider review at the opus-class floor/);
    expect(d.justification.ignored.join(' ')).toMatch(/routing.overrides.safety-review=haiku is not a qualified reviewer/);
    expect(d.alternatives_considered.find((a) => a.model === SONNET)?.rejected_because).toMatch(/below the safety review quality floor/);
    // No Opus-class model eligible: block, never drop to Sonnet.
    const onlyCheap = policy({ allowed: [HAIKU, SONNET], review: p.review });
    expect(code(() => route({ workKind: 'safety-review', signals: signals(), registry, policy: onlyCheap }))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('with the starter policy, routes review to codex only once the user configures and attests it', () => {
    const { registry } = setup();
    const starter = policy({ allowed: ['opus', 'sonnet', 'haiku'], providers: { claude: { model: null, data_policy_eligible: true }, codex: { model: null, data_policy_eligible: false } } });
    expect(route({ workKind: 'routine-code', signals: signals(), registry, policy: starter }).model).toBe(SONNET);
    expect(code(() => route({ workKind: 'safety-review', signals: signals(), registry, policy: starter }))).toBe('PROVIDER_UNAVAILABLE');
    starter.providers.codex = { model: 'codex-beta', data_policy_eligible: true };
    const d = route({ workKind: 'safety-review', signals: signals(), registry, policy: starter });
    expect(d.model).toBe('codex-beta');
    expect(d.reason).toMatch(/providers.codex.model names it/);
  });

  it('treats Claude as the independent reviewer of codex-produced work', () => {
    const { registry } = setup();
    const d = route({ workKind: 'safety-review', signals: signals({ implementerProvider: 'codex' }), registry, policy: policy() });
    expect(d.provider).toBe('claude');
    expect(d.model).toBe(OPUS);
  });

  it('still prefers the preferred provider when independence is not required', () => {
    const { registry } = setup();
    const p = policy({ review: { independent_provider_required: false, preferred_provider: 'codex', fallback_same_provider_allowed: false } });
    expect(route({ workKind: 'safety-review', signals: signals(), registry, policy: p }).provider).toBe('codex');
  });
});

describe('route decision shape and validation', () => {
  it('is a JSON-ready decision record', () => {
    const { registry } = setup();
    const d = route({ workKind: 'routine-code', signals: signals(), registry, policy: policy() });
    expect(JSON.parse(JSON.stringify(d))).toEqual(d);
    const rec = toDecisionRecord(d);
    expect(rec.kind).toBe('route');
    expect(rec.summary).toBe(`route routine-code -> claude/${SONNET}`);
    expect(rec.data).toBe(d);
    expect(d.success_probability).toBeGreaterThan(0);
    expect(d.attempt).toBe(1);
    expect(d.difficulty).toBe('simple');
  });

  it('rejects malformed requests', () => {
    const { registry } = setup();
    expect(code(() => route({ workKind: 'poetry' as WorkKind, signals: signals(), registry, policy: policy() }))).toBe('SCHEMA_INVALID');
    expect(code(() => route({ workKind: 'extraction', signals: signals({ attempt: 0 }), registry, policy: policy() }))).toBe('SCHEMA_INVALID');
    expect(code(() => route({ workKind: 'extraction', signals: signals({ repeatedFingerprints: -1 }), registry, policy: policy() }))).toBe('SCHEMA_INVALID');
    expect(code(() => route({ workKind: 'extraction', signals: signals({ difficulty: 'easy' as never }), registry, policy: policy() }))).toBe('SCHEMA_INVALID');
  });

  it('is deterministic for identical inputs', () => {
    const { registry } = setup();
    const req = { workKind: 'routine-code' as const, signals: signals({ repeatedFingerprints: 2, evidence: ['f1'] }), registry, policy: policy() };
    expect(route(req)).toEqual(route(req));
  });
});
