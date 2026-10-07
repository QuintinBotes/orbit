// Issue #10 (reopened): MSBuild worker nodes under the check sandbox. A node binds a named pipe at /tmp/MSBuild<pid>,
// which the sandbox denies; the node crashes and MSBuild waits 30 s for each of its ten attempts to start one.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { fingerprintFailure } from '../../../src/evidence/fingerprint.ts';
import { findMsbuildNodeDenial, msbuildFix, msbuildFixReason, msbuildNodeDenialNote, msbuildNodeDenialText, msbuildNodeFix, msbuildNodes, probeNodeSwitches, runStoppingRefusedNodes } from '../../../src/evidence/msbuild.ts';
import { checkDef } from './fixtures.ts';

const MSBUILD_MODULE = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '../../../src/evidence/msbuild.ts')).href;
const FAILURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../fixtures/environment', 'msbuild-node-pipe-denied.failure.txt'), 'utf8');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'orbit-msbuild-'));
  dirs.push(d);
  return d;
}

/** Where MSBuild 17 writes a node's crash report: `<TMPDIR>/MSBuildTemp<user>/MSBuild_pid-<pid>_<id>.failure.txt`. */
function report(dir: string, name: string, text: string): void {
  mkdirSync(join(dir, 'MSBuildTempacme'), { recursive: true });
  writeFileSync(join(dir, 'MSBuildTempacme', name), text);
}

