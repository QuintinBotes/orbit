/**
 * CONTRACTING (spec section 6): a read-only planner drafts criteria, proof,
 * scope and checks; contract/draft fixes everything that carries authority
 * (ids, policy hash, baseline, delivery, scope intersected with policy);
 * contract/validate and the intake gate accept or reject it. Material
 * questions the planner could not settle go to INQUISITION with the contract
 * already persisted; reversible ones are recorded as decisions.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson } from '../../core/fsx.ts';
import { hashObject } from '../../core/hash.ts';
import { OrbitError } from '../../core/errors.ts';
import { draftContract } from '../../contract/draft.ts';
import { validateModelOutput, type PlannerOutput } from '../../contract/model-outputs.ts';
import type { GoalContract } from '../../contract/types.ts';
import { renderWorkerPrompt } from '../../adapters/prompt.ts';
import type { Trigger } from '../../inquisition/types.ts';
import type { RunContext } from '../context.ts';
import { intakeGate } from '../gates.ts';
import { routeFor } from '../workers.ts';
import { advisoryBlockFor } from '../knowledge-hooks.ts';
import { decide, finishRun, MAX_REGENERATIONS, move, policySummary, safePoint, type StepResult } from './common.ts';
import { obtain } from './obtain.ts';
import { recordGate } from './preflight.ts';

export const PLANNER_FILE = 'planner.json';

export async function contractingStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  // Back from INQUISITION or BLOCKED with a contract already settled: only the intake gate remains.
  if (ctx.contract) return accept(ctx, ctx.contract, null);

  const route = routeFor(ctx, 'plan', 'routine-code', { difficulty: 'medium', attempt: 1, repeatedFingerprints: 0 });
  const got = await obtain<PlannerOutput>(ctx, {
    base: 'plan',
    maxAttempts: MAX_REGENERATIONS,
    what: 'the planner',
    request: (purpose) => ({
      role: 'planner',
      purpose,
      provider: route.provider,
      model: route.model,
      effort: route.effort,
      cwd: worktreeOf(ctx),
      readOnly: true,
      prompt: (workerId) => plannerPrompt(ctx, workerId),
    }),
    accept: (r) => validateModelOutput('planner', r.structured),
  });
  if (!got.ok) return got.step;
  const plan = got.value;
  atomicWriteJson(join(ctx.runDir, PLANNER_FILE), { worker_id: got.worker.id, output: plan });

  let drafted: ReturnType<typeof draftContract>;
  try {
    drafted = draftContract({ goal: ctx.run.goal, plannerOutput: plan, snapshot: ctx.snapshot, baselineRevision: ctx.run.baseRevision ?? '', taskId: ctx.run.id, policyHash: ctx.run.policyHash, environment: ctx.run.environment });
  } catch (err) {
    if (!(err instanceof OrbitError) || err.code !== 'CONTRACT_INVALID') throw err;
    return finishRun(ctx, 'BLOCKED', `intake gate rejected the planner's contract: ${err.message}`, { outcome: { problems: err.details ?? null } });
  }
  for (const a of drafted.adjustments) {
    decide(ctx, { id: `dec-${ctx.run.id}-draft-${hashObject(a).slice(7, 23)}`, kind: `contract.${a.kind}`, summary: `${a.subject}: ${a.reason}`, data: a });
  }
  // Reversible questions are settled by the planner's recommendation and recorded; material ones are not guessed.
  for (const [i, d] of plan.unresolved_decisions.entries()) {
    if (d.material) continue;
    decide(ctx, { id: `dec-${ctx.run.id}-plan-choice-${i + 1}`, kind: 'inquisition.resolve', summary: `reversible choice: ${d.question} -> ${d.recommendation ?? d.options[0] ?? 'convention'}`, data: { question: d.question, options: d.options, choice: d.recommendation ?? d.options[0] ?? null, basis: 'planner recommendation; reversible' } });
  }
  return accept(ctx, drafted.contract, plan);
}

async function accept(ctx: RunContext, contract: GoalContract, plan: PlannerOutput | null): Promise<StepResult> {
  const intake = intakeGate({ run: ctx.run, snapshot: ctx.snapshot, contract });
  recordGate(ctx, intake);
  if (!intake.passed) return finishRun(ctx, 'BLOCKED', `intake gate rejected the contract: ${intake.reasons.join('; ')}`, { outcome: { gate: intake } });
  atomicWriteJson(join(ctx.runDir, 'contract.json'), contract);
  const patch = { contractJson: JSON.stringify(contract), contractHash: hashObject(contract) };

  const material = (plan?.unresolved_decisions ?? []).filter((d) => d.material);
  const open = contract.assumptions.filter((a) => a.status === 'needs-decision');
  if (material.length > 0 || (plan !== null && open.length > 0)) {
    const keys = new Map((plan?.criteria ?? []).map((c, i) => [c.key, `AC-${i + 1}`] as const));
    const subjects = [...new Set(material.flatMap((d) => d.affected_criteria.map((k) => keys.get(k) ?? k)).filter((s) => /^AC-\d+$/.test(s)))];
    const trigger: Trigger = {
      kind: 'hidden_decision',
      mode: 'clarify',
      summary: `the planner left ${material.length || open.length} material decision(s) unresolved`,
      evidence: [...material.map((d) => d.question), ...open.map((a) => `${a.id}: ${a.statement}`)].slice(0, 20),
      subjects,
      key: `contracting:${hashObject(material.map((d) => d.question)).slice(7, 23)}`,
    };
    return move(ctx, 'INQUISITION', trigger.summary, { patch, data: { trigger } });
  }
  return move(ctx, 'PLANNING', `contract accepted: ${contract.acceptance_criteria.length} criteria, checks ${contract.required_check_ids.join(', ') || 'none'}`, { patch });
}

function worktreeOf(ctx: RunContext): string {
  if (!ctx.run.worktreePath) throw new OrbitError('INTERNAL', `run ${ctx.run.id} has no worktree; preflight did not finish`);
  return ctx.run.worktreePath;
}

function plannerPrompt(ctx: RunContext, workerId: string): string {
  const checks = Object.values(ctx.snapshot.config.checks).map((c) => `${c.id}${c.mandatory ? ' (mandatory)' : ''}`);
  const task = [
    'Draft the goal contract for the goal below. Read the repository as needed; do not edit anything.',
    'Return the current behaviour, criteria that are observable and testable, the proof for each, the trusted check ids that would show it,',
    'the files you expect to change, the narrowest allowed paths, non-goals, risks, assumptions and any decision you cannot settle from evidence.',
    `Trusted checks the policy defines: ${checks.join(', ') || 'none'}. Name only these as check ids.`,
    '',
    `Goal (from the user): ${ctx.run.goal}`,
  ].join('\n');
  return renderWorkerPrompt({
    role: 'planner',
    task,
    contract: null,
    policySummary: policySummary(ctx, { readOnly: true }),
    candidate: { revision: ctx.run.baseRevision, treeHash: ctx.run.baseTree, base: ctx.run.baseRevision },
    advisoryBlock: advisoryBlockFor(ctx, { role: 'planner', workerId, paths: ctx.snapshot.config.scope.allowed_paths, checkIds: Object.keys(ctx.snapshot.config.checks), fingerprints: [] }),
  });
}

/** The planner output CONTRACTING stored, for planning and reports; null when none was stored. */
export function storedPlan(ctx: RunContext): PlannerOutput | null {
  try {
    const raw = (JSON.parse(readFileSync(join(ctx.runDir, PLANNER_FILE), 'utf8')) as { output?: unknown }).output;
    return raw ? validateModelOutput('planner', raw) : null;
  } catch {
    return null;
  }
}
