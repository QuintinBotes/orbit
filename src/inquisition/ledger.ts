import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import { getDecision } from '../storage/decisions.ts';
import type { InquisitorOutput } from '../contract/model-outputs.ts';
import { CONFIDENCE_LEVELS, REVERSIBILITIES } from './types.ts';
import { isHumanActor } from './questions.ts';
import {
  LEDGER_EVIDENCE_KINDS,
  LEDGER_STATUSES,
  getLedgerEntry,
  insertLedgerEntry,
  listLedger,
  writeLedgerStatus,
  type LedgerEvidence,
  type LedgerEvidenceKind,
  type LedgerRecord,
  type LedgerStatus,
  type NewLedgerEntry,
} from './store.ts';

/**
 * The assumption ledger (spec section 10 "Ledger"): claim, source,
 * qualitative confidence, consequence if wrong, reversibility, validation
 * experiment, and a status that only evidence can change. Confidence is a
 * word, not a number: invented probabilities would look calibrated and aren't.
 *
 * Status moves:
 *   unverified     -> supported | rejected | needs-decision
 *   needs-decision -> supported | rejected      (only through a recorded human decision)
 *   supported      -> rejected | unverified     (contradicting or stale evidence)
 *   rejected       -> supported                 (new evidence overturns it)
 * A model's say-so is not evidence: a worker that reports an assumption as
 * supported gets it recorded as unverified with the claim attached.
 */

export interface EvidenceInput {
  kind: LedgerEvidenceKind;
  ref: string;
  note?: string;
}

const ALLOWED: Record<LedgerStatus, readonly LedgerStatus[]> = {
  unverified: ['supported', 'rejected', 'needs-decision'],
  'needs-decision': ['supported', 'rejected'],
  supported: ['rejected', 'unverified'],
  rejected: ['supported'],
};

/** A review is an opinion about the work, so it can contest a claim but cannot settle one. */
const SETTLING_KINDS: ReadonlySet<LedgerEvidenceKind> = new Set(['check', 'experiment', 'inspection', 'decision']);

export function addAssumption(
  db: OrbitDb,
  input: Omit<NewLedgerEntry, 'evidence'> & { evidence?: EvidenceInput[] },
  clock: Clock,
): LedgerRecord {
  const problems: string[] = [];
  if (!input.claim.trim()) problems.push('claim is empty');
  if (!input.source.trim()) problems.push('source is empty');
  if (!CONFIDENCE_LEVELS.includes(input.confidence)) problems.push(`confidence must be one of ${CONFIDENCE_LEVELS.join(', ')}`);
  if (!REVERSIBILITIES.includes(input.reversibility)) problems.push(`reversibility must be one of ${REVERSIBILITIES.join(', ')}`);
  if (input.consequence === null || !input.consequence.trim()) problems.push('consequence if wrong is empty');
  if (input.status !== undefined && !LEDGER_STATUSES.includes(input.status)) problems.push(`status must be one of ${LEDGER_STATUSES.join(', ')}`);
  if (problems.length > 0) throw new OrbitError('SCHEMA_INVALID', `assumption rejected: ${problems.join('; ')}`, { problems });

  const requested = input.status ?? 'unverified';
  const evidence: LedgerEvidence[] = (input.evidence ?? []).map((e) => stamp(db, input.runId, e, clock, requested === 'supported'));
  if ((requested === 'supported' || requested === 'rejected') && !evidence.some((e) => e.kind !== 'asserted' && SETTLING_KINDS.has(e.kind as LedgerEvidenceKind))) {
    throw new OrbitError('SCHEMA_INVALID', `an assumption cannot start ${requested} without check, experiment, inspection or decision evidence`);
  }
  // A costly or irreversible claim nobody can test is a decision, not an assumption to run with.
  const untestable = input.reversibility !== 'reversible' && !input.experiment?.trim() && requested === 'unverified';
  return insertLedgerEntry(db, { ...input, status: untestable ? 'needs-decision' : requested, evidence }, clock);
}

function stamp(db: OrbitDb, runId: string, e: EvidenceInput, clock: Clock, supporting: boolean): LedgerEvidence {
  if (!LEDGER_EVIDENCE_KINDS.includes(e.kind)) throw new OrbitError('SCHEMA_INVALID', `unknown evidence kind ${String(e.kind)}`);
  if (typeof e.ref !== 'string' || !e.ref.trim()) throw new OrbitError('SCHEMA_INVALID', 'evidence needs a reference a person can look up');
  const ref = e.ref.trim();
  // Checks, experiments and decisions live in tables, so a fabricated reference can be told from a real one.
  if (e.kind === 'check') {
    const row = db.get<{ status: string; flaky: number }>('SELECT status, flaky FROM check_runs WHERE id = ? AND run_id = ?', ref, runId);
    if (!row) throw new OrbitError('NOT_FOUND', `evidence names check run ${ref}, which this run does not have`, { ref });
    // A failed check can show a claim false but never true, and a pass that needed a rerun is disclosed instability, not support.
    if (supporting && (row.status !== 'PASSED' || row.flaky === 1)) {
      throw new OrbitError('SCHEMA_INVALID', `check run ${ref} ${row.status === 'PASSED' ? 'passed only after a rerun' : `ended ${row.status}`}; it cannot support a claim`, { ref });
    }
  }
  if (e.kind === 'experiment' && !experimentExists(db, runId, ref)) {
    throw new OrbitError('NOT_FOUND', `evidence names experiment ${ref}, which this run did not run (expected a hypothesis, check run or worker id)`, { ref });
  }
  if (e.kind === 'decision') {
    const d = getDecision(db, ref);
    if (!d || d.runId !== runId) throw new OrbitError('NOT_FOUND', `evidence names decision ${ref}, which this run does not have`, { ref });
  }
  return { kind: e.kind, ref, ...(e.note === undefined ? {} : { note: e.note }), at: clock.now() };
}

