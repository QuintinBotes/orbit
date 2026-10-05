import picomatch from 'picomatch';
import { OrbitError } from '../core/errors.ts';
import { redact } from '../core/redact.ts';
import { validateModelOutput } from '../contract/model-outputs.ts';
import type { CheckStatus, RepairBrief } from '../evidence/types.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import {
  FINDING_SEVERITIES,
  UNRESOLVED_FINDING_STATUSES,
  findingFingerprint,
  isFindingSeverity,
  severityRank,
  splitLocation,
  type FindingSeverity,
  type FindingStatus,
  type IngestedFinding,
  type IngestedReview,
  type ReviewVerdict,
} from './types.ts';

/**
 * Finding ingestion and resolution (spec section 12).
 *
 * The rules this file exists to keep:
 *  - A finding is a claim. It is closed only by recorded evidence bound to the
 *    candidate tree (a test that exercises the claim and passes, or a
 *    reproduction that fails), never by a majority, a second model's opinion,
 *    or the implementer's say-so.
 *  - Disagreement (two reviewers, or reviewer against implementer) is not
 *    settled here. It becomes a claim to test, routed to Inquisition.
 *  - High and critical findings block delivery until resolved. Security
 *    findings follow an explicit severity and exception policy; an exception
 *    counts only when it is listed in policy.
 *  - Every disposition carries its reason, which `persistResolution` records.
 */

// ---------------------------------------------------------------------------
// Ingestion

export interface IngestInput {
  /** The parsed structured output of the reviewer; validated against schemas/review-output.schema.json. */
  output: unknown;
  /** The candidate the review packet named. */
  candidate: { commitSha: string; treeHash: string };
}

/**
 * Validate a reviewer's output and normalize it. A review that does not match
 * the schema is MALFORMED_OUTPUT, never "no findings". A review of a different
 * revision than the candidate is STALE_EVIDENCE: it says nothing about this tree.
 */
export function ingestFindings(input: IngestInput): IngestedReview {
  const out = validateModelOutput('review', input.output);
  const rev = out.candidate_revision.toLowerCase();
  const commit = input.candidate.commitSha.toLowerCase();
  if (rev.length < 7 || !commit.startsWith(rev)) {
    throw new OrbitError('STALE_EVIDENCE', `the review is for revision ${rev}, not candidate ${commit.slice(0, 12)}`, {
      reviewedRevision: rev,
      candidateCommit: commit,
      candidateTree: input.candidate.treeHash,
    });
  }
  const seen = new Set<string>();
  const findings: IngestedFinding[] = [];
  for (const f of out.findings) {
    if (seen.has(f.id)) throw new OrbitError('MALFORMED_OUTPUT', `review output repeats finding id ${f.id}`, { findingId: f.id });
    seen.add(f.id);
    const location = f.location === null ? null : redact(f.location).trim() || null;
    const { path, line } = splitLocation(location);
    findings.push({
      externalId: f.id,
      severity: f.severity,
      category: redact(f.category).trim(),
      location,
      path,
      line,
      claim: redact(f.claim).trim(),
      evidence: redact(f.evidence).trim(),
      suggestedValidation: f.suggested_validation === null ? null : redact(f.suggested_validation).trim() || null,
    });
  }
  const warnings: string[] = [];
  const high = findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
  if (out.verdict === 'APPROVE' && high.length > 0) {
    warnings.push(`verdict APPROVE contradicts ${high.length} high or critical finding(s); the findings govern`);
  }
  if (out.verdict !== 'APPROVE' && findings.length === 0) {
    warnings.push(`verdict ${out.verdict} came with no findings, so there is no claim to test`);
  }
  return { verdict: out.verdict, candidateRevision: rev, findings, warnings };
}

// ---------------------------------------------------------------------------
// Security policy

/**
 * An exception to the security severity rule. It must be listed in trusted
 * policy; a reviewer, implementer or worker cannot create one. Everything is
 * explicit: exact category, the severities it covers (critical only when
 * listed), an optional path glob, a reason, and an optional expiry.
 */
