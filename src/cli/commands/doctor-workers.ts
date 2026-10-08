/**
 * `orbit doctor`: whether workers can run test suites that listen on loopback (issue #31). A worker runs the
 * repository's tests as a check does, and many runners listen there: VSTest (`dotnet test`) for its test host on every
 * run, Gradle's test workers, and any test that starts a server. In a .NET retest five of six implementers could not run
 * their own `dotnet test` (SocketException (13) at Socket.Bind) and submitted untested changes, while the checks ran the
 * same tests. On macOS that stays so, in either worker tier: Seatbelt lets a process listen on every address of the
 * machine or on none (srt's and Claude Code's allowLocalBinding admit 0.0.0.0 and the machine's network address, and a
 * rule for "localhost" does too, measured), so a worker, which runs model-driven commands, may not listen at all
 * (isolation/profiles.ts profileForWorker). This says so, and what runs those tests instead. On Linux every worker sandbox
 * has a loopback of its own, which it may always use.
 */
import { basename } from 'node:path';
import type { ToolchainId } from '../../isolation/toolchains.ts';
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
    const summary = 'workers can run test suites that listen on loopback: on Linux every worker sandbox has a loopback of its own, which nothing outside it can reach';
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
  const who = listening.length > 0 ? 'the checks that may listen run them' : 'no check may listen either (local_binding: false on every check), so nothing here runs them';
  return {
    id,
    area,
    status: 'warn',
    summary: `${cannot}, and this repository's tests need one, so a worker submits changes it could not test; ${who}`,
    details: [...runners, WHY, ...listening.map((check) => `check ${check.id} may listen (its own local_binding), so it runs tests a worker cannot`)],
    missing: "a worker sandbox that limits a listener to loopback, which macOS's Seatbelt cannot express",
    fix: 'nothing to set in Orbit on macOS: keep local_binding (the default) on the checks that run these tests, which test every change a worker submits; on Linux every worker sandbox has a loopback of its own, so workers there run them too',
  };
}

export interface WorkerToolchainsInput {
  /** The tier Claude workers run in, as the adapter chooses it (claudeWorkerTier in doctor.ts). */
  tier: 'os-sandbox' | 'claude-sandbox';
  /** The toolchains the repository uses (isolation/toolchains.ts detectToolchains). */
  toolchains: readonly ToolchainId[];
}

/**
 * The toolchains whose builds write state outside the worktree, which a worker gets in a private toolchain directory
 * under its worker directory (isolation/toolchains.ts, mode `worker`), and what fails first without it. In the
 * claude-sandbox tier Claude Code's sandbox lets Bash write the worktree and the worker's temp directory only, so a
 * worker's own build cannot start there (review of issue #31; Go and Rust measured with the real CLI). .NET, Python and
 * Node keep nothing a test run must write in that directory.
 */
const SCRATCH_BOUND: readonly { id: ToolchainId; name: string; detail: string }[] = [
  { id: 'go', name: 'Go', detail: 'go: GOCACHE and GOPATH are in the worker\'s private toolchain directory; go build and go test fail first ("failed to initialize build cache ... operation not permitted")' },
  { id: 'rust', name: 'Rust', detail: 'rust: CARGO_TARGET_DIR is in the worker\'s private toolchain directory; cargo build and cargo test fail first ("failed to create directory ... Operation not permitted")' },
  { id: 'jvm', name: 'JVM', detail: "jvm: GRADLE_USER_HOME and Maven's local repository are in the worker's private toolchain directory, which Gradle writes on every build and Maven whenever it resolves an artifact" },
];

/**
 * `workers.toolchains`: whether workers can build and test the repository's toolchains in the tier they run in. Only
 * the claude-sandbox tier has the gap; the os-sandbox tier confines the whole worker with srt, which may write the
 * worker directory (profileForWorker). Making that directory writable in the claude-sandbox tier is a follow-up.
 */
export function workerToolchainsCheck(input: WorkerToolchainsInput): DoctorCheck[] {
  if (input.tier !== 'claude-sandbox') return [];
  const hit = SCRATCH_BOUND.filter((t) => input.toolchains.includes(t.id));
  if (hit.length === 0) return [];
  const names = hit.map((t) => t.name);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} or ${names.at(-1)!}`;
  return [
    {
      id: 'workers.toolchains',
      area: 'isolation',
      status: 'warn',
      summary: `workers run in the claude-sandbox tier, where Claude Code's sandbox does not let their commands write their build state, so a worker cannot build or test ${list} code here and submits changes it could not test; the checks still run them`,
      details: hit.map((t) => t.detail),
      missing: 'the os-sandbox tier for workers, where the whole worker process is confined by sandbox-runtime and may write its build state',
      fix: 'export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token) and use isolation.provider: sandbox-runtime (see claude.worker-tier)',
    },
  ];
}
