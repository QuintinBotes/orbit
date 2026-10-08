import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostTool } from '../evidence/harness.ts';

/**
 * Issue #31: the shapes in which a repository's test runner or its tests use loopback, and the shapes that need none,
 * each as a tiny project and the command a worker would run. Measured under Orbit's worker sandbox on macOS 27 (srt
 * 0.0.78, and Claude Code's own sandbox, which is built on it) before the fix:
 *
 * - listens on loopback, refused without the permission: VSTest (`dotnet test`: vstest.console's SocketServer, which its
 *   test host connects to, "SocketException (13): Permission denied" at Socket.Bind), a forked JVM that connects back
 *   over a loopback socket (Gradle's test workers, Surefire's TCP fork channel), and a test that starts a server (Go's
 *   httptest, Python's http.server, a Node HTTP server);
 * - needs none: `go test -json` (test2json reads the test binary's output over a pipe), a forked JVM over pipes
 *   (Surefire's default fork channel), Node's child_process IPC and worker threads (Jest's and Vitest's workers), and
 *   pipes to a child Python (pytest-xdist's execnet popen gateways). pytest-xdist 3.8.0 (`pytest -n 2`) and Jest 30.5
 *   (`--maxWorkers=2`) themselves passed there too; they are not dependencies of Orbit, so the shapes stand in for them.
 */
export interface LoopbackRunner {
  name: string;
  /** Why the runner cannot run here, or null. */
  unavailable: string | null;
  files: Record<string, string>;
  command: string[];
  /** Whether it listens on loopback. */
  listens: boolean;
  /** Its output when it ran to the end. */
  passed: RegExp;
  /** Its output when the sandbox refused its bind (listens only). */
  refused?: RegExp;
  timeoutMs: number;
}

const node = process.execPath;
// Each tool counts only if it starts, outside any sandbox, the way a runner starts it (harness.ts hostTool): every Mac
// has /usr/bin/javac and /usr/bin/java, stubs that start a JDK installed elsewhere or fail with "Unable to locate a Java
// Runtime".
const python = hostTool('python3', ['--version']);
const go = hostTool('go', ['version']);
const javac = hostTool('javac', ['-version']);
const java = hostTool('java', ['-version']);
const jvmAbsent = javac.absent ?? java.absent;
const dotnetTool = hostTool('dotnet', ['--version'], join(homedir(), '.dotnet', 'dotnet'));
export const dotnet = dotnetTool.path;

const TFM = '<TargetFramework>net$(NETCoreAppMaximumVersion)</TargetFramework>';

let dotnetFirstRunDone = false;

/**
 * The account's own first .NET run, outside any sandbox, as on every machine where it has run a restore. The SDK keeps
 * its first-run state (~/.dotnet) and NuGet its user config (~/.nuget/NuGet/NuGet.Config) and migrations under HOME, and
 * writes them on the first run. A worker's HOME is the account's, which its sandbox lets it read and not write, so where
 * the account never ran a restore (GitHub's Ubuntu runner) a worker's first dotnet build stopped at "Unexpected failure
 * reading NuGet.Config ... Read-only file system : '<home>/.nuget'", and on a home without ~/.dotnet at the SDK's
 * first-use configuration. It restores a project with no packages, from no package source, in a directory of its own,
 * once: nothing of the runner's worktree, and nothing the account already has, changes.
 */
