/**
 * The learning layer as the controller sees it during a run (ADR 0002):
 * advisory lessons for a worker's prompt and the active role overlay. Both
 * are advisory text and grant nothing, and both stay out of prompts unless
 * `knowledge.lessons_in_prompts` is on (issue #173: off until a full benchmark
 * shows they help). Any failure here costs the worker its advice, never the
 * step: knowledge is opened, read and closed per call, and every error is
 * swallowed into a log line.
 */
import { join } from 'node:path';
import type { WorkerRole } from '../adapters/types.ts';
import { redact } from '../core/redact.ts';
import { appendEvent } from '../storage/events.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { applyLiveCheck } from '../knowledge/overlays.ts';
import { recordRetrieval, renderAdvisoryBlock, retrieve } from '../knowledge/retrieve.ts';
import { DEFAULT_LESSON_EXPIRY_DAYS } from '../knowledge/recheck.ts';
import { callMemoryTool, recallShared, sharedMemoryOn, type SharedRow } from '../knowledge/shared-memory.ts';
import { contradictedLessons } from '../knowledge/extract.ts';
import { estimateTokens } from '../knowledge/text.ts';
import type { LearnReport } from '../knowledge/learn.ts';
import type { Lesson, RetrievedLesson } from '../knowledge/types.ts';
import type { RetrievalRow } from '../knowledge/store.ts';
import type { RunContext } from './context.ts';
import { liveWindow } from './eval-runner.ts';

export function repoKnowledgePath(ctx: Pick<RunContext, 'run'>): string {
  return join(ctx.run.repoRoot, '.orbit', 'knowledge.sqlite');
}

export function globalKnowledgePath(ctx: Pick<RunContext, 'deps'>): string {
  return join(ctx.deps.orbitHome, 'knowledge.sqlite');
}

function withStore<T>(ctx: RunContext, fallback: T, fn: (store: KnowledgeStore) => T): T {
  const k = ctx.snapshot.config.knowledge;
  if (!k?.enabled || k.lessons_in_prompts !== true) return fallback;
  let store: KnowledgeStore | null = null;
  try {
    store = KnowledgeStore.open(repoKnowledgePath(ctx), { clock: ctx.clock });
    return fn(store);
  } catch (err) {
    ctx.log.warn('knowledge unavailable for this step', { error: err instanceof Error ? err.message : String(err) });
    return fallback;
  } finally {
    store?.close();
  }
}

/** The active overlay text for a role in this repository, or null. */
export function activeOverlayFor(ctx: RunContext, role: WorkerRole): string | null {
  return withStore(ctx, null, (store) => store.activeOverlay(role, 'repo')?.content ?? null);
}

export interface AdvisoryInput {
  role: WorkerRole;
  workerId: string;
  paths: string[];
  checkIds: string[];
  fingerprints: string[];
}

/** The fenced advisory block for a worker prompt (empty string when nothing applies), recorded against the worker. */
export function advisoryBlockFor(ctx: RunContext, input: AdvisoryInput): string {
  const config = ctx.snapshot.config.knowledge;
  return withStore(ctx, '', (store) => {
    const lessons = retrieve(store, {
      runId: ctx.run.id,
      workerId: input.workerId,
      role: input.role,
      goal: ctx.run.goal,
      paths: input.paths,
      checkIds: input.checkIds,
      fingerprints: input.fingerprints,
      languages: [],
      maxTokens: config.max_advisory_tokens,
      recheck: { root: ctx.run.repoRoot, checkIds: Object.keys(ctx.snapshot.config.checks), expiryDays: config.lesson_expiry_days ?? DEFAULT_LESSON_EXPIRY_DAYS },
    }, { maxLessons: config.max_prompt_lessons ?? 3, maxCandidates: 0 });
    recordRetrieval(store, { runId: ctx.run.id, workerId: input.workerId, fingerprints: input.fingerprints }, lessons);
    return renderAdvisoryBlock(lessons, sharedRowsFor(ctx, input, lessons));
  });
}

function memoryUnavailable(ctx: RunContext, operation: string, err: unknown): void {
  const error = redact(err instanceof Error ? err.message : String(err)).slice(0, 300);
  ctx.log.warn('shared memory unavailable', { operation, error });
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.memory-unavailable', ctx.ownerId, { operation, error }, ctx.clock.now()));
}

/**
 * Issue #233: shared items for a worker's prompt, asked of the run's repository (memory resolves the tenant from it)
 * and trimmed, whole rows, so the block stays within max_advisory_tokens after the lessons. Empty when the adapter is
 * off; a failure is recorded and costs the worker the rows, never the step. The ids shown are recorded per worker.
 */
