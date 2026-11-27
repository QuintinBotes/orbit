// Issue #284: a mapped test file that existed before the change is cut, for the criterion audit, to the test cases the
// candidate added or changed, keeping imports, helpers and describe lines, so a long existing file can still be audited.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { narrowTestFile } from '../../../src/review/proof.ts';
import { AUDIT_MAX_CHARS } from '../../../src/controller/proof.ts';

const FILE = [
  "import { describe, expect, it } from 'vitest';", // 1
  "import { add } from '../src/add.ts';", // 2
  '', // 3
  'const two = () => 2;', // 4
  '', // 5
  "describe('add', () => {", // 6
  "  it('adds', () => {", // 7
  '    expect(add(1, 1)).toBe(two());', // 8
  '  });', // 9
  '', // 10
  "  it.each([[1, 2], [2, 3]])('adds one to %i', (a, b) => {", // 11
  '    expect(add(a, 1)).toBe(b);', // 12
  '  });', // 13
  '', // 14
  "  test('the new case', () => {", // 15
  '    expect(add(2, 2)).toBe(4);', // 16
  '  });', // 17
  '});', // 18
].join('\n');

describe('narrowTestFile', () => {
  it('keeps the changed case, the imports, helpers and describe lines, and marks each unchanged case', () => {
    const out = narrowTestFile(FILE, new Set([15, 16, 17]))!;
    expect(out).toContain("import { add } from '../src/add.ts';");
    expect(out).toContain('const two = () => 2;');
    expect(out).toContain("describe('add', () => {");
    expect(out).toContain("  test('the new case', () => {\n    expect(add(2, 2)).toBe(4);\n  });");
    expect(out).not.toContain("it('adds'");
    expect(out).not.toContain('it.each');
    // The two unchanged cases next to each other become one marker.
    expect(out).toContain('  // [Orbit] test cases the candidate did not change, lines 7-13, left out of this audit');
  });

  it('keeps a case whose body alone changed, and a one-line case', () => {
    expect(narrowTestFile(FILE, new Set([12]))).toContain("it.each([[1, 2], [2, 3]])('adds one to %i'");
    const oneLine = ["it('a', () => expect(1).toBe(1));", "it('b', () => expect(2).toBe(2));"].join('\n');
    expect(narrowTestFile(oneLine, new Set([2]))).toBe("// [Orbit] test cases the candidate did not change, lines 1-1, left out of this audit\nit('b', () => expect(2).toBe(2));");
  });

  it('gives up (null) when no case is touched, when there is none, or when a case does not close', () => {
    expect(narrowTestFile(FILE, new Set([4]))).toBeNull();
    expect(narrowTestFile('export const x = 1;\n', new Set([1]))).toBeNull();
    expect(narrowTestFile("it('open', () => {\n  expect(1).toBe(1);\n", new Set([2]))).toBeNull();
  });

  it('brings a long existing file with one new case well under the auditor\'s limit', () => {
    const many = Array.from({ length: 1200 }, (_, i) => `  it('case ${i}', () => {\n    expect(add(${i}, 1)).toBe(${i + 1});\n  });`).join('\n');
    const long = `import { add } from '../src/add.ts';\ndescribe('add', () => {\n${many}\n  it('the new one', () => {\n    expect(add(0, 0)).toBe(0);\n  });\n});`;
    const lines = long.split('\n');
    const at = lines.indexOf("  it('the new one', () => {") + 1;
    expect(long.length).toBeGreaterThan(AUDIT_MAX_CHARS);
    const out = narrowTestFile(long, new Set([at, at + 1, at + 2]))!;
    expect(out).toContain("it('the new one'");
    expect(out.length).toBeLessThan(AUDIT_MAX_CHARS);
  });
});

describe("the planner's instructions (issue #284)", () => {
  it('name the audit limit and what the auditor reads of an existing test file', () => {
    const planner = readFileSync(join(import.meta.dirname, '../../../plugin/agents/planner.md'), 'utf8');
    expect(planner).toContain('under 60,000 characters');
    expect(planner).toContain('only the test cases the change adds or edits');
    expect(AUDIT_MAX_CHARS).toBe(60_000);
  });
});
