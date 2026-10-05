import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { assertReviewerSelected, selectReviewer, selectionDecisionRecord, type ReviewerSelection } from '../../../src/review/select.ts';
import { FABLE, HAIKU, OPUS, SONNET, setup } from '../routing/fixtures.ts';
import { cap, cred, snapshotOf } from './fixtures.ts';

const IMPL = { provider: 'claude', model: SONNET };

function ready() {
  return {
    capabilities: { claude: cap('claude'), codex: cap('codex') },
    credentials: { claude: cred('valid'), codex: cred('valid') },
  };
}

function blocked(sel: ReviewerSelection) {
  if (sel.decision !== 'BLOCK') throw new Error(`expected BLOCK, got SELECT ${sel.provider}`);
  return sel;
}

describe('selectReviewer: the independent provider is available', () => {
  it('selects the configured model of the preferred independent provider', () => {
    const sel = selectReviewer({ snapshot: snapshotOf(), ...ready(), implementer: IMPL });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'codex', model: 'codex-alpha', independent: true, basis: 'configured', substitutedForPreferred: false, readOnlySandbox: true });
  });

  it('qualifies a codex model from the registry when none is configured (provider default)', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.providers.codex!.model = null;
    });
    const sel = selectReviewer({ snapshot: snap, ...ready(), implementer: IMPL, registry });
    expect(sel.decision).toBe('SELECT');
    if (sel.decision === 'SELECT') {
      expect(sel.provider).toBe('codex');
      expect(['provider-default', 'evaluation']).toContain(sel.basis);
      expect(sel.model).toMatch(/^codex-/);
    }
  });

  it('carries the configured reasoning effort', () => {
    const snap = snapshotOf((c) => {
      c.providers.codex!.reasoning_effort = 'high';
    });
    expect(selectReviewer({ snapshot: snap, ...ready(), implementer: IMPL })).toMatchObject({ effort: 'high' });
  });

  it('rejects a configured model the adapter does not offer', () => {
    const r = ready();
    r.capabilities.codex = cap('codex', { models: ['codex-beta'] });
    const sel = blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: IMPL }));
    expect(sel.reason).toMatch(/no model of|no independent reviewer/);
    expect(sel.alternatives.some((a) => /not offered by the adapter/.test(a.reason))).toBe(true);
  });
});

describe('selectReviewer: a mandatory independent reviewer is unusable (spec scenario: BLOCK with the exact reason)', () => {
  it('blocks on expired credentials and does not substitute the implementer provider', () => {
    const r = ready();
    r.credentials.codex = cred('expired', 'token expired yesterday');
    const sel = blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: IMPL }));
    expect(sel.code).toBe('AUTH_EXPIRED');
    expect(sel.reason).toContain('credentials for "codex" are expired (token expired yesterday)');
    expect(sel.reason).toContain('independent review is required');
    expect(sel.reason).toContain('not being substituted');
    expect(sel.alternatives).toContainEqual({ provider: 'codex', model: null, reason: expect.stringContaining('expired') });
  });

  it.each([
    ['missing', 'AUTH_MISSING', /no credentials for "codex"/],
    ['invalid', 'AUTH_EXPIRED', /credentials for "codex" are invalid/],
    ['unknown', 'PROVIDER_UNAVAILABLE', /could not be validated \(unknown\)/],
  ] as const)('credential state %s maps to %s', (state, code, text) => {
    const r = ready();
    r.credentials.codex = cred(state);
    const sel = blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: IMPL }));
    expect(sel.code).toBe(code);
    expect(sel.reason).toMatch(text);
  });

  it('blocks when the adapter reports the provider unavailable', () => {
    const r = ready();
    r.capabilities.codex = cap('codex', { available: false, detail: 'codex binary not found' });
    const sel = blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: IMPL }));
    expect(sel.code).toBe('PROVIDER_UNAVAILABLE');
    expect(sel.reason).toContain('codex binary not found');
  });

  it('blocks when no capabilities were reported for the provider at all', () => {
    const sel = blocked(selectReviewer({ snapshot: snapshotOf(), capabilities: { claude: cap('claude') }, credentials: { claude: cred('valid') }, implementer: IMPL }));
    expect(sel.reason).toContain('no adapter capabilities were reported for "codex"');
  });

  it('blocks when the provider cannot return structured output', () => {
    const r = ready();
    r.capabilities.codex = cap('codex', { structuredOutput: false });
    expect(blocked(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: IMPL })).reason).toContain('schema-constrained output');
  });

  it('blocks when the provider is not attested for data handling', () => {
    const snap = snapshotOf((c) => {
      c.providers.codex!.data_policy_eligible = false;
    });
    const sel = blocked(selectReviewer({ snapshot: snap, ...ready(), implementer: IMPL }));
    expect(sel.code).toBe('POLICY_DENIED');
    expect(sel.reason).toContain('providers.codex.data_policy_eligible');
  });

  it('blocks when the only configured provider is the implementer itself', () => {
    const snap = snapshotOf((c) => {
      delete c.providers.codex;
      c.review.preferred_provider = 'claude';
    });
    const sel = blocked(selectReviewer({ snapshot: snap, capabilities: { claude: cap('claude') }, credentials: { claude: cred('valid') }, implementer: IMPL }));
    expect(sel.reason).toContain('no provider other than "claude" is configured');
  });

  it('blocks with a record that serializes for the decision log', () => {
    const r = ready();
    r.credentials.codex = cred('expired');
    const sel = selectReviewer({ snapshot: snapshotOf(), ...r, implementer: IMPL });
    const rec = selectionDecisionRecord(sel);
    expect(rec.kind).toBe('review.select');
    expect(rec.summary).toMatch(/^review blocked: independent review is required/);
    expect(() => JSON.stringify(rec)).not.toThrow();
  });

  it('assertReviewerSelected throws the BLOCK code', () => {
    const r = ready();
    r.credentials.codex = cred('missing');
    try {
      assertReviewerSelected(selectReviewer({ snapshot: snapshotOf(), ...r, implementer: IMPL }));
      expect.unreachable();
    } catch (err) {
      expect(isOrbitError(err, 'AUTH_MISSING')).toBe(true);
    }
  });
});

