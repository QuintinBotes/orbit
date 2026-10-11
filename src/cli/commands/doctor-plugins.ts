/**
 * `orbit doctor`: the plugins a Claude worker session would load, and whether the policy allows each (issue #9),
 * judged before any run exactly as a session's system/init is judged at collection (adapters/claude-plugins.ts).
 *
 * The judgement itself is adapters/worker-plugins-check.ts, shared with `orbit run` (admission) and the controller's
 * PREFLIGHT (issue #22), so doctor and run start cannot disagree. Scopes come from `claude plugin list --json`,
 * because system/init does not report them.
 */
import { judgeWorkerPlugins } from '../../adapters/worker-plugins-check.ts';
import type { ProviderAdapter } from '../../adapters/types.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { DoctorCheck } from './doctor.ts';
import { withHumanPolicyConfigNote } from './doctor-policy-note.ts';

/** The check, or null for an adapter that cannot list plugins (a stand-in, or another provider). */
export async function workerPluginsCheck(id: string, adapter: ProviderAdapter | undefined, config: OrbitConfig): Promise<DoctorCheck | null> {
  const verdict = await judgeWorkerPlugins(adapter, config);
  if (verdict === null) return null;
  const { refused, ...check } = verdict;
  return {
    id: `${id}.plugins`,
    area: 'providers',
    ...check,
    fix: refused.length > 0 && check.fix !== null ? withHumanPolicyConfigNote(check.fix) : check.fix,
  };
}
