import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classifyCouldNotRun } from '../../../src/evidence/environment-failure.ts';

// A check the environment refused before it ran anything of the repository (issue #10).

/**
 * Captured from Orbit's runner under the real srt check profile on macOS (tests/fixtures/environment), with the
 * machine's temp directory replaced by a neutral one: `dotnet build` on a minimal console project before the fix (the
 * SDK's first-run NuGet migrations ask for a named mutex under /tmp/.dotnet, without and with that directory on the
 * host), `dotnet build` on a missing semicolon, and `node --test` on a failing assertion.
 */
const fixture = (name: string): string => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', name), 'utf8');
const EPERM_CRASH = fixture('dotnet-build-eperm.log');
const EPERM_CRASH_SHM = fixture('dotnet-build-eperm-shm.log');
const COMPILE_ERROR = fixture('dotnet-build-compile-error.log');
const TEST_FAILURE = fixture('node-test-failure.log');
const CHECKOUT = '/private/var/folders/acme/T/orbit-evidence-acme/checkout';
const ROOTS = [CHECKOUT, '/orbit/runs/acme/baseline/build'];
const DENIAL = "Error: EPERM: operation not permitted, mkdir '/Users/acme/.cache/acme'\n";

describe('classifyCouldNotRun: the captured dotnet crash', () => {
  it('names the sandbox refusing a filesystem call outside the checkout, with the error line that shows it', () => {
    for (const [output, call] of [
      [EPERM_CRASH, 'mkdtemp("/tmp/.coreclr.'],
      [EPERM_CRASH_SHM, 'mkdir("/tmp/.dotnet/shm/session'],
    ] as const) {
      const f = classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS });
      expect(f, call).toMatchObject({ checkId: 'build', fingerprint: null, signals: ['filesystem-denied'] });
      expect(f!.cause).toMatch(/refused a filesystem operation outside the check's checkout/);
      expect(f!.lines).toHaveLength(1);
      expect(f!.lines[0]).toContain(call);
      // The line is longer than an evidence line; it is cut around the denial, so the errno it names stays in view.
      expect(f!.lines[0]).toMatch(/errno == EPERM;$/);
      expect(f!.lines[0]!.length).toBeLessThanOrEqual(200);
    }
  });
});

describe('classifyCouldNotRun: a real compile or test failure is never hidden', () => {
  it('is null for the captured compile error and the captured failing test', () => {
    expect(classifyCouldNotRun({ checkId: 'build', output: COMPILE_ERROR, insideRoots: ROOTS })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'unit', output: TEST_FAILURE, insideRoots: ROOTS })).toBeNull();
  });

  it('is null when a denial sits next to a compile error or a failing test: the code did run, and failed', () => {
    expect(classifyCouldNotRun({ checkId: 'build', output: `${COMPILE_ERROR}${DENIAL}`, insideRoots: ROOTS })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'unit', output: `${DENIAL}${TEST_FAILURE}`, insideRoots: ROOTS })).toBeNull();
    for (const report of [
      'Tests: 1 failed, 4 passed',
      'FAIL src/sum.test.ts',
      '--- FAIL: TestSum (0.00s)',
      'not ok 1 - sums',
      'FAILED tests/test_sum.py::test_sum - assert 3 == 4',
      'test result: FAILED. 0 passed; 1 failed',
      'Failed!  - Failed:     1, Passed:     3',
      "src/a.c:3:1: error: expected ';'",
      'error[E0425]: cannot find value `x` in this scope',
      "src/a.ts(3,1): error TS2304: Cannot find name 'x'.",
      "SyntaxError: Unexpected token '}'",
      'Found 2 errors in the same file',
      '    1 Error(s)',
      '2 failing',
    ]) {
      expect(classifyCouldNotRun({ checkId: 'unit', output: `${DENIAL}${report}\n`, insideRoots: ROOTS }), report).toBeNull();
    }
  });

  it('is null for a denial inside the checkout or the check\'s own directories, or with no path or no filesystem call', () => {
    for (const output of [
      `Error: EPERM: operation not permitted, chmod '${CHECKOUT}/bin/tool'\n`,
      'mkdir: /orbit/runs/acme/baseline/build/home/.cache: Operation not permitted\n',
      'Error: listen EPERM: operation not permitted 127.0.0.1\n',
      "{ errno: -1, code: 'EPERM', syscall: 'kill' }\n",
      'EPERM /Users/acme/notes.txt\n',
      '',
    ]) {
      expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS }), output).toBeNull();
    }
  });
});

