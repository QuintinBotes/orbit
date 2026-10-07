import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { baselineBlockReason, baselineEnvironmentBlockReason, baselineEnvironmentFailures, baselineMisconfiguredChecks, checksNotExecutedFor, environmentFix, missingTargetAdvice, missingTargetBlockReason, type BlockedCheck, type MisconfiguredBlock } from '../../../src/controller/environment-block.ts';
import { baselineGate } from '../../../src/controller/gates.ts';
import { frozenPolicyAdvice, frozenPolicyCause } from '../../../src/controller/steps/common.ts';
import type { BaselineReport } from '../../../src/evidence/baseline.ts';
import { finishCheckRun, planCheckRun } from '../../../src/evidence/store.ts';
import { defaultCheck } from '../../../src/policy/config.ts';
import type { EvidenceReport } from '../../../src/evidence/types.ts';
import { addCandidate, addEvidence, BASE_REV, makeUnitLab, setContract, type UnitLab } from './coverage-helpers.ts';

// Issues #10 and #23: how PREFLIGHT classifies a mandatory check that fails on the base revision. An environment
// failure and a misconfigured check both block the run with no baseline-exception question; only a failure of the
// repository's code is a pre-existing failure a person may accept.

const here = dirname(fileURLToPath(import.meta.url));
const misconfigured = (name: string): string => readFileSync(join(here, '../../fixtures/misconfigured', name), 'utf8');
const environment = (name: string): string => readFileSync(join(here, '../../fixtures/environment', name), 'utf8');
const MSB1008 = misconfigured('dotnet-msb1008-one-project.log');
/** The real MSB1025 crash: `dotnet test` of an xunit project referencing two libraries, under Orbit's runner and srt on macOS. */
const MSB1025 = environment('dotnet-test-msbuild-node-pipe-eacces.log');
const COMPILE_ERROR = environment('dotnet-build-compile-error.log');
const FP = 'fp:0123456789abcdef';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

/** A run whose policy defines `checks`, with a baseline report in which each fails with the given output and exit code. */
function baselineWith(checks: Record<string, { command: string[]; shell?: boolean; log: string | null; exit: number | null; excerpt?: string | null; row?: boolean }>): BaselineReport {
  lab = makeUnitLab({
    tweak: (c) => {
      for (const [id, d] of Object.entries(checks)) c.checks[id] = { ...defaultCheck(id), command: d.command, shell: d.shell === true, mandatory: true };
    },
  });
  const ctx = lab.ctx();
  const dir = join(ctx.runDir, 'baseline');
  mkdirSync(dir, { recursive: true });
  const failures: BaselineReport['failures'] = [];
  const entries: BaselineReport['checks'] = [];
  for (const [checkId, d] of Object.entries(checks)) {
    const logPath = join(dir, `${checkId}.log`);
    if (d.log !== null) writeFileSync(logPath, d.log);
    if (d.row !== false) {
      const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: null, checkId, kind: 'command', treeHash: 'b'.repeat(40), checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: d.command, cwd: join(lab.home, 'worktrees', 'baseline'), isolation: 'none', limitations: [] }, lab.clock);
      finishCheckRun(lab.db, row.id, { status: 'FAILED', exitCode: d.exit, timedOut: false, cancelled: false, logPath: d.log === null ? null : logPath, logSha256: null, fingerprint: FP, excerpt: d.excerpt ?? null, artifacts: [], endedAt: lab.clock.now() });
    }
    failures.push({ checkId, fingerprint: FP, excerpt: d.excerpt ?? null });
    entries.push({ checkId, mandatory: true, status: 'FAILED', exitCode: d.exit, flaky: false, fingerprint: FP, excerpt: d.excerpt ?? null, log: logPath });
  }
  return { schema: 'orbit.baseline/1', runId: lab.runId, baseRevision: BASE_REV, baseTree: 'b'.repeat(40), policyHash: ctx.run.policyHash, checkIds: Object.keys(checks), install: { skipped: true, reason: null, ok: false }, checks: entries, failures, complete: true, recordedAt: lab.clock.now() };
}

