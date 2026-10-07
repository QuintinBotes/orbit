// Release commands that need dependencies the run's install did not fetch, under the real srt (review of #26). Before
// the toolchain profile a deploy or verify command had a private HOME, so Go, Cargo and NuGet fetched into it on the
// environment's hosts. Given the check's profile, they pointed at the repository's read-only caches and could fetch
// nothing: a deploy `go run .` fetching one module from a file proxy committed in the repository (no network, no TLS)
// exited 0 on origin/main and failed on the branch with "go: writing go.mod cache: mkdir <orbit home>/toolchains/<key>/
// gomod/cache: operation not permitted". Now each gets caches of its own, with the repository's read-only beneath them
// where the tool reads a second cache. Each case is skipped where srt or its toolchain is missing.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32 } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { deliver } from '../../../src/delivery/deliver.ts';
import { performRelease } from '../../../src/delivery/release.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { removeScratch, toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import { which } from '../../../src/isolation/util.ts';
import { makeLab, type Lab } from './harness.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: ROOT });
const probe = await provider.available();
const srt = probe.ok ? null : `srt unavailable: ${probe.detail}`;
const go = which('go', process.env.PATH);
const cargo = which('cargo', process.env.PATH);
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const skip = (tool: string, path: string | null) => srt ?? (path === null ? `${tool} is not installed` : null);

