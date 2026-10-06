/**
 * What a delivering run needs from its environment before it is worth starting: the gh CLI and a GH_TOKEN the
 * controller can see (delivery refuses a broad keyring login). One function judges it for `orbit run` admission, for
 * `orbit doctor`, and for the controller's own preflight (a run handed to the service), so the three cannot disagree.
 * It checks presence only; whether the token is valid is `gh auth status`, which doctor runs.
 */
import { DELIVERY_MODES } from '../policy/config.ts';
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

export function deliveryEnvironmentProblem(config: Pick<OrbitConfig, 'mode' | 'delivery' | 'actions'>, env: Readonly<Record<string, string | undefined>>): DeliveryEnvironmentProblem | null {
  if (!deliversThroughGithub(config)) return null;
  if (!which('gh', env.PATH)) {
    return { summary: 'the gh CLI was not found', missing: 'the gh executable on PATH', fix: 'install GitHub CLI (https://cli.github.com)', code: 'PROVIDER_UNAVAILABLE' };
  }
  if (!env.GH_TOKEN) {
    return {
      summary: 'GH_TOKEN is not set for the controller',
      missing: 'a fine-grained GH_TOKEN scoped to the target repository (delivery refuses a broad keyring login)',
      fix: 'export GH_TOKEN in the environment the controller or service runs in',
      code: 'AUTH_MISSING',
    };
  }
  return null;
}
