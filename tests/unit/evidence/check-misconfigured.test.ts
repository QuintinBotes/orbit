import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyMisconfigured, classifyProgramNotFound, USAGE_ERRORS, type MisconfiguredInput } from '../../../src/evidence/check-misconfigured.ts';

// Issue #23: a check whose command is wrong fails on the base revision in under a second, and was offered as a
// baseline exception. A tool's own usage error, from the check's own direct invocation of that tool, is not a
// pre-existing failure: an argument error is a misconfigured check, and a missing target (something the command names
// that does not exist yet) is one unless the goal is to create it (ADR 0010).

/**
 * Captured from the real tools (the .NET 9.0.305 SDK, npm 11, pytest 8.4, go 1.27, cargo 1.98, macOS /bin/sh and env),
 * with the machine's paths replaced by neutral ones (tests/fixtures/misconfigured).
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, '../../fixtures/misconfigured', name), 'utf8');
const environment = (name: string): string => readFileSync(join(here, '../../fixtures/environment', name), 'utf8');

const input = (command: string[], exitCode: number | null, output: string, more: Partial<MisconfiguredInput> = {}): MisconfiguredInput => ({ checkId: 'build', command, exitCode, output, ...more });

/** Each signature of the table, from the tool's real output: the command that produced it, its exit code, its kind, and the error line expected first. */
const CASES: { signature: string; kind: 'argument' | 'missing-target'; fixture: string; command: string[]; shell?: boolean; exit: number; line: string; detail?: string }[] = [
  { signature: 'msbuild-unknown-switch', kind: 'argument', fixture: 'dotnet-msb1001-unknown-switch.log', command: ['dotnet', 'test', '--bogus-flag'], exit: 1, line: 'MSBUILD : error MSB1001: Unknown switch.', detail: 'Switch: --bogus-flag' },
  { signature: 'msbuild-one-project', kind: 'argument', fixture: 'dotnet-msb1008-one-project.log', command: ['dotnet', 'build', 'A.csproj', 'B.csproj'], exit: 1, line: 'MSBUILD : error MSB1008: Only one project can be specified.', detail: 'Switch: B.csproj' },
  { signature: 'msbuild-ambiguous-project', kind: 'argument', fixture: 'dotnet-msb1011-ambiguous-project.log', command: ['dotnet', 'build'], exit: 1, line: 'MSBUILD : error MSB1011: Specify which project or solution file to use because this folder contains more than one project or solution file.' },
  { signature: 'msbuild-no-project', kind: 'missing-target', fixture: 'dotnet-msb1003-no-project.log', command: ['dotnet', 'build'], exit: 1, line: 'MSBUILD : error MSB1003: Specify a project or solution file. The current working directory does not contain a project or solution file.' },
  { signature: 'msbuild-project-missing', kind: 'missing-target', fixture: 'dotnet-msb1009-project-missing.log', command: ['dotnet', 'build', 'Missing.csproj'], exit: 1, line: 'MSBUILD : error MSB1009: Project file does not exist.', detail: 'Switch: Missing.csproj' },
  { signature: 'dotnet-no-such-command', kind: 'missing-target', fixture: 'dotnet-command-not-found.log', command: ['dotnet', 'tset'], exit: 1, line: 'Could not execute because the specified command or file was not found.' },
  { signature: 'npm-missing-script', kind: 'missing-target', fixture: 'npm-missing-script.log', command: ['npm', 'run', 'tset'], exit: 1, line: 'npm error Missing script: "tset"' },
  { signature: 'pytest-unrecognized-arguments', kind: 'argument', fixture: 'pytest-unrecognized-arguments.log', command: ['python3', '-m', 'pytest', '--bogus'], exit: 4, line: '__main__.py: error: unrecognized arguments: --bogus' },
  { signature: 'pytest-path-not-found', kind: 'missing-target', fixture: 'pytest-path-not-found.log', command: ['pytest', 'tests/missing_test.py'], exit: 4, line: 'ERROR: file or directory not found: tests/missing_test.py' },
  { signature: 'go-flag', kind: 'argument', fixture: 'go-flag-not-defined.log', command: ['go', 'build', '-bogus'], exit: 2, line: 'flag provided but not defined: -bogus' },
  { signature: 'go-unknown-command', kind: 'argument', fixture: 'go-unknown-command.log', command: ['go', 'tset'], exit: 2, line: 'go tset: unknown command' },
  { signature: 'cargo-unexpected-argument', kind: 'argument', fixture: 'cargo-unexpected-argument.log', command: ['cargo', 'test', '--bogus'], exit: 1, line: "error: unexpected argument '--bogus' found" },
  { signature: 'cargo-no-such-command', kind: 'missing-target', fixture: 'cargo-plugin-not-installed.log', command: ['cargo', 'nextest', 'run'], exit: 101, line: 'error: no such command: `nextest`' },
  { signature: 'script-not-found', kind: 'missing-target', fixture: 'sh-script-not-found.log', command: ['./scripts/check.sh'], shell: true, exit: 127, line: '/bin/sh: ./scripts/check.sh: No such file or directory' },
];

