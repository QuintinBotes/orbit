import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir, networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { buildWorkerEnv } from '../../../src/adapters/env.ts';
import { prepareWorkerTmpDir, profileForCheck, profileForWorker, workerAllowedHosts } from '../../../src/isolation/profiles.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { detectToolchains, prepareToolchainLayout, toolchainLayout } from '../../../src/isolation/toolchains.ts';
import type { SandboxProfile } from '../../../src/isolation/types.ts';
import { defaultCheck } from '../../../src/policy/config.ts';
import { verifySnapshot } from '../../../src/policy/snapshot.ts';
import { makeFixture, waitFor, type Fixture } from '../adapters/helpers.ts';
import { LOOPBACK_RUNNERS, XUNIT_PROJECT, dotnet, dotnetFirstRun, nugetGlobalPackages, type LoopbackRunner } from './loopback-runners.ts';
import { runWrapped } from './run.ts';

/**
 * Issue #31: an implementer's own `dotnet test -m:1` built the project and then aborted with SocketException (13) at
 * VSTest's Socket.Bind, because the worker sandbox refused to let it listen, while the checks, which run the same tests,
 * could. Granting workers srt's allowLocalBinding would fix that, but on macOS it is not loopback only: srt 0.0.78 turns
 * it into Seatbelt rules for every local address, and a listener on 0.0.0.0, `::` or the machine's network address
 * answers from the network. Seatbelt has no narrower rule (the last case below), and a worker runs model-driven
 * commands, so a worker may not listen at all; on Linux every srt sandbox has a network namespace, and so a loopback, of
 * its own. Each runner and probe runs under the real srt with the sandbox a worker gets in the os-sandbox tier, built as
 * the controller builds it (controller/workers.ts taskSpec: the worktree's toolchain layout in worker mode,
 * profileForWorker, the worker environment). Claude Code's own sandbox, the claude-sandbox tier, is covered with the real
 * CLI in tests/integration/adapters/claude-sandbox-loopback.test.ts.
 */
const orbitInstallDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const srt = new SandboxRuntimeIsolation({ orbitInstallDir });
const status = await srt.available();
const darwin = process.platform === 'darwin';
/** This machine's address on its network, the one another machine would connect to; null without one. */
const lan = Object.values(networkInterfaces()).flat().find((a) => a !== undefined && a.family === 'IPv4' && !a.internal)?.address ?? null;

const fixtures: Fixture[] = [];
afterAll(() => {
  for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
});

/** A worktree holding the given files, under a policy that allows no hosts. */
function worktree(files: Record<string, string>): Fixture {
  const f = makeFixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["**"]}\nnetwork: {allowed_hosts: []}\n');
  fixtures.push(f);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(f.repo, rel)), { recursive: true });
    writeFileSync(join(f.repo, rel), text);
  }
  return f;
}

/** The worker's sandbox and environment for a worktree, as the controller builds them; `over` changes the profile. */
function workerSandbox(f: Fixture, files: Record<string, string>, timeoutMs: number, over: Partial<SandboxProfile> = {}) {
  const snapshot = verifySnapshot(f.policyPath, f.policyHash);
  const tmpDir = prepareWorkerTmpDir(f.workerDir);
  // The repository's dependency caches sit under a directory the profile denies, as ~/.orbit is in a run.
  const cacheRoot = join(f.base, 'orbit-home', 'cache', 'acme');
  const toolchains = toolchainLayout({
    toolchains: detectToolchains({ roots: [f.repo, ...Object.keys(files).filter((p) => p.includes('/')).map((p) => join(f.repo, dirname(p)))] }),
    mode: 'worker',
    cacheRoot,
    scratchRoot: join(f.workerDir, 'toolchains'),
    tmpDir,
    hostHome: homedir(),
    hostEnv: process.env,
    networkHosts: workerAllowedHosts('claude', snapshot),
  });
  prepareToolchainLayout(toolchains);
  // A worker runs with the account's HOME, read-only: .NET's first run there is the account's own, outside it.
  if (toolchains.toolchains.includes('dotnet')) dotnetFirstRun();
  if (files === XUNIT_PROJECT) {
    // What the dependency install does for a run, outside the sandbox: fill the repository's NuGet cache, here offline
    // from the account's own.
    execFileSync(dotnet!, ['restore', 'Acme.Tests/Acme.Tests.csproj', '--source', nugetGlobalPackages, '-v', 'q'], { cwd: f.repo, env: { ...process.env, NUGET_PACKAGES: join(cacheRoot, 'nuget') }, stdio: 'pipe' });
  }
  const claudeConfigDir = join(f.base, 'claude-config');
  mkdirSync(claudeConfigDir, { recursive: true });
  const profile = profileForWorker({
    worktree: f.repo,
    workerDir: f.workerDir,
    snapshot,
    provider: 'claude',
    claudeConfigDir,
    homeDir: homedir(),
    tmpDir,
    policyPath: f.policyPath,
    readablePaths: [orbitInstallDir, ...toolchains.readOnly],
    nisDomainName: toolchains.nisDomainName,
    timeoutMs,
  });
  const env = buildWorkerEnv({ provider: 'claude', base: process.env, policyPath: f.policyPath, policyHash: f.policyHash, worktree: f.repo, tmpDir, maxOutputTokens: null, extra: toolchains.env });
  return { profile, sandbox: { ...profile, ...over }, env };
}

