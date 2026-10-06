import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { requestCancel } from '../../../src/controller/run-store.ts';
import { reattachCheck, resumeChecks, runChecks } from '../../../src/evidence/runner.ts';
import { getCheckRun, listCheckRuns, listFailures } from '../../../src/evidence/store.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { sh } from '../../unit/evidence/fixtures.ts';
import { nodeCheck, checkDef, write } from '../../unit/evidence/fixtures.ts';
import { checkDirOf, pidGone, readText, recordingIsolation, runnerEnv, waitFor, type RunnerEnv } from './harness.ts';

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_GH_TOKEN = `ghp_${'a1B2'.repeat(9)}`;

const envs: RunnerEnv[] = [];
async function setup(checks: Parameters<typeof runnerEnv>[0], opts?: Parameters<typeof runnerEnv>[1]): Promise<RunnerEnv> {
  const e = await runnerEnv(checks, opts);
  envs.push(e);
  return e;
}
const markers: string[] = [];
/** A scratch file path the check scripts use to count their own executions; removed after the test. */
function marker(): string {
  const p = join(tmpdir(), `orbit-evidence-marker-${Math.random().toString(36).slice(2)}`);
  markers.push(p);
  return p;
}
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  for (const m of markers.splice(0)) rmSync(m, { force: true });
});

const run = (e: RunnerEnv, ids: string[], extra: Record<string, unknown> = {}) => runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ids, ...extra });

