import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BASE_GATED_SIGNALS, classifyCouldNotRun, showsCodeFailure } from '../../../src/evidence/environment-failure.ts';

// Issue #10, retested: a .NET check died in the sandbox with "MSBUILD : error MSB1025" and
// "System.Net.Sockets.SocketException (13): Permission denied" (EACCES on a Unix socket bind), and PREFLIGHT recorded it
// as a pre-existing failure with a baseline-exception question. Permission denied on a socket or a file, and a network
// connection the sandbox refused, are environment failures when the tool itself was refused; a test that reports the
// same words in a failing assertion stays the code's failure. On a candidate those denials count only when the base
// revision showed the same one: a denial the change introduced goes to repair (ADR 0010).

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, '../../fixtures/environment', name), 'utf8');
/**
 * Captured under Orbit's runner and srt 0.0.78 on macOS (the .NET 9.0.305 SDK): `dotnet test` of an xunit project that
 * references two class libraries, packages restored beforehand, no -m:1. MSBuild starts a worker node whose named pipe,
 * a Unix socket under /tmp, the sandbox refuses; after about five minutes of node retries it fails with ten MSB1025
 * crashes. It names no path and no pid.
 */
const MSBUILD_SOCKET = fixture('dotnet-test-msbuild-node-pipe-eacces.log');
/** Captured under srt on macOS: the repository's own program binds a Unix socket and the sandbox refuses it. */
const PROGRAM_SOCKET = fixture('dotnet-run-unix-socket-eacces.log');
/** Real NuGet (the .NET 9.0.305 SDK) through srt 0.0.78's own proxy refusing api.nuget.org, paths and port neutral. */
const NUGET_PROXY = fixture('dotnet-build-nuget-proxy-403.log');
/** Captured under Orbit's runner and srt 0.0.78 on macOS: NuGet's HTTP client cannot start in the sandbox. */
const NUGET_HTTP = fixture('dotnet-build-nuget-cookiecontainer.log');
/**
 * Captured under Orbit's runner and srt 0.0.78 on macOS (the .NET 9.0.305 SDK, the NIS rule in place): `dotnet build
 * Acme.csproj -m:1` of a project with one package and an empty cache, with api.nuget.org in the check's network_hosts.
 * The proxy lets it through, and .NET cannot verify the certificate, since srt keeps the system trust service out of
 * reach; and the same build without the host, the proxy's 403 on the service index.
 */
const NUGET_SSL = fixture('dotnet-build-nuget-ssl.log');
const NUGET_INDEX_403 = fixture('dotnet-build-nuget-service-index-403.log');
/** Python 3.12's unittest, a test that opens a file it may not read (captured; the checkout path neutral). */
const UNITTEST_EACCES = fixture('python-unittest-permission-error.log');
/**
 * Captured under srt 0.0.78 on macOS (node 22): a node server of the repository listens on a Unix socket in its temp
 * directory, which Seatbelt refuses anywhere. node names the call `listen` and the errno EPERM.
 */
const LISTEN_UNIX_EPERM = fixture('node-listen-unix-socket-eperm.log');
const CHECKOUT = '/var/folders/acme/T/orbit-evidence-acme/checkout';
const ROOTS = [CHECKOUT, '/orbit/runs/acme/baseline/build'];

