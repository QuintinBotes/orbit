import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DOTNET_FORMAT_REASON, dotnetFormatFix, FORMAT_OUTSIDE_REASON, formatLoadsProject, formatOutsideFix, formatReadsFolder, formatRestoreFix, formatRestoresUnpinned, nodeDenialFix, sdkFormatsInProcess } from '../../../src/evidence/dotnet-format.ts';
import { msbuildFix, msbuildFixReason, type JudgedCheck } from '../../../src/evidence/msbuild.ts';

// dotnet format under the check sandbox (issue #10; ADR 0009, addendum). Every form but `dotnet format whitespace
// --folder` loads the project through MSBuildWorkspace's build host, a separate process whose named pipe Roslyn binds at
// /tmp/<guid> whatever TMPDIR says (measured under srt: Seatbelt denied file-write-create of /tmp/<guid> with SDK
// 9.0.305 on macOS, and the check failed after the build host's 60 s connect timeout; srt's seccomp filter refused the
// socket with SDK 10.0.401 on Linux, at once).

const argv = (...command: string[]): JudgedCheck => ({ command, shell: false });
const line = (text: string): JudgedCheck => ({ command: [text], shell: true });

describe('formatLoadsProject', () => {
  it('finds dotnet format in every form that loads the project, as the check writes it', () => {
    for (const [check, shown] of [
      [argv('dotnet', 'format', '--verify-no-changes'), 'dotnet format --verify-no-changes'],
      [argv('/opt/dotnet/dotnet', 'format', 'src/Acme.sln', '--verify-no-changes', '--no-restore'), 'dotnet format src/Acme.sln --verify-no-changes --no-restore'],
      [argv('dotnet', 'format', 'style', '--verify-no-changes'), 'dotnet format style --verify-no-changes'],
      [argv('dotnet', 'format', 'analyzers', '--verify-no-changes', '--severity', 'warn'), 'dotnet format analyzers --verify-no-changes --severity warn'],
      // whitespace without --folder loads the project too.
      [argv('dotnet', 'format', 'whitespace', '--verify-no-changes'), 'dotnet format whitespace --verify-no-changes'],
      [argv('env', 'DOTNET_ROLL_FORWARD=Major', 'dotnet', 'format', '--verify-no-changes'), 'dotnet format --verify-no-changes'],
      [line('dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore'), 'dotnet format --verify-no-changes --no-restore'],
      [argv('sh', '-c', 'cd src && dotnet format --verify-no-changes'), 'dotnet format --verify-no-changes'],
      // A shell line doctor cannot split into commands: its words still show dotnet format.
      [line('dotnet format --verify-no-changes 2>&1 | tee format.log'), 'dotnet format'],
    ] as const) {
      expect(formatLoadsProject(check), JSON.stringify(check.command)).toEqual({ shown });
    }
  });

  it('is null for whitespace --folder, which reads the files without loading the project, and for what loads nothing', () => {
    for (const check of [
      argv('dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes'),
      argv('dotnet', 'format', 'whitespace', 'src', '--folder', '--verify-no-changes', '--include', 'src/Acme/'),
      line('cd src && dotnet format whitespace --folder --verify-no-changes'),
      argv('dotnet', 'format', '--version'),
      argv('dotnet', 'format', '--help'),
      argv('dotnet', 'build', '-m:1'),
      argv('dotnet', 'test', 'tests/Format.Tests', '-m:1'),
      // What make or a script runs is not in the definition; the runner still records its failure as the sandbox's.
      argv('make', 'format'),
      argv('npm', 'run', 'format'),
      line('prettier --check . && eslint .'),
    ]) {
      expect(formatLoadsProject(check), JSON.stringify(check.command)).toBeNull();
    }
  });
});

