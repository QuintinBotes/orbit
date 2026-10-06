import { describe, expect, it } from 'vitest';
import { assertReviewerSelected, selectReviewer, selectionDecisionRecord, type ReviewerRegistry, type ReviewerSelection } from '../../../src/review/select.ts';
import type { ModelEntry } from '../../../src/routing/types.ts';
import { FABLE, OPUS, SONNET, setup } from '../routing/fixtures.ts';
import { cap, cred, snapshotOf } from './fixtures.ts';

const ready = () => ({ capabilities: { claude: cap('claude'), codex: cap('codex') }, credentials: { claude: cred('valid'), codex: cred('valid') } });
const blocked = (s: ReviewerSelection) => {
  if (s.decision !== 'BLOCK') throw new Error(`expected BLOCK, got ${s.provider}`);
  return s;
};

/** A registry entry with only what selection reads. */
function entry(modelId: string, provider: string, family: string | null, over: { qualified?: string[]; providerDefault?: boolean } = {}): ModelEntry {
  return {
    modelId,
    provider,
    family,
    eligibility: { aliases: [], cliAlias: null, providerDefault: over.providerDefault ?? false },
    evaluation: { observedCost: null, qualifiedFor: over.qualified ?? [], justifiedWorkKinds: [] },
  } as unknown as ModelEntry;
}

/** A registry that answers with the given eligible entries for every question. */
function registryOf(eligible: ModelEntry[], excluded: { model: ModelEntry; reasons: string[] }[] = []): ReviewerRegistry {
  return {
    assess: () => ({ eligible, excluded }),
    get: (id) => eligible.find((e) => e.modelId === id) ?? excluded.find((x) => x.model.modelId === id)?.model ?? null,
  };
}

describe('selectionDecisionRecord', () => {
  it('summarizes a same-provider selection with the provider default model, and an independent one with its model', () => {
    const base = { decision: 'SELECT' as const, provider: 'claude', effort: null, basis: 'tier' as const, substitutedForPreferred: false, readOnlySandbox: true, reason: 'r', alternatives: [] };
    // Decision 0007: a same-provider selection never reads as independent, and says why.
    expect(selectionDecisionRecord({ ...base, model: null, independent: false }).summary).toBe('reviewer claude/default (same provider, not independent: no independent reviewer was usable)');
    expect(selectionDecisionRecord({ ...base, model: null, independent: false, independentUnavailable: 'no independent reviewer was usable: codex is down' }).summary).toBe('reviewer claude/default (same provider, not independent: no independent reviewer was usable: codex is down)');
    expect(selectionDecisionRecord({ ...base, provider: 'codex', model: 'codex-alpha', independent: true }).summary).toBe('reviewer codex/codex-alpha (independent)');
  });

  it('cuts the summary of a long refusal at 300 characters and keeps the whole selection as data', () => {
    const sel: ReviewerSelection = { decision: 'BLOCK', code: 'PROVIDER_UNAVAILABLE', reason: 'x'.repeat(500), alternatives: [] };
    const rec = selectionDecisionRecord(sel);
    expect(rec.summary).toHaveLength(300);
    expect(rec.data).toBe(sel);
  });

  it('assertReviewerSelected hands back a selection and throws a refusal with its alternatives', () => {
    const sel = selectReviewer({ snapshot: snapshotOf(), ...ready(), implementer: { provider: 'claude', model: SONNET } });
    expect(assertReviewerSelected(sel)).toBe(sel);
    const r = ready();
    r.credentials.codex = cred('expired', 'token expired');
    const refusal = selectReviewer({ snapshot: snapshotOf((c) => void (c.review.when_unavailable = 'block')), ...r, implementer: { provider: 'claude', model: SONNET } });
    expect(() => assertReviewerSelected(refusal)).toThrow(expect.objectContaining({ code: 'AUTH_EXPIRED', details: { alternatives: expect.arrayContaining([expect.objectContaining({ provider: 'codex' })]) } }));
  });
});

