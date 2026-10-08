import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { readJsonIfExists } from '../../../src/core/fsx.ts';
import { profileForWorker, workerAllowedHosts, workerTmpDir } from '../../../src/isolation/profiles.ts';
import { detectToolchains, prepareToolchainLayout, toolchainLayout } from '../../../src/isolation/toolchains.ts';
import type { PolicySnapshot } from '../../../src/policy/types.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { LOOPBACK_RUNNERS, XUNIT_PROJECT, dotnet, nugetGlobalPackages, type LoopbackRunner } from '../isolation/loopback-runners.ts';
import { IMPLEMENTER_OUTPUT, implementerSpec, makeFixture, waitFor, type Fixture } from './helpers.ts';

/**
 * Issue #31, in the tier the retest ran in: the REAL claude CLI against a fake API, with the settings file Orbit writes
 * for the claude-sandbox tier (no Claude credential exported, so Claude Code's own sandbox confines Bash), a worktree
 * under ~/.orbit as in a run, and the worker's toolchain environment. There the worker's `dotnet test -m:1` built and
 * then aborted with "SocketException (13): Permission denied" at VSTest's Socket.Bind ("Test Run Aborted"), and a Node
 * test server got "listen EPERM". On macOS it stays so: Claude Code's allowLocalBinding lets Bash listen on every address
 * of the machine (measured with 2.1.292: a listener on 0.0.0.0 or `::` answered on the LAN address), which Orbit cannot
 * narrow, so the settings say false, and doctor says what that costs (workers.loopback). On Linux Claude Code's sandbox
 * gives every command a network namespace of its own, whose loopback it may use. Each runner that listens on loopback
 * runs as one Bash step, in a directory of its own.
 */
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const ORBIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * Every runner that listens on loopback, as far as this machine can run them, except Go's: in this tier Go cannot build
 * at all, loopback or not, because its build cache (GOCACHE, in the worker's toolchain scratch under the worker
 * directory) is not writable by sandboxed Bash ("failed to initialize build cache ... operation not permitted"), a
 * separate gap. The os-sandbox tier runs Go's test server (tests/integration/isolation/worker-loopback.int.test.ts).
 */
const RUNNERS = LOOPBACK_RUNNERS.filter((r) => r.listens && r.unavailable === null && !r.name.startsWith('a Go test'));

type Api = Awaited<ReturnType<typeof startFakeAnthropicApi>>;
let api: Api;
let configDir: string;
const fixtures: Fixture[] = [];

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

function toolResults(f: Fixture): string[] {
  return readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; message?: { content?: unknown } })
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => (e.message!.content as { type: string; content?: unknown }[]).filter((c) => c.type === 'tool_result').map((c) => (typeof c.content === 'string' ? c.content : JSON.stringify(c.content))));
}

/** One implementer session whose Bash runs every runner. */
async function session(): Promise<{ outputs: string[]; settings: { sandbox: { network: Record<string, unknown> } } }> {
  const f = makeFixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["**"]}\nnetwork: {allowed_hosts: []}\n');
  fixtures.push(f);
  const home = join(f.base, 'home');
  const orbitHome = join(home, '.orbit');
  const worktree = join(orbitHome, 'repos', 'acme', 'worktrees', 'w1');
  mkdirSync(dirname(worktree), { recursive: true });
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'orbit/w1', worktree], { cwd: f.repo, stdio: 'ignore' });
  const wt = realpathSync(worktree);
  const dirs = RUNNERS.map((_, i) => join(wt, 'runners', String(i)));
  RUNNERS.forEach((runner, i) => {
    for (const [rel, text] of Object.entries(runner.files)) {
      mkdirSync(dirname(join(dirs[i]!, rel)), { recursive: true });
      writeFileSync(join(dirs[i]!, rel), text);
    }
  });
  const snapshot = readJsonIfExists<PolicySnapshot>(f.policyPath)!;
  const cacheRoot = join(orbitHome, 'cache', 'acme');
  const toolchains = toolchainLayout({
    toolchains: detectToolchains({ roots: [wt, ...dirs, ...dirs.map((d) => join(d, 'Acme.Tests'))] }),
    mode: 'worker',
    cacheRoot,
    scratchRoot: join(f.workerDir, 'toolchains'),
    tmpDir: workerTmpDir(f.workerDir),
    hostHome: homedir(),
    hostEnv: process.env,
    networkHosts: workerAllowedHosts('claude', snapshot),
  });
  prepareToolchainLayout(toolchains);
  RUNNERS.forEach((runner, i) => {
    // The dependency install's part, outside the sandbox: the repository's NuGet cache, filled offline from the account's.
    if (runner.files === XUNIT_PROJECT) execFileSync(dotnet!, ['restore', 'Acme.Tests/Acme.Tests.csproj', '--source', nugetGlobalPackages, '-v', 'q'], { cwd: dirs[i]!, env: { ...process.env, NUGET_PACKAGES: join(cacheRoot, 'nuget') }, stdio: 'pipe' });
  });
  const sandbox = profileForWorker({ worktree: wt, workerDir: f.workerDir, snapshot, provider: 'claude', claudeConfigDir: configDir, homeDir: home, policyPath: f.policyPath, readablePaths: [ORBIT_ROOT, ...toolchains.readOnly], nisDomainName: toolchains.nisDomainName, env: {} });
  api.setSteps([
    ...RUNNERS.map((runner, i) => ({ tool: 'Bash', input: { command: `cd ${quote(dirs[i]!)} && ${runner.command.map(quote).join(' ')} 2>&1 | tail -n 40`, description: runner.name, timeout: runner.timeoutMs } })),
    { structured: IMPLEMENTER_OUTPUT },
  ]);
  const a = new ClaudeAdapter({
    command: [CLAUDE!],
    tier: 'claude-sandbox',
    graceMs: 2_000,
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
  });
  const spec = implementerSpec(f, { env: toolchains.env, model: 'sonnet', cwd: wt, sandbox, timeoutMs: 900_000 });
  const handle = await a.startTask(spec);
  const result = await waitFor(() => a.collectResult(handle, spec), 900_000, 200);
  expect(result.status, result.error ?? '').toBe('succeeded');
  const outputs = toolResults(f);
  // One result per runner, then the structured-output tool's own.
  expect(outputs).toHaveLength(RUNNERS.length + 1);
  return { outputs: outputs.slice(0, -1), settings: JSON.parse(readFileSync(join(f.workerDir, 'settings.json'), 'utf8')) };
}

describe.skipIf(!CLAUDE || !canStripTypes)('claude-sandbox tier: test runners that listen on loopback, in a worker (real claude CLI, fake API)', () => {
  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
  });
  afterAll(async () => {
    await api?.close();
    rmSync(configDir, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  });

  it(`${process.platform === 'darwin' ? 'refuses them on macOS: the settings never let Bash listen' : 'runs them on Linux, on the sandbox\'s own loopback'}: ${RUNNERS.map((r: LoopbackRunner) => r.name).join('; ')}`, async () => {
    const { outputs, settings } = await session();
    expect(settings.sandbox.network).toEqual({ allowedDomains: [], strictAllowlist: true, allowLocalBinding: false });
    RUNNERS.forEach((runner, i) => {
      if (process.platform === 'darwin') {
        expect(outputs[i], runner.name).toMatch(runner.refused!);
        expect(outputs[i], runner.name).not.toMatch(runner.passed);
      } else {
        expect(outputs[i], runner.name).toMatch(runner.passed);
      }
    });
  }, 900_000);
});
