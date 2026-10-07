import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';
import { hostAllowed } from '../policy/hosts.ts';

/**
 * Toolchain sandbox profiles (docs/decisions/0009-toolchain-profiles.md). Checks and workers run with a write
 * allowlist, and every ecosystem's tools want writable state outside it: a dependency cache and per-build scratch.
 * One table, keyed by toolchain, says where each tool keeps them:
 *
 * - dependency caches live under the Orbit home, one set per repository (toolchainCacheRoot), written only by
 *   Orbit's dependency-install step and read-only for every other check and for workers;
 * - build outputs and per-command scratch go to a private directory per check attempt (or per worker);
 * - nothing points at the user's own caches, and nothing is shared between repositories.
 *
 * A check's own `env` overrides every variable set here (the runner applies it last).
 */

export type ToolchainId = 'dotnet' | 'go' | 'jvm' | 'python' | 'rust';

/** In table order, which is also the order detection returns. */
export const TOOLCHAIN_IDS: readonly ToolchainId[] = ['dotnet', 'go', 'jvm', 'python', 'rust'];

/** `install`: Orbit's dependency-install step, which may write the caches. `check` and `worker`: read-only caches. */
export type ToolchainMode = 'install' | 'check' | 'worker';

export interface ToolchainEnvDirs {
  mode: ToolchainMode;
  /** A dependency cache of this toolchain, by name (one of its `caches`). */
  cache(name: string): string;
  /** A private scratch directory of this attempt or worker, by name (one of its `scratch`). */
  scratch(name: string): string;
  /** The process's private temp directory. */
  tmpDir: string;
  /** An existing rustup installation, or null. */
  rustupHome: string | null;
  /** The JDK the host's JAVA_HOME names, or null. */
  javaHome: string | null;
  /** The platform the process runs on: the host's under an OS sandbox, Linux in a container. */
  platform: NodeJS.Platform;
  /** The hosts the process's sandbox lets it reach (a check's network_hosts, a worker's allowed hosts). */
  networkHosts: readonly string[];
}

export interface ToolchainProfile {
  id: ToolchainId;
  /** Executable base names that make a check this toolchain's (version suffixes such as python3.12 included). */
  executables: RegExp;
  /** Files whose presence in the checkout root (or the check's directory) makes it this toolchain's; `*.ext` matches a suffix. */
  markers: readonly string[];
  /** Dependency caches, by directory name under the repository's cache root. */
  caches: readonly string[];
  /** Private per-attempt directories, by name under the attempt's scratch root. */
  scratch: readonly string[];
  /** What `orbit doctor` says lives in the private scratch. */
  scratchVars: readonly string[];
  /** Registries the dependency install reaches for this toolchain. */
  registryHosts: readonly string[];
  /**
   * What `orbit doctor` starts: the first executable found on PATH, with these arguments, in an empty scratch checkout,
   * or one holding `files` (a generated project, `about` says what it is) when starting the tool proves too little.
   */
  probe: { executables: readonly string[]; args: readonly string[]; files?: Readonly<Record<string, string>>; about?: string };
  env(d: ToolchainEnvDirs): Record<string, string>;
}

/**
 * The project `orbit doctor` builds for .NET (issue #10, reopened): a library referencing two others, so its restore and
 * build have two projects to work on at once, which is where MSBuild starts worker nodes, as a real solution's build
 * does. No package references, so it restores and builds offline from the SDK alone; the target framework is the
 * newest one the SDK in use ships. The empty Directory.Build files stop MSBuild from importing any it finds above the
 * scratch directory.
 */
const PROBE_TFM = '<TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework>';
const probeLibrary = (refs: readonly string[] = []) =>
  `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>${PROBE_TFM}</PropertyGroup>\n${refs.length ? `  <ItemGroup>${refs.map((r) => `<ProjectReference Include="../${r}/${r}.csproj" />`).join('')}</ItemGroup>\n` : ''}</Project>\n`;
