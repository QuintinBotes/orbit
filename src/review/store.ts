import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { canonicalJson, sha256 } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { appendEvent } from '../storage/events.ts';
import { recordDecision } from '../storage/decisions.ts';
import {
  FINDING_SEVERITIES,
  FINDING_STATUSES,
  REVIEW_VERDICTS,
  TERMINAL_FINDING_STATUSES,
  UNRESOLVED_FINDING_STATUSES,
  isFindingSeverity,
  isFindingStatus,
  type FindingRecord,
  type FindingSeverity,
  type FindingStatus,
  type IngestedFinding,
  type ReviewRecord,
  type ReviewVerdict,
} from './types.ts';
import type { Resolution, ResolvableFinding, ResolverReview } from './resolve.ts';

/**
 * Repositories for the reviews and findings tables. A review is bound to the
 * candidate tree it examined; its findings are claims whose status changes
 * only through `persistResolution` (or `updateFindingStatus`), each change
 * with its reason and an event in the same transaction.
 *
 * Everything here is synchronous and nests inside a caller's `db.tx`, except
 * `persistResolution`, which writes decision records (a decisions.jsonl
 * mirror line after commit) and so must run outside a transaction.
 */

interface ReviewRow {
  id: string;
  run_id: string;
  candidate_id: string;
  tree_hash: string;
  round: number;
  provider: string;
  model: string | null;
  worker_id: string | null;
  verdict: string;
  packet_sha256: string | null;
  findings_json: string | null;
  created_at: number;
  invalidated_at: number | null;
  invalidated_reason: string | null;
}

interface FindingRow {
  id: string;
  run_id: string;
  review_id: string;
  external_id: string | null;
  severity: string;
  category: string | null;
  location: string | null;
  claim: string;
  evidence: string | null;
  suggested_validation: string | null;
  status: string;
  resolution: string | null;
  resolution_json: string | null;
  created_at: number;
  updated_at: number;
}

function toReview(r: ReviewRow): ReviewRecord {
  if (!(REVIEW_VERDICTS as readonly string[]).includes(r.verdict)) {
    throw new OrbitError('INTERNAL', `review ${r.id} has unknown verdict ${r.verdict}`);
  }
  return {
    id: r.id,
    runId: r.run_id,
    candidateId: r.candidate_id,
    treeHash: r.tree_hash,
    round: r.round,
    provider: r.provider,
    model: r.model,
    workerId: r.worker_id,
    verdict: r.verdict as ReviewVerdict,
    packetSha256: r.packet_sha256,
    createdAt: r.created_at,
    invalidatedAt: r.invalidated_at,
    invalidatedReason: r.invalidated_reason,
  };
}