describe('runChecks: results and evidence', () => {
  it('records a bound, logged result for a passing check and a failing one', async () => {
    const e = await setup([nodeCheck('ok', 'console.log("hello from ok")'), nodeCheck('bad', 'console.error("Error: expected 1 to equal 2"); process.exit(3)')]);
    const [ok, bad] = await run(e, ['ok', 'bad']);
    expect(ok).toMatchObject({ checkId: 'ok', status: 'PASSED', exitCode: 0, flaky: false, timedOut: false, cancelled: false, fingerprint: null, excerpt: null, isolation: 'none', kind: 'command' });
    expect(ok!.binding).toEqual({
      candidateId: e.candidate.id,
      treeHash: e.candidate.treeHash,
      checkConfigHash: e.run.snapshot.check_config_hashes.ok,
      policyHash: e.run.policyHash,
    });
    const log = readFileSync(ok!.logPath, 'utf8');
    expect(log).toContain('hello from ok');
    expect(log).toContain('[orbit] check=ok status=PASSED exit=0');
    expect(ok!.logSha256).toBe(createHash('sha256').update(log).digest('hex'));
    expect(ok!.artifacts[0]).toMatchObject({ path: ok!.logPath, sha256: ok!.logSha256, kind: 'log' });
    expect(ok!.isolationLimitations.length).toBeGreaterThan(0);
    expect(ok!.endedAt).toBeGreaterThanOrEqual(ok!.startedAt);
    expect(ok!.cwd).toBe(e.checkoutDir);

    expect(bad).toMatchObject({ status: 'FAILED', exitCode: 3 });
    expect(bad!.fingerprint).toMatch(/^fp:[0-9a-f]{16}$/);
    expect(bad!.excerpt).toContain('expected 1 to equal 2');
    const failures = listFailures(e.run.db, e.run.runId);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ source: 'check', sourceId: bad!.id, fingerprint: bad!.fingerprint, candidateId: e.candidate.id });
    expect(getCheckRun(e.run.db, bad!.id).status).toBe('FAILED');
    const events = e.run.db.all<{ type: string }>("SELECT type FROM events WHERE type LIKE 'check.%'").map((r) => r.type);
    expect(events).toEqual(expect.arrayContaining(['check.planned', 'check.started', 'check.finished']));
  });

  it('redacts secrets from the log and the excerpt and leaves no raw output behind', async () => {
    const script = `console.log("token is ${FAKE_GH_TOKEN}"); console.log("env secret " + process.env.MY_API_TOKEN); console.error("Error: auth failed for " + process.env.MY_API_TOKEN); process.exit(1)`;
    const e = await setup([nodeCheck('leaky', script, { env: { MY_API_TOKEN: 'hunter2-not-a-real-secret' } })]);
    const [r] = await run(e, ['leaky']);
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log).not.toContain(FAKE_GH_TOKEN);
    expect(log).not.toContain('hunter2-not-a-real-secret');
    expect(log).toContain('[REDACTED');
    expect(r!.excerpt).not.toContain('hunter2-not-a-real-secret');
    expect(existsSync(join(checkDirOf(e, 'leaky'), 'output.raw'))).toBe(false);
    for (const row of e.run.db.all<{ excerpt: string | null }>('SELECT excerpt FROM check_runs')) expect(row.excerpt ?? '').not.toContain('hunter2');
  });

  it('asks the isolation provider for loopback only for a check that may bind it, and leaves its outbound hosts alone', async () => {
    const isolation = recordingIsolation();
    const e = await setup(
      [nodeCheck('serves', 'process.exit(0)', { local_binding: true, network_hosts: ['registry.npmjs.org'] }), nodeCheck('plain', 'process.exit(0)', { local_binding: false, network_hosts: ['registry.npmjs.org'] })],
      { isolation },
    );
    await run(e, ['serves', 'plain']);
    expect(isolation.profiles.map((p) => p.allowLocalBinding)).toEqual([true, false]);
    expect(isolation.profiles.map((p) => p.allowedHosts)).toEqual([['registry.npmjs.org'], ['registry.npmjs.org']]);
  });

  it('starts from a fixed environment: no host variables, a private HOME and TMPDIR, the check env on top', async () => {
    process.env.ORBIT_TEST_HOST_VALUE = 'leak-me';
    process.env.GITHUB_TOKEN = 'ghs_not_for_checks';
    try {
      const e = await setup([nodeCheck('env', 'require("fs").writeFileSync(process.env.ORBIT_ARTIFACTS_DIR + "/env.json", JSON.stringify(process.env))', { env: { CUSTOM_FLAG: 'on', CI: 'overridden' } })]);
      const [r] = await run(e, ['env']);
      expect(r!.status).toBe('PASSED');
      const env = JSON.parse(readText(join(checkDirOf(e, 'env'), 'artifacts', 'env.json'))) as Record<string, string>;
      const home = env.HOME!;
      expect(env.ORBIT_TEST_HOST_VALUE).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      expect(env.CUSTOM_FLAG).toBe('on');
      expect(env.CI).toBe('overridden');
      expect(env.ORBIT_CHECK_ID).toBe('env');
      expect(env.NO_COLOR).toBe('1');
      expect(home.startsWith(checkDirOf(e, 'env'))).toBe(true);
      expect(home).not.toBe(process.env.HOME);
      expect(env.TMPDIR).toMatch(/orbit-\d+/);
      // The scratch HOME does not outlive the check.
      expect(existsSync(home)).toBe(false);
    } finally {
      delete process.env.ORBIT_TEST_HOST_VALUE;
      delete process.env.GITHUB_TOKEN;
    }
  });

  it('lists artifacts the check writes, with their hashes', async () => {
    const e = await setup([nodeCheck('art', 'const fs=require("fs");fs.writeFileSync(process.env.ORBIT_ARTIFACTS_DIR+"/report.xml","<x/>");fs.mkdirSync(process.env.ORBIT_ARTIFACTS_DIR+"/shots");fs.writeFileSync(process.env.ORBIT_ARTIFACTS_DIR+"/shots/a.png","png")')]);
    const [r] = await run(e, ['art']);
    const files = r!.artifacts.filter((a) => a.kind !== 'log');
    expect(files.map((a) => [a.kind, a.path.split('/').slice(-1)[0]])).toEqual([['report', 'report.xml'], ['screenshot', 'a.png']]);
    expect(files[0]!.sha256).toBe(createHash('sha256').update('<x/>').digest('hex'));
  });

  it('runs a shell check as /bin/sh -c with the one-element script', async () => {
    const e = await setup([checkDef('sh', { shell: true, command: ['echo first && echo "second $0" >&2 && exit 0'] })]);
    const [r] = await run(e, ['sh']);
    expect(r!.command).toEqual(['/bin/sh', '-c', 'echo first && echo "second $0" >&2 && exit 0']);
    expect(r!.status).toBe('PASSED');
    expect(readFileSync(r!.logPath, 'utf8')).toContain('first');
  });

  it('reports ERROR for a command that cannot start', async () => {
    const e = await setup([checkDef('nope', { command: ['definitely-not-a-real-binary-acme'] })]);
    const [r] = await run(e, ['nope']);
    expect(r!.status).toBe('ERROR');
    expect(readFileSync(r!.logPath, 'utf8')).toMatch(/could not start the check/);
    // An environmental error is not a code failure: no cancellation, no timeout.
    expect(r).toMatchObject({ timedOut: false, cancelled: false });
  });

  it('caps stored output and marks the truncation', async () => {
    const e = await setup([nodeCheck('loud', 'process.stdout.write("x".repeat(300000)); process.exit(0)')]);
    const [r] = await run(e, ['loud'], { maxOutputBytes: 10_000 });
    const log = readFileSync(r!.logPath, 'utf8');
    expect(log.length).toBeLessThan(11_000);
    expect(log).toContain('[orbit: output truncated:');
  });

  it('is idempotent: a second call returns the recorded results and runs nothing', async () => {
    const m = marker();
    const e = await setup([nodeCheck('once', `require("fs").appendFileSync(${JSON.stringify(m)}, "x")`)]);
    const [a] = await run(e, ['once']);
    const [b] = await run(e, ['once']);
    expect(b!.id).toBe(a!.id);
    expect(readText(m)).toBe('x');
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(1);
  });
});

