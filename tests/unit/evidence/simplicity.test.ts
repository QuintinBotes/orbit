// Issue #232: the simplicity gate. A check whose command is `unknot diagnose --baseline <base> --fail-on new:high --json`
// fails a candidate that adds a high-severity finding, names each finding, and never fails on what the base already had.
import { describe, expect, it } from 'vitest';
import { isSimplicityCheck, judgeSimplicity, MIN_UNKNOT, simplifyFindingsBlock, unknotVersionProblem } from '../../../src/evidence/simplicity.ts';

const finding = (over: Record<string, unknown> = {}) => ({
  kind: 'module.dependency-cycle',
  severity: 'high',
  location: 'src/a.ts:1',
  title: '2 modules form an import cycle: src/a.ts -> src/b.ts -> src/a.ts',
  evidence: [
    { summary: 'imports src/b.ts', source_ref: 'src/a.ts:1' },
    { summary: 'imports src/b.ts', source_ref: 'src/b.ts:1' },
  ],
  ...over,
});
const doc = (findings: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ schema_version: '1.0', baseline: { ref: 'abc', findings: 0, new: findings.length, extraction_failures: { tree: 0, base: 0 } }, findings, ...extra }, null, 2);
// unknot prints its own log lines to stderr, which the check's log interleaves with the JSON.
const NOISE = '12:31PM INF 0 commits scanned.\n{"level":"info-0","logger":"trufflehog"}\n';
const run = (body: string, exitCode: number | null, status: 'PASSED' | 'FAILED' | 'TIMEOUT' = exitCode === 0 ? 'PASSED' : 'FAILED') => judgeSimplicity({ body, exitCode, status, timeoutSeconds: 600 });

describe('isSimplicityCheck', () => {
  it('reads the check id', () => {
    expect(['simplicity', 'simplicity-gate', 'Simplicity'].map(isSimplicityCheck)).toEqual([true, true, true]);
    expect(['lint', 'simplicity2', 'not-simplicity'].map(isSimplicityCheck)).toEqual([false, false, false]);
  });
});

describe('judgeSimplicity', () => {
  it('scenario 1: exit 1 names each new finding with its kind, location and evidence', () => {
    const v = run(NOISE + doc([finding()]), 1);
    expect(v?.note).toContain('simplicity gate: 1 new high-severity finding');
    expect(v?.note).toContain('- [high] module.dependency-cycle src/a.ts:1: 2 modules form an import cycle');
    expect(v?.note).toContain('src/a.ts:1 imports src/b.ts');
    expect(v?.note).toContain('src/b.ts:1 imports src/b.ts');
  });

  it('scenario 2: exit 0 is a pass, whatever the base already had', () => {
    expect(run(NOISE + doc([]), 0)).toBeNull();
  });

  it('lists at most eight findings and counts the rest, so the excerpt keeps its header', () => {
    const v = run(doc(Array.from({ length: 12 }, (_, i) => finding({ location: `src/m${i}.ts:1` }))), 1);
    expect(v?.note.split('\n').length).toBeLessThanOrEqual(10);
    expect(v?.note).toContain('(4 more)');
  });

  it('exit 5: the base could not be mapped, said as that and not as a finding', () => {
    const v = run(JSON.stringify({ error: { code: 'UK_BASELINE_INVALID', message: 'HEAD^ is not a commit' } }), 5);
    expect(v?.note).toContain('base could not be mapped');
    expect(v?.note).toContain('HEAD^ is not a commit');
  });

  it('a pass from an unknot that ignores --baseline (older than 0.4.0, no schema_version) fails, naming the version needed', () => {
    const v = run('{"stats":{"findings":3},"findings":[]}', 0);
    expect(v?.status).toBe('FAILED');
    expect(v?.note).toContain('unknot 0.4.0 or newer');
  });

  it('a timeout says the scope was too large to map in the time, and which setting to raise', () => {
    const v = run('', null, 'TIMEOUT');
    expect(v?.note).toContain('did not finish mapping within 600 s');
    expect(v?.note).toContain('timeout_seconds');
    expect(v?.status).toBeUndefined();
  });

  it('a failure whose output is not unknot\'s document says so', () => {
    expect(run('boom', 2)?.note).toContain('unreadable');
  });
});

describe('unknotVersionProblem', () => {
  it('accepts 0.4.0 and newer, names an older one and a missing one', () => {
    expect(MIN_UNKNOT).toEqual([0, 4, 0]);
    expect(unknotVersionProblem('0.4.0\n')).toBeNull();
    expect(unknotVersionProblem('unknot 1.2.3')).toBeNull();
    expect(unknotVersionProblem('0.3.3')).toContain('older than 0.4.0');
    expect(unknotVersionProblem(null)).toContain('not installed');
    expect(unknotVersionProblem('weird')).toBeNull();
  });
});

describe('simplifyFindingsBlock', () => {
  const open = (kind: string, location: string, extra: Record<string, unknown> = {}) => ({ kind, severity: 'high', location, title: `${kind} at ${location}`, smallest_simplification: 'move it', ...extra });
  it('scenario 3: keeps unknot\'s order, drops findings outside the goal\'s scope, and caps the list', () => {
    const text = JSON.stringify({ schema_version: '1.0', findings: [open('module.hub-module', 'src/hub.ts'), open('module.dependency-cycle', 'vendor/x.ts:3'), open('local.size', 'src/big.ts:10')] });
    const block = simplifyFindingsBlock(text, ['src/**'], 2);
    expect(block).toContain('1. [high] module.hub-module src/hub.ts');
    expect(block).toContain('2. [high] local.size src/big.ts:10');
    expect(block).not.toContain('vendor/x.ts');
    expect(block).toContain('move it');
  });
  it('is null when nothing in scope, or the output is not a schema 1.x document', () => {
    expect(simplifyFindingsBlock(JSON.stringify({ schema_version: '1.0', findings: [open('a', 'docs/x.md')] }), ['src/**'], 5)).toBeNull();
    expect(simplifyFindingsBlock('nope', ['src/**'], 5)).toBeNull();
    expect(simplifyFindingsBlock(JSON.stringify({ findings: [] }), ['src/**'], 5)).toBeNull();
  });
});
