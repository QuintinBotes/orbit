// `orbit doctor`'s static .NET rules for the commands Orbit starts besides checks and the dependency install (issue #26):
// ui.environment.start_command and a release environment's deploy_command and verify_command. Each runs in a sandbox
// built from the check profile, where MSBuild's worker nodes and dotnet format's build host are refused their named
// pipes under /tmp. Measured under srt on macOS (SDK 9.0.305): `ui.environment.start_command: [dotnet, run, --project,
// Web]` for a web project referencing two libraries never became ready (MSBuild waited out its node retries, four node
// reports in the application's temp directory after 100 s); `sh -c "dotnet build Web -m:1 && dotnet run --project Web
// --no-build"` builds in about four seconds. Doctor judged checks and the install only, so it said nothing.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxCheck, type ProbeLaunch } from '../../../src/cli/commands/doctor-sandbox.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import type { IsolationProvider, SandboxProfile, WrappedCommand } from '../../../src/isolation/types.ts';
import { defaultCheck, defaultConfig, defaultReleaseEnvironment, defaultReleaseMerge, defaultUi } from '../../../src/policy/config.ts';
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

/** A .NET repository, a home and a bin directory with dotnet and make (each `exit 0`), and a pinned test check. */
function world() {
  const repo = temp('orbit-doctor-repo-');
  const home = temp('orbit-doctor-home-');
  const bin = temp('orbit-doctor-bin-');
  for (const t of ['dotnet', 'make']) writeFileSync(join(bin, t), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(join(repo, 'acme.sln'), '');
  const cfg: OrbitConfig = defaultConfig('autonomous');
  cfg.checks = { test: { ...defaultCheck('test'), command: ['dotnet', 'test', '-m:1'], mandatory: true } as CheckDefinition };
  return { repo, home, env: { PATH: bin, HOME: home }, cfg };
}

function withApp(cfg: OrbitConfig, command: string[]): OrbitConfig {
  const ui = defaultUi();
  ui.environment.start_command = command;
  return { ...cfg, ui };
}

/** A release environment, in mode `release`, the only mode whose runs deploy (or `mode`, to see one that never does). */
function withRelease(cfg: OrbitConfig, deploy: string[], verify: string[] | null = null, mode: OrbitConfig['mode'] = 'release'): OrbitConfig {
  return { ...cfg, mode, release: { merge: defaultReleaseMerge(), environments: { production: { ...defaultReleaseEnvironment('main'), deploy_command: deploy, verify_command: verify } } } };
}

/** An srt-like provider that records every wrap and wraps nothing. */
function srtLike(): { provider: IsolationProvider; wraps: string[][] } {
  const wraps: string[][] = [];
  const inner = new NoIsolation();
  const provider = {
    kind: 'sandbox-runtime' as const,
    available: () => inner.available(),
    wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
      wraps.push(argv);
      return inner.wrap(argv, profile, opts);
    },
  };
  return { provider: provider as IsolationProvider, wraps };
}

