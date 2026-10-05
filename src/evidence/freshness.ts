import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { snapshotHash } from '../policy/snapshot.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { aggregateCheckConfigHash } from './report.ts';
import type { Candidate, EvidenceReport } from './types.ts';

/**
 * Freshness (architecture "Evidence binding"). Evidence authorizes something
 * only while the candidate tree, the configuration of the checks it ran and
 * the policy snapshot are all exactly what they were when it was produced. A
 * single byte changed anywhere in the tree, or a check definition edited,
 * makes every earlier report stale.
 */

export interface FreshnessContext {
  candidate: Pick<Candidate, 'treeHash' | 'commitSha' | 'id' | 'runId'>;
  snapshot: PolicySnapshot;
}

/** Every way `report` no longer matches the current state; empty when it is fresh. */
export function staleReasons(report: EvidenceReport, ctx: FreshnessContext): string[] {
  const reasons: string[] = [];
  if (report.run_id !== ctx.candidate.runId) reasons.push(`report is for run ${report.run_id}, not ${ctx.candidate.runId}`);
  if (report.tree_hash !== ctx.candidate.treeHash) reasons.push(`candidate tree changed: evidence is for ${report.tree_hash}, current tree is ${ctx.candidate.treeHash}`);
  const policy = snapshotHash(ctx.snapshot);
  if (report.policy_hash !== policy) reasons.push(`policy snapshot changed: evidence used ${report.policy_hash}, current is ${policy}`);
  const config = aggregateCheckConfigHash(ctx.snapshot, report.checks.map((c) => c.id));
  if (report.check_config_hash !== config) reasons.push('check configuration changed since the checks ran');
  return reasons;
}

export function isFresh(report: EvidenceReport, ctx: FreshnessContext): boolean {
  return staleReasons(report, ctx).length === 0;
}

/**
 * Mark the run's live evidence reports stale, with the reason, in one
 * transaction with an event. Call when the candidate or the configuration
 * changes. Returns how many reports were invalidated; reports already
 * invalidated keep their original reason. `exceptTreeHash` spares the report
 * for the tree that is still current; `exceptVerdict` spares reports with that
 * verdict (a change that can only excuse failures cannot alter a PASS).
 */
export function invalidateEvidence(db: OrbitDb, runId: string, reason: string, clock: Clock, opts: { exceptTreeHash?: string; exceptVerdict?: EvidenceReport['verdict'] } = {}): number {
  const now = clock.now();
  return db.tx(() => {
    const live = db.all<{ id: string; tree_hash: string; verdict: string }>('SELECT id, tree_hash, verdict FROM evidence_reports WHERE run_id = ? AND invalidated_at IS NULL', runId);
    const targets = live.filter((r) => r.tree_hash !== opts.exceptTreeHash && r.verdict !== opts.exceptVerdict);
    for (const t of targets) db.run('UPDATE evidence_reports SET invalidated_at = ?, invalidated_reason = ? WHERE id = ?', now, reason, t.id);
    if (targets.length > 0) appendEvent(db, runId, 'evidence.invalidated', 'controller', { reason, reports: targets.map((t) => t.id) }, now);
    return targets.length;
  });
}

export interface ReviewBinding {
  /** Tree the reviewer actually saw. */
  treeHash: string;
  /** Review outcome; only APPROVE authorizes delivery. */
  verdict: string;
}

export interface DeliverableInput {
  report: EvidenceReport;
  review: ReviewBinding | null;
  /** `git rev-parse <delivery commit>^{tree}`, read by the caller from the commit about to be pushed. */
  deliveryCommitTree: string;
  /** Present when the report row was invalidated; its reason is quoted. */
  invalidatedReason?: string | null;
  /** When given, the report must also still match this candidate, configuration and policy. */
  current?: FreshnessContext;
}

/**
 * Delivery gate: the evidence, the review and the commit about to ship must
 * all describe the same tree, and the evidence must be a PASS that has not
 * gone stale. Throws STALE_EVIDENCE naming the first thing that does not hold.
 */
export function assertDeliverable(input: DeliverableInput): void {
  const { report, review } = input;
  const fail = (reason: string, details: Record<string, unknown> = {}): never => {
    throw new OrbitError('STALE_EVIDENCE', reason, { reason, ...details });
  };
  if (input.invalidatedReason) fail(`evidence was invalidated: ${input.invalidatedReason}`);
  if (report.verdict !== 'PASS') fail(`evidence verdict is ${report.verdict}, not PASS`, { verdict: report.verdict });
  if (input.current) {
    const reasons = staleReasons(report, input.current);
    if (reasons.length > 0) fail(`evidence is stale: ${reasons.join('; ')}`, { reasons });
  }
  if (!review) fail('no review of this tree');
  else {
    if (review!.verdict !== 'APPROVE') fail(`review verdict is ${review!.verdict}, not APPROVE`, { verdict: review!.verdict });
    if (review!.treeHash !== report.tree_hash) fail(`review covered tree ${review!.treeHash}, but the evidence is for ${report.tree_hash}`, { reviewTree: review!.treeHash, evidenceTree: report.tree_hash });
  }
  if (input.deliveryCommitTree !== report.tree_hash) {
    fail(`delivery commit has tree ${input.deliveryCommitTree}, but the evidence and review are for ${report.tree_hash}; hooks, rebases or generated files changed the tree`, {
      deliveryTree: input.deliveryCommitTree,
      evidenceTree: report.tree_hash,
    });
  }
}
