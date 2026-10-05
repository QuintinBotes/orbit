/**
 * Isolation for untrusted execution: model workers' shell commands, and the
 * repository's own checks (a test suite is code from the repository, so it is
 * as untrusted as the model that may have just edited it).
 *
 * Providers:
 *   sandbox-runtime  OS sandbox (macOS Seatbelt / Linux bubblewrap) with a
 *                    filesystem write allowlist and an egress domain allowlist.
 *   container        Docker: adds CPU, memory and process-count limits.
 *   none             Refused for unattended runs unless explicitly allowed.
 */
export interface SandboxProfile {
  /** Absolute paths the process may write. Everything else is read-only or denied. */
  writablePaths: string[];
  /** Absolute paths that must not be readable (credentials, other repos, Orbit state). */
  denyReadPaths: string[];
  /** Egress allowlist. Empty = no network. */
  allowedHosts: string[];
  /** Allow listening on loopback. UI app fixtures, and checks whose definition says `local_binding` (the default). */
  allowLocalBinding?: boolean;
  /**
   * A UI check's browser run, and nothing else (never the application under test or a worker). On macOS the
   * sandbox-runtime provider then lets Chromium register and look up its Mach rendezvous service, and only that
   * (docs/decisions/0001-runtime-choices.md, "Browsers under sandbox-runtime on macOS"). Other providers and platforms
   * ignore it.
   */
  chromiumMachRendezvous?: boolean;
  limits: {
    timeoutMs: number;
    memoryMb: number | null;
    cpus: number | null;
    pids: number | null;
  };
}

export interface WrappedCommand {
  argv: string[];
  env: Record<string, string>;
  /** Files written for this invocation (sandbox settings), removed by cleanup(). */
  cleanup(): void;
  /** What this wrapping does not enforce, for the evidence record and `orbit doctor`. */
  limitations: string[];
  /** Changes this wrapping made to the provider's usual confinement (`chromium-mach-rendezvous`); recorded with the evidence. */
  adjustments?: string[];
  /**
   * With the chromium-mach-rendezvous adjustment: why the srt preload refused to start the sandbox, as it recorded it
   * where the sandbox cannot write, or null. Read it before cleanup(). A command's exit code alone cannot tell, since srt
   * passes the command's own through.
   */
  preloadRefusal?: () => string | null;
  /** The sandbox runtime's version, when the provider can tell (srt's package version). */
  runtimeVersion?: string | null;
}

export interface WrapOptions {
  cwd: string;
  env: Record<string, string>;
  /**
   * Absolute paths of files the caller will hand the wrapped command as descriptors 0 to 2, opened for writing
   * (stdout and stderr appended to a log, as spawnDetached does for an application that must outlive the controller).
   * Pipes, /dev/null, a descriptor opened read-only and a file the sandbox can already read need nothing. A provider
   * that confines file access by path must keep these usable: under macOS Seatbelt a descriptor opened for writing on
   * a path the sandbox may not read fails fstat with EPERM, and node aborts at startup when fstat fails on descriptor
   * 0, 1 or 2. Naming a file here makes it readable by the command, nothing more; it is never made writable by path.
   */
  stdioFiles?: string[];
}

export interface IsolationProvider {
  readonly kind: 'sandbox-runtime' | 'container' | 'none';
  /**
   * Every wrapped command gets its own network namespace, so a server one wrapped command listens on is unreachable
   * from the host and from every other wrapped command (srt on Linux). A UI check then runs the application and the
   * browser in one wrapped launcher (src/ui/single-sandbox.ts). Absent or false: wrapped commands share the host's loopback.
   * Containers have it too: each runs with --network none.
   */
  readonly privateLoopback?: boolean;
  /**
   * The node that runs that launcher inside the wrapped command: a container has the image's node on its PATH, not the
   * host's. Absent: the controller's own node (process.execPath), which a sandbox on the host can run.
   */
  readonly launcherNode?: string;
  available(): Promise<{ ok: boolean; detail: string }>;
  wrap(argv: string[], profile: SandboxProfile, opts: WrapOptions): WrappedCommand;
}