function toFinding(r: FindingRow): FindingRecord {
  if (!isFindingSeverity(r.severity)) throw new OrbitError('INTERNAL', `finding ${r.id} has unknown severity ${r.severity}`);
  if (!isFindingStatus(r.status)) throw new OrbitError('INTERNAL', `finding ${r.id} has unknown status ${r.status}`);
  return {
    id: r.id,
    runId: r.run_id,
    reviewId: r.review_id,
    externalId: r.external_id,
    severity: r.severity,
    category: r.category,
    location: r.location,
    claim: r.claim,
    evidence: r.evidence,
    suggestedValidation: r.suggested_validation,
    status: r.status,
    resolution: r.resolution,
    resolutionJson: r.resolution_json === null ? null : (JSON.parse(r.resolution_json) as unknown),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface NewReview {
  /** Supply one to make recording idempotent across retries. */
  id?: string;
  runId: string;
  candidateId: string;
  /** The tree the reviewer examined. Must equal the candidate's tree when the candidate row exists. */
  treeHash: string;
  round: number;
  provider: string;
  model: string | null;
  workerId: string | null;
  verdict: ReviewVerdict;
  packetSha256: string | null;
  findings: readonly IngestedFinding[];
}

/** Store id of a finding: stable, so a retried recordReview finds its rows. */
export function findingStoreId(reviewId: string, externalId: string): string {
  return `${reviewId}:${externalId}`;
}

/**
 * Insert a review and its findings (status `open`) in one transaction, with a
 * `review.recorded` event. Recording the same id again with the same content
 * returns the stored review; different content under that id is rejected.
 */
export function recordReview(db: OrbitDb, input: NewReview, clock: Clock): ReviewRecord {
  if (!(REVIEW_VERDICTS as readonly string[]).includes(input.verdict)) throw new OrbitError('SCHEMA_INVALID', `unknown review verdict ${String(input.verdict)}`);
  if (!Number.isInteger(input.round) || input.round < 1) throw new OrbitError('SCHEMA_INVALID', 'review round must be a positive integer');
  if (!input.treeHash) throw new OrbitError('SCHEMA_INVALID', 'a review must be bound to a tree hash');
  const id = input.id ?? newId('rev');
  const seenIds = new Set<string>();
  for (const f of input.findings) {
    // Reading a row with an unknown severity throws, which would make every later listFindings fail.
    if (!isFindingSeverity(f.severity)) throw new OrbitError('SCHEMA_INVALID', `finding ${f.externalId} has unknown severity ${String(f.severity)}`);
    if (!f.externalId || seenIds.has(f.externalId)) throw new OrbitError('SCHEMA_INVALID', `finding id ${JSON.stringify(f.externalId)} is empty or repeated within the review`);
    seenIds.add(f.externalId);
  }
  const findingsJson = canonicalJson(input.findings);
  const now = clock.now();
  return db.tx(() => {
    const existing = db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ?', id);
    if (existing) {
      const same =
        existing.run_id === input.runId &&
        existing.candidate_id === input.candidateId &&
        existing.tree_hash === input.treeHash &&
        existing.provider === input.provider &&
        existing.verdict === input.verdict &&
        existing.findings_json === findingsJson;
      if (!same) throw new OrbitError('CONCURRENT_UPDATE', `review ${id} already exists with different content`, { reviewId: id });
      return toReview(existing);
    }
    if (!db.get('SELECT 1 AS x FROM runs WHERE id = ?', input.runId)) throw new OrbitError('NOT_FOUND', `no run ${input.runId}`);
    const cand = db.get<{ tree_hash: string; run_id: string }>('SELECT tree_hash, run_id FROM candidates WHERE id = ?', input.candidateId);
    // A review of a candidate that was never recorded would bind its tree to nothing the controller made.
    if (!cand) throw new OrbitError('NOT_FOUND', `no candidate ${input.candidateId}`, { candidateId: input.candidateId });
    if (cand.tree_hash !== input.treeHash || cand.run_id !== input.runId) {
      throw new OrbitError('STALE_EVIDENCE', `candidate ${input.candidateId} has tree ${cand.tree_hash}, not the reviewed tree ${input.treeHash}`, {
        candidateId: input.candidateId,
        candidateTree: cand.tree_hash,
        reviewedTree: input.treeHash,
      });
    }
    db.run(
      'INSERT INTO reviews (id, run_id, candidate_id, tree_hash, round, provider, model, worker_id, verdict, packet_sha256, findings_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      input.runId,
      input.candidateId,
      input.treeHash,
      input.round,
      input.provider,
      input.model,
      input.workerId,
      input.verdict,
      input.packetSha256,
      findingsJson,
      now,
    );
    for (const f of input.findings) {
      db.run(
        'INSERT INTO findings (id, run_id, review_id, external_id, severity, category, location, claim, evidence, suggested_validation, status, resolution, resolution_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)',
        findingStoreId(id, f.externalId),
        input.runId,
        id,
        f.externalId,
        f.severity,
        f.category,
        f.location,
        f.claim,
        f.evidence,
        f.suggestedValidation,
        'open',
        now,
        now,
      );
    }
    appendEvent(
      db,
      input.runId,
      'review.recorded',
      'controller',
      { review_id: id, provider: input.provider, model: input.model, verdict: input.verdict, tree_hash: input.treeHash, round: input.round, findings: input.findings.length },
      now,
    );
    return toReview(db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ?', id)!);
  });
}

export function getReview(db: OrbitDb, id: string): ReviewRecord | null {
  const row = db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ?', id);
  return row ? toReview(row) : null;
}

export interface ReviewFilter {
  treeHash?: string;
  provider?: string;
  /** Default false: invalidated reviews are history, not current. */
  includeInvalidated?: boolean;
}

/** A run's reviews, oldest first. */
export function listReviews(db: OrbitDb, runId: string, filter: ReviewFilter = {}): ReviewRecord[] {
  const clauses = ['run_id = ?'];
  const params: (string | number)[] = [runId];
  if (filter.treeHash !== undefined) {
    clauses.push('tree_hash = ?');
    params.push(filter.treeHash);
  }
  if (filter.provider !== undefined) {
    clauses.push('provider = ?');
    params.push(filter.provider);
  }
  if (!filter.includeInvalidated) clauses.push('invalidated_at IS NULL');
  return db.all<ReviewRow>(`SELECT * FROM reviews WHERE ${clauses.join(' AND ')} ORDER BY created_at, rowid`, ...params).map(toReview);
}

/**
 * Mark a review invalid for authorizing anything. Its findings stay: they are
 * still claims about the code, to be carried into the next round. The reason
 * is stored on the row, and also in the event and in the decision
 * `invalidateStaleReviews` records. Idempotent.
 */
export function markReviewInvalidated(db: OrbitDb, reviewId: string, reason: string, clock: Clock): boolean {
  return db.tx(() => {
    const row = db.get<ReviewRow>('SELECT * FROM reviews WHERE id = ?', reviewId);
    if (!row) throw new OrbitError('NOT_FOUND', `no review ${reviewId}`);
    if (row.invalidated_at !== null) return false;
    const now = clock.now();
    db.run('UPDATE reviews SET invalidated_at = ?, invalidated_reason = ? WHERE id = ? AND invalidated_at IS NULL', now, reason.slice(0, 2000), reviewId);
    appendEvent(db, row.run_id, 'review.invalidated', 'controller', { review_id: reviewId, tree_hash: row.tree_hash, reason }, now);
    return true;
  });
}

export function getFinding(db: OrbitDb, id: string): FindingRecord | null {
  const row = db.get<FindingRow>('SELECT * FROM findings WHERE id = ?', id);
  return row ? toFinding(row) : null;
}

export interface FindingFilter {
  reviewId?: string;
  statuses?: readonly FindingStatus[];
  severities?: readonly FindingSeverity[];
}

/** A run's findings in the order they were raised. */
export function listFindings(db: OrbitDb, runId: string, filter: FindingFilter = {}): FindingRecord[] {
  const clauses = ['run_id = ?'];
  const params: (string | number)[] = [runId];
  if (filter.reviewId !== undefined) {
    clauses.push('review_id = ?');
    params.push(filter.reviewId);
  }
  if (filter.statuses) {
    if (filter.statuses.length === 0) return [];
    clauses.push(`status IN (${filter.statuses.map(() => '?').join(',')})`);
    params.push(...filter.statuses);
  }
  if (filter.severities) {
    if (filter.severities.length === 0) return [];
    clauses.push(`severity IN (${filter.severities.map(() => '?').join(',')})`);
    params.push(...filter.severities);
  }
  return db.all<FindingRow>(`SELECT * FROM findings WHERE ${clauses.join(' AND ')} ORDER BY created_at, rowid`, ...params).map(toFinding);
}

export interface FindingUpdate {
  status: FindingStatus;
  /** Why: shown to people and carried into lessons. Required, a status without a reason is not auditable. */
  resolution: string;
  resolutionJson?: unknown;
}

/**
 * Change one finding's status with its reason, in a transaction with a
 * `finding.status` event. `rejected` and `resolved` are terminal. Setting the
 * status a finding already has (same reason) is a no-op, so replays are safe.
 */
export function updateFindingStatus(db: OrbitDb, id: string, update: FindingUpdate, clock: Clock): FindingRecord {
  if (!(FINDING_STATUSES as readonly string[]).includes(update.status)) throw new OrbitError('SCHEMA_INVALID', `unknown finding status ${String(update.status)}`);
  if (!update.resolution.trim()) throw new OrbitError('SCHEMA_INVALID', 'a finding status change needs a recorded reason');
  // "Rejected only with recorded evidence": a terminal closure without an evidence reference, or a waiver
  // without the listed exception, is refused here so no caller can close a claim by assertion.
  const rj = (update.resolutionJson ?? null) as { evidence_refs?: unknown; exception?: unknown } | null;
  if ((update.status === 'rejected' || update.status === 'resolved') && !(Array.isArray(rj?.evidence_refs) && rj.evidence_refs.length > 0 && rj.evidence_refs.every((r) => typeof r === 'string' && r.trim()))) {
    throw new OrbitError('SCHEMA_INVALID', `a ${update.status} finding needs recorded evidence (resolutionJson.evidence_refs)`);
  }
  if (update.status === 'excepted' && !(rj !== null && typeof rj.exception === 'object' && rj.exception !== null)) {
    throw new OrbitError('SCHEMA_INVALID', 'an excepted finding needs the policy exception that waives it (resolutionJson.exception)');
  }
  return db.tx(() => {
    const row = db.get<FindingRow>('SELECT * FROM findings WHERE id = ?', id);
    if (!row) throw new OrbitError('NOT_FOUND', `no finding ${id}`);
    const from = row.status as FindingStatus;
    const json = update.resolutionJson === undefined ? null : canonicalJson(update.resolutionJson);
    if (from === update.status && row.resolution === update.resolution && row.resolution_json === json) return toFinding(row);
    if ((TERMINAL_FINDING_STATUSES as readonly string[]).includes(from) && from !== update.status) {
      throw new OrbitError('TRANSITION_INVALID', `finding ${id} is ${from}; a ${from} finding is never reopened (a re-raised claim is a new finding)`, { findingId: id, from, to: update.status });
    }
    const now = clock.now();
    db.run('UPDATE findings SET status = ?, resolution = ?, resolution_json = ?, updated_at = ? WHERE id = ?', update.status, update.resolution, json, now, id);
    appendEvent(db, row.run_id, 'finding.status', 'controller', { finding_id: id, from, to: update.status, reason: update.resolution }, now);
    return toFinding(db.get<FindingRow>('SELECT * FROM findings WHERE id = ?', id)!);
  });
}

/**
 * Findings that still need resolution and block delivery. Uses the blocking
 * flag `persistResolution` recorded; a finding never analysed falls back to
 * the severity rule, so an unprocessed high finding blocks rather than slips.
 */
export function listBlockingFindings(db: OrbitDb, runId: string, blockSeverities: readonly FindingSeverity[] = ['critical', 'high']): FindingRecord[] {
  return listFindings(db, runId, { statuses: UNRESOLVED_FINDING_STATUSES }).filter((f) => {
    const flag = (f.resolutionJson as { blocking?: unknown } | null)?.blocking;
    return typeof flag === 'boolean' ? flag : blockSeverities.includes(f.severity);
  });
}

export interface ResolverState {
  /** Findings of the non-invalidated reviews of the given tree. */
  findings: ResolvableFinding[];
  /** Every other finding of the run, with its status: unresolved ones are carried, closed ones mark recurrence. */
  previousFindings: ResolvableFinding[];
  reviews: ResolverReview[];
}

/** Everything `resolveFindings` needs for one candidate tree, read in one consistent snapshot. */
export function loadResolverState(db: OrbitDb, runId: string, treeHash: string): ResolverState {
  return db.tx(() => {
    const reviews = listReviews(db, runId, { treeHash });
    const currentReviewIds = new Set(reviews.map((r) => r.id));
    const rows = db.all<FindingRow & { provider: string; tree_hash: string }>(
      'SELECT f.*, r.provider AS provider, r.tree_hash AS tree_hash FROM findings f JOIN reviews r ON r.id = f.review_id WHERE f.run_id = ? ORDER BY f.created_at, f.rowid',
      runId,
    );
    const findings: ResolvableFinding[] = [];
    const previousFindings: ResolvableFinding[] = [];
    for (const row of rows) {
      const f = toFinding(row);
      const rf: ResolvableFinding = {
        id: f.id,
        reviewId: f.reviewId,
        provider: row.provider,
        treeHash: row.tree_hash,
        externalId: f.externalId,
        severity: f.severity,
        category: f.category,
        location: f.location,
        claim: f.claim,
        evidence: f.evidence,
        suggestedValidation: f.suggestedValidation,
        status: f.status,
        resolution: f.resolution,
      };
      (currentReviewIds.has(f.reviewId) ? findings : previousFindings).push(rf);
    }
    return { findings, previousFindings, reviews: reviews.map((r) => ({ id: r.id, provider: r.provider, verdict: r.verdict, treeHash: r.treeHash })) };
  });
}

/** Severities as a value list for callers that build filters; re-exported so users need not import types.ts. */
export { FINDING_SEVERITIES };

function decisionId(kind: string, findingId: string, status: string, reason: string): string {
  return `dec-${kind.replace(/\W+/g, '-')}-${sha256(canonicalJson([findingId, status, reason])).slice(0, 12)}`;
}

/**
 * Persist a resolution: every member finding's status and reason in one
 * transaction, then one decision per accepted, rejected or excepted claim so
 * the decision log says why (spec section 12: "record why findings were
 * accepted or rejected"). Decision ids derive from content, so replaying the
 * same resolution after a crash repairs the mirror without duplicating rows.
 * Must run outside a transaction.
 */
export function persistResolution(db: OrbitDb, runDir: string, runId: string, resolution: Resolution, clock: Clock): { updated: string[] } {
  const updated: string[] = [];
  db.tx(() => {
    for (const d of resolution.dispositions) {
      for (const memberId of d.memberIds) {
        const row = db.get<FindingRow>('SELECT * FROM findings WHERE id = ? AND run_id = ?', memberId, runId);
        if (!row) throw new OrbitError('NOT_FOUND', `no finding ${memberId} in run ${runId}`);
        // A member that is terminal keeps its status; the group's outcome applies to the rest.
        if ((TERMINAL_FINDING_STATUSES as readonly string[]).includes(row.status) && row.status !== d.status) continue;
        const changed = row.status !== d.status || row.resolution !== d.reason;
        updateFindingStatus(
          db,
          memberId,
          {
            status: d.status,
            resolution: d.reason,
            resolutionJson: {
              blocking: d.blocking,
              fingerprint: d.fingerprint,
              tree_hash: resolution.treeHash,
              security: d.security,
              exception: d.exception,
              disagreement: d.disagreement,
              evidence_refs: d.evidenceRefs,
              carried: d.carried,
              claim: d.claim,
            },
          },
          clock,
        );
        if (changed) updated.push(memberId);
      }
    }
  });
  for (const d of resolution.dispositions) {
    if (d.status !== 'accepted' && d.status !== 'rejected' && d.status !== 'excepted' && d.status !== 'resolved') continue;
    const kind = `review.finding.${d.status}`;
    recordDecision(
      db,
      runDir,
      {
        id: decisionId(kind, d.findingId, d.status, d.reason),
        runId,
        kind,
        summary: `${d.externalId ?? d.findingId} (${d.severity}) ${d.status}: ${d.reason}`.slice(0, 500),
        data: {
          finding_ids: d.memberIds,
          fingerprint: d.fingerprint,
          status: d.status,
          severity: d.severity,
          category: d.category,
          location: d.location,
          tree_hash: resolution.treeHash,
          reason: d.reason,
          evidence_refs: d.evidenceRefs,
          exception: d.exception,
          disagreement: d.disagreement,
        },
      },
      clock,
    );
  }
  return { updated };
}
