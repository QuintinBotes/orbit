// Review of issue #31: the issue asked doctor to say when workers cannot run a repository's tests. In the claude-sandbox
// tier a worker's build state (the toolchain scratch under its worker directory: GOCACHE, CARGO_TARGET_DIR,
// GRADLE_USER_HOME, the Maven local repository) is not writable by Claude Code's sandboxed Bash, so its own `go test` and
// `cargo test` fail before any test runs (measured with the real CLI), while the checks, under srt, run them.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { workerDotnetCheck, workerToolchainsCheck } from '../../../src/cli/commands/doctor-workers.ts';
import { nugetUserConfigPath } from '../../../src/isolation/toolchains.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('workerToolchainsCheck', () => {
  it('warns in the claude-sandbox tier for Go, Rust and the JVM, naming each, with the os-sandbox tier as the fix', () => {
    const [c, ...rest] = workerToolchainsCheck({ tier: 'claude-sandbox', toolchains: ['dotnet', 'go', 'jvm', 'python', 'rust'] });
    expect(rest).toEqual([]);
    expect(c).toMatchObject({ id: 'workers.toolchains', area: 'isolation', status: 'warn' });
    expect(c!.summary).toBe(
      "workers run in the claude-sandbox tier, where Claude Code's sandbox does not let their commands write their build state, so a worker cannot build or test Go, Rust or JVM code here and submits changes it could not test; the checks still run them",
    );
    expect(c!.details).toEqual([
      'go: GOCACHE and GOPATH are in the worker\'s private toolchain directory; go build and go test fail first ("failed to initialize build cache ... operation not permitted")',
      'rust: CARGO_TARGET_DIR is in the worker\'s private toolchain directory; cargo build and cargo test fail first ("failed to create directory ... Operation not permitted")',
      "jvm: GRADLE_USER_HOME and Maven's local repository are in the worker's private toolchain directory, which Gradle writes on every build and Maven whenever it resolves an artifact",
    ]);
    expect(c!.missing).toBe('the os-sandbox tier for workers, where the whole worker process is confined by sandbox-runtime and may write its build state');
    expect(c!.fix).toBe('export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) and use isolation.provider: sandbox-runtime (see claude.worker-tier)');
  });

  it('names only the toolchains the repository uses', () => {
    expect(workerToolchainsCheck({ tier: 'claude-sandbox', toolchains: ['rust'] })[0]!.summary).toMatch(/cannot build or test Rust code here/);
    expect(workerToolchainsCheck({ tier: 'claude-sandbox', toolchains: ['go', 'jvm'] })[0]!.summary).toMatch(/cannot build or test Go or JVM code here/);
  });

  it('says nothing for .NET, Python or Node, which need no build state of their own to run tests, nor in the os-sandbox tier', () => {
    expect(workerToolchainsCheck({ tier: 'claude-sandbox', toolchains: ['dotnet', 'python'] })).toEqual([]);
    expect(workerToolchainsCheck({ tier: 'claude-sandbox', toolchains: [] })).toEqual([]);
    expect(workerToolchainsCheck({ tier: 'os-sandbox', toolchains: ['go', 'jvm', 'rust'] })).toEqual([]);
  });
});

describe('workerDotnetCheck', () => {
  it('names the first NuGet restore a fresh account needs before its read-only worker home can run dotnet', () => {
    const home = mkdtempSync(join(tmpdir(), 'orbit-worker-home-'));
    dirs.push(home);
    const config = nugetUserConfigPath(home);
    const [c] = workerDotnetCheck({ homeDir: home, toolchains: ['dotnet'] });
    expect(c).toMatchObject({ id: 'workers.dotnet', area: 'isolation', status: 'warn' });
    expect(c!.summary).toBe(`NuGet's account config is missing at ${config}: a worker's HOME is read-only, so its first dotnet command would fail without a private CLI home`);
    expect(c!.details).toEqual([
      'NuGet creates this file on the account\'s first restore; checks use a private writable HOME and are not affected',
      'Orbit gives .NET a private CLI home before it starts a worker, so NuGet creates its config without letting that worker write the account home',
    ]);
    expect(c!.missing).toBe(`NuGet's account config at ${config}`);
    expect(c!.fix).toBe('run once outside Orbit: dotnet restore');

    mkdirSync(dirname(config), { recursive: true });
    writeFileSync(config, '<configuration />\n');
    expect(workerDotnetCheck({ homeDir: home, toolchains: ['dotnet'] })).toEqual([]);
    expect(workerDotnetCheck({ homeDir: home, toolchains: ['go'] })).toEqual([]);
  });
});
