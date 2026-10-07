// A .NET web application as ui.environment.start_command under the real srt (issue #26). The application under test
// got a sandbox built from the check profile alone, without the .NET toolchain's profile, and on macOS it never served
// a journey: measured with a web project referencing two libraries (SDK 9.0.305),
//
// - `[dotnet, run, --project, Web]` was not ready after 100 s with "(no output)": MSBuild was refused a worker node its
//   named pipe under /tmp and waited 30 s for each of ten node starts (four node reports sat in its temp directory);
// - built with -m:1 first (`dotnet build -m:1 && dotnet run --no-build`), its host hung at startup with no output,
//   because ASP.NET Core's configuration file watcher asks the FSEvents service, which srt denies (mach-lookup
//   com.apple.FSEvents), and once it polled, its HttpClient died on "GetDomainName: -1" (the NIS domain name rule).
//
// The application now gets the profile a check gets, the polling watcher, and the runner's early stop, which names the
// two-step start command. Skipped where srt or dotnet is missing, and on Linux, where every srt sandbox has its own
// loopback and the application runs inside the journey check's sandbox (tests/unit/ui/app-toolchains.test.ts).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import type { Candidate } from '../../../src/evidence/types.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import { which } from '../../../src/isolation/util.ts';
import { defaultCheck, defaultConfig, defaultUi } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import { runUiChecks } from '../../../src/ui/runner.ts';
import { freePort } from './helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: ROOT });
const probe = await provider.available();
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const skip = !probe.ok ? `srt unavailable: ${probe.detail}` : dotnet === null ? 'dotnet is not installed' : provider.privateLoopback ? 'every srt sandbox has its own loopback here' : null;

const TFM = '<TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework>';
const library = (name: string, member: string) => ({
  [`${name}/${name}.csproj`]: `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`,
  [`${name}/${name}.cs`]: `namespace Acme; public static class ${name} { ${member} }\n`,
});
/** A web project referencing two libraries, whose home page fetches another of its pages with HttpClient. No packages. */
const WEB: Record<string, string> = {
  'Directory.Build.props': '<Project />\n',
  'Directory.Build.targets': '<Project />\n',
  '.gitignore': 'bin/\nobj/\ntest-results/\n',
  ...library('Left', 'public static int One => 1;'),
  ...library('Right', 'public static int Two => 2;'),
  'Web/Web.csproj': `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup>${TFM}<ImplicitUsings>enable</ImplicitUsings></PropertyGroup><ItemGroup><ProjectReference Include="../Left/Left.csproj" /><ProjectReference Include="../Right/Right.csproj" /></ItemGroup></Project>\n`,
  'Web/Program.cs': [
    'var url = Environment.GetEnvironmentVariable("ORBIT_UI_BASE_URL")!;',
    'var app = WebApplication.Create(args);',
    'app.MapGet("/data", () => "acme " + (Acme.Left.One + Acme.Right.Two));',
    'app.MapGet("/", async () => { using var http = new HttpClient(); return "home " + await http.GetStringAsync(url + "/data"); });',
    'app.Run(url);',
    '',
  ].join('\n'),
  'journeys/a.spec.ts': "import { test } from '@playwright/test';\n",
};

