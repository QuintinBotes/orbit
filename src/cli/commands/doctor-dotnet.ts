/**
 * checks.dotnet-tests (issue #10, reopened; docs/decisions/0009-toolchain-profiles.md, addendum). Orbit never changes a
 * check's processor count, but a check's own env may set DOTNET_PROCESSOR_COUNT=1, the alternative to -m:1 that the
 * MSBuild fix names and checks.sandbox accepts (it gives MSBuild one node). Its test host then gets one processor, and
 * xunit before 2.8 runs a test assembly on a synchronization context with one thread per processor, so a test that
 * blocks on async code (`.Result`, `.Wait()`) never finishes, and the check times out with nothing in its log to say
 * why. This names the tracked test projects that reference such an xunit, when such a check may run them. It reads
 * project files only (no build, no restore), so a version set through a property is not judged.
 */
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, posix, resolve } from 'node:path';
import { isDotnet, msbuildNodes, onOneProcessor, shellWord, verbOf, withOneMsbuildNode, words } from '../../evidence/msbuild.ts';
import { detectToolchains, toolchainCacheRoot } from '../../isolation/toolchains.ts';
import type { CheckDefinition, OrbitConfig } from '../../policy/types.ts';
import { repoKeyFor } from '../../storage/retention.ts';
import type { DoctorCheck } from './doctor.ts';

export interface DotnetTestsInput {
  config: OrbitConfig;
  repo: string;
  /** The repository's tracked files, relative (git ls-files). */
  files: readonly string[];
}

const PROJECT_FILE = /\.(?:cs|fs|vb)proj$/i;
const CENTRAL_FILE = 'Directory.Packages.props';
const RUNNER_JSON = 'xunit.runner.json';
/** The packages that carry xunit 2's test execution (xunit depends on xunit.core, which depends on the last). */
const XUNIT_IDS = new Set(['xunit', 'xunit.core', 'xunit.extensibility.execution']);
/** xunit 2.8.0 brought a new default parallel algorithm, which does not deadlock on one thread. */
const FIXED_MINOR = 8;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 256 * 1024;

/** `<PackageReference .../>` or `<PackageReference ...>...</PackageReference>`, and PackageVersion alike. */
const ITEM = /<(PackageReference|PackageVersion)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1\s*>)/gi;
const attribute = (attrs: string, name: string): string | null => new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, 'i').exec(attrs)?.[1] ?? null;
const element = (body: string, name: string): string | null => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, 'i').exec(body)?.[1] ?? null;

interface Reference {
  kind: 'PackageReference' | 'PackageVersion';
  id: string;
  version: string | null;
}

/** The xunit references of a project or props file, with the version each states (null: none, or the central one). */
function xunitReferences(text: string): Reference[] {
  const out: Reference[] = [];
  for (const m of text.matchAll(ITEM)) {
    const attrs = m[2] ?? '';
    const body = m[3] ?? '';
    const id = attribute(attrs, 'Include');
    if (id === null || !XUNIT_IDS.has(id.trim().toLowerCase())) continue;
    const version = attribute(attrs, 'VersionOverride') ?? attribute(attrs, 'Version') ?? element(body, 'VersionOverride') ?? element(body, 'Version');
    out.push({ kind: m[1]!.toLowerCase() === 'packageversion' ? 'PackageVersion' : 'PackageReference', id: id.trim(), version });
  }
  return out;
}

