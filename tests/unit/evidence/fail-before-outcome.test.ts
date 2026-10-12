// Fail-before outcomes (ADR 0014 section 3): one outcome per probed check, judged over every attempt. failed-before needs
// every attempt FAILED, at least two, with no ADR 0010 environment signal; passed-before needs every attempt PASSED;
// anything else is not established, and an environment, ERROR or install cause is never offered for acceptance.
import { describe, expect, it } from 'vitest';
import { acceptableCause, CLASSIFIER_LINES, judgeProbeAttempts, probeSignals, scanProbeLog, type ProbeAttempt } from '../../../src/evidence/fail-before.ts';

const attempt = (n: number, status: ProbeAttempt['status'], over: Partial<ProbeAttempt> = {}): ProbeAttempt => ({ attempt: n, status, exitCode: status === 'PASSED' ? 0 : status === 'FAILED' ? 1 : null, signals: [], log: `evidence/2/fail-before/unit${n === 1 ? '' : `~${n - 1}`}.log`, ...over });

describe('judgeProbeAttempts', () => {
  it('failed-before: two FAILED attempts and no environment signal', () => {
    const j = judgeProbeAttempts('unit', [attempt(1, 'FAILED'), attempt(2, 'FAILED')]);
    expect(j.outcome).toBe('failed-before');
    expect(j.cause).toBeUndefined();
    expect(j.reason).toBe('unit failed on the base revision with the new tests (exit 1, 2 attempts)');
  });

  it('one FAILED attempt is not enough: a failure is repeated before it counts', () => {
    const j = judgeProbeAttempts('unit', [attempt(1, 'FAILED')]);
    expect(j).toMatchObject({ outcome: 'not-established', cause: 'once' });
  });

  it('passed-before: every attempt PASSED', () => {
    expect(judgeProbeAttempts('unit', [attempt(1, 'PASSED')])).toMatchObject({ outcome: 'passed-before', reason: 'unit passed on the base revision with the new tests' });
  });

  it('a mixed result is not established', () => {
    const j = judgeProbeAttempts('unit', [attempt(1, 'FAILED'), attempt(2, 'PASSED')]);
    expect(j.outcome).toBe('not-established');
    expect(j.cause).toBe('mixed');
    expect(j.reason).toMatch(/FAILED, then PASSED/);
    expect(acceptableCause(j.cause!)).toBe(true);
  });

  it('an environment signal on any attempt is not established, and never offered for acceptance', () => {
    const j = judgeProbeAttempts('unit', [attempt(1, 'FAILED', { signals: ['socket-denied'] }), attempt(2, 'FAILED')]);
    expect(j).toMatchObject({ outcome: 'not-established', cause: 'environment' });
    expect(j.reason).toMatch(/socket-denied/);
    expect(acceptableCause('environment')).toBe(false);
  });

  it('a TIMEOUT is not established, and may be accepted by a person', () => {
    const j = judgeProbeAttempts('unit', [attempt(1, 'TIMEOUT')]);
    expect(j).toMatchObject({ outcome: 'not-established', cause: 'timeout' });
    expect(acceptableCause('timeout')).toBe(true);
  });

  it('an ERROR or a CANCELLED attempt is not established; an ERROR is never accepted', () => {
    expect(judgeProbeAttempts('unit', [attempt(1, 'ERROR')])).toMatchObject({ outcome: 'not-established', cause: 'error' });
    expect(acceptableCause('error')).toBe(false);
    expect(acceptableCause('install')).toBe(false);
    expect(judgeProbeAttempts('unit', [attempt(1, 'FAILED'), attempt(2, 'CANCELLED')])).toMatchObject({ outcome: 'not-established', cause: 'cancelled' });
  });

  it('no attempt at all is not established', () => {
    expect(judgeProbeAttempts('unit', [])).toMatchObject({ outcome: 'not-established' });
  });
});

