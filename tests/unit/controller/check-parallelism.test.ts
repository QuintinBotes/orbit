// Issue #266: verification.check_parallelism, how many of a policy's checks run at once in verification and the baseline.
import { afterEach, describe, expect, it } from 'vitest';
import { checkRunnerFor } from '../../../src/controller/context.ts';
import { checkParallelism, defaultConfig, parseConfig, validateConfig } from '../../../src/policy/config.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

const labs: UnitLab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.cleanup();
});

function problems(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (isOrbitError(err)) return ((err as OrbitError).details?.problems as string[] | undefined) ?? [err.message];
    throw err;
  }
  return [];
}

describe('verification.check_parallelism', () => {
  it('defaults to 1, so checks run one at a time as before', () => {
    expect(defaultConfig('autonomous').verification.check_parallelism).toBe(1);
    expect(checkParallelism(parseConfig('version: 1\nmode: autonomous\n'))).toBe(1);
  });

  it('accepts a number of checks from 1 to 16', () => {
    expect(checkParallelism(parseConfig('version: 1\nmode: autonomous\nverification:\n  check_parallelism: 4\n'))).toBe(4);
    for (const n of [0, 17, 2.5]) {
      expect(problems(() => validateConfig({ version: 1, mode: 'autonomous', verification: { check_parallelism: n } })).join('\n'), String(n)).toMatch(/verification\.check_parallelism/);
    }
  });

  it('reads a snapshot written before the key existed as 1', () => {
    const c = defaultConfig('autonomous');
    const old = { ...c, verification: { allow_flaky_pass: false, fail_before: 'required' as const } } as OrbitConfig;
    expect(checkParallelism(old)).toBe(1);
  });

  it('reaches the runner of the candidate checks and the probes', () => {
    const lab = makeUnitLab({ tweak: (c) => void (c.verification.check_parallelism = 3) });
    labs.push(lab);
    expect(checkRunnerFor(lab.ctx()).parallelism).toBe(3);
    const plain = makeUnitLab();
    labs.push(plain);
    expect(checkRunnerFor(plain.ctx()).parallelism).toBe(1);
  });
});
