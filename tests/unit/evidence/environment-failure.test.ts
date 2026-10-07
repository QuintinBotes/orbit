import { describe, expect, it } from 'vitest';
import { classifyEnvironmentFailure, classifyNotExecuted, type EnvironmentFailureInput } from '../../../src/evidence/environment-failure.ts';

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

// ---------------------------------------------------------------------------
// A check that could not execute at all

// What the demo app's log held in the first live run (UI app started under srt): only node's crash report and srt's note.
const LIVE_ABORT = [
  '----- Native stack trace -----',
  '',
  ' 1: 0x106eb9cf4 node::InitializeOncePerProcessInternal(std::__1::vector<std::__1::basic_string<char>> const&, node::ProcessInitializationFlags::Flags) (.cold.11) [/opt/acme/bin/node]',
  ' 2: 0x1050acb40 node::InitializeOncePerProcessInternal(std::__1::vector<std::__1::basic_string<char>> const&, node::ProcessInitializationFlags::Flags) [/opt/acme/bin/node]',
  ' 3: 0x1050ad720 node::Start(int, char**) [/opt/acme/bin/node]',
  ' 4: 0x192ee3e80 start [/usr/lib/dyld]',
  'Process killed by signal: SIGABRT',
  '',
].join('\n');

describe('classifyNotExecuted: the live crash', () => {
  it('names a process that died of SIGABRT with nothing but its crash report as an environment cause, with the signal line first and where node was', () => {
    const f = classifyNotExecuted({ checkId: 'ui', output: LIVE_ABORT });
    expect(f).toMatchObject({ checkId: 'ui', fingerprint: null, signals: ['process-aborted'] });
    expect(f!.cause).toMatch(/killed by a fatal signal before it printed anything of its own \(SIGABRT\)/);
    expect(f!.lines).toEqual(['Process killed by signal: SIGABRT', expect.stringMatching(/^1: 0x106eb9cf4 node::InitializeOncePerProcessInternal/)]);
  });

  it('reads the signal from the runner when the log has no srt line, and from the check log footer', () => {
    expect(classifyNotExecuted({ checkId: 'unit', output: '', signal: 'SIGSEGV' })?.cause).toMatch(/\(SIGSEGV\)/);
    const footer = '[orbit] check=unit status=FAILED exit=SIGABRT\n';
    expect(classifyNotExecuted({ checkId: 'unit', output: footer })?.cause).toMatch(/\(SIGABRT\)/);
    // The runner's footer is never the program's own output, so a crash report plus the footer is still a crash before anything ran.
    expect(classifyNotExecuted({ checkId: 'unit', output: `${LIVE_ABORT}[orbit] check=unit status=FAILED exit=1\n` })?.signals).toEqual(['process-aborted']);
  });

  // Review: a check that printed a footer of its own, "[orbit] check=x status=FAILED exit=SIGSEGV", read as a crash
  // before anything ran, which is not gated on a candidate. The runner writes its footer as the log's last line.
  it('reads only the log\'s last line as the runner\'s footer: a footer the check printed is its own output', () => {
    const forged = '[orbit] check=unit status=FAILED exit=SIGSEGV\n[orbit] check=unit status=FAILED exit=1\n';
    expect(classifyNotExecuted({ checkId: 'unit', output: forged })).toBeNull();
    expect(classifyNotExecuted({ checkId: 'unit', output: '[orbit] check=unit status=FAILED exit=SIGSEGV\n\n' })?.cause).toMatch(/\(SIGSEGV\)/);
  });

  it('accepts node\'s own report of process.abort(), which adds a JavaScript section, and a report with no signal named at all', () => {
    const out = ['----- Native stack trace -----', '', ' 1: 0x104a2eeac node::Abort(v8::FunctionCallbackInfo<v8::Value> const&) [/opt/acme/bin/node]', '----- JavaScript stack trace -----', '', '1: file:///app/main.mjs:3:9', '2: run (node:internal/modules/esm/module_job:343:25)', ''].join('\n');
    const f = classifyNotExecuted({ checkId: 'ui', output: out });
    expect(f?.signals).toEqual(['process-aborted']);
    expect(f?.cause).toBe('the process was killed by a fatal signal before it printed anything of its own');
  });

  it('accepts a native frame node cannot name, which is a bare address once the line is trimmed (the Linux x64 runner prints one)', () => {
    const out = ['----- Native stack trace -----', '', ' 1: 0x1052410  [/usr/local/bin/node]', ' 2: 0x7f3a1c2e4b50 ', '', '----- JavaScript stack trace -----', '', '1: file:///app/main.mjs:1:9', ''].join('\n');
    expect(classifyNotExecuted({ checkId: 'unit', output: out })?.signals).toEqual(['process-aborted']);
  });

  it('reads the colour codes out of the log', () => {
    expect(classifyNotExecuted({ checkId: 'ui', output: `\u001B[31mProcess killed by signal: SIGBUS\u001B[39m\n` })?.signals).toEqual(['process-aborted']);
  });
});