describe('why a provider cannot review', () => {
  const impl = { provider: 'claude', model: SONNET };

  it('uses a stock reason when the adapter gives no detail, and when credentials were never validated', () => {
    const r = ready();
    r.capabilities.codex = cap('codex', { available: false, detail: '' });
    expect(blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: impl })).reason).toContain('provider "codex" is not available: adapter reported unavailable');
    const r2 = ready();
    delete (r2.credentials as Record<string, unknown>).codex;
    expect(blocked(selectReviewer({ snapshot: snapshotOf(), ...r2, implementer: impl })).reason).toContain('credentials for "codex" were not validated');
  });

  it('leaves the credential detail out when there is none', () => {
    for (const [state, text] of [['invalid', 'credentials for "codex" are invalid'], ['missing', 'no credentials for "codex"'], ['unknown', 'credentials for "codex" could not be validated (unknown)']] as const) {
      const r = ready();
      r.credentials.codex = cred(state, '');
      const reason = blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: impl })).alternatives.find((a) => a.provider === 'codex')!.reason;
      expect(reason).toBe(text);
    }
  });

  it('includes the credential detail when there is one', () => {
    for (const [state, text] of [['invalid', 'credentials for "codex" are invalid (token revoked)'], ['missing', 'no credentials for "codex" (run login)'], ['unknown', 'credentials for "codex" could not be validated (unknown): probe timed out']] as const) {
      const r = ready();
      r.credentials.codex = cred(state, state === 'invalid' ? 'token revoked' : state === 'missing' ? 'run login' : 'probe timed out');
      expect(blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: impl })).alternatives.find((a) => a.provider === 'codex')!.reason).toBe(text);
    }
  });

  it('names an unselected preferred provider as "not selected" when it is not unusable on its own', () => {
    // codex is preferred and usable but has no qualified model, so another independent provider is chosen.
    const snap = snapshotOf((c) => {
      c.providers.codex!.model = null;
      c.providers.gemini = { command: 'gemini', data_policy_eligible: true, model: 'gem-1', reasoning_effort: null, extra_args: [] };
      // Decision 0007: only providers listed in review.providers are asked, in that order.
      c.review.providers = ['codex', 'gemini'];
    });
    const r = ready();
    const sel = selectReviewer({ snapshot: snap, capabilities: { ...r.capabilities, gemini: cap('gemini') }, credentials: { ...r.credentials, gemini: cred('valid') }, implementer: { provider: 'claude', model: SONNET } });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'gemini', substitutedForPreferred: true });
    if (sel.decision === 'SELECT') expect(sel.reason).toContain('preferred provider "codex" is unusable (not selected)');
  });
});

describe('qualifying a model of an independent provider', () => {
  const codexImpl = { provider: 'codex', model: 'codex-alpha' };
  const claudeFirst = (c: import('../../../src/policy/types.ts').OrbitConfig) => {
    c.review.preferred_provider = 'claude';
    c.providers.claude = { ...c.providers.claude!, data_policy_eligible: true, model: null };
    c.providers.codex!.model = null;
  };

  it('a claude reviewer qualifies by tier, from the allowed models only', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      claudeFirst(c);
      c.routing.allowed_models = [SONNET, OPUS];
    });
    const sel = selectReviewer({ snapshot: snap, ...ready(), implementer: codexImpl, registry });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', model: OPUS, basis: 'tier', independent: true });
  });

  it('skips a claude model whose family has no tier when looking for an opus-class reviewer', () => {
    const snap = snapshotOf((c) => {
      claudeFirst(c);
      c.routing.allowed_models = ['claude-mystery', OPUS];
    });
    const registry = registryOf([entry('claude-mystery', 'claude', 'mystery'), entry(OPUS, 'claude', 'opus')]);
    expect(selectReviewer({ snapshot: snap, ...ready(), implementer: codexImpl, registry })).toMatchObject({ provider: 'claude', model: OPUS });
  });

  it('refuses a claude reviewer below the opus floor, and says that none is opus-class', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      claudeFirst(c);
      c.routing.allowed_models = [SONNET];
    });
    const sel = blocked(selectReviewer({ snapshot: snap, ...ready(), implementer: codexImpl, registry }));
    expect(sel.alternatives.some((a) => a.provider === 'claude' && /none is opus-class or above/.test(a.reason))).toBe(true);
    expect(sel.reason).toContain('"claude" has no model qualified for review');
  });

  it('a claude reviewer whose only opus-class model is not offered by the adapter is not used', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      claudeFirst(c);
      c.routing.allowed_models = [SONNET, OPUS, FABLE];
    });
    const r = ready();
    r.capabilities.claude = cap('claude', { models: [SONNET, FABLE] });
    expect(selectReviewer({ snapshot: snap, ...r, implementer: codexImpl, registry })).toMatchObject({ provider: 'claude', model: FABLE });
  });

  it('a codex model qualifies through a recorded safety-review evaluation before the provider default', () => {
    const snap = snapshotOf((c) => void (c.providers.codex!.model = null));
    const registry = registryOf([entry('codex-default', 'codex', null, { providerDefault: true }), entry('codex-vetted', 'codex', null, { qualified: ['safety-review'] })]);
    const sel = selectReviewer({ snapshot: snap, ...ready(), implementer: { provider: 'claude', model: SONNET }, registry });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'codex', model: 'codex-vetted', basis: 'evaluation' });
  });

  it('a codex model qualifies as the provider default when nothing was evaluated, and not at all when neither holds', () => {
    const snap = snapshotOf((c) => void (c.providers.codex!.model = null));
    const impl = { provider: 'claude', model: SONNET };
    expect(selectReviewer({ snapshot: snap, ...ready(), implementer: impl, registry: registryOf([entry('codex-default', 'codex', null, { providerDefault: true })]) })).toMatchObject({ provider: 'codex', model: 'codex-default', basis: 'provider-default' });
    const none = blocked(selectReviewer({ snapshot: snap, ...ready(), implementer: impl, registry: registryOf([entry('codex-plain', 'codex', null)]) }));
    expect(none.alternatives.some((a) => a.provider === 'codex' && a.reason.includes('no model of "codex" is qualified for review') && !a.reason.includes('opus-class'))).toBe(true);
  });
});