describe('baselineMisconfiguredChecks: what PREFLIGHT reads from the baseline records', () => {
  it('finds the check whose tool rejected its command, with the error line, the config key and the log; a compile error stays the code\'s', () => {
    const report = baselineWith({
      build: { command: ['dotnet', 'build', 'A.csproj', 'B.csproj'], log: MSB1008, exit: 1 },
      compile: { command: ['dotnet', 'build'], log: COMPILE_ERROR, exit: 1 },
    });
    expect(baselineMisconfiguredChecks(lab.ctx(), report)).toEqual([
      expect.objectContaining({
        checkId: 'build',
        signature: 'msbuild-one-project',
        configKey: 'checks.build.command',
        lines: ['MSBUILD : error MSB1008: Only one project can be specified.', 'Switch: B.csproj'],
        logPath: join(lab.ctx().runDir, 'baseline', 'build.log'),
      }),
    ]);
  });

  it('judges the command the frozen policy gives the check: the same output under a command that runs another tool is not the tool\'s usage error', () => {
    const report = baselineWith({ build: { command: ['npm', 'run', 'build'], log: MSB1008, exit: 1 } });
    expect(baselineMisconfiguredChecks(lab.ctx(), report)).toEqual([]);
  });

  it('marks each with its kind: an argument error, or a missing target the goal may create', () => {
    const report = baselineWith({
      build: { command: ['dotnet', 'build', 'A.csproj', 'B.csproj'], log: MSB1008, exit: 1 },
      lint: { command: ['npm', 'run', 'lint'], log: 'npm error Missing script: "lint"\n', exit: 1 },
      // A shell command is read as one script.
      unit: { command: ['pytest tests/test_new.py 2>&1'], shell: true, log: 'ERROR: file or directory not found: tests/test_new.py\n', exit: 4 },
    });
    expect(baselineMisconfiguredChecks(lab.ctx(), report).map((m) => [m.checkId, m.kind, m.signature])).toEqual([
      ['build', 'argument', 'msbuild-one-project'],
      ['lint', 'missing-target', 'npm-missing-script'],
      ['unit', 'missing-target', 'pytest-path-not-found'],
    ]);
  });

  it('reads the excerpt when the log is gone, and the report\'s exit code when there is no recorded run', () => {
    const gone = baselineWith({ build: { command: ['dotnet', 'build', 'A.csproj', 'B.csproj'], log: null, exit: 1, excerpt: 'MSBUILD : error MSB1008: Only one project can be specified.' } });
    expect(baselineMisconfiguredChecks(lab.ctx(), gone).map((m) => m.signature)).toEqual(['msbuild-one-project']);
    lab.cleanup();
    const norow = baselineWith({ unit: { command: ['pytest', '--bogus'], log: misconfigured('pytest-unrecognized-arguments.log'), exit: 4, row: false } });
    expect(baselineMisconfiguredChecks(lab.ctx(), norow).map((m) => [m.checkId, m.signature])).toEqual([['unit', 'pytest-unrecognized-arguments']]);
  });

  it('needs the tool\'s usage-error exit code: the same text with another exit code is left alone', () => {
    const report = baselineWith({ unit: { command: ['pytest', '--bogus'], log: misconfigured('pytest-unrecognized-arguments.log'), exit: 1 } });
    expect(baselineMisconfiguredChecks(lab.ctx(), report)).toEqual([]);
  });
});

const msb1008: MisconfiguredBlock = {
  checkId: 'build',
  kind: 'argument',
  signature: 'msbuild-one-project',
  tool: 'dotnet (MSBuild)',
  cause: "dotnet (MSBuild) rejected the check's command line: it names more than one project, and MSBuild builds one project or solution per command",
  lines: ['MSBUILD : error MSB1008: Only one project can be specified.', 'Switch: B.csproj'],
  configKey: 'checks.build.command',
  logPath: '/orbit/runs/acme/baseline/build.log',
};