describe('dotnetFormatFix', () => {
  it('gives an argv check whitespace --folder, ready to paste, keeping its program and what env sets', () => {
    expect(dotnetFormatFix({ id: 'format', ...argv('dotnet', 'format', '--verify-no-changes') })).toBe('checks.format.command: ["dotnet", "format", "whitespace", "--folder", "--verify-no-changes"]');
    expect(dotnetFormatFix({ id: 'lint', ...argv('/opt/dotnet/dotnet', 'format', 'src/Acme.sln', 'style', '--verify-no-changes') })).toBe('checks.lint.command: ["/opt/dotnet/dotnet", "format", "whitespace", "src", "--folder", "--verify-no-changes"]');
    expect(dotnetFormatFix({ id: 'format', ...argv('env', 'DOTNET_ROLL_FORWARD=Major', 'dotnet', 'format') })).toBe('checks.format.command: ["env", "DOTNET_ROLL_FORWARD=Major", "dotnet", "format", "whitespace", "--folder", "--verify-no-changes"]');
  });

  // Review: the fix dropped the check's workspace and its --include and --exclude, so the pasted check covered other
  // files. whitespace --folder takes a folder and both options (measured: --exclude is read from that folder).
  it('keeps the files the check formats: its workspace\'s folder, --include, --exclude and --include-generated, and how it reports', () => {
    expect(dotnetFormatFix({ id: 'format', ...argv('dotnet', 'format', 'src/Acme.sln', '--verify-no-changes', '--exclude', 'gen') })).toBe('checks.format.command: ["dotnet", "format", "whitespace", "src", "--folder", "--verify-no-changes", "--exclude", "gen"]');
    expect(
      dotnetFormatFix({ id: 'style', ...argv('dotnet', 'format', 'style', 'src/Acme/Acme.csproj', '--severity', 'warn', '--include', 'A.cs', 'B.cs', '--diagnostics', 'IDE0005', 'IDE0055', '--include-generated', '-v', 'diag', '--report', 'out', '--no-restore') }),
    ).toBe('checks.style.command: ["dotnet", "format", "whitespace", "src/Acme", "--folder", "--verify-no-changes", "--include", "A.cs", "B.cs", "--include-generated", "-v", "diag", "--report", "out"]');
    // A folder stays a folder; a solution in the check's directory is that directory.
    expect(dotnetFormatFix({ id: 'format', ...argv('dotnet', 'format', 'whitespace', 'apps', '--verify-no-changes') })).toBe('checks.format.command: ["dotnet", "format", "whitespace", "apps", "--folder", "--verify-no-changes"]');
    expect(dotnetFormatFix({ id: 'format', ...line('cd src && dotnet format Acme.sln --verify-no-changes --exclude gen') })).toBe('checks.format.command: ["cd src && dotnet format whitespace --folder --verify-no-changes --exclude gen"]');
  });

  it('rewrites the dotnet format command of a chain in place, and names it for a line it cannot rewrite', () => {
    expect(dotnetFormatFix({ id: 'format', ...line('dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore') })).toBe('checks.format.command: ["dotnet restore -m:1 && dotnet format whitespace --folder --verify-no-changes"]');
    expect(dotnetFormatFix({ id: 'format', ...argv('sh', '-c', 'cd src && dotnet format --verify-no-changes') })).toBe('checks.format.command: ["sh", "-c", "cd src && dotnet format whitespace --folder --verify-no-changes"]');
    expect(dotnetFormatFix({ id: 'format', ...line('dotnet format --verify-no-changes 2>&1 | tee format.log') })).toBe('in checks.format.command, run "dotnet format whitespace --folder --verify-no-changes" in place of its dotnet format command');
  });

  it('says why once: the build host\'s pipe under /tmp, what whitespace --folder checks, and where the rest belongs', () => {
    expect(DOTNET_FORMAT_REASON).toMatch(/^\(dotnet format loads the project through a build host, a separate process whose named pipe \.NET binds under \/tmp, which the check sandbox refuses/);
    expect(DOTNET_FORMAT_REASON).toContain('whitespace only');
    expect(DOTNET_FORMAT_REASON).toContain('in CI');
    expect(DOTNET_FORMAT_REASON).toContain('docs/troubleshooting.md, "dotnet format under the sandbox"');
    expect(DOTNET_FORMAT_REASON).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('nodeDenialFix', () => {
  it('gives a dotnet format check whose implicit restore was refused a worker node the format fix, not -m:1, which format cannot pass on', () => {
    const fix = nodeDenialFix({ id: 'format', ...argv('dotnet', 'format', 'tests/Acme.Tests/Acme.Tests.csproj', '--verify-no-changes') }, null);
    expect(fix).toBe(`checks.format.command: ["dotnet", "format", "whitespace", "tests/Acme.Tests", "--folder", "--verify-no-changes"] ${DOTNET_FORMAT_REASON}`);
  });

  // Review: a chain that builds without -m:1 and runs a dotnet format that loads the project got only -m:1, so the
  // pasted command was refused again for the format.
  it('fixes both in one command when a check builds without -m:1 and runs a dotnet format that loads the project, with both reasons', () => {
    const fix = nodeDenialFix({ id: 'ci', ...line('dotnet build && dotnet format --verify-no-changes --no-restore') }, null);
    expect(fix.startsWith('checks.ci.command: ["dotnet build -m:1 && dotnet format whitespace --folder --verify-no-changes"] (MSBuild worker nodes cannot run in the check sandbox')).toBe(true);
    expect(fix.endsWith(` ${DOTNET_FORMAT_REASON}`)).toBe(true);
  });

  it('keeps the -m:1 fix for every other check', () => {
    expect(nodeDenialFix({ id: 'build', ...argv('dotnet', 'build') }, null)).toMatch(/^checks\.build\.command: \["dotnet", "build", "-m:1"\] \(MSBuild worker nodes/);
    expect(nodeDenialFix({ id: 'ci', ...line('dotnet build && dotnet format whitespace --folder --verify-no-changes') }, null)).toMatch(/^checks\.ci\.command: \["dotnet build -m:1 && dotnet format whitespace --folder --verify-no-changes"\] \(MSBuild worker nodes[^]*"\.NET builds and MSBuild worker nodes"\)$/);
  });

  it('with SDK 8, which formats in its own process, restores with -m:1 first and formats with --no-restore', () => {
    const check = { id: 'format', ...argv('dotnet', 'format', 'tests/Acme.Tests/Acme.Tests.csproj', '--verify-no-changes') };
    expect(nodeDenialFix(check, null, true)).toBe(`${formatRestoreFix(check, null).change} ${msbuildFixReason([formatRestoreFix(check, null)])}`);
    // A run's layout on macOS changes nothing for SDK 8: its pinned restore first passed in such a run.
    expect(nodeDenialFix(check, null, true, false)).toBe(nodeDenialFix(check, null, true));
  });

  // Review: the folder form the note named died in every real run on macOS, listing <orbit home>/worktrees/<key>/<run>.
  it('where the folder form cannot list the folders above the checkout, names running dotnet format outside Orbit, and -m:1 for the check\'s builds', () => {
    const format = { id: 'format', ...argv('dotnet', 'format', 'tests/Acme.Tests/Acme.Tests.csproj', '--verify-no-changes') };
    expect(nodeDenialFix(format, null, false, false)).toBe(`${formatOutsideFix(format)} ${FORMAT_OUTSIDE_REASON}`);
    const ci = { id: 'ci', ...line('dotnet build && dotnet format --verify-no-changes --no-restore') };
    const nodes = msbuildFix(ci, null);
    expect(nodeDenialFix(ci, null, false, false)).toBe(`${nodes.change} ${msbuildFixReason([nodes])}; ${formatOutsideFix(ci)} ${FORMAT_OUTSIDE_REASON}`);
    expect(nodes.change).toBe('checks.ci.command: ["dotnet build -m:1 && dotnet format --verify-no-changes --no-restore"]');
    expect(FORMAT_OUTSIDE_REASON).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('formatReadsFolder', () => {
  it('finds dotnet format whitespace --folder, which lists the folders above the one it formats, and nothing else', () => {
    expect(formatReadsFolder(argv('dotnet', 'format', 'whitespace', 'src', '--folder', '--verify-no-changes'))).toEqual({ shown: 'dotnet format whitespace src --folder --verify-no-changes' });
    expect(formatReadsFolder(line('dotnet build -m:1 && dotnet format whitespace --folder --verify-no-changes'))).toEqual({ shown: 'dotnet format whitespace --folder --verify-no-changes' });
    for (const check of [argv('dotnet', 'format', '--verify-no-changes'), argv('dotnet', 'format', 'whitespace', '--folder', '--help'), argv('dotnet', 'build', '-m:1')]) {
      expect(formatReadsFolder(check), JSON.stringify(check)).toBeNull();
    }
  });
});

// SDK 8.0.303 (pinned by global.json) evaluates the project in dotnet format's own process: no build host. Measured under
// srt through the runner on macOS: `dotnet format <project>` of a project with two references failed in about a second,
// its implicit restore refused an MSBuild worker node; `dotnet restore <project> -m:1 && dotnet format <project>
// --verify-no-changes --no-restore` passed, and so did the plain form with DOTNET_PROCESSOR_COUNT=1 in its env.
describe('dotnet format with SDK 8', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const repo = (globalJson: string | null, at = '') => {
    const d = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-format-sdk-')));
    dirs.push(d);
    mkdirSync(join(d, 'src', 'Acme'), { recursive: true });
    if (globalJson !== null) writeFileSync(join(d, at, 'global.json'), globalJson);
    return d;
  };

  it('reads the SDK global.json pins, from the check\'s directory up to the repository', () => {
    expect(sdkFormatsInProcess(repo('{"sdk":{"version":"8.0.303"}}'), repo(null))).toBe(false);
    const r8 = repo('{ "sdk": { "version": "8.0.303", "rollForward": "latestFeature" } }');
    expect(sdkFormatsInProcess(r8, r8)).toBe(true);
    expect(sdkFormatsInProcess(join(r8, 'src', 'Acme'), r8)).toBe(true);
    const commented = repo('// pinned for CI\n{\n  "sdk": { /* LTS */ "version": "8.0.100" }\n}\n');
    expect(sdkFormatsInProcess(commented, commented)).toBe(true);
    for (const text of ['{"sdk":{"version":"9.0.305"}}', '{"sdk":{"version":"8.0.303","rollForward":"latestMajor"}}', '{"sdk":{"version":"8.0.303","rollForward":"major"}}', '{"msbuild-sdks":{}}', 'not json']) {
      const r = repo(text);
      expect(sdkFormatsInProcess(r, r), text).toBe(false);
    }
    expect(sdkFormatsInProcess(repo(null), repo(null))).toBe(false);
    // The nearest global.json decides, and none above the repository is read.
    const nested = repo('{"sdk":{"version":"9.0.305"}}');
    writeFileSync(join(nested, 'src', 'global.json'), '{"sdk":{"version":"8.0.303"}}');
    expect(sdkFormatsInProcess(join(nested, 'src', 'Acme'), nested)).toBe(true);
    expect(sdkFormatsInProcess(nested, nested)).toBe(false);
  });

  it('finds a dotnet format that loads the project and restores first, unless --no-restore or one processor', () => {
    expect(formatRestoresUnpinned(argv('dotnet', 'format', '--verify-no-changes'))).toEqual({ shown: 'dotnet format --verify-no-changes' });
    expect(formatRestoresUnpinned(line('dotnet build -m:1 && dotnet format style --verify-no-changes'))).toEqual({ shown: 'dotnet format style --verify-no-changes' });
    for (const check of [
      argv('dotnet', 'format', '--verify-no-changes', '--no-restore'),
      { ...argv('dotnet', 'format', '--verify-no-changes'), env: { DOTNET_PROCESSOR_COUNT: '1' } },
      argv('dotnet', 'format', 'whitespace', '--folder', '--verify-no-changes'),
      line('dotnet restore -m:1 && dotnet format --verify-no-changes --no-restore'),
      argv('dotnet', 'build', '-m:1'),
    ]) {
      expect(formatRestoresUnpinned(check), JSON.stringify(check)).toBeNull();
    }
  });

  it('fixes it with a pinned restore of the same workspace first and --no-restore, a shell line for an argv, the chain in place', () => {
    expect(formatRestoreFix({ id: 'format', ...argv('dotnet', 'format', 'tests/Acme.Tests/Acme.Tests.csproj', '--verify-no-changes') }, null)).toEqual({
      change:
        'checks.format.command: ["dotnet restore tests/Acme.Tests/Acme.Tests.csproj -m:1 && dotnet format tests/Acme.Tests/Acme.Tests.csproj --verify-no-changes --no-restore"] with checks.format.shell: true (dotnet format passes no -m:1 to the restore it runs first, so restore with -m:1 first and format with --no-restore)',
      env: 'checks.format.env',
    });
    expect(formatRestoreFix({ id: 'ci', ...line('dotnet build && dotnet format style --verify-no-changes') }, null).change).toBe(
      'checks.ci.command: ["dotnet build -m:1 && dotnet restore -m:1 && dotnet format style --verify-no-changes --no-restore"] (dotnet format passes no -m:1 to the restore it runs first, so restore with -m:1 first and format with --no-restore)',
    );
    expect(formatRestoreFix({ id: 'format', ...argv('/opt/my dotnet/dotnet', 'format') }, null).change).toMatch(/^checks\.format\.command: \["'\/opt\/my dotnet\/dotnet' restore -m:1 && '\/opt\/my dotnet\/dotnet' format --no-restore"\] with checks\.format\.shell: true /);
  });
});
