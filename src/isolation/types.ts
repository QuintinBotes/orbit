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
  available(): Promise<{ ok: boolean; detail: string }>;
  wrap(argv: string[], profile: SandboxProfile, opts: WrapOptions): WrappedCommand;
}