export interface SecurityException {
  category: string;
  /** Glob against the finding's path; absent means any location. */
  location?: string;
  severities: FindingSeverity[];
  reason: string;
  /** ISO date or date-time; after it the exception no longer applies. A date alone covers that whole UTC day. */
  expires?: string;
}

export interface SecurityPolicy {
  /**
   * Severities at which an unresolved security finding blocks. null means the
   * general rule (high and critical, when review.block_unresolved_high_impact_findings).
   */
  blockSeverities: FindingSeverity[] | null;
  exceptions: SecurityException[];
}

export const DEFAULT_SECURITY_POLICY: SecurityPolicy = Object.freeze({ blockSeverities: null, exceptions: [] }) as SecurityPolicy;

function configError(message: string): OrbitError {
  return new OrbitError('CONFIG_INVALID', `review.security: ${message}`);
}

/**
 * Read `review.security` from the frozen policy snapshot (the shipped config
 * schema carries it, with `location` and `expires` as null when unset). A
 * snapshot without it, as an older one would be, gets the default: no
 * exceptions, so nothing is waived. Malformed policy is rejected, never
 * partially honoured: a waiver must be unambiguous.
 */
export function readSecurityPolicy(snapshot: Pick<PolicySnapshot, 'config'>): SecurityPolicy {
  const raw: unknown = snapshot.config.review?.security;
  if (raw === undefined || raw === null) return DEFAULT_SECURITY_POLICY;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw configError('must be an object');
  const r = raw as { block_severities?: unknown; exceptions?: unknown };
  let blockSeverities: FindingSeverity[] | null = null;
  if (r.block_severities !== undefined) {
    if (!Array.isArray(r.block_severities) || !r.block_severities.every(isFindingSeverity)) throw configError(`block_severities must list severities from ${FINDING_SEVERITIES.join(', ')}`);
    blockSeverities = [...(r.block_severities as FindingSeverity[])];
  }
  const exceptions: SecurityException[] = [];
  if (r.exceptions !== undefined) {
    if (!Array.isArray(r.exceptions)) throw configError('exceptions must be a list');
    r.exceptions.forEach((e: unknown, i) => {
      if (typeof e !== 'object' || e === null || Array.isArray(e)) throw configError(`exceptions[${i}] must be an object`);
      const x = e as Record<string, unknown>;
      if (typeof x.category !== 'string' || !x.category.trim()) throw configError(`exceptions[${i}].category is required`);
      if (typeof x.reason !== 'string' || !x.reason.trim()) throw configError(`exceptions[${i}].reason is required: a waiver without a reason is not auditable`);
      if (!Array.isArray(x.severities) || x.severities.length === 0 || !x.severities.every(isFindingSeverity)) throw configError(`exceptions[${i}].severities must list the severities it covers`);
      // null is how the typed config says "not set".
      const location = x.location ?? undefined;
      const expires = x.expires ?? undefined;
      if (location !== undefined && (typeof location !== 'string' || !location.trim())) throw configError(`exceptions[${i}].location must be a glob string`);
      if (expires !== undefined && (typeof expires !== 'string' || Number.isNaN(Date.parse(expires)))) throw configError(`exceptions[${i}].expires must be an ISO date`);
      exceptions.push({
        category: x.category.trim(),
        severities: [...(x.severities as FindingSeverity[])],
        reason: x.reason.trim(),
        ...(location !== undefined ? { location: location as string } : {}),
        ...(expires !== undefined ? { expires: expires as string } : {}),
      });
    });
  }
  return { blockSeverities, exceptions };
}

// Fail closed: an over-broad match only makes a finding follow the stricter security rule.
const SECURITY_CATEGORY = /secur|auth|inject|sqli|xss|csrf|ssrf|\brce\b|secret|credential|crypto|tenant|privacy|\bpii\b|traversal|deserializ|permission|access.?control|sandbox|vulnerab|escalation/i;