describe('classifyCouldNotRun: permission denied on a socket in the tool\'s own crash', () => {
  it('reads MSBuild\'s internal failure on a socket it was refused as the environment, with the first error line and the denial', () => {
    const f = classifyCouldNotRun({ checkId: 'build', output: MSBUILD_SOCKET, insideRoots: ROOTS });
    expect(f).toMatchObject({ checkId: 'build', fingerprint: null, signals: ['socket-denied'] });
    // One denial line, though the crash repeats it for each of the ten node starts.
    expect(f!.lines).toEqual(['MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.', 'System.Net.Sockets.SocketException (13): Permission denied']);
    expect(f!.cause).toMatch(/socket/);
    expect(f!.cause).toMatch(/permission denied/i);
  });

  it('reads the denial when the .NET SDK\'s own frames show it, without the MSB1025 line', () => {
    const output = MSBUILD_SOCKET.replace(/^MSBUILD : error MSB1025.*\r?\n/gm, '');
    expect(output).not.toMatch(/MSB1025/);
    expect(classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS })?.signals).toEqual(['socket-denied']);
  });

  it('keeps the same denial in the repository\'s own program as the code\'s: the repository ran', () => {
    expect(classifyCouldNotRun({ checkId: 'run', output: PROGRAM_SOCKET, insideRoots: ROOTS })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'unit', output: 'Error: listen EACCES: permission denied 0.0.0.0:80\n    at Server.setupListenHandle [as _listen2] (node:net:1917:21)\n', insideRoots: ROOTS })).toBeNull();
  });

  it('keeps a failing test that reports a refused socket as the code\'s failure, whatever frames it shows', () => {
    const output = [
      '  Failed Acme.Tests.SocketTests.Binds [12 ms]',
      '  Error Message:',
      '   System.Net.Sockets.SocketException (13): Permission denied',
      '  Stack Trace:',
      '     at System.Net.Sockets.Socket.DoBind(EndPoint endPointSnapshot, SocketAddress socketAddress)',
      '     at Microsoft.VisualStudio.TestPlatform.MSTestAdapter.PlatformServices.ThreadOperations.ExecuteWithAbortSafety(Action action)',
      '',
      'Failed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4, Duration: 52 ms - Acme.Tests.dll (net9.0)',
      '',
    ].join('\n');
    expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS })).toBeNull();
    // MSBuild's error count next to it counts a compile error here, not only its own crash.
    const compiled = `${MSBUILD_SOCKET}/src/Acme/Calc.cs(3,1): error CS1002: ; expected [/src/Acme/Acme.csproj]\n    2 Error(s)\n`;
    expect(classifyCouldNotRun({ checkId: 'build', output: compiled, insideRoots: ROOTS })).toBeNull();
  });

  it('ignores MSBuild\'s error count when every error it counted is its internal failure (MSB1025)', () => {
    expect(classifyCouldNotRun({ checkId: 'build', output: `${MSBUILD_SOCKET}    0 Warning(s)\n    10 Error(s)\n`, insideRoots: ROOTS })?.signals).toEqual(['socket-denied']);
  });
});

describe('classifyCouldNotRun: permission denied (EACCES) on a file outside the checkout', () => {
  it('reads EACCES and "Permission denied" on a filesystem call naming a path outside the checkout, a Unix socket included', () => {
    for (const output of [
      "Error: EACCES: permission denied, mkdir '/home/acme/.npm/_cacache'\n",
      "cp: cannot create regular file '/usr/local/bin/acme': Permission denied\n",
      "PermissionError: [Errno 13] Permission denied: '/home/acme/.cache/acme'\n",
      'Error: listen EACCES: permission denied /tmp/tsx-501/4242.pipe\n',
      'mkdir: cannot create directory \u2018/home/acme/.cache\u2019: Permission denied\n',
      // .NET's wording of EACCES on a file
      "System.UnauthorizedAccessException: Access to the path '/usr/local/share/acme/state' is denied.\n",
    ]) {
      const f = classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS });
      expect(f?.signals, output).toEqual(['permission-denied']);
      expect(f!.cause).toMatch(/EACCES/);
      expect(f!.lines).toEqual([output.trim()]);
    }
  });

  it('is null for the same denial inside the checkout or the check\'s own directories, or with no path', () => {
    for (const output of [
      `Error: EACCES: permission denied, open '${CHECKOUT}/dist/out.js'\n`,
      `error : Error reading git repository information: Access to the path '${CHECKOUT}/.gitmodules' is denied.\n`,
      'mkdir: /orbit/runs/acme/baseline/build/home/.cache: Permission denied\n',
      'sh: ./scripts/run.sh: Permission denied\n',
      "{ code: 'EACCES', syscall: 'open' }\n",
      'PermissionError: [Errno 13] Permission denied\n',
    ]) {
      expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS }), output).toBeNull();
    }
  });

  it('keeps a failing test whose assertion mentions permission denied on such a path as the code\'s failure', () => {
    for (const output of [
      // pytest, as 8.4 reports a test that raised it
      [">       open('/etc/acme/secret.conf')", "E       PermissionError: [Errno 13] Permission denied: '/etc/acme/secret.conf'", '', "tests/test_config.py:4: PermissionError", "FAILED tests/test_config.py::test_reads_secret - PermissionError: [Errno 13] Permission denied: '/etc/acme/secret.conf'", '1 failed in 0.05s', ''].join('\n'),
      // node:test, TAP
      ['not ok 1 - reports a config it may not read', '  ---', "  error: |-", "    expected the loader to report EACCES: permission denied, open '/etc/acme/config.json'", '  ...', '# fail 1', ''].join('\n'),
      // Vitest
      [' FAIL  tests/config.test.ts > loader > reports a config it may not read', "AssertionError: expected 'ok' to be 'EACCES: permission denied, open \\'/etc/acme/config.json\\''", ''].join('\n'),
      // Python's unittest, a test that errors (captured)
      UNITTEST_EACCES,
    ]) {
      expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS }), output).toBeNull();
    }
  });
});

