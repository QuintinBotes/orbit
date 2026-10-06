import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkSandboxCheck } from '../../../src/cli/commands/doctor-sandbox.ts';
import { candidateSubject, INSTALL_CHECK_ID, runCheckSet, runChecks } from '../../../src/evidence/runner.ts';
import { SandboxRuntimeIsolation } from '../../../src/isolation/sandbox-runtime.ts';
import { toolchainCacheRoot } from '../../../src/isolation/toolchains.ts';
import { which } from '../../../src/isolation/util.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition } from '../../../src/policy/types.ts';
import { repoKeyFor } from '../../../src/storage/retention.ts';
import { checkDef, nodeCheck } from '../../unit/evidence/fixtures.ts';
import { runnerEnv, type RunnerEnv } from './harness.ts';

/**
 * Toolchain sandbox profiles (docs/decisions/0009-toolchain-profiles.md) under Orbit's real srt check profile: each
 * installed toolchain builds and tests a tiny project with its dependency cache read-only under the (denied) Orbit
 * home and its build state private to the attempt, and a check that writes the cache is refused. Each part is
 * skipped where srt or the tool is missing.
 */
const installDir = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const provider = new SandboxRuntimeIsolation({ orbitInstallDir: installDir });
const probe = await provider.available();
const tool = (name: string, ...fallbacks: string[]): string | null => which(name, process.env.PATH) ?? fallbacks.find((p) => existsSync(p)) ?? null;
const tools = {
  python3: tool('python3'),
  go: tool('go'),
  cargo: tool('cargo'),
  java: tool('java'),
  dotnet: tool('dotnet', join(homedir(), '.dotnet', 'dotnet')),
};
const skipFor = (name: keyof typeof tools): string | null => (!probe.ok ? `srt unavailable: ${probe.detail}` : tools[name] === null ? `${name} is not installed` : null);
const title = (what: string, skip: string | null) => (skip === null ? what : `${what} skipped: ${skip}`);

