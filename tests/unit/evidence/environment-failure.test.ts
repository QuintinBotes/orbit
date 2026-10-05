import { describe, expect, it } from 'vitest';
import { classifyEnvironmentFailure, type EnvironmentFailureInput } from '../../../src/evidence/environment-failure.ts';

const CHECKOUT = '/orbit/runs/acme/worktrees/check-1';
const SAME = 'fp:0123456789abcdef';

/** A failing mandatory check that failed on the base revision with the very same fingerprint, unless a test says otherwise. */
function input(output: string, over: Partial<EnvironmentFailureInput> = {}): EnvironmentFailureInput {
  return { checkId: 'unit', fingerprint: SAME, baselineFingerprint: SAME, output, insideRoots: [CHECKOUT], ...over };
}

const LIVE = 'Error: listen EPERM: operation not permitted 127.0.0.1\n    at Server.setupListenHandle [as _listen2] (node:net:1940:21)\n';

describe('classifyEnvironmentFailure: the live failure', () => {
  it('names the sandbox as the cause of a check that fails like the base revision with "listen EPERM: operation not permitted"', () => {
    const f = classifyEnvironmentFailure(input(LIVE));
    expect(f).not.toBeNull();
    expect(f).toMatchObject({ checkId: 'unit', fingerprint: SAME });
    expect(f!.signals).toEqual(['eperm', 'operation-not-permitted']);
    expect(f!.cause).toMatch(/sandbox/);
    expect(f!.cause).toMatch(/EPERM/);
    expect(f!.lines).toEqual(['Error: listen EPERM: operation not permitted 127.0.0.1']);
  });
});

describe('classifyEnvironmentFailure: only the same failure as the base revision counts', () => {
  it('is null when the fingerprint differs from the baseline one, even with an EPERM line (a new failure is the change\'s)', () => {
    expect(classifyEnvironmentFailure(input(LIVE, { fingerprint: 'fp:ffffffffffffffff' }))).toBeNull();
  });

  it('is null when the check passed on the base revision, or either side has no fingerprint', () => {
    expect(classifyEnvironmentFailure(input(LIVE, { baselineFingerprint: null }))).toBeNull();
    expect(classifyEnvironmentFailure(input(LIVE, { fingerprint: null }))).toBeNull();
    expect(classifyEnvironmentFailure(input(LIVE, { fingerprint: '', baselineFingerprint: '' }))).toBeNull();
  });
});

describe('classifyEnvironmentFailure: a plain code failure keeps the current behaviour', () => {
  it('is null for an assertion failure, a thrown error and a missing module, and for permission words that are not denials', () => {
    for (const output of [
      "AssertionError [ERR_ASSERTION]: expected 3 to equal 4\n    at /orbit/runs/acme/worktrees/check-1/tests/math.test.ts:12:3\n",
      "TypeError: Cannot read properties of undefined (reading 'id')\n",
      "Error: Cannot find module './legacy.mjs'\n",
      'legacy report exporter is broken\n',
      'the user lacks permission to edit this report, as the test expects\n',
      'EPERMISSIVE and TEMPERATURE are not codes\n',
      '',
    ]) {
      expect(classifyEnvironmentFailure(input(output)), output).toBeNull();
    }
  });
});