export function isSecurityFinding(f: { category: string | null; externalId: string | null }): boolean {
  return (f.category !== null && SECURITY_CATEGORY.test(f.category)) || (f.externalId !== null && /^SEC[A-Z0-9]*-/.test(f.externalId));
}

/** Whether an unresolved finding of this severity blocks delivery under the snapshot's policy. */
export function severityBlocks(snapshot: Pick<PolicySnapshot, 'config'>, severity: FindingSeverity, security: boolean, policy: SecurityPolicy): boolean {
  if (security && policy.blockSeverities !== null) return policy.blockSeverities.includes(severity);
  return snapshot.config.review.block_unresolved_high_impact_findings && (severity === 'critical' || severity === 'high');
}

export interface ExceptionMatch {
  index: number;
  exception: SecurityException;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Last instant an exception applies. The config schema allows a plain date, which reads as "through that day". */
export function exceptionExpiryMs(expires: string): number {
  return DATE_ONLY.test(expires) ? Date.parse(`${expires}T23:59:59.999Z`) : Date.parse(expires);
}

/**
 * Whether one exception still applies to a finding at `now`: its category, its location glob when one is
 * set, and its expiry. Severity is matched separately (see matchException) because a finding that was
 * grouped with a more severe one was excepted at the group's severity.
 */
export function exceptionApplies(e: SecurityException, f: { category: string | null; location: string | null }, now: number | undefined): boolean {
  const { path } = splitLocation(f.location);
  if ((f.category ?? '').trim().toLowerCase() !== e.category.toLowerCase()) return false;
  if (e.location !== undefined && (path === null || !picomatch(e.location, { dot: true })(path))) return false;
  // Without a clock reading expiry cannot be shown to have not passed, so a dated waiver does not apply.
  if (e.expires !== undefined && (now === undefined || now > exceptionExpiryMs(e.expires))) return false;
  return true;
}

/** The first policy exception that covers this finding at time `now`. */
export function matchException(f: { category: string | null; location: string | null; severity: FindingSeverity }, policy: SecurityPolicy, now: number | undefined): ExceptionMatch | null {
  for (let i = 0; i < policy.exceptions.length; i++) {
    const e = policy.exceptions[i] as SecurityException;
    if (!e.severities.includes(f.severity)) continue;
    if (!exceptionApplies(e, f, now)) continue;
    return { index: i, exception: e };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Evidence

/** Kinds of evidence a machine produced. A model's opinion is not among them. */
export const MACHINE_EVIDENCE_KINDS = ['new_test', 'existing_check', 'reproduction', 'static_analysis'] as const;

/**
 * A recorded result about one claim. `refutes` means the claim does not hold on
 * the tree (a test that exercises it passes); `confirms` means it does (the
 * same test fails). Bound to a tree: evidence about another tree is ignored.
 */
export interface ClaimEvidence {
  findingId?: string;
  fingerprint?: string;
  kind: string;
  treeHash: string;
  verdict: 'confirms' | 'refutes';
  status: CheckStatus;
  flaky?: boolean;
  /** The check was written or selected to exercise this claim. A passing suite that never touches it refutes nothing. */
  exercisesClaim: boolean;
  checkId?: string | null;
  /** Artifact reference: a log path or hash. Required. */
  ref: string;
  note?: string;
}

type EvidenceEffect = { ok: true; effect: 'confirms' | 'refutes' } | { ok: false; why: string };

function assessEvidence(e: ClaimEvidence, treeHash: string): EvidenceEffect {
  if (!(MACHINE_EVIDENCE_KINDS as readonly string[]).includes(e.kind)) return { ok: false, why: `kind "${e.kind}" is an opinion, not reproducible evidence` };
  if (!e.ref || !e.ref.trim()) return { ok: false, why: 'no artifact reference' };
  if (e.treeHash !== treeHash) return { ok: false, why: `bound to tree ${e.treeHash.slice(0, 12)}, not the candidate tree ${treeHash.slice(0, 12)}` };
  if (!e.exercisesClaim) return { ok: false, why: 'does not exercise the claim' };
  if (e.flaky) return { ok: false, why: 'flaky result' };
  if (e.verdict === 'refutes') {
    return e.status === 'PASSED' ? { ok: true, effect: 'refutes' } : { ok: false, why: `a refuting check must pass on the candidate, status is ${e.status}` };
  }
  return e.status === 'FAILED' ? { ok: true, effect: 'confirms' } : { ok: false, why: `a confirming check must fail on the candidate, status is ${e.status}` };
}

function describeEvidence(e: ClaimEvidence): string {
  return `${e.kind}${e.checkId ? ` ${e.checkId}` : ''} ${e.status} on tree ${e.treeHash.slice(0, 12)} (${e.ref})`;
}

// ---------------------------------------------------------------------------
// Inputs and outputs of resolution

/** A finding as resolution needs it: a stored finding joined with its review. */
export interface ResolvableFinding {
  id: string;
  reviewId: string;
  provider: string;
  /** The tree the finding's review examined. */
  treeHash: string;
  externalId: string | null;
  severity: FindingSeverity;
  category: string | null;
  location: string | null;
  claim: string;
  evidence: string | null;
  suggestedValidation: string | null;
  status?: FindingStatus;
  /** The recorded reason for `status`, when it has one. */
  resolution?: string | null;
}

export interface ResolverReview {
  id: string;
  provider: string;
  verdict: ReviewVerdict;
  treeHash: string;
}

export interface ImplementerDispute {
  findingId?: string;
  fingerprint?: string;
  rationale: string;
}

export interface ResolveInput {
  /** Findings from the reviews of the current candidate tree. */
  findings: readonly ResolvableFinding[];
  snapshot: Pick<PolicySnapshot, 'config'>;
  /** Recorded evidence; only what is bound to `treeHash` counts. */
  evidence: readonly ClaimEvidence[];
  /** Earlier rounds' findings. Those still unresolved are carried forward and keep blocking until evidence on this tree closes them. */
  previousFindings?: readonly ResolvableFinding[];
  /** The candidate tree under review. */
  treeHash: string;
  /** Every review of this tree, including those with no findings: an APPROVE next to a finding is a disagreement. */
  reviews?: readonly ResolverReview[];
  disputes?: readonly ImplementerDispute[];
  /** Overrides the policy read from the snapshot; tests and callers that already parsed it. */
  security?: SecurityPolicy;
  /** For exception expiry; from the injected clock. */
  now?: number;
}

export type DisagreementKind = 'reviewer-vs-reviewer' | 'severity' | 'reviewer-vs-implementer' | 'conflicting-evidence';

export interface Disagreement {
  kinds: DisagreementKind[];
  parties: string[];
  detail: string[];
}

export interface Disposition {
  /** The representative finding's store id; every member shares the outcome. */
  findingId: string;
  memberIds: string[];
  externalId: string | null;
  fingerprint: string;
  severity: FindingSeverity;
  category: string | null;
  location: string | null;
  claim: string;
  status: FindingStatus;
  blocking: boolean;
  reason: string;
  evidenceRefs: string[];
  security: boolean;
  exception: { index: number; category: string; location: string | null; reason: string } | null;
  disagreement: Disagreement | null;
  /** True when no member of the group was raised against the current tree. */
  carried: boolean;
  /** Earlier findings of the same claim that were closed (rejected or resolved) on another tree. */
  recurrenceOf: string[];
}

export type ClaimRoute = 'validate' | 'inquisition';
export type ClaimReason = 'unvalidated' | 'disagreement' | 'conflicting-evidence' | 'no-proposed-validation' | 'confirmed' | 'carried';

export interface TestableClaim {
  claimId: string;
  findingId: string;
  memberIds: string[];
  statement: string;
  location: string | null;
  severity: FindingSeverity;
  /** A test or check that would confirm or refute the claim. */
  proposedValidation: string;
  validationSource: 'reviewer' | 'derived';
  route: ClaimRoute;
  reason: ClaimReason;
  status: FindingStatus;
  blocking: boolean;
  disagreement: Disagreement | null;
}

export interface ReviewRepairBrief extends RepairBrief {
  finding_ids: string[];
  severity: FindingSeverity;
}

export interface VerdictIssue {
  reviewId: string;
  provider: string;
  verdict: ReviewVerdict;
  reason: string;
}

export interface Resolution {
  treeHash: string;
  dispositions: Disposition[];
  /** Unresolved findings that block delivery. */
  blocking: Disposition[];
  repairBriefs: ReviewRepairBrief[];
  /** Every finding as a testable claim. */
  claims: TestableClaim[];
  /** Claims still awaiting validation; disagreements are routed to Inquisition. */
  claimsToTest: TestableClaim[];
  /** Confirmed by evidence, repair required. */
  accepted: Disposition[];
  /** Refuted by evidence. */
  rejected: Disposition[];
  excepted: Disposition[];
  advisory: Disposition[];
  resolved: Disposition[];
  /** Reviews whose verdict asked for repair or blocked without naming a claim. */
  verdictIssues: VerdictIssue[];
  /** Evidence that was supplied and not counted, with why. */
  ignoredEvidence: { ref: string; why: string }[];
  /** Nothing blocks and no verdict is unexplained. This is necessary for review to clear, not sufficient (see stale.ts reviewGate). */
  clear: boolean;
}

// ---------------------------------------------------------------------------
// Resolution

interface Member {
  f: ResolvableFinding;
  current: boolean;
}

const PRIOR_OPEN: readonly FindingStatus[] = UNRESOLVED_FINDING_STATUSES;
const MAX_QUOTED = 300;

function quoted(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > MAX_QUOTED ? `${one.slice(0, MAX_QUOTED)}...` : one;
}

export function resolveFindings(input: ResolveInput): Resolution {
  const security = input.security ?? readSecurityPolicy(input.snapshot);
  const treeHash = input.treeHash;
  const reviews = (input.reviews ?? []).filter((r) => r.treeHash === treeHash);
  const currentIds = new Set(input.findings.map((f) => f.id));

  // Current findings, plus earlier unresolved ones still owed a resolution.
  const members: Member[] = input.findings.map((f) => ({ f, current: true }));
  const closedEarlier = new Map<string, string[]>();
  for (const p of input.previousFindings ?? []) {
    if (currentIds.has(p.id)) continue;
    const fp = findingFingerprint(p);
    if (p.status !== undefined && PRIOR_OPEN.includes(p.status)) {
      members.push({ f: p, current: false });
    } else if (p.status === 'rejected' || p.status === 'resolved') {
      closedEarlier.set(fp, [...(closedEarlier.get(fp) ?? []), p.id]);
    }
  }

  const groups = new Map<string, Member[]>();
  for (const m of members) {
    const fp = findingFingerprint(m.f);
    const g = groups.get(fp);
    if (g) g.push(m);
    else groups.set(fp, [m]);
  }

  const ignoredEvidence: { ref: string; why: string }[] = [];
  const ignoredSeen = new Set<ClaimEvidence>();
  const dispositions: Disposition[] = [];
  const claims: TestableClaim[] = [];
  const repairBriefs: ReviewRepairBrief[] = [];

  for (const [fp, group] of groups) {
    const memberIds = group.map((m) => m.f.id);
    const rep = pickRepresentative(group);
    const severity = group.reduce<FindingSeverity>((s, m) => (severityRank(m.f.severity) < severityRank(s) ? m.f.severity : s), rep.f.severity);
    const sec = group.some((m) => isSecurityFinding(m.f));
    const blocks = severityBlocks(input.snapshot, severity, sec, security);
    const carried = group.every((m) => !m.current);
    const wasAccepted = group.some((m) => m.f.status === 'accepted');

    // Evidence for this claim, split into what counts and what does not.
    const refutes: ClaimEvidence[] = [];
    const confirms: ClaimEvidence[] = [];
    for (const e of input.evidence) {
      if (!((e.findingId !== undefined && memberIds.includes(e.findingId)) || e.fingerprint === fp)) continue;
      const a = assessEvidence(e, treeHash);
      if (!a.ok) {
        if (!ignoredSeen.has(e)) {
          ignoredSeen.add(e);
          ignoredEvidence.push({ ref: e.ref, why: a.why });
        }
      } else if (a.effect === 'refutes') refutes.push(e);
      else confirms.push(e);
    }

    const disagreement = detectDisagreement(group, reviews, input.disputes ?? [], fp, refutes.length > 0 && confirms.length > 0);
    const exceptionMatch = sec ? matchException({ category: rep.f.category, location: rep.f.location, severity }, security, input.now) : null;
    const refs = (list: ClaimEvidence[]): string[] => list.map(describeEvidence);

    let status: FindingStatus;
    let reason: string;
    let evidenceRefs: string[] = [];
    let reasonCode: ClaimReason = 'unvalidated';

    // Closed against this very tree in an earlier pass: terminal, and evidence is not re-litigated.
    const currentMembers = group.filter((m) => m.current);
    const closedHere = currentMembers.length > 0 && currentMembers.every((m) => m.f.status === 'rejected' || m.f.status === 'resolved') ? currentMembers[0]!.f : null;

    if (closedHere) {
      status = closedHere.status as FindingStatus;
      reason = closedHere.resolution ?? `${closedHere.status} earlier on this tree`;
    } else if (refutes.length > 0 && confirms.length > 0) {
      status = 'claim_pending';
      reason = `conflicting evidence on tree ${treeHash.slice(0, 12)}: ${refs(refutes).join('; ')} refutes while ${refs(confirms).join('; ')} confirms; needs Inquisition`;
      evidenceRefs = [...refs(refutes), ...refs(confirms)];
      reasonCode = 'conflicting-evidence';
    } else if (refutes.length > 0) {
      // Fixed if it was ever confirmed; rejected if the claim never held.
      status = wasAccepted ? 'resolved' : 'rejected';
      evidenceRefs = refs(refutes);
      reason = wasAccepted
        ? `confirmed earlier and no longer holds: ${evidenceRefs.join('; ')}`
        : `refuted by recorded evidence: ${evidenceRefs.join('; ')}`;
    } else if (exceptionMatch) {
      status = 'excepted';
      reason = `security exception ${exceptionMatch.index} listed in policy: ${exceptionMatch.exception.reason}`;
      if (confirms.length > 0) evidenceRefs = refs(confirms);
    } else if (confirms.length > 0) {
      status = 'accepted';
      evidenceRefs = refs(confirms);
      reason = `confirmed by recorded evidence: ${evidenceRefs.join('; ')}`;
      reasonCode = 'confirmed';
    } else if (wasAccepted) {
      status = 'accepted';
      reason = `confirmed on an earlier tree; no evidence on tree ${treeHash.slice(0, 12)} that it is fixed`;
      reasonCode = 'carried';
    } else if (disagreement) {
      status = 'claim_pending';
      reason = `disagreement (${disagreement.kinds.join(', ')}): ${disagreement.detail.join('; ')}; decided by evidence, not by vote`;
      reasonCode = 'disagreement';
    } else if (blocks) {
      status = 'claim_pending';
      reason = `${severity} finding unvalidated; it blocks delivery until a test or check confirms or refutes it`;
    } else if (sec && severityRank(severity) <= severityRank('high')) {
      // Policy chose not to block at this severity, but the claim is serious enough to still test.
      status = 'claim_pending';
      reason = `${severity} security finding awaiting validation; policy does not block on it`;
    } else if (sec) {
      status = 'advisory';
      reason = `security warning below the blocking severities (${(security.blockSeverities ?? ['critical', 'high']).join(', ')}): reported, not treated as a confirmed defect`;
    } else if (severityRank(severity) <= severityRank('medium')) {
      status = 'claim_pending';
      reason = `${severity} finding awaiting validation`;
    } else {
      status = 'advisory';
      reason = `${severity} finding: reported, not blocking`;
    }
    if (carried && status === 'claim_pending' && reasonCode === 'unvalidated') reasonCode = 'carried';

    const unresolved = status === 'claim_pending' || status === 'accepted' || status === 'open';
    const blocking = unresolved && blocks;
    if (unresolved && !blocks && !input.snapshot.config.review.block_unresolved_high_impact_findings && (severity === 'critical' || severity === 'high')) {
      reason += ' (review.block_unresolved_high_impact_findings is false, so it does not block)';
    }

    const exception = exceptionMatch
      ? { index: exceptionMatch.index, category: exceptionMatch.exception.category, location: exceptionMatch.exception.location ?? null, reason: exceptionMatch.exception.reason }
      : null;

    const d: Disposition = {
      findingId: rep.f.id,
      memberIds,
      externalId: rep.f.externalId,
      fingerprint: fp,
      severity,
      category: rep.f.category,
      location: rep.f.location,
      claim: rep.f.claim,
      status,
      blocking,
      reason,
      evidenceRefs,
      security: sec,
      exception,
      disagreement: status === 'claim_pending' && reasonCode === 'conflicting-evidence' ? { kinds: [...(disagreement?.kinds ?? []), 'conflicting-evidence'], parties: disagreement?.parties ?? [], detail: [...(disagreement?.detail ?? []), 'checks contradict each other'] } : disagreement,
      carried,
      recurrenceOf: closedEarlier.get(fp) ?? [],
    };
    if (d.recurrenceOf.length > 0 && !carried) d.reason += `; re-raised after ${d.recurrenceOf.length} earlier closure(s) on other trees, so it was re-tested against this tree`;
    dispositions.push(d);

    const claim = toClaim(d, group, reasonCode);
    claims.push(claim);
    if (status === 'accepted') repairBriefs.push(toRepairBrief(d, claim, group, input.snapshot, confirms));
  }

  const order = (a: Disposition, b: Disposition): number => severityRank(a.severity) - severityRank(b.severity) || a.findingId.localeCompare(b.findingId);
  dispositions.sort(order);
  claims.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.findingId.localeCompare(b.findingId));
  repairBriefs.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.fingerprint.localeCompare(b.fingerprint));
  const by = (s: FindingStatus): Disposition[] => dispositions.filter((d) => d.status === s);

  const verdictIssues: VerdictIssue[] = [];
  for (const r of reviews) {
    if (r.verdict === 'APPROVE') continue;
    if (!input.findings.some((f) => f.reviewId === r.id)) {
      verdictIssues.push({ reviewId: r.id, provider: r.provider, verdict: r.verdict, reason: `verdict ${r.verdict} names no finding, so there is no claim to test; ask for a re-review with explicit findings or record an Inquisition decision` });
    }
  }

  const blocking = dispositions.filter((d) => d.blocking);
  return {
    treeHash,
    dispositions,
    blocking,
    repairBriefs,
    claims,
    claimsToTest: claims.filter((c) => c.status === 'claim_pending'),
    accepted: by('accepted'),
    rejected: by('rejected'),
    excepted: by('excepted'),
    advisory: by('advisory'),
    resolved: by('resolved'),
    verdictIssues,
    ignoredEvidence,
    clear: blocking.length === 0 && verdictIssues.length === 0,
  };
}

function pickRepresentative(group: Member[]): Member {
  return [...group].sort((a, b) => Number(b.current) - Number(a.current) || severityRank(a.f.severity) - severityRank(b.f.severity) || a.f.id.localeCompare(b.f.id))[0] as Member;
}

/**
 * Disagreement is observed, never voted on: a reviewer that approved the same
 * tree while another raised the claim, reviewers rating the same claim at
 * different severities, or the implementer disputing it.
 */
function detectDisagreement(group: Member[], reviews: readonly ResolverReview[], disputes: readonly ImplementerDispute[], fp: string, conflictingEvidence: boolean): Disagreement | null {
  const current = group.filter((m) => m.current).map((m) => m.f);
  const kinds: DisagreementKind[] = [];
  const parties = new Set<string>();
  const detail: string[] = [];

  if (current.length > 0) {
    const raisedBy = new Set(current.map((f) => f.reviewId));
    const approvers = reviews.filter((r) => r.verdict === 'APPROVE' && !raisedBy.has(r.id));
    if (approvers.length > 0) {
      kinds.push('reviewer-vs-reviewer');
      for (const f of current) parties.add(f.provider);
      for (const a of approvers) parties.add(a.provider);
      detail.push(`${[...new Set(current.map((f) => f.provider))].join(', ')} raised it while ${[...new Set(approvers.map((a) => a.provider))].join(', ')} approved the same tree`);
    }
    const sev = new Map<FindingSeverity, Set<string>>();
    for (const f of current) sev.set(f.severity, (sev.get(f.severity) ?? new Set()).add(f.provider));
    if (new Set(current.map((f) => f.reviewId)).size > 1 && sev.size > 1) {
      kinds.push('severity');
      for (const f of current) parties.add(f.provider);
      detail.push(`severity differs: ${[...sev].map(([s, p]) => `${s} (${[...p].join(', ')})`).join(' vs ')}`);
    }
  }
  const ids = new Set(group.map((m) => m.f.id));
  const disputed = disputes.filter((d) => (d.findingId !== undefined && ids.has(d.findingId)) || d.fingerprint === fp);
  if (disputed.length > 0) {
    kinds.push('reviewer-vs-implementer');
    parties.add('implementer');
    for (const m of group) parties.add(m.f.provider);
    detail.push(`the implementer disputes it: ${quoted(disputed[0]!.rationale)}`);
  }
  if (kinds.length === 0 && !conflictingEvidence) return null;
  return { kinds, parties: [...parties].sort(), detail };
}

function toClaim(d: Disposition, group: Member[], reason: ClaimReason): TestableClaim {
  const proposed = group.map((m) => m.f.suggestedValidation).find((v): v is string => typeof v === 'string' && v.trim().length > 0);
  const derived = `Write a check that exercises this claim${d.location ? ` at ${d.location}` : ''}: "${quoted(d.claim)}". It must fail on the candidate if the claim holds and pass if it does not.`;
  const route: ClaimRoute = d.disagreement !== null || proposed === undefined ? 'inquisition' : 'validate';
  return {
    claimId: d.fingerprint,
    findingId: d.findingId,
    memberIds: d.memberIds,
    statement: d.claim,
    location: d.location,
    severity: d.severity,
    proposedValidation: proposed ?? derived,
    validationSource: proposed === undefined ? 'derived' : 'reviewer',
    route,
    reason: d.disagreement !== null && reason === 'unvalidated' ? 'disagreement' : proposed === undefined && reason === 'unvalidated' ? 'no-proposed-validation' : reason,
    status: d.status,
    blocking: d.blocking,
    disagreement: d.disagreement,
  };
}

function toRepairBrief(d: Disposition, claim: TestableClaim, group: Member[], snapshot: Pick<PolicySnapshot, 'config'>, confirms: ClaimEvidence[]): ReviewRepairBrief {
  const supporting = group.map((m) => m.f.evidence).filter((e): e is string => typeof e === 'string' && e.trim().length > 0);
  return {
    fingerprint: `review:${d.fingerprint}`,
    evidence: d.evidenceRefs.length > 0 ? d.evidenceRefs : confirms.map(describeEvidence),
    hypotheses: [{ statement: quoted(d.claim), supporting: quoted(supporting[0] ?? d.reason) }],
    experiment: claim.proposedValidation,
    expected_observation: 'The validation fails on the current candidate and passes on the repaired one.',
    scoped_fix: `Address the claim${d.location ? ` at ${d.location}` : ''} without changing behavior the criteria do not cover.`,
    post_fix_checks: [claim.proposedValidation, 'Rerun every mandatory check on the new candidate.'],
    preserved_constraints: [
      `Stay within scope.allowed_paths (${snapshot.config.scope.allowed_paths.join(', ') || 'none'}) and the contract's allowed paths.`,
      'Do not weaken, skip or delete tests to make the validation pass.',
    ],
    finding_ids: d.memberIds,
    severity: d.severity,
  };
}
