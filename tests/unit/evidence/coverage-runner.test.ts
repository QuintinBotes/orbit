import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualClock, type Clock } from '../../../src/core/clock.ts';
import { createRun, requestCancel } from '../../../src/controller/run-store.ts';
import { atomicWriteJson } from '../../../src/core/fsx.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider, WrappedCommand } from '../../../src/isolation/types.ts';
import { checkEnv, configHashFor, assertRunPolicy, reattachCheck, resumeChecks, runChecks, INSTALL_CHECK_ID } from '../../../src/evidence/runner.ts';
import { getCheckRun, listCheckRuns, planCheckRun } from '../../../src/evidence/store.ts';
import { checkConfigHash } from '../../../src/policy/snapshot.ts';
import { openDb } from '../../../src/storage/db.ts';
import { checkDef, nodeCheck, write } from './fixtures.ts';
import { checkDirOf, pidGone, readText, runnerEnv, waitFor, type RunnerEnv } from '../../integration/evidence/harness.ts';

const envs: RunnerEnv[] = [];
async function setup(checks: Parameters<typeof runnerEnv>[0], opts?: Parameters<typeof runnerEnv>[1]): Promise<RunnerEnv> {
  const e = await runnerEnv(checks, opts);
  envs.push(e);
  return e;
}
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const e of envs.splice(0)) await e.close();
});
const run = (e: RunnerEnv, ids: string[], extra: Record<string, unknown> = {}) => runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ids, ...extra });

/** A clock that does real work in sleep(), so a test can act between two polls of the supervisor. */
function scriptedClock(onSleep: (n: number) => Promise<void>, tickMs = 0): Clock & { advance(ms: number): void } {
  let t = 1_700_000_000_000;
  let n = 0;
  return {
    // With an abort signal the supervisor skips sleep() altogether, so a clock that must move on its own ticks when read.
    now: () => (t += tickMs),
    advance: (ms) => void (t += ms),
    async sleep(ms: number) {
      await onSleep(++n);
      t += ms;
    },
  };
}
const pidsOf = (e: RunnerEnv, id: string) => JSON.parse(readFileSync(join(checkDirOf(e, id), 'pid.json'), 'utf8')) as { shimPid: number; childPgid: number };

describe('trusted definitions and policy', () => {
  it('configHashFor refuses a definition that differs from the recorded hash and accepts an unrecorded one', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    const def = e.run.snapshot.config.checks.ok!;
    expect(configHashFor(e.run.snapshot, def)).toBe(checkConfigHash(def));
    expect(() => configHashFor(e.run.snapshot, { ...def, command: ['node', '-e', 'pwned'] })).toThrow(expect.objectContaining({ code: 'POLICY_TAMPERED', details: { checkId: 'ok' } }));
    const generated = { ...def, id: 'generated' };
    expect(configHashFor(e.run.snapshot, generated)).toBe(checkConfigHash(generated));
  });

  it('assertRunPolicy refuses a run that has no row', () => {
    const db = openDb(':memory:');
    const snapshot = { config: {} } as never;
    expect(() => assertRunPolicy(db, { id: 'orb-none', policyHash: 'sha256:x' }, snapshot)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }));
    db.close();
  });

  it('refuses a generated definition whose id differs from its key or is not safe in a file name, and a policy-defined id', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    const gen = checkDef('real-id');
    await expect(run(e, ['key'], { definitions: { key: gen } })).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('carries the id "real-id"') });
    const evil = checkDef('../evil');
    await expect(run(e, ['../evil'], { definitions: { '../evil': evil } })).rejects.toMatchObject({ code: 'CONFIG_INVALID', message: expect.stringContaining('not safe to use in a file name') });
    await expect(run(e, ['ok'], { definitions: { ok: checkDef('ok') } })).rejects.toMatchObject({ code: 'POLICY_DENIED', details: expect.objectContaining({ rule: 'checks.trusted-only' }) });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(0);
  });

  it('refuses a cwd that does not exist in the checkout', async () => {
    const e = await setup([nodeCheck('ghost-cwd', '', { cwd: 'does/not/exist' })]);
    await expect(run(e, ['ghost-cwd'])).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringContaining('check cwd does/not/exist does not exist in the checkout') });
  });

  it('a result recorded under another configuration of the same generated check is not reused', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    const first = checkDef('gen', { command: [process.execPath, '-e', 'console.log("one")'] });
    const second = checkDef('gen', { command: [process.execPath, '-e', 'console.log("two")'] });
    const [a] = await run(e, ['gen'], { definitions: { gen: first } });
    const [b] = await run(e, ['gen'], { definitions: { gen: second } });
    expect(b!.id).not.toBe(a!.id);
    expect(readFileSync(a!.logPath, 'utf8')).toBeDefined();
    expect(b!.binding.checkConfigHash).not.toBe(a!.binding.checkConfigHash);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'gen' })).toHaveLength(2);
  });
});

