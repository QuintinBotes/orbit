import { describe, expect, it } from 'vitest';
import { bashGrant } from '../../../src/policy/role-grants.ts';

// NM2: which worker roles may run Bash, and where. Writers keep their grant; a read-only worker gets Bash only when it is an experiment worker (diagnosis).
describe('bashGrant', () => {
  it('keeps the writer grant unchanged', () => {
    expect(bashGrant({ readOnly: false, experiments: false, tier: 'os-sandbox' })).toEqual({ allowRule: true, autoAllowInSandbox: true });
    expect(bashGrant({ readOnly: false, experiments: false, tier: 'claude-sandbox' })).toEqual({ allowRule: false, autoAllowInSandbox: true });
  });
  it('gives a read-only experiment worker Bash in both tiers, through the same mechanism as a writer', () => {
    expect(bashGrant({ readOnly: true, experiments: true, tier: 'os-sandbox' })).toEqual({ allowRule: true, autoAllowInSandbox: true });
    expect(bashGrant({ readOnly: true, experiments: true, tier: 'claude-sandbox' })).toEqual({ allowRule: false, autoAllowInSandbox: true });
  });
  it('gives any other read-only worker no Bash at all', () => {
    for (const tier of ['os-sandbox', 'claude-sandbox'] as const) expect(bashGrant({ readOnly: true, experiments: false, tier })).toEqual({ allowRule: false, autoAllowInSandbox: false });
  });
});