const socket: BlockedCheck = {
  checkId: 'test',
  fingerprint: null,
  signals: ['socket-denied'],
  cause: 'the sandbox or the operating system refused the tool a socket (permission denied) in its own startup, before it ran anything of the repository',
  lines: ['MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.', 'System.Net.Sockets.SocketException (13): Permission denied'],
  questionId: null,
  logPath: '/orbit/runs/acme/baseline/test.log',
};

/** Every sentence of a reason starts with a capital letter. */
function expectCapitalSentences(reason: string): void {
  for (const sentence of reason.split(/(?<=[a-z0-9)"\]])\. (?=\S)/)) expect(sentence, sentence).toMatch(/^[A-Z]/);
}

describe('baselineBlockReason', () => {
  it('names a misconfigured check, the classification, the first error line, the config key and the log, and offers no exception', () => {
    const reason = baselineBlockReason({ runId: 'orb-1', baseRevision: BASE_REV, environment: [], misconfigured: [msb1008] });
    expect(reason).toMatch(/^Check build is misconfigured, not a pre-existing failure: on the base revision aaaaaaaaaaaa /);
    expect(reason).toContain('"MSBUILD : error MSB1008: Only one project can be specified."');
    expect(reason).toContain('"Switch: B.csproj"');
    expect(reason).toContain('command in checks.build.command');
    expect(reason).toContain('output in /orbit/runs/acme/baseline/build.log');
    expect(reason).toMatch(/\. It is not recorded as a pre-existing failure and no baseline exception is offered: a check whose command is wrong never tested anything/);
    expect(reason).toMatch(/\. Fix: correct checks\.build\.command in \.orbit\/config\.yaml so that it runs as written from the check's cwd in a clean checkout of the base revision, and start a new run\.$/);
    expect(reason).not.toMatch(/install the program/);
    expect(reason).not.toMatch(/orbit decide/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    expectCapitalSentences(reason);
    // The check definition is in the run's frozen policy: the frozen-policy advice is added when the run blocks.
    expect(frozenPolicyCause(reason)).toBe('checks.build.command');
  });

  it('names both classifications when one check is misconfigured and another could not run, each with its own fix', () => {
    const reason = baselineBlockReason({ runId: 'orb-2', baseRevision: BASE_REV, environment: [socket], misconfigured: [msb1008, { ...msb1008, checkId: 'lint', configKey: 'checks.lint.command', logPath: '/orbit/runs/acme/baseline/lint.log' }] });
    expect(reason).toMatch(/^Checks build, lint are misconfigured, not a pre-existing failure/);
    // The two share their error lines: named once, then the evidence once, then both config keys and both logs.
    expect(reason.match(/MSB1008/g)).toHaveLength(1);
    expect(reason).toContain('commands in checks.build.command, checks.lint.command, output in /orbit/runs/acme/baseline/build.log, /orbit/runs/acme/baseline/lint.log');
    expect(reason).toMatch(/\. Check test could not run on the base revision either, and the output shows an environment cause: /);
    expect(reason).toContain('"MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.", "System.Net.Sockets.SocketException (13): Permission denied"');
    expect(reason).toMatch(/\. Fix for it: this is MSBuild starting a worker node/);
    expect(reason).toMatch(/\. Fix: correct checks\.build\.command, checks\.lint\.command in \.orbit\/config\.yaml so that each runs as written/);
    expect(frozenPolicyCause(reason)).toBe('checks.build.command, checks.lint.command');
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    expectCapitalSentences(reason);
  });

  it('is the environment reason when nothing is misconfigured, and that reason quotes every evidence line', () => {
    const reason = baselineBlockReason({ runId: 'orb-3', baseRevision: BASE_REV, environment: [socket], misconfigured: [] });
    expect(reason).toBe(baselineEnvironmentBlockReason({ runId: 'orb-3', baseRevision: BASE_REV, failures: [socket] }));
    expect(reason).toMatch(/^Check test could not run on the base revision aaaaaaaaaaaa, and the output shows an environment cause, not a pre-existing failure/);
    expect(reason).toContain('"System.Net.Sockets.SocketException (13): Permission denied"');
    expect(frozenPolicyCause(reason)).toBeNull();
    expectCapitalSentences(reason);
  });

  it('issue #10: three checks with the same crash name the checks once and the shared evidence once, each log after it', () => {
    const three = ['build', 'test', 'format'].map((checkId) => ({ ...socket, checkId, logPath: `/orbit/runs/acme/baseline/${checkId}.log` }));
    const reason = baselineEnvironmentBlockReason({ runId: 'orb-4', baseRevision: BASE_REV, failures: three });
    expect(reason).toMatch(/^Checks build, test, format could not run on the base revision aaaaaaaaaaaa, and the output shows an environment cause, not a pre-existing failure: the sandbox or the operating system refused the tool a socket/);
    expect(reason.match(/MSB1025/g)).toHaveLength(1);
    expect(reason.match(/SocketException \(13\)/g)).toHaveLength(1);
    expect(reason).toContain('output in /orbit/runs/acme/baseline/build.log, /orbit/runs/acme/baseline/test.log, /orbit/runs/acme/baseline/format.log');
    expect(reason).toMatch(/\. They are not recorded as a pre-existing failure/);
    expect(reason).toMatch(/\. Then orbit resume orb-4 runs the baseline again/);
    expectCapitalSentences(reason);
  });
});

describe('missingTargetBlockReason: a missing target the contract does not expect to flip', () => {
  const lint: MisconfiguredBlock = { checkId: 'lint', kind: 'missing-target', signature: 'npm-missing-script', tool: 'npm', cause: "npm could not find what the check's command names: package.json has no script of that name", lines: ['npm error Missing script: "lint"'], configKey: 'checks.lint.command', logPath: '/orbit/runs/acme/baseline/lint.log' };

  it('is a misconfigured check, and says why the goal is not expected to create it; the advice is its own (missingTargetAdvice)', () => {
    const reason = missingTargetBlockReason({ baseRevision: BASE_REV, checks: [lint] });
    expect(reason).toMatch(/^Check lint is misconfigured, not a pre-existing failure: on the base revision aaaaaaaaaaaa the check's command names something that does not exist, and the contract does not name it as the proof of any criterion, so the goal is not expected to create it: npm could not find/);
    expect(reason).toContain('("npm error Missing script: \\"lint\\""), command in checks.lint.command, output in /orbit/runs/acme/baseline/lint.log');
    expect(reason).toMatch(/no baseline exception is offered: a check whose target does not exist tests nothing, so accepting its failure would make a meaningless check green\.$/);
    // The command is in the run's frozen policy: finishRun records the setting from this start. The advice is added apart from it.
    expect(frozenPolicyCause(reason)).toBe('checks.lint.command');
    expect(reason).not.toMatch(/Fix:|start a new run/);
    expect(reason).not.toMatch(/[\u2013\u2014]/);
    expectCapitalSentences(reason);
  });
});

describe('missingTargetAdvice: what to do about a missing target the contract does not name', () => {
  const block = (checkId: string): MisconfiguredBlock => ({ checkId, kind: 'missing-target', signature: 'cargo-no-such-command', tool: 'cargo', cause: 'cargo has no such command', lines: ['error: no such command: `nextest`'], configKey: `checks.${checkId}.command` });

  it('names every way out and says a new run is needed, never resume --force: this block is read from the recorded baseline', () => {
    const advice = missingTargetAdvice({ runId: 'orb-5', checks: [block('lint')] });
    // A goal meant to create the target says so, in a new run, so that the contract names the check and expects it to flip.
    expect(advice).toContain('when the goal is meant to create what the command names, say so in the goal of a new run, so that the contract names the check as the proof of a criterion and expects it to flip');
    // A target a tool that is not installed or restored yet provides needs a new run once it is.
    expect(advice).toContain('when a tool that is not installed or restored yet provides it (a cargo plugin, a dotnet local tool, a pytest plugin), install or restore it and then start a new run, because this run reads the baseline it recorded and does not look again');
    // A wrong command is the config's.
    expect(advice).toContain('when the command is wrong, correct checks.lint.command in .orbit/config.yaml and start a new run');
    expect(advice).toContain('orbit cancel orb-5');
    expect(advice).not.toMatch(/--force/);
    expect(advice).not.toMatch(/orbit resume/);
    // Not the generic advice of a frozen-policy block, which sends a person to fix the config.
    expect(advice).not.toMatch(/This comes from the run's frozen policy|Fix the config/);
    expect(advice).not.toMatch(/[\u2013\u2014]/);
    expectCapitalSentences(`${missingTargetBlockReason({ baseRevision: BASE_REV, checks: [block('lint')] })} ${advice}`);
  });

  it('names the commands of every check when several name something that does not exist', () => {
    const advice = missingTargetAdvice({ runId: 'orb-5', checks: [block('lint'), block('fmt')] });
    expect(advice).toContain('when the commands are wrong, correct checks.lint.command, checks.fmt.command in .orbit/config.yaml and start a new run');
    expect(advice).toContain('what a command names');
    expect(advice).not.toMatch(/--force/);
  });
});

describe('the frozen-policy advice for a misconfigured check', () => {
  it('names a new run and not orbit resume --force, which runs the same check again from the same policy and baseline', () => {
    const check = frozenPolicyAdvice('orb-6', 'checks.lint.command');
    expect(check).toMatch(/^This comes from the run's frozen policy \(checks\.lint\.command\)/);
    expect(check).toContain('orbit cancel orb-6');
    expect(check).not.toMatch(/--force/);
    expect(frozenPolicyAdvice('orb-6', 'checks.build.command, checks.lint.command')).not.toMatch(/--force/);
    // A setting a fix outside the policy can satisfy keeps the way to resume.
    expect(frozenPolicyAdvice('orb-6', 'providers.codex.model (or a refreshed model catalog: orbit models refresh)')).toContain('orbit resume orb-6 --force');
  });
});

describe('baselineGate names a classified failure for what it is', () => {
  it('calls a misconfigured check or an environment failure not a pre-existing failure, and the rest pre-existing', () => {
    const report = baselineWith({ build: { command: ['dotnet', 'build'], log: MSB1008, exit: 1 }, test: { command: ['dotnet', 'test'], log: COMPILE_ERROR, exit: 1 }, lint: { command: ['npm', 'run', 'lint'], log: 'src/a.ts:1:1: error: unused\n', exit: 1 }, docs: { command: ['npm', 'run', 'docs'], log: 'npm error Missing script: "docs"\n', exit: 1 } });
    const marks: Record<string, 'misconfigured' | 'environment' | 'missing-target'> = { build: 'misconfigured', test: 'environment', docs: 'missing-target' };
    const failures = report.failures.map((f) => (marks[f.checkId] ? { ...f, classification: marks[f.checkId] } : f));
    expect(baselineGate({ ...report, failures }).notes).toEqual([
      `misconfigured check on the base revision, not a pre-existing failure: build (${FP})`,
      `environment failure on the base revision, not a pre-existing failure: test (${FP})`,
      `pre-existing failure on the base revision: lint (${FP})`,
      `missing target on the base revision (expected to flip if the contract names the check, otherwise misconfigured), not a pre-existing failure: docs (${FP})`,
    ]);
  });
});

describe('environmentFix for a refused socket, network connection or NuGet client, and a program not found', () => {
  it('names MSBuild\'s worker node and the verified fix, -m:1 on the check\'s dotnet command, and nothing unverified', () => {
    const fix = environmentFix([socket])!;
    expect(fix).toMatch(/MSBuild starting a worker node, whose named pipe \.NET makes a Unix socket under \/tmp/);
    expect(fix).toMatch(/-m:1 on the check's dotnet command \(for example \[dotnet, test, -m:1\]\)/);
    expect(fix).not.toMatch(/nodeReuse|UseSharedCompilation|MSBUILDDISABLENODEREUSE|DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER|DOTNET_PROCESSOR_COUNT|build server|compiler server/);
  });

  it('gives -m:1 only to a dotnet command that hands its arguments to MSBuild: dotnet format reads it as a project and fails', () => {
    const format = environmentFix([{ ...socket, checkId: 'format', command: { argv: ['dotnet', 'format', '--verify-no-changes'], shell: false } }])!;
    expect(format).not.toMatch(/-m:1 on the check's dotnet command/);
    expect(format).toMatch(/dotnet format \(check format\) takes no -m:1/);
    // The check's own command in the form that loads no project, as doctor and the runner name it (ADR 0009, addendum).
    expect(format).toContain('checks.format.command: ["dotnet", "format", "whitespace", "--folder", "--verify-no-changes"]');
    const test = environmentFix([{ ...socket, command: { argv: ['dotnet', 'test', 'tests/Acme.Tests/Acme.Tests.csproj'], shell: false } }])!;
    expect(test).toMatch(/-m:1 on the check's dotnet command \(for example \[dotnet, test, -m:1\]\)/);
    expect(test).not.toMatch(/dotnet format/);
    // Issue #10's three checks: each fix once, naming the checks it is for.
    const three = environmentFix([
      { ...socket, checkId: 'build', command: { argv: ['dotnet', 'build'], shell: false } },
      { ...socket, checkId: 'test', command: { argv: ['dotnet test -m:2'], shell: true } },
      { ...socket, checkId: 'format', command: { argv: ['dotnet', 'format', '--verify-no-changes'], shell: false } },
    ])!;
    expect(three).toMatch(/^for checks build, test: this is MSBuild starting a worker node/);
    expect(three).toMatch(/; and dotnet format \(check format\) takes no -m:1/);
    expect(three.match(/-m:1 on the check's dotnet command/g)).toHaveLength(1);
  });

  it('names the network allowlist for a refused connection, the NIS rule and the filled NuGet cache for NuGet, and the PATH for a program not found', () => {
    expect(environmentFix([{ ...socket, signals: ['network-denied'], lines: ['curl: (56) CONNECT tunnel failed, response 403'] }])).toMatch(/network_hosts/);
    // ADR 0009, addendum: Orbit lets .NET read the NIS domain name with the srt it ships, and on macOS the repository's
    // NuGet cache is filled outside the sandbox with doctor's command, from which the install and the checks restore.
    const nuget = environmentFix([{ ...socket, signals: ['nuget-http-denied'] }])!;
    expect(nuget).toMatch(/^NuGet's HTTP client could not start because it may not read the machine's NIS domain name/);
    expect(nuget).toContain('orbit doctor prints (checks.dotnet-packages)');
    expect(nuget).not.toMatch(/\[dotnet, restore\]/);
    const missing = environmentFix([{ ...socket, checkId: 'build', signals: ['program-not-found'], lines: ['/bin/sh: dotnett: command not found'] }])!;
    expect(missing).toMatch(/^install the program where the check runs, or give the check a PATH that holds it/);
    expect(missing).toContain('correct checks.build.command in .orbit/config.yaml, which needs a new run');
    expect(environmentFix([{ ...socket, signals: ['permission-denied'], lines: ["Error: EACCES: permission denied, mkdir '/usr/local/var/acme'"] }])).toMatch(/^run orbit doctor/);
  });
});

describe('baselineEnvironmentFailures: the real MSB1025 crash', () => {
  it('reads it as a socket refused in the tool\'s own crash, with its first error line and one denial line', () => {
    const report = baselineWith({ test: { command: ['dotnet', 'test', 'tests/Acme.Tests/Acme.Tests.csproj'], log: MSB1025, exit: 1 } });
    expect(baselineMisconfiguredChecks(lab.ctx(), report)).toEqual([]);
    expect(baselineEnvironmentFailures(lab.ctx(), report, join(lab.home, 'worktrees', 'baseline'))).toEqual([
      expect.objectContaining({ checkId: 'test', signals: ['socket-denied'], lines: ['MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.', 'System.Net.Sockets.SocketException (13): Permission denied'] }),
    ]);
  });
});

describe('baselineEnvironmentFailures: a failing .NET test that reports a denial', () => {
  it('is a pre-existing failure on the base revision: Microsoft.Testing.Platform reports a failing test (MSTest 4.4.1, EACCES on /etc/sudoers)', () => {
    const report = baselineWith({ test: { command: ['dotnet', 'run', '--project', 'tests/Acme.Tests'], log: environment('dotnet-mstest-runner-eacces.log'), exit: 2 } });
    expect(baselineMisconfiguredChecks(lab.ctx(), report)).toEqual([]);
    expect(baselineEnvironmentFailures(lab.ctx(), report, join(lab.home, 'worktrees', 'baseline'))).toEqual([]);
  });
});

describe('baselineEnvironmentFailures: a program that is not installed where the check runs', () => {
  it('is an environment failure (exit 127, the command\'s own program), not a misconfigured check', () => {
    const report = baselineWith({ build: { command: ['dotnett build'], shell: true, log: misconfigured('sh-command-not-found.log'), exit: 127 } });
    expect(baselineMisconfiguredChecks(lab.ctx(), report)).toEqual([]);
    expect(baselineEnvironmentFailures(lab.ctx(), report, join(lab.home, 'worktrees', 'baseline'))).toEqual([
      expect.objectContaining({ checkId: 'build', signals: ['program-not-found'], lines: ['/bin/sh: dotnett: command not found'], questionId: null }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// A candidate's denial goes to repair unless the base revision showed the same one (ADR 0010)

const UNITTEST = environment('python-unittest-permission-error.log');
const NUGET_PROXY = environment('dotnet-build-nuget-proxy-403.log');
const CAND_FP = 'fp:fedcba9876543210';

/** A run with a baseline record and one candidate on which mandatory `unit` failed with `log`. */
function candidateWith(log: string, base: BaselineReport['failures']): { cand: ReturnType<typeof addCandidate>; report: EvidenceReport } {
  lab = makeUnitLab();
  setContract(lab);
  const ctx = lab.ctx();
  writeFileSync(join(ctx.runDir, 'baseline.json'), JSON.stringify({ schema: 'orbit.baseline/1', runId: lab.runId, baseRevision: BASE_REV, complete: true, checks: [], failures: base }));
  const cand = addCandidate(lab);
  const dir = join(ctx.runDir, 'evidence', String(cand.seq));
  mkdirSync(dir, { recursive: true });
  const logPath = join(dir, 'unit.log');
  writeFileSync(logPath, log);
  const row = planCheckRun(lab.db, { runId: lab.runId, candidateId: cand.id, checkId: 'unit', kind: 'command', treeHash: cand.treeHash, checkConfigHash: 'h', policyHash: ctx.run.policyHash, command: ['node'], cwd: join(lab.home, 'check-1'), isolation: 'none', limitations: [] }, lab.clock);
  finishCheckRun(lab.db, row.id, { status: 'FAILED', exitCode: 1, timedOut: false, cancelled: false, logPath, logSha256: null, fingerprint: CAND_FP, excerpt: null, artifacts: [], endedAt: lab.clock.now() });
  const report = addEvidence(lab, cand, { verdict: 'FAIL', checks: [{ id: 'unit', status: 'FAILED', exit_code: 1, flaky: false, log: 'unit.log' }] }).report;
  return { cand, report };
}

describe('checksNotExecutedFor: a denial the change introduced goes to repair', () => {
  it('a Python unittest that errors with PermissionError on a candidate is a failing test: repair', () => {
    const { cand, report } = candidateWith(UNITTEST, []);
    expect(checksNotExecutedFor(lab.ctx(), cand, report)).toEqual([]);
  });

  it('the same denial outside a test runner, on a candidate whose base revision passed: repair', () => {
    const { cand, report } = candidateWith("Traceback (most recent call last):\n  File \"tools/check.py\", line 3, in <module>\nPermissionError: [Errno 13] Permission denied: '/etc/acme/secret.conf'\n", []);
    expect(checksNotExecutedFor(lab.ctx(), cand, report)).toEqual([]);
  });

  it('a build that starts fetching from a denied host after passing on the base revision: repair', () => {
    const { cand, report } = candidateWith(NUGET_PROXY, []);
    expect(checksNotExecutedFor(lab.ctx(), cand, report)).toEqual([]);
  });

  it('counts a denial the base revision showed with the same classification, and only that one', () => {
    const same = candidateWith(NUGET_PROXY, [{ checkId: 'unit', fingerprint: FP, excerpt: null, classification: 'environment', signals: ['network-denied'] }]);
    expect(checksNotExecutedFor(lab.ctx(), same.cand, same.report)).toEqual([expect.objectContaining({ checkId: 'unit', signals: ['network-denied'] })]);
    lab.cleanup();
    // A pre-existing failure of the code on the base revision, or another signal, is not the same classification.
    const code = candidateWith(NUGET_PROXY, [{ checkId: 'unit', fingerprint: FP, excerpt: null }]);
    expect(checksNotExecutedFor(lab.ctx(), code.cand, code.report)).toEqual([]);
    lab.cleanup();
    const other = candidateWith(NUGET_PROXY, [{ checkId: 'unit', fingerprint: FP, excerpt: null, classification: 'environment', signals: ['permission-denied'] }]);
    expect(checksNotExecutedFor(lab.ctx(), other.cand, other.report)).toEqual([]);
  });

  it('a .NET test the change brings that writes outside the checkout is a failing test: repair (Microsoft.Testing.Platform, xunit v3)', () => {
    for (const name of ['dotnet-mstest-runner-eperm.log', 'dotnet-xunit-v3-eperm.log', 'dotnet-xunit-v3-mtp-eperm.log']) {
      const { cand, report } = candidateWith(environment(name), []);
      expect(checksNotExecutedFor(lab.ctx(), cand, report), name).toEqual([]);
      lab.cleanup();
    }
  });

  it('a refused .NET named pipe the runner recorded follows the same rule: repair unless the base revision showed it (ADR 0009, addendum)', () => {
    // The runner stopped the check for an MSBuild node the sandbox refused; the base revision started none.
    const stopped = environment('dotnet-format-restore-node-denied.log');
    const fresh = candidateWith(stopped, []);
    expect(checksNotExecutedFor(lab.ctx(), fresh.cand, fresh.report)).toEqual([]);
    lab.cleanup();
    const host = candidateWith(environment('dotnet-format-build-host-timeout.log'), [{ checkId: 'unit', fingerprint: FP, excerpt: null }]);
    expect(checksNotExecutedFor(lab.ctx(), host.cand, host.report)).toEqual([]);
    lab.cleanup();
    const same = candidateWith(stopped, [{ checkId: 'unit', fingerprint: FP, excerpt: null, classification: 'environment', signals: ['pipe-denied'] }]);
    expect(checksNotExecutedFor(lab.ctx(), same.cand, same.report)).toEqual([expect.objectContaining({ checkId: 'unit', signals: ['pipe-denied'] })]);
  });

  it('keeps the denials that predate ADR 0010 on a candidate as before', () => {
    const { cand, report } = candidateWith("Error: EPERM: operation not permitted, mkdir '/usr/local/var/acme'\n", []);
    expect(checksNotExecutedFor(lab.ctx(), cand, report)).toEqual([expect.objectContaining({ checkId: 'unit', signals: ['filesystem-denied'] })]);
  });
});
