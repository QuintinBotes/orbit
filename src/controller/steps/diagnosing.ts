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
import { listDecisions } from '../../storage/decisions.ts';
import { availableParallelism, freemem, loadavg } from 'node:os';
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
    const timeouts = timeoutContext(ctx, cand.id);
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
        prompt: (workerId) => diagnosisPrompt(ctx, fingerprint, failures, workerId, timeouts),
      }),
      accept: (r) => {
        const out = validateModelOutput('diagnosis', r.structured);
        const brief = briefFromDiagnosis(out);
        const v = validateRepairBrief(brief, { policyCheckIds: Object.keys(config.checks), expectedFingerprint: fingerprint, priorHypotheses: priors });
        if (!v.valid) throw new OrbitError('MALFORMED_OUTPUT', `the repair brief is not usable: ${v.problems.join('; ')}`);
        // A timeout is diagnosed, never fixed by waiting longer (spec section 14).
        if (timeouts && raisesTimeout(brief.scoped_fix)) throw new OrbitError('MALFORMED_OUTPUT', `the scoped fix raises a timeout ("${brief.scoped_fix.slice(0, 200)}"); a timed-out check needs its cause found, not more time`);
        return { out, brief: timeouts ? withTimeoutHypothesis(brief, timeouts) : brief };
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
    const location = localizedFault(out, brief, cand.diffStat?.paths ?? []);
    if (location) decide(ctx, { id: `dec-${ctx.run.id}-localized-${next - 1}`, kind: 'repair.localized', summary: `fault of attempt ${next - 1} localized at ${location}`, data: { attempt: next - 1, location, hypothesis: statement, fingerprint } });
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
    // Read again: this diagnosis may have localized the fault of the attempt it examined.
    const now = attemptHistory(ctx);
    const prev = now.length >= 2 ? now[now.length - 2]! : null;
    const cur = now.at(-1) ?? null;
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
  const localized = new Map<number, string>();
  for (const d of listDecisions(ctx.db, ctx.run.id, { kind: 'repair.localized' })) {
    const data = d.data as { attempt?: number; location?: string } | null;
    if (typeof data?.attempt === 'number' && typeof data.location === 'string') localized.set(data.attempt, data.location);
  }
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
      localizedFault: localized.get(k) ?? null,
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

function diagnosisPrompt(ctx: RunContext, fingerprint: string, failures: FailureRecord[], workerId: string, timeouts: TimeoutContext | null): string {
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
    ...(timeouts ? timeoutPromptLines(timeouts) : []),
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

// ---------------------------------------------------------------------------
// Timeouts (spec section 14: diagnose performance or environment, do not blindly rerun)

export interface TimedOutCheck {
  checkId: string;
  durationMs: number | null;
  timeoutSeconds: number | null;
  /** The same check's duration on the base revision, when the baseline ran it to a final status. */
  baselineMs: number | null;
}

export interface TimeoutContext {
  checks: TimedOutCheck[];
  /** Machine load when the diagnosis was asked for: what the scheduler's capacity probe reads. */
  machine: { cores: number; loadAvg1m: number | null; freeMemMb: number };
}

/** The candidate's timed-out checks with their baselines and the machine's load; null when nothing timed out. */
export function timeoutContext(ctx: RunContext, candidateId: string, probe: { cores: number; loadAvg1m: number | null; freeMemMb: number } = machineProbe(ctx)): TimeoutContext | null {
  const rows = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId }).filter((r) => r.status === 'TIMEOUT' || r.timedOut);
  if (rows.length === 0) return null;
  const base = listCheckRuns(ctx.db, { runId: ctx.run.id, candidateId: null });
  const checks = rows.map((r) => {
    const b = base.filter((x) => x.checkId === r.checkId && x.endedAt !== null && x.status !== 'TIMEOUT').at(-1);
    return {
      checkId: r.checkId,
      durationMs: r.endedAt === null ? null : r.endedAt - r.startedAt,
      timeoutSeconds: ctx.snapshot.config.checks[r.checkId]?.timeout_seconds ?? null,
      baselineMs: b && b.endedAt !== null ? b.endedAt - b.startedAt : null,
    };
  });
  return { checks, machine: probe };
}