/** The version a NuGet version or range starts at ("2.4.1", "[2.7.1]", "[2.4,3.0)"), when it is before 2.8; null otherwise or when unreadable (a property). */
function before28(version: string): string | null {
  const m = /^\s*[[(]?\s*((\d+)\.(\d+)(?:\.\d+)*(?:-[0-9A-Za-z.-]+)?)/.exec(version);
  if (!m) return null;
  const major = Number(m[2]);
  const minor = Number(m[3]);
  return major < 2 || (major === 2 && minor < FIXED_MINOR) ? m[1]! : null;
}

function readSmall(path: string): string | null {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** Whether a project directory's xunit.runner.json lifts the thread limit (-1, or two threads or more): no deadlock then. */
function threadsLifted(repo: string, tracked: ReadonlySet<string>, dir: string): boolean {
  const rel = dir === '.' ? RUNNER_JSON : posix.join(dir, RUNNER_JSON);
  if (!tracked.has(rel)) return false;
  const text = readSmall(join(repo, rel));
  try {
    const n = (JSON.parse(text ?? '') as { maxParallelThreads?: unknown }).maxParallelThreads;
    return typeof n === 'number' && (n === -1 || n >= 2);
  } catch {
    return false;
  }
}

/** The tracked test projects that reference xunit before 2.8, as "path: id version", in path order. */
export function xunitBefore28(repo: string, files: readonly string[]): string[] {
  const relevant = files.filter((f) => PROJECT_FILE.test(f) || basename(f) === CENTRAL_FILE).slice(0, MAX_FILES);
  const tracked = new Set(files);
  // Central package management: the versions each Directory.Packages.props sets, by its directory.
  const central = new Map<string, Map<string, string>>();
  for (const f of relevant.filter((x) => basename(x) === CENTRAL_FILE)) {
    const versions = new Map<string, string>();
    for (const r of xunitReferences(readSmall(join(repo, f)) ?? '')) if (r.kind === 'PackageVersion' && r.version !== null) versions.set(r.id.toLowerCase(), r.version);
    central.set(posix.dirname(f), versions);
  }
  const centralVersion = (project: string, id: string): string | null => {
    for (let dir = posix.dirname(project); ; dir = posix.dirname(dir)) {
      const v = central.get(dir)?.get(id.toLowerCase());
      if (v !== undefined) return v;
      if (dir === '.' || dir === '/' || dir === '') return null;
    }
  };
  const out: string[] = [];
  for (const project of relevant.filter((f) => PROJECT_FILE.test(f)).sort()) {
    for (const r of xunitReferences(readSmall(join(repo, project)) ?? '')) {
      if (r.kind !== 'PackageReference') continue;
      const old = before28(r.version ?? centralVersion(project, r.id) ?? '');
      if (old === null || threadsLifted(repo, tracked, posix.dirname(project))) continue;
      out.push(`${project}: ${r.id} ${old}`);
      break;
    }
  }
  return out;
}

/**
 * Whether a check may run tests: `dotnet test` or `dotnet vstest`, or a command without dotnet whose words name tests
 * (`make test-all`, `./scripts/run-tests.sh`). `dotnet build tests/Acme.Tests` and `npm run lint` do not.
 */
function mayRunTests(check: CheckDefinition): boolean {
  const all = words(check.command);
  if (all.some((w) => basename(w) === 'dotnet')) return all.includes('test') || all.includes('vstest');
  return all.some((w) => /test/i.test(basename(w)));
}

export function dotnetTestsCheck(input: DotnetTestsInput): DoctorCheck[] {
  const { config, repo, files } = input;
  const atRisk = Object.values(config.checks).filter(
    (c) => c.kind === 'command' && onOneProcessor(c.env) && mayRunTests(c) && detectToolchains({ command: c.command, shell: c.shell, roots: [repo, resolve(repo, c.cwd)] }).includes('dotnet'),
  );
  if (atRisk.length === 0) return [];
  const projects = xunitBefore28(repo, files);
  if (projects.length === 0) return [];
  const ids = atRisk.map((c) => c.id);
  const one = ids.length === 1;
  return [
    {
      id: 'checks.dotnet-tests',
      area: 'checks',
      status: 'warn',
      summary: `${one ? `check ${ids[0]} sets` : `checks ${ids.join(', ')} set`} DOTNET_PROCESSOR_COUNT=1 in ${one ? 'its env, which its' : 'their env, which their'} test host gets too: xunit before 2.8 deadlocks a test that blocks on async code there, and the check times out`,
      details: projects,
      missing: 'a test host with its processors, or xunit 2.8 or later',
      fix: `remove DOTNET_PROCESSOR_COUNT from ${ids.map((i) => `checks.${i}.env`).join(' and ')} and pass -m:1 to every dotnet build or test ${one ? 'its command starts' : 'their commands start'} instead, which pins MSBuild to one node without touching the test host; or upgrade xunit to 2.8.0 or later (docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")`,
    },
  ];
}

// ---------------------------------------------------------------------------
// checks.dotnet-packages

/**
 * checks.dotnet-packages (issue #10; docs/decisions/0009-toolchain-profiles.md, addendum). On macOS .NET verifies a
 * server's certificate through the system trust service, whose lookup srt keeps out of reach (it could make trustd fetch
 * from any host for a sandboxed process), so a NuGet restore from nuget.org cannot complete inside the sandbox ("NU1301:
 * The SSL connection could not be established"). A repository whose .NET projects reference packages fills its NuGet
 * cache outside the sandbox, once and whenever its packages change; the dependency install and the checks then restore
 * from it with nothing to download. Doctor says so before a run, with the exact command, and fails when the dependency
 * install would restore from the network into an empty cache, since that install cannot succeed, and when a mandatory
 * check would (a `dotnet build` without --no-restore and no install that restores), since the run would block on it. It
 * reads tracked files only, and never creates the cache.
 */
export interface DotnetPackagesInput {
  config: OrbitConfig;
  repo: string;
  /** The repository's tracked files, relative (git ls-files). */
  files: readonly string[];
  /** The isolation provider checks run under, and whether it is available. */
  provider: { kind: string } | null;
  available: boolean;
  platform: NodeJS.Platform;
  /** The Orbit home: the repository's NuGet cache is under it (isolation/toolchains.ts toolchainCacheRoot). */
  orbitHome: string;
}

const PACKAGE_FILES = new Set(['packages.lock.json', 'Directory.Packages.props', 'packages.config']);
/** A local tool manifest: its tools are NuGet packages too, restored into the same cache by `dotnet tool restore`. */
const TOOL_MANIFEST = 'dotnet-tools.json';
/** Where `dotnet tool restore`, run at the repository root, finds the manifest. */
const ROOT_MANIFESTS = new Set(['.config/dotnet-tools.json', 'dotnet-tools.json']);
const MSBUILD_IMPORTS = new Set(['Directory.Build.props', 'Directory.Build.targets']);
const SOLUTION_FILE = /\.slnx?$/i;
const PACKAGE_REFERENCE = /<PackageReference\b[^>]*?\bInclude\s*=\s*"([^"]+)"/i;
const MAX_SHOWN = 5;
/** Restore targets named in one command at most; for a repository with more, the fix says how many it leaves out. */
const MAX_TARGETS = 20;
/** The dotnet verbs that restore before they build unless told --no-restore. */
const RESTORING_VERBS = new Set(['build', 'test', 'publish', 'pack', 'run']);
const NUGET_DOCS = 'docs/troubleshooting.md, ".NET HTTP clients and NuGet restore on macOS"';
const TRUST_REASON = "cannot be downloaded inside the sandbox on macOS (it keeps the system trust service out of reach, so .NET cannot verify nuget.org's certificate)";

/** A project or MSBuild import file that may name a package or an MSBuild SDK: a .csproj and the like, a .proj (Microsoft.Build.Traversal's dirs.proj), or Directory.Build.*. */
const MSBUILD_FILE = /\.(?:cs|fs|vb)?proj$/i;
/** An Sdk attribute (of Project or Import) that names a version, which NuGet resolves: `Sdk="MSTest.Sdk/3.6.0"`, several separated by ;. */
const SDK_ATTRIBUTE = /\bSdk\s*=\s*"([^"]*\/[^"]*)"/gi;
/** An Sdk element with a version: `<Sdk Name="Microsoft.Build.NoTargets" Version="3.7.56" />`. */
const SDK_ELEMENT = /<Sdk\b([^>]*)>/gi;

/**
 * The MSBuild SDKs of a file that NuGet resolves (measured: the fill command's restore caches one, and a build then
 * resolves it from the cache), as "Name/Version": versioned Sdk attributes and elements, or global.json's msbuild-sdks.
 */
function nugetSdks(file: string, text: string): string[] {
  if (basename(file) === 'global.json') {
    try {
      const sdks = (JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')) as { 'msbuild-sdks'?: Record<string, unknown> })['msbuild-sdks'] ?? {};
      return Object.entries(sdks).flatMap(([name, version]) => (typeof version === 'string' ? [`${name}/${version}`] : []));
    } catch {
      return [];
    }
  }
  const out: string[] = [];
  for (const m of text.matchAll(SDK_ATTRIBUTE)) out.push(...m[1]!.split(';').map((x) => x.trim()).filter((x) => x.includes('/')));
  for (const m of text.matchAll(SDK_ELEMENT)) {
    const name = attribute(m[1]!, 'Name');
    const version = attribute(m[1]!, 'Version');
    if (name && version) out.push(`${name}/${version}`);
  }
  return [...new Set(out)];
}

/**
 * What shows that the repository's .NET projects use NuGet packages: a package file, a local tool manifest, a project
 * or MSBuild import with a PackageReference, or an MSBuild SDK that NuGet resolves.
 */
function packageEvidence(repo: string, files: readonly string[]): string[] {
  const out: string[] = [];
  for (const f of files.slice(0, MAX_FILES * 4)) {
    const name = basename(f);
    if (PACKAGE_FILES.has(name) || name === TOOL_MANIFEST) out.push(f);
    else if (MSBUILD_FILE.test(f) || MSBUILD_IMPORTS.has(name) || f === 'global.json') {
      const text = readSmall(join(repo, f)) ?? '';
      const id = PACKAGE_REFERENCE.exec(text)?.[1];
      if (id !== undefined) out.push(`${f}: PackageReference ${id.trim()}`);
      for (const sdk of nugetSdks(f, text)) out.push(`${f}: MSBuild SDK ${sdk}`);
    }
  }
  return out;
}

/** Whether the repository's tracked files show NuGet packages, as checks.dotnet-packages reads them (for the toolchain line of checks.sandbox). */
export function hasNugetPackages(repo: string, files: readonly string[]): boolean {
  return packageEvidence(repo, files).length > 0;
}

/**
 * The package versions that float (`13.*`), which a restore looks up at the package source every time, however full
 * the cache (measured: NU1301 with it filled); none when the repository tracks a lock file, which pins them (measured:
 * restores offline). As "file: id version floats ...".
 */
function floatingVersions(repo: string, files: readonly string[]): string[] {
  if (files.some((f) => basename(f) === 'packages.lock.json')) return [];
  const out: string[] = [];
  for (const f of files.slice(0, MAX_FILES * 4)) {
    if (!PROJECT_FILE.test(f) && !MSBUILD_IMPORTS.has(basename(f)) && basename(f) !== CENTRAL_FILE) continue;
    for (const m of (readSmall(join(repo, f)) ?? '').matchAll(ITEM)) {
      const attrs = m[2] ?? '';
      const body = m[3] ?? '';
      const id = attribute(attrs, 'Include') ?? attribute(attrs, 'Update');
      const version = attribute(attrs, 'VersionOverride') ?? attribute(attrs, 'Version') ?? element(body, 'VersionOverride') ?? element(body, 'Version');
      if (id && version?.includes('*')) out.push(`${f}: ${id.trim()} ${version.trim()} floats, so every restore looks it up at nuget.org`);
    }
  }
  return out;
}

/**
 * What a command restores through dotnet itself: projects (dotnet restore, dotnet msbuild -restore, or a build verb
 * without --no-restore or --no-build, which implies it) and local tools (dotnet tool restore).
 */
function restoresOf(command: readonly string[]): { projects: boolean; tools: boolean } {
  const ws = words(command);
  const out = { projects: false, tools: false };
  ws.forEach((w, i) => {
    if (!isDotnet(w)) return;
    const next = ws.findIndex((x, j) => j > i && isDotnet(x));
    const own = ws.slice(i, next < 0 ? undefined : next);
    const verb = verbOf(own);
    if (verb === 'tool') out.tools ||= own.includes('restore');
    else if (verb === 'restore') out.projects = true;
    else if (verb === 'msbuild') out.projects ||= own.some((x) => /^[-/](?:restore|r)$/i.test(x) || /^[-/]t(?:arget)?:.*\brestore\b/i.test(x));
    else if (verb !== undefined && RESTORING_VERBS.has(verb) && !own.includes('--no-restore') && !own.includes('--no-build')) out.projects = true;
  });
  return out;
}

/** Whether a command restores NuGet packages through dotnet itself: projects or local tools. */
function restoresPackages(command: readonly string[]): boolean {
  const r = restoresOf(command);
  return r.projects || r.tools;
}

/** How many packages a NuGet cache holds (one directory per package id); null when it does not exist. */
function cachedPackages(cache: string): number | null {
  if (!existsSync(cache)) return null;
  try {
    return readdirSync(cache, { withFileTypes: true }).filter((e) => e.isDirectory()).length;
  } catch {
    return 0;
  }
}

/**
 * The project restores that fill the cache: the dependency install's own command with -m:1 when that is a dotnet
 * command that restores projects; otherwise `dotnet restore -m:1` of the repository root's one solution or project, or
 * of each tracked solution, or else each tracked project (at most MAX_TARGETS, with a note of how many it leaves out).
 */
function projectRestores(files: readonly string[], install: readonly string[] | null): { steps: string[]; note: string } {
  if (install && isDotnet(install[0] ?? '') && restoresOf(install).projects) return { steps: [withOneMsbuildNode(install).map(shellWord).join(' ')], note: '' };
  const solutions = files.filter((f) => SOLUTION_FILE.test(f));
  const projects = files.filter((f) => PROJECT_FILE.test(f));
  const atRoot = [...solutions, ...projects].filter((f) => !f.includes('/'));
  if (atRoot.length === 1 || (solutions.length === 0 && projects.length === 0)) return { steps: ['dotnet restore -m:1'], note: '' };
  const all = (solutions.length > 0 ? solutions : projects).slice().sort();
  const targets = all.slice(0, MAX_TARGETS);
  const left = all.length - targets.length;
  const note = left > 0 ? ` (the first ${targets.length} of ${all.length} ${solutions.length > 0 ? 'solutions' : 'projects'}; restore the other ${left} the same way)` : '';
  return { steps: targets.map((t) => `dotnet restore ${shellWord(t)} -m:1`), note };
}

/**
 * The one command that fills the repository's NuGet cache outside the sandbox, run from anywhere: in a subshell, in the
 * repository, with NUGET_PACKAGES set to the cache. It restores the projects' packages (projectRestores) when the
 * repository shows any or the install restores projects, and the local tools (`dotnet tool restore`, which puts them in
 * the same cache) when the repository root has a tool manifest or the install restores tools, whatever part of them the
 * install itself restores.
 */
function fillCommand(repo: string, cache: string, files: readonly string[], install: readonly string[] | null, evidence: readonly string[]): string {
  const env = `NUGET_PACKAGES=${shellWord(cache)}`;
  const inRepo = (body: string) => `(cd ${shellWord(repo)} && ${body})`;
  const restores = install ? restoresOf(install) : { projects: false, tools: false };
  const packages = restores.projects || evidence.some((e) => basename(e.split(':')[0]!) !== TOOL_MANIFEST);
  const tools = restores.tools || files.some((f) => ROOT_MANIFESTS.has(f));
  const projects = packages ? projectRestores(files, install) : { steps: [], note: '' };
  const steps = [...projects.steps, ...(tools ? ['dotnet tool restore'] : [])];
  return `${inRepo(steps.length === 1 ? `${env} ${steps[0]}` : `export ${env} && ${steps.join(' && ')}`)}${projects.note}`;
}

/** Whether a check gets .NET's toolchain, as the runner decides: its command, or .NET files at the checkout root or in its directory. */
const checkUsesDotnet = (repo: string, c: CheckDefinition): boolean => c.kind === 'command' && detectToolchains({ command: c.command, shell: c.shell, roots: [repo, resolve(repo, c.cwd)] }).includes('dotnet');

/**
 * What the NuGet lines of doctor read on macOS under srt, where nothing in the sandbox reaches nuget.org: the dependency
 * install's command (null when there is none) and what shows that the repository uses packages; null when the
 * repository's checks and install do not use .NET, it has no packages, or checks do not run under srt on macOS.
 */
function nugetOnMac(input: DotnetPackagesInput): { install: string[] | null; evidence: string[] } | null {
  const { config, repo, files } = input;
  if (input.platform !== 'darwin' || input.provider?.kind !== 'sandbox-runtime' || !input.available) return null;
  const deps = config.dependencies;
  const install = deps.install_existing_lockfile && deps.install_command ? deps.install_command : null;
  const usesDotnet = (install !== null && detectToolchains({ command: install, roots: [repo] }).includes('dotnet')) || Object.values(config.checks).some((c) => checkUsesDotnet(repo, c));
  if (!usesDotnet) return null;
  const evidence = packageEvidence(repo, files);
  return evidence.length === 0 ? null : { install, evidence };
}

export function dotnetPackagesCheck(input: DotnetPackagesInput): DoctorCheck[] {
  const { repo, files } = input;
  const mac = nugetOnMac(input);
  if (!mac) return [];
  const { install, evidence } = mac;

  const cache = join(toolchainCacheRoot(input.orbitHome, repoKeyFor(repo)), 'nuget');
  const count = cachedPackages(cache);
  const empty = count === null || count === 0;
  const restores = install !== null && restoresPackages(install);
  const floating = floatingVersions(repo, files);
  const capped = (lines: readonly string[]) => (lines.length > MAX_SHOWN ? [...lines.slice(0, MAX_SHOWN), `and ${lines.length - MAX_SHOWN} more`] : [...lines]);
  const state = count === null ? 'not created yet' : count === 0 ? 'empty' : `holds ${count} ${count === 1 ? 'package' : 'packages'}`;
  // What makes the dependency install fail in the sandbox, and what the offline restore waits for.
  const failing = [
    ...(restores && empty ? ["this repository's NuGet cache is empty"] : []),
    ...(install !== null && restoresOf(install).projects && floating.length > 0 ? ['a package version floats, which every restore looks up at nuget.org'] : []),
  ];
  // A mandatory check that restores into an empty cache blocks the run as surely (review of #10): its restore is
  // refused the host, or with the host allowed cannot verify nuget.org's certificate.
  const restoring = failing.length > 0 || !empty ? [] : Object.values(input.config.checks).filter((c) => c.kind === 'command' && c.mandatory && checkUsesDotnet(repo, c) && restoresPackages(c.command)).map((c) => c.id);
  const many = restoring.length > 1;
  const until = [
    ...(floating.length > 0 ? ['no package version floats: pin each one the details name, or restore with a lock file (RestorePackagesWithLockFile)'] : []),
    ...(auditFailures(input, mac) ? ['the vulnerability audit no longer fails them, as checks.dotnet-audit says'] : []),
  ];
  return [
    {
      id: 'checks.dotnet-packages',
      area: 'checks',
      status: failing.length > 0 || restoring.length > 0 ? 'fail' : 'warn',
      summary:
        failing.length > 0
          ? `dependencies.install_command restores NuGet packages, which ${TRUST_REASON}, and ${failing.join(', and ')}: the dependency install would fail`
          : restoring.length > 0
            ? `${many ? 'checks' : 'check'} ${restoring.join(', ')} ${many ? 'restore' : 'restores'} NuGet packages, which ${TRUST_REASON}, and this repository's NuGet cache is empty: the ${many ? 'checks' : 'check'} would fail at the baseline`
            : `this repository's NuGet packages ${TRUST_REASON}: fill its NuGet cache outside the sandbox`,
      details: [...capped(evidence), ...capped(floating), `NuGet cache ${cache}: ${state}`],
      missing: "NuGet packages in this repository's cache, restored outside the sandbox",
      fix: `run once in a terminal, outside the sandbox, and again whenever the packages change: ${fillCommand(repo, cache, files, install, evidence)}; the dependency install and the checks then restore offline from that cache ${
        until.length > 0 ? `once ${until.join(', and once ')} (${NUGET_DOCS})` : `(Orbit turns NuGet's vulnerability audit off in the sandbox, where it cannot reach nuget.org; ${NUGET_DOCS})`
      }`,
    },
  ];
}

// ---------------------------------------------------------------------------
// checks.dotnet-audit

/**
 * checks.dotnet-audit (issue #10; docs/decisions/0009-toolchain-profiles.md, addendum). NuGet's vulnerability audit
 * fetches from the package source at every restore, which nothing in the sandbox reaches on macOS, so it adds warning
 * NU1900 there, and a repository that treats warnings as errors fails the restore on it: the dependency install and
 * every check that restores, however full the NuGet cache. Orbit turns the audit off only where it cannot run
 * (isolation/toolchains.ts nugetAuditRuns), which on macOS under srt is every .NET process, with NuGetAudit=false in
 * the environment, which MSBuild reads, so that holds while nothing else sets NuGetAudit: a project or MSBuild import
 * that sets it overrides the environment (unless its condition defers to a value set already), and so do a check's own
 * env and a -p:NuGetAudit=true. Doctor names such a setting when warnings are errors (TreatWarningsAsErrors, NU1900 in
 * WarningsAsErrors, -warnaserror), with the change that lets Orbit's setting through. It reads tracked files only; a
 * setting under a condition doctor cannot evaluate makes the finding a warning.
 *
 * Doctor judges macOS under srt only, as before the rule was narrowed: the narrowing leaves the audit as configured
 * only where it reaches nuget.org (the dependency install on Linux, a Linux check that lists the host), where a
 * repository's own NuGetAudit adds no NU1900, so it makes no case newly relevant. The one other case where a
 * repository's setting meets an unreachable source, a Linux check without the host that restores, is not judged.
 */
const AUDIT_PROPERTY = /<(NuGetAudit|TreatWarningsAsErrors|MSBuildTreatWarningsAsErrors|WarningsAsErrors|MSBuildWarningsAsErrors|NoWarn|WarningsNotAsErrors|MSBuildWarningsNotAsErrors)\b([^>]*)>([^<]*)<\/\1\s*>/g;
const CONDITION = /\bCondition\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const DEFERS = /\$\(\s*NuGetAudit\s*\)/i;
const WARN_AS_ERROR = /^(?:--?|\/)(?:warnaserror|err)(?::(.*))?$/i;
const PROPERTY_SWITCH = /^(?:--?|\/)(?:p|property):(.+)$/i;
/** Where a -p switch's value starts another property: a ; or , before a name and =. */
const NEXT_PROPERTY = /[;,](?=\s*[A-Za-z_][\w.-]*\s*=)/;
const AUDIT_FILE = /\.(?:props|targets)$/i;
const CONDITIONAL_AUDIT = `<NuGetAudit Condition="'$(NuGetAudit)' == ''">true</NuGetAudit>`;

const namesNu1900 = (value: string): boolean => value.split(/[;,\s]+/).some((t) => t.toUpperCase() === 'NU1900');
const isTrue = (value: string): boolean => value.trim().toLowerCase() === 'true';

/**
 * A setting that turns the audit on, or makes NU1900 an error: where it is and what it says, and whether a condition
 * decides it. One that turns the audit on names what to change: a file, a check's env, or a word of a command.
 */
interface AuditSetting {
  detail: string;
  conditional: boolean;
  change?: { file: string } | { env: string } | { command: string; word: string };
}

/** The file or field an audit setting is in. */
const changed = (s: AuditSetting): string => (!s.change ? '' : 'file' in s.change ? s.change.file : 'env' in s.change ? s.change.env : s.change.command);

/** The index of the last match of a global pattern in a text, or -1. */
function lastMatch(text: string, pattern: RegExp): number {
  let at = -1;
  for (const m of text.matchAll(pattern)) at = m.index!;
  return at;
}

/** The settings of one project or MSBuild import that decide whether NU1900 fails a restore, comments left out. */
function fileSettings(file: string, raw: string): { on: AuditSetting[]; errors: AuditSetting[]; kept: boolean } {
  const text = raw.replace(/<!--[\s\S]*?-->/g, '');
  const out = { on: [] as AuditSetting[], errors: [] as AuditSetting[], kept: false };
  for (const m of text.matchAll(AUDIT_PROPERTY)) {
    const [, name, attrs, value] = m as unknown as [string, string, string, string];
    const before = text.slice(0, m.index);
    const group = before.lastIndexOf('<PropertyGroup');
    // Outside a PropertyGroup it is an item's metadata (a PackageReference's NoWarn), about that item alone.
    if (group < 0 || before.lastIndexOf('</PropertyGroup') > group) continue;
    const groupAttrs = /^<PropertyGroup\b([^>]*)>/.exec(text.slice(group))?.[1] ?? '';
    const conditions = [attrs, groupAttrs].map((a) => CONDITION.exec(a)).flatMap((c) => (c ? [c[1] ?? c[2] ?? ''] : []));
    // A property set inside a Choose or a target is decided by what doctor does not evaluate.
    const nested = lastMatch(before, /<Choose[\s>]/g) > lastMatch(before, /<\/Choose\s*>/g) || lastMatch(before, /<Target[\s>]/g) > lastMatch(before, /<\/Target\s*>/g);
    const lower = name.toLowerCase();
    // A switch whose value is another property's (true or false) is as undecided as one under a condition; a list
    // that appends to itself ($(NoWarn);NU1900) names NU1900 whatever it held.
    const boolean = lower === 'nugetaudit' || lower.endsWith('treatwarningsaserrors');
    const conditional = conditions.length > 0 || nested || (boolean && value.includes('$('));
    const setting = { detail: `${file}: ${name} ${value.trim()}${conditional ? ' (under a condition)' : ''}`, conditional };
    if (lower === 'nugetaudit') {
      if (conditions.some((c) => DEFERS.test(c)) || DEFERS.test(value)) continue;
      if (isTrue(value) || value.includes('$(')) out.on.push({ ...setting, change: { file } });
    } else if (lower.endsWith('treatwarningsaserrors')) {
      if (isTrue(value) || value.includes('$(')) out.errors.push(setting);
    } else if (lower.endsWith('warningsaserrors')) {
      if (namesNu1900(value)) out.errors.push(setting);
    } else if (namesNu1900(value) && !conditional) {
      out.kept = true;
    }
  }
  return out;
}

/** What a command and its env set: the audit on or off (-p:NuGetAudit, env NuGetAudit), and NU1900 as an error. */
function commandSettings(r: Restorer): { on: AuditSetting[]; errors: AuditSetting[]; off: boolean } {
  const { label, command, env } = r;
  const out = { on: [] as AuditSetting[], errors: [] as AuditSetting[], off: false };
  for (const raw of words(command)) {
    const w = raw.replace(/["']/g, '');
    const warn = WARN_AS_ERROR.exec(w);
    if (warn && (warn[1] === undefined || namesNu1900(warn[1]))) out.errors.push({ detail: `${label}: ${w}`, conditional: false });
    const props = PROPERTY_SWITCH.exec(w)?.[1];
    for (const assignment of props?.split(NEXT_PROPERTY) ?? []) {
      const eq = assignment.indexOf('=');
      const name = assignment.slice(0, eq).trim().toLowerCase();
      const value = assignment.slice(eq + 1);
      if (eq < 0) continue;
      if (name === 'nugetaudit') {
        if (isTrue(value)) out.on.push({ detail: `${label}: ${w}`, conditional: false, change: { command: r.commandField, word: w } });
        else out.off = true;
      } else if ((name.endsWith('treatwarningsaserrors') && isTrue(value)) || (name.endsWith('warningsaserrors') && !name.endsWith('treatwarningsaserrors') && namesNu1900(value))) {
        out.errors.push({ detail: `${label}: ${w}`, conditional: false });
      }
    }
  }
  for (const [k, v] of Object.entries(env)) {
    const name = k.toLowerCase();
    if (name === 'nugetaudit' && isTrue(v) && r.envField) out.on.push({ detail: `${label}: env ${k}=${v}`, conditional: false, change: { env: r.envField } });
    else if (name.endsWith('treatwarningsaserrors') && isTrue(v)) out.errors.push({ detail: `${label}: env ${k}=${v}`, conditional: false });
  }
  return out;
}

/** A process in the sandbox that restores projects: the dependency install, or a check that restores ('yes') or may run something that does ('may'). */
interface Restorer {
  label: string;
  /** The check's id; null for the dependency install. */
  check: string | null;
  /** Where its command and its env are configured; the dependency install has no env of its own. */
  commandField: string;
  envField: string | null;
  command: readonly string[];
  env: Readonly<Record<string, string>>;
  restores: 'yes' | 'may';
  mandatory: boolean;
}

interface AuditFailure {
  restorer: Restorer;
  certain: boolean;
  on: AuditSetting[];
  errors: AuditSetting[];
}

/** The restores in the sandbox that NU1900 fails, each with the settings that make it so; null when there is none. */
function auditFailures(input: DotnetPackagesInput, mac: { install: string[] | null }): AuditFailure[] | null {
  const { config, repo, files } = input;
  const restorers: Restorer[] = [];
  if (mac.install && restoresOf(mac.install).projects) restorers.push({ label: 'dependencies.install_command', check: null, commandField: 'dependencies.install_command', envField: null, command: mac.install, env: {}, restores: 'yes', mandatory: true });
  for (const c of Object.values(config.checks)) {
    if (!checkUsesDotnet(repo, c)) continue;
    const restores = restoresOf(c.command).projects ? 'yes' : msbuildNodes({ command: c.command, shell: c.shell }, true)?.kind === 'indirect' ? 'may' : null;
    if (restores) restorers.push({ label: `check ${c.id}`, check: c.id, commandField: `checks.${c.id}.command`, envField: `checks.${c.id}.env`, command: c.command, env: c.env, restores, mandatory: c.mandatory });
  }
  if (restorers.length === 0) return null;
  const read = files
    .filter((f) => PROJECT_FILE.test(f) || AUDIT_FILE.test(f))
    .slice(0, MAX_FILES * 4)
    .sort()
    .map((f) => fileSettings(f, readSmall(join(repo, f)) ?? ''));
  if (read.some((r) => r.kept)) return null;
  const fileOn = read.flatMap((r) => r.on);
  const fileErrors = read.flatMap((r) => r.errors);
  const out: AuditFailure[] = [];
  for (const r of restorers) {
    const own = commandSettings(r);
    const on = [...own.on, ...fileOn];
    const errors = [...fileErrors, ...own.errors];
    if (own.off || on.length === 0 || errors.length === 0) continue;
    out.push({ restorer: r, on, errors, certain: r.restores === 'yes' && on.some((s) => !s.conditional) && errors.some((s) => !s.conditional) });
  }
  return out.length > 0 ? out : null;
}

/** At most MAX_SHOWN settings' details, and how many more there are. */
const settingDetails = (settings: readonly AuditSetting[]): string[] => [...settings.slice(0, MAX_SHOWN).map((s) => s.detail), ...(settings.length > MAX_SHOWN ? [`and ${settings.length - MAX_SHOWN} more`] : [])];

/** "a", "a and b", "a, b and c". */
const listed = (items: readonly string[]): string => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** "dependencies.install_command and checks a, b": the install first, then the checks by id. */
function restorerNames(items: readonly Restorer[]): string {
  const install = items.filter((r) => r.check === null).map((r) => r.label);
  const ids = items.flatMap((r) => (r.check === null ? [] : [r.check]));
  return [...install, ...(ids.length > 0 ? [`${ids.length === 1 ? 'check' : 'checks'} ${ids.join(', ')}`] : [])].join(' and ');
}

export function dotnetAuditCheck(input: DotnetPackagesInput): DoctorCheck[] {
  const mac = nugetOnMac(input);
  const failures = mac ? auditFailures(input, mac) : null;
  if (!failures) return [];
  const unique = (settings: AuditSetting[]): AuditSetting[] => settings.filter((s, i) => settings.findIndex((x) => x.detail === s.detail) === i);
  const on = unique(failures.flatMap((f) => f.on));
  const errors = unique(failures.flatMap((f) => f.errors));
  const where = [...new Set(on.map(changed))];
  const certain = failures.filter((f) => f.certain).map((f) => f.restorer);
  const may = failures.filter((f) => !f.certain).map((f) => f.restorer);
  const fails = [...(certain.length > 0 ? [`fails ${restorerNames(certain)}`] : []), ...(may.length > 0 ? [`may fail ${restorerNames(may)}`] : [])].join(' and ');
  const filesOn = [...new Set(on.flatMap((s) => (s.change && 'file' in s.change ? [s.change.file] : [])))];
  const changes = [
    ...(filesOn.length > 0 ? [`in ${listed(filesOn)}, set NuGetAudit only where nothing has set it yet: ${CONDITIONAL_AUDIT}`] : []),
    ...[...new Set(on.flatMap((s) => (s.change && 'env' in s.change ? [`remove NuGetAudit from ${s.change.env}`] : [])))],
    ...[...new Set(on.flatMap((s) => (s.change && 'command' in s.change ? [`remove ${s.change.word} from ${s.change.command}`] : [])))],
  ];
  return [
    {
      id: 'checks.dotnet-audit',
      area: 'checks',
      status: failures.some((f) => f.certain && f.restorer.mandatory) ? 'fail' : 'warn',
      summary: `NuGet's vulnerability audit cannot reach nuget.org from the sandbox on macOS, and ${listed(where)} ${where.length === 1 ? 'turns' : 'turn'} it on where Orbit turns it off: with warnings as errors, its warning NU1900 ${fails}`,
      details: [...settingDetails(on), ...settingDetails(errors)],
      missing: 'a restore in the sandbox without the vulnerability audit, or NU1900 kept a warning',
      fix: `${changes.join('; ')}, so Orbit's NuGetAudit=false reaches the restore in the sandbox${filesOn.length > 0 ? ' and the audit stays on everywhere else' : ''} (${NUGET_DOCS})`,
    },
  ];
}
