// Toolchain sandbox profiles (docs/decisions/0009-toolchain-profiles.md): one table keyed by toolchain, detected from a
// check's command and the repository; dependency caches per repository, read-only outside the install step; build
// state private per attempt; nothing shared between repositories and nothing pointing at the user's own caches.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildSrtSettings } from '../../../src/isolation/sandbox-runtime.ts';
import { profileForCheck } from '../../../src/isolation/profiles.ts';
import {
  detectToolchains,
  prepareToolchainLayout,
  TOOLCHAIN_IDS,
  TOOLCHAIN_PROFILES,
  toolchainCacheRoot,
  toolchainLayout,
  toolchainRegistryHosts,
  type ToolchainId,
} from '../../../src/isolation/toolchains.ts';
import { defaultCheck } from '../../../src/policy/config.ts';
import { fakeSnapshot } from '../evidence/report-fixtures.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix = 'orbit-toolchains-'): string {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
}

function repoWith(files: string[]): string {
  const d = temp('orbit-toolchains-repo-');
  for (const f of files) {
    mkdirSync(join(d, f, '..'), { recursive: true });
    writeFileSync(join(d, f), '');
  }
  return d;
}

describe('the toolchain profile table', () => {
  it('has one entry per toolchain, each with its dependency caches, private build state and registry hosts', () => {
    expect([...TOOLCHAIN_IDS]).toEqual(['dotnet', 'go', 'jvm', 'python', 'rust']);
    expect(Object.keys(TOOLCHAIN_PROFILES).sort()).toEqual([...TOOLCHAIN_IDS]);
    expect(Object.fromEntries(TOOLCHAIN_IDS.map((id) => [id, TOOLCHAIN_PROFILES[id].caches]))).toEqual({
      dotnet: ['nuget'],
      go: ['gomod'],
      jvm: ['gradle', 'maven'],
      python: ['pip'],
      rust: ['cargo'],
    });
    expect(Object.fromEntries(TOOLCHAIN_IDS.map((id) => [id, TOOLCHAIN_PROFILES[id].scratch]))).toEqual({
      dotnet: ['nuget-http', 'nuget-plugins'],
      go: ['gocache', 'gopath'],
      jvm: ['gradle-home', 'maven-repo'],
      python: ['pycache', 'python-user'],
      rust: ['cargo-target'],
    });
    for (const id of TOOLCHAIN_IDS) {
      expect(TOOLCHAIN_PROFILES[id].id).toBe(id);
      expect(TOOLCHAIN_PROFILES[id].registryHosts.length, id).toBeGreaterThan(0);
      expect(TOOLCHAIN_PROFILES[id].probe.executables.length, id).toBeGreaterThan(0);
    }
    expect(toolchainRegistryHosts(['rust', 'go'])).toEqual(['proxy.golang.org', 'sum.golang.org', 'index.crates.io', 'static.crates.io']);
    expect(toolchainRegistryHosts([])).toEqual([]);
  });

  it('points each tool at the repository cache and at private per-attempt scratch, in a check', () => {
    const cacheRoot = '/orbit/toolchains/abc';
    const scratch = '/run/check/toolchains';
    const l = toolchainLayout({ toolchains: [...TOOLCHAIN_IDS], mode: 'check', cacheRoot, scratchRoot: scratch, tmpDir: '/t', hostHome: '/nonexistent-home', hostEnv: {} });
    expect(l.env).toEqual({
      NUGET_PACKAGES: `${cacheRoot}/nuget`,
      NUGET_HTTP_CACHE_PATH: `${scratch}/nuget-http`,
      NUGET_PLUGINS_CACHE_PATH: `${scratch}/nuget-plugins`,
      GOMODCACHE: `${cacheRoot}/gomod`,
      GOCACHE: `${scratch}/gocache`,
      GOPATH: `${scratch}/gopath`,
      GRADLE_USER_HOME: `${scratch}/gradle-home`,
      GRADLE_RO_DEP_CACHE: `${cacheRoot}/gradle/caches`,
      MAVEN_OPTS: `-Dmaven.repo.local=${scratch}/maven-repo -Dmaven.repo.local.tail=${cacheRoot}/maven`,
      JDK_JAVA_OPTIONS: '-Djava.io.tmpdir=/t',
      PIP_CACHE_DIR: `${cacheRoot}/pip`,
      PIP_DISABLE_PIP_VERSION_CHECK: '1',
      PYTHONPYCACHEPREFIX: `${scratch}/pycache`,
      PYTHONUSERBASE: `${scratch}/python-user`,
      POETRY_VIRTUALENVS_IN_PROJECT: 'true',
      PIPENV_VENV_IN_PROJECT: '1',
      CARGO_HOME: `${cacheRoot}/cargo`,
      CARGO_TARGET_DIR: `${scratch}/cargo-target`,
    });
    // Dependency caches are read-only outside the install step; only the scratch root is writable.
    expect(l.writable).toEqual([scratch]);
    expect(l.readOnly).toEqual(['nuget', 'gomod', 'gradle', 'maven', 'pip', 'cargo'].map((c) => `${cacheRoot}/${c}`));
    expect(l.caches.map((c) => `${c.toolchain}:${c.name}`)).toEqual(['dotnet:nuget', 'go:gomod', 'jvm:gradle', 'jvm:maven', 'python:pip', 'rust:cargo']);
  });

  it('lets the install step write the caches it fills: Gradle and Maven use them as their own homes there', () => {
    const l = toolchainLayout({ toolchains: ['jvm', 'go'], mode: 'install', cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostEnv: {} });
    expect(l.env).toMatchObject({ GRADLE_USER_HOME: '/c/gradle', MAVEN_OPTS: '-Dmaven.repo.local=/c/maven', GOMODCACHE: '/c/gomod' });
    expect(l.env).not.toHaveProperty('GRADLE_RO_DEP_CACHE');
    expect(l.writable).toEqual(['/s', '/c/gomod', '/c/gradle', '/c/maven']);
    expect(l.readOnly).toEqual([]);
  });

  it('keeps the caches read-only for a worker too', () => {
    const l = toolchainLayout({ toolchains: ['go'], mode: 'worker', cacheRoot: '/c', scratchRoot: '/w/toolchains', tmpDir: '/t', hostEnv: {} });
    expect(l.writable).toEqual(['/w/toolchains']);
    expect(l.readOnly).toEqual(['/c/gomod']);
  });

  it('without an Orbit home, puts the caches in the private scratch too (writable, per attempt)', () => {
    const l = toolchainLayout({ toolchains: ['rust'], mode: 'check', cacheRoot: null, scratchRoot: '/s', tmpDir: '/t', hostEnv: {} });
    expect(l.env).toMatchObject({ CARGO_HOME: '/s/cache/cargo', CARGO_TARGET_DIR: '/s/cargo-target' });
    expect(l.writable).toEqual(['/s']);
    expect(l.readOnly).toEqual([]);
  });

  it('sets nothing for a toolchain that was not detected', () => {
    const l = toolchainLayout({ toolchains: [], mode: 'check', cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostEnv: {} });
    expect(l).toMatchObject({ env: {}, readOnly: [], caches: [], directories: [] });
  });

  it('never points a tool at the user\'s own caches; rustup\'s installation is found, read only', () => {
    const home = temp('orbit-toolchains-home-');
    for (const d of ['.cargo', 'go', '.m2', '.nuget/packages', 'Library/Caches/pip', '.rustup']) mkdirSync(join(home, d), { recursive: true });
    const l = toolchainLayout({ toolchains: [...TOOLCHAIN_IDS], mode: 'check', cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostHome: home, hostEnv: {} });
    const { RUSTUP_HOME, ...rest } = l.env;
    expect(RUSTUP_HOME).toBe(join(home, '.rustup'));
    for (const [k, v] of Object.entries(rest)) expect(v.includes(home), `${k}=${v}`).toBe(false);
    expect(l.writable.concat(l.readOnly).some((p) => p.startsWith(home))).toBe(false);
    // RUSTUP_HOME from the environment wins; a relative one is ignored.
    expect(toolchainLayout({ toolchains: ['rust'], mode: 'check', cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostHome: home, hostEnv: { RUSTUP_HOME: '/opt/rustup' } }).env.RUSTUP_HOME).toBe('/opt/rustup');
    expect(toolchainLayout({ toolchains: ['rust'], mode: 'check', cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostHome: '/nonexistent', hostEnv: { RUSTUP_HOME: 'rel' } }).env).not.toHaveProperty('RUSTUP_HOME');
  });

  it('points a JVM toolchain at the host\'s JDK through JAVA_HOME, in every mode, and nothing else at it', () => {
    const jdk = '/opt/hostedtoolcache/Java_Temurin-Hotspot_jdk/21/arm64/Contents/Home';
    for (const mode of ['install', 'check', 'worker'] as const) {
      const l = toolchainLayout({ toolchains: ['jvm'], mode, cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostEnv: { JAVA_HOME: jdk } });
      expect(l.env.JAVA_HOME, mode).toBe(jdk);
      // The JDK is read where it is: never made writable, never re-allowed inside a denied directory.
      expect(l.writable.concat(l.readOnly).some((p) => p.startsWith(jdk)), mode).toBe(false);
    }
    // Only for a JVM check; a relative or empty JAVA_HOME names no JDK.
    expect(toolchainLayout({ toolchains: ['go'], mode: 'check', cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostEnv: { JAVA_HOME: jdk } }).env).not.toHaveProperty('JAVA_HOME');
    for (const JAVA_HOME of ['jdk', ' ', '']) {
      expect(toolchainLayout({ toolchains: ['jvm'], mode: 'check', cacheRoot: '/c', scratchRoot: '/s', tmpDir: '/t', hostEnv: { JAVA_HOME } }).env, JSON.stringify(JAVA_HOME)).not.toHaveProperty('JAVA_HOME');
    }
  });

  it('keys the caches by repository under the Orbit home, so nothing is shared between repositories', () => {
    expect(toolchainCacheRoot('/home/acme/.orbit', 'aaaaaaaaaaaa')).toBe('/home/acme/.orbit/toolchains/aaaaaaaaaaaa');
    expect(toolchainCacheRoot('/home/acme/.orbit', 'aaaaaaaaaaaa')).not.toBe(toolchainCacheRoot('/home/acme/.orbit', 'bbbbbbbbbbbb'));
    expect(() => toolchainCacheRoot('/home/acme/.orbit', '../x')).toThrow(/repository key/);
  });

  it('creates every cache and scratch directory owner-only, and can run again', () => {
    const root = temp();
    const l = toolchainLayout({ toolchains: ['go', 'python'], mode: 'check', cacheRoot: join(root, 'cache'), scratchRoot: join(root, 'scratch'), tmpDir: '/t', hostEnv: {} });
    prepareToolchainLayout(l);
    prepareToolchainLayout(l);
    expect(l.directories).toEqual([join(root, 'cache', 'gomod'), join(root, 'scratch', 'gocache'), join(root, 'scratch', 'gopath'), join(root, 'cache', 'pip'), join(root, 'scratch', 'pycache'), join(root, 'scratch', 'python-user')]);
    for (const d of l.directories) expect(statSync(d).mode & 0o077, d).toBe(0);
  });
});