describe('classifyNotExecuted: a process that ran keeps the normal path', () => {
  it('is null for an application that threw while loading, a failing assertion, a segfault after test output, and an empty log', () => {
    for (const output of [
      "SyntaxError: Unexpected token '}'\n    at ModuleLoader.moduleStrategy (node:internal/modules/esm/translators:152:18)\n",
      'AssertionError [ERR_ASSERTION]: expected 3 to equal 4\n',
      '12 tests passed\n----- Native stack trace -----\n 1: 0x1 addon::crash() [x]\nProcess killed by signal: SIGSEGV\n',
      '',
    ]) {
      expect(classifyNotExecuted({ checkId: 'ui', output }), output).toBeNull();
    }
  });

  it('is null for signals that come from a deadline, a person, the memory watchdog or a configured limit', () => {
    for (const signal of ['SIGKILL', 'SIGTERM', 'SIGINT', 'SIGXCPU', 'SIGXFSZ']) {
      expect(classifyNotExecuted({ checkId: 'unit', output: '', signal }), signal).toBeNull();
      expect(classifyNotExecuted({ checkId: 'unit', output: `Process killed by signal: ${signal}\n` }), signal).toBeNull();
      expect(classifyNotExecuted({ checkId: 'unit', output: `[orbit] check=unit status=FAILED exit=${signal}\n` }), signal).toBeNull();
    }
  });
});

describe('classifyNotExecuted: a check the runner could not start', () => {
  it('names it as an environment cause, with the runner\'s own words', () => {
    const f = classifyNotExecuted({ checkId: 'unit', output: '', startFailure: 'could not start the check: spawn npx ENOENT' });
    expect(f).toMatchObject({ checkId: 'unit', fingerprint: null, signals: ['start-failed'], cause: 'the check could not be started', lines: ['could not start the check: spawn npx ENOENT'] });
  });

  it('ignores a blank note', () => {
    expect(classifyNotExecuted({ checkId: 'unit', output: '', startFailure: '  ' })).toBeNull();
  });
});

describe('classifyNotExecuted: a browser the sandbox stopped', () => {
  it('names the runner\'s finding as an environment cause even when the log holds the run\'s own output', () => {
    const f = classifyNotExecuted({ checkId: 'ui', output: 'Running 8 tests using 2 workers\n8 failed', browserIsolation: 'Chromium could not register its Mach rendezvous service: bootstrap_check_in ...' });
    expect(f).toEqual({ checkId: 'ui', fingerprint: null, signals: ['browser-isolation'], cause: 'the browser could not start under sandbox-runtime', lines: ['Chromium could not register its Mach rendezvous service: bootstrap_check_in ...'] });
  });

  it('ignores a blank finding', () => {
    expect(classifyNotExecuted({ checkId: 'ui', output: '8 failed', browserIsolation: ' ' })).toBeNull();
  });
});
