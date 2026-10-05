/**
 * INQUISITION (spec section 10). The trigger travels with the transition
 * that entered this state; inquisition/runInquisition does the work (rules
 * first, a read-only inquisitor worker only when judgement is needed,
 * questions, ledger, amendments) and its disposition decides what happens:
 * resume the interrupted stage, strengthen the proof (green rejected), or
 * BLOCKED with the persisted questions. Unattended runs never wait for
 * keyboard input.
 */
import { join } from 'node:path';
import { atomicWriteJson } from '../../core/fsx.ts';
import { hashObject } from '../../core/hash.ts';
import { runInquisition } from '../../inquisition/engine.ts';
import { loadInquisitionSnapshot, thresholdsFromPolicy } from '../../inquisition/triggers.ts';
import type { Trigger } from '../../inquisition/types.ts';
import { profileForWorker } from '../../isolation/profiles.ts';
import { currentEvidenceReport } from '../../evidence/store.ts';
import { homeOf, type RunContext } from '../context.ts';
import { assertLeaseHeld } from '../run-store.ts';
import type { RunState } from '../states.ts';
import { adapterFor, collectIfFinished, routeFor, systemPromptFor } from '../workers.ts';
import { listActiveWorkers } from '../../storage/workers.ts';
import { assertContract, finishRun, move, safePoint, WAIT, type StepResult } from './common.ts';
import { briefPath, currentAttempt, type StoredBrief } from './implementing.ts';
import { handledTriggerKeys, pendingTrigger } from './verifying.ts';

export async function inquisitionStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const contract = assertContract(ctx);
  const resume: RunState = ctx.run.resumeState ?? (ctx.candidate ? 'VERIFYING' : 'PLANNING');
  const trigger = enteringTrigger(ctx) ?? (ctx.candidate ? pendingTrigger(ctx, ctx.candidate, null) : null);
  if (!trigger || handledTriggerKeys(ctx).has(trigger.key)) return move(ctx, resume, trigger ? `inquiry ${trigger.key} already settled; resuming ${resume}` : `nothing left to inquire into; resuming ${resume}`);

  // An inquisitor a crashed controller left behind is collected first; the engine refuses to start a second one.
  for (const w of listActiveWorkers(ctx.db, ctx.run.id).filter((x) => x.role === 'inquisitor')) {
    if (await collectIfFinished(ctx, w)) return WAIT(`inquisitor ${w.id} is still running`);
  }

  const route = routeFor(ctx, `inquire:${hashObject(trigger.key).slice(7, 19)}`, 'routine-code', { difficulty: (ctx.run.difficulty ?? 'medium') as 'simple' | 'medium' | 'complex', attempt: 1, repeatedFingerprints: 0 });
  const cwd = ctx.run.worktreePath!;
  const env = ctx.deps.hostEnv ?? process.env;
  const home = homeOf(ctx.deps);
  const workerDir = join(ctx.runDir, 'workers');
  const supported = ctx.candidate ? (currentEvidenceReport(ctx.db, ctx.run.id, ctx.candidate.id)?.report.acceptance_evidence.filter((a) => a.status === 'supported').map((a) => a.criterion_id) ?? []) : [];
  const result = await runInquisition({
    trigger,
    adapter: adapterFor(ctx, route.provider),
    context: {
      db: ctx.db,
      clock: ctx.clock,
      runId: ctx.run.id,
      runDir: ctx.runDir,
      snapshot: ctx.snapshot,
      contract,
      inquiry: loadInquisitionSnapshot(ctx.db, ctx.run.id, { ...(ctx.candidate ? { currentTreeHash: ctx.candidate.treeHash } : {}), thresholds: thresholdsFromPolicy(ctx.snapshot.config) }),
      supportedCriteria: supported,
      worker: {
        route: { provider: route.provider, model: route.model, effort: route.effort },
        workerDir,
        cwd,
        sandbox: profileForWorker({ worktree: cwd, workerDir, snapshot: ctx.snapshot, provider: route.provider.startsWith('codex') ? 'codex' : 'claude', claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), homeDir: home, policyPath: ctx.run.policyPath, readablePaths: [ctx.deps.orbitInstallDir], env }),
        policyPath: ctx.run.policyPath,
        systemPrompt: systemPromptFor(ctx, 'inquisitor'),
        maxTurns: ctx.snapshot.config.scheduler.hard_limits.worker_turns_per_session,
        pollMs: 250,
        fence: () => assertLeaseHeld(ctx.db, ctx.run.id, ctx.ownerId, ctx.clock.now()),
      },
    },
    signal: ctx.signal,
  });
  const patch = hashObject(result.contract) !== hashObject(contract) ? { contractJson: JSON.stringify(result.contract), contractHash: hashObject(result.contract) } : undefined;
  if (patch) atomicWriteJson(join(ctx.runDir, 'contract.json'), result.contract);
  const after = await safePoint(ctx);
  if (after) return after;

  if (result.disposition === 'ask' || result.disposition === 'block') {
    const questions = result.questions.map((q) => q.question);
    return finishRun(ctx, 'BLOCKED', `${result.reason}${questions.length ? `; open questions: ${questions.slice(0, 5).join(' | ')}` : ''}`, { outcome: { inquiry: trigger.key, questions: result.questions.map((q) => q.id), blocked_criteria: result.blockedCriteria } });
  }
  if (result.rejectGreen && ctx.candidate) {
    // Green checks do not count as proof while this holds (scenario 5): the next attempt must strengthen the proof.
    const next = currentAttempt(ctx) + 1;
    const stored: StoredBrief = {
      attempt: next,
      source: 'diagnosis',
      fingerprint: `proof:${trigger.key}`,
      brief: {
        fingerprint: `proof:${trigger.key}`,
        evidence: trigger.evidence,
        hypotheses: [{ statement: 'The passing checks do not exercise the behaviour the criteria require', supporting: trigger.summary }],
        experiment: result.experiments[0]?.description ?? 'Write a test for each affected criterion that fails without the change and passes with it',
        expected_observation: 'Each new test fails against the base revision and passes against the candidate',
        scoped_fix: 'Add or restore assertions that exercise the affected criteria; do not weaken or remove existing assertions',
        post_fix_checks: contract.required_check_ids,
        preserved_constraints: ['Never remove assertions, skip tests or raise timeouts to make checks pass'],
      },
    };
    atomicWriteJson(briefPath(ctx, next), stored);
    return move(ctx, 'DIAGNOSING', `green checks rejected as proof (${trigger.kind}); strengthening the tests in attempt ${next}`, { ...(patch ? { patch } : {}), data: { inquiry: trigger.key } });
  }
  return move(ctx, resume, `inquiry ${trigger.kind} settled (${result.disposition}); resuming ${resume}`, { ...(patch ? { patch } : {}), data: { inquiry: trigger.key, disposition: result.disposition } });
}

/** The trigger recorded on the transition into INQUISITION, if any. */
function enteringTrigger(ctx: RunContext): Trigger | null {
  const row = ctx.db.get<{ data_json: string | null }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'state.transition' AND to_state = 'INQUISITION' ORDER BY id DESC LIMIT 1", ctx.run.id);
  if (!row?.data_json) return null;
  const d = JSON.parse(row.data_json) as { data?: { trigger?: Trigger } };
  return d.data?.trigger ?? null;
}
