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
  /** Allow listening on loopback. Only UI app fixtures need it. */
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

export interface IsolationProvider {
  readonly kind: 'sandbox-runtime' | 'container' | 'none';
  available(): Promise<{ ok: boolean; detail: string }>;
  wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand;
}