const ok: ProbeLaunch = async () => ({ exitCode: 0, output: '' });
const REASON = /\(MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under \/tmp, which the sandbox refuses; docs\/troubleshooting\.md/;

describe('checkSandboxCheck: ui.environment.start_command (issue #26)', () => {
  it('fails a start command that runs dotnet run, before any probe of it, with the build and the run in two steps ready to paste', async () => {
    const w = world();
    const s = srtLike();
    const c = await checkSandboxCheck({ config: withApp(w.cfg, ['dotnet', 'run', '--project', 'Web']), repo: w.repo, provider: s.provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('ui.environment.start_command would start MSBuild worker nodes, which the sandbox refuses; a run would fail where Orbit starts it');
    expect(c.details).toContain('ui.environment.start_command: runs "dotnet run", which builds on a worker node per processor and hands -m:1 to the program, not to MSBuild, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp');
    // start_command is an argv, never run through a shell: the two steps are a sh -c script.
    expect(c.fix!.startsWith('ui.environment.start_command: ["sh", "-c", "dotnet build Web -m:1 && dotnet run --project Web --no-build"] (dotnet run hands -m:1 to the program')).toBe(true);
    expect(c.fix).toMatch(REASON);
    // The application has no env a person sets: no DOTNET_PROCESSOR_COUNT alternative for it.
    expect(c.fix).not.toContain('DOTNET_PROCESSOR_COUNT');
    expect(s.wraps.some((argv) => argv.includes('run'))).toBe(false);
    // The pasted command passes.
    const fixed = await checkSandboxCheck({ config: withApp(w.cfg, ['sh', '-c', 'dotnet build Web -m:1 && dotnet run --project Web --no-build']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(fixed.status, fixed.details.join('\n')).toBe('pass');
  });

  it('pins a build the start command runs itself, warns for one it cannot see, and says nothing of an application without .NET', async () => {
    const w = world();
    // An application that is already built runs no MSBuild.
    const built = await checkSandboxCheck({ config: withApp(w.cfg, ['dotnet', 'Web/bin/Release/net9.0/Web.dll']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(built.status).toBe('pass');
    const chain = await checkSandboxCheck({ config: withApp(w.cfg, ['sh', '-c', 'dotnet build && dotnet Web/bin/Debug/net9.0/Web.dll']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(chain.status).toBe('fail');
    expect(chain.fix!.startsWith('ui.environment.start_command: ["sh", "-c", "dotnet build -m:1 && dotnet Web/bin/Debug/net9.0/Web.dll"] ')).toBe(true);
    const make = await checkSandboxCheck({ config: withApp(w.cfg, ['make', 'serve']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(make.status).toBe('warn');
    expect(make.summary).toBe('doctor cannot tell whether ui.environment.start_command runs MSBuild on one node; one that does not is stopped as soon as MSBuild records the refused node');
    expect(make.details).toContain('ui.environment.start_command: may run dotnet through make, so doctor cannot tell whether each of its MSBuild calls passes -m:1');
    const node = world();
    rmSync(join(node.repo, 'acme.sln'));
    node.cfg.checks = {};
    const plain = await checkSandboxCheck({ config: withApp({ ...node.cfg, checks: { unit: { ...defaultCheck('unit'), command: ['make', 'test'] } } }, ['make', 'serve']), repo: node.repo, provider: srtLike().provider, available: true, env: node.env, homeDir: node.home, platform: 'linux', launch: ok });
    expect(plain.status).toBe('pass');
  });
});

describe('checkSandboxCheck: release commands (issue #26)', () => {
  it('fails a deploy command that publishes without -m:1, naming the environment\'s deploy_command, and warns for a verify_command through make', async () => {
    const w = world();
    const c = await checkSandboxCheck({ config: withRelease(w.cfg, ['dotnet', 'publish', 'src/Acme.Web', '-c', 'Release'], ['make', 'verify']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(c.status).toBe('fail');
    expect(c.summary).toBe('release.environments.production.deploy_command would start MSBuild worker nodes, which the sandbox refuses; a run would fail where Orbit starts it');
    expect(c.details).toContain('release.environments.production.deploy_command: runs "dotnet publish" without -m:1, so MSBuild starts a worker node per processor, and the check sandbox refuses every MSBuild worker node its named pipe under /tmp');
    expect(c.details).toContain('release.environments.production.verify_command: may run dotnet through make, so doctor cannot tell whether each of its MSBuild calls passes -m:1');
    expect(c.fix!.startsWith('release.environments.production.deploy_command: ["dotnet", "publish", "src/Acme.Web", "-c", "Release", "-m:1"]; pass -m:1 to every dotnet build, test, publish, pack, restore, clean or msbuild that release.environments.production.verify_command (["make", "verify"]) starts')).toBe(true);
    expect(c.fix).toMatch(REASON);
    expect(c.fix).not.toContain('DOTNET_PROCESSOR_COUNT');
    const pinned = await checkSandboxCheck({ config: withRelease(w.cfg, ['dotnet', 'publish', 'src/Acme.Web', '-c', 'Release', '-m:1'], ['dotnet', 'run', '--project', 'tools/Verify', '--no-build']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(pinned.status, pinned.details.join('\n')).toBe('pass');
  });

  it('fails a deploy command that runs a dotnet format that loads the project, with the folder form in its place (Linux)', async () => {
    const w = world();
    const c = await checkSandboxCheck({ config: withRelease(w.cfg, ['sh', '-c', 'dotnet format --verify-no-changes && fly deploy']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
    expect(c.status).toBe('fail');
    expect(c.details).toContain('release.environments.production.deploy_command: runs "dotnet format --verify-no-changes", which loads the project through a build host whose named pipe .NET binds under /tmp, and the check sandbox refuses it');
    expect(c.fix!.startsWith('release.environments.production.deploy_command: ["sh", "-c", "dotnet format whitespace --folder --verify-no-changes && fly deploy"] (dotnet format loads the project through a build host')).toBe(true);
  });

  // A review of #26 found that doctor failed a supervised configuration for a release block it never uses: only a run
  // in mode release merges or deploys (actions.merge and actions.deploy_production require it).
  it('does not judge the release commands of a mode that never releases', async () => {
    const w = world();
    for (const mode of ['supervised', 'autonomous', 'autonomous-delivery'] as const) {
      const c = await checkSandboxCheck({ config: withRelease(w.cfg, ['dotnet', 'publish', 'src/Acme.Web', '-c', 'Release'], ['dotnet', 'run', '--project', 'tools/Verify'], mode), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'linux', launch: ok });
      expect(c.status, `${mode}: ${c.summary}`).toBe('pass');
      expect(c.details.some((d) => d.includes('release.environments')), mode).toBe(false);
    }
  });

  it('names running dotnet format outside Orbit for a deploy command on macOS, where a run\'s checkout sits below the denied Orbit home', async () => {
    const w = world();
    const c = await checkSandboxCheck({ config: withRelease(w.cfg, ['sh', '-c', 'dotnet format whitespace --folder --verify-no-changes && fly deploy']), repo: w.repo, provider: srtLike().provider, available: true, env: w.env, homeDir: w.home, platform: 'darwin', launch: ok });
    expect(c.status).toBe('fail');
    expect(c.fix!.startsWith('remove dotnet format from release.environments.production.deploy_command and run it in CI (on macOS no form of dotnet format runs')).toBe(true);
  });
});
