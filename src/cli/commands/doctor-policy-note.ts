/**
 * The two policy decisions that must stay with a person. They can change which plugins enter a worker session or
 * whether sanitized code can be sent to Codex, so doctor must not make them sound like an agent action. It is advice,
 * not a boundary: nothing tells a person's edit from an interactive agent's (issue #111).
 */
export const HUMAN_POLICY_CONFIG_NOTE = 'A person, not an agent, must make any edit to agents.allowed_plugins or providers.codex.data_policy_eligible in .orbit/config.yaml. Do not ask an agent to apply this fix. An auto-mode classifier may flag worker launches. Orbit does not enforce this: only worker sessions are blocked from editing .orbit/config.yaml.';

export function withHumanPolicyConfigNote(fix: string): string {
  return `${fix}; ${HUMAN_POLICY_CONFIG_NOTE}`;
}