describe('classifyCouldNotRun: other denials it reads', () => {
  it('reads node, Python and shell tools refusing a path outside the checkout', () => {
    for (const output of [`${DENIAL}    at Object.mkdirSync (node:fs:1372:26)\n`, "PermissionError: [Errno 1] Operation not permitted: '/Users/acme/Library/Caches/acme'\n", 'touch: /usr/local/var/acme.lock: Operation not permitted\n']) {
      expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS })?.signals, output).toEqual(['filesystem-denied']);
    }
  });

  it('reads a write refused on Linux, where srt mounts everything outside the writable paths read-only (EROFS)', () => {
    for (const output of [
      // GNU coreutils under the C.UTF-8 locale a check gets on Linux, as srt left it in `orbit doctor`'s probe.
      "mkdir: cannot create directory ‘/tmp/orbit-denied-acme/cache’: Read-only file system\n",
      "Error: EROFS: read-only file system, mkdir '/home/acme/.cache/acme'\n",
      "OSError: [Errno 30] Read-only file system: '/home/acme/.cache/acme'\n",
    ]) {
      const f = classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS });
      expect(f?.signals, output).toEqual(['filesystem-denied']);
      expect(f!.cause).toContain('EROFS');
      expect(f!.lines).toEqual([output.trim()]);
    }
  });

  it('is null for a read-only denial inside the checkout, curly quotes and all, or next to a compile error', () => {
    for (const output of [
      `mkdir: cannot create directory ‘${CHECKOUT}’: Read-only file system\n`,
      `touch: cannot touch ‘${CHECKOUT}/.git/hooks/pre-commit’: Read-only file system\n`,
      `mkdir: cannot create directory ‘/home/acme/.cache’: Read-only file system\n${COMPILE_ERROR}`,
    ]) {
      expect(classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS }), output).toBeNull();
    }
  });

  it('reads Seatbelt deny lines: a file operation only on an absolute path outside the checkout, any other operation as it is', () => {
    const deny = (op: string, path: string) => `Sandbox: dotnet(4242) deny(1) ${op} ${path}\n`;
    expect(classifyCouldNotRun({ checkId: 'build', output: deny('file-write-create', '/private/tmp/.dotnet'), insideRoots: ROOTS })).toMatchObject({ signals: ['sandbox-violation'], lines: ['Sandbox: dotnet(4242) deny(1) file-write-create /private/tmp/.dotnet'] });
    expect(classifyCouldNotRun({ checkId: 'build', output: '<sandbox_violations>\ndeny(1) file-write-unlink /etc/acme\n</sandbox_violations>\n', insideRoots: ROOTS })?.signals).toEqual(['sandbox-violation']);
    expect(classifyCouldNotRun({ checkId: 'build', output: deny('mach-lookup', 'com.apple.securityd'), insideRoots: ROOTS })?.signals).toEqual(['sandbox-violation']);
    expect(classifyCouldNotRun({ checkId: 'build', output: deny('file-write-create', `${CHECKOUT}/.git/hooks/pre-commit`), insideRoots: ROOTS })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'build', output: deny('file-read-data', 'relative/path'), insideRoots: ROOTS })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'build', output: 'Sandbox: dotnet(4242) deny(1) file-read-data\n', insideRoots: ROOTS })).toBeNull();
  });

  it('lists both signals once, and keeps at most three distinct lines, through ANSI colour', () => {
    const line = (i: number) => `\u001B[31mmkdir: /var/acme/${i}: Operation not permitted\u001B[39m`;
    const f = classifyCouldNotRun({ checkId: 'unit', output: ['Sandbox: sh(1) deny(1) file-write-create /var/acme/1', line(1), line(1), line(2), line(3)].join('\n'), insideRoots: ROOTS });
    expect(f?.signals).toEqual(['sandbox-violation', 'filesystem-denied']);
    expect(f?.lines).toEqual(['Sandbox: sh(1) deny(1) file-write-create /var/acme/1', 'mkdir: /var/acme/1: Operation not permitted', 'mkdir: /var/acme/2: Operation not permitted']);
  });

  it('cuts a long line from its start when the denial is near the start', () => {
    const f = classifyCouldNotRun({ checkId: 'unit', output: `mkdir: /var/acme: Operation not permitted ${'x'.repeat(400)}\n`, insideRoots: ROOTS });
    expect(f?.lines[0]).toMatch(/^mkdir: \/var\/acme: Operation not permitted x+$/);
    expect(f?.lines[0]).toHaveLength(200);
  });
});