async function runAsWorker(runner: Pick<LoopbackRunner, 'files' | 'command' | 'timeoutMs'>, over: Partial<SandboxProfile> = {}) {
  const f = worktree(runner.files);
  const { profile, sandbox, env } = workerSandbox(f, runner.files, runner.timeoutMs, over);
  const wrapped = srt.wrap(runner.command, sandbox, { cwd: f.repo, env });
  try {
    const r = await runWrapped(wrapped, f.repo, { timeoutMs: runner.timeoutMs });
    return { profile, code: r.code, output: `${r.stdout}\n${r.stderr}` };
  } finally {
    wrapped.cleanup();
  }
}

/**
 * Listens on each address it is given (tag -> host) and records, in port-<tag> beside it, the port or why the listen was
 * refused; answers every connection with "hi" and logs who connected, until its time is up.
 */
const BIND_PROBE = `import net from 'node:net';
import { writeFileSync } from 'node:fs';
const hosts = JSON.parse(process.argv[2]);
for (const [tag, host] of Object.entries(hosts)) {
  const s = net.createServer((c) => { console.log('ACCEPTED ' + tag + ' ' + c.remoteAddress); c.end('hi\\n'); });
  s.on('error', (e) => { console.log('REFUSED ' + tag + ' ' + e.code); writeFileSync('port-' + tag, 'refused ' + e.code); });
  s.listen({ port: 0, host }, () => { console.log('LISTENING ' + tag); writeFileSync('port-' + tag, String(s.address().port)); });
}
setTimeout(() => process.exit(0), Number(process.argv[3]));
`;

/** What answers a connection from outside the sandbox to host:port: "hi", or the error. */
function connectFromOutside(host: string, port: number): Promise<string> {
  return new Promise((done) => {
    const s = net.connect({ host, port });
    s.setTimeout(3_000);
    s.on('data', (b) => {
      done(String(b).trim());
      s.destroy();
    });
    s.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? String(e)));
    s.on('timeout', () => {
      done('timeout');
      s.destroy();
    });
  });
}

/**
 * Runs the probe under `sandbox` for each address, and for each that listened connects from outside, to `connect[tag]`
 * (this machine's network address for the wildcard and network addresses, the loopback address itself otherwise).
 */
async function probeBinds(f: Fixture, sandbox: SandboxProfile, env: Record<string, string>, hosts: Record<string, string>, connect: Record<string, string>) {
  const command = [process.execPath, 'bind-probe.mjs', JSON.stringify(hosts), '8000'];
  const wrapped = srt.wrap(command, sandbox, { cwd: f.repo, env });
  try {
    const running = runWrapped(wrapped, f.repo, { timeoutMs: 30_000 });
    const outcome: Record<string, string> = {};
    for (const tag of Object.keys(hosts)) {
      const file = join(f.repo, `port-${tag}`);
      const recorded = await waitFor(() => (existsSync(file) && readFileSync(file, 'utf8') !== '' ? readFileSync(file, 'utf8') : null), 20_000, 50);
      outcome[tag] = recorded.startsWith('refused') ? recorded : `listening, from outside: ${await connectFromOutside(connect[tag]!, Number(recorded))}`;
    }
    const r = await running;
    return { outcome, output: `${r.stdout}\n${r.stderr}` };
  } finally {
    wrapped.cleanup();
  }
}