describe('findMsbuildNodeDenial', () => {
  it('finds the crash report of a node the sandbox refused its pipe, and names the pipe and the error', () => {
    const d = tmp();
    report(d, 'MSBuild_pid-4242_0123456789abcdef0123456789abcdef.failure.txt', FAILURE);
    const found = findMsbuildNodeDenial(d);
    expect(found).toEqual({ pid: 4242, pipe: '/tmp/MSBuild4242', exception: 'System.Net.Sockets.SocketException (13): Permission denied' });
    expect(msbuildNodeDenialText(found!)).toBe('MSBuild node (pid 4242) could not bind its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied)');
  });

  it('finds nothing in a temp directory without MSBuild reports, or with reports of other crashes', () => {
    const d = tmp();
    expect(findMsbuildNodeDenial(d)).toBeNull();
    expect(findMsbuildNodeDenial(join(d, 'missing'))).toBeNull();
    report(d, 'MSBuild_pid-77_0123abcd.failure.txt', 'UNHANDLED EXCEPTIONS FROM PROCESS 77:\nSystem.OutOfMemoryException: Insufficient memory\n   at Microsoft.Build.Execution.OutOfProcNode.Run()\n');
    report(d, 'notes.txt', FAILURE);
    expect(findMsbuildNodeDenial(d)).toBeNull();
  });

  it('names no pipe when the refused pipe server is not a build node (its path is not MSBuild<pid>)', () => {
    const d = tmp();
    report(d, 'MSBuild_pid-91_00ff.failure.txt', FAILURE.replace('Microsoft.Build.BackEnd.NodeEndpointOutOfProcBase.InternalConstruct', 'Microsoft.Build.Experimental.OutOfProcServerNode.Run'));
    expect(findMsbuildNodeDenial(d)).toEqual({ pid: 91, pipe: null, exception: 'System.Net.Sockets.SocketException (13): Permission denied' });
    expect(msbuildNodeDenialText(findMsbuildNodeDenial(d)!)).toBe('MSBuild node (pid 91) could not bind its named pipe (System.Net.Sockets.SocketException (13): Permission denied)');
  });

  it('follows no link a check plants in its temp directory, to a report or a report directory elsewhere', () => {
    const d = tmp();
    const outside = tmp();
    report(outside, 'MSBuild_pid-4242_ab.failure.txt', FAILURE);
    symlinkSync(join(outside, 'MSBuildTempacme'), join(d, 'MSBuildTempLinked'));
    mkdirSync(join(d, 'MSBuildTempacme'));
    symlinkSync(join(outside, 'MSBuildTempacme', 'MSBuild_pid-4242_ab.failure.txt'), join(d, 'MSBuildTempacme', 'MSBuild_pid-4242_cd.failure.txt'));
    expect(findMsbuildNodeDenial(d)).toBeNull();
  });

  // The scanner runs on the controller's event loop once a second for every check, against a directory the check
  // writes. A FIFO opened for reading waits for a writer with no time limit, which froze the controller: its timeouts,
  // backstop and cancellation never ran again.
  it('never blocks on a FIFO a check swaps in for a report between the scanner\'s look at it and its open', () => {
    const d = tmp();
    mkdirSync(join(d, 'MSBuildTempacme'));
    const fifo = join(d, 'MSBuildTempacme', 'MSBuild_pid-4242_ab.failure.txt');
    execFileSync('mkfifo', [fifo]);
    // In a child process with a time limit, since a blocked open() never returns. lstat reports the FIFO as the regular
    // file the check had there a moment before, which is what the swap looks like to the scanner.
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const lstat = fs.lstatSync;
      fs.lstatSync = (p, ...rest) => {
        const st = lstat(p, ...rest);
        if (String(p) === ${JSON.stringify(fifo)}) st.isFile = () => true;
        return st;
      };
      syncBuiltinESMExports();
      const { findMsbuildNodeDenial } = await import(${JSON.stringify(MSBUILD_MODULE)});
      process.stdout.write(JSON.stringify(findMsbuildNodeDenial(${JSON.stringify(d)})));
    `;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    expect(r.signal, `the scanner blocked opening the FIFO (stderr: ${r.stderr})`).toBeNull();
    expect(r.stdout).toBe('null');
  });

  // Review: the scanner lstat()ed MSBuildTemp* and then listed and read through it, so a check that swapped the
  // directory for a link between the two (renamex_np RENAME_SWAP in a loop) had the controller relay a line of a file
  // outside its temp directory. Simulated here: the directory is one when looked at, a link from then on.
  it('reads nothing through a report directory a check swaps for a link after the scanner looked at it', () => {
    const d = tmp();
    const outside = tmp();
    report(outside, 'MSBuild_pid-4242_ab.failure.txt', FAILURE.replace('Permission denied', 'SECRET-OUTSIDE-CONTENT'));
    const linked = join(d, 'MSBuildTempacme');
    symlinkSync(join(outside, 'MSBuildTempacme'), linked);
    const decoy = tmp();
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const lstat = fs.lstatSync;
      let looks = 0;
      fs.lstatSync = (p, ...rest) => (String(p) === ${JSON.stringify(linked)} && looks++ === 0 ? lstat(${JSON.stringify(decoy)}, ...rest) : lstat(p, ...rest));
      syncBuiltinESMExports();
      const { findMsbuildNodeDenial } = await import(${JSON.stringify(MSBUILD_MODULE)});
      process.stdout.write(JSON.stringify(findMsbuildNodeDenial(${JSON.stringify(d)})));
    `;
    const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 15_000 });
    expect(r.stderr).toBe('');
    expect(r.stdout).toBe('null');
  });

  // Review: the limit was per directory, so 4096 report directories of 256 names each were about a million names
  // listed on the controller's event loop every second.
  it('reads a bounded number of names in all, however many report directories a check makes', () => {
    const d = tmp();
    for (let i = 0; i < 5; i++) {
      mkdirSync(join(d, `MSBuildTemp${i}`));
      for (let j = 0; j < 10; j++) writeFileSync(join(d, `MSBuildTemp${i}`, `junk-${j}.txt`), '');
    }
    writeFileSync(join(d, 'MSBuildTemp4', 'MSBuild_pid-4242_ab.failure.txt'), FAILURE);
    expect(findMsbuildNodeDenial(d)?.pid).toBe(4242);
    expect(findMsbuildNodeDenial(d, 30)).toBeNull();
  });

  it('words the stopped check\'s note so the same denial in two runs shares one failure fingerprint (the pid differs)', () => {
    const exception = 'System.Net.Sockets.SocketException (13): Permission denied';
    const fix = msbuildNodeFix(checkDef('build', { command: ['dotnet', 'build'] }));
    const log = (pid: number) => `  Determining projects to restore...\n${msbuildNodeDenialNote({ pid, pipe: `/tmp/MSBuild${pid}`, exception }, fix)}\n`;
    expect(fingerprintFailure(log(4242), { id: 'build' }).fingerprint).toBe(fingerprintFailure(log(97), { id: 'build' }).fingerprint);
  });

  it.skipIf(process.getuid?.() === 0)('reads an unreadable report as no report (skipped as root, which ignores modes)', () => {
    const d = tmp();
    report(d, 'MSBuild_pid-4242_ab.failure.txt', FAILURE);
    chmodSync(join(d, 'MSBuildTempacme'), 0o000);
    try {
      expect(findMsbuildNodeDenial(d)).toBeNull();
    } finally {
      chmodSync(join(d, 'MSBuildTempacme'), 0o700);
    }
  });
});

