/**
 * Issue #176, FR-001: policy names which providers may implement; the default is Claude only, so partner
 * implementers ship off until a person lists them.
 */
import { describe, expect, it } from 'vitest';
import { defaultConfig, parseConfig, partnerImplementers } from '../../../src/policy/config.ts';

const BASE = 'version: 1\nmode: autonomous\nscope: {allowed_paths: ["src/**"]}\n';

function problems(yaml: string): string {
  try {
    parseConfig(yaml);
    return '';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

describe('routing.implementers (FR-001)', () => {
  it('defaults to Claude only: partners are off', () => {
    expect(defaultConfig().routing.implementers).toEqual(['claude']);
    expect(parseConfig(BASE).routing.implementers).toEqual(['claude']);
    expect(partnerImplementers(parseConfig(BASE))).toEqual([]);
    // A snapshot written before the key existed has no partners either.
    expect(partnerImplementers({ routing: {} })).toEqual([]);
  });

  it('names Codex and Muse providers defined under providers, in their order', () => {
    const c = parseConfig(`${BASE}providers:\n  codex: {command: codex, data_policy_eligible: true, model: gpt-6-astra}\n  muse: {command: muse, data_policy_eligible: true}\nrouting:\n  implementers: [muse, codex, claude]\n`);
    expect(c.routing.implementers).toEqual(['muse', 'codex', 'claude']);
    expect(partnerImplementers(c)).toEqual(['muse', 'codex']);
  });

  it('refuses an id that is no provider Orbit can implement with, or one not defined under providers, naming the key', () => {
    expect(problems(`${BASE}routing:\n  implementers: [gemini]\n`)).toMatch(/routing\.implementers\[0\]: "gemini" is not claude or a codex or muse provider/);
    expect(problems(`${BASE}routing:\n  implementers: [claude, muse]\n`)).toMatch(/routing\.implementers\[1\]: "muse" is not defined under providers/);
    expect(problems(`${BASE}routing:\n  implementers: []\n`)).toMatch(/routing\.implementers/);
  });

  it('refuses a partner listed after claude: the list is a preference order and Claude, always the fallback, comes last', () => {
    const codex = 'providers:\n  codex: {command: codex, data_policy_eligible: true, model: gpt-6-astra}\n';
    expect(problems(`${BASE}${codex}routing:\n  implementers: [claude, codex]\n`)).toMatch(/routing\.implementers\[1\]: "codex" comes after claude/);
    expect(problems(`${BASE}${codex}routing:\n  implementers: [codex]\n`)).toBe('');
  });
});