function sharedRowsFor(ctx: RunContext, input: AdvisoryInput, lessons: readonly RetrievedLesson[]): SharedRow[] {
  const config = ctx.snapshot.config.knowledge;
  if (!sharedMemoryOn(config)) return [];
  let rows: SharedRow[];
  try {
    rows = recallShared(config.shared_memory, ctx.run.repoRoot, { paths: input.paths, checkIds: input.checkIds, fingerprints: input.fingerprints, maxTokens: config.max_advisory_tokens });
  } catch (err) {
    memoryUnavailable(ctx, 'recall', err);
    return [];
  }
  while (rows.length > 0 && estimateTokens(renderAdvisoryBlock(lessons, rows)) > config.max_advisory_tokens) rows.pop();
  if (rows.length > 0) ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.memory-recalled', ctx.ownerId, { worker_id: input.workerId, ids: rows.map((r) => r.id), fingerprints: input.fingerprints }, ctx.clock.now()));
  return rows;
}

const MEMORY_TYPE: Record<Lesson['kind'], string> = { practice: 'convention', 'failure-pattern': 'failure-pattern', 'repair-recipe': 'repair-recipe', convention: 'convention', hazard: 'hazard' };

/**
 * Issue #233, at the learning stage: each lesson this run left validated is proposed to memory with the run as its
 * evidence (never activated: the owner approves in memory), and each recalled item whose failure came back in the
 * run is reported wrong through memory's feedback call. Orbit's own store is not touched. Never throws.
 */
export async function shareWithMemory(ctx: RunContext, store: KnowledgeStore, learn: LearnReport | null): Promise<{ proposed: string[]; reported: string[]; failed: number } | null> {
  const config = ctx.snapshot.config.knowledge;
  if (!sharedMemoryOn(config)) return null;
  const memory = config.shared_memory;
  const out = { proposed: [] as string[], reported: [] as string[], failed: 0 };
  const call = async (operation: string, name: 'memory_propose' | 'memory_feedback', args: Record<string, unknown>, done: string[], id: string): Promise<void> => {
    try {
      await callMemoryTool(memory, ctx.run.repoRoot, name, args);
      done.push(id);
    } catch (err) {
      out.failed++;
      memoryUnavailable(ctx, operation, err);
    }
  };
  for (const id of new Set([...(learn?.created ?? []), ...(learn?.merged ?? [])])) {
    const lesson = store.getLesson(id);
    if (lesson?.status !== 'validated') continue;
    await call('propose', 'memory_propose', { statement: lesson.statement, scope: 'repository', type: MEMORY_TYPE[lesson.kind], evidence: { source: `orbit run ${ctx.run.id}`, origin: 'agent' } }, out.proposed, id);
  }
  const shown: RetrievalRow[] = [];
  for (const e of ctx.db.all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', ctx.run.id, 'learning.memory-recalled')) {
    const d = JSON.parse(e.data_json) as { worker_id: string; ids: string[]; fingerprints: string[] };
    for (const itemId of d.ids) shown.push({ run_id: ctx.run.id, worker_id: d.worker_id, lesson_id: itemId, ts: 0, score: null, outcome: null, attempts: null, fingerprints: d.fingerprints });
  }
  for (const id of contradictedLessons(ctx.db, ctx.run.id, shown)) await call('feedback', 'memory_feedback', { id, signal: 'wrong' }, out.reported, id);
  return out;
}

export interface LiveOverlayCheck {
  overlay_id: string;
  role: string;
  tasks: number;
  rollback: boolean;
  reason: string;
  restored: string | null;
}

/**
 * Live regression (ADR 0002): every active overlay that was adopted on replay
 * evidence is compared, over the runs settled since it was activated, with
 * the baseline it was adopted against; a regression beyond the thresholds
 * rolls it back (the overlay it replaced is restored). Too few settled tasks
 * is not evidence and changes nothing. Never throws: learning cannot change a
 * run's outcome.
 */
export function checkLiveOverlays(ctx: RunContext, store: KnowledgeStore): LiveOverlayCheck[] {
  const out: LiveOverlayCheck[] = [];
  try {
    for (const overlay of store.listOverlays({ scope: 'repo' }).filter((o) => o.status === 'active')) {
      const baseline = overlay.eval?.baseline;
      if (!baseline || !overlay.activated_at) continue;
      const window = liveWindow(ctx.db, Date.parse(overlay.activated_at));
      if (!window) continue;
      const { decision, restored } = applyLiveCheck(store, overlay.id, window, baseline);
      out.push({ overlay_id: overlay.id, role: overlay.role, tasks: window.tasks, rollback: decision.rollback, reason: decision.reason, restored: restored?.id ?? null });
      if (decision.rollback) {
        ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.overlay-rolled-back', ctx.ownerId, { overlay_id: overlay.id, role: overlay.role, breaches: decision.breaches, reason: decision.reason, restored: restored?.id ?? null }, ctx.clock.now()));
      }
    }
  } catch (err) {
    ctx.log.warn('live overlay check failed', { error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) });
  }
  return out;
}
