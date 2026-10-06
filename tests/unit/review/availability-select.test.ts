// Reviewer selection under review.when_unavailable (issues #6 and #8, docs/decisions/0007-reviewer-availability.md).
// The provider answers are fakes (what codex would report about itself); selection and the registry are real.
import { describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { selectReviewer, selectionDecisionRecord, type ReviewerSelection } from '../../../src/review/select.ts';
import { route } from '../../../src/routing/router.ts';
import type { ReviewFallback } from '../../../src/policy/review.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { OPUS, SONNET, policy, setup, signals } from '../routing/fixtures.ts';
import { cap, cred, snapshotOf } from './fixtures.ts';

const IMPL = { provider: 'claude', model: SONNET };

interface World {
  patch?: (c: OrbitConfig) => void;
  capabilities: Record<string, ReturnType<typeof cap> | undefined>;
  credentials: Record<string, ReturnType<typeof cred> | undefined>;
  codexCatalog?: boolean;
}

function ready(): World {
  return { capabilities: { claude: cap('claude'), codex: cap('codex') }, credentials: { claude: cred('valid'), codex: cred('valid') } };
}

/** Each way the independent reviewer can be unusable, and the words its reason carries. */
const UNUSABLE: [string, (w: World) => void, RegExp][] = [
  ['not installed', (w) => void (w.capabilities.codex = cap('codex', { available: false, detail: 'codex: command not found' })), /codex: command not found/],
  ['no adapter answer', (w) => void delete w.capabilities.codex, /no adapter capabilities were reported for "codex"/],
  ['no structured output', (w) => void (w.capabilities.codex = cap('codex', { structuredOutput: false })), /cannot return schema-constrained output/],
  ['not logged in', (w) => void (w.credentials.codex = cred('missing', 'run codex login')), /no credentials for "codex" \(run codex login\)/],
  ['an expired login', (w) => void (w.credentials.codex = cred('expired', 'token expired')), /credentials for "codex" are expired/],
  ['not data-policy eligible', (w) => void (w.patch = (c) => void (c.providers.codex!.data_policy_eligible = false)), /providers\.codex\.data_policy_eligible is not true/],
  [
    'no qualified model',
    (w) => {
      w.patch = (c) => void (c.providers.codex!.model = null);
      w.codexCatalog = false;
    },
    /"codex" has no model qualified for review/,
  ],
];

function select(mode: ReviewFallback, w: World, implementer: { provider: string; model: string | null } = IMPL): ReviewerSelection {
  const { registry } = setup({ codex: w.codexCatalog ?? true });
  const snapshot = snapshotOf((c) => {
    c.review.when_unavailable = mode;
    w.patch?.(c);
  });
  return selectReviewer({ snapshot, capabilities: w.capabilities as never, credentials: w.credentials as never, implementer, registry });
}

describe('an independent reviewer is usable', () => {
  it.each(['claude', 'ask', 'block'] as const)('%s: codex reviews, independently, and nobody is asked', (mode) => {
    const sel = select(mode, ready());
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'codex', independent: true, needsApproval: false, independentUnavailable: null });
  });

  it('takes the providers in the listed order, and records a substitution', () => {
    const both = (w: World): World => ({
      ...w,
      patch: (c) => {
        c.providers['codex-review'] = { ...c.providers.codex!, command: 'codex', model: 'codex-alpha' };
        c.review.providers = ['codex-review', 'codex'];
      },
      capabilities: { ...w.capabilities, 'codex-review': cap('codex-review') },
      credentials: { ...w.credentials, 'codex-review': cred('valid') },
    });
    expect(select('block', both(ready()))).toMatchObject({ decision: 'SELECT', provider: 'codex-review', substitutedForPreferred: false });
    const first = both(ready());
    first.credentials['codex-review'] = cred('expired');
    const sel = select('block', first);
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'codex', independent: true, substitutedForPreferred: true });
  });

  it('never asks a provider that is not listed', () => {
    const w = ready();
    w.patch = (c) => void (c.review.providers = []);
    const sel = select('block', w);
    expect(sel.decision).toBe('BLOCK');
    if (sel.decision === 'BLOCK') expect(sel.reason).toMatch(/no independent review provider is listed in review\.providers/);
  });
});