describe('detectToolchains', () => {
  const words = (command: string[], shell = false) => detectToolchains({ command, shell, roots: [] });

  it('reads the executables of the command, by base name and with version suffixes', () => {
    expect(words(['go', 'test', './...'])).toEqual(['go']);
    expect(words(['/opt/homebrew/bin/cargo', 'test', '--locked'])).toEqual(['rust']);
    expect(words(['./gradlew', 'test'])).toEqual(['jvm']);
    expect(words(['mvn', '-q', 'verify'])).toEqual(['jvm']);
    expect(words(['java', 'Acme.java'])).toEqual(['jvm']);
    expect(words(['python3.12', '-m', 'unittest'])).toEqual(['python']);
    expect(words(['pytest', '-q'])).toEqual(['python']);
    expect(words(['dotnet', 'test'])).toEqual(['dotnet']);
    expect(words(['npm', 'test'])).toEqual([]);
    expect(words(['node', '-e', 'process.exit(0)'])).toEqual([]);
  });

  it('reads every word of a shell script', () => {
    expect(words(['cd app && go vet ./... && cargo build; python3 -m unittest'], true)).toEqual(['go', 'python', 'rust']);
    expect(words(['FOO=1 make test|tee out.txt'], true)).toEqual([]);
  });

  it('reads the repository\'s marker files, at the checkout root and in the check\'s directory', () => {
    const roots = (files: string[]): ToolchainId[] => detectToolchains({ command: ['make', 'test'], shell: false, roots: [repoWith(files)] });
    expect(roots(['go.mod'])).toEqual(['go']);
    expect(roots(['Cargo.toml'])).toEqual(['rust']);
    expect(roots(['acme.csproj'])).toEqual(['dotnet']);
    expect(roots(['Acme.sln'])).toEqual(['dotnet']);
    expect(roots(['pyproject.toml'])).toEqual(['python']);
    expect(roots(['requirements.txt'])).toEqual(['python']);
    expect(roots(['pom.xml'])).toEqual(['jvm']);
    expect(roots(['build.gradle.kts'])).toEqual(['jvm']);
    expect(roots(['package.json', 'README.md'])).toEqual([]);
    // Only the directories named: a marker deeper down is another directory's.
    expect(roots(['services/api/go.mod'])).toEqual([]);
    const repo = repoWith(['services/api/go.mod']);
    expect(detectToolchains({ command: ['make'], shell: false, roots: [repo, join(repo, 'services', 'api')] })).toEqual(['go']);
    expect(detectToolchains({ command: ['make'], shell: false, roots: [join(repo, 'missing')] })).toEqual([]);
  });
});