describe('same-provider review: the corners', () => {
  const allowSame = (c: import('../../../src/policy/types.ts').OrbitConfig) => {
    c.review.fallback_same_provider_allowed = true;
  };
  const noIndependent = () => ({ capabilities: { claude: cap('claude') }, credentials: { claude: cred('valid') } });

  it('has no tiers for a provider that is neither claude nor codex, even when the model is known', () => {
    const snap = snapshotOf((c) => {
      allowSame(c);
      c.providers.gemini = { command: 'gemini', data_policy_eligible: true, model: null, reasoning_effort: null, extra_args: [] };
    });
    const { registry } = setup();
    const sel = blocked(
      selectReviewer({ snapshot: snap, capabilities: { gemini: cap('gemini') }, credentials: { gemini: cred('valid') }, implementer: { provider: 'gemini', model: OPUS }, registry }),
    );
    expect(sel.reason).toContain('"gemini" has no tiered models, so a same-provider review at the quality floor is not defined');
  });

  it('skips models without a tier or that the adapter does not offer, and says when nothing is left', () => {
    const snap = snapshotOf(allowSame);
    const registry = registryOf([entry(SONNET, 'claude', 'sonnet'), entry('claude-mystery', 'claude', 'mystery'), entry(FABLE, 'claude', 'fable')]);
    const r = noIndependent();
    r.capabilities.claude = cap('claude', { models: [SONNET, 'claude-mystery'] });
    const sel = blocked(selectReviewer({ snapshot: snap, ...r, implementer: { provider: 'claude', model: SONNET }, registry }));
    // Decision 0007: the fallback needs a model at the floor; a different tier is preferred, not required.
    expect(sel.reason).toContain('no allowed claude model is at or above the opus-class floor');
    // Fable is not offered and the mystery model has no tier: neither is listed as a rejected tier.
    expect(sel.alternatives.map((a) => a.model)).not.toContain(FABLE);
    expect(sel.alternatives.map((a) => a.model)).not.toContain('claude-mystery');
  });

  it('names the implementer model, not a family, when the registry entry has no family', () => {
    const snap = snapshotOf(allowSame);
    const known = entry('claude-nofamily', 'claude', null);
    const registry: ReviewerRegistry = { assess: () => ({ eligible: [entry(OPUS, 'claude', 'opus')], excluded: [] }), get: (id) => (id === 'claude-nofamily' ? ({ ...known, family: 'sonnet' } as ModelEntry) : null) };
    const sel = selectReviewer({ snapshot: snap, ...noIndependent(), implementer: { provider: 'claude', model: 'claude-nofamily' }, registry });
    expect(sel).toMatchObject({ decision: 'SELECT', model: OPUS });
    if (sel.decision === 'SELECT') expect(sel.reason).toContain("a different tier than the implementer's sonnet");
  });

  it('records models the registry excluded, with their reasons', () => {
    const snap = snapshotOf(allowSame);
    const excludedModel = entry('claude-opus-old', 'claude', 'opus');
    const registry = registryOf([entry(OPUS, 'claude', 'opus')], [{ model: excludedModel, reasons: ['not validated on the CLI', 'not allowed'] }, { model: entry('codex-x', 'codex', null), reasons: ['other provider'] }]);
    // Decision 0007: the opus implementer is reviewed by opus in a separate session; the exclusions are still recorded.
    const sel = selectReviewer({ snapshot: snap, ...noIndependent(), implementer: { provider: 'claude', model: OPUS }, registry });
    expect(sel.decision).toBe('SELECT');
    expect(sel.alternatives).toContainEqual({ provider: 'claude', model: 'claude-opus-old', reason: 'ineligible: not validated on the CLI; not allowed' });
    expect(sel.alternatives.some((a) => a.model === 'codex-x')).toBe(false);
  });
});
