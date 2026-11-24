// Issue #232: the simplicity gate. A check whose command is `unknot diagnose --baseline <base> --fail-on new:high --json`
// fails a candidate that adds a high-severity finding, names each finding, and never fails on what the base already had.
import { describe, expect, it } from 'vitest';
import { isSimplicityCheck, judgeSimplicity, MIN_UNKNOT, simplifyFindingsBlock, unknotProjectProblem, unknotVersionProblem, type UnknotProbe } from '../../../src/evidence/simplicity.ts';
import { isTestCommandCheck } from '../../../src/evidence/fail-before.ts';
import { defaultCheck } from '../../../src/policy/config.ts';

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
    expect(['simplicity', 'simplicity-gate', 'simplicity-a-b'].map(isSimplicityCheck)).toEqual([true, true, true]);
    // Exactly `simplicity` or `simplicity-...`, case-sensitive: other names keep being ordinary checks.
    expect(['lint', 'simplicity2', 'not-simplicity', 'Simplicity', 'Simplicity_lint', 'simplicity_lint', 'simplicity.x', 'simplicity:y'].map(isSimplicityCheck)).toEqual(Array(8).fill(false));
  });
});

describe('judgeSimplicity', () => {
  it('scenario 1: exit 1 names each new finding with its kind, location and evidence', () => {
    const v = run(NOISE + doc([finding()]), 1);
    expect(v?.note).toContain('simplicity gate: 1 new finding against the base (1 high-severity)');
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

  it('counts from baseline.new, says how many it shows, and lists lower severities after the high ones', () => {
    const low = finding({ severity: 'low', kind: 'local.size', location: 'src/big.ts:1', title: 'big' });
    const d = JSON.parse(doc([low, finding()])) as { baseline: { new: number } };
    d.baseline.new = 40;
    const v = run(JSON.stringify(d), 1);
    const lines = v!.note.split('\n');
    expect(lines[0]).toBe('simplicity gate: 40 new findings against the base (1 high-severity), showing 2');
    expect(lines[1]).toContain('[high] module.dependency-cycle');
    expect(lines[2]).toContain('[low] local.size');
  });

  it('parses the balanced document, so stderr after it does not turn a pass into a failure', () => {
    expect(run(`${NOISE}${doc([])}\n{"level":"warn","msg":"} trailing"}\nbye }\n`, 0)).toBeNull();
    const v = run(`${doc([finding()])}\n12:31PM INF done }\n`, 1);
    expect(v?.note).toContain('module.dependency-cycle');
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
  const ok = (output: string): UnknotProbe => ({ state: 'ok', output });
  it('accepts 0.4.0 and newer, names an older one and a missing one', () => {
    expect(MIN_UNKNOT).toEqual([0, 4, 0]);
    expect(unknotVersionProblem(ok('0.4.0\n'))).toBeNull();
    expect(unknotVersionProblem(ok('unknot 1.2.3'))).toBeNull();
    expect(unknotVersionProblem(ok('0.3.3'))).toContain('older than 0.4.0');
    expect(unknotVersionProblem({ state: 'missing' })).toContain('not installed');
  });
  it('a prerelease of 0.4.0 is older than 0.4.0', () => {
    expect(unknotVersionProblem(ok('0.4.0-beta.1'))).toContain('older than 0.4.0');
    expect(unknotVersionProblem(ok('unknot 0.4.1-rc.2'))).toBeNull();
  });
  it('output with no version fails as unreadable, never passes', () => {
    expect(unknotVersionProblem(ok('weird'))).toContain('cannot tell the version');
    expect(unknotVersionProblem(ok(''))).toContain('cannot tell the version');
  });
  it('a --version that exits non-zero says the install is broken, not missing', () => {
    const p = unknotVersionProblem({ state: 'failed', exitCode: 3 });
    expect(p).toContain('broken');
    expect(p).toContain('exit 3');
    expect(p).not.toContain('not installed');
  });
});

describe('unknotProjectProblem', () => {
  it('needs a committed unknot directory with its own .gitignore, so a check writes nothing that shows as a change', () => {
    expect(unknotProjectProblem(['src/a.ts'])).toContain('.unknot');
    expect(unknotProjectProblem(['.unknot/config.yaml'])).toContain('.unknot/.gitignore');
    expect(unknotProjectProblem(['.unknot/.gitignore', '.unknot/config.yaml'])).toBeNull();
  });
});

describe('fail-before never probes the gate', () => {
  it('a check named simplicity is not a test command check, whatever its category (a probe has no base to compare)', () => {
    expect(isTestCommandCheck({ ...defaultCheck('simplicity'), category: 'test' })).toBe(false);
    expect(isTestCommandCheck({ ...defaultCheck('unit'), category: 'test' })).toBe(true);
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
