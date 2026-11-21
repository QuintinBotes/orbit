/**
 * Issue #172: `orbit bench --tier lab` scores this Orbit version on scenarios replayed from its own fixed issues, with
 * the fake providers and the real controller. CI runs the whole lab (the "Lab bench" step of ci.yml); these tests run a
 * few scenarios through the command to show what a scorecard holds, that it is the same on every run, that a scenario
 * whose fixed outcome no longer holds fails the command by name, and the comparison with one stage off.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../../src/cli/cli.ts';
import { memoryIo } from '../../src/cli/io.ts';
import { ORBIT_VERSION } from '../../src/cli/version.ts';
import { LAB_SCENARIOS, type LabScenario } from '../../src/bench/scenarios.ts';
import { stableJson, TIMESTAMP_FIELDS, type Scorecard } from '../../src/bench/scorecard.ts';
import { ORBIT_ROOT, READY } from './helpers/lab.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'orbit-bench-acc-'));
  dirs.push(d);
  return d;
};

async function bench(argv: string[], labScenarios?: readonly LabScenario[]): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const home = tmp();
  const code = await main(['bench', '--tier', 'lab', ...argv], { io, cwd: ORBIT_ROOT, homeDir: home, orbitHome: join(home, '.orbit'), env: { ...process.env, HOME: home }, seams: { bench: { root: ORBIT_ROOT, ...(labScenarios ? { labScenarios } : {}) } } });
  return { code, out: io.stdout, err: io.stderr };
}

const card = (dir: string, name = `orbit-${ORBIT_VERSION}-lab.json`): Scorecard => JSON.parse(readFileSync(join(dir, name), 'utf8')) as Scorecard;
const withoutTimestamps = (c: Scorecard): string => stableJson({ ...c, ...Object.fromEntries(TIMESTAMP_FIELDS.map((f) => [f, null])) });
const scenario = (id: string): LabScenario => LAB_SCENARIOS.find((s) => s.id === id)!;

describe.skipIf(!READY)('acceptance: orbit bench, lab tier (issue #172)', () => {
  it('User Story 1, scenario 1 and its independent test: each scenario reports pass or fail, the failure class, attempts and simulated spend, and two runs give the same scorecard', async () => {
    const only = ['--only', 'verified-candidate-offered,turn-cap-diagnosed'];
    const [a, b] = [tmp(), tmp()];
    const first = await bench([...only, '--out', a]);
    expect(first.code, first.err).toBe(0);
    const second = await bench([...only, '--out', b]);
    expect(second.code, second.err).toBe(0);

    const one = card(a);
    expect(one).toMatchObject({ tier: 'lab', orbit_version: ORBIT_VERSION, headline: { valid: 2, passed: 2, pass_rate: 1 } });
    expect(one.scenarios.map((r) => [r.id, r.issue, r.result, r.end_state, r.failure_class, r.attempts])).toEqual([
      ['turn-cap-diagnosed', '#144', 'pass', 'SUCCEEDED', null, 2],
      ['verified-candidate-offered', '#169', 'pass', 'BLOCKED', 'review-dispute', 1],
    ]);
    for (const r of one.scenarios) expect(r.spend_usd).toBeGreaterThan(0);
    expect(first.out).toMatch(/^verified-candidate-offered\s+#169\s+PASS\s+BLOCKED\s+review-dispute\s+1\s+\$\d+\.\d{4}$/m);
    expect(withoutTimestamps(card(b))).toBe(withoutTimestamps(one));
  }, 300_000);

  it('User Story 1, scenario 2: a scenario whose fixed outcome no longer holds fails the command, which names the scenario and its issue', async () => {
    // The #169 scenario, run where its reviewer never answers: the run cannot end the way the fix guarantees.
    const s = scenario('verified-candidate-offered');
    const broken: LabScenario = { ...s, roles: { ...s.roles, reviewer: [{ outcome: 'model_rejected' }] } };
    const r = await bench(['--out', tmp()], [broken]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('orbit bench: 1 lab scenario(s) failed: verified-candidate-offered (issue #169)');
    expect(r.out).toMatch(/^verified-candidate-offered\s+#169\s+FAIL\s/m);
    expect(r.out).toMatch(/verified-candidate-offered \(fail\):\n {2}- /);
  }, 300_000);

  it('User Story 3, scenario 1: with --without diagnosis the report shows pass rate and spend with and without the stage', async () => {
    const out = tmp();
    const r = await bench(['--only', 'turn-cap-diagnosed', '--without', 'diagnosis', '--out', out]);
    expect(r.code, r.err).toBe(0);
    const c = card(out, `orbit-${ORBIT_VERSION}-lab-without-diagnosis.json`);
    expect(c.comparison!.stage).toBe('diagnosis');
    expect(c.comparison!.with).toMatchObject({ valid: 1, passed: 1 });
    expect(c.comparison!.without.valid).toBe(1);
    // Without the stage no verifier session runs, so the same scenario spends less.
    expect(c.comparison!.without.spend_usd).toBeLessThan(c.comparison!.with.spend_usd);
    expect(r.out).toContain('With and without the diagnosis stage:');
    expect(r.out).toMatch(/^with\s+1\s+1\s+100\.0%/m);
    expect(r.out).toMatch(/^without diagnosis\s+1\s+\d\s+\d+\.\d%/m);
  }, 300_000);
});
