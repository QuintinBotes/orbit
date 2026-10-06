/**
 * Which worker roles may run Bash, and through what. A writer's Bash is
 * confined by the OS sandbox to its worktree and temp directory. A read-only
 * worker has no Bash unless it is an experiment worker (the diagnosis role),
 * which needs to run tests and repro scripts: its sandbox then makes the
 * worktree read-only and only the worker's private temp directory writable
 * (readOnlyProfile, and filesystem.allowWrite in the claude-sandbox tier),
 * and the network stays on the policy's allowlist. Edit tools stay denied
 * for every read-only worker; this grant is Bash and nothing else.
 */
export interface BashGrantInput {
  readOnly: boolean;
  /** The worker is a read-only experiment worker (diagnosis): it may run commands but never writes outside its scratch area. */
  experiments: boolean;
  tier: 'os-sandbox' | 'claude-sandbox';
}

export interface BashGrant {
  /** A bare `Bash` allow rule (permissions.allow and --allowedTools): only where the OS confines every command. */
  allowRule: boolean;
  /** Claude Code's own sandbox auto-approves Bash (autoAllowBashIfSandboxed): the claude-sandbox tier. */
  autoAllowInSandbox: boolean;
}

export function bashGrant(i: BashGrantInput): BashGrant {
  const granted = !i.readOnly || i.experiments;
  return { allowRule: granted && i.tier === 'os-sandbox', autoAllowInSandbox: granted };
}
