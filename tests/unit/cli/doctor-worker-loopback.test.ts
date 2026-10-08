// Issue #31: in a .NET retest five of six implementer sessions could not run their own `dotnet test`: VSTest's test host
// listens on loopback, which the worker sandbox refused (SocketException (13) at Socket.Bind), so the workers submitted
// untested changes while the checks, which may listen, ran the same tests. On macOS a worker still may not listen, in
// either tier: Seatbelt cannot limit a listener to loopback (srt's and Claude Code's allowLocalBinding admit every address
// of the machine, measured), and a worker runs model-driven commands. `orbit doctor` says so, and what runs them instead.
import { describe, expect, it } from 'vitest';
import { workerLoopbackCheck } from '../../../src/cli/commands/doctor-workers.ts';
import { defaultCheck, defaultConfig } from '../../../src/policy/config.ts';
import type { CheckDefinition, OrbitConfig } from '../../../src/policy/types.ts';

function config(checks: Partial<CheckDefinition>[] = []): OrbitConfig {
  const c = defaultConfig('autonomous');
  c.checks = Object.fromEntries(checks.map((x) => [x.id!, { ...defaultCheck(x.id!), ...x } as CheckDefinition]));
  return c;
}

const WHY =
  'neither worker sandbox on macOS (sandbox-runtime, or Claude Code\'s own) can limit a listener to loopback: Seatbelt lets a process listen on every address of this machine or on none, so a test server on 0.0.0.0 would be reachable from the network, and a worker runs model-driven commands (ADR 0001, "Workers and loopback")';

describe('workerLoopbackCheck', () => {
  it('warns on macOS for a .NET repository: workers cannot run its test host in either tier, and the checks that may listen run it', () => {
    const c = workerLoopbackCheck({ config: config([{ id: 'unit', command: ['dotnet', 'test'] }, { id: 'lint', command: ['dotnet', 'format'], local_binding: false }]), files: ['acme.sln', 'src/Acme/Acme.csproj'], platform: 'darwin' });
    expect(c).toMatchObject({ id: 'workers.loopback', area: 'isolation', status: 'warn' });
    expect(c.summary).toBe(
      "on macOS workers cannot run test hosts that need a loopback socket (dotnet test's VSTest test host, Gradle's test workers, a test that starts a server), in either worker tier, and this repository's tests need one, so a worker submits changes it could not test; the checks that may listen run them",
    );
    expect(c.details).toEqual([
      'this repository uses .NET: every dotnet test listens on loopback for its test host, so a worker\'s aborts with "SocketException (13): Permission denied"',
      WHY,
      'check unit may listen (its own local_binding), so it runs tests a worker cannot',
    ]);
    expect(c.missing).toBe("a worker sandbox that limits a listener to loopback, which macOS's Seatbelt cannot express");
    expect(c.fix).toBe(
      'nothing to set in Orbit on macOS: keep local_binding (the default) on the checks that run these tests, which test every change a worker submits; on Linux every worker sandbox has a loopback of its own, so workers there run them too',
    );
  });

  it('names Gradle too, not Maven (Surefire forks over pipes by default), and says when no check may listen either', () => {
    const gradle = workerLoopbackCheck({ config: config([{ id: 'unit', command: ['./gradlew', 'test'], local_binding: false }]), files: ['build.gradle.kts', 'settings.gradle.kts', 'app/build.gradle.kts'], platform: 'darwin' });
    expect(gradle.status).toBe('warn');
    expect(gradle.summary).toMatch(/; no check may listen either \(local_binding: false on every check\), so nothing here runs them$/);
    expect(gradle.details).toEqual(["this repository uses Gradle: its test workers connect to the build over loopback, so a worker's gradle test cannot run", WHY]);
    expect(workerLoopbackCheck({ config: config(), files: ['pom.xml', 'src/main/java/Acme.java'], platform: 'darwin' }).status).toBe('pass');
  });

  it('passes on macOS for a repository with no such runner, saying what workers cannot run', () => {
    const c = workerLoopbackCheck({ config: defaultConfig('autonomous'), files: ['package.json', 'src/a.ts'], platform: 'darwin' });
    expect(c).toMatchObject({ id: 'workers.loopback', area: 'isolation', status: 'pass', missing: null, fix: null });
    expect(c.summary).toBe(
      "on macOS workers cannot run test hosts that need a loopback socket (dotnet test's VSTest test host, Gradle's test workers, a test that starts a server), in either worker tier; this repository uses no runner that needs one on every run (.NET, Gradle), and a test that starts its own server runs in the checks",
    );
    expect(c.details).toEqual([WHY]);
  });

  it('passes on Linux, where every worker sandbox has a loopback of its own', () => {
    const c = workerLoopbackCheck({ config: config(), files: ['acme.sln'], platform: 'linux' });
    expect(c).toMatchObject({ id: 'workers.loopback', status: 'pass', details: [], missing: null, fix: null });
    expect(c.summary).toBe('workers can run test suites that listen on loopback: on Linux every worker sandbox has a loopback of its own, which nothing outside it can reach');
  });
});