describe('classifyCouldNotRun: a connection the sandbox\'s network proxy refused', () => {
  it('reads srt\'s refusal markers and the clients\' report of the proxy\'s 403 to a tunnel', () => {
    for (const output of [
      // curl under srt on macOS (captured), quiet and verbose
      'curl: (56) CONNECT tunnel failed, response 403\n',
      '< HTTP/1.1 403 Forbidden\n< Content-Type: text/plain\n< X-Proxy-Error: blocked-by-allowlist\n< \n* CONNECT tunnel failed, response 403\n',
      'Connection blocked by network allowlist\n',
    ]) {
      const f = classifyCouldNotRun({ checkId: 'build', output, insideRoots: ROOTS });
      expect(f?.signals, output).toEqual(['network-denied']);
      expect(f!.cause).toMatch(/network/);
    }
  });

  it('is null for a network failure that is not the proxy\'s refusal, and for a failing test that hit the proxy', () => {
    for (const output of [
      "getaddrinfo ENOTFOUND example.com\n",
      'curl: (6) Could not resolve host: example.com\n',
      'curl: (56) CONNECT tunnel failed, response 403\nnot ok 1 - downloads the fixture\n',
      'Connection blocked by network allowlist\nFAILED tests/test_fetch.py::test_download - urllib.error.HTTPError: HTTP Error 403\n',
    ]) {
      expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS }), output).toBeNull();
    }
  });
});

