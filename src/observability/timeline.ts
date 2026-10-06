/**
 * The readable history of one run (`orbit timeline`): one entry per significant step, in the order it happened,
 * built only from durable state. The events table is the spine, because its row order is the order things were
 * written whatever the clock did; every event that names a record (a worker, a check, a review, a question, a
 * decision, an evidence report) is rendered with that record's details. Records that leave no event of their own
 * (usage, a decision written by another tool) are merged in by time.
 *
 * Nothing here writes. An event type this module has no wording for is still shown, as its type and its data,
 * so a step is never hidden because the controller learned a new one.
 */
import type { OrbitDb } from '../storage/db.ts';
import type { RunRecord } from '../controller/run-store.ts';

export type TimelineCategory =
  | 'state'
  | 'route'
  | 'attempt'
  | 'worker'
  | 'candidate'
  | 'check'
  | 'verdict'
  | 'review'
  | 'question'
  | 'delivery'
  | 'policy'
  | 'cost'
  | 'budget'
  | 'recovery'
  | 'error'
  | 'decision'
  | 'event';

export interface TimelineEntry {
  /** Stable across rebuilds, so a follower can print only what it has not printed. */
  key: string;
  /** Epoch milliseconds. */
  at: number;
  /** `at` as ISO 8601 UTC. */
  time: string;
  category: TimelineCategory;
  /** The event type, or the decision kind, or "usage"; a routing escalation is "route.escalation". */
  kind: string;
  /** One line a person can read. */
  text: string;
  /** The events row this entry came from, when it came from one. */
  event_id: number | null;
  /** The structured facts behind the line. */
  data: Record<string, unknown>;
}

export interface TimelineCost {
  /** Spend the providers reported. */
  measured_usd: number;
  /** Spend priced from tokens and list pricing. */
  estimated_usd: number;
  /** What the budget ledger has charged against the cost cap, ceilings included; null before the run has a ledger. */
  charged_usd: number | null;
  reported_records: number;
  estimated_records: number;
  /** Sessions that reported no cost and could not be priced. */
  unavailable_records: number;
  /** Charged to the cap at per-role ceilings for those sessions. */
  ceiling_charged_usd: number;
  note: string;
}

export interface Timeline {
  run: {
    id: string;
    goal: string;
    mode: string;
    state: string;
    paused: boolean;
    cancel_requested: boolean;
    outcome_reason: string | null;
    branch: string | null;
    created_at: number;
    started_at: number | null;
    ended_at: number | null;
  };
  entries: TimelineEntry[];
  cost: TimelineCost;
}

export interface TimelineOptions {
  /** Include housekeeping events (heartbeat progress, lease bookkeeping, planned checks and workers). */
  all?: boolean;
}

type Rec = Record<string, unknown>;

interface EventRow {
  id: number;
  ts: number;
  type: string;
  from_state: string | null;
  to_state: string | null;
  actor: string;
  data_json: string | null;
}