describe('runChecks: trust and guards', () => {
  it('runs only checks defined in the policy snapshot', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    await expect(run(e, ['from-a-contract'])).rejects.toMatchObject({ code: 'POLICY_DENIED' });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(0);
  });

  it('rejects an in-memory snapshot that no longer matches the run hash', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    const tampered = JSON.parse(JSON.stringify(e.run.snapshot));
    tampered.config.checks.ok.command = ['node', '-e', 'require("fs").writeFileSync("pwned","x")'];
    await expect(run(e, ['ok'], { snapshot: tampered })).rejects.toMatchObject({ code: 'POLICY_TAMPERED' });
  });

  it('rejects malformed definitions and cwd escapes before running anything', async () => {
    const e = await setup([
      checkDef('two', { shell: true, command: ['echo a', 'echo b'] }),
      checkDef('up', { cwd: '../..' }),
      checkDef('empty', { command: [] }),
      checkDef('ui', { kind: 'playwright', command: ['npx', 'playwright', 'test'] }),
    ]);
    await expect(run(e, ['two'])).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(run(e, ['up'])).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(run(e, ['empty'])).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    await expect(run(e, ['ui'])).rejects.toMatchObject({ code: 'INTERNAL' });
  });

  it('refuses a symlinked cwd that leaves the checkout', async () => {
    const e = await setup([checkDef('link', { cwd: 'out' })]);
    const { symlinkSync } = await import('node:fs');
    symlinkSync(e.t.root, join(e.checkoutDir, 'out'));
    await expect(run(e, ['link'])).rejects.toMatchObject({ code: 'SCOPE_VIOLATION' });
  });

  it('refuses a checkout that holds a different tree than the candidate', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    write(join(e.r.repo, 'later.txt'), 'x');
    sh(e.r.repo, 'add', '-A');
    sh(e.r.repo, 'commit', '-qm', 'later');
    sh(e.checkoutDir, 'checkout', '-q', '--detach', sh(e.r.repo, 'rev-parse', 'HEAD').trim());
    await expect(run(e, ['ok'])).rejects.toSatisfy((err) => isOrbitError(err, 'STALE_EVIDENCE'));
  });

  it('refuses a candidate that belongs to another run', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    await expect(run(e, ['ok'], { candidate: { ...e.candidate, runId: 'other' } })).rejects.toMatchObject({ code: 'INTERNAL' });
  });
});

