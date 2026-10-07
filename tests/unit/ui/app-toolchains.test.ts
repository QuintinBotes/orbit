// The application under test gets the toolchain profile a check gets (issue #26; ADR 0009 and its addendum): the
// repository's dependency caches read-only, build state private to the run, and for .NET the NIS domain name rule, the
// check's .NET settings and the runner's early stop for a refused MSBuild worker node. Before, ui.environment.start_command
// ran in a sandbox built from the check profile alone. Measured under srt on macOS (SDK 9.0.305) with a web project
// referencing two libraries: `[dotnet, run, --project, Web]` never became ready (MSBuild waited out its node retries, the
// log said "(no output)" after 100 s); built with -m:1 first it ran, but its HttpClient died on "GetDomainName: -1".
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { NoIsolation } from '../../../src/isolation/none.ts';
import { toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import type { IsolationProvider, SandboxProfile, WrapOptions, WrappedCommand } from '../../../src/isolation/types.ts';
import { defaultCheck, defaultConfig, defaultUi } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import type { PolicySnapshot, UiConfig } from '../../../src/policy/types.ts';
import { exploreUi } from '../../../src/ui/explore.ts';
import { runUiChecks } from '../../../src/ui/runner.ts';
import { LAUNCH_ENV, type LaunchSpec } from '../../../src/ui/single-sandbox.ts';

const MSBUILD_FAILURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', 'msbuild-node-pipe-denied.failure.txt'), 'utf8');
/** Stands in for `dotnet run` under srt: MSBuild records the refused node in the temp directory, then waits. */
const REFUSED_NODE = `const fs = require('node:fs'); const dir = process.env.TMPDIR + '/MSBuildTempacme'; fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dir + '/MSBuild_pid-4242_01234567.failure.txt', ${JSON.stringify(MSBUILD_FAILURE)}); setTimeout(() => {}, 120000);`;

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();

let root: string;
let repo: string;
let home: string;
let cacheRoot: string;
let candidate: Candidate;
let n = 0;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-ui-tc-')));
  repo = join(root, 'repo');
  home = join(root, 'home');
  cacheRoot = toolchainCacheRoot(join(home, '.orbit'), 'abcdefabcdef');
  mkdirSync(join(repo, 'journeys'), { recursive: true });
  mkdirSync(join(repo, 'Web'), { recursive: true });
  mkdirSync(home);
  sh(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, '.gitignore'), 'test-results/\n');
  writeFileSync(join(repo, 'acme.sln'), '');
  writeFileSync(join(repo, 'Web', 'Web.csproj'), '<Project Sdk="Microsoft.NET.Sdk.Web" />\n');
  writeFileSync(join(repo, 'journeys', 'a.spec.ts'), "import { test } from '@playwright/test';\n");
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  const parentSha = sh(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'README.md'), '# acme\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'candidate');
  const commitSha = sh(repo, 'rev-parse', 'HEAD');
  candidate = { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-ui-tc', seq: 1, attempt: 1, commitSha, treeHash: sh(repo, 'rev-parse', 'HEAD^{tree}'), parentSha };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

function policy(port: number, start: string[], journeyHosts: string[] = []): { snapshot: PolicySnapshot; ui: UiConfig } {
  const config = defaultConfig('supervised');
  config.checks['ui-journeys'] = { ...defaultCheck('ui-journeys'), kind: 'playwright', command: ['playwright-cli', 'test'], timeout_seconds: 30, network_hosts: journeyHosts };
  config.ui = defaultUi();
  config.ui.journey_check_ids = ['ui-journeys'];
  config.ui.browsers = ['chromium'];
  config.ui.viewports = [{ width: 1440, height: 900 }];
  config.ui.accessibility.enabled = false;
  config.ui.environment.base_url = `http://127.0.0.1:${port}`;
  config.ui.environment.start_command = start;
  config.ui.environment.ready_timeout_seconds = 60;
  const { snapshot } = snapshotPolicy(config, { runId: 'orb-ui-tc', repoRoot: repo, runDir: join(home, `run-${++n}`), clock: new ManualClock() });
  return { snapshot, ui: snapshot.config.ui! };
}

interface Wrap {
  argv: string[];
  profile: SandboxProfile & { readablePaths?: string[] };
  env: Record<string, string>;
}

/**
 * A provider that records every wrap. The application (anything Orbit starts but the journeys) runs `app` in its place;
 * a journey check, or the single-sandbox launcher, runs `journey`.
 */
function recording(opts: { privateLoopback?: boolean; app?: (env: Record<string, string>) => string[]; journey?: (env: Record<string, string>) => string[] }): { provider: IsolationProvider; apps: Wrap[]; journeys: Wrap[] } {
  const apps: Wrap[] = [];
  const journeys: Wrap[] = [];
  const inner = new NoIsolation();
  const provider: IsolationProvider = {
    kind: 'sandbox-runtime',
    ...(opts.privateLoopback ? { privateLoopback: true } : {}),
    available: () => inner.available(),
    wrap(argv: string[], profile: SandboxProfile, o: WrapOptions): WrappedCommand {
      const journey = o.env.ORBIT_UI_RUN === '1';
      (journey ? journeys : apps).push({ argv, profile, env: o.env });
      const stand = journey ? (opts.journey?.(o.env) ?? [process.execPath, '-e', 'process.exit(1)']) : (opts.app?.(o.env) ?? [process.execPath, '-e', 'process.exit(1)']);
      return inner.wrap(stand, profile, o);
    },
  };
  return { provider, apps, journeys };
}

describe('the application under test gets its toolchain profile (issue #26)', () => {
  it('starts a .NET application with the repository\'s NuGet cache read-only, private build state, the check\'s .NET settings and the NIS rule', async () => {
    const port = await freePort();
    const p = policy(port, ['dotnet', 'run', '--project', 'Web']);
    const r = recording({});
    await runUiChecks({ checkoutDir: repo, snapshot: p.snapshot, candidate, uiConfig: p.ui, journeyCheckIds: ['ui-journeys'], isolation: r.provider, outDir: join(root, 'evidence', 'ui'), homeDir: home, hostEnv: { PATH: process.env.PATH, HOME: home }, toolchainCacheRoot: cacheRoot, appPollMs: 50 });
    const [app] = r.apps;
    expect(app!.argv).toEqual(['dotnet', 'run', '--project', 'Web']);
    const nuget = join(cacheRoot, 'nuget');
    expect(app!.env.NUGET_PACKAGES).toBe(nuget);
    expect(app!.profile.readablePaths).toContain(nuget);
    expect(app!.profile.writablePaths).not.toContain(nuget);
    expect(app!.profile.writablePaths.some((w) => app!.env.NUGET_HTTP_CACHE_PATH!.startsWith(w))).toBe(true);
    expect(app!.env).toMatchObject({ DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', EnableSourceControlManagerQueries: 'false', NuGetAudit: 'false' });
    expect(app!.profile.nisDomainName).toBe(true);
    // The application's own variables are still there.
    expect(app!.env).toMatchObject({ ORBIT_UI_BASE_URL: `http://127.0.0.1:${port}`, PORT: String(port) });
  }, 30_000);

  it('stops an application whose build MSBuild records a refused worker node for, at once, with the note and start_command in two steps', async () => {
    const port = await freePort();
    const p = policy(port, ['dotnet', 'run', '--project', 'Web']);
    const r = recording({ app: () => [process.execPath, '-e', REFUSED_NODE] });
    const started = Date.now();
    const result = await runUiChecks({ checkoutDir: repo, snapshot: p.snapshot, candidate, uiConfig: p.ui, journeyCheckIds: ['ui-journeys'], isolation: r.provider, outDir: join(root, 'evidence', 'ui'), homeDir: home, hostEnv: { PATH: process.env.PATH, HOME: home }, toolchainCacheRoot: cacheRoot, appPollMs: 50 });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.verdict).toBe('ERROR');
    expect(r.journeys).toHaveLength(0);
    const reason = result.reasons.find((x) => x.startsWith('the application did not start'))!;
    expect(reason).toContain('the sandbox of the application denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied); MSBuild waits 30 s for each of ten node starts before it fails, so Orbit stopped the application.');
    expect(reason).toContain('Fix: ui.environment.start_command: ["sh", "-c", "dotnet build Web -m:1 && dotnet run --project Web --no-build"]');
  }, 60_000);

  it('gives the application its profile inside the journey check\'s sandbox where every sandbox has its own loopback, with the journey check\'s hosts', async () => {
    const port = await freePort();
    const p = policy(port, ['dotnet', 'run', '--project', 'Web'], ['api.nuget.org']);
    // The launcher stand-in: MSBuild refused a node and the application exited before it was ready (as on Linux, at once).
    const launcher = (env: Record<string, string>): string[] => {
      const spec = JSON.parse(env[LAUNCH_ENV]!) as LaunchSpec;
      return [process.execPath, '-e', `${REFUSED_NODE.replace('setTimeout(() => {}, 120000);', '')} fs.writeFileSync(${JSON.stringify(spec.statusPath)}, JSON.stringify({ app: 'exited', code: 1, signal: null })); process.exit(98);`];
    };
    const r = recording({ privateLoopback: true, journey: launcher });
    const result = await runUiChecks({ checkoutDir: repo, snapshot: p.snapshot, candidate, uiConfig: p.ui, journeyCheckIds: ['ui-journeys'], isolation: r.provider, outDir: join(root, 'evidence', 'ui'), homeDir: home, hostEnv: { PATH: process.env.PATH, HOME: home }, toolchainCacheRoot: cacheRoot, appPollMs: 50 });
    expect(r.apps).toHaveLength(0);
    const [journey] = r.journeys;
    const spec = JSON.parse(journey!.env[LAUNCH_ENV]!) as LaunchSpec;
    const nuget = join(cacheRoot, 'nuget');
    // The application's variables reach the application only; the shared sandbox gets its paths and the NIS rule.
    expect(spec.app.env.NUGET_PACKAGES).toBe(nuget);
    expect(spec.app.env.DOTNET_NOLOGO).toBe('1');
    expect(journey!.env.NUGET_PACKAGES).toBeUndefined();
    expect(journey!.profile.readablePaths).toContain(nuget);
    expect(journey!.profile.nisDomainName).toBe(true);
    // The application shares the journey check's network, which reaches the package source: off macOS the audit runs.
    expect(spec.app.env.NuGetAudit).toBe(process.platform === 'darwin' ? 'false' : undefined);
    const reason = result.reasons.find((x) => x.startsWith('the application did not start'))!;
    expect(reason).toContain('the sandbox of the application denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied), and the application failed on it before Orbit\'s next look.');
    expect(reason).toContain('Fix: ui.environment.start_command: ["sh", "-c", "dotnet build Web -m:1 && dotnet run --project Web --no-build"]');
  }, 30_000);

  it('starts the explorer\'s application with the same profile', async () => {
    const port = await freePort();
    const p = policy(port, ['dotnet', 'run', '--project', 'Web']);
    const r = recording({ app: () => [process.execPath, '-e', REFUSED_NODE] });
    const explored = await exploreUi({
      checkoutDir: repo,
      snapshot: p.snapshot,
      candidate,
      uiConfig: p.ui,
      exploration: { enabled: true, budget_usd: 1, max_minutes: 5 },
      isolation: r.provider,
      outDir: join(root, 'evidence', 'ui-exploration'),
      explore: async () => ({ output: null, costUsd: 0, status: 'failed', error: 'not reached' }),
      authorSpec: async () => null,
      homeDir: home,
      hostEnv: { PATH: process.env.PATH, HOME: home },
      toolchainCacheRoot: cacheRoot,
      appPollMs: 50,
    });
    const [app] = r.apps;
    expect(app!.env.NUGET_PACKAGES).toBe(join(cacheRoot, 'nuget'));
    expect(app!.profile.readablePaths).toContain(join(cacheRoot, 'nuget'));
    expect(app!.profile.nisDomainName).toBe(true);
    expect(explored.outcome).toBe('app_failed');
    expect(explored.reasons.join('\n')).toContain('so Orbit stopped the application. Fix: ui.environment.start_command: ["sh", "-c", "dotnet build Web -m:1 && dotnet run --project Web --no-build"]');
  }, 60_000);
});
