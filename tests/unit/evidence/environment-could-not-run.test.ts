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