describe.each(UNUSABLE)('the independent reviewer is unusable: %s', (_name, breakIt, why) => {
  const broken = (): World => {
    const w = ready();
    breakIt(w);
    return w;
  };

  it('claude: Claude reviews in a separate session at the quality floor, and says it is not independent and why', () => {
    const sel = select('claude', broken());
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', model: OPUS, independent: false, needsApproval: false });
    if (sel.decision !== 'SELECT') return;
    expect(sel.independentUnavailable).toMatch(why);
    expect(sel.reason).toMatch(/not independent/);
    expect(sel.reason).toMatch(/separate reviewer session/);
    expect(sel.reason).toMatch(why);
    const rec = selectionDecisionRecord(sel);
    expect(rec.summary).toMatch(/^reviewer claude\/claude-opus-5-5 \(same provider, not independent: /);
    expect(rec.summary).not.toMatch(/\(independent\)/);
  });

  it('ask: the same-provider review is selected but needs a person\'s yes', () => {
    const sel = select('ask', broken());
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', independent: false, needsApproval: true });
    if (sel.decision === 'SELECT') expect(sel.independentUnavailable).toMatch(why);
  });

  it('block: the run blocks with the reason and nothing stands in', () => {
    const sel = select('block', broken());
    expect(sel.decision).toBe('BLOCK');
    if (sel.decision !== 'BLOCK') return;
    expect(sel.reason).toMatch(/independent review is required \(review\.when_unavailable: block\)/);
    expect(sel.reason).toMatch(why);
    expect(sel.reason).toContain('not being substituted');
  });
});

describe('the Claude fallback is never routed down', () => {
  const expired = (): World => {
    const w = ready();
    w.credentials.codex = cred('expired');
    return w;
  };

  it('reviews an opus implementer with opus in a separate session when no other tier at the floor is allowed', () => {
    const sel = select('claude', expired(), { provider: 'claude', model: OPUS });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', model: OPUS, independent: false });
    if (sel.decision === 'SELECT') expect(sel.reason).toMatch(/same tier as the implementer's model; it reviews in a separate session/);
  });

  it('picks a model at the floor before the implementer\'s model is known (preflight)', () => {
    expect(select('claude', expired(), { provider: 'claude', model: null })).toMatchObject({ decision: 'SELECT', provider: 'claude', model: OPUS });
  });

  it('blocks rather than review below the floor', () => {
    const w = expired();
    w.patch = (c) => void (c.routing.allowed_models = ['haiku', 'sonnet']);
    const sel = select('claude', w);
    expect(sel.decision).toBe('BLOCK');
    if (sel.decision === 'BLOCK') expect(sel.alternatives.some((a) => a.model === SONNET && /below the review quality floor/.test(a.reason))).toBe(true);
  });
});

describe('safety-review routing follows review.when_unavailable', () => {
  const p = (mode: ReviewFallback) => policy({ review: { providers: ['codex'], when_unavailable: mode } });

  it('claude: routes the review to Claude at the opus-class floor and says it is not independent', () => {
    const { registry } = setup({ codex: false });
    const d = route({ workKind: 'safety-review', signals: signals(), registry, policy: p('claude') });
    expect(d).toMatchObject({ provider: 'claude', model: OPUS });
    expect(d.reason).toMatch(/no qualified independent reviewer; review\.when_unavailable is claude, so a same-provider review at the opus-class floor in a separate session \(not independent; opus meets the opus-class floor\)/);
  });

  it('ask: routes to Claude only with a person\'s approval, and says so', () => {
    const { registry } = setup({ codex: false });
    const d = route({ workKind: 'safety-review', signals: signals(), registry, policy: p('ask') });
    expect(d.provider).toBe('claude');
    expect(d.reason).toMatch(/review\.when_unavailable is ask: a person must approve/);
  });

  it('block: refuses to route the review', () => {
    const { registry } = setup({ codex: false });
    let err: unknown;
    try {
      route({ workKind: 'safety-review', signals: signals(), registry, policy: p('block') });
    } catch (e) {
      err = e;
    }
    expect(isOrbitError(err, 'PROVIDER_UNAVAILABLE')).toBe(true);
    expect((err as Error).message).toMatch(/independent review is required/);
  });

  it('prefers the listed provider whatever the mode', () => {
    const { registry } = setup();
    expect(route({ workKind: 'safety-review', signals: signals(), registry, policy: p('claude') }).provider).toBe('codex');
  });
});
