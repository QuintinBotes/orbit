import type { OrbitDb } from '../storage/db.ts';
import { systemClock, type Clock } from '../core/clock.ts';
import { isOrbitError, OrbitError } from '../core/errors.ts';
import { newId } from '../core/ids.ts';
import { openKnowledgeDb } from './db.ts';
import { assertLesson } from './validate.ts';
import { authorityViolations, lessonText, verificationLooksExecutable } from './authority.ts';
import { lessonIdFor, lessonKey, searchTerms, unionCapped } from './text.ts';
import { fromJsonLd, toJsonLd, type JsonLdDocument } from './jsonld.ts';
import {
  EDGE_TYPES,
  type Confidence,
  type EdgeType,
  type EvidenceRef,
  type Lesson,
  type LessonKind,
  type LessonScope,
  type LessonStats,
  type LessonStatus,
  type OverlayEvaluation,
  type OverlayStatus,
  type PromptOverlay,
  type Provenance,
} from './types.ts';

/** Schema maxItems, mirrored so merges never produce a lesson the schema rejects. */
const CAPS = {
  languages: 10,
  frameworks: 10,
  paths: 20,
  check_ids: 20,
  fingerprints: 20,
  roles: 5,
  keywords: 20,
  evidence: 50,
  derived_from: 50,
} as const;

const CONFIDENCE_ORDER: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };

export interface LessonFilters {
  kinds?: readonly LessonKind[];
  statuses?: readonly LessonStatus[];
  scopes?: readonly LessonScope[];
  sources?: readonly Provenance['source'][];
  /** Keep lessons whose roles list is empty (any role) or names one of these. */
  roles?: readonly string[];
  limit?: number;
}

export interface SearchHit {
  lesson: Lesson;
  /** SQLite FTS5 bm25: lower (more negative) is a better match. */
  bm25: number;
}

export interface UpsertResult {
  lesson: Lesson;
  /** A new node was inserted. */
  created: boolean;
  /** An existing node with the same kind and normalized statement absorbed the input. */
  merged: boolean;
}

export interface EdgeRecord {
  src: string;
  dst: string;
  type: EdgeType;
  run_id: string | null;
  data: Record<string, unknown> | null;
}

export interface LessonEvent {
  lesson_id: string;
  ts: number;
  type: string;
  data: Record<string, unknown> | null;
}

export interface RetrievalRow {
  run_id: string;
  worker_id: string | null;
  lesson_id: string;
  ts: number;
  score: number | null;
  outcome: 'success' | 'failure' | null;
  attempts: number | null;
}

export interface EvalRunRecord {
  id: string;
  overlay_id: string;
  kind: 'replay' | 'live';
  suite_id: string | null;
  cases: number | null;
  baseline: unknown;
  metrics: unknown;
  decision: string;
  detail: Record<string, unknown> | null;
  created_at: number;
}

export interface ImportReport {
  imported: string[];
  merged: string[];
  rejected: { ref: string; reason: string }[];
  edges: number;
}

interface NodeRow {
  id: string;
  lesson_json: string;
}

interface OverlayRow {
  id: string;
  role: string;
  scope: string;
  version: number;
  status: string;
  content: string;
  lesson_ids_json: string;
  parent_id: string | null;
  eval_json: string | null;
  created_at: number;
  activated_at: number | null;
  updated_at: number;
}

function evidenceKey(e: EvidenceRef): string {
  return `${e.relation}\u0000${e.run_id}\u0000${e.artifact}`;
}

/** Union by (relation, run, artifact), oldest first, keeping the newest when over the cap. */
export function mergeEvidence(a: readonly EvidenceRef[], b: readonly EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  const out: EvidenceRef[] = [];
  for (const e of [...a, ...b]) {
    const k = evidenceKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ run_id: e.run_id, artifact: e.artifact, sha256: e.sha256, relation: e.relation });
  }
  // The edges table keeps every piece of evidence; the lesson document keeps a bounded window.
  return out.length > CAPS.evidence ? out.slice(out.length - CAPS.evidence) : out;
}