describe('classifyCouldNotRun: a NuGet restore refused inside dotnet build', () => {
  it('ignores MSBuild\'s error count when every error it counted is a restore error, and reads the proxy\'s refusal', () => {
    // "2 Error(s)": NU1301 and the restore task's own uncoded error from NuGet.targets, both the refused download.
    expect(NUGET_PROXY).toMatch(/^ {4}2 Error\(s\)$/m);
    expect(showsCodeFailure(NUGET_PROXY)).toBe(false);
    const f = classifyCouldNotRun({ checkId: 'build', output: NUGET_PROXY, insideRoots: ROOTS });
    expect(f?.signals).toEqual(['network-denied']);
    expect(f!.lines[0]).toBe("The proxy tunnel request to proxy 'http://localhost:54120/' failed with status code '403'.\"");
  });

  it('reads NuGet\'s HTTP client failing to start in the sandbox (macOS), the way a real check under srt fails to restore', () => {
    expect(NUGET_HTTP).toMatch(/^ {4}1 Error\(s\)$/m);
    const f = classifyCouldNotRun({ checkId: 'build', output: NUGET_HTTP, insideRoots: ROOTS });
    expect(f?.signals).toEqual(['nuget-http-denied']);
    expect(f!.lines[0]).toMatch(/error NU1301: {3}The type initializer for 'System\.Net\.CookieContainer' threw an exception\.$/);
    expect(f!.cause).toMatch(/NuGet's HTTP client could not start in the sandbox/);
    // Without the failed read of the domain name, the same type initializer failure is not shown to be the sandbox's.
    expect(classifyCouldNotRun({ checkId: 'build', output: NUGET_HTTP.replace(/^.*GetDomainName: -1\n/gm, ''), insideRoots: ROOTS })).toBeNull();
  });

  // Review: following the network-denied fix on macOS (the host in network_hosts) led to this, which PREFLIGHT recorded
  // as a pre-existing failure with a baseline-exception question, the issue #10 symptom.
  it('reads NuGet\'s restore that could not establish the SSL connection (macOS, the system trust service out of reach) as the environment', () => {
    const f = classifyCouldNotRun({ checkId: 'build', output: NUGET_SSL, insideRoots: ROOTS });
    expect(f).toMatchObject({ checkId: 'build', fingerprint: null, signals: ['nuget-tls-denied'] });
    expect(f!.lines).toEqual(['/var/folders/acme/T/orbit-evidence-acme/checkout/Acme.csproj : error NU1301:   The SSL connection could not be established, see inner exception.']);
    expect(f!.cause).toMatch(/system trust service/);
    expect(classifyCouldNotRun({ checkId: 'build', output: NUGET_INDEX_403, insideRoots: ROOTS })?.signals).toEqual(['network-denied']);
    // A failing test that reports the same words is the code's.
    expect(classifyCouldNotRun({ checkId: 'test', output: `${NUGET_SSL}\nFailed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4\n`, insideRoots: ROOTS })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'test', output: 'HttpRequestException: The SSL connection could not be established, see inner exception.\n', insideRoots: ROOTS })).toBeNull();
  });

  it('keeps the count when any counted error is not a restore error: the build compiled the repository\'s code', () => {
    const withCompile = NUGET_PROXY.replace(/^ {4}2 Error\(s\)$/m, '/src/Acme/Calc.cs(3,1): error CS1002: ; expected [/src/Acme/Acme.csproj]\n    3 Error(s)');
    expect(classifyCouldNotRun({ checkId: 'build', output: withCompile, insideRoots: ROOTS })).toBeNull();
    const withTask = NUGET_PROXY.replace(/^ {4}2 Error\(s\)$/m, '/src/Acme/Acme.csproj(12,5): error MSB3073: The command "npm run build" exited with code 1.\n    3 Error(s)');
    expect(classifyCouldNotRun({ checkId: 'build', output: withTask, insideRoots: ROOTS })).toBeNull();
    const uncoded = NUGET_PROXY.replace(/^ {4}2 Error\(s\)$/m, '/src/Acme/Acme.csproj : error : the generator failed\n    3 Error(s)');
    expect(classifyCouldNotRun({ checkId: 'build', output: uncoded, insideRoots: ROOTS })).toBeNull();
    // A count that is not MSBuild's summary is not read this way at all.
    expect(showsCodeFailure("The proxy tunnel request to proxy 'http://localhost:54120/' failed with status code '403'.\nFound 2 errors.\n")).toBe(true);
  });

  it('reads a count and its word on one line only: "-1" then "Failed to restore" on the next is no failed test', () => {
    expect(showsCodeFailure('error NU1301:   GetDomainName: -1\n  Failed to restore /src/Acme/Acme.csproj (in 5.62 sec).\n')).toBe(false);
    expect(showsCodeFailure('3\nerrors were printed above\n')).toBe(false);
    expect(showsCodeFailure('1 failed in 0.05s\n')).toBe(true);
    expect(showsCodeFailure('  3 failing\n')).toBe(true);
    expect(showsCodeFailure('Found 2 errors.\n')).toBe(true);
  });

  it('on a candidate whose base revision showed no environment failure, reads MSBuild\'s count of restore errors as the code\'s', () => {
    // The shape of a restore that writes a new package to the global packages folder under srt on Linux, where it is
    // read-only (constructed): a change that adds a package brings it, so on a candidate it goes to repair, as it did
    // before ADR 0010, when MSBuild's count always read as a code failure.
    const restore = [
      '  Determining projects to restore...',
      `${CHECKOUT}/src/Acme/Acme.csproj : error NU1301: Failed to download package 'Acme.Json.1.0.0'.`,
      `${CHECKOUT}/src/Acme/Acme.csproj : error NU1301:   System.IO.IOException: Read-only file system : '/home/acme/.nuget/packages/acme.json'`,
      '    0 Warning(s)',
      '    1 Error(s)',
      '',
    ].join('\n');
    expect(classifyCouldNotRun({ checkId: 'build', output: restore, insideRoots: ROOTS })?.signals).toEqual(['filesystem-denied']);
    expect(classifyCouldNotRun({ checkId: 'build', output: restore, insideRoots: ROOTS, baseSignals: [] })).toBeNull();
    // A base revision that showed the same refusal leaves the restore errors aside, as on the base revision.
    expect(classifyCouldNotRun({ checkId: 'build', output: restore, insideRoots: ROOTS, baseSignals: ['filesystem-denied'] })?.signals).toEqual(['filesystem-denied']);
    expect(showsCodeFailure(restore)).toBe(false);
    expect(showsCodeFailure(restore, { countRestoreErrors: true })).toBe(true);
  });
});

