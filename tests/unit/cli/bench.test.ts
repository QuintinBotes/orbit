import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, commandHelp, main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { ORBIT_VERSION } from '../../../src/cli/version.ts';
import type { LiveExecutor, LiveTrial } from '../../../src/bench/live.ts';
import type { Scorecard } from '../../../src/bench/scorecard.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CATALOG_20 = join(ROOT, 'tests', 'fixtures', 'bench', 'live-goals-20.json');
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'orbit-bench-cli-'));
  dirs.push(d);
  return d;
};

/** A live executor that never calls a model; it counts every call so a refusal can be shown to start nothing. */
function fakeExecutor(): LiveExecutor & { calls: string[] } {
  const calls: string[] = [];
  const t = (accepted: boolean): LiveTrial => ({ end_state: 'SUCCEEDED', failure_class: null, attempts: 1, spend_usd: 0.1, wall_ms: 2000, delivered: true, accepted, problems: [] });
  return {
    calls,
    validate: async (g) => (calls.push(`validate ${g.id}`), []),
    orbit: async (g) => (calls.push(`orbit ${g.id}`), t(true)),
    plain: async (g) => (calls.push(`plain ${g.id}`), t(g.id.endsWith('1'))),
  };
}

async function bench(argv: string[], executor: LiveExecutor = fakeExecutor()): Promise<{ code: number; out: string; err: string }> {
  const io = memoryIo();
  const home = tmp();
  const code = await main(['bench', ...argv], { io, cwd: ROOT, homeDir: home, orbitHome: join(home, '.orbit'), env: { ...process.env, HOME: home }, seams: { bench: { root: ROOT, liveExecutor: executor, labScenarios: [] } } });
  return { code, out: io.stdout, err: io.stderr };
}

