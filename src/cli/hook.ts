/**
 * `orbit hook pre-tool-use`: Claude Code's PreToolUse guard, as a fail-closed
 * wrapper. In Claude Code's hook protocol only exit code 2 blocks a tool call;
 * exit 1, a crash, a timeout or a missing binary all let it through. So this
 * wrapper makes 2 the default, installs handlers that turn any uncaught error
 * into 2, and only then loads the policy module (a broken or missing module is
 * an error like any other). The guard's own entry then sets the real answer.
 *
 * This file imports nothing at load time: nothing may throw before the
 * handlers exist.
 */

const DENY = (reason: string): string =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

function failClosed(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  const reason = `Orbit guard failed closed: ${message}`;
  try {
    process.stdout.write(DENY(reason));
    process.stderr.write(`${reason}\n`);
  } finally {
    process.exit(2);
  }
}

export async function hookMain(args: readonly string[]): Promise<void> {
  process.exitCode = 2;
  process.on('uncaughtException', failClosed);
  process.on('unhandledRejection', failClosed);
  try {
    if (args[0] !== 'pre-tool-use') throw new Error(`unknown hook ${JSON.stringify(args[0] ?? '')}; only pre-tool-use exists`);
    const guard = await import('../policy/guard-hook.ts');
    await guard.runGuardHookProcess();
  } catch (err) {
    failClosed(err);
  }
}
