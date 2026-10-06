/**
 * The plugins a worker session would load, judged at the start of PREFLIGHT (issue #22), before the base revision's
 * checks, the baseline questions or any worker. It is the judgement `orbit doctor` makes for claude.plugins
 * (adapters/worker-plugins-check.ts), so a run is not started whose every session would be refused after it began and
 * spent model budget.
 *
 * `orbit run --foreground` already refused such a run in admission, before the run existed (cli/admission.ts). What
 * reaches this step is a run that exists: one handed to the service, whose Claude Code configuration is its own and
 * could not be judged in the CLI process, or one resumed. It ends BLOCKED with nothing spent: no check ran, no question
 * was raised, no worker was started, and (report.ts) no curator is. The run's policy is frozen, so the block says that
 * allowing the plugins is a new run, and that removing them from Claude Code's configuration is a resume.
 */
import { workerPluginRefusals } from '../../adapters/worker-plugins-check.ts';
import type { RunContext } from '../context.ts';
import { decide, finishRun, type StepResult } from './common.ts';

/** Ends the run BLOCKED when workers would load a plugin the policy does not allow; null when none would, or when that cannot be judged. */
export async function workerPluginsStep(ctx: RunContext): Promise<StepResult | null> {
  const refusals = await workerPluginRefusals(ctx.deps.adapters, ctx.snapshot.config);
  if (refusals.length === 0) return null;
  const reason = refusals.map(({ verdict }) => `${verdict.summary}; to fix: ${verdict.fix ?? 'allow each plugin in .orbit/config.yaml'}`).join('; and ');
  const plugins = refusals.flatMap(({ verdict }) => verdict.refused.map((p) => p.id).filter((id): id is string => id !== null));
  // No `evidence` key: this is a refusal of the environment, not something the learning layer should study.
  decide(ctx, { kind: 'preflight.worker-plugins', summary: reason, data: { providers: refusals.map((r) => r.provider), plugins } });
  return finishRun(ctx, 'BLOCKED', reason, { outcome: { worker_refusal: { kind: 'plugins', plugins, providers: refusals.map((r) => r.provider) } } });
}
