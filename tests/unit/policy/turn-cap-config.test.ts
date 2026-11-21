import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseConfig } from '../../../src/policy/config.ts';
import { isOrbitError } from '../../../src/core/errors.ts';

function problems(yaml: string): string {
  try {
    parseConfig(yaml);
  } catch (err) {
    if (isOrbitError(err)) {
      expect(err.code).toBe('CONFIG_INVALID');
      return JSON.stringify(err.details ?? '') + err.message;
    }
    throw err;
  }
  return '';
}

const section = (floor: number, ceiling: number, def: number, fraction = 0.8) =>
  `version: 1\nscheduler:\n  turn_cap: {floor: ${floor}, ceiling: ${ceiling}, default: ${def}, reminder_fraction: ${fraction}}\n`;

describe('scheduler.turn_cap config (AC-1)', () => {
  it('is optional and absent by default (turnCapBounds then applies floor 10 and the hard cap as ceiling and default)', () => {
    expect(parseConfig('version: 1\n').scheduler.turn_cap).toBeUndefined();
  });
  it('accepts floor <= default <= ceiling <= hard cap', () => {
    expect(parseConfig(section(8, 25, 20)).scheduler.turn_cap).toEqual({ floor: 8, ceiling: 25, default: 20, reminder_fraction: 0.8 });
  });
  it('rejects a floor above the ceiling', () => {
    expect(problems(section(26, 25, 25))).toMatch(/floor/);
  });
  it('rejects a ceiling above the hard cap', () => {
    expect(problems(section(5, 31, 20))).toMatch(/ceiling/);
  });
  it('rejects a default outside floor..ceiling', () => {
    expect(problems(section(8, 25, 5))).toMatch(/default/);
  });
  it('rejects a reminder fraction outside (0, 1)', () => {
    expect(problems(section(8, 25, 20, 1))).not.toBe('');
    expect(problems(section(8, 25, 20, 0))).not.toBe('');
  });
  it('documents the keys in the config template', () => {
    expect(readFileSync(new URL('../../../templates/config.yaml', import.meta.url), 'utf8')).toMatch(/turn_cap:[\s\S]*reminder_fraction/);
  });
});