export const DOTNET_PROBE_PROJECT: Readonly<Record<string, string>> = {
  'Directory.Build.props': '<Project />\n',
  'Directory.Build.targets': '<Project />\n',
  'Probe.Left/Probe.Left.csproj': probeLibrary(),
  'Probe.Left/Left.cs': 'namespace Probe;\npublic static class Left { public static int One => 1; }\n',
  'Probe.Right/Probe.Right.csproj': probeLibrary(),
  'Probe.Right/Right.cs': 'namespace Probe;\npublic static class Right { public static int Two => 2; }\n',
  'Probe.App/Probe.App.csproj': probeLibrary(['Probe.Left', 'Probe.Right']),
  'Probe.App/App.cs': 'namespace Probe;\npublic static class App { public static int Three => Left.One + Right.Two; }\n',
};

/**
 * What a check's record says when the .NET profile's NuGetAudit=false reached it (the check's own env did not set it
 * back): a review found that nothing in a run's evidence said a restore under Orbit skips the vulnerability audit that
 * a repository's CI may fail on (NU1903 as an error). Orbit sets it only where the audit cannot run (nugetAuditRuns).
 */
export const NUGET_AUDIT_LIMITATION =
  "NuGet's vulnerability audit was off (NuGetAudit=false in Orbit's .NET profile, which turns it off where it cannot reach the package source from the sandbox), so a package with a known vulnerability does not fail this restore, even where such warnings are errors; the repository's CI still runs it";

const NUGET_HOSTS: readonly string[] = ['api.nuget.org'];

/**
 * Whether NuGet's vulnerability audit can run in a .NET process (ADR 0009, addendum, item 12): its sandbox lets it
 * reach the package source, and it is not on macOS, where .NET under srt cannot verify nuget.org's certificate (the
 * system trust service is denied by design, addendum item 9). Where it cannot run, the audit only waits and warns
 * NU1900, which fails every restore of a repository that treats warnings as errors (#10), so the profile turns it off;
 * everywhere else it stays as the repository configures it, so a package with a known vulnerability fails a restore
 * under Orbit as it fails in the repository's CI (NU1903 as an error).
 */
export function nugetAuditRuns(d: Pick<ToolchainEnvDirs, 'platform' | 'networkHosts'>): boolean {
  return d.platform !== 'darwin' && NUGET_HOSTS.every((h) => hostAllowed(h, d.networkHosts));
}

