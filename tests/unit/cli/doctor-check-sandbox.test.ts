// `orbit doctor`'s checks.sandbox (issue #10): each command check's executable started in the sandbox the check would
// get, with a harmless argument, so a denial shows before any run instead of as a failure of the base revision.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxCheck, type ProbeLaunch } from '../../../src/cli/commands/doctor-sandbox.ts';
import { NUGET_MIGRATIONS_DIR } from '../../../src/evidence/runner.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition, OrbitConfig } from '../../../src/policy/types.ts';

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
  return { repo, home, bin, env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home } };
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
      { id: 'build', command: ['dotnet', 'build'], network_hosts: ['api.nuget.org'] },
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
    const c = await checkSandboxCheck({ config: config([{ id: 'build', command: ['dotnet', 'build'], mandatory: true }]), repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, launch });
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
    const c = await checkSandboxCheck({ config: config([{ id: 'build', command: ['dotnet', 'build'], mandatory: true }]), repo: w.repo, provider: broken, available: true, env: w.env, homeDir: w.home });
    expect(c.status).toBe('fail');
    expect(c.details).toEqual(['build: could not be started in the sandbox: srt vanished']);
  });

  it('is not needed without command checks or under another provider, and not checked without isolation', async () => {
    const w = world();
    const none = await checkSandboxCheck({ config: config([]), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home });
    expect(none).toMatchObject({ status: 'pass', summary: 'not needed: no command check is defined' });
    const cfg = config([{ id: 'build', command: ['dotnet', 'build'] }]);
    const container = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: { kind: 'container', available: async () => ({ ok: true, detail: '' }), wrap: () => ({}) as never }, available: true, env: w.env, homeDir: w.home });
    expect(container).toMatchObject({ status: 'pass', summary: 'not needed: checks run under container, not in an OS sandbox on this host' });
    const down = await checkSandboxCheck({ config: cfg, repo: w.repo, provider: srtLike().provider, available: false, env: w.env, homeDir: w.home });
    expect(down).toMatchObject({ status: 'warn', summary: 'not checked: isolation is unavailable (see the isolation check)' });
    const noRepo = await checkSandboxCheck({ config: cfg, repo: null, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, launch: async () => ({ exitCode: 0, output: '' }) });
    expect(noRepo.status).toBe('pass');
  });
});