describe('checkEnv', () => {
  const dirs = { homeDir: '/h', tmpDir: '/t', artifactsDir: '/a' };

  it('falls back to a minimal PATH when the host has none, and lets the check override anything', () => {
    vi.stubEnv('PATH', undefined as unknown as string);
    expect(checkEnv(checkDef('x'), dirs).PATH).toBe('/usr/bin:/bin');
    expect(checkEnv(checkDef('x', { env: { PATH: '/mine', EXTRA: '1' } }), dirs, '/host')).toMatchObject({ PATH: '/mine', EXTRA: '1', HOME: '/h', ORBIT_CHECK_ID: 'x' });
    expect(checkEnv(checkDef('x'), dirs, '/host').PATH).toBe('/host');
  });
});

describe('reattaching rows left by another owner', () => {
  it('refuses a check run that belongs to another run', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    createRun(e.run.db, { id: 'orb-other', repoRoot: e.r.repo, goal: 'g', mode: 'autonomous', policyHash: e.run.policyHash, policyPath: '/p' }, e.ctx.clock);
    const row = planCheckRun(e.run.db, { runId: 'orb-other', candidateId: null, checkId: 'ok', kind: 'command', treeHash: e.candidate.treeHash, checkConfigHash: e.run.snapshot.check_config_hashes.ok!, policyHash: e.run.policyHash, command: ['node'], cwd: '/x', isolation: 'none', limitations: [] }, e.ctx.clock);
    await expect(reattachCheck(e.ctx, row.id)).rejects.toMatchObject({ code: 'INTERNAL', message: expect.stringContaining('belongs to run orb-other') });
  });

  it('closes a baseline row whose launch never produced a process as ERROR, once the launch grace has passed, and skips duplicates', async () => {
    const clock = new ManualClock();
    const e = await setup([nodeCheck('ok', '')], { clock });
    const plan = () => planCheckRun(e.run.db, { runId: e.run.runId, candidateId: null, checkId: 'ok', kind: 'command', treeHash: e.candidate.treeHash, checkConfigHash: e.run.snapshot.check_config_hashes.ok!, policyHash: e.run.policyHash, command: ['node'], cwd: e.checkoutDir, isolation: 'none', limitations: [] }, clock);
    const first = plan();
    plan(); // a second open row for the same check: one reattach covers the group
    clock.advance(11_000);
    const results = await resumeChecks({ ...e.ctx, clock });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ checkId: 'ok', status: 'ERROR' });
    expect(readFileSync(results[0]!.logPath, 'utf8')).toContain('disappeared');
    expect(getCheckRun(e.run.db, first.id).candidateId).toBeNull();
  });

  it('needs a recorded definition for a generated check, and refuses one that does not match the recorded hash', async () => {
    const clock = new ManualClock();
    const e = await setup([nodeCheck('ok', '')], { clock });
    const def = checkDef(INSTALL_CHECK_ID, { command: [process.execPath, '-e', ''] });
    const row = planCheckRun(e.run.db, { runId: e.run.runId, candidateId: null, checkId: INSTALL_CHECK_ID, kind: 'command', treeHash: e.candidate.treeHash, checkConfigHash: checkConfigHash(def), policyHash: e.run.policyHash, command: def.command, cwd: e.checkoutDir, isolation: 'none', limitations: [] }, clock);
    await expect(reattachCheck({ ...e.ctx, clock }, row.id)).rejects.toMatchObject({ code: 'POLICY_DENIED', message: expect.stringContaining('no generated definition was recorded') });

    const file = join(e.run.runDir, 'baseline', INSTALL_CHECK_ID, 'definition.json');
    mkdirSync(join(e.run.runDir, 'baseline', INSTALL_CHECK_ID), { recursive: true });
    atomicWriteJson(file, { ...def, command: [process.execPath, '-e', 'pwned'] });
    await expect(reattachCheck({ ...e.ctx, clock }, row.id)).rejects.toMatchObject({ code: 'POLICY_TAMPERED', message: expect.stringContaining('does not match the configuration hash') });
  });
});