export const TOOLCHAIN_PROFILES: Readonly<Record<ToolchainId, ToolchainProfile>> = {
  dotnet: {
    id: 'dotnet',
    executables: /^dotnet$/,
    markers: ['*.sln', '*.slnx', '*.csproj', '*.fsproj', '*.vbproj', 'global.json', 'Directory.Build.props'],
    caches: ['nuget'],
    scratch: ['nuget-http', 'nuget-plugins'],
    scratchVars: ['NUGET_HTTP_CACHE_PATH', 'NUGET_PLUGINS_CACHE_PATH'],
    registryHosts: NUGET_HOSTS,
    // A real build: `dotnet help` started the SDK and ran its first-run steps (#10) but passed where every build of two
    // projects was denied an MSBuild worker node (#10, reopened). A build runs the first-run steps too.
    probe: {
      executables: ['dotnet'],
      args: ['build', 'Probe.App/Probe.App.csproj'],
      files: DOTNET_PROBE_PROJECT,
      about: 'three generated projects with no packages, one referencing the other two: their restore and build start MSBuild as a real build does',
    },
    env: (d) => ({
      NUGET_PACKAGES: d.cache('nuget'),
      NUGET_HTTP_CACHE_PATH: d.scratch('nuget-http'),
      NUGET_PLUGINS_CACHE_PATH: d.scratch('nuget-plugins'),
      // NuGet's vulnerability audit (an MSBuild property, which MSBuild also reads from the environment) fetches from the
      // package source at every restore. Off only where it cannot run (nugetAuditRuns): anything on macOS under srt,
      // and any process whose network lacks the host (a check or worker that does not list it). There it could only
      // add warning NU1900, after a wait, and a repository that treats warnings as errors fails its restore on it,
      // after its cache was filled (#10). Elsewhere (the dependency install on Linux or in a container, a Linux check
      // that lists the host) it stays as the repository configures it, so Orbit does not pass a restore the
      // repository's CI fails on NU1903. A check's own env, or a project that sets NuGetAudit itself, wins (orbit
      // doctor's checks.dotnet-audit names the second on macOS).
      ...(nugetAuditRuns(d) ? {} : { NuGetAudit: 'false' }),
    }),
  },
  go: {
    id: 'go',
    executables: /^(go|gofmt)$/,
    markers: ['go.mod', 'go.work'],
    caches: ['gomod'],
    scratch: ['gocache', 'gopath'],
    scratchVars: ['GOCACHE', 'GOPATH'],
    registryHosts: ['proxy.golang.org', 'sum.golang.org'],
    probe: { executables: ['go'], args: ['version'] },
    env: (d) => ({ GOMODCACHE: d.cache('gomod'), GOCACHE: d.scratch('gocache'), GOPATH: d.scratch('gopath') }),
  },
  jvm: {
    id: 'jvm',
    executables: /^(java|javac|jar|jshell|kotlinc|mvn|mvnw|gradle|gradlew)$/,
    markers: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew', 'mvnw'],
    caches: ['gradle', 'maven'],
    scratch: ['gradle-home', 'maven-repo'],
    scratchVars: ['GRADLE_USER_HOME', 'maven.repo.local'],
    registryHosts: ['repo.maven.apache.org', 'repo1.maven.org', 'plugins.gradle.org', 'services.gradle.org'],
    probe: { executables: ['java'], args: ['--version'] },
    env: (d) => ({
      // The install fills Gradle's and Maven's own homes; everyone else reads them as Gradle's read-only dependency
      // cache (the directory holding modules-2) and Maven's read-only tail repository, writing only private copies.
      ...(d.mode === 'install'
        ? { GRADLE_USER_HOME: d.cache('gradle'), MAVEN_OPTS: `-Dmaven.repo.local=${d.cache('maven')}` }
        : {
            GRADLE_USER_HOME: d.scratch('gradle-home'),
            GRADLE_RO_DEP_CACHE: join(d.cache('gradle'), 'caches'),
            MAVEN_OPTS: `-Dmaven.repo.local=${d.scratch('maven-repo')} -Dmaven.repo.local.tail=${d.cache('maven')}`,
          }),
      // The JVM ignores TMPDIR on macOS; srt sets JAVA_TOOL_OPTIONS for its own proxy agent, so this goes in the
      // launcher's variable (java 9 and later).
      JDK_JAVA_OPTIONS: `-Djava.io.tmpdir=${d.tmpDir}`,
      // The host's JDK, read-only: a check inherits nothing else of the host's environment, and macOS's /usr/bin/java
      // (a stub that finds the runtime through JAVA_HOME, else a JDK registered under /Library/Java) and the Maven and
      // Gradle launchers find the JDK through it. Without it a JDK outside /Library/Java (GitHub's macOS runners keep
      // theirs in the tool cache) is "Unable to locate a Java Runtime".
      ...(d.javaHome ? { JAVA_HOME: d.javaHome } : {}),
    }),
  },
  python: {
    id: 'python',
    executables: /^(python[0-9.]*|pip[0-9.]*|pytest|py\.test|tox|nox|poetry|pipenv|hatch|pdm)$/,
    markers: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock', 'tox.ini'],
    caches: ['pip'],
    scratch: ['pycache', 'python-user'],
    scratchVars: ['PYTHONPYCACHEPREFIX', 'PYTHONUSERBASE'],
    registryHosts: ['pypi.org', 'files.pythonhosted.org'],
    probe: { executables: ['python3', 'python'], args: ['--version'] },
    env: (d) => ({
      PIP_CACHE_DIR: d.cache('pip'),
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PYTHONPYCACHEPREFIX: d.scratch('pycache'),
      PYTHONUSERBASE: d.scratch('python-user'),
      // Virtual environments belong in the checkout (per run), never in a tool's cache directory.
      POETRY_VIRTUALENVS_IN_PROJECT: 'true',
      PIPENV_VENV_IN_PROJECT: '1',
    }),
  },
  rust: {
    id: 'rust',
    executables: /^(cargo|rustc|rustup|rustfmt|rustdoc)$/,
    markers: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml'],
    caches: ['cargo'],
    scratch: ['cargo-target'],
    scratchVars: ['CARGO_TARGET_DIR'],
    registryHosts: ['index.crates.io', 'static.crates.io'],
    probe: { executables: ['cargo'], args: ['--version'] },
    env: (d) => ({
      CARGO_HOME: d.cache('cargo'),
      CARGO_TARGET_DIR: d.scratch('cargo-target'),
      // rustup's proxies find their toolchains through RUSTUP_HOME, else under HOME, which is private in a check.
      ...(d.rustupHome ? { RUSTUP_HOME: d.rustupHome } : {}),
    }),
  },
};

