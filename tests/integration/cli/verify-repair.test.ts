/**
 * `orbit verify` and `orbit repair` end to end (G1), in this process, over the real controller loop,
 * git repository, SQLite state, check runner and the fake provider CLIs.
 */
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import type { CliContext, CliSeams } from '../../../src/cli/context.ts';
import { systemClock } from '../../../src/core/clock.ts';
import { acquireLease, getRun, listRuns, releaseLease, transition } from '../../../src/controller/run-store.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { listEvidenceReports } from '../../../src/evidence/store.ts';
import { baseScenario, DIAGNOSIS, implementMul, labDeps, makeLab, seedRegistry, waitFor, writeScenario, type Lab } from '../controller/harness.ts';

const labs: Lab[] = [];
function lab(opts: Parameters<typeof makeLab>[0] = {}): Lab {
  const l = makeLab(opts);
  labs.push(l);
  return l;
}
afterEach(() => labs.splice(0).forEach((l) => l.close()));

function seams(l: Lab): CliSeams {
  return {
    pollMs: 20,
    controller: { tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300, shutdownGraceMs: 400, startGraceMs: 2_000 },
    controllerDeps: (input) => {
      seedRegistry(input.db!);
      // Deterministic across machines: the built-in secret patterns, not whatever gitleaks is installed.
      return { ...labDeps(l, input.db), gitleaksPath: null };
    },
  };
}

// A token shape the built-in scanner knows (github-token), assembled at runtime so no token-shaped literal is in the source.
const FIXTURE_TOKEN = ['gh', 'p_', 'A1b2C3d4'.repeat(5)].join('');

async function cli(l: Lab, argv: string[], over: Partial<CliContext> = {}) {
  const io = memoryIo();
  const code = await main(argv, { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome, HOME: l.base }, user: 'alice', seams: seams(l), ...over });
  return { code, out: io.stdout, err: io.stderr };
}

const GOAL = 'Add a mul function to the calculator.';


/** Runs the controller in this process until the diagnosis worker is mid-flight, then interrupts: the run is paused at DIAGNOSING with FAIL evidence. */
async function failedPausedRun(l: Lab): Promise<string> {
  // The first implementation is wrong (mul adds), the second is right; the diagnosis takes a while so the interrupt lands inside it.
  writeScenario(l, baseScenario({ implementer: [implementMul('+'), implementMul('*')], verifier: [{ ...DIAGNOSIS, sleepMs: 4_000 }] }));
  const signals = new EventEmitter();
  const started = cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath], { seams: { ...seams(l), signals } });
  const id = await waitFor(() => listRuns(l.db(), { limit: 1 })[0]?.id);
  await waitFor(() => listWorkers(l.db(), { runId: id, role: 'verifier' }).find((w) => w.state === 'RUNNING'), 60_000);
  signals.emit('SIGINT');
  const r = await started;
  expect(r.code, `${r.out}\n${r.err}`).toBe(20);
  expect(getRun(l.db(), id)).toMatchObject({ state: 'DIAGNOSING', paused: true });
  return id;
}

describe('orbit verify', () => {
  it('prints a verdict per criterion with its evidence for the newest run, exits 0 on PASS and moves nothing', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    const done = await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    expect(done.code, `${done.out}\n${done.err}`).toBe(0);
    const id = listRuns(l.db(), { limit: 1 })[0]!.id;
    const before = getRun(l.db(), id);

    const r = await cli(l, ['verify']);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toMatch(new RegExp(`run ${id}  candidate 1  tree [0-9a-f]{12}  verdict PASS`));
    expect(r.out).toMatch(/AC-1  supported\s+mul\(a, b\) returns the product/);
    expect(r.out).toMatch(/\n {6}evidence: \S+/);
    expect(r.out).toMatch(/unit  PASSED \(exit 0\)/);

    const after = getRun(l.db(), id);
    expect({ state: after.state, version: after.version }).toEqual({ state: before.state, version: before.version });
    const j = JSON.parse((await cli(l, ['verify', id, '--json'])).out) as { verdict: string; exit_code: number; criteria: { id: string; status: string; artifacts: string[] }[] };
    expect(j).toMatchObject({ verdict: 'PASS', exit_code: 0 });
    expect(j.criteria[0]).toMatchObject({ id: 'AC-1', status: 'supported' });
    expect(j.criteria[0]!.artifacts.length).toBeGreaterThan(0);
  }, 120_000);

  it('exits 14 on FAIL, naming the unsupported criterion, without moving a paused run', async () => {
    const l = lab();
    const id = await failedPausedRun(l);
    const r = await cli(l, ['verify', id]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(14);
    expect(r.out).toMatch(/verdict FAIL/);
    expect(r.out).toMatch(/AC-1  unsupported/);
    expect(r.out).toMatch(/unit  FAILED \(exit 1\)/);
    expect(r.out).toContain(`orbit repair ${id}`);
    expect(getRun(l.db(), id)).toMatchObject({ state: 'DIAGNOSING', paused: true });
    // Leave nothing running behind the test.
    expect((await cli(l, ['cancel', id])).code).toBe(0);
  }, 120_000);

  it('judges a secret finding waived by static_security.exceptions the way the run did: exit 0 and the same evidence as the run report (G47)', async () => {
    const l = lab({
      tweak: (c) => {
        c.static_security = {
          block_severities: ['critical', 'high'],
          exceptions: [{ rule_id: 'github-token', path_glob: 'tests/fixtures/**', reason: 'revoked token used by the acme parser fixture', expires: null }],
        };
      },
    });
    writeScenario(l, baseScenario({ implementer: [implementMul('*', [{ op: 'write', path: 'tests/fixtures/token.txt', content: `${FIXTURE_TOKEN}\n` }])] }));
    const done = await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    expect(done.code, `${done.out}\n${done.err}`).toBe(0);
    const id = listRuns(l.db(), { limit: 1 })[0]!.id;
    const own = listEvidenceReports(l.db(), id).at(-1)!.report;
    expect(own.verdict).toBe('PASS');

    const r = await cli(l, ['verify', id, '--json']);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const j = JSON.parse(r.out) as { verdict: string; fail_reasons: string[]; unverified: string[] };
    expect(j.verdict).toBe(own.verdict);
    expect(j.fail_reasons).toEqual([]);
    expect([...j.unverified].sort()).toEqual([...own.unverified].sort());
  }, 120_000);

  it('refuses while a live controller owns the run', async () => {
    const l = lab();
    writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
    await cli(l, ['run', '--goal', GOAL, '--foreground', '--policy', l.configPath]);
    const id = listRuns(l.db(), { limit: 1 })[0]!.id;
    acquireLease(l.db(), id, 'live-controller', 60_000, systemClock);
    const r = await cli(l, ['verify', id]);
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/owned by a live controller \(live-controller\)/);
    releaseLease(l.db(), id, 'live-controller');
  }, 120_000);
});