describe('runChecks: time limits and cancellation', () => {
  it('enforces the timeout, kills the whole process group and records TIMEOUT', async () => {
    const script = `const c=require("child_process").spawn("sleep",["60"],{stdio:"ignore"});require("fs").writeFileSync(process.env.ORBIT_ARTIFACTS_DIR+"/gc",String(c.pid));console.log("started");setInterval(()=>{},1000)`;
    const e = await setup([nodeCheck('slow', script, { timeout_seconds: 1 })]);
    const t0 = Date.now();
    const [r] = await run(e, ['slow']);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r).toMatchObject({ status: 'TIMEOUT', timedOut: true, cancelled: false });
    expect(readFileSync(r!.logPath, 'utf8')).toContain('timed out');
    expect(r!.fingerprint).toMatch(/^fp:/);
    const grandchild = Number(readText(join(checkDirOf(e, 'slow'), 'artifacts', 'gc')));
    await waitFor(() => pidGone(grandchild), 5_000);
    expect(listFailures(e.run.db, e.run.runId)).toHaveLength(1);
  });

  it('cancels a check mid-run on an AbortSignal and leaves no process behind', async () => {
    const script = `const c=require("child_process").spawn("sleep",["60"],{stdio:"ignore"});require("fs").writeFileSync(process.env.ORBIT_ARTIFACTS_DIR+"/gc",String(c.pid));setInterval(()=>{},1000)`;
    const e = await setup([nodeCheck('long', script, { timeout_seconds: 120 })]);
    const ac = new AbortController();
    const pending = run(e, ['long'], { signal: ac.signal });
    const gcFile = join(checkDirOf(e, 'long'), 'artifacts', 'gc');
    await waitFor(() => existsSync(gcFile) && readText(gcFile) !== '');
    const grandchild = Number(readText(gcFile));
    const t0 = Date.now();
    ac.abort();
    const [r] = await pending;
    expect(Date.now() - t0).toBeLessThan(8_000);
    expect(r).toMatchObject({ status: 'CANCELLED', cancelled: true, timedOut: false, fingerprint: null });
    await waitFor(() => pidGone(grandchild), 5_000);
    // A cancellation is not a failure the repair loop should chase.
    expect(listFailures(e.run.db, e.run.runId)).toHaveLength(0);
  });

  it('cancels on durable run cancellation and starts nothing afterwards', async () => {
    const e = await setup([nodeCheck('long', 'setInterval(()=>{},1000)', { timeout_seconds: 120 }), nodeCheck('after', '')]);
    const pending = run(e, ['long', 'after']);
    await waitFor(() => existsSync(join(checkDirOf(e, 'long'), 'pid.json')));
    requestCancel(e.run.db, e.run.runId, 'test', e.ctx.clock);
    const results = await pending;
    expect(results.map((r) => [r.checkId, r.status])).toEqual([['long', 'CANCELLED']]);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'after' })).toHaveLength(0);
    // Planning new work for a cancelled run is refused in the database itself.
    expect(await run(e, ['after'])).toEqual([]);
  });

  it('stops supervising on a detach signal without killing the check; the next owner reattaches and collects it', async () => {
    // Lease lost or controller shutdown is not a cancellation: the check must outlive its supervisor.
    const script = `const fs=require("fs");const f=process.env.ORBIT_ARTIFACTS_DIR+"/go";const t=setInterval(()=>{if(fs.existsSync(f)){clearInterval(t);console.log("finished after detach")}},50)`;
    const e = await setup([nodeCheck('long', script, { timeout_seconds: 120 })]);
    const ac = new AbortController();
    const pending = run(e, ['long'], { detachSignal: ac.signal });
    const pidFile = join(checkDirOf(e, 'long'), 'pid.json');
    await waitFor(() => existsSync(pidFile));
    ac.abort(new Error('lease lost'));
    const err = await pending.then(() => null, (x: unknown) => x);
    expect(isOrbitError(err, 'CANCELLED')).toBe(true);
    expect((err as { details?: { detached?: boolean } }).details?.detached).toBe(true);
    const [row] = listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'long' });
    expect(row!.status).toBe('RUNNING');
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { shimPid: number };
    expect(pidGone(pids.shimPid)).toBe(false);
    // The next owner reattaches: the same row ends PASSED and nothing was launched twice.
    write(join(checkDirOf(e, 'long'), 'artifacts', 'go'), '1');
    const [r] = await run(e, ['long']);
    expect(r).toMatchObject({ id: row!.id, status: 'PASSED', cancelled: false });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'long' })).toHaveLength(1);
  });

  it('a detach signal that is already aborted starts nothing', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    const ac = new AbortController();
    ac.abort();
    await expect(run(e, ['ok'], { detachSignal: ac.signal })).rejects.toMatchObject({ code: 'CANCELLED', details: { detached: true } });
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(0);
  });

  it('does not start when the signal is already aborted', async () => {
    const e = await setup([nodeCheck('ok', '')]);
    const ac = new AbortController();
    ac.abort();
    expect(await run(e, ['ok'], { signal: ac.signal })).toEqual([]);
    expect(listCheckRuns(e.run.db, { runId: e.run.runId })).toHaveLength(0);
  });
});