describe('the supervisor, with the clock under test control', () => {
  it('stops a check its own supervisor never stopped once the backstop passes, killing the shim and the group', async () => {
    let pids: { shimPid: number; childPgid: number } | null = null;
    let e!: RunnerEnv;
    const clock = scriptedClock(async () => {
      // Real time passes only until the shim has started the check; then the clock races to the backstop.
      if (!pids) {
        await waitFor(() => existsSync(join(checkDirOf(e, 'hang'), 'pid.json')));
        pids = pidsOf(e, 'hang');
      }
    });
    e = await setup([nodeCheck('hang', 'setInterval(()=>{},1000)', { timeout_seconds: 1 })], { clock });
    const [r] = await run(e, ['hang'], { clock, pollMs: 20, killGraceMs: 500 });
    expect(r).toMatchObject({ status: 'TIMEOUT', timedOut: true });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('its supervisor did not stop it');
    await waitFor(() => pidGone(pids!.shimPid), 5_000);
  }, 30_000);

  it('gives a cancelled check a recorded outcome even when its shim is stopped and cannot answer', async () => {
    const ac = new AbortController();
    let shim = 0;
    let e!: RunnerEnv;
    const clock = scriptedClock(async (n) => {
      if (n === 1) {
        await waitFor(() => existsSync(join(checkDirOf(e, 'deaf'), 'pid.json')));
        shim = pidsOf(e, 'deaf').shimPid;
        process.kill(shim, 'SIGSTOP');
        ac.abort();
      }
    }, 20);
    e = await setup([nodeCheck('deaf', 'setInterval(()=>{},1000)', { timeout_seconds: 120 })], { clock });
    const [r] = await run(e, ['deaf'], { clock, pollMs: 20, killGraceMs: 500, signal: ac.signal });
    expect(r).toMatchObject({ status: 'CANCELLED', cancelled: true });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('did not report an exit record');
    await waitFor(() => pidGone(shim), 5_000);
  }, 30_000);

  it('records CANCELLED, and kills what is left of the group, when the shim died before the cancellation reached it', async () => {
    const ac = new AbortController();
    let e!: RunnerEnv;
    let group = 0;
    const clock = scriptedClock(async (n) => {
      if (n === 1) {
        await waitFor(() => existsSync(join(checkDirOf(e, 'orphan'), 'pid.json')));
        const p = pidsOf(e, 'orphan');
        group = p.childPgid;
        process.kill(p.shimPid, 'SIGKILL');
        await waitFor(() => pidGone(p.shimPid));
        ac.abort();
      }
    }, 20);
    e = await setup([nodeCheck('orphan', 'setInterval(()=>{},1000)', { timeout_seconds: 120 })], { clock });
    const [r] = await run(e, ['orphan'], { clock, pollMs: 20, killGraceMs: 500, signal: ac.signal });
    expect(r).toMatchObject({ status: 'CANCELLED', cancelled: true });
    await waitFor(() => pidGone(group), 5_000);
  }, 30_000);
});