describe('a check profile with toolchain caches', () => {
  it('re-allows the cache for reading inside the denied Orbit home and never for writing (srt rules)', () => {
    const home = temp('orbit-toolchains-home-');
    const worktree = temp('orbit-toolchains-wt-');
    const cacheRoot = toolchainCacheRoot(join(home, '.orbit'), 'abcdefabcdef');
    const l = toolchainLayout({ toolchains: ['go'], mode: 'check', cacheRoot, scratchRoot: join(worktree, '..', 'scratch'), tmpDir: '/t', hostEnv: {} });
    const check = { ...defaultCheck('unit'), command: ['go', 'test'] };
    const profile = profileForCheck({ worktree, check, snapshot: fakeSnapshot([]), extraWritable: l.writable, readablePaths: l.readOnly, homeDir: home });
    const gomod = join(cacheRoot, 'gomod');
    expect(profile.writablePaths).not.toContain(gomod);
    expect(profile.readablePaths).toContain(gomod);
    const srt = buildSrtSettings(profile);
    expect(srt.filesystem.denyRead).toContain(join(home, '.orbit'));
    expect(srt.filesystem.allowRead).toContain(gomod);
    expect(srt.filesystem.allowWrite.some((w) => gomod === w || gomod.startsWith(`${w}/`))).toBe(false);
  });
});
