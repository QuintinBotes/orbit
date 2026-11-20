/**
 * Issue #176, user story 2: the reviewer is never the implementer's model family alone. Selection is pure; the
 * registry is real (the codex catalog lists codex-alpha, the recommended model, and codex-beta below it).
 *
 * Scenario 1: a risky change gets one fresh-session review from the implementer's family and one from another
 * provider's top tier. Scenario 2: with only a low-tier cross-model reviewer, the cross-model pass is skipped and the
 * selection says why. FR-003: independence is computed from who implemented in the run.
 */
import { describe, expect, it } from 'vitest';
import { selectReviewer, type ReviewerSelection } from '../../../src/review/select.ts';
import { reviewerLine } from '../../../src/controller/report.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { OPUS, SONNET, setup } from '../routing/fixtures.ts';
import { cap, cred, snapshotOf } from './fixtures.ts';

function select(opts: { implementer: { provider: string; model: string | null }; risky?: boolean; implementers?: string[]; patch?: (c: OrbitConfig) => void }): ReviewerSelection {
  const { registry } = setup();
  const snapshot = snapshotOf((c) => {
    c.review.when_unavailable = 'claude';
    opts.patch?.(c);
  });
  return selectReviewer({
    snapshot,
    capabilities: { claude: cap('claude'), codex: cap('codex') },
    credentials: { claude: cred('valid'), codex: cred('valid') },
    implementer: opts.implementer,
    ...(opts.implementers ? { implementers: opts.implementers } : {}),
    ...(opts.risky ? { risky: true } : {}),
    registry,
  });
}

describe('issue #176: one fresh same-family pass plus one cross-model pass', () => {
  it('scenario 1: a Codex implementer and a risky change: Claude at its top tier reviews across models, and Codex reviews again in a fresh session', () => {
    const sel = select({ implementer: { provider: 'codex', model: 'codex-alpha' }, risky: true });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', model: OPUS, independent: true, crossModelSkipped: null });
    if (sel.decision !== 'SELECT') return;
    expect(sel.sameFamily).toMatchObject({ provider: 'codex', model: 'codex-alpha', basis: 'configured' });
    expect(sel.reason).toMatch(/risky change: a fresh codex\/codex-alpha session reviews it too/);
  });

  it('scenario 1: a Claude implementer and a risky change: Codex reviews across models, and Claude reviews again in a fresh session at the quality floor', () => {
    const sel = select({ implementer: { provider: 'claude', model: SONNET }, risky: true });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'codex', model: 'codex-alpha', independent: true });
    if (sel.decision !== 'SELECT') return;
    expect(sel.sameFamily).toMatchObject({ provider: 'claude', model: OPUS });
  });

  it('a change that is not risky keeps one review, as before', () => {
    const sel = select({ implementer: { provider: 'claude', model: SONNET } });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'codex', independent: true });
    expect(sel).not.toHaveProperty('sameFamily');
    expect(sel).not.toHaveProperty('crossModelSkipped');
  });

  it('scenario 2: only a low-tier cross-model reviewer: the cross-model pass is skipped, the selection says why, and the implementer family reviews', () => {
    const sel = select({ implementer: { provider: 'claude', model: SONNET }, risky: true, patch: (c) => void (c.providers.codex!.model = 'codex-beta') });
    expect(sel).toMatchObject({ decision: 'SELECT', provider: 'claude', independent: false, sameFamily: null });
    if (sel.decision !== 'SELECT') return;
    expect(sel.crossModelSkipped).toMatch(/"codex" reviews with codex-beta, below its top tier \(codex-alpha is codex's recommended model\), and a weak cross-model reviewer adds nothing to a risky change/);
    expect(sel.independentUnavailable).toMatch(/below its top tier/);
    // The same low-tier reviewer still reviews a change that is not risky.
    expect(select({ implementer: { provider: 'claude', model: SONNET }, patch: (c) => void (c.providers.codex!.model = 'codex-beta') })).toMatchObject({ provider: 'codex', model: 'codex-beta', independent: true });
  });

  it('scenario 2: a Codex implementer whose only cross-model reviewer is a Claude model below the opus-class floor is not reviewed by it', () => {
    const sel = select({ implementer: { provider: 'codex', model: 'codex-alpha' }, risky: true, patch: (c) => void (c.routing.allowed_models = ['sonnet', 'haiku']) });
    // A same-provider review of a partner is not defined at a quality floor (ADR 0022), so the run blocks and says why.
    expect(sel.decision).toBe('BLOCK');
    if (sel.decision !== 'BLOCK') return;
    expect(sel.reason).toMatch(/"claude" has no model qualified for review at its top tier/);
  });

  it('scenario 2: a configured Claude reviewer model below the opus-class floor is not the cross-model pass of a risky change', () => {
    const sel = select({ implementer: { provider: 'codex', model: 'codex-alpha' }, risky: true, patch: (c) => void (c.providers.claude!.model = SONNET) });
    expect(sel.decision).toBe('BLOCK');
    if (sel.decision !== 'BLOCK') return;
    expect(sel.reason).toMatch(new RegExp(`"claude" reviews with ${SONNET}, below the opus-class floor`));
    // The same configured model still reviews a change that is not risky.
    expect(select({ implementer: { provider: 'codex', model: 'codex-alpha' }, patch: (c) => void (c.providers.claude!.model = SONNET) })).toMatchObject({ provider: 'claude', model: SONNET, independent: true });
  });

  it('FR-003: independence is computed from every provider that implemented in the run', () => {
    // A Codex implementer is reviewed by Claude, which review.providers does not list.
    expect(select({ implementer: { provider: 'codex', model: 'codex-alpha' } })).toMatchObject({ provider: 'claude', independent: true });
    // A tree Codex began and Claude finished is reviewed by neither as independent.
    const mixed = select({ implementer: { provider: 'claude', model: SONNET }, implementers: ['codex'] });
    expect(mixed).toMatchObject({ decision: 'SELECT', provider: 'claude', independent: false });
  });

  it('the final report names the second pass, and says when and why the cross-model pass was skipped', () => {
    expect(reviewerLine({ provider: 'claude', model: OPUS, independent: true, why_not_independent: null, approved_by: null, same_family_reviewer: 'codex/codex-alpha' })).toBe(
      `Reviewer: claude/${OPUS} (independent)\n- Same-family review: codex/codex-alpha (the implementer's family, in a fresh session; the change is risky)`,
    );
    const line = reviewerLine({ provider: 'claude', model: OPUS, independent: false, why_not_independent: 'no independent reviewer was usable: weak', approved_by: null, cross_model_skipped: '"codex" reviews with codex-beta, below its top tier' });
    expect(line).toMatch(/NOT independent/);
    expect(line).toMatch(/\n- Cross-model review skipped: "codex" reviews with codex-beta, below its top tier$/);
  });
});