describe('orbit repair', () => {
  it('moves a BLOCKED run with FAIL evidence to DIAGNOSING and the controller completes the repair', async () => {
    const l = lab();
    const id = await failedPausedRun(l);
    // The run was parked BLOCKED while its failure was being diagnosed.
    acquireLease(l.db(), id, 'prep', 60_000, systemClock);
    transition(l.db(), { runId: id, to: 'BLOCKED', ownerId: 'prep', reason: 'parked for the test', actor: 'prep', patch: { outcomeReason: 'waiting for a person' } }, systemClock);
    releaseLease(l.db(), id, 'prep');
    expect(getRun(l.db(), id)).toMatchObject({ state: 'BLOCKED', paused: true });

    const r = await cli(l, ['repair', id, '--foreground', '--policy', l.configPath]);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    expect(r.out).toMatch(/repairing failure \S+; the controller writes the brief to \.orbit\/runs\/orb-\S+\/briefs\/attempt-2\.json/);
    const t = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND from_state = 'BLOCKED' AND to_state = 'DIAGNOSING'", id);
    expect((JSON.parse(t!.data_json) as { reason: string }).reason).toMatch(/^repair requested by alice: fp:/);
    expect(r.out).toMatch(/-> SUCCEEDED/);
    expect(getRun(l.db(), id).state).toBe('SUCCEEDED');
    const ev = l.db().get<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'run.repair-requested'", id);
    expect(JSON.parse(ev!.data_json)).toMatchObject({ from: 'BLOCKED' });
  }, 180_000);

  it('hands a paused run in another working state to DIAGNOSING too, and leaves it to the service without --foreground', async () => {
    const l = lab();
    const id = await failedPausedRun(l);
    // Pretend the pause happened one stage earlier, in VERIFYING.
    acquireLease(l.db(), id, 'prep', 60_000, systemClock);
    transition(l.db(), { runId: id, to: 'REPAIRING', ownerId: 'prep', reason: 'prepared', actor: 'prep' }, systemClock);
    transition(l.db(), { runId: id, to: 'VERIFYING', ownerId: 'prep', reason: 'prepared', actor: 'prep' }, systemClock);
    releaseLease(l.db(), id, 'prep');
    const r = await cli(l, ['repair', id, '--json']);
    expect(r.code, `${r.out}\n${r.err}`).toBe(0);
    const j = JSON.parse(r.out) as { state: string; fingerprint: string; brief_path: string; service_running: boolean };
    expect(j).toMatchObject({ state: 'DIAGNOSING', service_running: false });
    expect(j.brief_path).toMatch(/^\.orbit\/runs\/orb-.*\/briefs\/attempt-\d+\.json$/);
    expect(getRun(l.db(), id)).toMatchObject({ state: 'DIAGNOSING', paused: false });
    expect((await cli(l, ['cancel', id])).code).toBe(0);
  }, 120_000);

  it('turns a description into a repair run with the goal "Repair: <text>"', async () => {
    const l = lab();
    const r = await cli(l, ['repair', 'the', 'export', 'test', 'fails', 'on', 'empty', 'input', '--detach', '--policy', l.configPath, '--json']);
    expect(r.code, r.err).toBe(0);
    const { run_id } = JSON.parse(r.out) as { run_id: string };
    expect(getRun(l.db(), run_id).goal).toBe('Repair: the export test fails on empty input');
  });
});
