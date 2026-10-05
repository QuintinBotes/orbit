import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { canonicalJson, sha256 } from '../core/hash.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import { recordDecision } from '../storage/decisions.ts';
import { listFindings, listReviews, markReviewInvalidated } from './store.ts';
import { exceptionApplies, isSecurityFinding, readSecurityPolicy, severityBlocks, type SecurityPolicy } from './resolve.ts';
import type { FindingRecord, FindingStatus, ReviewRecord } from './types.ts';

/**
 * Review freshness. A review is bound to the tree it examined; for any other
 * candidate it is evidence of nothing ("No delivery from an unreviewed
 * revision"). Invalidation is recorded rather than inferred later, so a
 * report can say which review stopped counting, when, and because of which
 * tree. The review's findings survive: they are claims about the code, and
 * the next round carries the unresolved ones forward.
 */

/** A review authorizes only its own tree, and only while it has not been invalidated. */
export function isReviewCurrent(review: Pick<ReviewRecord, 'treeHash' | 'invalidatedAt'>, candidate: { treeHash: string }): boolean {
  return review.invalidatedAt === null && review.treeHash === candidate.treeHash;
}

/** Valid (not yet invalidated) reviews of this run that were made for some other tree. */
export function findStaleReviews(db: OrbitDb, runId: string, current: { treeHash: string }): ReviewRecord[] {
  return listReviews(db, runId).filter((r) => r.treeHash !== current.treeHash);
}

export interface InvalidateInput {
  runId: string;
  runDir: string;
  /** The candidate now under consideration. */
  current: { candidateId?: string; treeHash: string };
  /** Why the tree changed, for the record (for example "repair candidate 3"). */
  cause?: string;
}

/**
 * Invalidate every still-valid review bound to a tree other than the current
 * one: one transaction with an event each, then a decision naming them.
 * Idempotent: a second call finds nothing left to invalidate. Must run
 * outside a transaction (it records a decision).
 */
export function invalidateStaleReviews(db: OrbitDb, input: InvalidateInput, clock: Clock): ReviewRecord[] {
  const reason = `candidate tree is now ${input.current.treeHash}${input.cause ? ` (${input.cause})` : ''}; a review of another tree authorizes nothing`;
  const stale = findStaleReviews(db, input.runId, input.current);
  if (stale.length === 0) return [];
  // Intent first: a crash after the decision and before the update replays to the same
  // decision id and finishes the update; the other order would lose the decision for good.
  const ids = stale.map((r) => r.id).sort();
  recordDecision(
    db,
    input.runDir,
    {
      id: `dec-review-invalidated-${sha256(canonicalJson([input.runId, input.current.treeHash, ids])).slice(0, 12)}`,
      runId: input.runId,
      kind: 'review.invalidated',
      summary: `${stale.length} review(s) invalidated: ${reason}`.slice(0, 500),
      data: { reviews: stale.map((r) => ({ id: r.id, provider: r.provider, tree_hash: r.treeHash, verdict: r.verdict })), current_tree: input.current.treeHash, cause: input.cause ?? null },
    },
    clock,
  );
  const invalidated = db.tx(() => {
    const out: ReviewRecord[] = [];
    for (const r of stale) if (markReviewInvalidated(db, r.id, reason, clock)) out.push(r);
    return out;
  });
  return invalidated;
}

// ---------------------------------------------------------------------------
// The gate

export interface ReviewGateInput {
  runId: string;
  /** The tree about to be delivered. */
  treeHash: string;
  snapshot: Pick<PolicySnapshot, 'config'>;
  /** Who produced the candidate; needed to tell whether an independent review cleared it. */
  implementerProvider?: string;
  security?: SecurityPolicy;
  /**
   * Gate time (epoch ms, from the injected clock). A finding persisted as excepted is excepted only
   * while its policy exception still covers it at this moment, so an exception that has since
   * expired stops waiving the finding. Required: there is no safe default time.
   */
  now: number;
}

export interface ReviewGateResult {
  ok: boolean;
  reasons: string[];
  /** Current reviews that cleared the tree. */
  cleared: ReviewRecord[];
}

const CLEARS_REPAIR: readonly FindingStatus[] = ['rejected', 'excepted', 'advisory', 'resolved'];
const CLEARS_BLOCK: readonly FindingStatus[] = ['rejected', 'excepted', 'resolved'];

/**
 * Whether the recorded reviews let this tree through. Every current
 * (non-invalidated, same-tree) review must clear: APPROVE, or a
 * REPAIR_REQUIRED or BLOCK whose findings are all closed by recorded
 * resolutions (BLOCK is not cleared by advisory findings, and never by having
 * none). No second reviewer's approval outvotes a first reviewer's open claim.
 * With independent review required, at least one cleared review must come from
 * a provider other than the implementer's. Unresolved blocking findings from
 * any round also stop it.
 */
