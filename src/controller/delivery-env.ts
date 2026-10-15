/**
 * What a delivering run needs from its environment before it is worth starting: the gh CLI and a GH_TOKEN the
 * controller can see (delivery refuses a broad keyring login). One function judges it for `orbit run` admission, for
 * `orbit doctor`, and for the controller's own preflight (a run handed to the service), so the three cannot disagree.
 * It checks presence only; whether the token is valid is `gh auth status`, which doctor runs.
 */
import { DELIVERY_ACTIONS, DELIVERY_MODES, RELEASE_ACTIONS } from '../policy/config.ts';
import type { OrbitConfig } from '../policy/types.ts';
import { which } from '../isolation/util.ts';

export interface DeliveryEnvironmentProblem {
  /** What is wrong, as one clause (doctor's summary line). */
  summary: string;
  /** What is missing, for doctor's "missing:" line. */
  missing: string;
  /** The exact way out. */
  fix: string;
  code: 'AUTH_MISSING' | 'PROVIDER_UNAVAILABLE';
}

/** Whether a run under this policy pushes a branch, opens a pull request or repairs CI through GitHub. */
export function deliversThroughGithub(config: Pick<OrbitConfig, 'mode' | 'delivery' | 'actions'>): boolean {
  return config.delivery.provider === 'github' && DELIVERY_MODES.has(config.mode) && (config.actions.open_pull_request || config.actions.push_task_branch || config.actions.repair_ci);
}

/**
 * How to run under this policy without delivering: mode autonomous, and every delivery or release action it turns on set
 * to false, since policy/config.ts modeAllowsActions refuses an action left on in a mode that does not deliver (the 0.3.1
 * retest followed "set mode: autonomous" alone and was refused again).
 */
export function withoutDelivery(config: Pick<OrbitConfig, 'actions'>): string {
  const on = [...DELIVERY_ACTIONS, ...RELEASE_ACTIONS].filter((a) => config.actions[a] === true).map((a) => `actions.${a}`);
  const listed = on.length <= 1 ? on.join('') : `${on.slice(0, -1).join(', ')} and ${on.at(-1)}`;
  return `or, to run without delivery, set mode: autonomous${on.length > 0 ? ` and ${listed} to false` : ''} in .orbit/config.yaml`;
}

export function deliveryEnvironmentProblem(config: Pick<OrbitConfig, 'mode' | 'delivery' | 'actions'>, env: Readonly<Record<string, string | undefined>>): DeliveryEnvironmentProblem | null {
  if (!deliversThroughGithub(config)) return null;
  if (!which('gh', env.PATH)) {
    return { summary: 'the gh CLI was not found', missing: 'the gh executable on PATH', fix: `install GitHub CLI (https://cli.github.com), ${withoutDelivery(config)}`, code: 'PROVIDER_UNAVAILABLE' };
  }
  if (!env.GH_TOKEN) {
    return {
      summary: 'GH_TOKEN is not set for the controller',
      missing: 'a fine-grained GH_TOKEN scoped to the target repository (delivery refuses a broad keyring login)',
      fix: `export GH_TOKEN in the environment the controller or service runs in, ${withoutDelivery(config)}`,
      code: 'AUTH_MISSING',
    };
  }
  return null;
}