/**
 * Named pipes .NET binds under /tmp, which no check sandbox may use (ADR 0009, addendum). Captured through Orbit's runner
 * under srt 0.0.78, with the machine's temp directory and the SDK's path replaced by neutral ones:
 * - `dotnet format --verify-no-changes` on macOS with SDK 9.0.305: MSBuildWorkspace's build host binds its pipe at
 *   /tmp/<guid> (Seatbelt denied file-write-create of /tmp/<guid>), and the format waited out the build host's
 *   60 s connect timeout;
 * - the same with SDK 10.0.401 on Linux (bubblewrap): srt's seccomp filter refused the socket and it failed at once;
 * - `dotnet format` of a project with two project references on macOS: its implicit restore started an MSBuild worker
 *   node, which the sandbox refused its pipe, and the runner stopped the check and wrote why on the log's last line.
 */
describe('classifyCouldNotRun: a .NET named pipe the sandbox refused under /tmp', () => {
  const BUILD_HOST_MACOS = fixture('dotnet-format-build-host-timeout.log');
  const BUILD_HOST_LINUX = fixture('dotnet-format-build-host-linux.log');
  const RESTORE_NODE = fixture('dotnet-format-restore-node-denied.log');
  const FORMAT_ROOTS = ['/var/folders/acme/T/orbit-evidence-acme/checkout', '/orbit/runs/acme/baseline/format'];

  it('reads dotnet format\'s build host that could not be reached, by the timeout on macOS and the refused socket on Linux', () => {
    for (const [output, line] of [
      [BUILD_HOST_MACOS, 'Unhandled exception: System.TimeoutException: The operation has timed out.'],
      [BUILD_HOST_LINUX, "Unhandled exception: System.Exception: The build host was started but we were unable to connect to it's pipe. The process exited with 137. Process output:"],
    ] as const) {
      const f = classifyCouldNotRun({ checkId: 'format', output, insideRoots: FORMAT_ROOTS });
      expect(f, line).toMatchObject({ checkId: 'format', fingerprint: null, signals: ['pipe-denied'], lines: [line] });
      expect(f!.cause).toMatch(/^the sandbox refused a \.NET process the named pipe it binds under \/tmp \(an MSBuild worker node, or the build host dotnet format loads the project with\)/);
    }
  });

  it('reads the runner\'s record of a check it stopped for an MSBuild worker node the sandbox refused, on the log\'s last line only', () => {
    const f = classifyCouldNotRun({ checkId: 'format', output: RESTORE_NODE, insideRoots: FORMAT_ROOTS });
    expect(f).toMatchObject({ signals: ['pipe-denied'] });
    expect(f!.lines[0]).toMatch(/^the check sandbox denied MSBuild node \(pid 4242\) its named pipe \/tmp\/MSBuild4242 \(System\.Net\.Sockets\.SocketException \(13\): Permission denied\)/);
    expect(f!.lines[0]!.length).toBeLessThanOrEqual(200);
    // Only the runner writes the last line of a check's log; the same words printed by the check itself are its own
    // output, and never the runner's record. (Inside dotnet format's own crash they still name a refused socket, which
    // ADR 0010 reads as socket-denied whoever printed it, gated on a candidate the same way.)
    const [last, ...rest] = RESTORE_NODE.trimEnd().split('\n').reverse();
    const forged = classifyCouldNotRun({ checkId: 'format', output: `${[...rest.reverse(), last].join('\n')}\n[orbit] check=format status=FAILED exit=1\n`, insideRoots: FORMAT_ROOTS });
    expect(forged?.signals).toEqual(['socket-denied']);
    expect(classifyCouldNotRun({ checkId: 'format', output: `${last}\n[orbit] check=format status=FAILED exit=1\n`, insideRoots: FORMAT_ROOTS })).toBeNull();
  });

  it('reads a refused pipe once: the SocketException of the same crash is that pipe, not a second signal', () => {
    // dotnet test's own MSB1025 report of the node the runner then recorded (MSBuild fails at once on Linux).
    const msb1025 = fixture('dotnet-test-msbuild-node-pipe-eacces.log').replace(/\[orbit\] check=test status=FAILED exit=1\n?$/, '');
    const note = RESTORE_NODE.trimEnd().split('\n').at(-1)!.replace('check=fmt', 'check=test');
    const f = classifyCouldNotRun({ checkId: 'test', output: `${msb1025}${note}\n`, insideRoots: FORMAT_ROOTS });
    expect(f?.signals).toEqual(['pipe-denied']);
    expect(f?.lines).toHaveLength(1);
    expect(f!.lines[0]).toMatch(/^the check sandbox denied MSBuild node \(pid 4242\)/);
    expect(classifyCouldNotRun({ checkId: 'format', output: BUILD_HOST_LINUX, insideRoots: FORMAT_ROOTS })?.signals).toEqual(['pipe-denied']);
  });

  it('on a candidate, counts a refused pipe only when the same check showed one on the base revision (ADR 0010): one the change brought goes to repair', () => {
    for (const output of [BUILD_HOST_MACOS, BUILD_HOST_LINUX, RESTORE_NODE]) {
      expect(classifyCouldNotRun({ checkId: 'format', output, insideRoots: FORMAT_ROOTS, baseSignals: [] })).toBeNull();
      expect(classifyCouldNotRun({ checkId: 'format', output, insideRoots: FORMAT_ROOTS, baseSignals: ['filesystem-denied'] })).toBeNull();
      expect(classifyCouldNotRun({ checkId: 'format', output, insideRoots: FORMAT_ROOTS, baseSignals: ['pipe-denied'] })?.signals).toEqual(['pipe-denied']);
    }
    // The base revision saw the same refused pipe as socket-denied (dotnet test's MSB1025, or a log without the runner's
    // note): the candidate's record of it is that socket too.
    expect(classifyCouldNotRun({ checkId: 'format', output: BUILD_HOST_LINUX, insideRoots: FORMAT_ROOTS, baseSignals: ['socket-denied'] })?.signals).toEqual(['socket-denied']);
    expect(classifyCouldNotRun({ checkId: 'format', output: BUILD_HOST_MACOS, insideRoots: FORMAT_ROOTS, baseSignals: ['socket-denied'] })).toBeNull();
  });

  it('is null when the code was compiled or tested and failed, whatever the pipes did', () => {
    expect(classifyCouldNotRun({ checkId: 'format', output: `${COMPILE_ERROR}${BUILD_HOST_MACOS}`, insideRoots: FORMAT_ROOTS })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'format', output: `${TEST_FAILURE}${RESTORE_NODE}`, insideRoots: FORMAT_ROOTS })).toBeNull();
    // A timeout of anything else is not the build host's pipe.
    expect(classifyCouldNotRun({ checkId: 'unit', output: 'Unhandled exception: System.TimeoutException: The operation has timed out.\n   at Acme.Client.Fetch()\n', insideRoots: FORMAT_ROOTS })).toBeNull();
  });
});