describe.skipIf(!status.ok)(status.ok ? 'test runners and listeners under the worker sandbox (real srt)' : `test runners under the worker sandbox skipped: ${status.detail}`, () => {
  for (const runner of LOOPBACK_RUNNERS.filter((r) => r.listens)) {
    const name = `${runner.name}: ${darwin ? 'refused under the worker sandbox on macOS, and runs once srt may bind, the rule a check gets' : 'runs under the worker sandbox, on its own loopback'}${runner.unavailable ? ` (skipped: ${runner.unavailable})` : ''}`;
    it.skipIf(runner.unavailable !== null)(name, async () => {
      const worker = await runAsWorker(runner);
      expect(worker.profile.allowLocalBinding).toBeUndefined();
      if (!darwin) {
        // srt on Linux runs every sandbox in a network namespace of its own (bwrap --unshare-net), whose loopback its
        // commands may use and nothing outside can reach.
        expect(worker.output).toMatch(runner.passed);
        expect(worker.code, worker.output.slice(-2000)).toBe(0);
        return;
      }
      expect(worker.code).not.toBe(0);
      expect(worker.output).toMatch(runner.refused!);
      expect(worker.output).not.toMatch(runner.passed);
      // The same sandbox with srt's allowLocalBinding, which a check's local_binding gives it: the refusal above is
      // that permission's alone, and the checks run these tests.
      const bound = await runAsWorker(runner, { allowLocalBinding: true });
      expect(bound.output).toMatch(runner.passed);
      expect(bound.code, bound.output.slice(-2000)).toBe(0);
    }, runner.timeoutMs * 2 + 60_000);
  }

  for (const runner of LOOPBACK_RUNNERS.filter((r) => !r.listens)) {
    it.skipIf(runner.unavailable !== null)(`${runner.name}: needs no listener, and runs under the worker sandbox${runner.unavailable ? ` (skipped: ${runner.unavailable})` : ''}`, async () => {
      const worker = await runAsWorker(runner);
      expect(worker.output).toMatch(runner.passed);
      expect(worker.code, worker.output.slice(-2000)).toBe(0);
    }, runner.timeoutMs + 60_000);
  }

  // Measured on macOS 27.0.1 with srt 0.0.78, and the reason workers get no listener there: srt's allowLocalBinding (what
  // a check's local_binding turns into) lets a check listen on every address, and one on 0.0.0.0, `::` or this machine's
  // network address answers a connection made to that address, as another machine's would be.
  it.skipIf(!darwin)("on macOS a worker may listen on no address, and a check's listener is not loopback only", async () => {
    const hosts: Record<string, string> = { lo4: '127.0.0.1', lo6: '::1', any4: '0.0.0.0', any6: '::', ...(lan ? { lan } : {}) };
    const connect: Record<string, string> = { lo4: '127.0.0.1', lo6: '::1', any4: lan ?? '127.0.0.1', any6: lan ?? '::1', ...(lan ? { lan } : {}) };

    const w = worktree({ 'bind-probe.mjs': BIND_PROBE });
    const { profile, env } = workerSandbox(w, {}, 60_000);
    const worker = await probeBinds(w, profile, env, hosts, connect);
    expect(worker.outcome, worker.output).toEqual(Object.fromEntries(Object.keys(hosts).map((tag) => [tag, 'refused EPERM'])));

    const c = worktree({ 'bind-probe.mjs': BIND_PROBE });
    const snapshot = verifySnapshot(c.policyPath, c.policyHash);
    const check = profileForCheck({ worktree: c.repo, check: { ...defaultCheck('unit'), command: [process.execPath, 'bind-probe.mjs'] }, snapshot, homeDir: homedir(), env: {} });
    expect(check.allowLocalBinding).toBe(true);
    const checked = await probeBinds(c, check, { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir() }, hosts, connect);
    expect(checked.outcome, checked.output).toEqual(Object.fromEntries(Object.keys(hosts).map((tag) => [tag, 'listening, from outside: hi'])));
    if (lan) expect(checked.output).toMatch(new RegExp(`ACCEPTED any4 ${lan.replaceAll('.', '\\.')}`));
  }, 120_000);

  // Why no Orbit rule narrows it either: Seatbelt checks a listener once, at listen(), against its local address, and the
  // only hosts its address filter accepts are "*" and "localhost", which matches every address of this machine. A
  // profile that denies listening and then allows it for "localhost" still lets a process listen on 0.0.0.0 and on this
  // machine's network address, and a connection made to that address is accepted (sandbox-exec alone, no srt).
  it.skipIf(!darwin)('Seatbelt\'s (local ip "localhost:*") admits every address of this machine, not loopback only', async () => {
    const probe = worktree({ 'bind-probe.mjs': BIND_PROBE });
    const hosts: Record<string, string> = { lo4: '127.0.0.1', any4: '0.0.0.0', ...(lan ? { lan } : {}) };
    const run = (profile: string) => {
      for (const tag of Object.keys(hosts)) rmSync(join(probe.repo, `port-${tag}`), { force: true });
      return spawnSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, 'bind-probe.mjs', JSON.stringify(hosts), '200'], { cwd: probe.repo, encoding: 'utf8', timeout: 30_000 });
    };
    const denied = run('(version 1)(allow default)(deny network-inbound)');
    expect(denied.stdout).toMatch(/REFUSED lo4 EPERM/);
    expect(denied.stdout).not.toMatch(/LISTENING/);
    const localhost = run('(version 1)(allow default)(deny network-inbound)(allow network-inbound (local ip "localhost:*"))');
    for (const tag of Object.keys(hosts)) expect(localhost.stdout, localhost.stderr).toMatch(new RegExp(`LISTENING ${tag}`));
    expect(localhost.stdout).not.toMatch(/REFUSED/);
  }, 60_000);
});