/**
 * Merge `incoming` into `existing`. The existing node keeps its id, text,
 * status and scope (a merge is new evidence, never a status change); lists
 * are unioned within schema caps; confidence takes the higher of the two;
 * code_free holds only if both sides claim it.
 */
export function mergeLessons(existing: Lesson, incoming: Lesson): Lesson {
  const a = existing.applicability;
  const b = incoming.applicability;
  return {
    ...existing,
    rationale: existing.rationale.trim() ? existing.rationale : incoming.rationale,
    verification: existing.verification.trim() ? existing.verification : incoming.verification,
    applicability: {
      languages: unionCapped(a.languages, b.languages, CAPS.languages),
      frameworks: unionCapped(a.frameworks, b.frameworks, CAPS.frameworks),
      paths: unionCapped(a.paths, b.paths, CAPS.paths),
      check_ids: unionCapped(a.check_ids, b.check_ids, CAPS.check_ids),
      fingerprints: unionCapped(a.fingerprints, b.fingerprints, CAPS.fingerprints),
      roles: unionCapped(a.roles, b.roles, CAPS.roles),
      keywords: unionCapped(a.keywords, b.keywords, CAPS.keywords),
    },
    evidence: mergeEvidence(existing.evidence, incoming.evidence),
    provenance: {
      ...existing.provenance,
      uri: existing.provenance.uri ?? incoming.provenance.uri,
      derived_from: unionCapped(existing.provenance.derived_from, incoming.provenance.derived_from, CAPS.derived_from),
    },
    confidence: CONFIDENCE_ORDER[incoming.confidence] > CONFIDENCE_ORDER[existing.confidence] ? incoming.confidence : existing.confidence,
    code_free: existing.code_free && incoming.code_free,
    supersedes: existing.supersedes ?? (incoming.supersedes === existing.id ? null : incoming.supersedes),
  };
}

/**
 * Rejects text that could act as an instruction outside a worker's authority,
 * and verification that reads as a command. Every path into the store
 * (curator, ingest, import, seeds, global promotion) passes through here.
 */
function assertAdvisory(lesson: Lesson): void {
  const violations = authorityViolations(lessonText(lesson));
  if (violations.length > 0) {
    throw new OrbitError('POLICY_DENIED', `lesson ${lesson.id} contains authority language (${violations.join(', ')})`, { violations });
  }
  const executable = verificationLooksExecutable(lesson.verification);
  if (executable) throw new OrbitError('SCHEMA_INVALID', `lesson ${lesson.id} verification must be a description, not a command (${executable})`);
}

function ftsApplicability(lesson: Lesson): string {
  const a = lesson.applicability;
  return [lesson.kind, ...a.languages, ...a.frameworks, ...a.check_ids, ...a.fingerprints, ...a.roles, ...a.paths].join(' ');
}

function parseLesson(json: string): Lesson {
  return JSON.parse(json) as Lesson;
}

function toOverlay(r: OverlayRow): PromptOverlay {
  return {
    id: r.id,
    role: r.role,
    scope: r.scope as LessonScope,
    version: r.version,
    content: r.content,
    lesson_ids: JSON.parse(r.lesson_ids_json) as string[],
    status: r.status as OverlayStatus,
    parent_id: r.parent_id,
    eval: r.eval_json ? (JSON.parse(r.eval_json) as OverlayEvaluation) : null,
    created_at: new Date(r.created_at).toISOString(),
    activated_at: r.activated_at === null ? null : new Date(r.activated_at).toISOString(),
  };
}

/**
 * One knowledge graph: a repository's (`.orbit/knowledge.sqlite`) or the
 * global one (`~/.orbit/knowledge.sqlite`). All writes run inside one
 * IMMEDIATE transaction each, so a crash never leaves a node without its FTS
 * row or its evidence edges.
 */
export class KnowledgeStore {
  readonly db: OrbitDb;
  readonly clock: Clock;

  private constructor(db: OrbitDb, clock: Clock) {
    this.db = db;
    this.clock = clock;
  }

