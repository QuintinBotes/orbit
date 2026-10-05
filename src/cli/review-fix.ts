/**
 * What to do about a reviewer that cannot be used, from the reasons review/select.ts gives for each provider it rejected.
 * Shared by `orbit doctor` and the refusal `orbit run` gives before it creates a run, so both name the same fix.
 */
import { LOGIN_COMMANDS } from '../recovery/index.ts';

const REVIEW_FIX_GENERIC = 'log in to the reviewer provider and set providers.<id>.data_policy_eligible: true if sending sanitized code to it is permitted';

/**
 * The fix that matches why each provider was rejected as reviewer (review/select.ts words the reasons), so a
 * provider that is logged in and eligible but has no qualified model is not told to log in again.
 */
export function reviewFix(alternatives: readonly { provider: string; reason: string }[]): string {
  const fixes: string[] = [];
  const add = (f: string): void => {
    if (!fixes.includes(f)) fixes.push(f);
  };
  for (const { provider, reason } of alternatives) {
    if (/^no model of "[^"]+" is qualified for review/.test(reason)) add(`for ${provider}: run "orbit models refresh" (it reads the provider's model catalog), or set providers.${provider}.model in .orbit/config.yaml to a model you accept for review`);
    else if (/data_policy_eligible is not true/.test(reason)) add(`for ${provider}: set providers.${provider}.data_policy_eligible: true if sending sanitized code to it is permitted`);
    else if (/^(no credentials for|credentials for) /.test(reason)) add(`for ${provider}: ${LOGIN_COMMANDS[provider] ?? `${provider} login`}`);
    else if (/is not offered by the adapter/.test(reason)) add(`for ${provider}: set providers.${provider}.model to a model its CLI offers ("orbit models refresh" lists them)`);
  }
  return fixes.length > 0 ? fixes.join('; ') : REVIEW_FIX_GENERIC;
}
