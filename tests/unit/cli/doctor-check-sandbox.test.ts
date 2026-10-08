// `orbit doctor`'s checks.sandbox (issue #10): each command check's executable started in the sandbox the check would
// get, with a harmless argument, so a denial shows before any run instead of as a failure of the base revision.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxCheck, type ProbeLaunch } from '../../../src/cli/commands/doctor-sandbox.ts';
import { NUGET_MIGRATIONS_DIR } from '../../../src/evidence/runner.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition, OrbitConfig } from '../../../src/policy/types.ts';
import { repoKeyFor } from '../../../src/storage/retention.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

const DOTNET_CRASH = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', 'dotnet-build-eperm-shm.log'), 'utf8');

/** A repository, a home, and a bin directory outside both holding the named tools (each `exit 0`). */
function world(tools: string[] = ['dotnet']) {
  const repo = temp('orbit-doctor-repo-');
  const home = temp('orbit-doctor-home-');
  const bin = temp('orbit-doctor-bin-');
  for (const t of tools) writeFileSync(join(bin, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  mkdirSync(join(repo, 'scripts'), { recursive: true });
  writeFileSync(join(repo, 'scripts', 'check.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // PATH is the bin directory alone: a tool the test did not list is not found on any host, whatever the host has installed.
  return { repo, home, bin, env: { PATH: bin, HOME: home } };
}

function config(checks: Partial<CheckDefinition>[]): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.checks = Object.fromEntries(checks.map((x) => [x.id!, { ...defaultCheck(x.id!), ...x } as CheckDefinition]));
  return c;
}

/** An srt-like provider that records every wrap (argv, profile, the environment the command gets) and wraps nothing. */
function srtLike() {
  const wraps: { argv: string[]; profile: SandboxProfile; env: Record<string, string>; cwd: string; homeHasMarker: boolean }[] = [];
  const inner = new NoIsolation();
  const provider = {
    kind: 'sandbox-runtime' as const,
    available: () => inner.available(),
    wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
      wraps.push({ argv, profile, env: opts.env, cwd: opts.cwd, homeHasMarker: existsSync(join(opts.env.HOME!, NUGET_MIGRATIONS_DIR, '1')) });
      return inner.wrap(argv, profile, opts);
    },
  };
  return { provider: provider as IsolationProvider, wraps };
}

describe('checkSandboxCheck', () => {
  it('starts each check\'s executable in the check\'s own sandbox with a harmless argument, and passes when it runs', async () => {
    const w = world(['dotnet', 'npm']);
    const s = srtLike();
    const seen: string[][] = [];
    const launch: ProbeLaunch = async (argv) => (seen.push(argv), { exitCode: 0, output: 'ok' });
    const cfg = config([
      { id: 'build', command: ['dotnet', 'build', '-m:1'], network_hosts: ['api.nuget.org'] },
      { id: 'lint', command: ['FORCE=1 npm run lint'], shell: true },
    ]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, launch });
    expect(c).toMatchObject({ id: 'checks.sandbox', area: 'checks', status: 'pass', summary: '2 check executable(s) start in the sandbox' });
    expect(c.details).toEqual(['build: "dotnet help" ran in the sandbox', 'lint: "npm --version" ran in the sandbox']);
    // `dotnet --version` skips the SDK's first-run steps, where the sandbox refused it; `dotnet help` runs them.
    expect(seen).toEqual([[join(w.bin, 'dotnet'), 'help'], [join(w.bin, 'npm'), '--version']]);
    // The check's own profile and environment: its hosts, the repository denied, a private HOME prepared like a run's.
    const [build] = s.wraps;
    expect(build!.profile.allowedHosts).toEqual(['api.nuget.org']);
    expect(build!.profile.denyReadPaths).toContain(w.repo);
    expect(build!.profile.writablePaths.some((p) => p.startsWith(w.repo))).toBe(false);
    expect(build!.env).toMatchObject({ HOME: expect.any(String), DOTNET_CLI_HOME: build!.env.HOME, DOTNET_NOLOGO: '1', ORBIT_CHECK_ID: 'build' });
    expect(build!.homeHasMarker).toBe(true);
    // The scratch directories are gone.
    expect(existsSync(build!.cwd)).toBe(false);
    expect(existsSync(build!.env.TMPDIR!)).toBe(false);
  });

  it('reports a sandbox denial as a failure of a mandatory check, with the line that shows it and the fix, before any run', async () => {
    const w = world();
    const s = srtLike();
    const launch: ProbeLaunch = async () => ({ exitCode: 1, output: DOTNET_CRASH });
    const c = await checkSandboxCheck({ config: config([{ id: 'build', command: ['dotnet', 'build', '-m:1'], mandatory: true }]), repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, launch });
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('the sandbox refuses the executable of check build; a run would block at its baseline');
    expect(c.details[0]).toMatch(/^build: "dotnet help" was refused in the sandbox: the sandbox or the operating system refused a filesystem operation outside the check's checkout/);
    expect(c.details[0]).toContain('/tmp/.dotnet/shm/session');
    expect(c.missing).toBe('a check executable that can start in the check sandbox');
    expect(c.fix).toMatch(/\.NET runtime asking for \/tmp\/\.dotnet/);
  });

  it('warns for an optional check, and counts a crash before any output as a refusal', async () => {
    const w = world(['make']);
    const launch: ProbeLaunch = async () => ({ exitCode: null, output: 'Process killed by signal: SIGABRT' });
    const c = await checkSandboxCheck({ config: config([{ id: 'docs', command: ['make', 'docs'], mandatory: false }]), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch });
    expect(c.status).toBe('warn');
    expect(c.details[0]).toMatch(/^docs: "make --version" was refused in the sandbox: the process was killed by a fatal signal/);
    expect(c.fix).toMatch(/^see the line above and docs\/troubleshooting\.md/);
  });

  it('does not count a tool that exits non-zero with no denial in its output (an unknown flag is not the sandbox)', async () => {
    const w = world(['acme-lint']);
    const launch: ProbeLaunch = async () => ({ exitCode: 2, output: 'acme-lint: unknown flag --version' });
    const c = await checkSandboxCheck({ config: config([{ id: 'lint', command: ['acme-lint'] }]), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch });
    expect(c.status).toBe('pass');
    expect(c.details).toEqual(['lint: "acme-lint --version" exited 2 in the sandbox, with no sandbox denial in its output: acme-lint: unknown flag --version']);
    const silent = await checkSandboxCheck({ config: config([{ id: 'lint', command: ['acme-lint'] }]), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: null, output: '' }) });
    expect(silent.details).toEqual(['lint: "acme-lint --version" timed out in the sandbox, with no sandbox denial in its output']);
  });

  it('starts nothing of the repository, nothing it cannot find, and no shell builtin', async () => {
    const w = world([]);
    const seen: string[][] = [];
    const launch: ProbeLaunch = async (argv) => (seen.push(argv), { exitCode: 0, output: '' });
    const cfg = config([
      { id: 'own', command: ['./scripts/check.sh'] },
      { id: 'missing', command: ['acme-not-installed'] },
      { id: 'builtin', command: ['cd sub && make'], shell: true },
      { id: 'empty', command: [''], shell: true },
    ]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch });
    expect(seen).toEqual([]);
    expect(c).toMatchObject({ status: 'pass', summary: 'no check executable outside the repository to start' });
    expect(c.details).toEqual([
      'own: not started ("./scripts/check.sh" is the repository\'s own code, which only a run executes)',
      'missing: not started ("acme-not-installed" was not found; see the checks entry)',
      'builtin: not started (shell builtin "cd")',
      'empty: not started (no command)',
    ]);
  });

  it('reports a provider that cannot wrap the command as a refusal', async () => {
    const w = world();
    const broken = { kind: 'sandbox-runtime' as const, available: async () => ({ ok: true, detail: '' }), wrap: () => { throw new Error('srt vanished'); } } as IsolationProvider;
    const c = await checkSandboxCheck({ config: config([{ id: 'build', command: ['dotnet', 'build', '-m:1'], mandatory: true }]), repo: w.repo, provider: broken, available: true, env: w.env, homeDir: w.home });
    expect(c.status).toBe('fail');
    expect(c.details).toEqual(['build: could not be started in the sandbox: srt vanished']);
  });

  it('is not needed without command checks or under another provider, and not checked without isolation', async () => {
    const w = world();
    const none = await checkSandboxCheck({ config: config([]), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home });
    expect(none).toMatchObject({ status: 'pass', summary: 'not needed: no command check is defined' });
    const cfg = config([{ id: 'build', command: ['dotnet', 'build', '-m:1'] }]);
    const container = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: { kind: 'container', available: async () => ({ ok: true, detail: '' }), wrap: () => ({}) as never }, available: true, env: w.env, homeDir: w.home });
    expect(container).toMatchObject({ status: 'pass', summary: 'not needed: checks run under container, not in an OS sandbox on this host' });
    const down = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: false, env: w.env, homeDir: w.home });
    expect(down).toMatchObject({ status: 'warn', summary: 'not checked: isolation is unavailable (see the isolation check)' });
    const noRepo = await checkSandboxCheck({ config: cfg, repo: null, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(noRepo.status).toBe('pass');
  });
});