describe('probeSignals: ADR 0010 environment signals, BASE_GATED_SIGNALS ungated', () => {
  it('reads a refused socket in the tool\'s own crash, which a candidate reads only when the base showed it', () => {
    const log = ['MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.', 'System.Net.Sockets.SocketException (13): Permission denied', '   at Microsoft.Build.BackEnd.NodeEndpointOutOfProc.Listen()', '[orbit] check=unit status=FAILED exit=1'].join('\n');
    expect(probeSignals({ output: log, exitCode: 1, command: ['dotnet', 'test'], shell: false, insideRoots: ['/checkout'] })).toEqual(['socket-denied']);
  });

  it('reads a program that is not found, and a start failure', () => {
    expect(probeSignals({ output: 'sh: 1: pytest: not found\n', exitCode: 127, command: ['pytest'], shell: false, insideRoots: ['/checkout'] })).toEqual(['program-not-found']);
    expect(probeSignals({ output: '', exitCode: null, command: ['pytest'], shell: false, insideRoots: ['/checkout'], startFailure: 'could not start the check: spawn pytest ENOENT' })).toEqual(['start-failed']);
  });

  it('reads nothing from a failing test, even one whose message says permission denied', () => {
    const log = ['FAIL tests/mul.test.mjs', 'AssertionError: expected permission denied for /etc/shadow', '1 failed'].join('\n');
    expect(probeSignals({ output: log, exitCode: 1, command: ['node', 'tests/run.mjs'], shell: false, insideRoots: ['/checkout'] })).toEqual([]);
  });
});

// The second review's decision: one whole pass of the classifier, with nothing dropped, is the only log that can show
// failed-before; every log is scanned for causes in overlapping windows; ERROR and environment causes come first.
describe('scanProbeLog and the order of causes', () => {
  const input = { exitCode: 1, command: ['dotnet', 'test'], shell: false, insideRoots: ['/checkout'] };
  const CRASH = 'MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.';
  const DENIAL = 'System.Net.Sockets.SocketException (13): Permission denied';

  it('reads a log that fits one pass in that pass, and calls it whole unless output was dropped', () => {
    expect(scanProbeLog(`${CRASH}\n${DENIAL}\n`, input)).toEqual({ signals: ['socket-denied'] });
    expect(scanProbeLog('1 failed\n', input)).toEqual({ signals: [] });
    expect(scanProbeLog('1 failed\n\n[orbit: output truncated: 10 bytes dropped after the first 100]\n', input).unscanned).toMatch(/cut short/);
    expect(scanProbeLog(null, input)).toEqual({ signals: [], unscanned: expect.stringMatching(/not written/) });
  });

  it('reads a longer log in overlapping windows, so lines that belong together are read together, and never calls it whole', () => {
    // The crash header ends the first pass and its refused socket starts the next: the window halfway between holds both.
    const log = `${'ok\n'.repeat(CLASSIFIER_LINES - 1)}${CRASH}\n${DENIAL}\n${'ok\n'.repeat(50_000)}`;
    const scan = scanProbeLog(log, input);
    expect(scan.signals).toEqual(['socket-denied']);
    expect(scan.unscanned).toMatch(/more than one pass of the environment classifier reads \(200000\)/);
  });

  it('judges an ERROR or an environment signal before anything else, and unscanned last', () => {
    const cut = 'its output was cut short';
    expect(judgeProbeAttempts('unit', [attempt(1, 'ERROR', { unscanned: cut })])).toMatchObject({ cause: 'error' });
    expect(judgeProbeAttempts('unit', [attempt(1, 'FAILED', { unscanned: cut, signals: ['filesystem-denied'] }), attempt(2, 'FAILED', { unscanned: cut })])).toMatchObject({ cause: 'environment' });
    expect(judgeProbeAttempts('unit', [attempt(1, 'TIMEOUT', { unscanned: cut })])).toMatchObject({ cause: 'timeout' });
    expect(judgeProbeAttempts('unit', [attempt(1, 'FAILED', { unscanned: cut })])).toMatchObject({ cause: 'once' });
    expect(judgeProbeAttempts('unit', [attempt(1, 'FAILED', { unscanned: cut }), attempt(2, 'FAILED')])).toMatchObject({ outcome: 'not-established', cause: 'unscanned' });
    expect(acceptableCause('unscanned')).toBe(true);
  });
});