/** What counts as "an experiment this run ran": a hypothesis under test, a check run, or an inquisitor worker. */
function experimentExists(db: OrbitDb, runId: string, ref: string): boolean {
  for (const table of ['hypotheses', 'check_runs', 'workers']) {
    if (db.get(`SELECT 1 AS x FROM ${table} WHERE id = ? AND run_id = ?`, ref, runId)) return true;
  }
  return false;
}

/**
 * Move an assumption to a new status on evidence. Same-status calls return the
 * entry unchanged so a retry after a crash does nothing twice.
 */
export function transitionAssumption(db: OrbitDb, id: string, to: LedgerStatus, evidence: readonly EvidenceInput[], clock: Clock, actor = 'controller'): LedgerRecord {
  return db.tx(() => {
    const cur = getLedgerEntry(db, id);
    if (cur.status === to) return cur;
    if (!ALLOWED[cur.status].includes(to)) {
      throw new OrbitError('TRANSITION_INVALID', `assumption ${id} cannot go from ${cur.status} to ${to}`, { ledgerId: id, from: cur.status, to });
    }
    if (evidence.length === 0) throw new OrbitError('SCHEMA_INVALID', `assumption ${id}: a status change needs evidence`, { ledgerId: id });
    const stamped = evidence.map((e) => stamp(db, cur.runId, e, clock, to === 'supported'));
    const settles = stamped.some((e) => SETTLING_KINDS.has(e.kind as LedgerEvidenceKind));
    if ((to === 'supported' || to === 'rejected') && !settles) {
      throw new OrbitError('SCHEMA_INVALID', `assumption ${id} cannot become ${to} on a review alone; run a check or experiment`, { ledgerId: id });
    }
    if (cur.status === 'needs-decision') {
      // Only a person can settle a decision: the evidence must be an answered-question decision.
      const human = stamped.find((e) => {
        if (e.kind !== 'decision') return false;
        const d = getDecision(db, e.ref);
        // The row's own claim of who answered is checked too: the kind alone is only a label.
        const by = (d?.data as { answered_by?: unknown } | null)?.answered_by;
        return d?.kind === 'inquisition.answer' && typeof by === 'string' && isHumanActor(by);
      });
      if (!human) throw new OrbitError('POLICY_DENIED', `assumption ${id} needs a human decision (an answered question) to leave needs-decision`, { ledgerId: id });
    }
    return writeLedgerStatus(db, id, cur.status, to, stamped, clock, actor);
  });
}

/** Map a worker's ledger onto new entries. Statuses the worker cannot earn are recorded as claims, not conclusions. */
export function entriesFromWorker(runId: string, output: Pick<InquisitorOutput, 'ledger'>, now: number): NewLedgerEntry[] {
  return output.ledger.map((l) => ({
    runId,
    claim: l.claim,
    source: l.source,
    confidence: l.confidence,
    consequence: l.consequence_if_wrong,
    reversibility: l.reversibility,
    experiment: l.validation_experiment,
    status: l.status === 'needs-decision' || (l.reversibility !== 'reversible' && !l.validation_experiment?.trim()) ? 'needs-decision' : 'unverified',
    evidence:
      l.status === 'supported' || l.status === 'rejected'
        ? [{ kind: 'asserted', ref: 'inquisitor-output', note: `the worker asserted "${l.status}" without evidence; kept unverified`, at: now }]
        : [],
  }));
}

/** Assumptions that stop the work they touch until a person decides. */
export function blockingAssumptions(db: OrbitDb, runId: string): LedgerRecord[] {
  return listLedger(db, runId, { status: 'needs-decision' });
}

export function unverifiedAssumptions(db: OrbitDb, runId: string): LedgerRecord[] {
  return listLedger(db, runId, { status: 'unverified' });
}

export function ledgerCounts(db: OrbitDb, runId: string): Record<LedgerStatus, number> {
  const counts: Record<LedgerStatus, number> = { unverified: 0, supported: 0, rejected: 0, 'needs-decision': 0 };
  for (const e of listLedger(db, runId)) counts[e.status]++;
  return counts;
}