describe('supervising with the defaults', () => {
  it('uses the default poll interval and kill grace when the context sets neither', async () => {
    const e = await setup([nodeCheck('quick', 'console.log("hi")')]);
    const [r] = await run(e, ['quick'], { pollMs: undefined, killGraceMs: undefined });
    expect(r).toMatchObject({ status: 'PASSED' });
  });

  it('records a check as lost, not cancelled, when its shim dies while nobody asked for a cancellation', async () => {
    let e!: RunnerEnv;
    let group = 0;
    const clock = scriptedClock(async (n) => {
      if (n === 1) {
        await waitFor(() => existsSync(join(checkDirOf(e, 'vanish'), 'pid.json')));
        const p = pidsOf(e, 'vanish');
        group = p.childPgid;
        process.kill(p.shimPid, 'SIGKILL');
        await waitFor(() => pidGone(p.shimPid));
      }
    });
    e = await setup([nodeCheck('vanish', 'setInterval(()=>{},1000)', { timeout_seconds: 120 })], { clock });
    const [r] = await run(e, ['vanish'], { clock, pollMs: 20, killGraceMs: 500 });
    expect(r).toMatchObject({ status: 'ERROR', cancelled: false });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('disappeared');
    await waitFor(() => pidGone(group), 5_000);
  }, 30_000);
});

describe('flaky reruns that are interrupted', () => {
  /** An AbortSignal stand-in that reads as aborted once any check run has failed. */
  function afterFirstFailure(e: RunnerEnv) {
    const failed = () => e.run.db.get("SELECT 1 AS x FROM check_runs WHERE status = 'FAILED'") !== undefined;
    return { get aborted() { return failed(); }, addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
  }

  it('does not start a rerun once the run is cancelled after the first failure', async () => {
    const e = await setup([nodeCheck('f', 'console.error("Error: boom"); process.exit(1)', { flaky_reruns: 2 })]);
    const [r] = await run(e, ['f'], { signal: afterFirstFailure(e) });
    expect(r).toMatchObject({ status: 'FAILED' });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'f' })).toHaveLength(1);
  });

  it('stops with a detach error, whatever the reason was, instead of starting a rerun', async () => {
    const e = await setup([nodeCheck('f', 'console.error("Error: boom"); process.exit(1)', { flaky_reruns: 2 })]);
    const failed = () => e.run.db.get("SELECT 1 AS x FROM check_runs WHERE status = 'FAILED'") !== undefined;
    const detachSignal = { get aborted() { return failed(); }, reason: 'lease lost', addEventListener() {}, removeEventListener() {} } as unknown as AbortSignal;
    await expect(run(e, ['f'], { detachSignal })).rejects.toMatchObject({ code: 'CANCELLED', details: { detached: true }, message: expect.stringContaining('supervision stopped (supervision stopped)') });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'f' })).toHaveLength(1);
  });
});

describe('launch failures', () => {
  function counting(): { provider: IsolationProvider; cleaned: () => number } {
    let cleaned = 0;
    const inner = new NoIsolation();
    const provider: IsolationProvider = {
      kind: inner.kind,
      wrap: (argv, profile, opts) => {
        const w: WrappedCommand = inner.wrap(argv, profile, opts);
        return { ...w, cleanup: () => { cleaned++; w.cleanup(); } };
      },
    } as IsolationProvider;
    return { provider, cleaned: () => cleaned };
  }

  it('records ERROR, cleans up the wrapper and rethrows when the shim cannot be started', async () => {
    const c = counting();
    const e = await setup([nodeCheck('ok', '')], { isolation: c.provider });
    // The shim's output file cannot be opened: a directory is in its place.
    mkdirSync(join(checkDirOf(e, 'ok'), 'shim.out'), { recursive: true });
    await expect(run(e, ['ok'])).rejects.toThrow();
    const [row] = listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'ok' });
    expect(row).toMatchObject({ status: 'ERROR' });
    expect(row!.excerpt).toContain('could not start the check');
    expect(c.cleaned()).toBe(1);
  });

  it('cleans up the wrapper and rethrows when the intent cannot be recorded', async () => {
    const c = counting();
    const e = await setup([nodeCheck('ok', '')], { isolation: c.provider });
    const failing = { ...e.run.db, tx: () => { throw new Error('disk full'); } };
    await expect(run(e, ['ok'], { db: failing })).rejects.toThrow('disk full');
    expect(c.cleaned()).toBe(1);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(0);
  });
});

