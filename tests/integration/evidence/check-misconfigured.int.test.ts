import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyMisconfigured, classifyProgramNotFound } from '../../../src/evidence/check-misconfigured.ts';
import { runChecks } from '../../../src/evidence/runner.ts';
import { which } from '../../../src/isolation/util.ts';
import { checkDef } from '../../unit/evidence/fixtures.ts';
import { runnerEnv, type RunnerEnv } from './harness.ts';

/**
 * Issue #23: the usage-error table against the real tools. Each misconfigured command runs as a check through Orbit's
 * runner (the environment a check gets: a private HOME and TMPDIR, the toolchain variables), and the log it leaves is
 * classified as PREFLIGHT classifies it: an argument error, a missing target, or (exit 127) a program that is not
 * installed, which is the environment's. A usage error the check's command does not print itself (a script of the
 * repository, a chain) is none of them. Each tool is skipped where it is not installed.
 */
const dotnet = which('dotnet', process.env.PATH) ?? [join(homedir(), '.dotnet', 'dotnet')].find((p) => existsSync(p)) ?? null;
const python = which('python3', process.env.PATH);
const hasPytest = python !== null && (() => {
  try {
    execFileSync(python, ['-m', 'pytest', '--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
})();

const envs: RunnerEnv[] = [];
afterEach(async () => {
  for (const e of envs.splice(0)) await e.close();
});

async function run(command: string[], files?: Record<string, string>, shell = false): Promise<{ exitCode: number | null; log: string }> {
  const e = await runnerEnv([checkDef('build', { command, shell, timeout_seconds: 300 })], files ? { files: { 'README.md': 'acme\n', ...files } } : {});
  envs.push(e);
  const [r] = await runChecks({ ...e.ctx, candidate: e.candidate, checkIds: ['build'] });
  expect(r!.status).toBe('FAILED');
  return { exitCode: r!.exitCode, log: readFileSync(r!.logPath, 'utf8') };
}

const PACKAGE = '{"name":"acme","version":"1.0.0","private":true,"scripts":{"test":"node -e 0"}}\n';
const hasCargo = which('cargo', process.env.PATH) !== null;
const hasGo = which('go', process.env.PATH) !== null;

const CASES: { name: string; available: boolean; command: () => string[]; shell?: boolean; files?: Record<string, string>; signature: string; kind: 'argument' | 'missing-target'; line: RegExp }[] = [
  { name: 'dotnet build with two projects', available: dotnet !== null, command: () => [dotnet!, 'build', 'A.csproj', 'B.csproj'], signature: 'msbuild-one-project', kind: 'argument', line: /^MSBUILD : error MSB1008: Only one project can be specified\.$/ },
  { name: 'dotnet build of a project that does not exist', available: dotnet !== null, command: () => [dotnet!, 'build', 'Missing.csproj'], signature: 'msbuild-project-missing', kind: 'missing-target', line: /^MSBUILD : error MSB1009: Project file does not exist\.$/ },
  { name: 'dotnet build in a directory with no project', available: dotnet !== null, command: () => [dotnet!, 'build'], signature: 'msbuild-no-project', kind: 'missing-target', line: /^MSBUILD : error MSB1003: / },
  { name: 'dotnet build with an unknown switch', available: dotnet !== null, command: () => [dotnet!, 'build', '--bogus-flag'], signature: 'msbuild-unknown-switch', kind: 'argument', line: /^MSBUILD : error MSB1001: Unknown switch\.$/ },
  // dotnet test hands MSBuild what it does not know itself, a test platform's option included, until the repository runs that platform.
  { name: 'dotnet test with an unknown switch', available: dotnet !== null, command: () => [dotnet!, 'test', '--report-trx'], signature: 'dotnet-test-unknown-switch', kind: 'missing-target', line: /^MSBUILD : error MSB1001: Unknown switch\.$/ },
  { name: 'dotnet with no such command', available: dotnet !== null, command: () => [dotnet!, 'tset'], signature: 'dotnet-no-such-command', kind: 'missing-target', line: /^Could not execute because the specified command or file was not found\.$/ },
  { name: 'npm with a missing script', available: which('npm', process.env.PATH) !== null, command: () => ['npm', 'run', 'tset'], files: { 'package.json': PACKAGE }, signature: 'npm-missing-script', kind: 'missing-target', line: /^npm (?:error|ERR!) Missing script: "tset"$/ },
  { name: 'pytest with an unknown argument', available: hasPytest, command: () => [python!, '-m', 'pytest', '--bogus'], signature: 'pytest-unrecognized-arguments', kind: 'missing-target', line: /: error: unrecognized arguments: --bogus$/ },
  // An option of a plugin that is not loaded is the same error: -p no:cov stands in for a pytest-cov the repository does not install yet.
  { name: 'pytest with a plugin option and no plugin', available: hasPytest, command: () => [python!, '-m', 'pytest', '-p', 'no:cov', '--cov=src'], signature: 'pytest-unrecognized-arguments', kind: 'missing-target', line: /: error: unrecognized arguments: --cov=src$/ },
  { name: 'pytest with a test file that does not exist', available: hasPytest, command: () => [python!, '-m', 'pytest', 'tests/missing_test.py'], signature: 'pytest-path-not-found', kind: 'missing-target', line: /^ERROR: file or directory not found: tests\/missing_test\.py$/ },
  { name: 'go build with an unknown flag', available: hasGo, command: () => ['go', 'build', '-bogus'], signature: 'go-flag', kind: 'argument', line: /^flag provided but not defined: -bogus$/ },
  { name: 'go with no such command', available: hasGo, command: () => ['go', 'tset'], signature: 'go-unknown-command', kind: 'argument', line: /^go tset: unknown command$/ },
  { name: 'go mod with no such command', available: hasGo, command: () => ['go', 'mod', 'tset'], signature: 'go-unknown-command', kind: 'argument', line: /^go mod: unknown command$/ },
  { name: 'cargo test with an unknown argument', available: hasCargo, command: () => ['cargo', 'test', '--bogus'], signature: 'cargo-unexpected-argument', kind: 'argument', line: /^error: unexpected argument '--bogus' found$/ },
  { name: 'cargo with no such command', available: hasCargo, command: () => ['cargo', 'tset'], signature: 'cargo-no-such-command', kind: 'missing-target', line: /^error: no such command: `tset`$/ },
  { name: 'a script of the repository that does not exist yet', available: true, command: () => ['./scripts/check.sh --fast'], shell: true, signature: 'script-not-found', kind: 'missing-target', line: /\.\/scripts\/check\.sh: (?:No such file or directory|not found)$/ },
];

describe('the misconfigured-check table against the real tools, run as checks', () => {
  for (const c of CASES) {
    it.skipIf(!c.available)(`${c.name}: ${c.signature}`, async () => {
      const command = c.command();
      const { exitCode, log } = await run(command, c.files, c.shell === true);
      const found = classifyMisconfigured({ checkId: 'build', command, shell: c.shell === true, exitCode, output: log });
      expect(found, log).toMatchObject({ signature: c.signature, kind: c.kind, configKey: 'checks.build.command' });
      expect(found!.lines[0]).toMatch(c.line);
    }, 300_000);
  }

  it('a program the shell cannot find is not installed where the check runs: the environment, not a misconfigured check', async () => {
    const command = ['orbit-acme-missing-tool build'];
    const { exitCode, log } = await run(command, undefined, true);
    expect(exitCode).toBe(127);
    expect(classifyMisconfigured({ checkId: 'build', command, shell: true, exitCode, output: log })).toBeNull();
    const found = classifyProgramNotFound({ checkId: 'build', command, shell: true, exitCode, output: log });
    expect(found, log).toMatchObject({ signals: ['program-not-found'] });
    expect(found!.lines[0]).toMatch(/orbit-acme-missing-tool: (?:command )?not found$/);
  }, 300_000);

  it.skipIf(which('npm', process.env.PATH) === null)('npm test whose script runs a missing npm run lint, and a chain, stay pre-existing failures', async () => {
    const files = { 'package.json': '{"name":"acme","version":"1.0.0","private":true,"scripts":{"test":"npm run lint && node -e 0"}}\n' };
    const nested = await run(['npm', 'test'], files);
    expect(nested.log).toMatch(/Missing script: "lint"/);
    expect(classifyMisconfigured({ checkId: 'build', command: ['npm', 'test'], exitCode: nested.exitCode, output: nested.log })).toBeNull();
    const chained = await run(['node -e 0 && npm run lint'], files, true);
    expect(chained.log).toMatch(/Missing script: "lint"/);
    expect(classifyMisconfigured({ checkId: 'build', command: ['node -e 0 && npm run lint'], shell: true, exitCode: chained.exitCode, output: chained.log })).toBeNull();
  }, 300_000);

  it.skipIf(which('npm', process.env.PATH) === null)('npm test whose script runs npm test in a package that has none stays a pre-existing failure', async () => {
    const files = {
      'package.json': '{"name":"acme","version":"1.0.0","private":true,"scripts":{"test":"cd client && npm test"}}\n',
      'client/package.json': '{"name":"acme-client","version":"1.0.0","private":true}\n',
    };
    const nested = await run(['npm', 'test'], files);
    expect(nested.log).toMatch(/Missing script: "test"/);
    expect(nested.log).toMatch(/^> acme@1\.0\.0 test$/m);
    expect(classifyMisconfigured({ checkId: 'build', command: ['npm', 'test'], exitCode: nested.exitCode, output: nested.log })).toBeNull();
  }, 300_000);
});