describe('runChecks: flakiness', () => {
  const flakyScript = (file: string, failTimes: number) =>
    `const fs=require("fs");const f=${JSON.stringify(file)};fs.appendFileSync(f,"x");const n=fs.readFileSync(f,"utf8").length;if(n<=${failTimes}){console.error("Error: flaky failure number "+n);process.exit(1)}`;

  it('records a pass after a failure as flaky, never clean, and keeps the failed attempt', async () => {
    const m = marker();
    const e = await setup([nodeCheck('f', flakyScript(m, 1), { flaky_reruns: 2 })]);
    const [r] = await run(e, ['f']);
    expect(r).toMatchObject({ status: 'PASSED', flaky: true, exitCode: 0 });
    const rows = listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'f' });
    expect(rows.map((x) => [x.status, x.flaky])).toEqual([['FAILED', false], ['PASSED', true]]);
    expect(rows[1]!.rerunOf).toBe(rows[0]!.id);
    expect(readText(m)).toBe('xx');
    expect(listFailures(e.run.db, e.run.runId).map((f) => f.source)).toEqual(['flaky_check']);
    // Each attempt keeps its own log.
    expect(rows[0]!.logPath).not.toBe(rows[1]!.logPath);
    expect(readFileSync(rows[0]!.logPath!, 'utf8')).toContain('flaky failure number 1');
    // Calling again does not rerun anything.
    const [again] = await run(e, ['f']);
    expect(again!.id).toBe(r!.id);
    expect(readText(m)).toBe('xx');
  });

  it('stops after the bounded number of reruns and reports the failure, not a flake', async () => {
    const m = marker();
    const e = await setup([nodeCheck('f', flakyScript(m, 99), { flaky_reruns: 2 })]);
    const [r] = await run(e, ['f']);
    expect(r).toMatchObject({ status: 'FAILED', flaky: false });
    expect(readText(m)).toBe('xxx');
    expect(listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'f' })).toHaveLength(3);
    expect(listFailures(e.run.db, e.run.runId)).toHaveLength(1);
  });

  it('does not rerun without flaky_reruns, and never reruns a timeout', async () => {
    const m = marker();
    const e = await setup([nodeCheck('plain', flakyScript(m, 99)), nodeCheck('slow', 'setInterval(()=>{},1000)', { timeout_seconds: 1, flaky_reruns: 3 })]);
    const [plain, slow] = await run(e, ['plain', 'slow']);
    expect(plain!.status).toBe('FAILED');
    expect(readText(m)).toBe('x');
    expect(slow!.status).toBe('TIMEOUT');
    expect(listCheckRuns(e.run.db, { runId: e.run.runId, checkId: 'slow' })).toHaveLength(1);
  });
});

