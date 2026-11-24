// Issue #232, scenario 4: with a simplicity check configured, doctor reports Unknot unavailable (not installed, or too
// old to compare against a base) with the install step; without one it says nothing; admission refuses the run.
import { describe, expect, it } from 'vitest';
import { simplicityCheck, simplicityRefusal } from '../../../src/cli/commands/doctor-simplicity.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';

function config(ids: string[]): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.checks = Object.fromEntries(ids.map((id) => [id, { ...defaultCheck(id), command: ['true'] }]));
  return c;
}
const probe = (version: string | null) => async () => version;

describe('simplicityCheck', () => {
  it('says nothing without a simplicity check', async () => {
    expect(await simplicityCheck({ config: config(['lint']), probe: probe(null) })).toEqual([]);
  });
  it('fails when unknot is not installed, with the install step', async () => {
    const [c] = await simplicityCheck({ config: config(['simplicity']), probe: probe(null) });
    expect(c).toMatchObject({ id: 'checks.simplicity', area: 'checks', status: 'fail' });
    expect(c!.summary).toContain('unknot is not installed');
    expect(c!.fix).toContain('claude plugin install unknot@quintinbotes');
  });
  it('fails when unknot is older than 0.4.0', async () => {
    const [c] = await simplicityCheck({ config: config(['simplicity']), probe: probe('0.3.3') });
    expect(c).toMatchObject({ status: 'fail' });
    expect(c!.summary).toContain('older than 0.4.0');
  });
  it('passes with unknot 0.4.0', async () => {
    const [c] = await simplicityCheck({ config: config(['simplicity']), probe: probe('0.4.0') });
    expect(c).toMatchObject({ status: 'pass' });
  });
});

describe('simplicityRefusal', () => {
  it('refuses a run when the configured gate cannot run, and not otherwise', async () => {
    expect(await simplicityRefusal({ config: config(['simplicity']), probe: probe(null) })).toMatchObject({ reason: expect.stringContaining('unknot is not installed'), fix: expect.stringContaining('claude plugin install unknot') });
    expect(await simplicityRefusal({ config: config(['simplicity']), probe: probe('0.4.0') })).toBeNull();
    expect(await simplicityRefusal({ config: config(['lint']), probe: probe(null) })).toBeNull();
  });
});