/** The journeys, in place of Playwright: fetch the home page, say what came back, and pass when it is the application's. */
const JOURNEYS = `
const fs = require('fs'); const path = require('path');
const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE;
fs.mkdirSync(path.dirname(out), { recursive: true });
(async () => {
  let body = null;
  try { const r = await fetch(process.env.ORBIT_UI_BASE_URL); body = r.status + ' ' + await r.text(); } catch (e) { body = String(e.cause && e.cause.code || e.message); }
  fs.writeFileSync(path.join(path.dirname(out), 'seen.txt'), body);
  const passed = body === '200 home acme 3';
  fs.writeFileSync(out, JSON.stringify({ config: { version: '1.63.0', updateSnapshots: 'none', projects: [{ name: 'desktop' }] }, suites: [{ title: 'a.spec.ts', file: 'journeys/a.spec.ts', specs: [{ title: 'home', file: 'journeys/a.spec.ts', line: 3, tests: [{ projectName: 'desktop', status: passed ? 'expected' : 'unexpected', expectedStatus: 'passed', annotations: [], results: [{ status: passed ? 'passed' : 'failed', duration: 5, retry: 0, ...(passed ? {} : { error: { message: 'Error: ' + body } }) }] }] }] }], errors: [], stats: { expected: passed ? 1 : 0, unexpected: passed ? 0 : 1, flaky: 0, skipped: 0 } }));
  process.exit(passed ? 0 : 1);
})();
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } }).trim();

/** The web application at a candidate commit, a UI policy that starts it with `start`, and the run's directories. */
async function world(start: string[]) {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-ui-dotnet-')));
  dirs.push(base);
  const repo = join(base, 'repo');
  for (const [rel, text] of Object.entries(WEB)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'base');
  const parentSha = sh(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'README.md'), '# acme\n');
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', 'candidate');
  const commitSha = sh(repo, 'rev-parse', 'HEAD');
  const candidate: Candidate = { id: `cand-${commitSha.slice(0, 7)}`, runId: 'orb-ui-dotnet', seq: 1, attempt: 1, commitSha, treeHash: sh(repo, 'rev-parse', 'HEAD^{tree}'), parentSha };
  const port = await freePort();
  const config = defaultConfig('supervised');
  config.checks['ui-journeys'] = { ...defaultCheck('ui-journeys'), kind: 'playwright', command: [process.execPath, '-e', JOURNEYS, 'journeys'], timeout_seconds: 60 };
  config.ui = defaultUi();
  config.ui.journey_check_ids = ['ui-journeys'];
  config.ui.browsers = ['chromium'];
  config.ui.viewports = [{ width: 1440, height: 900 }];
  config.ui.accessibility.enabled = false;
  config.ui.environment.base_url = `http://127.0.0.1:${port}`;
  config.ui.environment.start_command = start;
  config.ui.environment.ready_timeout_seconds = 150;
  const { snapshot } = snapshotPolicy(config, { runId: 'orb-ui-dotnet', repoRoot: repo, runDir: join(base, 'run'), clock: new ManualClock() });
  // A run's layout: its evidence and the repository's caches under the Orbit home, which every sandbox read-denies.
  const orbitHome = join(base, 'orbit');
  const run = () =>
    runUiChecks({ checkoutDir: repo, snapshot, candidate, uiConfig: snapshot.config.ui!, journeyCheckIds: ['ui-journeys'], isolation: provider, outDir: join(orbitHome, 'runs', 'orb-ui-dotnet', 'evidence', '1', 'ui'), toolchainCacheRoot: toolchainCacheRoot(orbitHome, 'abcdefabcdef'), appPollMs: 200 });
  return { run, outDir: join(orbitHome, 'runs', 'orb-ui-dotnet', 'evidence', '1', 'ui') };
}

describe.skipIf(skip !== null)(skip === null ? 'a .NET web application under srt' : `a .NET web application under srt skipped: ${skip}`, () => {
  it('stops `dotnet run` within seconds once MSBuild records the refused worker node, naming the start command in two steps', async () => {
    const w = await world([dotnet!, 'run', '--project', 'Web']);
    const started = Date.now();
    const result = await w.run();
    expect(Date.now() - started).toBeLessThan(90_000);
    expect(result.verdict).toBe('ERROR');
    const reason = result.reasons.find((r) => r.startsWith('the application did not start'));
    expect(reason, result.reasons.join('\n')).toMatch(/the sandbox of the application denied MSBuild node \(pid \d+\) its named pipe \/tmp\/MSBuild\d+ \(System\.Net\.Sockets\.SocketException \(\d+\): [^)]+\); MSBuild waits 30 s for each of ten node starts before it fails, so Orbit stopped the application\./);
    expect(reason).toContain(`Fix: ui.environment.start_command: ["sh", "-c", "${dotnet} build Web -m:1 && ${dotnet} run --project Web --no-build"]`);
  }, 180_000);

  it('serves the journeys from the two-step start: the host starts and its HttpClient reaches the application', async () => {
    const w = await world(['sh', '-c', `${dotnet} build Web -m:1 && ${dotnet} run --project Web --no-build`]);
    const result = await w.run();
    const seen = join(w.outDir, 'ui-journeys', 'seen.txt');
    expect(existsSync(seen) ? readFileSync(seen, 'utf8') : result.reasons.join('\n')).toBe('200 home acme 3');
    expect(result.verdict, result.reasons.join('\n')).toBe('PASS');
  }, 240_000);
});
