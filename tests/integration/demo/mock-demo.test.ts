/**
 * scripts/demo/run-mock-demo.sh, the offline run of the three demo goals used in CI:
 * the real controller over the fake providers and FakeGitHub. Three terminal reports.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromiumAvailable, ORBIT_ROOT } from '../../../scripts/demo/lib/example.ts';
import type { MockDemoResult } from '../../../scripts/demo/mock-demo.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const ready = canStripTypes && chromiumAvailable(ORBIT_ROOT);

let out: string;
let result: MockDemoResult;
let exit: number | null = null;
let stderr = '';

function runScript(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(join(ORBIT_ROOT, 'scripts/demo/run-mock-demo.sh'), args, { cwd: ORBIT_ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (err += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr: err }));
  });
}

beforeAll(async () => {
  if (!ready) return;
  out = mkdtempSync(join(tmpdir(), 'orbit-mock-demo-test-'));
  const r = await runScript(['--json', '--out', out]);
  exit = r.code;
  stderr = r.stderr;
  result = JSON.parse(r.stdout) as MockDemoResult;
}, 600_000);
afterAll(() => {
  if (out) rmSync(out, { recursive: true, force: true });
});

describe.skipIf(!ready)('run-mock-demo.sh', () => {
  it('exits 0 with three terminal reports', () => {
    expect(exit, stderr).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.goals.map((g) => g.goal)).toEqual(['simple', 'difficult', 'ui']);
    for (const g of result.goals) {
      expect(g.problems, g.goal).toEqual([]);
      expect(g.reportPath, g.goal).toBe(join(out, g.goal, 'final.md'));
      expect(existsSync(g.reportPath!), g.goal).toBe(true);
      expect(readFileSync(g.reportPath!, 'utf8'), g.goal).toMatch(new RegExp(`^# Orbit run ${g.runId}: SUCCEEDED`));
    }
  });

  it('simple: SUCCEEDED on a cheap route in one attempt', () => {
    const g = result.goals.find((x) => x.goal === 'simple')!;
    expect(g.state).toBe('SUCCEEDED');
    expect(g.difficulty).toBe('simple');
    expect(g.implementerAttempts).toBe(1);
    expect(g.repairs).toBe(0);
    expect(g.evidenceVerdicts).toEqual(['PASS']);
    expect(g.routes.find((r) => r.startsWith('implement:1'))).toMatch(/claude-(haiku|sonnet)/);
    expect(g.reviews).toEqual(['codex:APPROVE']);
  });

  it('difficult: SUCCEEDED after a recorded escalation and a repair', () => {
    const g = result.goals.find((x) => x.goal === 'difficult')!;
    expect(g.state).toBe('SUCCEEDED');
    expect(g.escalations.length).toBeGreaterThanOrEqual(1);
    expect(g.repairs).toBeGreaterThanOrEqual(1);
    expect(g.implementerAttempts).toBe(2);
    expect(g.evidenceVerdicts).toEqual(['FAIL', 'PASS']);
    expect(g.reviews).toEqual(['codex:APPROVE']);
    const report = readFileSync(g.reportPath!, 'utf8');
    expect(report).toMatch(/## Repairs\n\n- attempt 2: /);
    expect(report).toMatch(/escalated from/);
  });

  it('ui: SUCCEEDED after a browser failure, with a draft PR on FakeGitHub', () => {
    const g = result.goals.find((x) => x.goal === 'ui')!;
    expect(g.state).toBe('SUCCEEDED');
    expect(g.evidenceVerdicts).toEqual(['FAIL', 'PASS']);
    expect(g.repairs).toBeGreaterThanOrEqual(1);
    expect(g.reviews).toEqual(['codex:APPROVE']);
    expect(g.pr).toMatchObject({ draft: true, branch: g.branch });
    expect(g.branch).toBe(`orbit/${g.runId}`);
    const report = readFileSync(g.reportPath!, 'utf8');
    expect(report).toMatch(/pull request: .*#?\d/);
  });

  it('opens a draft pull request for every run and never merges', () => {
    for (const g of result.goals) expect(g.pr, g.goal).toMatchObject({ draft: true });
    expect(new Set(result.goals.map((g) => g.pr!.number)).size).toBe(3);
  });
});

describe('run-mock-demo.sh arguments', () => {
  it('rejects an unknown goal before doing anything', async () => {
    const r = await runScript(['--goals', 'nope']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown goal/);
  });

  it('prints its usage', async () => {
    const r = await runScript(['--help']);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/run-mock-demo\.sh \[--out DIR\]/);
  });
});
