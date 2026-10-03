import { isAbsolute, relative, sep } from 'node:path';
import type { OrbitDb } from '../storage/db.ts';
import { canonicalJson, sha256 } from '../core/hash.ts';
import type { ScopeReport } from '../evidence/types.ts';
import type { EvidenceRef, LessonKind } from './types.ts';
import { asSha256, cleanUntrusted, truncate } from './text.ts';

/**
 * Deterministic extraction of raw observations from a finished run.
 *
 * Only verified facts recorded by the controller are read, and only through
 * SQL against the run-state schema: check results bound to candidate trees,
 * review findings and their resolution, CI failure fingerprints, decisions
 * that cite evidence, and scope reports. Nothing a worker merely claimed is an
 * observation. Text fields are redacted and bounded here, before they can
 * reach the curator's prompt.
 *
 * Artifacts that are database rows rather than files are referenced as
 * `<table>:<id>` and hashed as the sha256 of the row's canonical JSON, so a
 * reader can re-derive the hash from state.sqlite.
 */

export type ObservationSource = 'failure-repair' | 'review-finding' | 'ci-failure' | 'decision' | 'scope-denial';

export interface Observation {
  /** Stable across re-extraction: derived from run, source and the observed key. */
  id: string;
  run_id: string;
  source: ObservationSource;
  /** The lesson kind this observation most naturally supports. */
  kind: LessonKind;
  /** Redacted, single-line, bounded summary. */
  summary: string;
  /** Redacted structured facts for the curator. */
  detail: Record<string, unknown>;
  fingerprints: string[];
  check_ids: string[];
  /** Repository paths involved (repo-scope applicability only). */
  paths: string[];
  evidence: EvidenceRef[];
}

/** Finding statuses that mean the finding was confirmed and then addressed. */
export const RESOLVED_FINDING_STATUSES: readonly string[] = ['resolved', 'fixed'];
/** failures.source value for CI breakages observed after delivery. */
export const CI_FAILURE_SOURCE = 'ci';
/**
 * Decision kinds that record a policy denial (storage/decisions.ts lists
 * 'policy.deny'). A denial is a hazard, not a convention, and needs no
 * further evidence: the controller's own refusal is the evidence.
 */
export const DENIAL_DECISION_KINDS: readonly string[] = ['policy.deny'];

function isDenial(kind: string): boolean {
  return DENIAL_DECISION_KINDS.some((k) => kind === k || kind.startsWith(`${k}.`));
}

const SOURCE_ORDER: ObservationSource[] = ['failure-repair', 'review-finding', 'ci-failure', 'decision', 'scope-denial'];
const TEXT_MAX = 500;
const PATHS_MAX = 20;

interface CandidateRow {
  id: string;
  seq: number;
  attempt: number;
  commit_sha: string;
  tree_hash: string;
  status: string;
  diff_stat_json: string | null;
  scope_json: string | null;
}

interface CheckRunRow {
  id: string;
  candidate_id: string | null;
  check_id: string;
  status: string;
  flaky: number;
  fingerprint: string | null;
  log_path: string | null;
  log_sha256: string | null;
  excerpt: string | null;
}

/**
 * Check statuses (evidence/types.ts CheckStatus) that mean the code under test
 * failed. ERROR and CANCELLED say the check could not give a verdict
 * (infrastructure, cancellation), so a fingerprint from one is not a failure
 * the next candidate can have repaired.
 */
const FAILING_CHECK_STATUSES: readonly string[] = ['FAILED', 'TIMEOUT'];

/** A clean pass: PASSED without needing a rerun. A flaky pass is disclosed instability, never a clean pass (spec section 14). */
function cleanPass(c: CheckRunRow): boolean {
  return c.status === 'PASSED' && Number(c.flaky) === 0;
}

interface FailureRow {
  id: number;
  candidate_id: string | null;
  source: string;
  source_id: string | null;
  fingerprint: string;
  excerpt: string | null;
  created_at: number;
}

interface FindingRow {
  id: string;
  review_id: string;
  severity: string;
  category: string | null;
  location: string | null;
  claim: string;
  evidence: string | null;
  suggested_validation: string | null;
  status: string;
  resolution: string | null;
  packet_sha256: string | null;
}