let lab: Lab | null = null;
const scratch: string[] = [];
afterEach(() => {
  // Go writes its module cache read-only.
  if (lab) removeScratch(join(lab.dir, 'orbit'));
  lab?.cleanup();
  lab = null;
  for (const d of scratch.splice(0)) removeScratch(d);
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

/** A zip archive whose entries are stored (Go's module zips and NuGet's packages both read that), without a zip tool. */
function storedZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const data = Buffer.from(text);
    const file = Buffer.from(name);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(file.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(file.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, file, data);
    centrals.push(central, file);
    offset += local.length + file.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

/** A release repository whose preview environment deploys with `deploy`, no network hosts. */
function releaseLab(deploy: string[]): Lab {
  return (lab = makeLab({
    mode: 'release',
    tweak: (cfg) => {
      cfg.delivery.pull_request = 'ready';
      cfg.actions.merge = true;
      cfg.actions.deploy_production = true;
      cfg.release = {
        merge: { method: 'squash', require_checks: [], delete_branch: false, mark_ready: true },
        environments: { preview: { deploy_command: deploy, allowed_branches: ['orbit/*'], require_ci_green: false, network_hosts: [], timeout_seconds: 240, verify_command: null } },
      };
    },
  }));
}

const cacheRootOf = (l: Lab) => toolchainCacheRoot(join(l.dir, 'orbit'), 'abcdefabcdef');

/** Commit `files` as a candidate, deliver it and run the preview deploy under srt: its output, or the failure. */
async function deploy(l: Lab, files: Record<string, string | Buffer>): Promise<{ output: string | null; error: string | null }> {
  const names = Object.keys(files);
  for (const name of names.slice(0, -1)) {
    mkdirSync(dirname(join(l.work, name)), { recursive: true });
    writeFileSync(join(l.work, name), files[name]!);
  }
  const last = names.at(-1)!;
  const c = l.candidate(String(files[last]), last);
  const ev = l.evidenceFor(c);
  const rv = l.reviewFor(c);
  const d = await deliver({ run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock, report: { title: 't', summary: 's' } });
  try {
    const r = await performRelease({
      run: l.deliveryRun, candidate: c, evidence: ev, review: rv, snapshot: l.snapshot, ledger: l.ledger(), client: l.fake, clock: l.clock,
      commit: d.commit, pr: d.pr?.number ?? null, contractMerge: false, environment: 'preview', readiness: () => ({ ok: true, reasons: [] }),
      isolation: provider, workDir: join(l.dir, 'runs', l.runId), toolchainCacheRoot: cacheRootOf(l),
    });
    return { output: r.deploy?.output ?? null, error: null };
  } catch (err) {
    return { output: null, error: err instanceof Error ? err.message : String(err) };
  }
}

// One module, example.com/dep v1.0.0, laid out as a Go module proxy serves it.
const DEP_MOD = 'module example.com/dep\n\ngo 1.21\n';
const DEP_PROXY: Record<string, string | Buffer> = {
  'proxy/example.com/dep/@v/list': 'v1.0.0\n',
  'proxy/example.com/dep/@v/v1.0.0.info': '{"Version":"v1.0.0","Time":"2024-01-01T00:00:00Z"}\n',
  'proxy/example.com/dep/@v/v1.0.0.mod': DEP_MOD,
  'proxy/example.com/dep/@v/v1.0.0.zip': storedZip({ 'example.com/dep@v1.0.0/go.mod': DEP_MOD, 'example.com/dep@v1.0.0/dep.go': 'package dep\n\nfunc Hello() string { return "hello from dep" }\n' }),
};
const APP_MOD = 'module example.com/app\n\ngo 1.21\n\nrequire example.com/dep v1.0.0\n';
const APP_MAIN = 'package main\n\nimport (\n\t"fmt"\n\t"example.com/dep"\n)\n\nfunc main() { fmt.Println(dep.Hello()) }\n';

// One NuGet package, Acme.Greeting 1.0.0, whose build targets print a line: a restore that resolved it shows in the build.
const GREETING = storedZip({
  'Acme.Greeting.nuspec': '<?xml version="1.0" encoding="utf-8"?>\n<package xmlns="http://schemas.microsoft.com/packaging/2013/05/nuspec.xsd"><metadata><id>Acme.Greeting</id><version>1.0.0</version><authors>acme</authors><description>A greeting at build time.</description></metadata></package>\n',
  'build/Acme.Greeting.targets': '<Project><Target Name="AcmeGreet" AfterTargets="Build"><Message Importance="high" Text="hello from the acme package" /></Target></Project>\n',
});
const ACME_CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework></PropertyGroup><ItemGroup><PackageReference Include="Acme.Greeting" Version="1.0.0" /></ItemGroup></Project>\n';
const nugetConfig = (feed: string | null) => `<?xml version="1.0" encoding="utf-8"?>\n<configuration><packageSources><clear />${feed ? `<add key="feed" value="${feed}" />` : ''}</packageSources></configuration>\n`;
const DOTNET_ENV = { DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1', DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1' };

describe('a release command that needs what the run\'s install did not fetch, under srt (review of #26)', () => {
  it.skipIf(skip('go', go) !== null)('fetches a Go module into a module cache of its own (here from a proxy in the repository)', async () => {
    const l = releaseLab(['sh', '-c', `GOTOOLCHAIN=local GOPROXY=file://$PWD/proxy GOSUMDB=off GOFLAGS=-mod=mod ${go} run .`]);
    const out = await deploy(l, { ...DEP_PROXY, 'go.mod': APP_MOD, 'main.go': APP_MAIN });
    expect(out.error).toBeNull();
    expect(out.output).toContain('hello from dep');
    // The repository's module cache is still empty: only the install step writes it.
    expect(existsSync(join(cacheRootOf(l), 'gomod', 'cache'))).toBe(false);
  }, 300_000);

  it.skipIf(skip('go', go) !== null)('builds with a module only the repository\'s cache holds, read through it as a module proxy, with no network', async () => {
    const l = releaseLab(['sh', '-c', `GOTOOLCHAIN=local ${go} run .`]);
    // The dependency install's part, outside the sandbox: the repository's module cache filled, go.sum written.
    const stage = temp('orbit-go-stage-');
    for (const [name, data] of Object.entries(DEP_PROXY)) {
      mkdirSync(dirname(join(stage, name)), { recursive: true });
      writeFileSync(join(stage, name), data);
    }
    writeFileSync(join(stage, 'go.mod'), APP_MOD);
    writeFileSync(join(stage, 'main.go'), APP_MAIN);
    const gomod = join(cacheRootOf(l), 'gomod');
    mkdirSync(gomod, { recursive: true });
    execFileSync(go!, ['mod', 'tidy'], { cwd: stage, env: { PATH: process.env.PATH ?? '', HOME: stage, GOTOOLCHAIN: 'local', GOMODCACHE: gomod, GOPROXY: `file://${stage}/proxy`, GOSUMDB: 'off', GOFLAGS: '-mod=mod', GOCACHE: join(stage, 'gocache'), GOPATH: join(stage, 'gopath') } });
    const out = await deploy(l, { 'go.sum': readFileSync(join(stage, 'go.sum'), 'utf8'), 'main.go': APP_MAIN, 'go.mod': APP_MOD });
    expect(out.error).toBeNull();
    expect(out.output).toContain('hello from dep');
  }, 300_000);

  it.skipIf(skip('dotnet', dotnet) !== null)('restores a NuGet package into a packages folder of its own (here from a feed in the repository)', async () => {
    const l = releaseLab([dotnet!, 'build', 'Acme.csproj', '-m:1']);
    const out = await deploy(l, { 'feed/acme.greeting.1.0.0.nupkg': GREETING, 'nuget.config': nugetConfig('feed'), 'Acme.csproj': ACME_CSPROJ });
    expect(out.error).toBeNull();
    expect(out.output).toContain('hello from the acme package');
    expect(existsSync(join(cacheRootOf(l), 'nuget', 'acme.greeting'))).toBe(false);
  }, 300_000);

  it.skipIf(skip('dotnet', dotnet) !== null)('restores a NuGet package only the repository\'s cache holds, as its fallback folder, with no package source', async () => {
    const l = releaseLab([dotnet!, 'build', 'Acme.csproj', '-m:1']);
    const stage = temp('orbit-nuget-stage-');
    mkdirSync(join(stage, 'feed'));
    writeFileSync(join(stage, 'feed', 'acme.greeting.1.0.0.nupkg'), GREETING);
    writeFileSync(join(stage, 'nuget.config'), nugetConfig('feed'));
    writeFileSync(join(stage, 'Acme.csproj'), ACME_CSPROJ);
    const nuget = join(cacheRootOf(l), 'nuget');
    execFileSync(dotnet!, ['restore', '-m:1'], { cwd: stage, env: { ...process.env, ...DOTNET_ENV, NUGET_PACKAGES: nuget } });
    expect(existsSync(join(nuget, 'acme.greeting', '1.0.0'))).toBe(true);
    const out = await deploy(l, { 'nuget.config': nugetConfig(null), 'Acme.csproj': ACME_CSPROJ });
    expect(out.error).toBeNull();
    expect(out.output).toContain('hello from the acme package');
  }, 300_000);

  it.skipIf(skip('cargo', cargo) !== null)('installs a crate into a Cargo home of its own', async () => {
    const l = releaseLab(['sh', '-c', `${cargo} install --path . --offline --quiet && "$CARGO_HOME/bin/acme-deploy"`]);
    const out = await deploy(l, { 'src/main.rs': 'fn main() { println!("hello from acme-deploy"); }\n', 'Cargo.toml': '[package]\nname = "acme-deploy"\nversion = "0.1.0"\nedition = "2021"\n' });
    expect(out.error).toBeNull();
    expect(out.output).toContain('hello from acme-deploy');
    expect(existsSync(join(cacheRootOf(l), 'cargo', 'bin'))).toBe(false);
  }, 300_000);
});
