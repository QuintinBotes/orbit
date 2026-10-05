/**
 * Shared vocabulary for independent review (spec section 12). Findings are
 * claims made by a reviewer model, never verdicts: nothing here lets a model's
 * opinion, a vote or the number of reviewers close a finding. Only recorded
 * evidence bound to the candidate tree does (see resolve.ts).
 */
import { sha256 } from '../core/hash.ts';

export const REVIEW_VERDICTS = ['APPROVE', 'REPAIR_REQUIRED', 'BLOCK'] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** Most severe first; the order is the ranking. */
export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/**
 * Finding lifecycle (findings.status):
 *   open           ingested, not yet analysed
 *   claim_pending  a testable claim awaiting validation (or Inquisition, for a disagreement)
 *   accepted       confirmed as a defect by recorded evidence; a repair is required
 *   rejected       refuted by recorded evidence on the candidate tree (terminal)
 *   excepted       a security finding waived by an exception listed in policy
 *   advisory       below the blocking threshold and not confirmed: a warning, not a defect
 *   resolved       a confirmed or carried claim no longer holds on a newer tree (terminal)
 * `resolved` is the value the knowledge extractor reads as "confirmed and then addressed".
 */
export const FINDING_STATUSES = ['open', 'claim_pending', 'accepted', 'rejected', 'excepted', 'advisory', 'resolved'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** Once a finding is rejected with evidence or resolved, nothing reopens it; a re-raised claim is a new finding. */
export const TERMINAL_FINDING_STATUSES: readonly FindingStatus[] = ['rejected', 'resolved'];

/** Statuses that still need work before the finding stops mattering. */
export const UNRESOLVED_FINDING_STATUSES: readonly FindingStatus[] = ['open', 'claim_pending', 'accepted'];

/**
 * Statuses that mean a confirmed claim was addressed. The knowledge extractor learns hazards only from
 * findings in these statuses, so it imports this list rather than keeping a copy of the vocabulary.
 */
export const RESOLVED_FINDING_STATUSES: readonly FindingStatus[] = ['resolved'];

export function isFindingSeverity(v: unknown): v is FindingSeverity {
  return typeof v === 'string' && (FINDING_SEVERITIES as readonly string[]).includes(v);
}

export function isFindingStatus(v: unknown): v is FindingStatus {
  return typeof v === 'string' && (FINDING_STATUSES as readonly string[]).includes(v);
}

/** 0 is the most severe. */
export function severityRank(s: FindingSeverity): number {
  return FINDING_SEVERITIES.indexOf(s);
}

/** A finding as it came out of a validated review output, normalized and redacted. */
export interface IngestedFinding {
  /** The reviewer's id (SEC-1). Unique within one review only. */
  externalId: string;
  severity: FindingSeverity;
  category: string;
  /** The reviewer's location string, kept verbatim for display. */
  location: string | null;
  /** Repository-relative path parsed from `location`; untrusted, never used for file access. */
  path: string | null;
  line: number | null;
  claim: string;
  evidence: string;
  suggestedValidation: string | null;
}

export interface IngestedReview {
  verdict: ReviewVerdict;
  /** As the reviewer echoed it; verified as a prefix of the candidate commit. */
  candidateRevision: string;
  findings: IngestedFinding[];
  /** Things worth recording that did not make the output invalid. */
  warnings: string[];
}

export interface ReviewRecord {
  id: string;
  runId: string;
  candidateId: string;
  treeHash: string;
  round: number;
  provider: string;
  model: string | null;
  workerId: string | null;
  verdict: ReviewVerdict;
  packetSha256: string | null;
  createdAt: number;
  invalidatedAt: number | null;
  /** Why it stopped counting (reviews.invalidated_reason); null while valid. */
  invalidatedReason: string | null;
}

export interface FindingRecord {
  id: string;
  runId: string;
  reviewId: string;
  externalId: string | null;
  severity: FindingSeverity;
  category: string | null;
  location: string | null;
  claim: string;
  evidence: string | null;
  suggestedValidation: string | null;
  status: FindingStatus;
  resolution: string | null;
  resolutionJson: unknown;
  createdAt: number;
  updatedAt: number;
}

/** `path:line` or `path:line:col` or `path`; anything else yields no path. */
export function splitLocation(location: string | null): { path: string | null; line: number | null } {
  if (location === null) return { path: null, line: null };
  const text = location.trim();
  const m = /^(.+?)(?::(\d+)(?:[:-]\d+)*)?$/.exec(text);
  if (!m || !m[1]) return { path: null, line: null };
  const path = m[1].trim().replace(/^\.\//, '');
  // A path with whitespace or control characters is prose ("the whole change"), not a location.
  if (path.length === 0 || path.length > 512 || /[\s\u0000-\u001f]/.test(path)) return { path: null, line: null };
  return { path, line: m[2] === undefined ? null : Number(m[2]) };
}

function normalizeClaim(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Identity of a claim across reviews and rounds: category, file (not line,
 * which shifts as code moves) and normalized wording. Two reviewers who word a
 * claim differently get different fingerprints; the cost of that is two
 * claims to test, never a wrongly merged one.
 */
export function findingFingerprint(f: { category: string | null; location: string | null; claim: string }): string {
  const { path } = splitLocation(f.location);
  return `fp-${sha256([(f.category ?? '').trim().toLowerCase(), path ?? '', normalizeClaim(f.claim)].join('\n')).slice(0, 16)}`;
}