describe('orbit bench (#172)', () => {
  it('FR-001, FR-006: is a command with a lab and a live tier, and its help lists the stages that can be turned off and the gates that cannot', () => {
    const def = COMMANDS.find((c) => c.name === 'bench')!;
    const help = commandHelp(def);
    expect(help).toContain('--tier <tier>');
    expect(help).toMatch(/lab \(fake providers, no model, deterministic\) or live \(real providers; spends money\)/);
    expect(help).toContain('diagnosis, fail-before (scope, secrets, verification are gates and cannot be turned off)');
  });

  it('needs a tier, and refuses options of the other tier and a stage that is a gate', async () => {
    expect((await bench([])).code).toBe(2);
    expect((await bench(['--tier', 'cloud'])).err).toMatch(/--tier must be one of lab, live/);
    expect((await bench(['--tier', 'lab', '--budget', '5'])).err).toContain('--budget is for the live tier');
    expect((await bench(['--tier', 'live', '--without', 'diagnosis', '--budget', '5', '--approved-by', 'owner'])).err).toContain('--without is for the lab tier');
    const gate = await bench(['--tier', 'lab', '--without', 'secrets']);
    expect(gate.code).toBe(2);
    expect(gate.err).toContain('--without: secrets is a gate no bench may turn off');
  });

  it('edge case: the live tier refuses to start without an explicit budget, and without the owner approval, before it reads a goal', async () => {
    const ex = fakeExecutor();
    const noBudget = await bench(['--tier', 'live', '--approved-by', 'owner', '--catalog', CATALOG_20], ex);
    expect(noBudget.code).toBe(2);
    expect(noBudget.err).toContain('the live tier spends money and needs an explicit budget: --budget <usd>');
    const zero = await bench(['--tier', 'live', '--budget', '0', '--approved-by', 'owner', '--catalog', CATALOG_20], ex);
    expect(zero.err).toContain('--budget must be a positive amount');
    const noApproval = await bench(['--tier', 'live', '--budget', '10', '--catalog', CATALOG_20], ex);
    expect(noApproval.code).toBe(2);
    expect(noApproval.err).toContain("every live run needs the owner's approval: --approved-by <name>");
    expect(ex.calls).toEqual([]);
  });

  it('US2.1, US2.2: twenty pinned goals run with the baseline write a versioned live scorecard with the pass rate, cost per accepted task and the difference to the plain session', async () => {
    const out = tmp();
    const ex = fakeExecutor();
    const r = await bench(['--tier', 'live', '--budget', '24', '--approved-by', 'owner', '--baseline', '--catalog', CATALOG_20, '--out', out], ex);
    expect(r.code, r.err).toBe(0);
    expect(r.err).toContain('live tier: 20 goal(s) x 3 runs and the plain-session baseline, 120 sessions, budget $24.00, approved by owner');
    const file = join(out, `orbit-${ORBIT_VERSION}-live.json`);
    const card = JSON.parse(readFileSync(file, 'utf8')) as Scorecard;
    expect(card).toMatchObject({ tier: 'live', orbit_version: ORBIT_VERSION, approval: { by: 'owner', budget_usd: 24 } });
    expect(card.scenarios).toHaveLength(60);
    expect(card.headline).toMatchObject({ pass_rate: 1, cost_per_pass_usd: 0.1 });
    // Goals 1, 11 pass for the plain session: 6 of 60 runs.
    expect(card.baseline).toMatchObject({ counts: { passed: 6, pass_rate: 0.1 }, difference: { pass_rate: 0.9 } });
    expect(r.out).toMatch(/^False-done rate for \S+: n\/a|^False-done rate for \S+: 0 of 60/m);
    expect(r.out).toContain('Orbit minus the plain session: pass rate +90.0 points');
    expect(r.out).toContain(`Scorecard written to ${file}`);
    expect(ex.calls.filter((c) => c.startsWith('plain'))).toHaveLength(60);
  });

  it('--only runs the named goals and writes no scorecard unless --out is given; an unknown id is refused', async () => {
    const r = await bench(['--tier', 'live', '--budget', '3', '--approved-by', 'owner', '--catalog', CATALOG_20, '--only', 'goal-2', '--json']);
    expect(r.code, r.err).toBe(0);
    const out = JSON.parse(r.out) as { scorecard: Scorecard; written: string | null };
    expect(out.written).toBeNull();
    expect(out.scorecard.scenarios.map((s) => s.id)).toEqual(['goal-2#1', 'goal-2#2', 'goal-2#3']);
    expect(existsSync(join(ROOT, 'docs', 'scorecards', `orbit-${ORBIT_VERSION}-live.json`))).toBe(false);
    expect((await bench(['--tier', 'live', '--budget', '3', '--approved-by', 'owner', '--catalog', CATALOG_20, '--only', 'goal-99'])).err).toContain('--only names no known id: goal-99');
  });

  it('FR-007: reads the false dones a person recorded for this version into the headline, and refuses a malformed false-done file', async () => {
    const dir = tmp();
    const file = join(dir, 'false-dones.json');
    writeFileSync(file, JSON.stringify([{ orbit_version: ORBIT_VERSION, ref: 'goal-1#1', found_by: 'hidden-check', link: 'https://github.com/QuintinBotes/orbit/issues/1' }]));
    const r = await bench(['--tier', 'live', '--budget', '3', '--approved-by', 'owner', '--catalog', CATALOG_20, '--only', 'goal-1', '--false-dones', file]);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain(`False-done rate for ${ORBIT_VERSION}: 1 of 3 delivered runs (33.3%)\n  goal-1#1 found by hidden-check: https://github.com/QuintinBotes/orbit/issues/1`);
    writeFileSync(file, '[{"ref": "x"}]');
    const bad = await bench(['--tier', 'live', '--budget', '3', '--approved-by', 'owner', '--catalog', CATALOG_20, '--false-dones', file]);
    expect(bad.code).not.toBe(0);
    expect(bad.err).toMatch(/false-done record 1 has an invalid orbit_version/);
  });

  it('is refused inside a worker, like every command that is not read-only', async () => {
    const io = memoryIo();
    const code = await main(['bench', '--tier', 'lab'], { io, env: { ...process.env, ORBIT_WORKER: '1' } });
    expect(code).not.toBe(0);
    expect(io.stderr).toContain('"orbit bench" is refused inside a worker');
  });
});
