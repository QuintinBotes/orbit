/**
 * DIAGNOSING (spec sections 7 and 14): from the failure records of the
 * current candidate to a repair brief for the next attempt.
 *
 *   1. non-progress: attempts that keep failing without measurable progress end the run (EXHAUSTED, scenario 6)
 *   2. repeated equivalent failures call the Inquisition (diagnose mode), once per condition
 *   3. the brief: CI and scope briefs are deterministic; otherwise a read-only verifier writes one,
 *      validated against the fingerprint, the policy's checks and earlier hypotheses (bounded regeneration)
 *   4. no hypothesis left standing: IMPOSSIBLE, with the reason
 *   5. allowance: one more attempt only with progress, a new hypothesis and the reserve intact
 */
import { existsSync } from 'node:fs';
import { atomicWriteJson, readJsonIfExists } from '../../core/fsx.ts';
import { OrbitError } from '../../core/errors.ts';
import { renderWorkerPrompt, type EvidenceRef } from '../../adapters/prompt.ts';
import { validateModelOutput, type DiagnosisOutput } from '../../contract/model-outputs.ts';
import { listCheckRuns, listEvidenceReports, listFailures, type FailureRecord } from '../../evidence/store.ts';
import type { RepairBrief } from '../../evidence/types.ts';
import { briefFromDiagnosis, nonProgress, nonProgressThreshold, progressSince, validateRepairBrief, type AttemptSnapshot } from '../../inquisition/repair.ts';
import { eliminatedHypothesisIds, proposeHypothesis, toPrior } from '../../inquisition/hypotheses.ts';
import { listHypotheses, listQuestions } from '../../inquisition/store.ts';
import { extensionDecisionRecord } from '../../scheduling/budget.ts';
import type { RunContext } from '../context.ts';
import { routeFor } from '../workers.ts';
import { advisoryBlockFor } from '../knowledge-hooks.ts';
import { assertContract, decide, finishRun, MAX_REGENERATIONS, move, policySummary, safePoint, type StepResult } from './common.ts';
import { obtain } from './obtain.ts';
import { attemptCandidateId, briefPath, currentAttempt, type StoredBrief } from './implementing.ts';
import { pendingTrigger } from './verifying.ts';

