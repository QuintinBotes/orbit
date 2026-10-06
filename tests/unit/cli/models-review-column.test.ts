/**
 * Nm5: `orbit models list` and `orbit doctor` agree. Reviewer selection allows a provider's own models for review on top
 * of `routing.allowed_models` (the review packet goes to a different provider's model), so a Codex model that is "not
 * allowed" for implementation is still the reviewer: the list says so in a REVIEW column instead of contradicting doctor.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { systemClock } from '../../../src/core/clock.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import { codexCatalog } from '../routing/fixtures.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

describe('models list: the REVIEW column', () => {
  it('shows a catalog model that policy does not allow for implementation as usable for review', async () => {
    const l = makeLab();
    labs.push(l);
    await l.cli(['init']);
    new ModelRegistry(l.db(), systemClock).seed();
    const reg = new ModelRegistry(l.db(), systemClock);
    reg.registerCodexCatalog(codexCatalog(), { source: 'live' });

    const j = JSON.parse((await l.cli(['models', 'list', '--json'])).out) as { models: { model: string; surface: string; policy: string; eligible: boolean; review_eligible: boolean }[] };
    const codex = j.models.filter((m) => m.surface === 'codex-cli');
    expect(codex.length).toBeGreaterThan(0);
    const listed = codex.find((m) => m.review_eligible);
    expect(listed, JSON.stringify(codex)).toBeDefined();
    expect(listed!.policy).toBe('not allowed');
    expect(listed!.eligible).toBe(false);

    const text = (await l.cli(['models', 'list'])).out;
    expect(text.split('\n')[0]).toMatch(/MODEL\s+SURFACE\s+AVAILABILITY\s+POLICY\s+ELIGIBLE\s+REVIEW/);
    expect(text).toMatch(new RegExp(`${listed!.model}.*not allowed.*no.*yes`));
  });

  it('a Claude model is not offered for review on the strength of the provider wildcard alone', async () => {
    const l = makeLab();
    labs.push(l);
    await l.cli(['init']);
    const j = JSON.parse((await l.cli(['models', 'list', '--json'])).out) as { models: { model: string; policy: string; review_eligible: boolean }[] };
    for (const m of j.models.filter((x) => x.policy === 'not allowed' && x.model.startsWith('claude-'))) expect(m.review_eligible, m.model).toBe(false);
  });
});
