/**
 * How a message names an Orbit command so the reader can act on it (docs/decisions/0006-plugin-packaging.md).
 * A plugin user has no `orbit` in their terminal: the plugin's bin/orbit is on the PATH of Claude Code's Bash tool
 * only, and the common steps are skills. bin/orbit marks that by setting ORBIT_PLUGIN_ROOT, since Claude Code does not
 * export CLAUDE_PLUGIN_ROOT to Bash tool commands.
 *
 * How the process was started is process-wide, so messages built deep in the policy or state layers read it here;
 * the CLI's main() records its context's environment so in-process callers (tests) get the same answer.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The commands that have a skill of the same name (plugin/skills/<name>). */
const SKILLS: ReadonlySet<string> = new Set(['init', 'doctor', 'run', 'status', 'resume', 'repair', 'verify']);

let invocationEnv: Env = process.env;

/** The environment that says how this process was invoked; the CLI's main() sets it from its context. */
export function setInvocationEnv(env: Env): void {
  invocationEnv = env;
}

/** Whether this process was started through the plugin's bin/orbit. */
export function viaPlugin(env: Env = invocationEnv): boolean {
  return typeof env.ORBIT_PLUGIN_ROOT === 'string' && env.ORBIT_PLUGIN_ROOT !== '';
}

/**
 * `command` ("init", "service install") in the form that works for whoever runs this process: the quoted terminal
 * command, or under the plugin the skill (when there is one) and the Bash-tool command. `quote: false` leaves the
 * command bare, for a `fix:` line that is the command itself.
 */
export function orbitHint(command: string, env: Env = invocationEnv, opts: { quote?: boolean } = {}): string {
  const cli = opts.quote === false ? `orbit ${command}` : `"orbit ${command}"`;
  if (!viaPlugin(env)) return cli;
  return SKILLS.has(command) ? `/orbit:${command} (or ${cli} in Claude Code's Bash tool)` : `${cli} in Claude Code's Bash tool`;
}