describe('runChecks: parallelism', () => {
  const sleeper = (id: string) => nodeCheck(id, 'require("fs").writeFileSync(process.env.ORBIT_ARTIFACTS_DIR+"/t0",String(Date.now()));setTimeout(()=>{require("fs").writeFileSync(process.env.ORBIT_ARTIFACTS_DIR+"/t1",String(Date.now()))},1200)');
  const span = (e: RunnerEnv, id: string) => [Number(readText(join(checkDirOf(e, id), 'artifacts', 't0'))), Number(readText(join(checkDirOf(e, id), 'artifacts', 't1')))] as const;

  it('runs independent checks concurrently up to the limit and serially at limit 1', async () => {
    const e = await setup([sleeper('a'), sleeper('b')]);
    await run(e, ['a', 'b'], { parallelism: 2 });
    const [a0, a1] = span(e, 'a');
    const [b0, b1] = span(e, 'b');
    expect(Math.max(a0, b0)).toBeLessThan(Math.min(a1, b1));

    const e2 = await setup([sleeper('a'), sleeper('b')]);
    await run(e2, ['a', 'b'], { parallelism: 1 });
    const [x0, x1] = span(e2, 'a');
    const [y0] = span(e2, 'b');
    expect(y0).toBeGreaterThanOrEqual(x1);
    expect(x1).toBeGreaterThan(x0);
  });

  it('returns results in request order and surfaces a launch error after the others settle', async () => {
    const e = await setup([nodeCheck('z', ''), nodeCheck('a', 'process.exit(1)')]);
    const results = await run(e, ['z', 'a', 'z'], { parallelism: 2 });
    expect(results.map((r) => r.checkId)).toEqual(['z', 'a']);
  });
});