export function reviewGate(db: OrbitDb, input: ReviewGateInput): ReviewGateResult {
  const reasons: string[] = [];
  const { config } = input.snapshot;
  const current = listReviews(db, input.runId, { treeHash: input.treeHash });
  const security = input.security ?? readSecurityPolicy(input.snapshot);
  // A persisted waiver is re-checked now: if its exception has expired or does not cover the finding's location, the claim is open again.
  const lapsed = new Set<string>();
  const all = listFindings(db, input.runId).map((f): FindingRecord => {
    if (f.status !== 'excepted' || exceptionStillApplies(f, security, input.now)) return f;
    lapsed.add(f.id);
    return { ...f, status: 'open' };
  });

  if (current.length === 0) {
    const stale = findStaleReviews(db, input.runId, { treeHash: input.treeHash });
    reasons.push(stale.length > 0 ? `no review of tree ${input.treeHash}; ${stale.length} review(s) exist only for other trees and authorize nothing` : `no review of tree ${input.treeHash}`);
  }

  const cleared: ReviewRecord[] = [];
  for (const r of current) {
    if (r.verdict === 'APPROVE') {
      cleared.push(r);
      continue;
    }
    const own = all.filter((f) => f.reviewId === r.id);
    const closers = r.verdict === 'BLOCK' ? CLEARS_BLOCK : CLEARS_REPAIR;
    const open = own.filter((f) => !closers.includes(f.status));
    if (own.length === 0) reasons.push(`${r.provider} review ${r.id} is ${r.verdict} with no findings to resolve`);
    else if (open.length > 0) reasons.push(`${r.provider} review ${r.id} is ${r.verdict} and ${open.length} of its finding(s) are unresolved (${open.map((f) => `${f.externalId ?? f.id} ${f.status}`).join(', ')})`);
    else cleared.push(r);
  }

  for (const f of blockingUnresolved(all, input.snapshot, security, lapsed)) {
    const why = lapsed.has(f.id) ? ' (its policy exception has expired or no longer covers it)' : '';
    reasons.push(`finding ${f.externalId ?? f.id} (${f.severity}, ${f.status}) blocks delivery${why}: ${f.claim.slice(0, 120)}`);
  }

  if (config.review.independent_provider_required && cleared.length > 0 && input.implementerProvider === undefined) {
    // Independence cannot be shown without knowing who implemented; passing would fail open.
    reasons.push('independent review is required but the implementer provider was not supplied, so independence cannot be shown');
  } else if (config.review.independent_provider_required && cleared.length > 0 && !cleared.some((r) => r.provider !== input.implementerProvider)) {
    reasons.push(`independent review is required but every clearing review is from "${input.implementerProvider}", the implementer's provider`);
  }
  if (current.length > 0 && cleared.length === 0 && reasons.length === 0) reasons.push('no review cleared this tree');
  return { ok: reasons.length === 0, reasons, cleared };
}

/** The exception recorded when the finding was excepted, looked up in the frozen policy and judged at `now`. */
function exceptionStillApplies(f: FindingRecord, security: SecurityPolicy, now: number): boolean {
  const index = (f.resolutionJson as { exception?: { index?: unknown } } | null)?.exception?.index;
  const exception = typeof index === 'number' ? security.exceptions[index] : undefined;
  return exception !== undefined && exceptionApplies(exception, f, now);
}

function blockingUnresolved(findings: FindingRecord[], snapshot: Pick<PolicySnapshot, 'config'>, security: SecurityPolicy, lapsed: ReadonlySet<string>): FindingRecord[] {
  return findings.filter((f) => {
    if (f.status !== 'open' && f.status !== 'claim_pending' && f.status !== 'accepted') return false;
    // The flag persistResolution recorded wins; a finding never analysed falls back to the severity rule.
    // So does a lapsed waiver: its recorded flag was computed while the exception still applied.
    const flag = (f.resolutionJson as { blocking?: unknown } | null)?.blocking;
    if (typeof flag === 'boolean' && !lapsed.has(f.id)) return flag;
    return severityBlocks(snapshot, f.severity, isSecurityFinding({ category: f.category, externalId: f.externalId }), security);
  });
}

/** `reviewGate`, thrown as STALE_EVIDENCE when it does not pass. */
export function assertReviewGate(db: OrbitDb, input: ReviewGateInput): ReviewGateResult {
  const res = reviewGate(db, input);
  if (!res.ok) throw new OrbitError('STALE_EVIDENCE', `review does not clear tree ${input.treeHash}: ${res.reasons.join('; ')}`, { reasons: res.reasons, treeHash: input.treeHash });
  return res;
}
