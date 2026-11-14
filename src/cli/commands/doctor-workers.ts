/**
 * `orbit doctor`: whether workers can run test suites that listen on loopback (issue #31). A worker runs the
 * repository's tests as a check does, and many runners listen there: VSTest (`dotnet test`) for its test host on every
 * run, Gradle's test workers, and any test that starts a server. In a .NET retest five of six implementers could not run
 * their own `dotnet test` (SocketException (13) at Socket.Bind) and submitted untested changes, while the checks ran the
 * same tests. On macOS that stays so, in either worker tier: Seatbelt lets a process listen on every address of the
 * machine or on none (srt's and Claude Code's allowLocalBinding admit 0.0.0.0 and the machine's network address, and a
 * rule for "localhost" does too, measured), so a worker, which runs model-driven commands, may not listen at all
 * (isolation/profiles.ts profileForWorker). This says so, and what runs those tests instead: the test checks that may
 * listen. On Linux srt starts every sandbox in a network namespace of its own (bwrap --unshare-net), whose loopback it may
 * always use; that rests on srt's source, not a measurement, and the message says so.
 */
import { basename } from 'node:path';
import { checkCategory } from '../../policy/config.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { DoctorCheck } from './doctor.ts';

export interface WorkerLoopbackInput {
  config: OrbitConfig;
  /** The repository's tracked files, relative (git ls-files); empty without a repository. */
  files: readonly string[];
  platform: NodeJS.Platform;
}

const RUNNERS = "dotnet test's VSTest test host, Gradle's test workers, a test that starts a server";
const DOTNET_FILE = /\.(sln|slnx|csproj|fsproj|vbproj)$/;
const GRADLE_FILES = new Set(['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradlew']);
const WHY =
  'neither worker sandbox on macOS (sandbox-runtime, or Claude Code\'s own) can limit a listener to loopback: Seatbelt lets a process listen on every address of this machine or on none, so a test server on 0.0.0.0 would be reachable from the network, and a worker runs model-driven commands (ADR 0001, "Workers and loopback")';

export function workerLoopbackCheck(input: WorkerLoopbackInput): DoctorCheck {
  const id = 'workers.loopback';
  const area = 'isolation';
  if (input.platform === 'linux') {
    const summary = "workers can run test suites that listen on loopback: on Linux srt starts every worker sandbox in a network namespace of its own, with a loopback nothing outside it can reach (from srt's source, not measured by Orbit)";
    return { id, area, status: 'pass', summary, details: [], missing: null, fix: null };
  }
  const cannot = `on macOS workers cannot run test hosts that need a loopback socket (${RUNNERS}), in either worker tier`;
  const runners: string[] = [];
  if (input.files.some((f) => DOTNET_FILE.test(f))) runners.push('this repository uses .NET: every dotnet test listens on loopback for its test host, so a worker\'s aborts with "SocketException (13): Permission denied"');
  if (input.files.some((f) => GRADLE_FILES.has(basename(f)))) runners.push("this repository uses Gradle: its test workers connect to the build over loopback, so a worker's gradle test cannot run");
  if (runners.length === 0) {
    const summary = `${cannot}; this repository uses no runner that needs one on every run (.NET, Gradle), and a test that starts its own server runs in the checks`;
    return { id, area, status: 'pass', summary, details: [WHY], missing: null, fix: null };
  }
  // `!== false`: a definition frozen into an older snapshot has no key and reads as the default.
  const listening = Object.values(input.config.checks).filter((check) => check.local_binding !== false);
  // The tests run in the test checks; a build or lint check that may listen runs none of them.
  const testing = listening.filter((check) => check.kind === 'command' && checkCategory(check) === 'test');
  const who =
    testing.length > 0
      ? 'the test checks that may listen run them'
      : listening.length > 0
        ? 'no test check may listen (local_binding: false on each), so nothing here runs them'
        : 'no check may listen either (local_binding: false on every check), so nothing here runs them';
  return {
    id,
    area,
    status: 'warn',
    summary: `${cannot}, and this repository's tests need one, so a worker submits changes it could not test; ${who}`,
    details: [...runners, WHY, ...testing.map((check) => `check ${check.id} may listen (its own local_binding), so it runs tests a worker cannot`)],
    missing: "a worker sandbox that limits a listener to loopback, which macOS's Seatbelt cannot express",
    fix: "nothing to set in Orbit on macOS: keep local_binding (the default) on the checks that run these tests, which test every change a worker submits; on Linux srt starts every worker sandbox in a network namespace of its own (from srt's source, not measured by Orbit), so workers there can run them too",
  };
}