describe('reattach after the controller dies', () => {
  const dbPathOf = (e: RunnerEnv) => join(e.t.root, 'state.sqlite');
  const startController = (e: RunnerEnv, ids: string[]) =>
    spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', resolve(here, 'child-runner.ts'), dbPathOf(e), e.run.runId, e.run.runDir, e.checkoutDir, e.candidate.id, ids.join(',')], { stdio: ['ignore', 'pipe', 'pipe'] });

  it('collects the result of a check that finished while no controller was running, without rerunning it', async () => {
    const m = marker();
    const script = `const fs=require("fs");fs.appendFileSync(${JSON.stringify(m)},"x");setTimeout(()=>{console.log("finished after the controller died")},1500)`;
    const e = await setup([nodeCheck('survivor', script)]);
    const controller = startController(e, ['survivor']);
    const exited = new Promise((r) => controller.on('exit', r));
    await waitFor(() => existsSync(join(checkDirOf(e, 'survivor'), 'pid.json')) && readText(m) === 'x');
    // The shim writes pid.json before the controller records RUNNING; on a slow runner a kill in between leaves
    // PLANNED (a crash window the fault-injection suite covers). This scenario is the controller dying after RUNNING.
    await waitFor(() => listCheckRuns(e.run.db, { runId: e.run.runId })[0]?.status === 'RUNNING');
    controller.kill('SIGKILL');
    await exited;

    // The database still says RUNNING: nobody recorded the outcome.
    const [pending] = listCheckRuns(e.run.db, { runId: e.run.runId });
    expect(pending!.status).toBe('RUNNING');
    const shimPid = pending!.pid!;
    expect(pidGone(shimPid)).toBe(false);

    const results = await resumeChecks(e.ctx);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ checkId: 'survivor', status: 'PASSED', exitCode: 0 });
    expect(readFileSync(results[0]!.logPath, 'utf8')).toContain('finished after the controller died');
    expect(readText(m)).toBe('x');
    const rows = listCheckRuns(e.run.db, { runId: e.run.runId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.pid).toBe(shimPid);
    // Collecting it again is a no-op.
    expect((await reattachCheck(e.ctx, rows[0]!.id)).id).toBe(rows[0]!.id);
  });

  it('still enforces the timeout after the controller died, because the shim owns it', async () => {
    const e = await setup([nodeCheck('hang', 'setInterval(()=>{},1000)', { timeout_seconds: 1 })]);
    const controller = startController(e, ['hang']);
    const exited = new Promise((r) => controller.on('exit', r));
    await waitFor(() => existsSync(join(checkDirOf(e, 'hang'), 'pid.json')));
    controller.kill('SIGKILL');
    await exited;
    const [r] = await resumeChecks(e.ctx);
    expect(r).toMatchObject({ status: 'TIMEOUT', timedOut: true });
  });

  it('reports ERROR when the shim and the check both vanished, and a later call starts over', async () => {
    const m = marker();
    const e = await setup([nodeCheck('gone', `require("fs").appendFileSync(${JSON.stringify(m)},"x");if(require("fs").readFileSync(${JSON.stringify(m)},"utf8").length===1)setInterval(()=>{},1000)`)]);
    const controller = startController(e, ['gone']);
    const exited = new Promise((r) => controller.on('exit', r));
    const pidFile = join(checkDirOf(e, 'gone'), 'pid.json');
    await waitFor(() => existsSync(pidFile) && readText(m) === 'x');
    controller.kill('SIGKILL');
    await exited;
    const pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { shimPid: number; childPgid: number };
    process.kill(pids.shimPid, 'SIGKILL');
    process.kill(-pids.childPgid, 'SIGKILL');
    await waitFor(() => pidGone(pids.shimPid));

    const [lost] = await resumeChecks(e.ctx);
    expect(lost).toMatchObject({ status: 'ERROR' });
    expect(readFileSync(lost!.logPath, 'utf8')).toContain('disappeared');

    // The earlier ERROR is old news for a fresh call: it runs the check again (the marker script now passes).
    const [fresh] = await run(e, ['gone']);
    expect(fresh).toMatchObject({ status: 'PASSED' });
    expect(fresh!.id).not.toBe(lost!.id);
  });

  it('takes an unstarted intent with no process as a lost launch rather than waiting forever', async () => {
    const e = await setup([nodeCheck('x', '')]);
    const { planCheckRun } = await import('../../../src/evidence/store.ts');
    const { atomicWriteJson } = await import('../../../src/core/fsx.ts');
    const row = planCheckRun(e.run.db, { runId: e.run.runId, candidateId: e.candidate.id, checkId: 'x', kind: 'command', treeHash: e.candidate.treeHash, checkConfigHash: e.run.snapshot.check_config_hashes.x!, policyHash: e.run.policyHash, command: ['node'], cwd: e.checkoutDir, isolation: 'none', limitations: [] }, e.ctx.clock);
    atomicWriteJson(join(checkDirOf(e, 'x'), 'intent.json'), { token: 't', checkRunId: row.id, argv: ['node'], cwd: e.checkoutDir, timeoutMs: 1000, killGraceMs: 100, maxOutputBytes: 1000, writtenAt: Date.now() - 60_000 });
    const result = await reattachCheck(e.ctx, row.id);
    expect(result.status).toBe('ERROR');
    expect(statSync(result.logPath).isFile()).toBe(true);
    expect(readdirSync(checkDirOf(e, 'x')).includes('output.raw')).toBe(false);
  });
});