const envs: RunnerEnv[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A repository with `files`, the srt provider, and a dependency cache root under the run's (denied) Orbit home. */
async function sandboxed(checks: CheckDefinition[], files: Record<string, string>) {
  const e = await runnerEnv(checks, { isolation: provider, files });
  envs.push(e);
  const cacheRoot = toolchainCacheRoot(join(e.ctx.homeDir!, '.orbit'), 'abcdefabcdef');
  return { e, cacheRoot, ctx: { ...e.ctx, toolchainCacheRoot: cacheRoot } };
}

async function check(checks: CheckDefinition[], files: Record<string, string>) {
  const s = await sandboxed(checks, files);
  const [r] = await runChecks({ ...s.ctx, candidate: s.e.candidate, checkIds: [checks[0]!.id] });
  return { ...s, r: r!, log: readFileSync(r!.logPath, 'utf8') };
}

/** Orbit's dependency install step, generated (not from the policy): the one step that may write the caches. */
async function install(s: Awaited<ReturnType<typeof sandboxed>>, command: string[]) {
  const def: CheckDefinition = { ...defaultCheck(INSTALL_CHECK_ID), command, timeout_seconds: 300, mandatory: false };
  const subject = { ...candidateSubject(s.e.ctx.runDir, s.e.candidate), source: 'install' as const };
  const [r] = await runCheckSet({ ...s.ctx, definitions: { [INSTALL_CHECK_ID]: def } }, subject, [def]);
  return { r: r!, log: readFileSync(r!.logPath, 'utf8') };
}

const GO_MOD = { 'go.mod': 'module acme\n\ngo 1.22\n' };
/**
 * How the sandbox refuses a write to a path it allows only for reading, as Node reports it: Seatbelt on macOS denies
 * the call (EPERM, "operation not permitted", or EACCES), bubblewrap on Linux mounts the path read-only (EROFS,
 * "read-only file system"). Either way the write is refused; only the words differ.
 */
const WRITE_DENIED = process.platform === 'darwin' ? /\b(EPERM|EACCES)\b|operation not permitted|permission denied/i : /\bEROFS\b|read-only file system/i;
const WRITE_CACHE = 'const fs=require("fs"),p=require("path");fs.writeFileSync(p.join(process.env.GOMODCACHE,"planted"),"x");console.log("wrote the cache")';

describe.skipIf(!probe.ok)(title('the dependency cache under srt', probe.ok ? null : `srt unavailable: ${probe.detail}`), () => {
  it('refuses a check that writes the dependency cache, and lets the install step write it', async () => {
    const s = await sandboxed([nodeCheck('unit', WRITE_CACHE, { timeout_seconds: 120 })], GO_MOD);
    const [r] = await runChecks({ ...s.ctx, candidate: s.e.candidate, checkIds: ['unit'] });
    const log = readFileSync(r!.logPath, 'utf8');
    expect(r!.status).toBe('FAILED');
    expect(log).toMatch(WRITE_DENIED);
    expect(existsSync(join(s.cacheRoot, 'gomod', 'planted'))).toBe(false);

    const i = await install(s, [process.execPath, '-e', WRITE_CACHE]);
    expect(i.log).toContain('wrote the cache');
    expect(i.r.status).toBe('PASSED');
    expect(existsSync(join(s.cacheRoot, 'gomod', 'planted'))).toBe(true);
  }, 120_000);
});

describe.skipIf(skipFor('python3') !== null)(title('a python3 unittest check under srt', skipFor('python3')), () => {
  it('passes, with __pycache__ in the attempt\'s scratch instead of the checkout', async () => {
    const files = {
      'acme/__init__.py': 'def add(a, b):\n    return a + b\n',
      'tests/__init__.py': '',
      'tests/test_acme.py': 'import unittest\nfrom acme import add\n\n\nclass AddTest(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(1, 2), 3)\n',
      'requirements.txt': '',
    };
    const { r, log, e } = await check([checkDef('unit', { command: [tools.python3!, '-m', 'unittest', '-v'], timeout_seconds: 120 })], files);
    expect(log).toMatch(/Ran 1 test/);
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
    expect(existsSync(join(e.checkoutDir, 'acme', '__pycache__'))).toBe(false);
  }, 180_000);
});

describe.skipIf(skipFor('go') !== null)(title('a go test check under srt', skipFor('go')), () => {
  it('passes with the module cache read-only and the build cache private', async () => {
    const files = {
      ...GO_MOD,
      'acme.go': 'package acme\n\nfunc Add(a, b int) int { return a + b }\n',
      'acme_test.go': 'package acme\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("add")\n\t}\n}\n',
    };
    const { r, log, cacheRoot } = await check([checkDef('unit', { command: [tools.go!, 'test', './...'], timeout_seconds: 300 })], files);
    expect(log).toMatch(/^ok\s+acme/m);
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
    expect(readdirSync(join(cacheRoot, 'gomod'))).toEqual([]);
  }, 300_000);
});

describe.skipIf(skipFor('cargo') !== null)(title('a cargo test check under srt', skipFor('cargo')), () => {
  it('fills CARGO_HOME in the install step, then tests with it read-only and the target directory private', async () => {
    const files = {
      'Cargo.toml': '[package]\nname = "acme"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\n',
      'Cargo.lock': '# This file is automatically @generated by Cargo.\nversion = 3\n\n[[package]]\nname = "acme"\nversion = "0.1.0"\n',
      'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(super::add(1, 2), 3);\n    }\n}\n',
    };
    const s = await sandboxed([checkDef('unit', { command: [tools.cargo!, 'test', '--locked'], timeout_seconds: 300 })], files);
    const i = await install(s, [tools.cargo!, 'fetch', '--locked']);
    expect(i.r.status).toBe('PASSED');
    expect(readdirSync(join(s.cacheRoot, 'cargo')).length).toBeGreaterThan(0);
    const [r] = await runChecks({ ...s.ctx, candidate: s.e.candidate, checkIds: ['unit'] });
    expect(readFileSync(r!.logPath, 'utf8')).toMatch(/test tests::adds \.\.\. ok/);
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
    expect(existsSync(join(s.e.checkoutDir, 'target'))).toBe(false);
  }, 300_000);
});

describe.skipIf(skipFor('java') !== null)(title('a single-file java check under srt', skipFor('java')), () => {
  it('runs, with java.io.tmpdir in the check\'s private temp directory', async () => {
    const files = { 'Acme.java': 'public class Acme {\n  public static void main(String[] args) throws Exception {\n    java.io.File f = java.io.File.createTempFile("acme", ".txt");\n    if (1 + 2 != 3) System.exit(1);\n    System.out.println("acme ok " + f.delete());\n  }\n}\n' };
    const { r, log } = await check([checkDef('unit', { command: [tools.java!, 'Acme.java'], timeout_seconds: 120 })], files);
    expect(log).toContain('acme ok true');
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
  }, 180_000);
});

describe.skipIf(skipFor('dotnet') !== null)(title('a dotnet build check under srt with the NuGet cache read-only', skipFor('dotnet')), () => {
  it('builds a minimal console project', async () => {
    const files = {
      'acme.csproj': '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n',
      'Program.cs': 'System.Console.WriteLine("hello acme");\n',
    };
    const { r, log, cacheRoot } = await check([checkDef('build', { command: [tools.dotnet!, 'build'], timeout_seconds: 300 })], files);
    expect(log).toMatch(/Build succeeded/);
    expect(r).toMatchObject({ status: 'PASSED', isolation: 'sandbox-runtime' });
    expect(readdirSync(join(cacheRoot, 'nuget'))).toEqual([]);
  }, 300_000);
});

describe.skipIf(!probe.ok)(title('orbit doctor reports each installed toolchain under srt', probe.ok ? null : `srt unavailable: ${probe.detail}`), () => {
  it('starts every installed toolchain in the check sandbox and names its cache', async () => {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-toolchains-repo-')));
    const orbitHome = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-toolchains-home-')));
    dirs.push(repo, orbitHome);
    for (const f of ['go.mod', 'Cargo.toml', 'pyproject.toml', 'pom.xml', 'acme.csproj']) writeFileSync(join(repo, f), '');
    const config = defaultConfig('autonomous');
    config.checks = { unit: { ...defaultCheck('unit'), command: ['/bin/sh', '-c', 'exit 0'], mandatory: true } };
    const env = { ...process.env, PATH: [process.env.PATH, ...Object.values(tools).filter((t): t is string => t !== null).map(dirname)].join(':') };
    const c = await checkSandboxCheck({ config, repo, provider, available: true, env, homeDir: homedir(), orbitHome });
    const key = repoKeyFor(repo);
    const expected: [string, keyof typeof tools, string][] = [['dotnet', 'dotnet', 'nuget'], ['go', 'go', 'gomod'], ['jvm', 'java', 'gradle'], ['python', 'python3', 'pip'], ['rust', 'cargo', 'cargo']];
    for (const [id, exe, cache] of expected) {
      const line = c.details.find((d) => d.startsWith(`toolchain ${id}:`));
      expect(line, id).toBeDefined();
      if (tools[exe] === null) continue;
      // Started by its own name: rustup's cargo is a link to rustup, whose `--version` runs where cargo cannot.
      expect(line, id).toMatch(new RegExp(`^toolchain ${id}: "${exe} [^"]*" ran in the sandbox; dependency caches? `));
      expect(line, id).toContain(join(orbitHome, 'toolchains', key, cache));
    }
    expect(c.status).toBe('pass');
    expect(existsSync(join(orbitHome, 'toolchains'))).toBe(false);
  }, 300_000);
});
