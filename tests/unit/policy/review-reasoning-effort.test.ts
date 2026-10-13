import { describe, expect, it } from 'vitest';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import { defaultConfig, parseConfig } from '../../../src/policy/config.ts';

/**
 * providers.<id>.review_reasoning_effort: the reasoning effort of the Codex reviewer's sessions. At the Codex CLI's own
 * default, a retest review answered in 17 reasoning tokens with no tool call, so Orbit asks for medium unless told otherwise.
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

describe('providers.<id>.review_reasoning_effort for codex', () => {
  it('defaults to medium, in the built-in defaults and in a file that names none', () => {
    expect(defaultConfig().providers.codex?.review_reasoning_effort).toBe('medium');
    expect(ok('').providers.codex?.review_reasoning_effort).toBe('medium');
    expect(ok('providers:\n  codex: {data_policy_eligible: true}\n').providers.codex?.review_reasoning_effort).toBe('medium');
    expect(ok('providers:\n  codex-review: {command: codex}\n').providers['codex-review']?.review_reasoning_effort).toBe('medium');
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'])('accepts %s', (effort) => {
    expect(ok(`providers:\n  codex: {review_reasoning_effort: ${effort}}\n`).providers.codex?.review_reasoning_effort).toBe(effort);
  });

  it.each(['ultra', 'HIGH', 'null', '""', '5'])('rejects %s, naming the key', (effort) => {
    expect(problemsOf(`providers:\n  codex: {review_reasoning_effort: ${effort}}\n`).join('\n')).toMatch(/providers\.codex\.review_reasoning_effort/);
  });

  it('keeps the effort a person set only as reasoning_effort, and lets the new key win when both are set', () => {
    expect(ok('providers:\n  codex: {reasoning_effort: high}\n').providers.codex?.review_reasoning_effort).toBe('high');
    expect(ok('providers:\n  codex: {reasoning_effort: high, review_reasoning_effort: low}\n').providers.codex).toMatchObject({ reasoning_effort: 'high', review_reasoning_effort: 'low' });
  });
});

describe('providers.<id>.review_reasoning_effort for claude', () => {
  it('has none by default', () => {
    expect(defaultConfig().providers.claude).not.toHaveProperty('review_reasoning_effort');
    expect(ok('').providers.claude).not.toHaveProperty('review_reasoning_effort');
  });

  it('is rejected on a Claude provider instead of ignored, and says it is a Codex setting', () => {
    expect(problemsOf('providers:\n  claude: {review_reasoning_effort: high}\n')).toEqual([expect.stringMatching(/^providers\.claude\.review_reasoning_effort: .*Codex/)]);
  });
});