const REPO_KEY = /^[A-Za-z0-9_-]{1,64}$/;

/** `<orbit home>/toolchains/<repo key>`: the dependency caches of one repository, shared with no other. */
export function toolchainCacheRoot(orbitHome: string, repoKey: string): string {
  if (!REPO_KEY.test(repoKey)) throw new Error(`invalid repository key ${JSON.stringify(repoKey)}`);
  return join(orbitHome, 'toolchains', repoKey);
}

/** The registries the dependency install of these toolchains reaches, in table order. */
export function toolchainRegistryHosts(ids: readonly ToolchainId[]): string[] {
  return [...new Set(ordered(ids).flatMap((id) => TOOLCHAIN_PROFILES[id].registryHosts))];
}

function ordered(ids: readonly ToolchainId[]): ToolchainId[] {
  return TOOLCHAIN_IDS.filter((id) => ids.includes(id));
}

/** Every word of the command (a shell script split on whitespace and operators), as the base name it would run. */
function commandWords(command: readonly string[]): string[] {
  return command.flatMap((part) => part.split(/[\s;&|()<>`]+/)).filter((w) => w !== '' && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)).map((w) => basename(w));
}

function hasMarker(dir: string, markers: readonly string[]): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  return markers.some((m) => (m.startsWith('*.') ? names.some((n) => n.endsWith(m.slice(1)) && n.length > m.length - 1) : names.includes(m)));
}

/**
 * The toolchains a check uses: any word of its command that is one of a toolchain's executables (so `make test` is
 * nothing, `cd app && go test` is Go), and any toolchain whose marker files are in one of `roots` (the checkout root
 * and the check's directory; a worker's worktree). In table order.
 */
export function detectToolchains(input: { command?: readonly string[]; shell?: boolean; roots?: readonly string[] }): ToolchainId[] {
  const words = commandWords(input.command ?? []);
  return TOOLCHAIN_IDS.filter((id) => {
    const p = TOOLCHAIN_PROFILES[id];
    return words.some((w) => p.executables.test(w)) || (input.roots ?? []).some((r) => hasMarker(r, p.markers));
  });
}

export interface ToolchainLayoutInput {
  toolchains: readonly ToolchainId[];
  mode: ToolchainMode;
  /** The repository's cache root (toolchainCacheRoot), or null: then the caches are private scratch too. */
  cacheRoot: string | null;
  /** The attempt's (or worker's) private scratch root; writable. */
  scratchRoot: string;
  tmpDir: string;
  /** The account's real home, only to find an existing rustup installation. */
  hostHome?: string;
  /** For RUSTUP_HOME and JAVA_HOME; defaults to process.env. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
  /** The platform the process runs on; defaults to process.platform. A container's is Linux, whatever the host's. */
  platform?: NodeJS.Platform;
  /** The hosts the process's sandbox lets it reach: a check's network_hosts, a worker's allowed hosts. */
  networkHosts: readonly string[];
}

export interface ToolchainLayout {
  toolchains: ToolchainId[];
  /** Variables for the process; the check's own env is applied after them. */
  env: Record<string, string>;
  /** Paths the sandbox must let the process write: the scratch root, and the caches in the install step. */
  writable: string[];
  /** Paths the sandbox must let the process read and never write: the repository's caches outside the install step. */
  readOnly: string[];
  /** Every cache and scratch directory, to create before the process starts. */
  directories: string[];
  caches: { toolchain: ToolchainId; name: string; path: string }[];
  /**
   * The process runs .NET, whose CookieContainer reads the NIS domain name: every .NET HTTP client (NuGet's restore
   * included) needs it, and srt's Seatbelt profile does not allow it (SandboxProfile.nisDomainName; ADR 0009, addendum).
   */
  nisDomainName: boolean;
}

function rustupHomeOf(input: ToolchainLayoutInput): string | null {
  const configured = (input.hostEnv ?? process.env).RUSTUP_HOME;
  if (configured && configured.trim() !== '') return isAbsolute(configured) ? configured : null;
  if (!input.hostHome) return null;
  const dflt = join(input.hostHome, '.rustup');
  return existsSync(dflt) ? dflt : null;
}

/** The host's JAVA_HOME when it is an absolute path; a relative one would name a directory under the check's cwd. */
function javaHomeOf(input: ToolchainLayoutInput): string | null {
  const configured = (input.hostEnv ?? process.env).JAVA_HOME;
  return configured && configured.trim() !== '' && isAbsolute(configured) ? configured : null;
}

/** Where each detected toolchain's caches and scratch go for one process, and what its sandbox must allow. */
export function toolchainLayout(input: ToolchainLayoutInput): ToolchainLayout {
  const ids = ordered(input.toolchains);
  const shared = input.cacheRoot !== null;
  const cachePath = (name: string) => (input.cacheRoot !== null ? join(input.cacheRoot, name) : join(input.scratchRoot, 'cache', name));
  const scratchPath = (name: string) => join(input.scratchRoot, name);
  const rustupHome = ids.includes('rust') ? rustupHomeOf(input) : null;
  const javaHome = ids.includes('jvm') ? javaHomeOf(input) : null;
  const platform = input.platform ?? process.platform;
  const env: Record<string, string> = {};
  const directories: string[] = [];
  const caches: ToolchainLayout['caches'] = [];
  for (const id of ids) {
    const p = TOOLCHAIN_PROFILES[id];
    Object.assign(env, p.env({ mode: input.mode, cache: cachePath, scratch: scratchPath, tmpDir: input.tmpDir, rustupHome, javaHome, platform, networkHosts: input.networkHosts }));
    for (const name of p.caches) caches.push({ toolchain: id, name, path: cachePath(name) });
    directories.push(...p.caches.map(cachePath), ...p.scratch.map(scratchPath));
  }
  const cachePaths = caches.map((c) => c.path);
  return {
    toolchains: ids,
    env,
    writable: ids.length === 0 ? [] : [input.scratchRoot, ...(shared && input.mode === 'install' ? cachePaths : [])],
    readOnly: shared && input.mode !== 'install' ? cachePaths : [],
    directories,
    caches,
    nisDomainName: ids.includes('dotnet'),
  };
}

/** Create the layout's directories, owner-only. Orbit (trusted) creates the caches; only the install step fills them. */
export function prepareToolchainLayout(layout: ToolchainLayout): void {
  for (const d of layout.directories) {
    mkdirSync(d, { recursive: true, mode: 0o700 });
    chmodSync(d, 0o700);
  }
}

/**
 * Remove a private scratch tree (a check's home, temp or toolchain directory). Two things get in the way of a plain
 * recursive remove: a tool that writes read-only directories (Go's module cache, when a check points it at scratch),
 * and a helper a tool left running that still writes there for a moment (Go's telemetry sidecar under the private
 * home), which makes a directory non-empty again mid-removal. A directory without write permission cannot have its
 * entries unlinked, and which error that surfaces as depends on the platform's recursive remove: EACCES or EPERM from
 * the unlink itself (Node 22), or ENOTEMPTY (Node 24 on macOS), where the failed removal of the directory's entries
 * is overwritten by the parent's own rmdir failing. So all three mean "make the tree writable, then remove it"; any
 * other error is thrown as it came.
 */
export function removeScratch(dir: string): void {
  const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  try {
    remove();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw err;
  }
  makeTreeWritable(dir);
  remove();
}

/**
 * Give every directory under `dir` (and `dir`) owner read, write and search permission, top down, so the entries of a
 * directory a tool made read-only can be unlinked. Symbolic links are never followed: a link is neither chmod'd nor
 * descended into, so nothing outside the tree changes mode.
 */
function makeTreeWritable(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) return;
  } catch {
    return;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    try {
      chmodSync(d, 0o700);
      for (const entry of readdirSync(d, { withFileTypes: true })) if (entry.isDirectory()) stack.push(join(d, entry.name));
    } catch {
      /* gone already */
    }
  }
}
