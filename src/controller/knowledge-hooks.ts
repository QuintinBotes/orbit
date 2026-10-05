/**
 * The learning layer as the controller sees it during a run (ADR 0002):
 * advisory lessons for a worker's prompt and the active role overlay. Both
 * are advisory text and grant nothing. Any failure here costs the worker its
 * advice, never the step: knowledge is opened, read and closed per call, and
 * every error is swallowed into a log line.
 */
import { join } from 'node:path';
import type { WorkerRole } from '../adapters/types.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { recordRetrieval, renderAdvisoryBlock, retrieve } from '../knowledge/retrieve.ts';
import type { RunContext } from './context.ts';

export function repoKnowledgePath(ctx: Pick<RunContext, 'run'>): string {
  return join(ctx.run.repoRoot, '.orbit', 'knowledge.sqlite');
}

export function globalKnowledgePath(ctx: Pick<RunContext, 'deps'>): string {
  return join(ctx.deps.orbitHome, 'knowledge.sqlite');
}

function withStore<T>(ctx: RunContext, fallback: T, fn: (store: KnowledgeStore) => T): T {
  if (!ctx.snapshot.config.knowledge?.enabled) return fallback;
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
    });
    recordRetrieval(store, { runId: ctx.run.id, workerId: input.workerId }, lessons);
    return renderAdvisoryBlock(lessons);
  });
}