// Orbit never changes a check's processor count (ADR 0009, addendum): a dotnet check pins one MSBuild node in its own
// command. What doctor can judge from a definition, and the exact fix it names.
describe('msbuildNodes', () => {
  const judge = (command: string[], opts: { shell?: boolean; usesDotnet?: boolean; env?: Record<string, string> } = {}) => msbuildNodes({ command, shell: opts.shell ?? false, env: opts.env ?? {} }, opts.usesDotnet ?? true);

  it('passes a dotnet MSBuild command that pins one node, in any spelling of the switch', () => {
    for (const command of [['dotnet', 'test', '-m:1'], ['/usr/local/share/dotnet/dotnet', 'build', '/maxcpucount:1', 'acme.sln'], ['dotnet', 'restore', '--maxCpuCount:1'], ['dotnet', 'clean', '-m:1']]) {
      expect(judge(command), command.join(' ')).toEqual({ kind: 'pinned' });
    }
    expect(judge(['dotnet test -m:1 tests/Acme.Tests'], { shell: true })).toEqual({ kind: 'pinned' });
    expect(judge(['CI=1 dotnet build -m:1'], { shell: true })).toEqual({ kind: 'pinned' });
  });

  it('refuses every dotnet command that runs MSBuild directly without -m:1: each starts one node per processor', () => {
    for (const verb of ['build', 'test', 'publish', 'pack', 'restore', 'msbuild', 'clean']) {
      expect(judge(['dotnet', verb, 'acme.sln']), verb).toEqual({ kind: 'unpinned', reason: `runs "dotnet ${verb}" without -m:1, so MSBuild starts a worker node per processor` });
    }
    expect(judge(['dotnet test tests/Acme.Tests'], { shell: true })).toEqual({ kind: 'unpinned', reason: 'runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor' });
  });

  // Measured under srt: `dotnet run -m:1` and `dotnet run -maxcpucount:1` start worker nodes and are refused, since dotnet
  // run hands those words to the program; `dotnet build -m:1 && dotnet run --no-build` passes.
  it('refuses dotnet run that builds, whatever switch it carries, and passes one that does not build', () => {
    const reason = 'runs "dotnet run", which builds on a worker node per processor and hands -m:1 to the program, not to MSBuild';
    expect(judge(['dotnet', 'run', '--project', 'src/Acme'])).toEqual({ kind: 'unpinned', reason });
    expect(judge(['dotnet', 'run', '--project', 'src/Acme', '-m:1'])).toEqual({ kind: 'unpinned', reason });
    expect(judge(['dotnet', 'run', '--project', 'src/Acme', '--no-build'])).toBeNull();
    expect(judge(['dotnet', 'run', '--', '--no-build'])).toEqual({ kind: 'unpinned', reason });
  });

  it('refuses a command that asks for more nodes, or a bare -m, even beside -m:1', () => {
    expect(judge(['dotnet', 'build', '-m:4'])).toEqual({ kind: 'unpinned', reason: 'asks MSBuild for 4 nodes (-m:4)' });
    expect(judge(['dotnet', 'test', '-m:1', '/maxcpucount:2'])).toEqual({ kind: 'unpinned', reason: 'asks MSBuild for 2 nodes (/maxcpucount:2)' });
    expect(judge(['dotnet', 'build', '-m'])).toEqual({ kind: 'unpinned', reason: 'passes -m, which asks MSBuild for a worker node per processor' });
  });

  it('cannot tell for a shell line with more than a chain of commands, a wrapper, make or a script, and says so', () => {
    expect(judge(['dotnet test -m:1 | tee test.log'], { shell: true })).toEqual({ kind: 'indirect', reason: 'runs dotnet in a shell line, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
    expect(judge(['dotnet build -m:1 || dotnet build'], { shell: true })).toEqual({ kind: 'indirect', reason: 'runs dotnet in a shell line, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
    expect(judge(['xargs', 'dotnet', 'test'])).toEqual({ kind: 'indirect', reason: 'runs dotnet through xargs, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
    expect(judge(['make', 'test'])).toEqual({ kind: 'indirect', reason: 'may run dotnet through make, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
    expect(judge(['./build.sh', 'test'])).toEqual({ kind: 'indirect', reason: 'may run dotnet through ./build.sh, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
    expect(judge(['cd src && make check'], { shell: true })).toEqual({ kind: 'indirect', reason: 'may run dotnet through make, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
  });

  // Review round 4: doctor's own fix for dotnet run is a chain (`dotnet build -m:1 && dotnet run --no-build`), which
  // doctor then could not judge and kept warning about.
  it('judges each command of a chain joined by &&, ; or a newline: the first unpinned one fails it', () => {
    expect(judge(['dotnet build -m:1 && dotnet run --project src/Acme --no-build'], { shell: true })).toEqual({ kind: 'pinned' });
    expect(judge(['cd src && dotnet test -m:1'], { shell: true })).toEqual({ kind: 'pinned' });
    expect(judge(['set -e; npm ci\nCI=1 dotnet test -m:1;'], { shell: true })).toEqual({ kind: 'pinned' });
    expect(judge(['cd src && npm test'], { shell: true })).toBeNull();
    expect(judge(['cd src && dotnet test'], { shell: true })).toEqual({ kind: 'unpinned', reason: 'runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor' });
    expect(judge(['dotnet build -m:1 && dotnet run'], { shell: true })).toEqual({ kind: 'unpinned', reason: 'runs "dotnet run", which builds on a worker node per processor and hands -m:1 to the program, not to MSBuild' });
    expect(judge(['dotnet test -m:1 && make e2e'], { shell: true })).toEqual({ kind: 'indirect', reason: 'may run dotnet through make, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
  });

  it('judges the command env starts, after its options and assignments', () => {
    expect(judge(['env', 'CI=1', 'dotnet', 'test'])).toEqual({ kind: 'unpinned', reason: 'runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor' });
    expect(judge(['/usr/bin/env', '-u', 'ACME_DEBUG', 'CI=1', 'dotnet', 'test', '-m:1'])).toEqual({ kind: 'pinned' });
    // Not a program that runs others: nothing to warn about in a .NET repository.
    expect(judge(['/usr/bin/env', 'node', 'scripts/lint.mjs'])).toBeNull();
    expect(judge(['env', '-S', 'dotnet test'])).toEqual({ kind: 'indirect', reason: 'runs dotnet through env, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
  });

  it('reads the script of sh -c as the shell line it is', () => {
    expect(judge(['/bin/sh', '-c', 'exit 0'])).toBeNull();
    expect(judge(['bash', '-c', 'dotnet test -m:1'])).toEqual({ kind: 'pinned' });
    expect(judge(['sh', '-c', 'dotnet build'])).toEqual({ kind: 'unpinned', reason: 'runs "dotnet build" without -m:1, so MSBuild starts a worker node per processor' });
    expect(judge(['sh', '-c', 'cd src && dotnet build -m:1'])).toEqual({ kind: 'pinned' });
    expect(judge(['sh', '-c', 'dotnet build -m:1 | tee b.log'])).toEqual({ kind: 'indirect', reason: 'runs dotnet in a shell line, so doctor cannot tell whether each of its MSBuild calls passes -m:1' });
  });

  // Review round 4: `dotnet test` hands what follows `--` to the test runner (RunSettings), not to MSBuild. Measured
  // through the runner under srt: `dotnet test P -- -m:1` is refused a worker node, `dotnet build P -- -m:1` builds.
  it('reads no node switch after the -- of dotnet test, which belongs to the test runner', () => {
    expect(judge(['dotnet', 'test', 'tests/Acme.Tests', '--', '-m:1'])).toEqual({ kind: 'unpinned', reason: 'runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor' });
    expect(judge(['dotnet test tests/Acme.Tests -- -m:1'], { shell: true })).toEqual({ kind: 'unpinned', reason: 'runs "dotnet test" without -m:1, so MSBuild starts a worker node per processor' });
    expect(judge(['dotnet', 'test', '-m:1', '--', 'RunConfiguration.MaxCpuCount=4', '-m:4'])).toEqual({ kind: 'pinned' });
    expect(judge(['dotnet', 'build', 'src/Acme', '--', '-m:1'])).toEqual({ kind: 'pinned' });
  });

  // Review round 4: DOTNET_PROCESSOR_COUNT=1 in a check's own env gives MSBuild one node, as the runner measured, and
  // doctor's fix names it as the alternative; doctor failed it anyway.
  it('passes a check whose own env sets DOTNET_PROCESSOR_COUNT=1, unless a switch asks MSBuild for more nodes', () => {
    const one = { DOTNET_PROCESSOR_COUNT: '1' };
    expect(judge(['dotnet', 'build', 'tests/Acme.Tests'], { env: one })).toEqual({ kind: 'pinned' });
    expect(judge(['dotnet', 'test', '-m'], { env: { DOTNET_PROCESSOR_COUNT: ' 1 ' } })).toEqual({ kind: 'pinned' });
    expect(judge(['dotnet', 'run', '--project', 'src/Acme'], { env: one })).toEqual({ kind: 'pinned' });
    expect(judge(['cd src && dotnet test'], { shell: true, env: one })).toEqual({ kind: 'pinned' });
    // The env reaches every dotnet a check starts, through make or a script too, whose default is then one node.
    expect(judge(['make', 'test'], { env: one })).toEqual({ kind: 'pinned' });
    expect(judge(['dotnet test | tee t.log'], { shell: true, env: one })).toEqual({ kind: 'pinned' });
    expect(judge(['dotnet', 'build', '-m:4'], { env: one })).toEqual({ kind: 'unpinned', reason: 'asks MSBuild for 4 nodes (-m:4)' });
    expect(judge(['dotnet', 'build'], { env: { DOTNET_PROCESSOR_COUNT: '2' } })).toEqual({ kind: 'unpinned', reason: 'runs "dotnet build" without -m:1, so MSBuild starts a worker node per processor' });
    expect(judge(['dotnet', 'build'], { env: { ACME: '1' } })).toEqual({ kind: 'unpinned', reason: 'runs "dotnet build" without -m:1, so MSBuild starts a worker node per processor' });
  });

  it('says nothing of a command that runs no MSBuild: another tool, a dotnet command that is not a build, or make outside a .NET repository', () => {
    expect(judge(['npm', 'test'])).toBeNull();
    expect(judge(['pytest', '-q'])).toBeNull();
    expect(judge(['dotnet', '--version'])).toBeNull();
    expect(judge(['dotnet', 'vstest', 'bin/Acme.Tests.dll'])).toBeNull();
    expect(judge(['dotnet', 'format', '--verify-no-changes'])).toBeNull();
    expect(judge(['make', 'test'], { usesDotnet: false })).toBeNull();
    expect(judge(['npm run lint'], { shell: true })).toBeNull();
  });
});

describe('msbuildNodeFix', () => {
  const fixOf = (command: string[], shell = false, id = 'test') => msbuildNodeFix(checkDef(id, { command, shell }));
  const TAIL = /\(MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under \/tmp, which the sandbox refuses; DOTNET_PROCESSOR_COUNT=1 in checks\.test\.env also works, but the test host then gets one processor too, where xunit before 2\.8 deadlocks a test that blocks on async code; docs\/troubleshooting\.md, "\.NET builds and MSBuild worker nodes"\)$/;

  it('names the check and its command with -m:1 added, ready to paste', () => {
    const fix = fixOf(['dotnet', 'test', 'tests/Acme.Tests']);
    expect(fix.startsWith('checks.test.command: ["dotnet", "test", "tests/Acme.Tests", "-m:1"] ')).toBe(true);
    expect(fix).toMatch(TAIL);
  });

  it('replaces the switch a command already has, and keeps -m:1 before the arguments after --', () => {
    expect(fixOf(['dotnet', 'build', '-m:4', 'acme.sln'])).toMatch(/^checks\.test\.command: \["dotnet", "build", "acme\.sln", "-m:1"\] /);
    expect(fixOf(['dotnet', 'build', '-m'])).toMatch(/^checks\.test\.command: \["dotnet", "build", "-m:1"\] /);
    expect(fixOf(['dotnet', 'test', 'tests/Acme.Tests', '--', 'RunConfiguration.MaxCpuCount=2'])).toMatch(/^checks\.test\.command: \["dotnet", "test", "tests\/Acme\.Tests", "-m:1", "--", "RunConfiguration\.MaxCpuCount=2"\] /);
    expect(fixOf(['dotnet test tests/Acme.Tests'], true)).toMatch(/^checks\.test\.command: \["dotnet test tests\/Acme\.Tests -m:1"\] /);
    expect(fixOf(['dotnet test -m:2 -- RunConfiguration.X=1'], true)).toMatch(/^checks\.test\.command: \["dotnet test -m:1 -- RunConfiguration\.X=1"\] /);
  });

  it('builds first and runs without building for dotnet run, which hands -m:1 to the program', () => {
    expect(fixOf(['dotnet', 'run', '--project', 'src/Acme App', '-m:1', '--', '--port', '80'])).toMatch(
      /^checks\.test\.command: \["dotnet build 'src\/Acme App' -m:1 && dotnet run --project 'src\/Acme App' --no-build -- --port 80"\] with checks\.test\.shell: true \(dotnet run hands -m:1 to the program, so build with it first, with the same configuration and framework, and run without building\) \(MSBuild worker nodes/,
    );
    expect(fixOf(['dotnet run -c Release'], true)).toMatch(/^checks\.test\.command: \["dotnet build -m:1 && dotnet run -c Release --no-build"\] \(dotnet run hands -m:1/);
  });

  it('asks for -m:1 on every MSBuild call of a command it cannot rewrite, naming the command', () => {
    expect(fixOf(['make', 'test'])).toMatch(/^pass -m:1 to every dotnet build, test, publish, pack, restore, clean or msbuild that checks\.test\.command \(\["make", "test"\]\) starts, and build before dotnet run --no-build \(MSBuild worker nodes/);
    expect(fixOf(['cd src && dotnet test | tee test.log'], true)).toMatch(/^pass -m:1 to every dotnet build, test, publish, pack, restore, clean or msbuild that checks\.test\.command \(\["cd src && dotnet test \| tee test\.log"\]\) starts, /);
  });

  // Review round 4: a check doctor refuses gets its exact fixed command whatever form it has.
  it('fixes each unpinned dotnet command of a chain, the script of sh -c, and the command env starts', () => {
    expect(fixOf(['cd src && dotnet test'], true)).toMatch(/^checks\.test\.command: \["cd src && dotnet test -m:1"\] \(MSBuild worker nodes/);
    expect(fixOf(['dotnet build -m:1 &&  dotnet test ;echo done'], true)).toMatch(/^checks\.test\.command: \["dotnet build -m:1 &&  dotnet test -m:1 ;echo done"\] \(MSBuild worker nodes/);
    expect(fixOf(['cd src && dotnet run -- --port 80'], true)).toMatch(
      /^checks\.test\.command: \["cd src && dotnet build -m:1 && dotnet run --no-build -- --port 80"\] \(dotnet run hands -m:1 to the program/,
    );
    expect(fixOf(['sh', '-c', 'dotnet test'])).toMatch(/^checks\.test\.command: \["sh", "-c", "dotnet test -m:1"\] \(MSBuild worker nodes/);
    expect(fixOf(['bash', '-c', 'dotnet run --project src/Acme'])).toMatch(/^checks\.test\.command: \["bash", "-c", "dotnet build src\/Acme -m:1 && dotnet run --project src\/Acme --no-build"\] \(dotnet run hands/);
    expect(fixOf(['env', 'CI=1', 'dotnet', 'test', '-m:4'])).toMatch(/^checks\.test\.command: \["env", "CI=1", "dotnet", "test", "-m:1"\] \(MSBuild worker nodes/);
    expect(fixOf(['env', 'CI=1', 'dotnet', 'run'])).toMatch(/^checks\.test\.command: \["env CI=1 dotnet build -m:1 && env CI=1 dotnet run --no-build"\] with checks\.test\.shell: true \(dotnet run hands/);
    expect(fixOf(['CI=1 dotnet run'], true)).toMatch(/^checks\.test\.command: \["CI=1 dotnet build -m:1 && CI=1 dotnet run --no-build"\] \(dotnet run hands/);
    // A chain that also runs make or a script: -m:1 on every MSBuild call it starts.
    expect(fixOf(['dotnet test && make e2e'], true)).toMatch(/^pass -m:1 to every dotnet build, test, publish, pack, restore, clean or msbuild that checks\.test\.command \(\["dotnet test && make e2e"\]\) starts/);
  });

  it('names DOTNET_PROCESSOR_COUNT=1 as the alternative only to a check whose env does not set it already', () => {
    const fix = msbuildNodeFix(checkDef('test', { command: ['dotnet', 'build', '-m:4'], env: { DOTNET_PROCESSOR_COUNT: '1' } }));
    expect(fix).toBe('checks.test.command: ["dotnet", "build", "-m:1"] (MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under /tmp, which the sandbox refuses; docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")');
  });

  it('gives the reason once for several fixes, naming each env the alternative could go in', () => {
    const a = msbuildFix(checkDef('unit', { command: ['dotnet', 'test'] }));
    const b = msbuildFix(checkDef('pack', { command: ['dotnet', 'pack'] }));
    const install = msbuildFix(checkDef('orbit-install', { command: ['dotnet', 'restore'] }), { command: 'dependencies.install_command', env: null });
    expect(a).toEqual({ change: 'checks.unit.command: ["dotnet", "test", "-m:1"]', env: 'checks.unit.env' });
    expect(install.env).toBeNull();
    expect(msbuildFixReason([a, b, install])).toBe(
      '(MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under /tmp, which the sandbox refuses; DOTNET_PROCESSOR_COUNT=1 in checks.unit.env and checks.pack.env also works, but the test host then gets one processor too, where xunit before 2.8 deadlocks a test that blocks on async code; docs/troubleshooting.md, ".NET builds and MSBuild worker nodes")',
    );
    expect(msbuildNodeFix(checkDef('unit', { command: ['dotnet', 'test'] }))).toBe(`${a.change} ${msbuildFixReason([a])}`);
  });

  it('names the install command where the dependency install is meant, which has no env of its own, and a generic fix without a check', () => {
    const install = msbuildNodeFix(checkDef('orbit-install', { command: ['dotnet', 'restore', '--locked-mode'] }), { command: 'dependencies.install_command', env: null });
    expect(install).toMatch(/^dependencies\.install_command: \["dotnet", "restore", "--locked-mode", "-m:1"\] \(MSBuild worker nodes cannot run in the check sandbox: each binds a named pipe under \/tmp, which the sandbox refuses; docs\/troubleshooting\.md/);
    expect(msbuildNodeFix(null)).toMatch(/^pass -m:1 to every dotnet build, test, publish, pack, restore, clean or msbuild a check starts, and build before dotnet run --no-build \(MSBuild worker nodes .*DOTNET_PROCESSOR_COUNT=1 in a check's env also works, but the test host then gets one processor too/);
  });
});

// The doctor's .NET build probe builds as the check does, so doctor and the runner agree (review round 2).
describe('probeNodeSwitches', () => {
  it('carries the node switches of a check that runs dotnet, as written', () => {
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'test', '-m:1'] }))).toEqual(['-m:1']);
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'test', '-maxcpucount:1'] }))).toEqual(['-maxcpucount:1']);
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'test'] }))).toEqual([]);
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'build', '-m:4'] }))).toEqual(['-m:4']);
    expect(probeNodeSwitches(checkDef('t', { command: ['cd src && dotnet test -m:1'], shell: true }))).toEqual(['-m:1']);
  });

  it('builds with -m:1, the fix doctor names, for a check whose command does not run dotnet itself, or with no check at all', () => {
    expect(probeNodeSwitches(checkDef('t', { command: ['make', 'test'] }))).toEqual(['-m:1']);
    expect(probeNodeSwitches(null)).toEqual(['-m:1']);
  });

  // Review round 4: the probe carried the -m:1 of `dotnet test P -- -m:1`, which the test runner gets, so doctor passed
  // a check the runner stops; and a check like `dotnet format` built the probe with no switch and was refused.
  it('reads the switches as MSBuild gets them: none after the -- of dotnet test, none of dotnet run, one per call of a chain', () => {
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'test', 'tests/Acme.Tests', '--', '-m:1'] }))).toEqual([]);
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'run', '--project', 'src/Acme', '-m:1'] }))).toEqual([]);
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet build -m:1 && dotnet test -m:1 && dotnet run --no-build'], shell: true }))).toEqual(['-m:1']);
    expect(probeNodeSwitches(checkDef('t', { command: ['env', 'CI=1', 'dotnet', 'test', '-maxcpucount:1'] }))).toEqual(['-maxcpucount:1']);
    expect(probeNodeSwitches(checkDef('t', { command: ['sh', '-c', 'cd src && dotnet build -m:1'] }))).toEqual(['-m:1']);
  });

  it('builds with -m:1 for a check whose dotnet commands do not build (dotnet format, dotnet vstest)', () => {
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'format', '--verify-no-changes'] }))).toEqual(['-m:1']);
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'vstest', 'bin/Acme.Tests.dll'] }))).toEqual(['-m:1']);
    expect(probeNodeSwitches(checkDef('t', { command: ['dotnet', 'run', '--no-build'] }))).toEqual(['-m:1']);
  });
});