describe('classifyEnvironmentFailure: signals', () => {
  it('reads "operation not permitted" on its own, in any letter case, through ANSI colour', () => {
    const f = classifyEnvironmentFailure(input('\u001B[31mchmod: /orbit/runs/acme/worktrees/check-1/x: Operation not permitted\u001B[39m\n'));
    expect(f?.signals).toEqual(['operation-not-permitted']);
    expect(f?.cause).toMatch(/not permitted/);
  });

  it('reads a bare EPERM code', () => {
    expect(classifyEnvironmentFailure(input("{ errno: -1, code: 'EPERM', syscall: 'bind' }\n"))?.signals).toEqual(['eperm']);
  });

  it('reads srt violation markers: the violations block, a sandbox deny line, and the proxy refusals', () => {
    const outputs = [
      'npm error\n<sandbox_violations>\ndeny(1) network-bind 127.0.0.1:0\n</sandbox_violations>\n',
      'Sandbox: node(4242) deny(1) network-bind 127.0.0.1:3000\n',
      'HTTP/1.1 403 Forbidden\r\nX-Proxy-Error: blocked-by-allowlist\r\n',
      'Connection blocked by network allowlist\n',
    ];
    for (const output of outputs) {
      const f = classifyEnvironmentFailure(input(output));
      expect(f?.signals, output).toEqual(['sandbox-violation']);
      expect(f?.cause, output).toMatch(/sandbox/);
    }
  });

  it('lists each signal once, in the order first seen, and bounds the evidence lines', () => {
    const noisy = [...Array.from({ length: 6 }, (_, i) => `Error: connect EPERM: operation not permitted 127.0.0.1:${3000 + i}`), 'Error: connect EPERM: operation not permitted 127.0.0.1:3000', `Error: ${'x'.repeat(500)} EPERM`].join('\n');
    const f = classifyEnvironmentFailure(input(`<sandbox_violations>\n${noisy}\n`));
    expect(f?.signals).toEqual(['sandbox-violation', 'eperm', 'operation-not-permitted']);
    expect(f!.lines.length).toBeLessThanOrEqual(3);
    expect(new Set(f!.lines).size).toBe(f!.lines.length);
    expect(f!.lines.every((l) => l.length <= 200)).toBe(true);
  });
});

describe('classifyEnvironmentFailure: EACCES counts only outside the worktree', () => {
  const eacces = (path: string) => `Error: EACCES: permission denied, mkdir '${path}'\n    at Object.mkdirSync (node:fs:1349:3)\n`;

  it('is an environment denial for a path outside the checkout', () => {
    const f = classifyEnvironmentFailure(input(eacces('/Users/acme/.npm/_cacache')));
    expect(f?.signals).toEqual(['eacces-outside-worktree']);
    expect(f?.cause).toMatch(/outside the worktree/);
    expect(f?.lines).toEqual(["Error: EACCES: permission denied, mkdir '/Users/acme/.npm/_cacache'"]);
  });

  it('is a code failure for a path inside the checkout, a relative path, or no path at all', () => {
    expect(classifyEnvironmentFailure(input(eacces(`${CHECKOUT}/build/out.txt`)))).toBeNull();
    expect(classifyEnvironmentFailure(input(eacces(CHECKOUT)))).toBeNull();
    expect(classifyEnvironmentFailure(input('sh: ./scripts/run.sh: Permission denied\n'))).toBeNull();
    expect(classifyEnvironmentFailure(input("code: 'EACCES'\n"))).toBeNull();
  });

  it('treats a sibling directory that merely shares the checkout name as outside', () => {
    expect(classifyEnvironmentFailure(input(eacces(`${CHECKOUT}-other/file`)))?.signals).toEqual(['eacces-outside-worktree']);
  });

  it('honours every inside root given, such as the check\'s own scratch directory', () => {
    const scratch = '/orbit/runs/acme/evidence/1';
    expect(classifyEnvironmentFailure(input(eacces(`${scratch}/unit/home/.cache`), { insideRoots: [CHECKOUT, scratch] }))).toBeNull();
    expect(classifyEnvironmentFailure(input(eacces(`${scratch}/unit/home/.cache`), { insideRoots: [CHECKOUT] }))?.signals).toEqual(['eacces-outside-worktree']);
  });

  it('reads "Permission denied" from the shell the same way as EACCES', () => {
    expect(classifyEnvironmentFailure(input('cp: cannot create regular file \'/usr/local/bin/tool\': Permission denied\n'))?.signals).toEqual(['eacces-outside-worktree']);
  });
});