describe('a failing test in a .NET test runner\'s own report stays the code\'s failure, whatever denial it reports', () => {
  /**
   * Captured with `dotnet run` of real test projects on macOS (the .NET 9.0.305 SDK), the checkout path neutral: a test
   * that creates a directory under /System (EPERM, "Operation not permitted") or reads /etc/sudoers (EACCES), next to one
   * that passes. Microsoft.Testing.Platform's report from MSTest 3.6.4's runner (platform 1.4), MSTest 4.4.1's (platform
   * 2) and TUnit 1.72.16, and xunit v3 3.2.2's own in-process runner (colour codes kept) and its platform mode.
   */
  const RUNNERS = ['dotnet-mstest-runner-eperm.log', 'dotnet-mstest-runner-eacces.log', 'dotnet-tunit-eperm.log', 'dotnet-xunit-v3-eperm.log', 'dotnet-xunit-v3-mtp-eperm.log'];

  it('reads each as a failing test: no environment failure on the base revision or on a candidate', () => {
    for (const name of RUNNERS) {
      const output = fixture(name);
      expect(output, name).toMatch(/Access to the path '\/(?:System\/acme-cache|etc\/sudoers)' is denied/);
      expect(showsCodeFailure(output), name).toBe(true);
      expect(classifyCouldNotRun({ checkId: 'test', output, insideRoots: ROOTS }), name).toBeNull();
      expect(classifyCouldNotRun({ checkId: 'test', output, insideRoots: ROOTS, baseSignals: [] }), name).toBeNull();
      expect(classifyCouldNotRun({ checkId: 'test', output, insideRoots: ROOTS, baseSignals: ['permission-denied'] }), name).toBeNull();
    }
  });

  it('reads the platform\'s and xunit\'s failing-test lines and counts, and not a count of none', () => {
    for (const output of [
      // Microsoft.Testing.Platform: the summary's count, and the line for each failing test with its duration
      'Test run summary: Failed! - bin/Debug/net9.0/Acme.Tests.dll (net9.0|arm64)\n  total: 2\n  failed: 1\n  succeeded: 1\n',
      'failed WritesCache (12ms)\n',
      'failed Acme.Tests.CacheTests.ReadsConfig (1s 012ms)\n',
      // xunit's own runner: the line for each failing test, and its summary
      '    Acme.Tests.CacheTests.WritesCache [FAIL]\n',
      '   Acme.Tests  Total: 2, Errors: 0, Failed: 1, Skipped: 0, Not Run: 0, Time: 0,068s\n',
    ]) {
      expect(showsCodeFailure(output), output).toBe(true);
    }
    for (const output of [
      'Test run summary: Zero tests ran - bin/Debug/net9.0/Acme.Tests.dll (net9.0|arm64)\n  total: 0\n  failed: 0\n  succeeded: 0\n',
      '   Acme.Tests  Total: 2, Errors: 0, Failed: 0, Skipped: 0, Not Run: 0, Time: 0,068s\n',
      // a call that failed with an errno, not a count of failing tests
      'bind() failed: 1 (Operation not permitted)\n',
      'failed to create /tmp/.dotnet (13)\n',
    ]) {
      expect(showsCodeFailure(output), output).toBe(false);
    }
  });
});