describe('selectReviewer: other independent providers', () => {
  function withGemini() {
    const r = ready();
    return {
      snapshot: snapshotOf((c) => {
        c.providers.gemini = { command: 'gemini', data_policy_eligible: true, model: 'gem-1', reasoning_effort: null, extra_args: [] };
      }),
      capabilities: { ...r.capabilities, gemini: cap('gemini') },
      credentials: { ...r.credentials, gemini: cred('valid') },
    };
  }

  it('uses another independent provider when the preferred one is unusable, and says so', () => {
    const f = withGemini();
    f.credentials.codex = cred('expired');
    const sel = selectReviewer({ ...f, implementer: IMPL });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'gemini', model: 'gem-1', independent: true, substitutedForPreferred: true });
    if (sel.decision === 'SELECT') expect(sel.reason).toContain('preferred provider "codex" is unusable');
  });

  it('prefers preferred_provider when several are usable', () => {
    expect(selectReviewer({ ...withGemini(), implementer: IMPL })).toMatchObject({ provider: 'codex', substitutedForPreferred: false });
  });
});

describe('selectReviewer: same-provider review', () => {
  const expired = () => {
    const r = ready();
    r.credentials.codex = cred('expired');
    return r;
  };

  it('is not allowed while an independent reviewer is required and fallback is off', () => {
    const { registry } = setup();
    expect(blocked(selectReviewer({ snapshot: snapshotOf(), ...expired(), implementer: IMPL, registry })).code).toBe('AUTH_EXPIRED');
  });

  it('uses a different tier at or above the floor when policy allows the fallback', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.review.fallback_same_provider_allowed = true;
    });
    const sel = selectReviewer({ snapshot: snap, ...expired(), implementer: IMPL, registry });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', model: OPUS, independent: false, basis: 'tier' });
    if (sel.decision === 'SELECT') expect(sel.reason).toContain('different tier');
  });

  it('is allowed without a fallback flag when independent review is not required', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.review.independent_provider_required = false;
    });
    expect(selectReviewer({ snapshot: snap, ...expired(), implementer: IMPL, registry })).toMatchObject({ decision: 'SELECT', provider: 'claude', independent: false });
  });

  it('never picks the implementer tier: an opus implementer cannot be reviewed by opus', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.review.fallback_same_provider_allowed = true;
    });
    const sel = blocked(selectReviewer({ snapshot: snap, ...expired(), implementer: { provider: 'claude', model: OPUS }, registry }));
    expect(sel.reason).toMatch(/no allowed claude model is at or above the opus-class floor and in a different tier/);
    expect(sel.alternatives.some((a) => a.model === OPUS && /same tier/.test(a.reason))).toBe(true);
  });

  it('may use fable only when policy lists it explicitly', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.review.fallback_same_provider_allowed = true;
      c.routing.allowed_models = [HAIKU, SONNET, OPUS, FABLE];
    });
    expect(selectReviewer({ snapshot: snap, ...expired(), implementer: { provider: 'claude', model: OPUS }, registry })).toMatchObject({ decision: 'SELECT', model: FABLE });
  });

  it('never goes below the floor: a sonnet-only allowlist yields BLOCK for a haiku implementer', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.review.fallback_same_provider_allowed = true;
      c.routing.allowed_models = [HAIKU, SONNET];
    });
    const sel = blocked(selectReviewer({ snapshot: snap, ...expired(), implementer: { provider: 'claude', model: HAIKU }, registry }));
    expect(sel.alternatives.some((a) => a.model === SONNET && /below the review quality floor/.test(a.reason))).toBe(true);
  });

  it('blocks when the implementer model tier is unknown, since a difference cannot be shown', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.review.fallback_same_provider_allowed = true;
    });
    expect(blocked(selectReviewer({ snapshot: snap, ...expired(), implementer: { provider: 'claude', model: null }, registry })).reason).toContain('tier is unknown');
  });

  it('blocks without a registry', () => {
    const snap = snapshotOf((c) => {
      c.review.fallback_same_provider_allowed = true;
    });
    expect(blocked(selectReviewer({ snapshot: snap, ...expired(), implementer: IMPL })).reason).toContain('no model registry');
  });

  it('blocks when the implementer provider itself cannot review', () => {
    const { registry } = setup();
    const snap = snapshotOf((c) => {
      c.review.fallback_same_provider_allowed = true;
    });
    const r = expired();
    r.credentials.claude = cred('expired', 'login expired');
    const sel = blocked(selectReviewer({ snapshot: snap, ...r, implementer: IMPL, registry }));
    expect(sel.reason).toContain('"claude" cannot review');
  });
});
