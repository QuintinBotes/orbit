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

/** A rejection that hides what would be wrong next: the selector reports one reason per provider, the first it finds. */
const MASKING_REASON = /^(no credentials for|credentials for) |data_policy_eligible is not true/;

/** What a simulated re-selection assumes is already met: the selector checks the login, then the data policy, then the model. */
export interface AssumedMet {
  login: boolean;
  dataPolicy: boolean;
}

/**
 * Every unmet prerequisite of the reviewer check, not just the first per provider. review/select.ts stops at the
 * first problem of a provider (login, then data policy, then model), so fixing one used to reveal the next on the
 * following doctor run. `simulate` re-runs the selection as if the given providers had met the stated prerequisites
 * and returns its rejections; whatever it still rejects them for is an unmet prerequisite too.
 */
export function allReviewPrerequisites<T extends { provider: string; reason: string }>(first: readonly T[], simulate: (providers: readonly string[], assumed: AssumedMet) => readonly T[]): T[] {
  const masked = [...new Set(first.filter((a) => MASKING_REASON.test(a.reason)).map((a) => a.provider))];
  if (masked.length === 0) return [...first];
  const seen = new Set(first.map((a) => `${a.provider}\u0000${a.reason}`));
  const out = [...first];
  for (const assumed of [{ login: true, dataPolicy: false }, { login: true, dataPolicy: true }]) {
    for (const a of simulate(masked, assumed)) {
      const key = `${a.provider}\u0000${a.reason}`;
      if (!masked.includes(a.provider) || seen.has(key)) continue;
      seen.add(key);
      out.push(a);
    }
  }
  return out;
}