describe('msbuildNodeDenialNote', () => {
  it('names the denied node and pipe, why Orbit stopped the check, and the fix for that check', () => {
    const fix = msbuildNodeFix(checkDef('build', { command: ['dotnet', 'build'] }));
    const note = msbuildNodeDenialNote({ pid: 4242, pipe: '/tmp/MSBuild4242', exception: 'System.Net.Sockets.SocketException (13): Permission denied' }, fix);
    expect(note).toBe(`the check sandbox denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied); MSBuild waits 30 s for each of ten node starts before it fails, so Orbit stopped the check. Fix: ${fix}`);
    expect(note).toContain('checks.build.command: ["dotnet", "build", "-m:1"]');
  });

  // Review: the note said Orbit stopped the check when the late look found the record of a check that had already
  // failed on its own (MSBuild fails at once on Linux; the dotnet format baseline ended exit=1, not 143).
  it('says the check failed on it, not that Orbit stopped it, for a check that ended before the runner\'s next look', () => {
    const fix = msbuildNodeFix(checkDef('build', { command: ['dotnet', 'build'] }));
    const note = msbuildNodeDenialNote({ pid: 4242, pipe: '/tmp/MSBuild4242', exception: 'System.Net.Sockets.SocketException (13): Permission denied' }, fix, false);
    expect(note).toBe(`the check sandbox denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242 (System.Net.Sockets.SocketException (13): Permission denied), and the check failed on it before the runner's next look. Fix: ${fix}`);
    expect(note).not.toMatch(/Orbit stopped/);
  });
});

