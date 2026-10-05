import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import { defaultConfig, parseConfig } from '../../../src/policy/config.ts';

/**
 * providers.<id>.tier: the isolation tier of the Codex reviewer (ADR 0001,
 * "Second live finding"). It is a Codex setting. A Claude provider rejects the
 * key rather than ignoring it, because a tier that silently did nothing would
 * look like confinement that is not there.
 */
function problemsOf(yaml: string): string[] {
  try {
    parseConfig(`version: 1\n${yaml}`);
  } catch (err) {
    expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONFIG_INVALID');
}
const ok = (yaml: string) => parseConfig(`version: 1\n${yaml}`);

describe('providers.<id>.tier for codex', () => {
  it('defaults to auto for the codex provider, in the built-in defaults and in a file that names no tier', () => {
    expect(defaultConfig().providers.codex?.tier).toBe('auto');
    expect(ok('').providers.codex?.tier).toBe('auto');
    expect(ok('providers:\n  codex: {data_policy_eligible: true}\n').providers.codex?.tier).toBe('auto');
  });

  it('defaults to auto for another codex provider id, and carries no tier for a provider that is not codex', () => {
    expect(ok('providers:\n  codex-review: {command: codex}\n').providers['codex-review']?.tier).toBe('auto');
    expect(ok('providers:\n  codex_alt: {command: codex}\n').providers.codex_alt?.tier).toBe('auto');
    expect(ok('providers:\n  extra: {command: extra-cli}\n').providers.extra).not.toHaveProperty('tier');
  });

  it.each(['auto', 'os-sandbox', 'codex-sandbox'] as const)('accepts %s', (tier) => {
    expect(ok(`providers:\n  codex: {tier: ${tier}}\n`).providers.codex?.tier).toBe(tier);
    expect(ok(`providers:\n  codex-review: {command: codex, tier: ${tier}}\n`).providers['codex-review']?.tier).toBe(tier);
  });

  it.each(['sandbox', 'claude-sandbox', 'AUTO', 'null', '""', '5'])('rejects the unknown tier %s, naming the key', (tier) => {
    expect(problemsOf(`providers:\n  codex: {tier: ${tier}}\n`).join('\n')).toMatch(/providers\.codex\.tier/);
  });

  it('keeps the tier when the user changes other provider settings', () => {
    const c = ok('providers:\n  codex: {tier: codex-sandbox, model: acme-model}\n');
    expect(c.providers.codex).toMatchObject({ tier: 'codex-sandbox', model: 'acme-model', command: 'codex' });
  });
});

describe('providers.<id>.tier for claude', () => {
  it('has no tier by default', () => {
    expect(defaultConfig().providers.claude).not.toHaveProperty('tier');
    expect(ok('').providers.claude).not.toHaveProperty('tier');
  });

  it.each(['claude', 'claude-review', 'claude_alt'])('rejects the key on %s instead of ignoring it, and says it is a Codex setting', (id) => {
    const problems = problemsOf(`providers:\n  ${id}: {command: claude, tier: os-sandbox}\n`);
    expect(problems).toEqual([expect.stringMatching(new RegExp(`^providers\\.${id}\\.tier: .*Codex`))]);
  });

  it('rejects the key on claude whatever its value', () => {
    expect(problemsOf('providers:\n  claude: {tier: auto}\n')).toHaveLength(1);
    expect(problemsOf('providers:\n  claude: {tier: bogus}\n').join('\n')).toMatch(/providers\.claude\.tier/);
  });
});

describe('the published config documents the tier', () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), 'utf8');

  it('lists tier in the starter template under codex only, as auto', () => {
    const template = read('templates/config.yaml');
    const codex = template.slice(template.indexOf('  codex:\n'), template.indexOf('routing:\n'));
    expect(codex).toMatch(/^ {4}tier: auto$/m);
    const claude = template.slice(template.indexOf('  claude:\n'), template.indexOf('  codex:\n'));
    expect(claude).not.toMatch(/^ {4}tier:/m);
  });

  it('describes the three values and the claude rule in docs/configuration.md', () => {
    const doc = read('docs/configuration.md');
    expect(doc).toMatch(/tier: auto/);
    for (const v of ['auto', 'os-sandbox', 'codex-sandbox']) expect(doc).toContain(`\`${v}\``);
    expect(doc).toMatch(/providers\.claude\.tier/);
  });
});