interface DecisionRow {
  id: string;
  kind: string;
  summary: string;
  data_json: string | null;
  created_at: number;
}

function observationId(runId: string, source: ObservationSource, key: string): string {
  return `obs-${sha256(`${runId}\u0000${source}\u0000${key}`).slice(0, 12)}`;
}

function rowRef(runId: string, table: string, row: object): EvidenceRef {
  const id = (row as { id: string | number }).id;
  return { run_id: runId, artifact: `${table}:${id}`, sha256: sha256(canonicalJson(row)), relation: 'supports' };
}

/** Artifact paths are recorded relative to the run directory; anything elsewhere is referenced by row id. */
function logRef(runId: string, runDir: string, check: CheckRunRow): EvidenceRef {
  const sha = asSha256(check.log_sha256);
  if (check.log_path) {
    if (!isAbsolute(check.log_path)) return { run_id: runId, artifact: check.log_path, sha256: sha, relation: 'supports' };
    const rel = relative(runDir, check.log_path);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return { run_id: runId, artifact: rel.split(sep).join('/'), sha256: sha, relation: 'supports' };
  }
  return { run_id: runId, artifact: `check_run:${check.id}`, sha256: sha, relation: 'supports' };
}

function parseJson(text: string | null): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Paths named by a diff stat, whatever its exact layout ({files:[{path}]}, {files:[string]}, {paths:[...]}). */
function diffStatPaths(stat: unknown): string[] {
  if (!stat || typeof stat !== 'object') return [];
  const s = stat as Record<string, unknown>;
  const list = Array.isArray(s.files) ? s.files : Array.isArray(s.paths) ? s.paths : [];
  const out: string[] = [];
  for (const f of list) {
    if (typeof f === 'string') out.push(f);
    else if (f && typeof f === 'object' && typeof (f as { path?: unknown }).path === 'string') out.push((f as { path: string }).path);
  }
  return out.slice(0, PATHS_MAX);
}

/** A bounded, redacted copy of a diff stat: totals always, the file list only while it stays small. */
function boundedDiffStat(stat: unknown): unknown {
  if (!stat || typeof stat !== 'object') return null;
  if (canonicalJson(stat).length <= 2000) return redactDeep(stat);
  const s = stat as Record<string, unknown>;
  const totals: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(s)) if (typeof v === 'number') totals[k] = v;
  return { ...totals, files_listed: diffStatPaths(stat).length, truncated: true };
}

/** Redact every string leaf; structure and numbers are kept as they are. */
function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return cleanUntrusted(value, 300);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanUntrusted(k, 100), redactDeep(v)]));
  return value;
}

function locationPath(location: string | null): string[] {
  if (!location) return [];
  const path = location.trim().replace(/(?::\d+){1,2}$/, '');
  return path && !/\s/.test(path) ? [path] : [];
}

function evidenceText(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const ev = (data as Record<string, unknown>).evidence;
  if (typeof ev === 'string') return ev.trim() ? ev : null;
  if (Array.isArray(ev) && ev.length > 0) return ev.map((e) => (typeof e === 'string' ? e : canonicalJson(e))).join('; ');
  return null;
}

/**
 * Turn one run's verified record into observations. Deterministic: the same
 * database yields the same observations in the same order with the same ids.
 */
export function extractObservations(runDb: OrbitDb, runId: string, runDir: string): Observation[] {
  const out: Observation[] = [
    ...repairObservations(runDb, runId, runDir),
    ...findingObservations(runDb, runId),
    ...ciObservations(runDb, runId),
    ...decisionObservations(runDb, runId),
    ...scopeObservations(runDb, runId),
  ];
  return out.sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source) || a.id.localeCompare(b.id));
}

/**
 * A failure fingerprint present at candidate k and absent at candidate k+1,
 * where every check that produced it at k ran again at k+1 and passed
 * cleanly, is a repair: the change from k to k+1 cleared it. The first such
 * transition after the fingerprint first appeared is reported, with the diff
 * stat of k+1.
 *
 * Absence alone is not enough: a check that did not run proves nothing, so a
 * fingerprint must be tied to at least one check (directly, or through a
 * failure row whose source_id names a check run of this run). A pass that
 * needed a rerun proves nothing either, and a fingerprint whose check also
 * passed at k was instability rather than a failure the change fixed.
 */