export async function diagnosingStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const contract = assertContract(ctx);
  const cand = ctx.candidate;
  if (!cand || !ctx.ledger) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is DIAGNOSING without a candidate or budget`);
  const next = currentAttempt(ctx) + 1;
  const config = ctx.snapshot.config;

  // 1. Repeated non-progress ends the loop; more attempts, tokens or lines would not change it.
  const history = attemptHistory(ctx);
  const np = nonProgress(history, nonProgressThreshold(config.scheduler.repeated_failure_threshold));
  if (np.terminate) {
    decide(ctx, { id: `dec-${ctx.run.id}-non-progress-${next}`, kind: 'repair.non-progress', summary: np.reason, data: np });
    return finishRun(ctx, 'EXHAUSTED', `non-progress: ${np.reason}`, { outcome: { non_progress: np } });
  }

  const failures = listFailures(ctx.db, ctx.run.id).filter((f) => f.candidateId === cand.id);
  const primary: FailureRecord | null = failures.find((f) => f.source !== 'flaky_check') ?? failures[0] ?? null;
  const fingerprint = primary?.fingerprint ?? `verdict:${cand.id}`;
  // The hard cap never moves: with no attempt left, a diagnosis would be spend without a use.
  const att = ctx.ledger.state('implementation_attempts');
  if (att.used >= att.hard_cap) return finishRun(ctx, 'EXHAUSTED', `implementation attempts hard cap reached (${att.used} of ${att.hard_cap}); the last failure was ${fingerprint}`, { outcome: { fingerprint } });

  // 2. Repeated equivalent failures go to the Inquisition before another repair (spec section 7 stop logic).
  const existing = readJsonIfExists<StoredBrief>(briefPath(ctx, next));
  if (!existing) {
    const trigger = pendingTrigger(ctx, cand, ['repeated_failure']);
    if (trigger) return move(ctx, 'INQUISITION', trigger.summary, { data: { trigger } });
  }

  // 3. The brief.
  let stored: StoredBrief;
  let hypothesisIsNew = true;
  if (existing) stored = existing;
  else if (primary?.source === 'worker' && primary.sourceId?.startsWith('scope:')) {
    stored = { attempt: next, source: 'scope', fingerprint, brief: scopeBrief(ctx, fingerprint, primary.excerpt ?? 'scope inspection denied the candidate') };
  } else {
    const priors = listHypotheses(ctx.db, ctx.run.id).map(toPrior);
    const route = routeFor(ctx, `diagnose:${cand.id}`, failures.length > 0 && repeatedCount(ctx, fingerprint) >= config.scheduler.repeated_failure_threshold ? 'complex-diagnosis' : 'focused-tests', {
      difficulty: (ctx.run.difficulty ?? 'medium') as 'simple' | 'medium' | 'complex',
      attempt: 1,
      repeatedFingerprints: repeatedCount(ctx, fingerprint),
      ...(failures.length > 0 ? { evidence: failures.map((f) => `failure:${f.id}`) } : {}),
    });
    const got = await obtain<{ out: DiagnosisOutput; brief: RepairBrief }>(ctx, {
      base: `diagnose:${cand.id}`,
      maxAttempts: MAX_REGENERATIONS,
      what: 'the verifier (diagnosis)',
      beforeStart: () => ctx.ledger!.consume('diagnostic_experiments', 1),
      request: (purpose) => ({
        role: 'verifier',
        purpose,
        candidateId: cand.id,
        provider: route.provider,
        model: route.model,
        effort: route.effort,
        cwd: ctx.run.worktreePath!,
        readOnly: true,
        prompt: (workerId) => diagnosisPrompt(ctx, fingerprint, failures, workerId),
      }),
      accept: (r) => {
        const out = validateModelOutput('diagnosis', r.structured);
        const brief = briefFromDiagnosis(out);
        const v = validateRepairBrief(brief, { policyCheckIds: Object.keys(config.checks), expectedFingerprint: fingerprint, priorHypotheses: priors });
        if (!v.valid) throw new OrbitError('MALFORMED_OUTPUT', `the repair brief is not usable: ${v.problems.join('; ')}`);
        return { out, brief };
      },
      exhausted: () => finishRun(ctx, 'EXHAUSTED', `diagnosis produced no valid repair brief within ${MAX_REGENERATIONS} attempts for ${fingerprint}`),
    });
    if (!got.ok) return got.step;
    const { out, brief } = got.value;
    // 4. Every competing cause ruled out and none left to test: nothing authorized remains to try.
    if (out.competing_hypotheses.length > 0 && out.competing_hypotheses.every((h) => h.status === 'ruled-out')) {
      return finishRun(ctx, 'IMPOSSIBLE', `every hypothesis for ${fingerprint} was ruled out by evidence and no authorized experiment remains`, { outcome: { hypotheses: out.competing_hypotheses.map((h) => h.statement) } });
    }
    const chosen = out.competing_hypotheses.find((h) => h.id === out.chosen_hypothesis_id) ?? null;
    const statement = chosen?.statement ?? brief.hypotheses[0]?.statement ?? '';
    try {
      const proposed = proposeHypothesis(ctx.db, ctx.run.id, { statement, fingerprint, experiment: brief.experiment, expectedObservation: brief.expected_observation }, ctx.clock);
      hypothesisIsNew = proposed.novelty.isNew;
      decide(ctx, { kind: 'repair.hypothesis', summary: `${proposed.novelty.kind}: ${statement}`.slice(0, 500), data: { novelty: proposed.novelty, hypothesis_id: proposed.record?.id ?? null, fingerprint } });
    } catch (err) {
      if (!(err instanceof OrbitError) || err.code !== 'SCHEMA_INVALID') throw err;
      hypothesisIsNew = false;
    }
    stored = { attempt: next, source: 'diagnosis', fingerprint, brief, refs: failures.map((f) => `failure:${f.id}`) };
  }

  // 5. Allowance: an extension needs progress, a new hypothesis and the reserve intact; the hard cap never moves.
  if (att.used >= att.allowance) {
    const prev = history.length >= 2 ? history[history.length - 2]! : null;
    const cur = history.at(-1) ?? null;
    const p = cur ? progressSince(prev, cur) : null;
    const decision = ctx.ledger.requestExtension({
      counter: 'implementation_attempts',
      progress: p ? { newly_supported_criteria: p.newly_supported_criteria, fixed_checks: p.fixed_checks, eliminated_hypotheses: p.eliminated_hypotheses, localized_fault: p.localized_fault, resolved_ambiguity: p.resolved_ambiguity } : {},
      hypothesisIsNew,
      withinScope: true,
      failureRemains: true,
      nextExperiment: (stored.brief as Partial<RepairBrief>).experiment ?? 'repair as briefed',
      reason: `failure ${fingerprint} remains after attempt ${next - 1}`,
      role: 'implementer',
    });
    const rec = extensionDecisionRecord(decision);
    decide(ctx, { id: `dec-${ctx.run.id}-extension-${next}`, kind: rec.kind, summary: rec.summary, data: rec.data });
    if (decision.decision === 'deny_extension') {
      return finishRun(ctx, 'EXHAUSTED', `implementation attempt allowance spent (${att.used} of ${att.allowance}) and no extension: ${decision.denied_because.join('; ')}`, { outcome: { extension: decision } });
    }
  }

  if (!existsSync(briefPath(ctx, next))) atomicWriteJson(briefPath(ctx, next), stored);
  decide(ctx, { id: `dec-${ctx.run.id}-brief-${next}`, kind: 'repair.brief', summary: `repair brief (${stored.source}) for attempt ${next}: ${fingerprint}`, data: { attempt: next, source: stored.source, fingerprint, path: `briefs/attempt-${next}.json` } });
  return move(ctx, 'REPAIRING', `repair brief for attempt ${next} (${stored.source})`, { data: { attempt: next, fingerprint } });
}

/** Distinct candidates that failed with this fingerprint. */
function repeatedCount(ctx: RunContext, fingerprint: string): number {
  return new Set(listFailures(ctx.db, ctx.run.id, fingerprint).map((f) => f.candidateId ?? `row-${f.id}`)).size;
}

/** What each attempt established, oldest first, from its candidate's newest evidence report. */
export function attemptHistory(ctx: RunContext): AttemptSnapshot[] {
  const out: AttemptSnapshot[] = [];
  const mandatory = new Set(Object.values(ctx.snapshot.config.checks).filter((c) => c.mandatory).map((c) => c.id));
  const reports = listEvidenceReports(ctx.db, ctx.run.id);
  const failures = listFailures(ctx.db, ctx.run.id);
  const eliminated = eliminatedHypothesisIds(ctx.db, ctx.run.id);
  const resolved = listQuestions(ctx.db, ctx.run.id, { status: 'answered' }).map((q) => q.id);
  const last = currentAttempt(ctx);
  for (let k = 1; k <= last; k++) {
    const candId = attemptCandidateId(ctx, k);
    if (!candId) continue;
    const r = reports.filter((x) => x.candidateId === candId).at(-1);
    if (!r) continue;
    const checks = r.report.checks;
    out.push({
      attempt: k,
      supportedCriteria: r.report.acceptance_evidence.filter((a) => a.status === 'supported').map((a) => a.criterion_id),
      passingMandatoryChecks: checks.filter((c) => mandatory.has(c.id) && c.status === 'PASSED').map((c) => c.id),
      failingMandatoryChecks: checks.filter((c) => mandatory.has(c.id) && c.status !== 'PASSED').map((c) => c.id),
      failureFingerprints: [...new Set(failures.filter((f) => f.candidateId === candId).map((f) => f.fingerprint))],
      eliminatedHypotheses: eliminated,
      localizedFault: null,
      resolvedAmbiguities: resolved,
    });
  }
  return out;
}

function scopeBrief(ctx: RunContext, fingerprint: string, why: string): RepairBrief {
  const contract = assertContract(ctx);
  return {
    fingerprint,
    evidence: [`scope inspection of the candidate: ${why}`],
    hypotheses: [{ statement: 'The change edits files outside the authorized scope or beyond the size limits', supporting: why }],
    experiment: 'Compare the candidate diff with the contract allowed paths and list each path outside them',
    expected_observation: 'Every changed path outside the allowed paths is identified and none remain after the repair',
    scoped_fix: `Revert the out-of-scope changes and keep the change inside ${contract.allowed_paths.join(', ')}`,
    post_fix_checks: contract.required_check_ids,
    preserved_constraints: ['Do not edit protected paths, policy, CI configuration or check definitions', 'Keep the behaviour tests that prove the acceptance criteria'],
  };
}

function diagnosisPrompt(ctx: RunContext, fingerprint: string, failures: FailureRecord[], workerId: string): string {
  const contract = assertContract(ctx);
  const cand = ctx.candidate!;
  const refs: EvidenceRef[] = [];
  for (const row of listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: cand.id })) {
    if (row.status === 'PASSED' || !row.logPath || !row.logSha256) continue;
    refs.push({ id: row.checkId, path: row.logPath.startsWith(`${ctx.runDir}/`) ? row.logPath.slice(ctx.runDir.length + 1) : row.logPath, sha256: row.logSha256, summary: `${row.checkId} ${row.status}`, ...(row.excerpt ? { excerpt: row.excerpt } : {}) });
  }
  const priors = listHypotheses(ctx.db, ctx.run.id);
  const task = [
    'Diagnose the failure of the candidate in this checkout. Do not edit anything.',
    `Failure fingerprint: ${fingerprint}`,
    'Return a repair brief for exactly this fingerprint: evidence, competing causal hypotheses, one discriminating experiment and what it will show,',
    'a scoped fix, post-fix checks (trusted check ids only) and the constraints the repair must preserve.',
    `Trusted check ids: ${Object.keys(ctx.snapshot.config.checks).join(', ') || 'none'}.`,
    priors.length > 0 ? `Hypotheses already recorded (a reworded one is not new): ${priors.map((h) => `[${h.status}] ${h.statement}`).join(' | ')}` : 'No earlier hypotheses.',
  ].join('\n');
  return renderWorkerPrompt({
    role: 'verifier',
    task,
    contract,
    policySummary: policySummary(ctx, { readOnly: true }),
    candidate: { revision: cand.commitSha, treeHash: cand.treeHash, base: ctx.run.baseRevision },
    evidenceRefs: refs,
    untrusted: failures.filter((f) => f.excerpt && !refs.length).slice(0, 3).map((f) => ({ label: `failure ${f.id} (${f.source})`, content: f.excerpt! })),
    advisoryBlock: advisoryBlockFor(ctx, { role: 'verifier', workerId, paths: contract.allowed_paths, checkIds: contract.required_check_ids, fingerprints: [fingerprint] }),
  });
}
