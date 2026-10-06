import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join } from 'node:path';

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
  /** What `orbit doctor` starts: the first executable found on PATH, with these arguments. */
  probe: { executables: readonly string[]; args: readonly string[] };
  env(d: ToolchainEnvDirs): Record<string, string>;
}

export const TOOLCHAIN_PROFILES: Readonly<Record<ToolchainId, ToolchainProfile>> = {
  dotnet: {
    id: 'dotnet',
    executables: /^dotnet$/,
    markers: ['*.sln', '*.slnx', '*.csproj', '*.fsproj', '*.vbproj', 'global.json', 'Directory.Build.props'],
    caches: ['nuget'],
    scratch: ['nuget-http', 'nuget-plugins'],
    scratchVars: ['NUGET_HTTP_CACHE_PATH', 'NUGET_PLUGINS_CACHE_PATH'],
    registryHosts: ['api.nuget.org'],
    // `dotnet --version` skips the SDK's first-run steps, where the sandbox stopped it (#10); `dotnet help` runs them.
    probe: { executables: ['dotnet'], args: ['help'] },
    env: (d) => ({ NUGET_PACKAGES: d.cache('nuget'), NUGET_HTTP_CACHE_PATH: d.scratch('nuget-http'), NUGET_PLUGINS_CACHE_PATH: d.scratch('nuget-plugins') }),
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
  /** For RUSTUP_HOME; defaults to process.env. */
  hostEnv?: Readonly<Record<string, string | undefined>>;
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
}

function rustupHomeOf(input: ToolchainLayoutInput): string | null {
  const configured = (input.hostEnv ?? process.env).RUSTUP_HOME;
  if (configured && configured.trim() !== '') return isAbsolute(configured) ? configured : null;
  if (!input.hostHome) return null;
  const dflt = join(input.hostHome, '.rustup');
  return existsSync(dflt) ? dflt : null;
}

/** Where each detected toolchain's caches and scratch go for one process, and what its sandbox must allow. */
export function toolchainLayout(input: ToolchainLayoutInput): ToolchainLayout {
  const ids = ordered(input.toolchains);
  const shared = input.cacheRoot !== null;
  const cachePath = (name: string) => (input.cacheRoot !== null ? join(input.cacheRoot, name) : join(input.scratchRoot, 'cache', name));
  const scratchPath = (name: string) => join(input.scratchRoot, name);
  const rustupHome = ids.includes('rust') ? rustupHomeOf(input) : null;
  const env: Record<string, string> = {};
  const directories: string[] = [];
  const caches: ToolchainLayout['caches'] = [];
  for (const id of ids) {
    const p = TOOLCHAIN_PROFILES[id];
    Object.assign(env, p.env({ mode: input.mode, cache: cachePath, scratch: scratchPath, tmpDir: input.tmpDir, rustupHome }));
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
 * home), which makes a directory non-empty again mid-removal. Both are retried; anything else is thrown.
 */
export function removeScratch(dir: string): void {
  const remove = () => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  try {
    remove();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EACCES' && code !== 'EPERM') throw err;
  }
  const stack = [dir];
  while (stack.length > 0) {
    const d = stack.pop()!;
    try {
      chmodSync(d, 0o700);
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (lstatSync(p).isDirectory()) stack.push(p);
      }
    } catch {
      /* gone already */
    }
  }
  remove();
}
