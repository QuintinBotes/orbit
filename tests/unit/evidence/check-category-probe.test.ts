// What a check evidences decides whether the fail-before probe runs it (ADR 0014 section 4): only a command check of
// category test is probed. A check without a category reads as test, so a lint check written without one was probed as
// a test (the 0.3.0 retest: "lint passed on the base revision with the new tests: AC-2" on the demo app).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newTestSupport } from '../../../src/evidence/fail-before.ts';
import { loadConfig, parseConfig } from '../../../src/policy/config.ts';
import { contract, fakeSnapshot } from './report-fixtures.ts';

const ROOT = new URL('../../../', import.meta.url);
const read = (p: string): string => readFileSync(new URL(p, ROOT), 'utf8');

const LINT_AND_UNIT = contract({
  acceptance_criteria: [{ id: 'AC-2', statement: 'The change passes lint and the whole unit suite.', proof: ['lint and unit pass'], mandatory: true, check_ids: ['lint', 'unit'] }],
  required_check_ids: ['lint', 'unit'],
});
const BASE = { treeHash: 'tree-base', checks: [{ checkId: 'lint', status: 'PASSED' as const }, { checkId: 'unit', status: 'PASSED' as const }], changedPaths: ['src/views/not-found.ts', 'tests/unit/not-found.test.ts'] };

describe('the demo app names what each check evidences', () => {
  const config = loadConfig(fileURLToPath(new URL('examples/demo-app', ROOT)));

  it('sets a category on every check: lint is lint, unit is test, the browser journeys are ui', () => {
    expect(Object.fromEntries(Object.entries(config.checks).map(([id, c]) => [id, c.category]))).toEqual({ lint: 'lint', unit: 'test', ui: 'ui' });
    const text = read('examples/demo-app/.orbit/config.yaml');
    for (const category of ['lint', 'test', 'ui']) expect(text).toMatch(new RegExp(`^ {4}category: ${category}$`, 'm'));
  });

  it('so the probe runs unit for a criterion citing lint and unit, never lint', () => {
    const [support] = newTestSupport(LINT_AND_UNIT, fakeSnapshot(Object.values(config.checks)), BASE);
    expect(support).toMatchObject({ criterionId: 'AC-2', withTests: ['lint', 'unit'], probeable: ['unit'] });
  });
});

describe('a check without a category', () => {
  it('is treated as test and probed', () => {
    const parsed = parseConfig('version: 1\nchecks:\n  lint:\n    command: [npm, run, lint]\n  unit:\n    command: [npm, test]\n');
    expect(parsed.checks.lint!.category).toBe('test');
    const [support] = newTestSupport(LINT_AND_UNIT, fakeSnapshot(Object.values(parsed.checks)), BASE);
    expect(support!.probeable).toEqual(['lint', 'unit']);
  });

  it('docs/configuration.md says so, and documents the category key', () => {
    const doc = read('docs/configuration.md');
    expect(doc).toMatch(/a check without a category is treated as `test` and is probed/i);
    expect(doc).toMatch(/^\| `category` \| /m);
  });

  it('the starter template gives every example check a category', () => {
    const examples = read('templates/config.yaml').split('# example-checks:start')[1]!.split('# example-checks:end')[0]!;
    const ids = [...examples.matchAll(/^# {3}([\w-]+):$/gm)].map((m) => m[1]);
    const categorized = [...examples.matchAll(/^# {5}category: (\w+)$/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(0);
    expect(categorized).toHaveLength(ids.length);
  });
});