/** Events that say only that bookkeeping happened; the step they belong to has its own line. */
const HOUSEKEEPING: ReadonlySet<string> = new Set(['progress', 'lease.acquired', 'lease.released', 'check.planned', 'check.started', 'worker.planned', 'worker.start-charged']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const rec = (v: unknown): Rec => (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const short = (hash: string | null): string => (hash ? hash.slice(0, 12) : '?');

function parse(json: string | null): Rec {
  if (json === null) return {};
  try {
    return rec(JSON.parse(json));
  } catch {
    return {};
  }
}

/** $0.12, or four decimals for the fractions of a cent a cheap model costs. */
export function usd(n: number): string {
  return n > 0 && n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;

/** Everything an event may need to be explained, read once. */
interface Lookups {
  candidates: Map<string, { seq: number; attempt: number; tree: string }>;
  checks: Map<string, { check_id: string; status: string; exit_code: number | null; candidate_id: string | null; started_at: number; ended_at: number | null; flaky: boolean; timed_out: boolean; fingerprint: string | null }>;
  workers: Map<string, { id: string; role: string; provider: string; model: string | null; attempt: number | null; state: string; spawned_at: number | null; ended_at: number | null; exit_code: number | null; signal: string | null; result_status: string | null; error: string | null }>;
  questions: Map<string, { id: string; question: string; material: boolean; affected: string[]; answer: string | null; answered_by: string | null }>;
  reviews: Map<string, { id: string; candidate_id: string; round: number; provider: string; model: string | null; verdict: string; counts: Record<string, number> }>;
  decisions: Map<string, { id: string; kind: string; summary: string; data: Rec; created_at: number }>;
  evidence: Map<string, { report: Rec }>;
}

function loadLookups(db: OrbitDb, runId: string): Lookups {
  const l: Lookups = { candidates: new Map(), checks: new Map(), workers: new Map(), questions: new Map(), reviews: new Map(), decisions: new Map(), evidence: new Map() };
  for (const r of db.all<{ id: string; seq: number; attempt: number; tree_hash: string }>('SELECT id, seq, attempt, tree_hash FROM candidates WHERE run_id = ?', runId)) l.candidates.set(r.id, { seq: r.seq, attempt: r.attempt, tree: r.tree_hash });
  for (const r of db.all<{ id: string; check_id: string; status: string; exit_code: number | null; candidate_id: string | null; started_at: number; ended_at: number | null; flaky: number; timed_out: number; fingerprint: string | null }>(
    'SELECT id, check_id, status, exit_code, candidate_id, started_at, ended_at, flaky, timed_out, fingerprint FROM check_runs WHERE run_id = ?',
    runId,
  ))
    l.checks.set(r.id, { check_id: r.check_id, status: r.status, exit_code: r.exit_code, candidate_id: r.candidate_id, started_at: r.started_at, ended_at: r.ended_at, flaky: r.flaky === 1, timed_out: r.timed_out === 1, fingerprint: r.fingerprint });
  for (const r of db.all<{ id: string; role: string; provider: string; model: string | null; attempt: number | null; state: string; spawned_at: number | null; ended_at: number | null; exit_code: number | null; signal: string | null; result_status: string | null; error: string | null }>(
    'SELECT id, role, provider, model, attempt, state, spawned_at, ended_at, exit_code, signal, result_status, error FROM workers WHERE run_id = ?',
    runId,
  ))
    l.workers.set(r.id, r);
  for (const r of db.all<{ id: string; question: string; material: number; affected_json: string | null; answer: string | null; answered_by: string | null }>('SELECT id, question, material, affected_json, answer, answered_by FROM questions WHERE run_id = ?', runId))
    l.questions.set(r.id, { id: r.id, question: r.question, material: r.material === 1, affected: list(parse(r.affected_json).affected), answer: r.answer, answered_by: r.answered_by });
  const findings = db.all<{ review_id: string; severity: string; n: number }>('SELECT review_id, severity, COUNT(*) AS n FROM findings WHERE run_id = ? GROUP BY review_id, severity', runId);
  for (const r of db.all<{ id: string; candidate_id: string; round: number; provider: string; model: string | null; verdict: string }>('SELECT id, candidate_id, round, provider, model, verdict FROM reviews WHERE run_id = ?', runId)) {
    const counts: Record<string, number> = {};
    for (const f of findings) if (f.review_id === r.id) counts[f.severity] = f.n;
    l.reviews.set(r.id, { ...r, counts });
  }
  for (const r of db.all<{ id: string; kind: string; summary: string; data_json: string | null; created_at: number }>('SELECT id, kind, summary, data_json, created_at FROM decisions WHERE run_id = ?', runId))
    l.decisions.set(r.id, { id: r.id, kind: r.kind, summary: r.summary, data: parse(r.data_json), created_at: r.created_at });
  for (const r of db.all<{ id: string; report_json: string }>('SELECT id, report_json FROM evidence_reports WHERE run_id = ?', runId)) l.evidence.set(r.id, { report: parse(r.report_json) });
  return l;
}

const SEVERITY_ORDER = ['critical', 'high', 'medium', 'low', 'info'];

/** The wording of a routing decision: where the work went and why, with the evidence that justified it. */
function describeRoute(d: Rec): { kind: string; text: string } {
  const workKind = str(d.work_kind) ?? 'work';
  const to = `${str(d.provider) ?? '?'}/${str(d.model) ?? '?'}`;
  const effort = str(d.effort);
  const ref = (v: unknown): string => {
    const r = rec(v);
    return `${str(r.provider) ?? '?'}/${str(r.model) ?? '?'}`;
  };
  const escalated = d.escalated_from !== undefined ? ref(d.escalated_from) : null;
  const down = d.down_routed_from !== undefined ? ref(d.down_routed_from) : null;
  const just = rec(d.justification);
  const signals = (Array.isArray(just.signals) ? just.signals : []).map((s) => {
    const x = rec(s);
    return `${str(x.signal) ?? 'signal'}${str(x.detail) ? ` (${str(x.detail)})` : ''}`;
  });
  const evidence = list(just.evidence);
  const reason = str(d.reason);
  const parts: string[] = [];
  const head = escalated ? `${workKind}: escalated ${escalated} -> ${to}` : down ? `${workKind}: down-routed ${down} -> ${to}` : `${workKind} -> ${to}`;
  if (reason) parts.push(reason);
  if (evidence.length > 0) parts.push(`evidence: ${evidence.join(', ')}`);
  if (signals.length > 0) parts.push(`signals: ${signals.join(', ')}`);
  const cost = num(d.expected_cost_per_verified_task);
  if (cost !== null) parts.push(`expected ${usd(cost)} per verified task`);
  const alternatives = Array.isArray(d.alternatives_considered) ? d.alternatives_considered.length : 0;
  if (alternatives > 0) parts.push(`${plural(alternatives, 'alternative')} considered`);
  if (d.unvalidated === true) parts.push('model not yet validated on this CLI');
  return { kind: escalated ? 'route.escalation' : down ? 'route.down-route' : 'route', text: `${head}${effort ? ` (${effort})` : ''}${parts.length ? `: ${parts.join('; ')}` : ''}` };
}

function decisionCategory(kind: string): TimelineCategory {
  if (kind === 'route') return 'route';
  if (kind.startsWith('policy.')) return 'policy';
  if (kind.startsWith('delivery.') || kind.startsWith('release.')) return 'delivery';
  if (kind.startsWith('review.')) return 'review';
  return 'decision';
}

function describeDecision(d: { id: string; kind: string; summary: string; data: Rec }): { category: TimelineCategory; kind: string; text: string; data: Rec } {
  if (d.kind === 'route' && typeof d.data.model === 'string') {
    const r = describeRoute(d.data);
    return { category: 'route', kind: r.kind, text: r.text, data: { decision_id: d.id, ...d.data } };
  }
  return { category: decisionCategory(d.kind), kind: d.kind, text: `${d.kind}: ${d.summary.replace(/\s+/g, ' ').trim()}`, data: { decision_id: d.id, ...d.data } };
}

function categoryOfType(type: string): TimelineCategory {
  const p = type.split('.')[0]!;
  switch (p) {
    case 'action':
    case 'delivery':
    case 'ci':
    case 'release':
      return 'delivery';
    case 'check':
      return 'check';
    case 'worker':
    case 'authorization':
      return 'worker';
    case 'budget':
      return 'budget';
    case 'question':
      return 'question';
    case 'review':
    case 'finding':
      return 'review';
    case 'evidence':
      return 'verdict';
    case 'implementation':
      return 'attempt';
    case 'recovery':
    case 'watchdog':
    case 'credentials':
      return 'recovery';
    case 'step':
      return 'error';
    case 'run':
    case 'state':
      return 'state';
    default:
      return 'event';
  }
}

/** An event with no special wording: its type, then what it carried. */
function generic(type: string, data: Rec): string {
  const pairs = Object.entries(data)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  const flat = pairs.replace(/\s+/g, ' ').trim();
  return flat ? `${type}  ${flat.length > 240 ? `${flat.slice(0, 237)}...` : flat}` : type;
}

interface Rendered {
  category?: TimelineCategory;
  kind?: string;
  text: string;
  data?: Rec;
}

function renderEvent(e: EventRow, data: Rec, l: Lookups): Rendered | null {
  const candidateSeq = (id: unknown): string => {
    const c = typeof id === 'string' ? l.candidates.get(id) : undefined;
    return c ? String(c.seq) : '?';
  };
  switch (e.type) {
    case 'run.created':
      return { text: `run created in ${str(data.mode) ?? '?'} mode${str(data.environment) ? ` for environment ${str(data.environment)}` : ''}` };
    case 'state.transition':
      return { text: `${e.from_state ?? '?'} -> ${e.to_state ?? '?'}${str(data.reason) ? `: ${str(data.reason)!.replace(/\s+/g, ' ').trim()}` : ''}` };
    case 'run.paused':
      return { text: `run paused by ${e.actor}` };
    case 'run.unpaused':
      return { text: `run unpaused by ${e.actor}` };
    case 'run.cancel-requested':
      return { text: `cancellation requested by ${e.actor}` };
    case 'run.resumed':
      return { text: `run resumed from ${str(data.from) ?? '?'} to ${str(data.to) ?? '?'} by ${e.actor}${data.forced === true ? ' (forced past open questions)' : ''}` };
    case 'run.repair-requested':
      return { text: `repair requested by ${e.actor} from ${str(data.from) ?? '?'}${str(data.fingerprint) ? `, failure ${str(data.fingerprint)}` : ''}` };
    case 'lease.takeover':
      return { category: 'recovery', text: `${e.actor} took over the run from ${str(data.previous_owner) ?? 'a previous owner'} (its lease had expired)` };
    case 'recovery.crash-handled':
      return { text: `crash handled: ${str(data.outcome) ?? 'recovered'}${str(data.resume_state) ? `, resuming at ${str(data.resume_state)}` : ''}` };
    case 'watchdog.stall':
      return { category: 'recovery', text: `stall detected in ${str(data.state) ?? '?'}: no activity for ${duration(num(data.idle_ms) ?? 0)}` };
    case 'step.error':
      return { text: `step error in ${str(data.state) ?? '?'}${str(data.code) ? ` (${str(data.code)})` : ''}: ${str(data.message) ?? 'unknown error'}` };
    case 'budget.exhausted':
      return { text: `budget exhausted: ${str(data.counter) ?? '?'} ${num(data.used) ?? '?'} of ${num(data.allowance) ?? '?'}${str(data.limit) ? ` (${str(data.limit)})` : ''}` };
    case 'budget.cost-ceiling-charged': {
      const c = num(data.ceiling_usd);
      return { category: 'cost', text: `charged a ceiling of ${c === null ? '?' : usd(c)} for ${str(data.role) ?? 'a session'}: no cost was reported` };
    }
    case 'budget.cost-token-estimated': {
      const c = num(data.charged_usd);
      return { category: 'cost', text: `charged ${c === null ? '?' : usd(c)} for ${str(data.role) ?? 'a session'}, estimated from its tokens${str(data.model) ? ` at ${str(data.model)} list pricing` : ''}` };
    }
    case 'implementation.attempt': {
      const cap = num(data.spend_cap_usd);
      return { text: `attempt ${num(data.attempt) ?? '?'} started${str(data.route) ? ` (route ${str(data.route)}${cap !== null ? `, spend cap ${usd(cap)}` : ''})` : cap !== null ? ` (spend cap ${usd(cap)})` : ''}` };
    }
    case 'implementation.candidate':
      // The candidate.created line says it all unless the attempt ended on a tree that already existed, or on a rebase.
      if (data.reused === true) return { category: 'candidate', text: `attempt ${num(data.attempt) ?? '?'} ended on the tree of candidate ${num(data.seq) ?? '?'}, which already existed` };
      if (data.rebase === true) return { category: 'candidate', text: `candidate ${num(data.seq) ?? '?'} is the rebased tree of attempt ${num(data.attempt) ?? '?'}` };
      return null;
    case 'candidate.created':
      return { category: 'candidate', text: `candidate ${num(data.seq) ?? '?'} created for attempt ${num(data.attempt) ?? '?'} (tree ${short(str(data.tree_hash))}${str(data.worker_id) ? `, by ${str(data.worker_id)}` : ''})` };
    case 'worker.started': {
      const w = l.workers.get(str(data.worker_id) ?? '');
      return w
        ? { text: `${w.id} ${w.role} ${w.provider}/${w.model ?? 'default'} started${w.attempt !== null ? ` (attempt ${w.attempt})` : ''}`, data: { ...data, role: w.role, provider: w.provider, model: w.model, attempt: w.attempt } }
        : { text: `${str(data.worker_id) ?? 'a worker'} started` };
    }
    case 'worker.finished': {
      const id = str(data.worker_id) ?? 'a worker';
      const w = l.workers.get(id);
      const state = str(data.state) ?? w?.state ?? '?';
      const status = str(data.result_status) ?? w?.result_status ?? null;
      const exit = num(data.exit_code) ?? w?.exit_code ?? null;
      const signal = str(data.signal) ?? w?.signal ?? null;
      const detail = [status && status !== 'succeeded' ? status : null, signal ? `signal ${signal}` : null, exit !== null ? `exit ${exit}` : null].filter(Boolean).join(', ');
      const took = w && w.spawned_at !== null && w.ended_at !== null ? ` after ${duration(w.ended_at - w.spawned_at)}` : '';
      return { text: `${id} ${state}${took}${detail ? ` (${detail})` : ''}${w?.error ? `: ${w.error.replace(/\s+/g, ' ').trim()}` : ''}`, data: { ...data, ...(w ? { role: w.role, provider: w.provider, model: w.model } : {}) } };
    }
    case 'worker.cancel-requested':
      return { text: `${str(data.worker_id) ?? 'a worker'} cancellation requested${str(data.reason) ? `: ${str(data.reason)}` : ''}` };
    case 'worker.restart-planned':
      return { text: `${str(data.worker_id) ?? 'a worker'} restart planned (restart ${num(data.restart_count) ?? '?'})` };
    case 'check.finished': {
      const c = l.checks.get(str(data.check_run_id) ?? '');
      const status = str(data.status) ?? c?.status ?? '?';
      const exit = num(data.exit_code) ?? c?.exit_code ?? null;
      const took = c && c.ended_at !== null ? ` in ${duration(c.ended_at - c.started_at)}` : '';
      const cand = c?.candidate_id ? ` on candidate ${candidateSeq(c.candidate_id)}` : '';
      const fp = str(data.fingerprint) ?? c?.fingerprint ?? null;
      return { text: `${str(data.check_id) ?? c?.check_id ?? 'check'} ${status}${exit !== null ? ` (exit ${exit})` : ''}${cand}${took}${c?.flaky ? ' (flaky)' : ''}${fp && status !== 'PASSED' ? `; fingerprint ${fp}` : ''}` };
    }
    case 'evidence.report': {
      const verdict = str(data.verdict) ?? '?';
      const report = l.evidence.get(str(data.report_id) ?? '')?.report ?? {};
      const failing = (Array.isArray(report.checks) ? report.checks : []).map(rec).filter((c) => c.status !== 'PASSED').map((c) => str(c.id) ?? '?');
      const unverified = num(data.unverified) ?? 0;
      const more = [failing.length > 0 ? `failing checks: ${failing.join(', ')}` : null, unverified > 0 ? `${unverified} unverified` : null].filter(Boolean).join('; ');
      return { category: 'verdict', text: `candidate ${candidateSeq(data.candidate_id)} ${verdict}${more ? `: ${more}` : ''}` };
    }
    case 'evidence.invalidated':
      return { category: 'verdict', text: `evidence invalidated: ${str(data.reason) ?? 'the candidate changed'}` };
    case 'review.recorded': {
      const r = l.reviews.get(str(data.review_id) ?? '');
      const provider = r?.provider ?? str(data.provider) ?? '?';
      const model = r ? r.model : str(data.model);
      const verdict = r?.verdict ?? str(data.verdict) ?? '?';
      const counts = r?.counts ?? {};
      const total = Object.values(counts).reduce((a, b) => a + b, 0) || (num(data.findings) ?? 0);
      const bySeverity = SEVERITY_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(', ');
      const extra = r ? { verdict, provider, model, round: r.round, candidate_seq: Number(candidateSeq(r.candidate_id)) || null, finding_counts: counts } : {};
      return { category: 'review', text: `round ${r?.round ?? num(data.round) ?? '?'} ${verdict} by ${provider}/${model ?? 'default'} on candidate ${r ? candidateSeq(r.candidate_id) : '?'} (${plural(total, 'finding')}${bySeverity ? `: ${bySeverity}` : ''})`, data: { ...data, ...extra } };
    }
    case 'review.invalidated':
      return { category: 'review', text: `review ${str(data.review_id) ?? '?'} no longer counts: ${str(data.reason) ?? 'the candidate changed'}` };
    case 'finding.status':
      return { category: 'review', text: `finding ${str(data.finding_id) ?? '?'} ${str(data.from) ?? '?'} -> ${str(data.to) ?? '?'}${str(data.reason) ? `: ${str(data.reason)}` : ''}` };
    case 'question.created': {
      const q = l.questions.get(str(data.question_id) ?? '');
      const id = str(data.question_id) ?? '?';
      const material = q ? q.material : data.material === true;
      const affected = q ? q.affected : list(data.affected);
      return { category: 'question', text: `${id} asked${material ? ' [material]' : ''}: ${(q?.question ?? 'a question').replace(/\s+/g, ' ').trim()}${affected.length ? ` (affects ${affected.join(', ')})` : ''}`, data: { ...data, ...(q ? { question: q.question } : {}) } };
    }
    case 'question.answered': {
      const q = l.questions.get(str(data.question_id) ?? '');
      return { category: 'question', text: `${str(data.question_id) ?? '?'} answered by ${q?.answered_by ?? e.actor}: ${(q?.answer ?? '').replace(/\s+/g, ' ').trim()}`, data: { ...data, ...(q ? { answer: q.answer, answered_by: q.answered_by } : {}) } };
    }
    case 'question.withdrawn':
      return { category: 'question', text: `${str(data.question_id) ?? '?'} withdrawn${str(data.reason) ? `: ${str(data.reason)}` : ''}` };
    case 'action.intent':
      return { category: 'delivery', text: `${str(data.kind) ?? 'action'}: intent recorded${str(data.commit_sha) ? ` for ${short(str(data.commit_sha))}` : ''}` };
    case 'action.executing':
      return { category: 'delivery', text: `${str(data.kind) ?? 'action'}: executing (attempt ${num(data.attempt) ?? '?'})` };
    case 'action.succeeded': {
      const attempts = num(data.attempts) ?? 1;
      return { category: 'delivery', text: `${str(data.kind) ?? 'action'}: succeeded${attempts > 1 ? ` after ${attempts} attempts` : ''}${str(data.via) && data.via !== 'execute' ? ` (${str(data.via)})` : ''}` };
    }
    case 'action.denied':
      return { category: 'delivery', text: `${str(data.kind) ?? 'action'}: denied${str(data.rule) ? ` by ${str(data.rule)}` : ''}${str(data.reason) ? `: ${str(data.reason)}` : ''}` };
    case 'action.reconciled':
      return { category: 'delivery', text: `${str(data.kind) ?? 'action'}: reconciled with the remote (${data.found === true ? 'the effect was there' : 'no effect found'})` };
    default:
      if (e.type.startsWith('action.')) return { category: 'delivery', text: `${str(data.kind) ?? 'action'}: ${e.type.slice('action.'.length)}${num(data.attempts) !== null ? ` (attempt ${num(data.attempts)})` : ''}${str(data.error) ? `: ${str(data.error)}` : ''}` };
      return { text: generic(e.type, data) };
  }
}

function costOf(db: OrbitDb, runId: string): { cost: TimelineCost; usage: { id: number; ts: number; worker_id: string | null; provider: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; cost_source: string }[] } {
  const usage = db.all<{ id: number; ts: number; worker_id: string | null; provider: string; model: string | null; input_tokens: number | null; output_tokens: number | null; cost_usd: number | null; cost_source: string }>(
    'SELECT id, ts, worker_id, provider, model, input_tokens, output_tokens, cost_usd, cost_source FROM usage WHERE run_id = ? ORDER BY id',
    runId,
  );
  let measured = 0;
  let estimated = 0;
  let reported = 0;
  let estimatedRecords = 0;
  let unavailable = 0;
  for (const u of usage) {
    if (u.cost_usd === null) unavailable++;
    else if (u.cost_source === 'estimated') {
      estimated += u.cost_usd;
      estimatedRecords++;
    } else {
      measured += u.cost_usd;
      reported++;
    }
  }
  // A session charged from its tokens (no cost in its usage row) is an estimate, not unmeasured.
  let tokenEstimates = 0;
  let ceiling = 0;
  let ceilingCharges = 0;
  for (const e of db.all<{ type: string; data_json: string | null }>("SELECT type, data_json FROM events WHERE run_id = ? AND type IN ('budget.cost-token-estimated', 'budget.cost-ceiling-charged')", runId)) {
    const d = parse(e.data_json);
    if (e.type === 'budget.cost-token-estimated') {
      tokenEstimates++;
      estimated += num(d.charged_usd) ?? 0;
    } else {
      ceiling += num(d.ceiling_usd) ?? 0;
      ceilingCharges++;
    }
  }
  const moved = Math.min(tokenEstimates, unavailable);
  unavailable -= moved;
  estimatedRecords += moved;
  const row = db.get<{ used: number }>("SELECT used FROM budget_counters WHERE run_id = ? AND counter = 'cost_usd'", runId);
  const cost: TimelineCost = {
    measured_usd: round6(measured),
    estimated_usd: round6(estimated),
    charged_usd: row ? round6(row.used) : null,
    reported_records: reported,
    estimated_records: estimatedRecords,
    unavailable_records: unavailable,
    ceiling_charged_usd: round6(ceiling),
    note: '',
  };
  cost.note = costNote(cost, ceilingCharges);
  return { cost, usage };
}

function costNote(c: TimelineCost, ceilingCharges: number): string {
  if (c.reported_records + c.estimated_records + c.unavailable_records === 0 && c.charged_usd === null && ceilingCharges === 0) return 'no usage recorded yet';
  const records = [c.reported_records > 0 ? `${c.reported_records} reported` : null, c.estimated_records > 0 ? `${c.estimated_records} estimated from tokens` : null].filter(Boolean).join(', ');
  const parts = [`measured ${usd(c.measured_usd)}${records ? ` (${records})` : ''}`];
  if (c.estimated_usd > 0) parts.push(`estimated ${usd(c.estimated_usd)}`);
  parts.push(c.charged_usd === null ? 'nothing charged to the cost budget yet' : `charged ${usd(c.charged_usd)} to the cost budget`);
  if (c.unavailable_records > 0) {
    parts.push(c.ceiling_charged_usd > 0 ? `${usd(c.ceiling_charged_usd)} of that stands in for ${plural(c.unavailable_records, 'session')} with no reported cost` : `${plural(c.unavailable_records, 'session')} with no reported cost`);
  }
  return parts.join('; ');
}

function asEntry(at: number, key: string, category: TimelineCategory, kind: string, text: string, eventId: number | null, data: Rec): TimelineEntry {
  return { key, at, time: new Date(at).toISOString(), category, kind, text, event_id: eventId, data };
}

export function buildTimeline(db: OrbitDb, run: RunRecord, opts: TimelineOptions = {}): Timeline {
  const l = loadLookups(db, run.id);
  const { cost, usage } = costOf(db, run.id);
  const spine: TimelineEntry[] = [];
  const mirrored = new Set<string>();

  for (const e of db.all<EventRow>('SELECT id, ts, type, from_state, to_state, actor, data_json FROM events WHERE run_id = ? ORDER BY id', run.id)) {
    const data = parse(e.data_json);
    if (e.type === 'decision.recorded') {
      const id = str(data.decision_id);
      const d = id ? l.decisions.get(id) : undefined;
      if (!d) continue;
      mirrored.add(d.id);
      const r = describeDecision(d);
      spine.push(asEntry(e.ts, `event:${e.id}`, r.category, r.kind, r.text, e.id, r.data));
      continue;
    }
    if (HOUSEKEEPING.has(e.type) && !opts.all) continue;
    const r = renderEvent(e, data, l);
    if (r === null) {
      if (!opts.all) continue;
      spine.push(asEntry(e.ts, `event:${e.id}`, categoryOfType(e.type), e.type, generic(e.type, data), e.id, data));
      continue;
    }
    spine.push(asEntry(e.ts, `event:${e.id}`, r.category ?? categoryOfType(e.type), r.kind ?? e.type, r.text, e.id, r.data ?? data));
  }

  const extras: TimelineEntry[] = [];
  // A decision written without its event (another tool, an older version) is still part of the history.
  for (const d of l.decisions.values()) {
    if (mirrored.has(d.id)) continue;
    const r = describeDecision(d);
    extras.push(asEntry(d.created_at, `decision:${d.id}`, r.category, r.kind, r.text, null, r.data));
  }
  let running = 0;
  for (const u of usage) {
    const who = `${u.worker_id ?? 'a session'} ${u.provider}/${u.model ?? 'default'}`;
    const tokens = u.input_tokens !== null || u.output_tokens !== null ? ` (${u.input_tokens ?? '?'} in, ${u.output_tokens ?? '?'} out tokens)` : '';
    let text: string;
    if (u.cost_usd === null) text = `${who}: no cost reported${tokens}`;
    else {
      if (u.cost_source !== 'estimated') running += u.cost_usd;
      text = `${who} ${usd(u.cost_usd)} ${u.cost_source === 'estimated' ? 'estimated' : 'reported'}${tokens}; measured so far ${usd(round6(running))}`;
    }
    extras.push(asEntry(u.ts, `usage:${u.id}`, 'cost', 'usage', text, null, { worker_id: u.worker_id, provider: u.provider, model: u.model, input_tokens: u.input_tokens, output_tokens: u.output_tokens, cost_usd: u.cost_usd, cost_source: u.cost_source }));
  }
  extras.sort((a, b) => a.at - b.at);

  // Events keep the order they were written in. A record without an event goes before the first event that is
  // later than it, so a clock that stepped back never reorders the log.
  const entries: TimelineEntry[] = [];
  let x = 0;
  for (const s of spine) {
    while (x < extras.length && extras[x]!.at < s.at) entries.push(extras[x++]!);
    entries.push(s);
  }
  while (x < extras.length) entries.push(extras[x++]!);

  return {
    run: {
      id: run.id,
      goal: run.goal,
      mode: run.mode,
      state: run.state,
      paused: run.paused,
      cancel_requested: run.cancelRequested,
      outcome_reason: run.outcomeReason,
      branch: run.branch,
      created_at: run.createdAt,
      started_at: run.startedAt,
      ended_at: run.endedAt,
    },
    entries,
    cost,
  };
}