describe('checks that change the checkout', () => {
  it('names the first ten changed files and counts the rest', async () => {
    const files = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`src/f${String(i).padStart(2, '0')}.txt`, `v${i}\n`]));
    const e = await setup(
      [nodeCheck('rewrite', 'const fs=require("fs");for(const f of fs.readdirSync("src")) fs.writeFileSync("src/"+f,"changed\\n")'), nodeCheck('next', '')],
      { files: { 'README.md': 'acme\n', ...files } },
    );
    const [first] = await run(e, ['rewrite']);
    expect(first!.status).toBe('PASSED');
    await expect(run(e, ['next'])).rejects.toMatchObject({ code: 'STALE_EVIDENCE', message: expect.stringMatching(/tracked files changed: (src\/f\d\d\.txt, ){9}src\/f\d\d\.txt, and 3 more\); check next was not started/) });
  });
});

describe('what a finished check leaves behind', () => {
  it('ends the log with a newline of its own when the output has none, and with only the footer when there is no output', async () => {
    const e = await setup([nodeCheck('bare', 'process.stdout.write("no newline")'), nodeCheck('quiet', '')]);
    const [bare, quiet] = await run(e, ['bare', 'quiet']);
    expect(readFileSync(bare!.logPath, 'utf8')).toMatch(/^no newline\n\[orbit\] check=bare status=PASSED exit=0\n$/);
    expect(readFileSync(quiet!.logPath, 'utf8')).toMatch(/^\[orbit\] check=quiet status=PASSED exit=0\n$/);
  });

  it('classifies artifacts by extension', async () => {
    const script = 'const fs=require("fs");const d=process.env.ORBIT_ARTIFACTS_DIR;for(const n of ["clip.webm","clip.mp4","trace.zip","run.log","blob.bin","report.json","shot.JPG"])fs.writeFileSync(d+"/"+n,"x")';
    const e = await setup([nodeCheck('art', script)]);
    const [r] = await run(e, ['art']);
    const kinds = Object.fromEntries(r!.artifacts.filter((a) => a.kind !== 'log' || a.path.endsWith('run.log')).map((a) => [a.path.split('/').pop()!, a.kind]));
    expect(kinds).toMatchObject({ 'clip.webm': 'video', 'clip.mp4': 'video', 'trace.zip': 'trace', 'run.log': 'log', 'blob.bin': 'other', 'report.json': 'report', 'shot.JPG': 'screenshot' });
  });

  it('keeps at most the first 32 MiB of raw output and says what it dropped', async () => {
    const e = await setup([nodeCheck('huge', 'const b=Buffer.alloc(1<<20,97);for(let i=0;i<34;i++)process.stdout.write(b)')]);
    const [r] = await run(e, ['huge'], { maxOutputBytes: 64 * 1024 * 1024 });
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).toContain('[orbit: output truncated: 2097152 bytes dropped]');
    expect(statSync(r!.logPath).size).toBeLessThan(33 * 1024 * 1024);
  }, 60_000);
});

describe('reattaching with a partly written shim record', () => {
  it('finds the shim through its pid file when the launch record is gone, and ignores records with another token', async () => {
    const e = await setup([nodeCheck('long', 'const fs=require("fs");const f=process.env.ORBIT_ARTIFACTS_DIR+"/go";const t=setInterval(()=>{if(fs.existsSync(f)){clearInterval(t);console.log("done")}},50)', { timeout_seconds: 120 })]);
    const ac = new AbortController();
    const pending = run(e, ['long'], { detachSignal: ac.signal });
    const dir = checkDirOf(e, 'long');
    await waitFor(() => existsSync(join(dir, 'pid.json')));
    ac.abort(new Error('lease lost'));
    await pending.then(() => null, () => null);
    rmSync(join(dir, 'launch.json'));
    write(join(dir, 'artifacts', 'go'), '1');
    const [row] = listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'long' });
    const result = await reattachCheck(e.ctx, row!.id);
    expect(result).toMatchObject({ id: row!.id, status: 'PASSED' });
    expect(readText(result.logPath)).toContain('done');
  });
});

describe('cancellation recorded in the database', () => {
  it('starts nothing for a run whose cancellation is already durable, and returns no results', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    requestCancel(e.run.db, e.run.runId, 'test', e.ctx.clock);
    expect(await run(e, ['ok'])).toEqual([]);
  });
});

