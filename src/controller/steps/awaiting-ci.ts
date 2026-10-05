/**
 * AWAITING_CI (docs/decisions/0001: a separate state so a restarted
 * controller knows delivery already happened). Each tick observes CI once
 * and returns; nothing blocks on a poll. A green CI on the delivered commit
 * goes through the completion gate; a red one becomes a CI repair brief
 * within ci_repair_cycles (and actions.repair_ci); "no checks reported" is
 * never a pass by itself.
 */
import { join } from 'node:path';
import { atomicWriteJson, readJsonIfExists } from '../../core/fsx.ts';
import { OrbitError } from '../../core/errors.ts';
import { appendEvent } from '../../storage/events.ts';
import { recordFailure } from '../../evidence/store.ts';
import { authorize } from '../../policy/authorize.ts';
import { ciRepairBrief, ciRepairDecision, observeCi } from '../../delivery/ci.ts';
import type { RunContext } from '../context.ts';
import { decide, finishRun, move, safePoint, WAIT, type StepResult } from './common.ts';
import { complete, DELIVERY_FILE, githubClient } from './delivering.ts';
import { briefPath, currentAttempt, type StoredBrief } from './implementing.ts';

interface DeliveryFile {
  commit: string;
  tree: string;
  branch: string;
  pr: { number: number } | null;
  delivered_at: number;
}

const CI_CYCLE_EVENT = 'ci.repair-cycle';

export async function awaitingCiStep(ctx: RunContext): Promise<StepResult> {
  const stop = await safePoint(ctx);
  if (stop) return stop;
  const d = readJsonIfExists<DeliveryFile>(join(ctx.runDir, DELIVERY_FILE));
  if (!d || !ctx.ledger) throw new OrbitError('INTERNAL', `run ${ctx.run.id} is AWAITING_CI without a delivery record`);
  const config = ctx.snapshot.config;
  const client = await githubClient(ctx);
  const readLogs = authorize(ctx.snapshot, { kind: 'action', action: 'read_ci_logs' }).allowed;
  const obs = await observeCi({ client, ...(d.pr ? { pr: d.pr.number } : {}), sha: d.commit, timeoutMs: 0, clock: ctx.clock, readLogs });
  const elapsed = ctx.clock.now() - d.delivered_at;
  const base = { branch: d.branch, commit: d.commit, pr: d.pr?.number ?? null };

  if (obs.state === 'passed') return complete(ctx, d.tree, { ...base, ci: 'passed' });
  if (obs.state === 'cancelled') return finishRun(ctx, 'BLOCKED', `CI was cancelled on ${d.commit.slice(0, 12)}; re-run it and resume the run`, { outcome: base });
  if (obs.state === 'failed') {
    const brief = ciRepairBrief(obs.failures, { sha: d.commit, ...(d.pr ? { pr: d.pr.number } : {}) });
    const previous = ctx.db.all<{ fp: string | null }>("SELECT json_extract(data_json, '$.fingerprint') AS fp FROM events WHERE run_id = ? AND type = ?", ctx.run.id, CI_CYCLE_EVENT).map((r) => r.fp).filter((x): x is string => typeof x === 'string');
    const decision = ciRepairDecision({ snapshot: ctx.snapshot, cyclesUsed: ctx.ledger.state('ci_repair_cycles').used, fingerprint: brief.fingerprint, previousFingerprints: previous });
    decide(ctx, { id: `dec-${ctx.run.id}-ci-${d.commit}`, kind: 'ci.repair-decision', summary: `CI failed on ${d.commit.slice(0, 12)}: ${decision.reason}`, data: { decision, failures: brief.failures } });
    for (const f of obs.failures) recordFailure(ctx.db, { runId: ctx.run.id, candidateId: ctx.candidate?.id ?? null, source: 'ci', sourceId: `ci:${d.commit}:${f.name}`, fingerprint: f.fingerprint, excerpt: f.logExcerpt.slice(0, 2000) || null }, ctx.clock);
    if (!decision.allowed) {
      return decision.remaining === 0
        ? finishRun(ctx, 'EXHAUSTED', `CI failed and the CI repair budget is spent: ${decision.reason}`, { outcome: base })
        : finishRun(ctx, 'BLOCKED', `CI failed and repair is not authorized: ${decision.reason}`, { outcome: base });
    }
    const next = currentAttempt(ctx) + 1;
    // The cycle is counted with its record, so a crash cannot count it twice.
    ctx.db.tx(() => {
      if (ctx.db.get("SELECT 1 AS x FROM events WHERE run_id = ? AND type = ? AND json_extract(data_json, '$.commit') = ?", ctx.run.id, CI_CYCLE_EVENT, d.commit)) return;
      ctx.ledger!.consume('ci_repair_cycles', 1);
      appendEvent(ctx.db, ctx.run.id, CI_CYCLE_EVENT, ctx.ownerId, { commit: d.commit, fingerprint: brief.fingerprint, attempt: next }, ctx.clock.now());
    });
    const stored: StoredBrief = { attempt: next, source: 'ci', fingerprint: brief.fingerprint, brief: { text: brief.text, evidence: brief.evidence, preserved_constraints: brief.preservedConstraints, post_fix_checks: brief.postFixChecks } };
    atomicWriteJson(briefPath(ctx, next), stored);
    return move(ctx, 'DIAGNOSING', `CI failed on ${d.commit.slice(0, 12)} (${obs.failures.map((f) => f.name).join(', ')}); CI repair brief for attempt ${next}`);
  }

  // Pending: nothing reported yet, or still running.
  const timeoutMs = config.delivery.ci_timeout_minutes * 60_000;
  if (obs.absent && elapsed >= ctx.timing.ciAbsentGraceMs) {
    if (config.delivery.require_ci) {
      if (elapsed >= timeoutMs) return finishRun(ctx, 'BLOCKED', `no CI checks were reported for ${d.commit.slice(0, 12)} within ${config.delivery.ci_timeout_minutes} minutes and delivery.require_ci is true`, { outcome: base });
      return WAIT('no CI checks reported yet');
    }
    return complete(ctx, d.tree, { ...base, ci: 'none reported' }, ['no CI checks were reported for the delivered commit; CI is unverified']);
  }
  if (elapsed >= timeoutMs) return finishRun(ctx, 'BLOCKED', `CI did not finish within ${config.delivery.ci_timeout_minutes} minutes (pending: ${obs.pending.join(', ') || 'unknown'})`, { outcome: base });
  return WAIT(`CI pending on ${d.commit.slice(0, 12)}${obs.pending.length ? ` (${obs.pending.join(', ')})` : ''}`);
}