export function dotnetFirstRun(): void {
  if (dotnetFirstRunDone) return;
  const dir = mkdtempSync(join(tmpdir(), 'orbit-dotnet-first-run-'));
  try {
    writeFileSync(join(dir, 'first.csproj'), `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}</PropertyGroup></Project>\n`);
    for (const f of ['Directory.Build.props', 'Directory.Build.targets']) writeFileSync(join(dir, f), '<Project></Project>\n');
    mkdirSync(join(dir, 'no-source'));
    execFileSync(dotnet!, ['restore', 'first.csproj', '--source', join(dir, 'no-source'), '-v', 'q'], { cwd: dir, stdio: 'pipe' });
    dotnetFirstRunDone = true;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** No package references: it restores and builds offline from the SDK alone. Empty Directory.Build files stop MSBuild importing any above. */
const DOTNET_ISOLATED = { 'Directory.Build.props': '<Project></Project>\n', 'Directory.Build.targets': '<Project></Project>\n' };

/**
 * What VSTest does, without its packages: the runner listens on loopback (vstest.console's SocketServer.Start binds
 * IPAddress.Loopback:0) and starts a test host that connects back.
 */
const VSTEST_SHAPE = {
  ...DOTNET_ISOLATED,
  'acme.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType>${TFM}<ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup></Project>\n`,
  'Program.cs': [
    'using System.Diagnostics;',
    'using System.Net;',
    'using System.Net.Sockets;',
    'if (args.Length > 0)',
    '{',
    '    using var client = new TcpClient();',
    '    client.Connect(IPAddress.Loopback, int.Parse(args[0]));',
    '    using var writer = new StreamWriter(client.GetStream());',
    '    writer.WriteLine("hello from the test host");',
    '    return 0;',
    '}',
    'var listener = new TcpListener(IPAddress.Loopback, 0);',
    'listener.Start();',
    'var port = ((IPEndPoint)listener.LocalEndpoint).Port;',
    'var host = new ProcessStartInfo(Environment.ProcessPath!);',
    'host.ArgumentList.Add(typeof(Program).Assembly.Location);',
    'host.ArgumentList.Add(port.ToString());',
    'using var child = Process.Start(host)!;',
    'using var accepted = listener.AcceptTcpClient();',
    'Console.WriteLine("runner got: " + new StreamReader(accepted.GetStream()).ReadLine());',
    'child.WaitForExit();',
    'return child.ExitCode;',
    '',
  ].join('\n'),
};

/** The xunit packages the real `dotnet test` case restores, offline, from the account's NuGet cache. */
export const XUNIT_PACKAGES: Readonly<Record<string, string>> = { 'Microsoft.NET.Test.Sdk': '17.12.0', xunit: '2.9.3', 'xunit.runner.visualstudio': '2.8.2' };
export const nugetGlobalPackages = process.env.NUGET_PACKAGES && process.env.NUGET_PACKAGES.trim() ? process.env.NUGET_PACKAGES : join(homedir(), '.nuget', 'packages');
const xunitCached = Object.entries(XUNIT_PACKAGES).every(([id, v]) => existsSync(join(nugetGlobalPackages, id.toLowerCase(), v)));

/** A real xunit test project, the issue's own shape. */
export const XUNIT_PROJECT = {
  ...DOTNET_ISOLATED,
  'Acme.Tests/Acme.Tests.csproj': `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>${TFM}<IsPackable>false</IsPackable><IsTestProject>true</IsTestProject></PropertyGroup><ItemGroup>${Object.entries(XUNIT_PACKAGES)
    .map(([id, v]) => `<PackageReference Include="${id}" Version="${v}" />`)
    .join('')}</ItemGroup></Project>\n`,
  'Acme.Tests/CalcTests.cs': 'using Xunit;\n\nnamespace Acme.Tests;\n\npublic class CalcTests\n{\n    [Fact]\n    public void Adds() => Assert.Equal(5, 2 + 3);\n}\n',
};

/**
 * A Maven build file. Every repository whose tests Surefire or Gradle runs has one (pom.xml, build.gradle...), and these
 * are what make a repository a JVM one to Orbit (the jvm toolchain's markers), so only with one does a worker get the
 * host's JDK through JAVA_HOME (isolation/toolchains.ts). Without it the worker had no JAVA_HOME, and where the JDK is
 * found through JAVA_HOME alone (GitHub's macOS runners keep it in the tool cache, behind the /usr/bin/javac stub) its
 * javac was "Unable to locate a Java Runtime".
 */
const MAVEN_POM = { 'pom.xml': '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>acme</groupId><artifactId>acme</artifactId><version>0</version></project>\n' };

const JAVA_SOCKET = {
  ...MAVEN_POM,
  'Runner.java': [
    'import java.io.*;',
    'import java.net.*;',
    'public class Runner {',
    '  public static void main(String[] a) throws Exception {',
    '    try (ServerSocket server = new ServerSocket(0, 50, InetAddress.getLoopbackAddress())) {',
    '      Process fork = new ProcessBuilder(System.getProperty("java.home") + "/bin/java", "-cp", ".", "Forked", String.valueOf(server.getLocalPort())).inheritIO().start();',
    '      try (Socket s = server.accept(); BufferedReader r = new BufferedReader(new InputStreamReader(s.getInputStream()))) { System.out.println("runner got: " + r.readLine()); }',
    '      System.exit(fork.waitFor());',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n'),
  'Forked.java': [
    'import java.io.*;',
    'import java.net.*;',
    'public class Forked {',
    '  public static void main(String[] a) throws Exception {',
    '    try (Socket s = new Socket(InetAddress.getLoopbackAddress(), Integer.parseInt(a[0])); PrintWriter w = new PrintWriter(s.getOutputStream(), true)) { w.println("hello from the forked jvm"); }',
    '  }',
    '}',
    '',
  ].join('\n'),
};

const JAVA_PIPES = {
  ...MAVEN_POM,
  'Runner.java': [
    'import java.io.*;',
    'public class Runner {',
    '  public static void main(String[] a) throws Exception {',
    '    Process fork = new ProcessBuilder(System.getProperty("java.home") + "/bin/java", "-cp", ".", "Forked").start();',
    '    fork.getOutputStream().write("ping\\n".getBytes());',
    '    fork.getOutputStream().close();',
    '    System.out.println("runner got: " + new BufferedReader(new InputStreamReader(fork.getInputStream())).readLine());',
    '    System.exit(fork.waitFor());',
    '  }',
    '}',
    '',
  ].join('\n'),
  'Forked.java': 'import java.io.*;\npublic class Forked {\n  public static void main(String[] a) throws Exception {\n    System.out.println("forked read " + new BufferedReader(new InputStreamReader(System.in)).readLine());\n  }\n}\n',
};

const GO_MOD = { 'go.mod': 'module acme\n\ngo 1.21\n' };
const PYPROJECT = { 'pyproject.toml': '[project]\nname = "acme"\nversion = "0"\n' };
const NODE_PACKAGE = { 'package.json': '{"name":"acme","private":true}\n' };

export const LOOPBACK_RUNNERS: readonly LoopbackRunner[] = [
  {
    name: 'a Node test that starts a server',
    unavailable: null,
    files: { ...NODE_PACKAGE, 'serve.mjs': "import { createServer } from 'node:http';\nconst s = createServer((q, r) => r.end('ok')).listen(0, '127.0.0.1', async () => { const r = await fetch(`http://127.0.0.1:${s.address().port}/`); console.log('server answered', await r.text()); s.close(); });\n" },
    command: [node, 'serve.mjs'],
    listens: true,
    passed: /server answered ok/,
    refused: /listen EPERM: operation not permitted 127\.0\.0\.1/,
    timeoutMs: 30_000,
  },
  {
    name: "a Python test that starts a server (http.server)",
    unavailable: python.absent,
    files: { ...PYPROJECT, 'serve.py': "import http.server, threading, urllib.request\ns = http.server.HTTPServer(('127.0.0.1', 0), http.server.SimpleHTTPRequestHandler)\nthreading.Thread(target=s.serve_forever, daemon=True).start()\nprint('server answered', urllib.request.urlopen(f'http://127.0.0.1:{s.server_address[1]}/pyproject.toml').status)\n" },
    command: [python.path ?? 'python3', 'serve.py'],
    listens: true,
    passed: /server answered 200/,
    refused: /PermissionError: \[Errno 1\] Operation not permitted/,
    timeoutMs: 30_000,
  },
  {
    name: "a Go test that starts an httptest server, under go test -json",
    unavailable: go.absent,
    files: {
      ...GO_MOD,
      'serve_test.go': 'package acme\n\nimport (\n\t"io"\n\t"net/http"\n\t"net/http/httptest"\n\t"testing"\n)\n\nfunc TestServe(t *testing.T) {\n\ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") }))\n\tdefer s.Close()\n\tres, err := http.Get(s.URL)\n\tif err != nil {\n\t\tt.Fatal(err)\n\t}\n\tb, _ := io.ReadAll(res.Body)\n\tif string(b) != "ok" {\n\t\tt.Fatal(string(b))\n\t}\n}\n',
    },
    command: [go.path ?? 'go', 'test', '-json', './...'],
    listens: true,
    passed: /"Action":"pass","Package":"acme","Test":"TestServe"/,
    refused: /httptest: failed to listen on a port: listen tcp6? \S+:0: bind: operation not permitted/,
    timeoutMs: 180_000,
  },
  {
    name: "a forked JVM that connects back over loopback (Gradle's test workers, Surefire's TCP fork channel)",
    unavailable: jvmAbsent,
    files: JAVA_SOCKET,
    command: ['/bin/sh', '-c', 'javac Runner.java Forked.java && java -cp . Runner'],
    listens: true,
    passed: /runner got: hello from the forked jvm/,
    refused: /java\.net\.SocketException: Operation not permitted[\s\S]*ServerSocket/,
    timeoutMs: 120_000,
  },
  {
    name: "VSTest's shape: a .NET runner that listens on loopback for the test host it starts",
    unavailable: dotnetTool.absent,
    files: VSTEST_SHAPE,
    command: ['/bin/sh', '-c', `"$0" build -m:1 -o out -v q -nologo && "$0" out/acme.dll`, dotnet ?? 'dotnet'],
    listens: true,
    passed: /runner got: hello from the test host/,
    refused: /SocketException \(13\): Permission denied[\s\S]*Socket\.Bind/,
    timeoutMs: 300_000,
  },
  {
    name: 'the issue itself: dotnet test -m:1 of an xunit project (VSTest)',
    unavailable: dotnetTool.absent !== null ? dotnetTool.absent : !xunitCached ? `the xunit packages (${Object.entries(XUNIT_PACKAGES).map(([id, v]) => `${id} ${v}`).join(', ')}) are not in the NuGet cache ${nugetGlobalPackages}` : null,
    files: XUNIT_PROJECT,
    command: [dotnet ?? 'dotnet', 'test', '-m:1', 'Acme.Tests/Acme.Tests.csproj'],
    listens: true,
    passed: /Passed!\s+- Failed:\s+0, Passed:\s+1/,
    refused: /SocketException \(13\): Permission denied[\s\S]*TestRequestSender\.InitializeCommunication[\s\S]*Test Run Aborted/,
    timeoutMs: 300_000,
  },
  {
    name: 'go test -json of a plain test (test2json over a pipe)',
    unavailable: go.absent,
    files: { ...GO_MOD, 'calc.go': 'package acme\n\nfunc Add(a, b int) int { return a + b }\n', 'calc_test.go': 'package acme\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(2, 3) != 5 {\n\t\tt.Fatal("2 + 3")\n\t}\n}\n' },
    command: [go.path ?? 'go', 'test', '-json', './...'],
    listens: false,
    passed: /"Action":"pass","Package":"acme","Test":"TestAdd"/,
    timeoutMs: 180_000,
  },
  {
    name: "a forked JVM over pipes (Surefire's default fork channel)",
    unavailable: jvmAbsent,
    files: JAVA_PIPES,
    command: ['/bin/sh', '-c', 'javac Runner.java Forked.java && java -cp . Runner'],
    listens: false,
    passed: /runner got: forked read ping/,
    timeoutMs: 120_000,
  },
  {
    name: "Node workers over child_process IPC and worker threads (Jest's and Vitest's pools)",
    unavailable: null,
    files: {
      ...NODE_PACKAGE,
      'workers.mjs':
        "import { fork } from 'node:child_process';\nimport { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';\n" +
        "if (process.argv[2] === 'child') process.on('message', (m) => { process.send(m * 2); process.disconnect(); });\n" +
        "else if (!isMainThread) parentPort.postMessage(workerData * 3);\n" +
        "else { const c = fork(new URL(import.meta.url).pathname, ['child']); c.on('message', (m) => { console.log('fork answered', m); new Worker(new URL(import.meta.url), { workerData: 7 }).on('message', (t) => console.log('thread answered', t)); }); c.send(21); }\n",
    },
    command: [node, 'workers.mjs'],
    listens: false,
    passed: /fork answered 42[\s\S]*thread answered 21/,
    timeoutMs: 30_000,
  },
  {
    name: "a child Python over pipes (pytest-xdist's execnet popen gateways)",
    unavailable: python.absent,
    files: { ...PYPROJECT, 'pipes.py': "import subprocess, sys\nr = subprocess.run([sys.executable, '-c', 'import sys; print(sys.stdin.read().upper())'], input='ping', capture_output=True, text=True)\nprint('child said', r.stdout.strip())\n" },
    command: [python.path ?? 'python3', 'pipes.py'],
    listens: false,
    passed: /child said PING/,
    timeoutMs: 30_000,
  },
];
