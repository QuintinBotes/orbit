// Issue #9: agents.allowed_plugins and agents.allow_managed_plugins, the policy keys that admit a plugin into
// worker sessions. Strict by default; ids must be exact name@marketplace strings.
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig } from '../../../src/policy/config.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    return ((err as OrbitError).details?.problems as string[]) ?? [];
  }
  throw new Error('expected CONFIG_INVALID');
}

describe('agents plugin policy keys', () => {
  it('default to no allowed plugins and managed plugins refused', () => {
    expect(defaultConfig().agents).toMatchObject({ allowed_plugins: [], allow_managed_plugins: false });
    expect(parseConfig('version: 1\n').agents).toMatchObject({ allowed_plugins: [], allow_managed_plugins: false });
  });

  it('accept exact name@marketplace ids and the managed flag', () => {
    const c = parseConfig('version: 1\nagents:\n  allowed_plugins: ["acme-guard@acme-it", "acme.notes_2@acme"]\n  allow_managed_plugins: true\n');
    expect(c.agents.allowed_plugins).toEqual(['acme-guard@acme-it', 'acme.notes_2@acme']);
    expect(c.agents.allow_managed_plugins).toBe(true);
  });

  it('refuse an id without a marketplace, with a pattern, or repeated, and a non-boolean flag', () => {
    expect(problems(() => parseConfig('version: 1\nagents: {allowed_plugins: ["acme-guard"]}\n'))).toEqual([expect.stringMatching(/^agents\.allowed_plugins\[0\]: must match/)]);
    expect(problems(() => parseConfig('version: 1\nagents: {allowed_plugins: ["*@acme"]}\n'))).toEqual([expect.stringMatching(/^agents\.allowed_plugins\[0\]: must match/)]);
    expect(problems(() => parseConfig('version: 1\nagents: {allowed_plugins: ["a@b", "a@b"]}\n'))).toEqual([expect.stringMatching(/^agents\.allowed_plugins: must NOT have duplicate items/)]);
    expect(problems(() => parseConfig('version: 1\nagents: {allow_managed_plugins: "yes"}\n'))).toEqual(['agents.allow_managed_plugins: must be boolean']);
  });
});