  static open(path: string, options: { clock?: Clock; busyTimeoutMs?: number } = {}): KnowledgeStore {
    return new KnowledgeStore(openKnowledgeDb(path, options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }), options.clock ?? systemClock);
  }

  get path(): string {
    return this.db.path;
  }

  /** Synchronous callbacks only: the write lock is held for the whole call. */
  tx<T>(fn: () => T): T {
    return this.db.tx(fn);
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Lessons

  /**
   * Insert a lesson, or merge it into the node that already holds the same
   * kind and normalized statement. Validates against orbit.lesson/1 and the
   * authority filter before touching the database, and again after merging.
   */
  upsertLesson(input: Lesson): UpsertResult {
    assertLesson(input);
    assertAdvisory(input);
    const key = lessonKey(input.kind, input.statement);
    const now = this.clock.now();
    return this.db.tx(() => {
      const existingRow = this.db.get<NodeRow>('SELECT id, lesson_json FROM nodes WHERE norm_key = ?', key);
      if (existingRow) {
        const existing = parseLesson(existingRow.lesson_json);
        const merged = mergeLessons(existing, input);
        assertLesson(merged);
        const before = existing.evidence.length;
        this.writeNode(merged, key, now, false);
        this.writeLessonEdges(merged, input, now);
        this.appendEvent(merged.id, 'merged', { from_id: input.id, source: input.provenance.source, evidence_before: before, evidence_after: merged.evidence.length }, now);
        return { lesson: merged, created: false, merged: true };
      }
      const lesson: Lesson = { ...input, id: this.freeId(input), evidence: mergeEvidence([], input.evidence) };
      assertLesson(lesson);
      this.writeNode(lesson, key, now, true);
      this.writeLessonEdges(lesson, lesson, now);
      this.appendEvent(lesson.id, 'created', { source: lesson.provenance.source, status: lesson.status, requested_id: input.id === lesson.id ? undefined : input.id }, now);
      return { lesson, created: true, merged: false };
    });
  }

  /** Keep the caller's id unless another statement already owns it. */
  private freeId(input: Lesson): string {
    const taken = (id: string) => this.db.get<{ id: string }>('SELECT id FROM nodes WHERE id = ?', id) !== undefined;
    if (!taken(input.id)) return input.id;
    const derived = lessonIdFor(input.kind, input.statement);
    if (!taken(derived)) return derived;
    for (;;) {
      const id = newId('les');
      if (!taken(id)) return id;
    }
  }

  private writeNode(lesson: Lesson, key: string, now: number, insert: boolean): void {
    const json = JSON.stringify(lesson);
    if (insert) {
      this.db.run(
        `INSERT INTO nodes (id, norm_key, kind, status, scope, confidence, code_free, source, statement, lesson_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        lesson.id,
        key,
        lesson.kind,
        lesson.status,
        lesson.scope,
        lesson.confidence,
        lesson.code_free ? 1 : 0,
        lesson.provenance.source,
        lesson.statement,
        json,
        now,
        now,
      );
    } else {
      this.db.run(
        'UPDATE nodes SET status = ?, scope = ?, confidence = ?, code_free = ?, lesson_json = ?, updated_at = ? WHERE id = ?',
        lesson.status,
        lesson.scope,
        lesson.confidence,
        lesson.code_free ? 1 : 0,
        json,
        now,
        lesson.id,
      );
      this.db.run('DELETE FROM fts WHERE lesson_id = ?', lesson.id);
    }
    this.db.run(
      'INSERT INTO fts (lesson_id, statement, rationale, keywords, applicability) VALUES (?, ?, ?, ?, ?)',
      lesson.id,
      lesson.statement,
      lesson.rationale,
      lesson.applicability.keywords.join(' '),
      ftsApplicability(lesson),
    );
  }

  /** Edges implied by a lesson's own fields. `source` supplies evidence that may have been trimmed from the merged window. */
  private writeLessonEdges(lesson: Lesson, source: Lesson, now: number): void {
    // Not mergeEvidence: its cap would drop edges, and the edges are the full record.
    for (const e of [...source.evidence, ...lesson.evidence]) this.insertEvidenceEdge(lesson.id, e, now);
    for (const d of source.provenance.derived_from) this.insertEdge(lesson.id, d, 'DERIVED_FROM', null, null, now);
    if (lesson.supersedes) this.insertEdge(lesson.id, lesson.supersedes, 'SUPERSEDES', null, null, now);
    for (const c of source.applicability.check_ids) this.insertEdge(lesson.id, `check:${c}`, 'APPLIES_TO', null, null, now);
    for (const f of source.applicability.fingerprints) {
      this.insertEdge(lesson.id, `fingerprint:${f}`, 'APPLIES_TO', null, null, now);
      if (lesson.kind === 'repair-recipe') this.insertEdge(`fingerprint:${f}`, lesson.id, 'FIXED_BY', null, null, now);
    }
  }

  private insertEvidenceEdge(lessonId: string, e: EvidenceRef, now: number): boolean {
    return this.insertEdge(
      lessonId,
      `evidence:${e.run_id}#${e.artifact}`,
      e.relation === 'supports' ? 'SUPPORTED_BY' : 'CONTRADICTED_BY',
      e.run_id,
      { artifact: e.artifact, sha256: e.sha256 },
      now,
    );
  }

  private insertEdge(src: string, dst: string, type: EdgeType, runId: string | null, data: Record<string, unknown> | null, now: number): boolean {
    const r = this.db.run(
      'INSERT OR IGNORE INTO edges (src, dst, type, run_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      src,
      dst,
      type,
      runId,
      data ? JSON.stringify(data) : null,
      now,
    );
    return r.changes === 1;
  }

  getLesson(id: string): Lesson | null {
    const row = this.db.get<NodeRow>('SELECT id, lesson_json FROM nodes WHERE id = ?', id);
    return row ? parseLesson(row.lesson_json) : null;
  }

  requireLesson(id: string): Lesson {
    const lesson = this.getLesson(id);
    if (!lesson) throw new OrbitError('NOT_FOUND', `no lesson ${id}`);
    return lesson;
  }

  /** The node a lesson with this kind and statement would merge into, if any. */
  findByStatement(kind: LessonKind, statement: string): Lesson | null {
    const row = this.db.get<NodeRow>('SELECT id, lesson_json FROM nodes WHERE norm_key = ?', lessonKey(kind, statement));
    return row ? parseLesson(row.lesson_json) : null;
  }

  listLessons(filters: LessonFilters = {}): Lesson[] {
    const { where, params } = filterSql(filters);
    const rows = this.db.all<NodeRow>(`SELECT id, lesson_json FROM nodes n ${where} ORDER BY n.id`, ...params);
    const lessons = rows.map((r) => parseLesson(r.lesson_json)).filter((l) => roleMatches(l, filters.roles));
    return filters.limit === undefined ? lessons : lessons.slice(0, filters.limit);
  }

  count(): number {
    return Number(this.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM nodes')?.n ?? 0);
  }

  /**
   * Full-text search over statement, rationale, keywords and applicability.
   * The query is reduced to plain terms OR-ed together, so no part of the
   * caller's text is ever interpreted as FTS5 syntax.
   */
  search(text: string, filters: LessonFilters = {}): SearchHit[] {
    const terms = searchTerms(text);
    if (terms.length === 0) return [];
    const match = terms.map((t) => `"${t}"`).join(' OR ');
    const { where, params } = filterSql(filters, 'AND');
    const limit = Math.max(1, Math.min(filters.limit ?? 50, 500));
    const rows = this.db.all<{ lesson_json: string; rank: number }>(
      `SELECT n.lesson_json AS lesson_json, bm25(fts, 0.0, 4.0, 1.0, 2.0, 1.0) AS rank
       FROM fts JOIN nodes n ON n.id = fts.lesson_id
       WHERE fts MATCH ? ${where}
       ORDER BY rank ASC, n.id ASC
       LIMIT ?`,
      match,
      ...params,
      // Role filtering happens after the query, so fetch more than asked.
      filters.roles ? limit * 4 : limit,
    );
    return rows
      .map((r) => ({ lesson: parseLesson(r.lesson_json), bm25: Number(r.rank) }))
      .filter((h) => roleMatches(h.lesson, filters.roles))
      .slice(0, limit);
  }

  /**
   * Record a status change with its reason. The rules deciding when a status
   * changes live in feedback.ts and overlays.ts; this only writes and audits.
   */
  setStatus(id: string, status: LessonStatus, reason: string, data?: Record<string, unknown>): Lesson {
    const now = this.clock.now();
    return this.db.tx(() => {
      const lesson = this.requireLesson(id);
      if (lesson.status === status) return lesson;
      const next: Lesson = { ...lesson, status };
      this.db.run('UPDATE nodes SET status = ?, lesson_json = ?, updated_at = ? WHERE id = ?', status, JSON.stringify(next), now, id);
      this.appendEvent(id, 'status', { from: lesson.status, to: status, reason, ...(data ?? {}) }, now);
      return next;
    });
  }

  /**
   * Attach one piece of evidence to a lesson. Returns false when the same
   * (relation, run, artifact) was already recorded, which is what makes
   * settling a run twice harmless.
   */
  addEvidence(id: string, ref: EvidenceRef): boolean {
    const now = this.clock.now();
    return this.db.tx(() => {
      const lesson = this.requireLesson(id);
      const added = this.insertEvidenceEdge(id, ref, now);
      if (!added) return false;
      const next: Lesson = { ...lesson, evidence: mergeEvidence(lesson.evidence, [ref]) };
      assertLesson(next);
      this.db.run('UPDATE nodes SET lesson_json = ?, updated_at = ? WHERE id = ?', JSON.stringify(next), now, id);
      this.appendEvent(id, 'evidence', { relation: ref.relation, run_id: ref.run_id, artifact: ref.artifact }, now);
      return true;
    });
  }

  /** Add a typed edge; false when it already existed (edges are unique per src, dst, type). */
  addEdge(src: string, dst: string, type: EdgeType, data?: Record<string, unknown> | null, runId?: string | null): boolean {
    if (!(EDGE_TYPES as readonly string[]).includes(type)) throw new OrbitError('SCHEMA_INVALID', `unknown edge type ${String(type)}`);
    if (!src || !dst) throw new OrbitError('SCHEMA_INVALID', 'edge endpoints must be non-empty');
    return this.db.tx(() => this.insertEdge(src, dst, type, runId ?? null, data ?? null, this.clock.now()));
  }

  edges(query: { src?: string; dst?: string; type?: EdgeType } = {}): EdgeRecord[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (query.src !== undefined) {
      clauses.push('src = ?');
      params.push(query.src);
    }
    if (query.dst !== undefined) {
      clauses.push('dst = ?');
      params.push(query.dst);
    }
    if (query.type !== undefined) {
      clauses.push('type = ?');
      params.push(query.type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db
      .all<{ src: string; dst: string; type: string; run_id: string | null; data_json: string | null }>(`SELECT src, dst, type, run_id, data_json FROM edges ${where} ORDER BY src, type, dst`, ...params)
      .map((r) => ({ src: r.src, dst: r.dst, type: r.type as EdgeType, run_id: r.run_id, data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : null }));
  }

  events(lessonId: string): LessonEvent[] {
    return this.db
      .all<{ lesson_id: string; ts: number; type: string; data_json: string | null }>('SELECT lesson_id, ts, type, data_json FROM lesson_events WHERE lesson_id = ? ORDER BY id', lessonId)
      .map((r) => ({ lesson_id: r.lesson_id, ts: r.ts, type: r.type, data: r.data_json ? (JSON.parse(r.data_json) as Record<string, unknown>) : null }));
  }

  private appendEvent(lessonId: string, type: string, data: Record<string, unknown> | null, ts: number): void {
    this.db.run('INSERT INTO lesson_events (lesson_id, ts, type, data_json) VALUES (?, ?, ?, ?)', lessonId, ts, type, data ? JSON.stringify(data) : null);
  }

  /**
   * Counts are per distinct run: one run citing three artifacts is one run of
   * support, so it cannot outvote a contradiction from another run.
   * `retrieved` and the after-retrieval outcomes are also per distinct run.
   */
  stats(lessonId: string): LessonStats {
    return this.statsMany([lessonId]).get(lessonId) ?? emptyStats();
  }

  statsMany(lessonIds: readonly string[]): Map<string, LessonStats> {
    const out = new Map<string, LessonStats>();
    for (const id of lessonIds) out.set(id, emptyStats());
    if (lessonIds.length === 0) return out;
    for (let i = 0; i < lessonIds.length; i += 400) {
      const chunk = lessonIds.slice(i, i + 400);
      const marks = chunk.map(() => '?').join(',');
      const edgeRows = this.db.all<{ src: string; support: number; contradict: number; runs: number }>(
        `SELECT src,
                COUNT(DISTINCT CASE WHEN type = 'SUPPORTED_BY' THEN run_id END) AS support,
                COUNT(DISTINCT CASE WHEN type = 'CONTRADICTED_BY' THEN run_id END) AS contradict,
                COUNT(DISTINCT run_id) AS runs
         FROM edges WHERE src IN (${marks}) AND type IN ('SUPPORTED_BY', 'CONTRADICTED_BY') AND run_id IS NOT NULL
         GROUP BY src`,
        ...chunk,
      );
      for (const r of edgeRows) {
        const s = out.get(r.src);
        if (!s) continue;
        s.support = Number(r.support);
        s.contradict = Number(r.contradict);
        s.distinct_runs = Number(r.runs);
      }
      const retrievalRows = this.db.all<{ lesson_id: string; retrieved: number; ok: number; bad: number }>(
        `SELECT lesson_id,
                COUNT(DISTINCT run_id) AS retrieved,
                COUNT(DISTINCT CASE WHEN outcome = 'success' THEN run_id END) AS ok,
                COUNT(DISTINCT CASE WHEN outcome = 'failure' THEN run_id END) AS bad
         FROM retrievals WHERE lesson_id IN (${marks}) GROUP BY lesson_id`,
        ...chunk,
      );
      for (const r of retrievalRows) {
        const s = out.get(r.lesson_id);
        if (!s) continue;
        s.retrieved = Number(r.retrieved);
        s.success_after_retrieval = Number(r.ok);
        s.failure_after_retrieval = Number(r.bad);
      }
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Retrievals

  recordRetrievals(runId: string, workerId: string | null, items: readonly { lessonId: string; score: number | null }[]): number {
    const now = this.clock.now();
    return this.db.tx(() => {
      let n = 0;
      for (const item of items) {
        this.requireLesson(item.lessonId);
        this.db.run('INSERT INTO retrievals (run_id, worker_id, lesson_id, ts, score) VALUES (?, ?, ?, ?, ?)', runId, workerId, item.lessonId, now, item.score);
        n++;
      }
      return n;
    });
  }

  retrievalsForRun(runId: string): RetrievalRow[] {
    return this.db
      .all<RetrievalRow>('SELECT run_id, worker_id, lesson_id, ts, score, outcome, attempts FROM retrievals WHERE run_id = ? ORDER BY id', runId)
      .map((r) => ({ ...r, outcome: (r.outcome as RetrievalRow['outcome']) ?? null }));
  }

  /** Mark every retrieval of a run with how the run ended; returns rows updated. */
  settleRetrievals(runId: string, outcome: 'success' | 'failure', attempts: number | null): number {
    const now = this.clock.now();
    return this.db.run('UPDATE retrievals SET outcome = ?, attempts = ?, settled_at = ? WHERE run_id = ?', outcome, attempts, now, runId).changes;
  }

  // -------------------------------------------------------------------------
  // Overlays and evaluations (lifecycle rules live in overlays.ts)

  insertOverlay(overlay: PromptOverlay): void {
    this.db.run(
      `INSERT INTO overlays (id, role, scope, version, status, content, lesson_ids_json, parent_id, eval_json, created_at, activated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      overlay.id,
      overlay.role,
      overlay.scope,
      overlay.version,
      overlay.status,
      overlay.content,
      JSON.stringify(overlay.lesson_ids),
      overlay.parent_id,
      overlay.eval ? JSON.stringify(overlay.eval) : null,
      Date.parse(overlay.created_at),
      overlay.activated_at ? Date.parse(overlay.activated_at) : null,
      this.clock.now(),
    );
  }

  getOverlay(id: string): PromptOverlay | null {
    const row = this.db.get<OverlayRow>('SELECT * FROM overlays WHERE id = ?', id);
    return row ? toOverlay(row) : null;
  }

  listOverlays(filter: { role?: string; scope?: LessonScope } = {}): PromptOverlay[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filter.role !== undefined) {
      clauses.push('role = ?');
      params.push(filter.role);
    }
    if (filter.scope !== undefined) {
      clauses.push('scope = ?');
      params.push(filter.scope);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.all<OverlayRow>(`SELECT * FROM overlays ${where} ORDER BY role, scope, version`, ...params).map(toOverlay);
  }

  activeOverlay(role: string, scope: LessonScope): PromptOverlay | null {
    const row = this.db.get<OverlayRow>("SELECT * FROM overlays WHERE role = ? AND scope = ? AND status = 'active' ORDER BY version DESC LIMIT 1", role, scope);
    return row ? toOverlay(row) : null;
  }

  nextOverlayVersion(role: string, scope: LessonScope): number {
    const row = this.db.get<{ v: number | null }>('SELECT MAX(version) AS v FROM overlays WHERE role = ? AND scope = ?', role, scope);
    return Number(row?.v ?? 0) + 1;
  }

  updateOverlay(id: string, patch: { status: OverlayStatus; eval?: OverlayEvaluation | null; activatedAt?: number | null; parentId?: string | null }): void {
    const sets = ['status = ?', 'updated_at = ?'];
    const params: (string | number | null)[] = [patch.status, this.clock.now()];
    if (patch.parentId !== undefined) {
      sets.push('parent_id = ?');
      params.push(patch.parentId);
    }
    if (patch.eval !== undefined) {
      sets.push('eval_json = ?');
      params.push(patch.eval ? JSON.stringify(patch.eval) : null);
    }
    if (patch.activatedAt !== undefined) {
      sets.push('activated_at = ?');
      params.push(patch.activatedAt);
    }
    const r = this.db.run(`UPDATE overlays SET ${sets.join(', ')} WHERE id = ?`, ...params, id);
    if (r.changes !== 1) throw new OrbitError('NOT_FOUND', `no overlay ${id}`);
  }

  insertEvalRun(row: Omit<EvalRunRecord, 'created_at'>): void {
    this.db.run(
      `INSERT INTO eval_runs (id, overlay_id, kind, suite_id, cases, baseline_json, metrics_json, decision, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.id,
      row.overlay_id,
      row.kind,
      row.suite_id,
      row.cases,
      row.baseline === undefined ? null : JSON.stringify(row.baseline),
      JSON.stringify(row.metrics),
      row.decision,
      row.detail ? JSON.stringify(row.detail) : null,
      this.clock.now(),
    );
  }

  evalRuns(overlayId: string): EvalRunRecord[] {
    return this.db
      .all<{
        id: string;
        overlay_id: string;
        kind: string;
        suite_id: string | null;
        cases: number | null;
        baseline_json: string | null;
        metrics_json: string;
        decision: string;
        detail_json: string | null;
        created_at: number;
      }>('SELECT * FROM eval_runs WHERE overlay_id = ? ORDER BY created_at, rowid', overlayId)
      .map((r) => ({
        id: r.id,
        overlay_id: r.overlay_id,
        kind: r.kind as EvalRunRecord['kind'],
        suite_id: r.suite_id,
        cases: r.cases,
        baseline: r.baseline_json ? JSON.parse(r.baseline_json) : null,
        metrics: JSON.parse(r.metrics_json),
        decision: r.decision,
        detail: r.detail_json ? (JSON.parse(r.detail_json) as Record<string, unknown>) : null,
        created_at: r.created_at,
      }));
  }

  // -------------------------------------------------------------------------
  // Interchange

  /** The whole graph (lessons and edges) as JSON-LD with schema.org and PROV-O terms. */
  exportJsonLd(): JsonLdDocument {
    return toJsonLd(this.listLessons(), this.edges(), new Date(this.clock.now()).toISOString());
  }

  /**
   * Load a document produced by exportJsonLd. Imported text is untrusted:
   * every lesson passes the schema and the authority filter. Unless
   * `preserveStatus` is set (a restore of one's own export, which keeps
   * statuses, evidence and every edge), a lesson lands as `candidate` with no
   * evidence and no evidence edges: support is counted per run id, and run ids
   * from another graph name runs this graph never saw, so keeping them would
   * let an import validate (or deprecate) lessons with no local corroboration.
   *
   * The import is one transaction: a lesson the schema or the authority filter
   * refuses is reported and skipped, but any other failure aborts the whole
   * import so a graph is never left half loaded.
   */
  importJsonLd(doc: unknown, options: { preserveStatus?: boolean } = {}): ImportReport {
    let parsed: ReturnType<typeof fromJsonLd>;
    try {
      parsed = fromJsonLd(doc);
    } catch (err) {
      throw new OrbitError('SCHEMA_INVALID', `not an Orbit JSON-LD export: ${err instanceof Error ? err.message : String(err)}`, undefined, { cause: err });
    }
    const restore = options.preserveStatus === true;
    const report: ImportReport = { imported: [], merged: [], rejected: [...parsed.rejected], edges: 0 };
    const idMap = new Map<string, string>();
    return this.db.tx(() => {
      for (const lesson of parsed.lessons) {
        const incoming: Lesson = restore ? lesson : { ...lesson, status: lesson.status === 'validated' ? 'candidate' : lesson.status, evidence: [] };
        try {
          const res = this.upsertLesson(incoming);
          idMap.set(lesson.id, res.lesson.id);
          (res.created ? report.imported : report.merged).push(res.lesson.id);
        } catch (err) {
          if (!isOrbitError(err, 'SCHEMA_INVALID') && !isOrbitError(err, 'POLICY_DENIED')) throw err;
          report.rejected.push({ ref: lesson.id, reason: err.message });
        }
      }
      const now = this.clock.now();
      for (const e of parsed.edges) {
        if (!(EDGE_TYPES as readonly string[]).includes(e.type)) continue;
        const src = idMap.get(e.src) ?? e.src;
        const dst = idMap.get(e.dst) ?? e.dst;
        if (!restore) {
          // From someone else's graph, only edges that hang off an imported lesson
          // are taken (the rest of its topology is not this graph's business), and
          // never evidence: see above.
          if (!idMap.has(e.src) && !idMap.has(e.dst)) continue;
          if (e.type === 'SUPPORTED_BY' || e.type === 'CONTRADICTED_BY' || e.run_id !== null) continue;
        }
        if (this.insertEdge(src, dst, e.type, e.run_id, e.data, now)) report.edges++;
      }
      return report;
    });
  }
}

function emptyStats(): LessonStats {
  return { support: 0, contradict: 0, distinct_runs: 0, retrieved: 0, success_after_retrieval: 0, failure_after_retrieval: 0 };
}

function roleMatches(lesson: Lesson, roles: readonly string[] | undefined): boolean {
  if (!roles || roles.length === 0) return true;
  return lesson.applicability.roles.length === 0 || lesson.applicability.roles.some((r) => roles.includes(r));
}

function filterSql(filters: LessonFilters, lead: 'WHERE' | 'AND' = 'WHERE'): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  const add = (column: string, values: readonly string[] | undefined) => {
    if (!values) return;
    if (values.length === 0) {
      clauses.push('0');
      return;
    }
    clauses.push(`n.${column} IN (${values.map(() => '?').join(',')})`);
    params.push(...values);
  };
  add('kind', filters.kinds);
  add('status', filters.statuses);
  add('scope', filters.scopes);
  add('source', filters.sources);
  if (clauses.length === 0) return { where: '', params };
  return { where: `${lead} ${clauses.join(' AND ')}`, params };
}