describe('checkSandboxCheck: toolchains (ADR 0009)', () => {
  it('starts each detected toolchain in the check sandbox and says where its caches live, writing nothing outside its scratch', async () => {
    const w = world(['go', 'make']);
    writeFileSync(join(w.repo, 'go.mod'), 'module acme\n');
    const orbitHome = temp('orbit-doctor-orbit-');
    const s = srtLike();
    const seen: string[][] = [];
    const launch: ProbeLaunch = async (argv) => (seen.push(argv), { exitCode: 0, output: 'ok' });
    const c = await checkSandboxCheck({ config: config([{ id: 'unit', command: ['make', 'test'] }]), repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    const cache = join(orbitHome, 'toolchains', repoKeyFor(w.repo), 'gomod');
    expect(c.status).toBe('pass');
    expect(c.details).toEqual([
      'unit: "make --version" ran in the sandbox',
      `toolchain go: "go version" ran in the sandbox; dependency cache ${cache} (not created yet; dependencies.install_command is not set, so no run creates it); private per check attempt: GOCACHE, GOPATH`,
    ]);
    expect(seen).toEqual([[join(w.bin, 'make'), '--version'], [join(w.bin, 'go'), 'version']]);
    // The check's probe gets the check's toolchain environment: a stand-in cache, read-only, and private build state.
    const [unit, go] = s.wraps;
    for (const x of [unit!, go!]) {
      expect(x.env.GOMODCACHE).toBeDefined();
      expect((x.profile as { readablePaths?: string[] }).readablePaths).toContain(x.env.GOMODCACHE);
      expect(x.profile.writablePaths).not.toContain(x.env.GOMODCACHE);
      expect(x.profile.writablePaths.some((p) => x.env.GOCACHE!.startsWith(`${p}/`))).toBe(true);
    }
    // Doctor created no cache.
    expect(existsSync(join(orbitHome, 'toolchains'))).toBe(false);
  });

  it('mounts an existing repository cache read-only and says so', async () => {
    const w = world(['cargo']);
    writeFileSync(join(w.repo, 'Cargo.toml'), '[package]\nname = "acme"\n');
    const orbitHome = temp('orbit-doctor-orbit-');
    const cache = join(orbitHome, 'toolchains', repoKeyFor(w.repo), 'cargo');
    mkdirSync(cache, { recursive: true });
    const s = srtLike();
    const c = await checkSandboxCheck({ config: config([{ id: 'unit', command: ['cargo', 'test'] }]), repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.details).toContain(`toolchain rust: "cargo --version" ran in the sandbox; dependency cache ${cache} (read-only for checks and workers; dependencies.install_command is not set, so no run writes it); private per check attempt: CARGO_TARGET_DIR`);
    // With an install command, the install is what writes it (issue #33: the line said so for every repository).
    const withInstall = config([{ id: 'unit', command: ['cargo', 'test'] }]);
    withInstall.dependencies = { ...withInstall.dependencies, install_command: ['cargo', 'fetch'] };
    const installed = await checkSandboxCheck({ config: withInstall, repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(installed.details.find((d) => d.startsWith('toolchain rust:'))).toContain('(read-only for checks and workers, written by the dependency install); private per check attempt');
    withInstall.dependencies.install_existing_lockfile = false;
    const off = await checkSandboxCheck({ config: withInstall, repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(off.details.find((d) => d.startsWith('toolchain rust:'))).toContain('(read-only for checks and workers; dependencies.install_existing_lockfile is false, so no run writes it); private per check attempt');
    expect(s.wraps[0]!.env.CARGO_HOME).toBe(cache);
    expect((s.wraps[0]!.profile as { readablePaths?: string[] }).readablePaths).toContain(cache);
    expect(s.wraps[0]!.profile.writablePaths).not.toContain(cache);
  });

  it('starts a linked tool by its own name, as a multi-call binary needs (rustup\'s cargo is a link to rustup)', async () => {
    const w = world(['rustup']);
    symlinkSync('rustup', join(w.bin, 'cargo'));
    writeFileSync(join(w.repo, 'Cargo.toml'), '[package]\nname = "acme"\n');
    // A link on PATH into the repository is the repository's code, whatever its name.
    writeFileSync(join(w.repo, 'acme-lint'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    symlinkSync(join(w.repo, 'acme-lint'), join(w.bin, 'acme-lint'));
    const seen: string[][] = [];
    const launch: ProbeLaunch = async (argv) => (seen.push(argv), { exitCode: 0, output: '' });
    const cfg = config([{ id: 'unit', command: ['cargo', 'test'] }, { id: 'lint', command: ['acme-lint'] }]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome: temp('orbit-doctor-orbit-'), launch });
    expect(seen).toEqual([[join(w.bin, 'cargo'), '--version'], [join(w.bin, 'cargo'), '--version']]);
    expect(c.details[0]).toBe('unit: "cargo --version" ran in the sandbox');
    expect(c.details[1]).toBe('lint: not started ("acme-lint" is the repository\'s own code, which only a run executes)');
    expect(c.details[2]).toMatch(/^toolchain rust: "cargo --version" ran in the sandbox; /);
  });

  it('warns when the sandbox refuses a toolchain, and reports one it cannot find', async () => {
    const w = world(['make', 'python3']);
    writeFileSync(join(w.repo, 'pyproject.toml'), '');
    writeFileSync(join(w.repo, 'go.mod'), 'module acme\n');
    const launch: ProbeLaunch = async (argv) => (argv[0]!.endsWith('python3') ? { exitCode: 1, output: 'mkdir /Users/acme/.cache: Operation not permitted' } : { exitCode: 0, output: '' });
    const c = await checkSandboxCheck({ config: config([{ id: 'unit', command: ['make', 'test'], mandatory: true }]), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome: temp('orbit-doctor-orbit-'), launch });
    expect(c.status).toBe('warn');
    expect(c.summary).toBe('the sandbox refuses the python toolchain; checks that use it would block at their baseline');
    expect(c.details.find((d) => d.startsWith('toolchain go:'))).toMatch(/^toolchain go: not started \("go" was not found\); dependency cache /);
    expect(c.details.find((d) => d.startsWith('toolchain python:'))).toMatch(/^toolchain python: "python3 --version" was refused in the sandbox: the sandbox or the operating system refused a filesystem operation outside the check's checkout/);
  });

  it('reports toolchains only with an Orbit home, where their caches live; the check probe still gets their environment', async () => {
    const w = world(['go']);
    const s = srtLike();
    const c = await checkSandboxCheck({ config: config([{ id: 'unit', command: ['go', 'test', './...'] }]), repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.details).toEqual(['unit: "go version" ran in the sandbox']);
    expect(s.wraps[0]!.env.GOCACHE).toBeDefined();
    expect(s.wraps[0]!.profile.writablePaths.some((p) => s.wraps[0]!.env.GOMODCACHE!.startsWith(`${p}/`))).toBe(true);
  });
});

describe('checkSandboxCheck: the .NET build probe (issue #10)', () => {
  const MSBUILD_FAILURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', 'msbuild-node-pipe-denied.failure.txt'), 'utf8');
  const BUILD = ['build', 'Probe.App/Probe.App.csproj'];
  /** Every MSBuild fix names -m:1 and the alternative with its cost to the test host. */
  const MSBUILD_FIX = /-m:1.*DOTNET_PROCESSOR_COUNT=1 in .+ also works, but the test host then gets one processor too/;

  /** Every file under `dir`, relative and sorted, skipping what a build writes. */
  function files(dir: string, rel = ''): string[] {
    return readdirSync(join(dir, rel), { withFileTypes: true })
      .flatMap((e) => (e.isDirectory() ? files(dir, join(rel, e.name)) : [join(rel, e.name)]))
      .sort();
  }

  /** A launch that answers `dotnet help` with success and the build probe with `build`, seeing what the build ran in. */
  function launches(build: (opts: { cwd: string; env: Record<string, string> }) => { exitCode: number | null; output: string }) {
    const seen: { argv: string[]; files: string[]; env: Record<string, string> }[] = [];
    const launch: ProbeLaunch = async (argv, opts) => {
      seen.push({ argv, files: files(opts.cwd), env: opts.env });
      return argv[1] === 'build' ? build(opts) : { exitCode: 0, output: '' };
    };
    return { seen, launch };
  }

  /**
   * As MSBuild under srt: a build on more than one node (no -m:1, and not one processor from DOTNET_PROCESSOR_COUNT=1
   * unless a switch asks for more) starts a worker node, which records the refused pipe and fails.
   */
  function msbuild(opts: { cwd: string; env: Record<string, string> }, argv: readonly string[]) {
    const many = argv.some((a) => /^(?:--?|\/)(?:m|maxcpucount):(?:[2-9]|\d{2,})$/i.test(a));
    const one = argv.some((a) => /^(?:--?|\/)(?:m|maxcpucount):1$/i.test(a)) || opts.env.DOTNET_PROCESSOR_COUNT === '1';
    if (one && !many) return { exitCode: 0, output: 'Build succeeded.' };
    mkdirSync(join(opts.env.TMPDIR!, 'MSBuildTempacme'), { recursive: true });
    writeFileSync(join(opts.env.TMPDIR!, 'MSBuildTempacme', 'MSBuild_pid-4242_01234567.failure.txt'), MSBUILD_FAILURE);
    return { exitCode: 1, output: '  Determining projects to restore...\n\nBuild FAILED.\n    0 Warning(s)\n    0 Error(s)' };
  }

  /** A .NET repository with the given checks, and an Orbit home. */
  function dotnetWorld(checks: Partial<CheckDefinition>[]) {
    const w = world(['dotnet', 'make']);
    writeFileSync(join(w.repo, 'acme.sln'), '');
    return { w, cfg: config(checks), orbitHome: temp('orbit-doctor-orbit-') };
  }

  it('builds three generated projects with no packages in the check sandbox, with the check\'s -m:1, where a bare start covered no build', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', '-m:1'], mandatory: true }]);
    const s = srtLike();
    const { seen, launch } = launches(() => ({ exitCode: 0, output: 'Build succeeded.' }));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.status).toBe('pass');
    expect(c.details[0]).toBe('test: "dotnet help" ran in the sandbox');
    expect(c.details[1]).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj -m:1" ran in the sandbox \(three generated projects with no packages, one referencing the other two: their restore and build start MSBuild as a real build does\); dependency cache /);
    const build = seen.find((x) => x.argv[1] === 'build')!;
    expect(build.argv).toEqual([join(w.bin, 'dotnet'), ...BUILD, '-m:1']);
    expect(build.files).toEqual(['Directory.Build.props', 'Directory.Build.targets', 'Probe.App/App.cs','Probe.App/Probe.App.csproj', 'Probe.Left/Left.cs', 'Probe.Left/Probe.Left.csproj', 'Probe.Right/Probe.Right.csproj', 'Probe.Right/Right.cs']);
    // Orbit leaves the processor count alone, and the probe's own scratch is removed afterwards.
    expect(build.env.DOTNET_PROCESSOR_COUNT).toBeUndefined();
    expect(existsSync(build.env.TMPDIR!)).toBe(false);
  });

  // On macOS the install step cannot download NuGet packages (srt keeps the system trust service out of reach), so the
  // .NET line does not say the install fills the cache without saying that (checks.dotnet-packages has the command).
  // Review: the line said both that the first install creates the cache and that packages go in outside the sandbox,
  // and said it for a repository with no packages.
  it('says on macOS that a repository\'s NuGet packages go into the dependency cache outside the sandbox, and only where it has packages', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', '-m:1'], mandatory: true }]);
    const { launch } = launches(() => ({ exitCode: 0, output: 'Build succeeded.' }));
    const line = async (platform: NodeJS.Platform, nugetPackages: boolean) =>
      (await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch, platform, nugetPackages })).details.find((d) => d.startsWith('toolchain dotnet:'))!;
    expect(await line('darwin', true)).toContain(
      '(not created yet: on macOS the dependency install cannot download NuGet packages, so this repository\'s are restored into it outside the sandbox, as checks.dotnet-packages says); private per check attempt',
    );
    // No install command is configured here, and Orbit's own install is npm ci: nothing in a run creates the cache (issue #33).
    expect(await line('darwin', false)).toContain('(not created yet; dependencies.install_command is not set, so no run creates it); private per check attempt');
    expect(await line('linux', true)).toContain('(not created yet; dependencies.install_command is not set, so no run creates it); private per check attempt');
    for (const [platform, packages] of [['darwin', false], ['linux', true]] as const) expect(await line(platform, packages)).not.toContain('outside the sandbox');
    // Once it exists, checks and workers read it; on macOS it is still filled outside the sandbox.
    mkdirSync(join(toolchainCacheRoot(orbitHome, repoKeyFor(realpathSync(w.repo))), 'nuget'), { recursive: true });
    expect(await line('darwin', true)).toContain("(read-only for checks and workers; on macOS the dependency install cannot download NuGet packages, so this repository's are restored into it outside the sandbox, as checks.dotnet-packages says); private per check attempt");
    expect(await line('linux', true)).toContain('(read-only for checks and workers; dependencies.install_command is not set, so no run writes it); private per check attempt');
    // With an install command it is the install that creates and writes it.
    cfg.dependencies = { ...cfg.dependencies, install_command: ['dotnet', 'restore', '-m:1'] };
    expect(await line('linux', true)).toContain('(read-only for checks and workers, written by the dependency install); private per check attempt');
    rmSync(join(toolchainCacheRoot(orbitHome, repoKeyFor(realpathSync(w.repo))), 'nuget'), { recursive: true });
    expect(await line('linux', true)).toContain('(not created yet; the first dependency install creates it); private per check attempt');
  });

  // Orbit never changes a check's processor count (ADR 0009, addendum), so a dotnet check pins one MSBuild node in its
  // own command. One that does not is refused from its definition, before anything is started, with its command fixed.
  it('fails a mandatory check that runs dotnet test without -m:1 before any probe, naming its command with -m:1 added', async () => {
    const { w, cfg } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', 'tests/Acme.Tests'], mandatory: true }]);
    const { seen, launch } = launches(() => ({ exitCode: 0, output: '' }));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch });
    expect(seen).toEqual([]);
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('check test would start MSBuild worker nodes, which the sandbox refuses; a run would block at its baseline');
    expect(c.missing).toBe('dotnet commands that pin one MSBuild node (-m:1)');
    expect(c.details).toEqual(['test: runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp']);
    expect(c.fix!.startsWith('checks.test.command: ["dotnet", "test", "tests/Acme.Tests", "-m:1"] (MSBuild worker nodes cannot run in the check sandbox')).toBe(true);
    expect(c.fix).toMatch(MSBUILD_FIX);
  });

  it('only warns for an optional check without -m:1', async () => {
    const { w, cfg } = dotnetWorld([{ id: 'test', command: ['dotnet', 'build'], mandatory: false }]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.status).toBe('warn');
    expect(c.fix!.startsWith('checks.test.command: ["dotnet", "build", "-m:1"] ')).toBe(true);
  });

  it('fails a dotnet check that asks MSBuild for more than one node, which no probe of its own would show, before any run', async () => {
    const { w, cfg } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', '-m:4'], mandatory: true }]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.status).toBe('fail');
    expect(c.details).toEqual(['test: asks MSBuild for 4 nodes (-m:4), and the check sandbox refuses every MSBuild worker node its named pipe under /tmp']);
    expect(c.fix!.startsWith('checks.test.command: ["dotnet", "test", "-m:1"] ')).toBe(true);
  });

  it('fails a dependency install command that runs dotnet restore without -m:1, naming dependencies.install_command', async () => {
    const { w, cfg } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', '-m:1'], mandatory: true }]);
    cfg.dependencies.install_command = ['dotnet', 'restore', '--locked-mode'];
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('dependencies.install_command would start MSBuild worker nodes, which the sandbox refuses; a run would block at its baseline');
    expect(c.details).toContain('dependencies.install_command: runs "dotnet restore" without -m:1, so MSBuild starts a worker node per processor, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp');
    expect(c.fix).toMatch(/^dependencies\.install_command: \["dotnet", "restore", "--locked-mode", "-m:1"\] \(MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under \/tmp, which the sandbox refuses; docs\/troubleshooting\.md/);
    // The install is Orbit's own step, with no env a person sets: no DOTNET_PROCESSOR_COUNT alternative for it.
    expect(c.fix).not.toContain('DOTNET_PROCESSOR_COUNT');
    // One that goes through make cannot be judged; with -m:1, or without a dependency install, nothing is said.
    cfg.dependencies.install_command = ['make', 'deps'];
    const make = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(make.status).toBe('warn');
    expect(make.summary).toBe('doctor cannot tell whether dependencies.install_command runs MSBuild on one node; one that does not is stopped as soon as MSBuild records the refused node');
    expect(make.details).toContain('dependencies.install_command: may run dotnet through make, so doctor cannot tell whether each of its MSBuild calls passes -m:1');
    for (const over of [{ install_command: ['dotnet', 'restore', '--locked-mode', '-m:1'] }, { install_existing_lockfile: false }]) {
      cfg.dependencies = { ...cfg.dependencies, install_command: ['dotnet', 'restore'], ...over };
      const ok = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
      expect(ok.status, JSON.stringify(over)).toBe('pass');
    }
  });

  it('warns that it cannot tell for make, a script or a shell line with a pipe in a .NET repository, and names the fix, still probing them', async () => {
    const { w, cfg } = dotnetWorld([
      { id: 'test', command: ['make', 'test'], mandatory: true },
      { id: 'chain', command: ['cd src && dotnet test -m:1 | tee test.log'], shell: true, mandatory: true },
    ]);
    const seen: string[][] = [];
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async (argv) => (seen.push(argv), { exitCode: 0, output: '' }) });
    expect(c.status).toBe('warn');
    expect(c.summary).toBe('doctor cannot tell whether checks test, chain run MSBuild on one node; one that does not is stopped as soon as MSBuild records the refused node');
    expect(c.details).toEqual([
      'test: may run dotnet through make, so doctor cannot tell whether each of its MSBuild calls passes -m:1',
      'test: "make --version" ran in the sandbox',
      'chain: runs dotnet in a shell line, so doctor cannot tell whether each of its MSBuild calls passes -m:1',
      'chain: not started (shell builtin "cd")',
    ]);
    expect(seen).toEqual([[join(w.bin, 'make'), '--version']]);
    expect(c.missing).toBe('dotnet commands that pin one MSBuild node (-m:1)');
    expect(c.fix).toContain('pass -m:1 to every dotnet build, test, publish, pack, restore, clean or msbuild that checks.test.command (["make", "test"]) starts, and build before dotnet run --no-build; ');
    expect(c.fix).toContain('that checks.chain.command (["cd src && dotnet test -m:1 | tee test.log"]) starts');
    // One reason for both, at the end.
    expect(c.fix!.split('MSBuild worker nodes cannot run in the check sandbox').length - 1).toBe(1);
  });

  it('fails, naming the denied pipe, when the sandbox refuses the probe\'s build an MSBuild node', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', 'tests/Acme.Tests'], mandatory: true }]);
    const { seen, launch } = launches((opts) => msbuild(opts, seen.at(-1)!.argv));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.status).toBe('fail');
    // The check is refused from its definition; the probe builds as the check would, without -m:1, and is refused too.
    expect(seen.map((x) => x.argv.slice(1))).toEqual([BUILD]);
    expect(c.details.find((d) => d.startsWith('toolchain dotnet:'))).toMatch(
      /^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj" was refused in the sandbox: MSBuild node \(pid 4242\) could not bind its named pipe \/tmp\/MSBuild4242 \(System\.Net\.Sockets\.SocketException \(13\): Permission denied\); /,
    );
    expect(c.fix!.startsWith('checks.test.command: ["dotnet", "test", "tests/Acme.Tests", "-m:1"] ')).toBe(true);
    expect(c.fix!.split('checks.test.command:').length - 1).toBe(1);
  });

  it('only warns for a refused probe when no mandatory check runs dotnet itself', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'lint', command: ['acme-lint'], mandatory: true }]);
    writeFileSync(join(w.bin, 'acme-lint'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const { launch } = launches(() => ({ exitCode: 1, output: 'Build FAILED.' }));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.status).toBe('warn');
    expect(c.summary).toBe('the sandbox refuses the dotnet toolchain; checks that use it would block at their baseline');
  });

  // Round 2 of the review: doctor and the runner must agree, so the probe builds with the node switch the check passes.
  it('carries the check\'s own node switch over to the probe, so a check that raises DOTNET_PROCESSOR_COUNT in its env and passes -maxcpucount:1 passes', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', '-maxcpucount:1'], mandatory: true, env: { DOTNET_PROCESSOR_COUNT: '8' } }]);
    const { seen, launch } = launches((opts) => msbuild(opts, seen.at(-1)!.argv));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.details.find((d) => d.startsWith('toolchain dotnet:'))).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj -maxcpucount:1" ran in the sandbox \(three generated projects/);
    expect(c.status).toBe('pass');
    const build = seen.find((x) => x.argv[1] === 'build')!;
    expect(build.argv).toEqual([join(w.bin, 'dotnet'), ...BUILD, '-maxcpucount:1']);
    expect(build.env.DOTNET_PROCESSOR_COUNT).toBe('8');
  });

  it('builds as the check would: without a switch, with a bare -m, and with -m:1 (the fix) for a check that does not run dotnet itself', async () => {
    for (const [command, switches] of [[['dotnet', 'test'], []], [['dotnet', 'test', '-m'], ['-m']], [['make', 'test'], ['-m:1']]] as const) {
      const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: [...command], mandatory: true, env: { ACME_MODE: 'ci' } }]);
      const { seen, launch } = launches(() => ({ exitCode: 0, output: '' }));
      await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
      const build = seen.find((x) => x.argv[1] === 'build')!;
      expect(build.argv, command.join(' ')).toEqual([join(w.bin, 'dotnet'), ...BUILD, ...switches]);
      // The sandbox of the check that uses .NET: its env too.
      expect(build.env.ACME_MODE).toBe('ci');
    }
  });

  it('fails when the generated project does not build, even with no denial in the output: it needs nothing but the SDK', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', '-m:1'], mandatory: true }]);
    const { launch } = launches(() => ({ exitCode: 1, output: '  Determining projects to restore...\n\nBuild FAILED.\n    0 Warning(s)\n    0 Error(s)' }));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.status).toBe('fail');
    expect(c.details[1]).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj -m:1" exited 1 in the sandbox: three generated projects with no packages, one referencing the other two did not build: Determining projects to restore\.\.\. Build FAILED\./);
    expect(c.fix).toMatch(/^the generated project needs nothing but the toolchain, so build it outside the sandbox/);
  });

  // Review round 4: DOTNET_PROCESSOR_COUNT=1 in the check's own env, the alternative doctor's fix names, gives MSBuild
  // one node and the runner passes the check; doctor failed it, and its fix named the setting the check already had.
  it('passes a mandatory check whose own env sets DOTNET_PROCESSOR_COUNT=1, and builds the probe in that env as the runner would', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'envalt', command: ['dotnet', 'build', 'tests/Acme.Tests'], mandatory: true, env: { DOTNET_PROCESSOR_COUNT: '1' } }]);
    const { seen, launch } = launches((opts) => msbuild(opts, seen.at(-1)!.argv));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.status).toBe('pass');
    expect(c.details[0]).toBe('envalt: "dotnet help" ran in the sandbox');
    expect(c.details[1]).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj" ran in the sandbox \(three generated projects/);
    const build = seen.find((x) => x.argv[1] === 'build')!;
    expect(build.argv).toEqual([join(w.bin, 'dotnet'), ...BUILD]);
    expect(build.env.DOTNET_PROCESSOR_COUNT).toBe('1');
  });

  it('fails a check on one processor whose switch asks for more nodes, without naming the setting it has as the fix', async () => {
    const { w, cfg } = dotnetWorld([{ id: 'envalt', command: ['dotnet', 'build', '-m:4'], mandatory: true, env: { DOTNET_PROCESSOR_COUNT: '1' } }]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.status).toBe('fail');
    expect(c.details).toEqual(['envalt: asks MSBuild for 4 nodes (-m:4), and the check sandbox refuses every MSBuild worker node its named pipe under /tmp']);
    expect(c.fix!.startsWith('checks.envalt.command: ["dotnet", "build", "-m:1"] (MSBuild worker nodes')).toBe(true);
    expect(c.fix).not.toContain('DOTNET_PROCESSOR_COUNT');
  });

  it('does not blame a missing -m:1 when the probe of a check on one processor fails without a refused node', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test'], mandatory: true, env: { DOTNET_PROCESSOR_COUNT: '1' } }]);
    const { launch } = launches(() => ({ exitCode: 1, output: 'Build FAILED.' }));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.details.find((d) => d.startsWith('toolchain dotnet:'))).toMatch(/^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj" exited 1 in the sandbox: three generated projects with no packages, one referencing the other two did not build/);
    expect(c.fix).toMatch(/^the generated project needs nothing but the toolchain/);
  });

  // Review round 4: the probe carried the -m:1 after `--`, which dotnet test hands to the test runner.
  it('refuses dotnet test whose -m:1 comes after --, and builds the probe without it, as the runner would', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test', 'tests/Acme.Tests', '--', '-m:1'], mandatory: true }]);
    const { seen, launch } = launches((opts) => msbuild(opts, seen.at(-1)!.argv));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.status).toBe('fail');
    expect(c.details[0]).toBe('test: runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp');
    expect(seen.find((x) => x.argv[1] === 'build')!.argv).toEqual([join(w.bin, 'dotnet'), ...BUILD]);
    expect(c.fix!.startsWith('checks.test.command: ["dotnet", "test", "tests/Acme.Tests", "-m:1", "--", "-m:1"] ')).toBe(true);
  });

  // Review round 4: the fix doctor prints for dotnet run is a chain, which doctor then warned it could not judge.
  it('passes the chain its own fix prescribes for dotnet run, and a cd before a pinned command', async () => {
    const { w, cfg } = dotnetWorld([
      { id: 'smoke', command: ['dotnet build -m:1 && dotnet run --project src/Acme --no-build'], shell: true, mandatory: true },
      { id: 'unit', command: ['cd tests && dotnet test -m:1'], shell: true, mandatory: true },
    ]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.status).toBe('pass');
    expect(c.details).toEqual(['smoke: "dotnet help" ran in the sandbox', 'unit: not started (shell builtin "cd")']);
  });

  // Review round 4: one explanation for several fixes, and a summary that names what the sandbox refuses.
  it('names every check that would start worker nodes in one summary, and gives the reason once after their fixed commands', async () => {
    const { w, cfg } = dotnetWorld([
      { id: 'unit', command: ['dotnet', 'test'], mandatory: true },
      { id: 'pack', command: ['dotnet', 'pack'], mandatory: true },
    ]);
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('checks unit, pack would start MSBuild worker nodes, which the sandbox refuses; a run would block at its baseline');
    expect(c.missing).toBe('dotnet commands that pin one MSBuild node (-m:1)');
    expect(c.fix).toBe(
      'checks.unit.command: ["dotnet", "test", "-m:1"]; checks.pack.command: ["dotnet", "pack", "-m:1"] (MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under /tmp, which the sandbox refuses; DOTNET_PROCESSOR_COUNT=1 in checks.unit.env and checks.pack.env also works, but the test host then gets one processor too, where xunit before 2.8 deadlocks a test that blocks on async code; docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")',
    );
  });

  it('builds the probe with -m:1 for a check whose dotnet command does not build (dotnet format whitespace --folder), and passes', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes'], mandatory: true }]);
    const { seen, launch } = launches((opts) => msbuild(opts, seen.at(-1)!.argv));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(seen.find((x) => x.argv[1] === 'build')!.argv).toEqual([join(w.bin, 'dotnet'), ...BUILD, '-m:1']);
    expect(c.status).toBe('pass');
  });

  it('names the missing -m:1 when a probe built without it fails and MSBuild left no record of the refused node (Linux)', async () => {
    const { w, cfg, orbitHome } = dotnetWorld([{ id: 'test', command: ['dotnet', 'test'], mandatory: true }]);
    const { launch } = launches(() => ({ exitCode: 1, output: 'Build FAILED.' }));
    const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, launch });
    expect(c.details.find((d) => d.startsWith('toolchain dotnet:'))).toMatch(
      /^toolchain dotnet: "dotnet build Probe\.App\/Probe\.App\.csproj" was refused in the sandbox: runs "dotnet build" without -m:1, so MSBuild starts a worker node per processor, and the build failed \(exited 1\) with no record of which node was refused; /,
    );
    expect(c.fix).toMatch(MSBUILD_FIX);
  });

  // dotnet format loads the project through MSBuildWorkspace's build host, whose named pipe Roslyn binds at /tmp/<guid>
  // whatever TMPDIR says, which the sandbox refuses (ADR 0009, addendum): measured, the check failed after the build
  // host's 60 s connect timeout on macOS (SDK 9) and at once on Linux (SDK 10). Only whitespace --folder loads nothing.
  describe('dotnet format', () => {
    // These pin Linux, where srt lays an empty tmpfs over a denied directory, so the folder form lists the folders above
    // a run's checkout; on macOS it cannot (the describe block below).
    const FORMAT_FIX = /\(dotnet format loads the project through a build host, a separate process whose named pipe \.NET binds under \/tmp, which the check sandbox refuses/;

    it('fails a mandatory dotnet format check that loads the project, before any probe, with whitespace --folder ready to paste', async () => {
      const { w, cfg } = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', '--verify-no-changes'], mandatory: true }]);
      const { seen, launch } = launches(() => ({ exitCode: 0, output: 'Build succeeded.' }));
      const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch });
      expect(seen).toEqual([]);
      expect(c.status).toBe('fail');
      expect(c.summary).toBe('check format runs dotnet format, which loads the project through a build host the sandbox refuses its named pipe; a run would block at its baseline');
      expect(c.details).toEqual(['format: runs "dotnet format --verify-no-changes", which loads the project through a build host whose named pipe .NET binds under /tmp, and the check sandbox refuses it']);
      expect(c.missing).toBe('dotnet format checks that load no project (dotnet format whitespace --folder)');
      expect(c.fix!.startsWith('checks.format.command: ["dotnet", "format", "whitespace", "--folder", "--verify-no-changes"] (dotnet format loads the project')).toBe(true);
      expect(c.fix).toMatch(FORMAT_FIX);
      expect(c.fix).not.toMatch(/[\u2013\u2014]/);
    });

    it('fails every form that loads the project, --no-restore after a pinned restore included, and only warns for an optional one', async () => {
      for (const command of [['dotnet', 'format', 'style', '--verify-no-changes'], ['dotnet', 'format', 'whitespace', '--verify-no-changes'], ['dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore']]) {
        const { w, cfg } = dotnetWorld([{ id: 'format', command, shell: command.length === 1, mandatory: true }]);
        const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: async () => ({ exitCode: 0, output: '' }) });
        expect(c.status, command.join(' ')).toBe('fail');
      }
      const { w, cfg } = dotnetWorld([{ id: 'format', command: ['dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore'], shell: true, mandatory: false }]);
      const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(c.status).toBe('warn');
      expect(c.fix!.startsWith('checks.format.command: ["dotnet restore -m:1 && dotnet format whitespace --folder --verify-no-changes"] (dotnet format loads')).toBe(true);
    });

    it('starts whitespace --folder like any check, and says nothing of dotnet format where checks do not run under srt', async () => {
      const { w, cfg } = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes'], mandatory: true }]);
      const ok = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(ok).toMatchObject({ status: 'pass', details: ['format: "dotnet help" ran in the sandbox'] });
      const loads = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', '--verify-no-changes'], mandatory: true }]);
      const none = await checkSandboxCheck({ config: loads.cfg, repo: loads.w.repo, provider: new NoIsolation(), available: true, env: loads.w.env, homeDir: loads.w.home, platform: 'linux', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(none.status).toBe('pass');
    });

    // Review: a chain that builds without -m:1 and runs dotnet format got only -m:1, so the pasted command was refused
    // again on the next doctor run for its format.
    it('fixes a chain that builds without -m:1 and runs a dotnet format that loads the project in one command, with both reasons', async () => {
      const { w, cfg } = dotnetWorld([{ id: 'ci', command: ['dotnet build && dotnet format --verify-no-changes'], shell: true, mandatory: true }]);
      const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(c.status).toBe('fail');
      expect(c.summary).toBe("check ci would start MSBuild worker nodes or dotnet format's build host, whose named pipes the sandbox refuses; a run would block at its baseline");
      expect(c.details).toEqual([
        'ci: runs "dotnet build" without -m:1, so MSBuild starts a worker node per processor, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp',
        'ci: runs "dotnet format --verify-no-changes", which loads the project through a build host whose named pipe .NET binds under /tmp, and the check sandbox refuses it',
      ]);
      expect(c.fix!.startsWith('checks.ci.command: ["dotnet build -m:1 && dotnet format whitespace --folder --verify-no-changes"] (MSBuild worker nodes cannot run in the check sandbox')).toBe(true);
      expect(c.fix).toMatch(FORMAT_FIX);
      expect(c.fix!.match(/dotnet format loads the project through a build host/g)).toHaveLength(1);
      // The fixed command passes doctor's judgement: it would start the executable now.
      const again = dotnetWorld([{ id: 'ci', command: ['dotnet build -m:1 && dotnet format whitespace --folder --verify-no-changes'], shell: true, mandatory: true }]);
      const ok = await checkSandboxCheck({ config: again.cfg, repo: again.w.repo, provider: srtLike().provider, available: true, env: again.w.env, homeDir: again.w.home, platform: 'linux', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(ok.status).toBe('pass');
    });

    // Review: SDK 8, pinned by global.json, loads the project in dotnet format's own process (measured under srt: it
    // runs with --no-restore after a pinned restore, or on one processor); doctor refused it for a build host it has not.
    it('with SDK 8 pinned by global.json, refuses only a format whose implicit restore would start worker nodes, fixed with a pinned restore first', async () => {
      const sdk8 = (checks: Partial<CheckDefinition>[]) => {
        const world8 = dotnetWorld(checks);
        writeFileSync(join(world8.w.repo, 'global.json'), '{ "sdk": { "version": "8.0.303" } }\n');
        return world8;
      };
      const plain = sdk8([{ id: 'format', command: ['dotnet', 'format', '--verify-no-changes'], mandatory: true }]);
      const c = await checkSandboxCheck({ config: plain.cfg, repo: plain.w.repo, provider: srtLike().provider, available: true, env: plain.w.env, homeDir: plain.w.home, launch: async () => ({ exitCode: 0, output: '' }) });
      expect(c.status).toBe('fail');
      expect(c.summary).toBe('check format would start MSBuild worker nodes, which the sandbox refuses; a run would block at its baseline');
      expect(c.details).toEqual([
        'format: runs "dotnet format --verify-no-changes", which restores the project first with a worker node per processor (SDK 8, which global.json pins, loads the project in its own process), and the check sandbox refuses every MSBuild worker node its named pipe under /tmp',
      ]);
      expect(c.fix!.startsWith('checks.format.command: ["dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore"] with checks.format.shell: true (dotnet format passes no -m:1 to the restore it runs first')).toBe(true);
      expect(c.fix).toMatch(MSBUILD_FIX);
      expect(c.fix).not.toMatch(FORMAT_FIX);
      for (const check of [
        { id: 'format', command: ['dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore'], shell: true, mandatory: true },
        { id: 'format', command: ['dotnet', 'format', 'style', '--verify-no-changes'], mandatory: true, env: { DOTNET_PROCESSOR_COUNT: '1' } },
      ]) {
        const ok = sdk8([check]);
        const r = await checkSandboxCheck({ config: ok.cfg, repo: ok.w.repo, provider: srtLike().provider, available: true, env: ok.w.env, homeDir: ok.w.home, launch: async () => ({ exitCode: 0, output: '' }) });
        expect(r.status, JSON.stringify(check.command)).toBe('pass');
      }
    });

    it('names both causes, each reason once, when one check is refused worker nodes and another the build host', async () => {
      const { w, cfg } = dotnetWorld([
        { id: 'unit', command: ['dotnet', 'test'], mandatory: true },
        { id: 'format', command: ['dotnet', 'format', '--verify-no-changes'], mandatory: true },
        { id: 'style', command: ['dotnet', 'format', 'style', '--verify-no-changes'], mandatory: false },
      ]);
      const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(c.status).toBe('fail');
      expect(c.summary).toBe("checks unit, format, style would start MSBuild worker nodes or dotnet format's build host, whose named pipes the sandbox refuses; a run would block at its baseline");
      expect(c.missing).toBe('dotnet commands that pin one MSBuild node (-m:1), and dotnet format checks that load no project (dotnet format whitespace --folder)');
      expect(c.fix).toMatch(/^checks\.unit\.command: \["dotnet", "test", "-m:1"\] \(MSBuild worker nodes cannot run in the check sandbox.*\); checks\.format\.command: \["dotnet", "format", "whitespace", "--folder", "--verify-no-changes"\]; checks\.style\.command: \["dotnet", "format", "whitespace", "--folder", "--verify-no-changes"\] \(dotnet format loads/);
      expect(c.fix!.match(/dotnet format loads the project through a build host/g)).toHaveLength(1);
    });
  });

  // Review: doctor passed `dotnet format whitespace --folder` (its probe started `dotnet help`), and in every real run on
  // macOS the check died at once with "UnauthorizedAccessException: Access to the path '<orbit home>/worktrees/<key>/<run>'
  // is denied": the folder form lists every folder above the checkout for .editorconfig files, and a run's checkout sits
  // in the Orbit home, which the check profile read-denies but for the checkout itself.
  describe('dotnet format on macOS, where a run\'s checkout sits in the read-denied Orbit home', () => {
    const OUTSIDE = /^remove checks\.format from \.orbit\/config\.yaml and run dotnet format in CI \(on macOS no form of dotnet format runs in a run's check sandbox with SDK 9 and later: /;

    it('fails a mandatory folder-form check before starting it, with running dotnet format outside Orbit as its fix', async () => {
      const { w, cfg } = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes'], mandatory: true }]);
      const { seen, launch } = launches(() => ({ exitCode: 0, output: '' }));
      // The default Orbit home, ~/.orbit, which every check profile read-denies.
      const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'darwin', launch });
      expect(seen).toEqual([]);
      expect(c.status).toBe('fail');
      expect(c.summary).toBe("check format runs dotnet format, which cannot run in a run's check sandbox on macOS; a run would block at its baseline");
      expect(c.details).toEqual([
        'format: runs "dotnet format whitespace --folder --verify-no-changes", which lists every folder above the checkout for .editorconfig files, while a run\'s checkout sits in the Orbit home, which the check sandbox does not let it read, and the check sandbox refuses it',
      ]);
      expect(c.missing).toBe('dotnet format run outside Orbit, in CI');
      expect(c.fix).toMatch(OUTSIDE);
      expect(c.fix).not.toMatch(/whitespace --folder --verify-no-changes"\]/);
      expect(c.fix).not.toMatch(/[\u2013\u2014]/);
    });

    // Issue #32: doctor's fix offered checks.format.mandatory: false, and with it set a contract that cited the check in a
    // criterion required it anyway; it is run on the base revision first and blocks that run, so optional is no fix.
    it('warns for an optional format that cannot run, says a run that requires it blocks, and never offers making it optional', async () => {
      const { w, cfg } = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', '--verify-no-changes'], mandatory: false }]);
      const c = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'darwin', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(c.status).toBe('warn');
      expect(c.summary).toBe("check format runs dotnet format, which cannot run in a run's check sandbox on macOS; a run whose contract requires it would block at its baseline");
      expect(c.fix).toMatch(OUTSIDE);
      expect(c.fix).not.toMatch(/mandatory/);
    });

    it('fails a format that loads the project with the same fix, not the folder form, and keeps -m:1 for a chain\'s build', async () => {
      const loads = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', '--verify-no-changes'], mandatory: true }]);
      const c = await checkSandboxCheck({ config: loads.cfg, repo: loads.w.repo, provider: srtLike().provider, available: true, env: loads.w.env, homeDir: loads.w.home, platform: 'darwin', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(c.status).toBe('fail');
      expect(c.fix).toMatch(OUTSIDE);
      expect(c.fix!.match(/on macOS no form of dotnet format runs/g)).toHaveLength(1);
      const chain = dotnetWorld([{ id: 'format', command: ['dotnet build && dotnet format --verify-no-changes'], shell: true, mandatory: true }]);
      const both = await checkSandboxCheck({ config: chain.cfg, repo: chain.w.repo, provider: srtLike().provider, available: true, env: chain.w.env, homeDir: chain.w.home, platform: 'darwin', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(both.status).toBe('fail');
      expect(both.summary).toBe("check format would start MSBuild worker nodes, whose named pipes the sandbox refuses, or run dotnet format, which cannot run in a run's check sandbox on macOS; a run would block at its baseline");
      expect(both.fix!.startsWith('checks.format.command: ["dotnet build -m:1 && dotnet format --verify-no-changes"] (MSBuild worker nodes cannot run in the check sandbox')).toBe(true);
      expect(both.fix).toMatch(/; remove checks\.format from \.orbit\/config\.yaml and run dotnet format in CI \(on macOS no form/);
      expect(both.fix).not.toMatch(/whitespace --folder --verify-no-changes"/);
    });

    it('starts the folder form like any check when ORBIT_HOME is somewhere no rule denies, and passes SDK 8\'s pinned restore first', async () => {
      const { w, cfg, orbitHome } = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes'], mandatory: true }]);
      const ok = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, orbitHome, platform: 'darwin', launch: async () => ({ exitCode: 0, output: 'Build succeeded.' }) });
      expect(ok.status, ok.details.join('\n')).toBe('pass');
      const sdk8 = dotnetWorld([{ id: 'format', command: ['dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore'], shell: true, mandatory: true }]);
      writeFileSync(join(sdk8.w.repo, 'global.json'), '{ "sdk": { "version": "8.0.303" } }\n');
      const pinned = await checkSandboxCheck({ config: sdk8.cfg, repo: sdk8.w.repo, provider: srtLike().provider, available: true, env: sdk8.w.env, homeDir: sdk8.w.home, platform: 'darwin', launch: async () => ({ exitCode: 0, output: '' }) });
      expect(pinned.status).toBe('pass');
    });

  });

  // Issue #33 (0.2.1 retest): after "set checks.format.mandatory: false", doctor still warned that a run would block at
  // its baseline and offered "set mandatory: false" again. PREFLIGHT runs mandatory checks only, so an optional check
  // blocks no run unconditionally; a run whose contract requires it runs it on the base revision first and blocks there
  // (issue #32, ADR 0012), so doctor still warns, says which run blocks, and never offers making it optional.
  describe('an optional check (issue #33): only a run whose contract requires it blocks', () => {
    const run = (cfg: OrbitConfig, w: ReturnType<typeof world>, orbitHome?: string) => checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'darwin', ...(orbitHome ? { orbitHome } : {}), launch: async () => ({ exitCode: 0, output: '' }) });

    it('warns about an optional dotnet format that cannot run on macOS in either form, names the run that blocks, and never offers set mandatory: false', async () => {
      for (const command of [['dotnet', 'format', '--verify-no-changes'], ['dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes']]) {
        const { w, cfg } = dotnetWorld([{ id: 'format', command, mandatory: false }]);
        const c = await run(cfg, w);
        expect(c.status, command.join(' ')).toBe('warn');
        expect(c.summary).toBe("check format runs dotnet format, which cannot run in a run's check sandbox on macOS; a run whose contract requires it would block at its baseline");
        expect(c.missing).toBe('dotnet format run outside Orbit, in CI');
        expect(c.fix).toMatch(/^remove checks\.format from \.orbit\/config\.yaml and run dotnet format in CI \(on macOS no form/);
        const text = [c.summary, ...c.details, c.fix].join('\n');
        expect(text).not.toMatch(/; a run would block at its baseline/);
        expect(text).not.toMatch(/mandatory: false/);
        expect(c.details).toEqual([`format: ${command.includes('whitespace') ? 'runs "dotnet format whitespace --folder --verify-no-changes", which lists every folder above the checkout for .editorconfig files, while a run\'s checkout sits in the Orbit home, which the check sandbox does not let it read' : 'runs "dotnet format --verify-no-changes", which loads the project through a build host whose named pipe .NET binds under /tmp'}, and the check sandbox refuses it`]);
      }
    });

    it('still fails the same check when it is mandatory, and offers "set mandatory: false" to neither', async () => {
      const mandatory = dotnetWorld([{ id: 'format', command: ['dotnet', 'format', '--verify-no-changes'], mandatory: true }]);
      const m = await run(mandatory.cfg, mandatory.w);
      expect(m.status).toBe('fail');
      expect(m.summary).toBe("check format runs dotnet format, which cannot run in a run's check sandbox on macOS; a run would block at its baseline");
      expect(m.fix).toMatch(/^remove checks\.format from \.orbit\/config\.yaml and run dotnet format in CI \(on macOS no form/);
      expect(m.fix).not.toMatch(/mandatory/);
      // An optional dotnet format inside a chain that also builds without -m:1 is still refused for the build, with the format taken out and no mandatory advice.
      const chain = dotnetWorld([{ id: 'format', command: ['dotnet build && dotnet format --verify-no-changes'], shell: true, mandatory: false }]);
      const c = await run(chain.cfg, chain.w);
      expect(c.status).toBe('warn');
      expect(c.fix).toMatch(/^checks\.format\.command: \["dotnet build -m:1 && dotnet format --verify-no-changes"\] \(MSBuild worker nodes cannot run/);
      expect(c.fix).toMatch(/; remove checks\.format from \.orbit\/config\.yaml and run dotnet format in CI \(on macOS no form/);
      expect(c.fix).not.toMatch(/mandatory/);
    });

    it('says only a run whose contract requires an optional check the sandbox refuses for another cause blocks, in place of "a run would block at its baseline"', async () => {
      const { w, cfg } = dotnetWorld([{ id: 'test', command: ['dotnet', 'build'], mandatory: false }]);
      const c = await run(cfg, w);
      expect(c.status).toBe('warn');
      expect(c.summary).toBe('check test would start MSBuild worker nodes, which the sandbox refuses; a run whose contract requires it would block at its baseline');
      const optionals = dotnetWorld([{ id: 'test', command: ['dotnet', 'build'], mandatory: false }, { id: 'docs', command: ['dotnet', 'build', 'docs'], mandatory: false }]);
      expect((await run(optionals.cfg, optionals.w)).summary).toBe('checks test, docs would start MSBuild worker nodes, which the sandbox refuses; a run whose contract requires one of them would block at its baseline');
      const mixed = dotnetWorld([{ id: 'build', command: ['dotnet', 'build'], mandatory: true }, { id: 'docs', command: ['dotnet', 'build', 'docs'], mandatory: false }]);
      expect((await run(mixed.cfg, mixed.w)).summary).toBe('checks build, docs would start MSBuild worker nodes, which the sandbox refuses; a run would block at its baseline');
    });
  });
});