describe('runStoppingRefusedNodes', () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const NAME = 'MSBuild_pid-4242_0123456789abcdef0123456789abcdef.failure.txt';

  it('stops a command once MSBuild records a refused node, and says Orbit stopped it', async () => {
    const d = tmp();
    const ran = await runStoppingRefusedNodes(
      d,
      (signal) =>
        new Promise<{ cancelled: boolean }>((resolve) => {
          report(d, NAME, FAILURE);
          signal.addEventListener('abort', () => resolve({ cancelled: true }));
        }),
      undefined,
      20,
    );
    expect(ran).toMatchObject({ stopped: true, denial: { pid: 4242 } });
  });

  // A review of #26 found that a command that had already exited on its own (MSBuild fails at once on Linux) read as
  // stopped by Orbit when a look found the record before the run's result came back: its real exit code was replaced by
  // null and its note said Orbit stopped it. The abort only stops a command that is still running (execCapture reports
  // that as `cancelled`).
  it('does not say Orbit stopped a command that exited on its own before the abort reached it', async () => {
    const d = tmp();
    const ran = await runStoppingRefusedNodes(
      d,
      async () => {
        report(d, NAME, FAILURE);
        await wait(300);
        return { cancelled: false };
      },
      undefined,
      20,
    );
    expect(ran.denial).toMatchObject({ pid: 4242 });
    expect(ran.stopped).toBe(false);
  });

  it('does not say Orbit stopped a command a cancellation had stopped first', async () => {
    const d = tmp();
    const outer = new AbortController();
    setTimeout(() => outer.abort(), 50);
    const ran = await runStoppingRefusedNodes(
      d,
      (signal) =>
        new Promise<{ cancelled: boolean }>((resolve) => {
          signal.addEventListener('abort', () => {
            report(d, NAME, FAILURE);
            setTimeout(() => resolve({ cancelled: true }), 300);
          });
        }),
      outer.signal,
      20,
    );
    expect(ran.denial).toMatchObject({ pid: 4242 });
    expect(ran.stopped).toBe(false);
  });
});