/** What the scheduler reads: the controller's injected probe (ControllerDeps.schedulerProbe) when given, else the host. */
function machineProbe(ctx: RunContext): { cores: number; loadAvg1m: number | null; freeMemMb: number } {
  const probe = ctx.deps.schedulerProbe;
  // An injected probe stands for a machine whose load the host cannot report.
  const load = probe ? undefined : loadavg()[0];
  return { cores: probe ? probe.availableParallelism() : availableParallelism(), loadAvg1m: typeof load === 'number' && Number.isFinite(load) && load > 0 ? Math.round(load * 100) / 100 : null, freeMemMb: Math.floor((probe ? probe.freemem() : freemem()) / (1024 * 1024)) };
}

function describeTimeouts(t: TimeoutContext): string {
  const parts = t.checks.map((c) => {
    const ran = c.durationMs === null ? 'an unknown time' : `${Math.round(c.durationMs / 1000)} s`;
    const base = c.baselineMs === null ? 'no baseline duration' : `${Math.round(c.baselineMs / 1000)} s on the base revision`;
    return `${c.checkId} timed out after ${ran} (limit ${c.timeoutSeconds ?? '?'} s; ${base})`;
  });
  const m = t.machine;
  return `${parts.join('; ')}; machine: ${m.cores} core(s), load average ${m.loadAvg1m ?? 'unknown'}, ${m.freeMemMb} MB free`;
}

/** The prompt lines that make an environment or performance cause a mandatory hypothesis. */
export function timeoutPromptLines(t: TimeoutContext): string[] {
  return [
    `Timeouts: ${describeTimeouts(t)}.`,
    'One competing hypothesis must be an environment or performance cause (machine load, a slow dependency, resource limits, a performance regression in the change) rather than a logic defect, with the observation that would tell them apart (compare with the baseline duration).',
    'Raising, extending or removing a timeout is never the scoped fix.',
  ];
}

const ENV_HYPOTHESIS = /\b(environment|performance|load|slow|latency|resource|memory|cpu|machine|contention|regression in speed|hang|deadlock)\b/i;

/** The brief carries the environment or performance hypothesis even when the diagnosis left it out. */
export function withTimeoutHypothesis(brief: RepairBrief, t: TimeoutContext): RepairBrief {
  const hypotheses = brief.hypotheses.some((h) => ENV_HYPOTHESIS.test(h.statement))
    ? brief.hypotheses
    : [...brief.hypotheses, { statement: 'The timeout comes from the environment or a performance regression (machine load, resource limits, a slower code path) rather than a logic defect', supporting: describeTimeouts(t) }];
  const constraint = 'Do not raise, extend or remove any check or test timeout';
  return { ...brief, hypotheses, preserved_constraints: brief.preserved_constraints.includes(constraint) ? brief.preserved_constraints : [...brief.preserved_constraints, constraint] };
}

/** A fix that buys time instead of finding the cause. */
export function raisesTimeout(text: string): boolean {
  return /\b(raise|raising|increase|increasing|extend|extending|bump|bumping|lengthen|double|doubling|remove|removing|disable|disabling|relax|relaxing)\b[^.]{0,40}\btime-?outs?\b/i.test(text) || /\btime-?outs?\b[^.]{0,40}\b(longer|higher|larger|raised|increased|extended|removed|disabled)\b/i.test(text);
}

// ---------------------------------------------------------------------------
// Fault localization

/**
 * Where the fault is, when the diagnosis pins it down: a chosen hypothesis the diagnosis holds with high or
 * medium confidence and supports with evidence, and a scoped fix that names a file the candidate changed. Null
 * otherwise; a location is progress only the first time it is found (inquisition/repair.progressSince).
 */
export function localizedFault(out: DiagnosisOutput, brief: RepairBrief, changedPaths: readonly string[]): string | null {
  const chosen = out.competing_hypotheses.find((h) => h.id === out.chosen_hypothesis_id);
  if (!chosen || chosen.status === 'ruled-out' || chosen.supporting_evidence.length === 0) return null;
  if (out.confidence === 'low') return null;
  const changed = new Set(changedPaths);
  const named = brief.scoped_fix.match(/[A-Za-z0-9_@][A-Za-z0-9_@./-]*\.[A-Za-z0-9]+/g) ?? [];
  const path = named.map((p) => p.replace(/^\.\//, '').replace(/[.,;:]+$/, '')).find((p) => changed.has(p));
  return path ? `${path}: ${chosen.statement}`.slice(0, 300) : null;
}