function repairObservations(db: OrbitDb, runId: string, runDir: string): Observation[] {
  const candidates = db.all<CandidateRow>(
    'SELECT id, seq, attempt, commit_sha, tree_hash, status, diff_stat_json, scope_json FROM candidates WHERE run_id = ? ORDER BY seq',
    runId,
  );
  if (candidates.length < 2) return [];
  const checks = db.all<CheckRunRow>(
    'SELECT id, candidate_id, check_id, status, flaky, fingerprint, log_path, log_sha256, excerpt FROM check_runs WHERE run_id = ? AND candidate_id IS NOT NULL ORDER BY started_at, id',
    runId,
  );
  const failures = db.all<FailureRow>(
    'SELECT id, candidate_id, source, source_id, fingerprint, excerpt, created_at FROM failures WHERE run_id = ? AND candidate_id IS NOT NULL AND source <> ? ORDER BY id',
    runId,
    CI_FAILURE_SOURCE,
  );
  const checkById = new Map(checks.map((c) => [c.id, c]));

  interface Seen {
    checkRuns: CheckRunRow[];
    failureRows: FailureRow[];
  }
  const perCandidate = new Map<string, Map<string, Seen>>();
  const checksByCandidate = new Map<string, CheckRunRow[]>();
  for (const c of candidates) {
    perCandidate.set(c.id, new Map());
    checksByCandidate.set(c.id, []);
  }
  const seenAt = (candidateId: string, fp: string): Seen | undefined => {
    const m = perCandidate.get(candidateId);
    if (!m) return undefined;
    let s = m.get(fp);
    if (!s) {
      s = { checkRuns: [], failureRows: [] };
      m.set(fp, s);
    }
    return s;
  };
  const addCheckRun = (seen: Seen | undefined, cr: CheckRunRow) => {
    if (seen && !seen.checkRuns.includes(cr)) seen.checkRuns.push(cr);
  };
  for (const cr of checks) {
    if (!cr.candidate_id) continue;
    checksByCandidate.get(cr.candidate_id)?.push(cr);
    if (FAILING_CHECK_STATUSES.includes(cr.status) && cr.fingerprint) addCheckRun(seenAt(cr.candidate_id, cr.fingerprint), cr);
  }
  for (const f of failures) {
    if (!f.candidate_id) continue;
    const seen = seenAt(f.candidate_id, f.fingerprint);
    seen?.failureRows.push(f);
    // A failure row that names the check run it came from ties the fingerprint to that check.
    const source = f.source_id ? checkById.get(f.source_id) : undefined;
    if (source && source.candidate_id === f.candidate_id && FAILING_CHECK_STATUSES.includes(source.status)) addCheckRun(seen, source);
  }

  const out: Observation[] = [];
  const reported = new Set<string>();
  for (let i = 0; i + 1 < candidates.length; i++) {
    const cur = candidates[i]!;
    const next = candidates[i + 1]!;
    if (next.seq !== cur.seq + 1) continue;
    const curChecks = checksByCandidate.get(cur.id) ?? [];
    const nextChecks = checksByCandidate.get(next.id) ?? [];
    if (nextChecks.length === 0) continue;
    const nextFailing = perCandidate.get(next.id)!;
    for (const [fp, seen] of [...perCandidate.get(cur.id)!.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (reported.has(fp) || nextFailing.has(fp)) continue;
      const checkIds = [...new Set(seen.checkRuns.map((c) => c.check_id))].sort();
      if (checkIds.length === 0) continue;
      if (checkIds.some((id) => curChecks.some((c) => c.check_id === id && c.status === 'PASSED'))) continue;
      const passedAgain = checkIds.map((id) => nextChecks.find((c) => c.check_id === id && cleanPass(c)));
      if (passedAgain.some((c) => c === undefined)) continue;
      // A check that also failed again at k+1 (with another fingerprint) did not pass.
      if (checkIds.some((id) => nextChecks.some((c) => c.check_id === id && !cleanPass(c)))) continue;
      reported.add(fp);
      const firstSeen = candidates.find((c) => perCandidate.get(c.id)!.has(fp))!;
      const stat = parseJson(next.diff_stat_json);
      const evidence: EvidenceRef[] = [
        ...seen.checkRuns.map((c) => logRef(runId, runDir, c)),
        ...passedAgain.map((c) => logRef(runId, runDir, c!)),
        ...seen.failureRows.map((f) => rowRef(runId, 'failure', f)),
        rowRef(runId, 'candidate', { id: next.id, seq: next.seq, commit_sha: next.commit_sha, tree_hash: next.tree_hash, diff_stat_json: next.diff_stat_json }),
      ];
      const excerpt = seen.checkRuns.find((c) => c.excerpt)?.excerpt ?? seen.failureRows.find((f) => f.excerpt)?.excerpt ?? null;
      out.push({
        id: observationId(runId, 'failure-repair', fp),
        run_id: runId,
        source: 'failure-repair',
        kind: 'repair-recipe',
        summary: cleanUntrusted(`Failure ${fp} in ${checkIds.join(', ')} cleared between candidate ${cur.seq} and ${next.seq}`, TEXT_MAX),
        detail: {
          fingerprint: fp,
          first_seen_candidate: firstSeen.seq,
          failing_candidate: cur.seq,
          fixed_candidate: next.seq,
          persisted_candidates: cur.seq - firstSeen.seq + 1,
          failure_excerpt: cleanUntrusted(excerpt, TEXT_MAX),
          fix_diff_stat: boundedDiffStat(stat),
        },
        fingerprints: [fp],
        check_ids: checkIds,
        paths: diffStatPaths(stat),
        evidence: dedupeRefs(evidence),
      });
    }
  }
  return out;
}

function findingObservations(db: OrbitDb, runId: string): Observation[] {
  const marks = RESOLVED_FINDING_STATUSES.map(() => '?').join(',');
  const rows = db.all<FindingRow>(
    `SELECT f.id, f.review_id, f.severity, f.category, f.location, f.claim, f.evidence, f.suggested_validation, f.status, f.resolution, r.packet_sha256
     FROM findings f JOIN reviews r ON r.id = f.review_id
     WHERE f.run_id = ? AND f.status IN (${marks})
     ORDER BY f.id`,
    runId,
    ...RESOLVED_FINDING_STATUSES,
  );
  return rows.map((f) => {
    const evidence: EvidenceRef[] = [rowRef(runId, 'finding', f)];
    const packet = asSha256(f.packet_sha256);
    if (packet) evidence.push({ run_id: runId, artifact: `review:${f.review_id}`, sha256: packet, relation: 'supports' });
    return {
      id: observationId(runId, 'review-finding', f.id),
      run_id: runId,
      source: 'review-finding' as const,
      kind: 'hazard' as const,
      summary: cleanUntrusted(f.claim, TEXT_MAX),
      detail: {
        severity: f.severity,
        category: f.category,
        location: cleanUntrusted(f.location, 200),
        evidence: cleanUntrusted(f.evidence, TEXT_MAX),
        suggested_validation: cleanUntrusted(f.suggested_validation, TEXT_MAX),
        resolution: cleanUntrusted(f.resolution, TEXT_MAX),
      },
      fingerprints: [],
      check_ids: [],
      paths: locationPath(f.location),
      evidence,
    };
  });
}

function ciObservations(db: OrbitDb, runId: string): Observation[] {
  const rows = db.all<FailureRow>(
    'SELECT id, candidate_id, source, source_id, fingerprint, excerpt, created_at FROM failures WHERE run_id = ? AND source = ? ORDER BY fingerprint, id',
    runId,
    CI_FAILURE_SOURCE,
  );
  const byFp = new Map<string, FailureRow[]>();
  for (const r of rows) byFp.set(r.fingerprint, [...(byFp.get(r.fingerprint) ?? []), r]);
  return [...byFp.entries()].map(([fp, group]) => ({
    id: observationId(runId, 'ci-failure', fp),
    run_id: runId,
    source: 'ci-failure' as const,
    kind: 'failure-pattern' as const,
    summary: cleanUntrusted(group.find((g) => g.excerpt)?.excerpt ?? `CI failure ${fp}`, TEXT_MAX),
    detail: { fingerprint: fp, occurrences: group.length, ci_sources: [...new Set(group.map((g) => g.source_id).filter((s): s is string => !!s))].slice(0, 10) },
    fingerprints: [fp],
    check_ids: [],
    paths: [],
    evidence: dedupeRefs(group.map((g) => rowRef(runId, 'failure', g))).slice(0, 10),
  }));
}

function decisionObservations(db: OrbitDb, runId: string): Observation[] {
  const rows = db.all<DecisionRow>('SELECT id, kind, summary, data_json, created_at FROM decisions WHERE run_id = ? ORDER BY created_at, id', runId);
  const out: Observation[] = [];
  for (const d of rows) {
    const data = parseJson(d.data_json);
    if (isDenial(d.kind)) {
      out.push(denialObservation(runId, d, data));
      continue;
    }
    const evidence = evidenceText(data);
    // A decision without cited evidence is an opinion, not something learned.
    if (!evidence) continue;
    out.push({
      id: observationId(runId, 'decision', d.id),
      run_id: runId,
      source: 'decision',
      kind: 'convention',
      summary: cleanUntrusted(d.summary, TEXT_MAX),
      detail: { decision_kind: d.kind, evidence: cleanUntrusted(evidence, TEXT_MAX) },
      fingerprints: [],
      check_ids: [],
      paths: [],
      evidence: [rowRef(runId, 'decision', d)],
    });
  }
  return out;
}

function denialObservation(runId: string, d: DecisionRow, data: unknown): Observation {
  const fields = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const rawPaths = [fields.path, ...(Array.isArray(fields.paths) ? fields.paths : [])].filter((p): p is string => typeof p === 'string');
  return {
    id: observationId(runId, 'scope-denial', `decision\u0000${d.id}`),
    run_id: runId,
    source: 'scope-denial',
    kind: 'hazard',
    summary: cleanUntrusted(d.summary, TEXT_MAX),
    detail: {
      category: 'policy-denial',
      decision_kind: d.kind,
      rule: typeof fields.rule === 'string' ? cleanUntrusted(fields.rule, 80) : null,
      reason: typeof fields.reason === 'string' ? cleanUntrusted(fields.reason, TEXT_MAX) : null,
    },
    fingerprints: [],
    check_ids: [],
    paths: [...new Set(rawPaths)].sort().slice(0, PATHS_MAX),
    evidence: [rowRef(runId, 'decision', d)],
  };
}

/** Changes the controller's scope inspection flagged: forbidden, out of scope, or escaping symlinks. */
function scopeObservations(db: OrbitDb, runId: string): Observation[] {
  const rows = db.all<CandidateRow>(
    'SELECT id, seq, attempt, commit_sha, tree_hash, status, diff_stat_json, scope_json FROM candidates WHERE run_id = ? AND scope_json IS NOT NULL ORDER BY seq',
    runId,
  );
  const byKey = new Map<string, Observation>();
  for (const c of rows) {
    const scope = parseJson(c.scope_json) as Partial<ScopeReport> | null;
    if (!scope) continue;
    const categories: [string, string[] | undefined][] = [
      ['forbidden', scope.forbidden_paths_changed],
      ['out-of-scope', scope.out_of_scope_paths_changed],
      ['symlink-escape', scope.symlinks_escaping],
    ];
    for (const [category, list] of categories) {
      const paths = (list ?? []).filter((p): p is string => typeof p === 'string').sort().slice(0, PATHS_MAX);
      if (paths.length === 0) continue;
      const key = `${category}\u0000${paths.join('\u0000')}`;
      const ref = rowRef(runId, 'candidate', { id: c.id, seq: c.seq, tree_hash: c.tree_hash, scope_json: c.scope_json });
      const existing = byKey.get(key);
      if (existing) {
        existing.evidence = dedupeRefs([...existing.evidence, ref]).slice(0, 10);
        (existing.detail.candidates as number[]).push(c.seq);
        continue;
      }
      byKey.set(key, {
        id: observationId(runId, 'scope-denial', key),
        run_id: runId,
        source: 'scope-denial',
        kind: 'hazard',
        summary: cleanUntrusted(`Scope inspection refused ${category} changes to ${truncate(paths.join(', '), 300)}`, TEXT_MAX),
        detail: { category, candidates: [c.seq] },
        fingerprints: [],
        check_ids: [],
        paths,
        evidence: [ref],
      });
    }
  }
  return [...byKey.values()];
}

function dedupeRefs(refs: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const k = `${r.relation}\u0000${r.run_id}\u0000${r.artifact}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
