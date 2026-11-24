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
import type { UnknotProbe } from '../../../src/evidence/simplicity.ts';
const probe = (version: string | null) => async (): Promise<UnknotProbe> => (version === null ? { state: 'missing' } : { state: 'ok', output: version });
const PROJECT = ['.unknot/.gitignore', '.unknot/config.yaml'];
const base = { env: { PATH: '/usr/bin' }, cwd: '/repo', files: PROJECT };

describe('simplicityCheck', () => {
  it('says nothing without a simplicity check', async () => {
    expect(await simplicityCheck({ ...base, config: config(['lint']), probe: probe(null) })).toEqual([]);
  });
  it('fails when unknot is not installed, with the install step', async () => {
    const [c] = await simplicityCheck({ ...base, config: config(['simplicity']), probe: probe(null) });
    expect(c).toMatchObject({ id: 'checks.simplicity', area: 'checks', status: 'fail' });
    expect(c!.summary).toContain('unknot is not installed');
    expect(c!.fix).toContain('claude plugin install unknot@quintinbotes');
  });
  it('fails when unknot is older than 0.4.0', async () => {
    const [c] = await simplicityCheck({ ...base, config: config(['simplicity']), probe: probe('0.3.3') });
    expect(c).toMatchObject({ status: 'fail' });
    expect(c!.summary).toContain('older than 0.4.0');
  });
  it('passes with unknot 0.4.0', async () => {
    const [c] = await simplicityCheck({ ...base, config: config(['simplicity']), probe: probe('0.4.0') });
    expect(c).toMatchObject({ status: 'pass' });
  });
});

describe('an unknot project', () => {
  it('doctor fails and admission refuses when the repository has no committed unknot directory, which every candidate would fail on with UK_NOT_INITIALIZED', async () => {
    const input = { ...base, files: ['src/a.ts'], config: config(['simplicity']), probe: probe('0.4.0') };
    const [c] = await simplicityCheck(input);
    expect(c).toMatchObject({ status: 'fail' });
    expect(c!.summary).toContain('.unknot');
    expect(c!.fix).toContain('/unknot:init');
    expect((await simplicityRefusal(input))?.reason).toContain('.unknot');
  });
  it('the probe runs with the PATH the check will have: its own env.PATH when it sets one', async () => {
    const seen: (string | undefined)[] = [];
    const c = config(['simplicity']);
    c.checks.simplicity!.env = { PATH: '/opt/unknot/bin' };
    await simplicityCheck({ ...base, config: c, probe: async (e) => (seen.push(e.PATH), { state: 'ok', output: '0.4.0' }) });
    await simplicityCheck({ ...base, config: config(['simplicity']), probe: async (e) => (seen.push(e.PATH), { state: 'ok', output: '0.4.0' }) });
    expect(seen).toEqual(['/opt/unknot/bin', '/usr/bin']);
  });
});

describe('simplicityRefusal', () => {
  it('refuses a run when the configured gate cannot run, and not otherwise', async () => {
    expect(await simplicityRefusal({ ...base, config: config(['simplicity']), probe: probe(null) })).toMatchObject({ reason: expect.stringContaining('unknot is not installed'), fix: expect.stringContaining('claude plugin install unknot') });
    expect(await simplicityRefusal({ ...base, config: config(['simplicity']), probe: probe('0.4.0') })).toBeNull();
    expect(await simplicityRefusal({ ...base, config: config(['lint']), probe: probe(null) })).toBeNull();
  });
});