describe('classifyMisconfigured: the table of tool usage errors', () => {
  it('has one entry per signature, each tested here', () => {
    expect(USAGE_ERRORS.map((s) => s.id).sort()).toEqual(CASES.map((c) => c.signature).sort());
  });

  for (const c of CASES) {
    it(`reads ${c.signature} from the tool's real output, as ${c.kind === 'argument' ? 'an argument error' : 'a missing target'}`, () => {
      const f = classifyMisconfigured(input(c.command, c.exit, fixture(c.fixture), { shell: c.shell === true }));
      expect(f, c.fixture).toMatchObject({ checkId: 'build', kind: c.kind, signature: c.signature, configKey: 'checks.build.command' });
      expect(f!.lines[0]).toBe(c.line);
      if (c.detail) expect(f!.lines).toEqual([c.line, c.detail]);
      expect(f!.cause.length).toBeGreaterThan(10);
      expect(f!.cause).not.toMatch(/[\u2013\u2014]/);
    });
  }

  it('splits the table: an argument error the goal cannot fix, a missing target the goal may create', () => {
    const kinds = Object.fromEntries(USAGE_ERRORS.map((s) => [s.id, s.kind]));
    expect(Object.entries(kinds).filter(([, k]) => k === 'argument').map(([id]) => id).sort()).toEqual(['cargo-unexpected-argument', 'go-flag', 'go-unknown-command', 'msbuild-ambiguous-project', 'msbuild-one-project', 'msbuild-unknown-switch', 'pytest-unrecognized-arguments']);
    expect(Object.entries(kinds).filter(([, k]) => k === 'missing-target').map(([id]) => id).sort()).toEqual(['cargo-no-such-command', 'dotnet-no-such-command', 'msbuild-no-project', 'msbuild-project-missing', 'npm-missing-script', 'pytest-path-not-found', 'script-not-found']);
  });

  it('names the tool and what its error means in the cause', () => {
    expect(classifyMisconfigured(input(['dotnet', 'build', 'A.csproj', 'B.csproj'], 1, fixture('dotnet-msb1008-one-project.log')))!.cause).toMatch(/^dotnet \(MSBuild\) rejected the check's command line: .*more than one project/);
    expect(classifyMisconfigured(input(['npm', 'run', 'lint'], 1, 'npm error Missing script: "lint"\n'))!.cause).toMatch(/^npm could not find what the check's command names: package\.json has no script of that name/);
    // pytest 8.4 says the same for an option of a plugin that is not installed (--cov without pytest-cov), whose fix is
    // the plugin, not the command.
    const cov = classifyMisconfigured(input(['pytest', '--cov=acme'], 4, '__main__.py: error: unrecognized arguments: --cov=acme\n  inifile: None\n  rootdir: /home/acme/checkout\n\n'));
    expect(cov?.signature).toBe('pytest-unrecognized-arguments');
    expect(cov!.cause).toMatch(/an option of a plugin that is not installed where the check runs \(--cov without pytest-cov\)/);
  });

  it('reads the other spellings of a usage error the same tools print', () => {
    const cases: [string[], boolean, number, string, string][] = [
      [['npm', 'run', 'tset'], false, 1, 'npm ERR! Missing script: "tset"\n', 'npm-missing-script'],
      [['npm', 'test'], false, 1, 'npm error Missing script: "test"\n', 'npm-missing-script'],
      [['npm', '--silent', 'run-script', 'lint', '--', '--fix'], false, 1, 'npm error Missing script: "lint"\n', 'npm-missing-script'],
      [['pytest', '--bogus'], false, 4, 'ERROR: usage: pytest [options] [file_or_dir] [file_or_dir] [...]\npytest: error: unrecognized arguments: --bogus\n', 'pytest-unrecognized-arguments'],
      [['pytest', 'tests/test_new.py::test_a'], false, 4, 'ERROR: file or directory not found: tests/test_new.py::test_a\n', 'pytest-path-not-found'],
      [['go', 'mod', 'tset'], false, 2, fixture('go-mod-unknown-command.log'), 'go-unknown-command'],
      [['go', 'test', '-run'], false, 2, "flag needs an argument: -run\nusage: go test [build/test flags] [packages] [build/test flags & test binary flags]\nRun 'go help test' and 'go help testflag' for details.\n", 'go-flag'],
      [['go', '-bogus'], false, 2, 'flag provided but not defined: -bogus\nGo is a tool for managing Go source code.\n\nUsage:\n\n\tgo <command> [arguments]\n', 'go-flag'],
      [['cargo', 'tset'], false, 101, fixture('cargo-no-such-command.log'), 'cargo-no-such-command'],
      [['dotnet', 'bin/missing.dll'], false, 1, fixture('dotnet-missing-dll.log'), 'dotnet-no-such-command'],
      [['/usr/local/share/dotnet/dotnet', 'build', 'A.csproj', 'B.csproj'], false, 1, fixture('dotnet-msb1008-one-project.log'), 'msbuild-one-project'],
      // the shell's and env's words for a script of the repository that does not exist yet (sh, bash, dash, zsh, env)
      [['./scripts/check.sh'], false, 127, fixture('env-script-not-found.log'), 'script-not-found'],
      [['./scripts/check.sh --fast'], true, 127, 'bash: line 1: ./scripts/check.sh: No such file or directory\n', 'script-not-found'],
      [['./scripts/check.sh'], true, 127, 'sh: 1: ./scripts/check.sh: not found\n', 'script-not-found'],
      [['./scripts/check.sh'], true, 127, 'zsh:1: no such file or directory: ./scripts/check.sh\n', 'script-not-found'],
    ];
    for (const [command, shell, exit, output, signature] of cases) {
      expect(classifyMisconfigured(input(command, exit, output, { shell }))?.signature, `${command.join(' ')}: ${output}`).toBe(signature);
    }
  });

  it('reads the check\'s own invocation past a leading env assignment, env, an npx-style runner or python -m', () => {
    const cases: [string[], boolean, number, string, string][] = [
      [['CI=1 npm run lint 2>&1'], true, 1, 'npm error Missing script: "lint"\n', 'npm-missing-script'],
      [['env', 'CI=1', 'dotnet', 'build', 'A.csproj', 'B.csproj'], false, 1, fixture('dotnet-msb1008-one-project.log'), 'msbuild-one-project'],
      [['uv', 'run', 'pytest', 'tests/test_new.py'], false, 4, 'ERROR: file or directory not found: tests/test_new.py\n', 'pytest-path-not-found'],
      [['python3', '-m', 'pytest', 'tests/test_new.py'], false, 4, 'ERROR: file or directory not found: tests/test_new.py\n', 'pytest-path-not-found'],
      [['/bin/sh', '-c', 'npm run lint'], false, 1, 'npm error Missing script: "lint"\n', 'npm-missing-script'],
    ];
    for (const [command, shell, exit, output, signature] of cases) {
      expect(classifyMisconfigured(input(command, exit, output, { shell }))?.signature, command.join(' ')).toBe(signature);
    }
  });
});

describe('classifyMisconfigured: only the check\'s own direct invocation of the tool counts', () => {
  it('is null for npm test whose script runs a missing npm run lint: the script is the repository\'s', () => {
    expect(classifyMisconfigured(input(['npm', 'test'], 1, fixture('npm-test-runs-missing-script.log')))).toBeNull();
    expect(classifyMisconfigured(input(['npm', 'run', 'check'], 1, fixture('npm-test-runs-missing-script.log')))).toBeNull();
  });

  it('is null for a script that hands the same script name to a nested npm: npm ran the check\'s script, whose npm found none', () => {
    // npm 11.6: "test": "cd client && npm test", and client/package.json has no test script. npm prints its lifecycle
    // banner ("> acme@1.0.0 test") only for a script it found and ran; a missing script of the check's own never has one.
    expect(classifyMisconfigured(input(['npm', 'test'], 1, fixture('npm-test-delegates-to-missing-script.log')))).toBeNull();
    // npm 11.6: "lint": "npm run lint --prefix web", and web/package.json has no lint script.
    const prefix = '\n> acme@1.0.0 lint\n> npm run lint --prefix web\n\nnpm error Missing script: "lint"\nnpm error\nnpm error Did you mean this?\nnpm error   npm link # Symlink a package folder\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n';
    expect(classifyMisconfigured(input(['npm', 'run', 'lint'], 1, prefix))).toBeNull();
    // A package with no name or version: the banner is the script's name alone.
    expect(classifyMisconfigured(input(['npm', 'test'], 1, '\n> test\n> cd client && npm test\n\nnpm error Missing script: "test"\n'))).toBeNull();
    // The check's own missing script, before any banner: npm checks for it before running a pre-script.
    expect(classifyMisconfigured(input(['npm', 'test'], 1, 'npm error Missing script: "test"\nnpm error\nnpm error To see a list of scripts, run:\nnpm error   npm run\n'))?.signature).toBe('npm-missing-script');
  });

  it('is null for a chain or a pipeline, whichever part printed it', () => {
    expect(classifyMisconfigured(input(['dotnet restore && npm test'], 1, '  Determining projects to restore...\n  All projects are up-to-date for restore.\nnpm error Missing script: "test"\n', { shell: true }))).toBeNull();
    expect(classifyMisconfigured(input(['cd src && dotnet build A.csproj B.csproj'], 1, fixture('dotnet-msb1008-one-project.log'), { shell: true }))).toBeNull();
    expect(classifyMisconfigured(input(['/bin/sh', '-c', 'npm run lint | tee lint.log'], 1, 'npm error Missing script: "lint"\n'))).toBeNull();
    expect(classifyMisconfigured(input(['npm run lint; true'], 1, 'npm error Missing script: "lint"\n', { shell: true }))).toBeNull();
    expect(classifyMisconfigured(input(['true || ./scripts/check.sh'], 127, fixture('sh-script-not-found.log'), { shell: true }))).toBeNull();
  });

  it('is null for dotnet run of a build program that prints MSB1008: the program is the repository\'s', () => {
    expect(classifyMisconfigured(input(['dotnet', 'run', '--project', 'build/Build.csproj'], 1, fixture('dotnet-run-program-msb1008.log')))).toBeNull();
    // A dotnet command that is not MSBuild's, and a known command whose own program printed "not found".
    expect(classifyMisconfigured(input(['dotnet', 'format', '--verify-no-changes'], 1, fixture('dotnet-msb1008-one-project.log')))).toBeNull();
    expect(classifyMisconfigured(input(['dotnet', 'run', '--project', 'build/Build.csproj'], 1, fixture('dotnet-command-not-found.log')))).toBeNull();
  });

  it('is null when what the error names is not what the command names', () => {
    // An argument from the repository's pytest.ini (addopts), not from the check's command.
    expect(classifyMisconfigured(input(['pytest', 'tests'], 4, fixture('pytest-addopts-unrecognized-arguments.log')))).toBeNull();
    expect(classifyMisconfigured(input(['pytest'], 4, 'ERROR: file or directory not found: tests/test_new.py\n'))).toBeNull();
    // A switch MSBuild read from a response file of the repository (Directory.Build.rsp), not from the command.
    expect(classifyMisconfigured(input(['dotnet', 'test'], 1, fixture('dotnet-msb1001-unknown-switch.log')))).toBeNull();
    expect(classifyMisconfigured(input(['dotnet', 'build', 'Other.csproj'], 1, fixture('dotnet-msb1009-project-missing.log')))).toBeNull();
    expect(classifyMisconfigured(input(['go', 'mod', 'tidy'], 2, 'go tset: unknown command\n'))).toBeNull();
    expect(classifyMisconfigured(input(['go', 'build', '-o', 'out'], 2, fixture('go-flag-not-defined.log')))).toBeNull();
    expect(classifyMisconfigured(input(['cargo', 'test'], 1, fixture('cargo-unexpected-argument.log')))).toBeNull();
    expect(classifyMisconfigured(input(['cargo', 'test'], 101, fixture('cargo-plugin-not-installed.log')))).toBeNull();
    // A script the command does not run itself.
    expect(classifyMisconfigured(input(['make', 'test'], 127, fixture('sh-script-not-found.log')))).toBeNull();
  });

  it('is null for a fast exit with no usage-error signature', () => {
    for (const output of ['error: build failed\n', 'Killed\n', '', 'MSBUILD : error MSB4025: The project file could not be loaded.\n']) {
      expect(classifyMisconfigured(input(['dotnet', 'build'], 1, output)), output).toBeNull();
    }
  });

  it('is null for MSBuild\'s internal failure (MSB1025): a crash, not a command line it rejected', () => {
    expect(classifyMisconfigured(input(['dotnet', 'test', 'tests/Acme.Tests/Acme.Tests.csproj'], 1, environment('dotnet-test-msbuild-node-pipe-eacces.log')))).toBeNull();
  });

  it('is null for a program that was not found: that is the environment (classifyProgramNotFound)', () => {
    expect(classifyMisconfigured(input(['dotnett build'], 127, fixture('sh-command-not-found.log'), { shell: true }))).toBeNull();
  });

  it('requires the exit code the tool gives a usage error, where it has one', () => {
    expect(classifyMisconfigured(input(['pytest', '--bogus'], 1, fixture('pytest-unrecognized-arguments.log')))).toBeNull();
    expect(classifyMisconfigured(input(['pytest', 'tests/missing_test.py'], 2, fixture('pytest-path-not-found.log')))).toBeNull();
    expect(classifyMisconfigured(input(['go', 'build', '-bogus'], 1, fixture('go-flag-not-defined.log')))).toBeNull();
    expect(classifyMisconfigured(input(['cargo', 'tset'], 1, fixture('cargo-no-such-command.log')))).toBeNull();
    expect(classifyMisconfigured(input(['./scripts/check.sh'], 1, fixture('sh-script-not-found.log'), { shell: true }))).toBeNull();
  });

  it('is null for a check that did not exit (timed out) or passed', () => {
    expect(classifyMisconfigured(input(['dotnet', 'build', 'A.csproj', 'B.csproj'], null, fixture('dotnet-msb1008-one-project.log')))).toBeNull();
    expect(classifyMisconfigured(input(['dotnet', 'build', 'A.csproj', 'B.csproj'], 0, fixture('dotnet-msb1008-one-project.log')))).toBeNull();
  });

  it('is null for a flag the repository\'s own program rejects: go test passes it to the test binary, cargo run to the program', () => {
    // go test -bogus with test files, as go 1.27 prints it (the flag list cut short): the test binary's usage, not go's.
    const testBinary = 'flag provided but not defined: -bogus\nUsage of /var/folders/acme/T/go-build1505778674/b001/acme.test:\n  -test.bench regexp\n    \trun only benchmarks matching regexp\nexit status 2\nFAIL\texample.com/acme\t0.177s\n';
    expect(classifyMisconfigured(input(['go', 'test', '-bogus', './...'], 1, testBinary))).toBeNull();
    const program = "error: unexpected argument '--bogus' found\n\nUsage: acme [OPTIONS]\n\nFor more information, try '--help'.\n";
    expect(classifyMisconfigured(input(['cargo', 'run', '--', '--bogus'], 1, program))).toBeNull();
  });

  it('is null when the output shows the repository\'s code compiled or tested and failed next to it', () => {
    const tested = `${fixture('dotnet-msb1008-one-project.log')}Failed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4\n`;
    expect(classifyMisconfigured(input(['dotnet', 'build', 'A.csproj', 'B.csproj'], 1, tested))).toBeNull();
    expect(classifyMisconfigured(input(['npm', 'run', 'tset'], 1, `${fixture('npm-missing-script.log')}not ok 1 - sums\n`))).toBeNull();
  });

  it('reads through ANSI colour and keeps each evidence line within 200 characters', () => {
    const name = 't'.repeat(300);
    const f = classifyMisconfigured(input(['npm', 'run', name], 1, `\u001B[31mnpm error Missing script: "${name}"\u001B[39m\n`));
    expect(f?.signature).toBe('npm-missing-script');
    expect(f!.lines[0]).toMatch(/^npm error Missing script: "t+$/);
    expect(f!.lines[0]!.length).toBeLessThanOrEqual(200);
  });
});

describe('classifyProgramNotFound: a program the check runs is not installed where it runs', () => {
  it('reads the shell\'s and env\'s words for a program named by a bare name or an absolute path, with exit 127', () => {
    const cases: [string[], boolean, string][] = [
      [['dotnett build'], true, fixture('sh-command-not-found.log')],
      [['dotnett build'], true, '/bin/sh: 1: dotnett: not found\n'],
      [['dotnett build'], true, 'bash: line 1: dotnett: command not found\n'],
      [['dotnett build'], true, 'zsh:1: command not found: dotnett\n'],
      [['dotnett', 'build'], false, 'env: dotnett: No such file or directory\n'],
      [['dotnett', 'build'], false, '/usr/bin/env: ‘dotnett’: No such file or directory\n'],
      [['/bin/sh', '-c', 'dotnett build'], false, fixture('sh-command-not-found.log')],
      [['/opt/acme/bin/tool build'], true, '/bin/sh: /opt/acme/bin/tool: No such file or directory\n'],
    ];
    for (const [command, shell, output] of cases) {
      const f = classifyProgramNotFound(input(command, 127, output, { shell }));
      expect(f, output).toMatchObject({ checkId: 'build', fingerprint: null, signals: ['program-not-found'] });
      expect(f!.lines).toEqual([output.trim()]);
      expect(f!.cause).toMatch(/^the program "(?:dotnett|\/opt\/acme\/bin\/tool)" was not found where the check runs \(exit 127\)/);
    }
  });

  it('is null for a program the check does not run itself, a script of the repository, another exit code or no direct invocation', () => {
    expect(classifyProgramNotFound(input(['make', 'test'], 127, '/bin/sh: jest: command not found\n'))).toBeNull();
    expect(classifyProgramNotFound(input(['npm test'], 127, 'sh: 1: jest: not found\n', { shell: true }))).toBeNull();
    expect(classifyProgramNotFound(input(['./scripts/check.sh'], 127, fixture('sh-script-not-found.log'), { shell: true }))).toBeNull();
    expect(classifyProgramNotFound(input(['dotnett build'], 1, fixture('sh-command-not-found.log'), { shell: true }))).toBeNull();
    expect(classifyProgramNotFound(input(['true && dotnett build'], 127, fixture('sh-command-not-found.log'), { shell: true }))).toBeNull();
    expect(classifyProgramNotFound(input(['dotnett build'], 127, `${fixture('sh-command-not-found.log')}not ok 1 - builds\n`, { shell: true }))).toBeNull();
  });
});
