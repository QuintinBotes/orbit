/**
 * The two policy decisions that must stay with a person. They can change which plugins enter a worker session or
 * whether sanitized code can be sent to Codex, so doctor must not make them sound like an agent action.
 */
export const HUMAN_POLICY_CONFIG_NOTE = 'A person, not an agent, must make any edit to agents.allowed_plugins or providers.codex.data_policy_eligible in .orbit/config.yaml. Do not ask an agent to apply this fix. An auto-mode classifier may flag worker launches.';

export function withHumanPolicyConfigNote(fix: string): string {
  return `${fix}; ${HUMAN_POLICY_CONFIG_NOTE}`;
}