describe('classifyCouldNotRun on a candidate: the denials ADR 0010 added count only when the base revision showed the same one', () => {
  const EACCES = "PermissionError: [Errno 13] Permission denied: '/etc/acme/secret.conf'\n";
  const NETWORK = 'curl: (56) CONNECT tunnel failed, response 403\n';

  it('takes a new denial on a candidate whose base revision showed none for a failure for repair', () => {
    for (const output of [EACCES, NETWORK, NUGET_PROXY, NUGET_HTTP, NUGET_SSL, MSBUILD_SOCKET]) {
      expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS }), output).not.toBeNull();
      expect(classifyCouldNotRun({ checkId: 'unit', output, insideRoots: ROOTS, baseSignals: [] }), output).toBeNull();
    }
    // Another signal on the base revision is not the same one.
    expect(classifyCouldNotRun({ checkId: 'unit', output: NETWORK, insideRoots: ROOTS, baseSignals: ['permission-denied'] })).toBeNull();
  });

  it('counts it when the base revision showed the same signal', () => {
    expect(classifyCouldNotRun({ checkId: 'unit', output: EACCES, insideRoots: ROOTS, baseSignals: ['permission-denied'] })?.signals).toEqual(['permission-denied']);
    expect(classifyCouldNotRun({ checkId: 'build', output: NUGET_PROXY, insideRoots: ROOTS, baseSignals: ['network-denied'] })?.signals).toEqual(['network-denied']);
    expect(classifyCouldNotRun({ checkId: 'build', output: NUGET_SSL, insideRoots: ROOTS, baseSignals: ['nuget-tls-denied'] })?.signals).toEqual(['nuget-tls-denied']);
    expect(classifyCouldNotRun({ checkId: 'test', output: MSBUILD_SOCKET, insideRoots: ROOTS, baseSignals: ['socket-denied'] })?.signals).toEqual(['socket-denied']);
  });

  // Review: `listen` joined the filesystem calls for node's `listen EACCES: permission denied /tmp/x.pipe`, which made
  // the same server's EPERM an ungated filesystem denial, so a candidate that adds a Unix socket server ended BLOCKED
  // where main repaired it. `listen` counts with EACCES only, which is gated; its EPERM is no evidence, as before.
  it('takes a Unix socket server the sandbox refuses with EPERM for the code\'s failure, on a candidate and on the base revision', () => {
    expect(classifyCouldNotRun({ checkId: 'unit', output: LISTEN_UNIX_EPERM, insideRoots: ROOTS, baseSignals: [] })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'unit', output: LISTEN_UNIX_EPERM, insideRoots: ROOTS, baseSignals: ['filesystem-denied'] })).toBeNull();
    expect(classifyCouldNotRun({ checkId: 'unit', output: LISTEN_UNIX_EPERM, insideRoots: ROOTS })).toBeNull();
    // Its EACCES form is the gated permission-denied: read on the base revision, on a candidate only when the base showed it.
    const eacces = 'Error: listen EACCES: permission denied /tmp/tsx-501/4242.pipe\n';
    expect(classifyCouldNotRun({ checkId: 'unit', output: eacces, insideRoots: ROOTS })?.signals).toEqual(['permission-denied']);
    expect(classifyCouldNotRun({ checkId: 'unit', output: eacces, insideRoots: ROOTS, baseSignals: [] })).toBeNull();
  });

  it('keeps the denials that predate ADR 0010 (EPERM, EROFS, a Seatbelt deny line) as they were on a candidate', () => {
    expect([...BASE_GATED_SIGNALS].sort()).toEqual(['network-denied', 'nuget-http-denied', 'nuget-tls-denied', 'permission-denied', 'pipe-denied', 'program-not-found', 'socket-denied']);
    expect(classifyCouldNotRun({ checkId: 'unit', output: "Error: EPERM: operation not permitted, mkdir '/usr/local/var/acme'\n", insideRoots: ROOTS, baseSignals: [] })?.signals).toEqual(['filesystem-denied']);
    expect(classifyCouldNotRun({ checkId: 'unit', output: 'Sandbox: make(1) deny(1) file-write-create /usr/local/var/acme\n', insideRoots: ROOTS, baseSignals: [] })?.signals).toEqual(['sandbox-violation']);
  });
});
