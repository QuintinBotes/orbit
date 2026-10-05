/**
 * Helpers for replay-evaluation tests: scenario files that differ by whether a
 * prompt overlay reached the worker's system prompt, so a fake provider
 * "does better" exactly when the candidate overlay is in force, and a
 * candidate overlay distilled from validated lessons.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { systemClock } from '../../../src/core/clock.ts';
import { createAdapter } from '../../../src/adapters/index.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities, ProviderEvent, TaskHandle, TaskResult, TaskSpec, UsageReport } from '../../../src/adapters/types.ts';
import { KnowledgeStore } from '../../../src/knowledge/store.ts';
import { createCandidateOverlay, distillOverlay } from '../../../src/knowledge/overlays.ts';
import type { PromptOverlay } from '../../../src/knowledge/types.ts';
import { ModelRegistry } from '../../../src/routing/registry.ts';
import type { ControllerDeps } from '../../../src/controller/context.ts';
import type { OrbitDb } from '../../../src/storage/db.ts';
import { ev, makeLesson } from '../../unit/knowledge/helpers.ts';
import { ORBIT_ROOT, type Lab } from '../controller/harness.ts';

/** Present in a role's system prompt exactly when an overlay for that role is in force. */
export const OVERLAY_MARKER = 'Orbit learned guidance for the implementer role.';

/** Routes each task to one of two scenario files by whether the overlay marker is in its system prompt. */
class VariantAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly inner: ProviderAdapter;
  private readonly paths: { withOverlay: string; without: string };

  constructor(inner: ProviderAdapter, paths: { withOverlay: string; without: string }) {
    this.inner = inner;
    this.id = inner.id;
    this.paths = paths;
  }

  discoverCapabilities(): Promise<ProviderCapabilities> {
    return this.inner.discoverCapabilities();
  }

  validateCredentials(): Promise<CredentialStatus> {
    return this.inner.validateCredentials();
  }

  startTask(spec: TaskSpec): Promise<TaskHandle> {
    const path = spec.systemPrompt.includes(OVERLAY_MARKER) ? this.paths.withOverlay : this.paths.without;
    return this.inner.startTask({ ...spec, env: { ...spec.env, ORBIT_FAKE_SCENARIO: path } });
  }

  streamEvents(handle: TaskHandle, fromOffset: number): Promise<{ events: ProviderEvent[]; nextOffset: number }> {
    return this.inner.streamEvents(handle, fromOffset);
  }

  cancelTask(handle: TaskHandle): Promise<void> {
    return this.inner.cancelTask(handle);
  }

  collectResult(handle: TaskHandle, spec: Pick<TaskSpec, 'outputSchema'>): Promise<TaskResult | null> {
    return this.inner.collectResult(handle, spec);
  }

  reportUsage(handle: TaskHandle): Promise<UsageReport> {
    return this.inner.reportUsage(handle);
  }

  reattach(workerDir: string): TaskHandle | null {
    const r = (this.inner as { reattach?: (d: string) => TaskHandle | null }).reattach;
    return typeof r === 'function' ? r.call(this.inner, workerDir) : null;
  }
}

export interface Variants {
  /** The scenario while the overlay is in force (the candidate arm). */
  withOverlay: object;
  /** The scenario without it (the baseline arm, and every live run). */
  without: object;
}

/** Write the two scenario files and return deps whose adapters pick between them. */
export function variantDeps(lab: Lab, variants: Variants): (db: OrbitDb) => Omit<ControllerDeps, 'ownerId'> {
  const paths = { withOverlay: join(lab.base, 'scenario.with-overlay.json'), without: join(lab.base, 'scenario.without-overlay.json') };
  writeFileSync(paths.withOverlay, JSON.stringify(variants.withOverlay));
  writeFileSync(paths.without, JSON.stringify(variants.without));
  const baseEnv = { PATH: process.env.PATH, HOME: process.env.HOME, ORBIT_FAKE_SCENARIO: paths.without, ORBIT_FAKE_ARGV_LOG: lab.argvLog };
  return (db) => {
    const adapters: Record<string, ProviderAdapter> = {};
    for (const [id, pc] of Object.entries(lab.config.providers)) {
      adapters[id] = new VariantAdapter(createAdapter(id, pc, { claudeTier: 'claude-sandbox', graceMs: 300, baseEnv, clock: systemClock }), paths);
    }
    return {
      db,
      clock: systemClock,
      adapters,
      registry: new ModelRegistry(db, systemClock),
      orbitHome: lab.orbitHome,
      hostEnv: process.env,
      orbitInstallDir: ORBIT_ROOT,
      timing: { checkPollMs: 50, killGraceMs: 300, ciAbsentGraceMs: 0, workerTimeoutMs: 120_000 },
    };
  };
}

/** Two validated lessons for the implementer in the repository's knowledge graph. */
export function seedLessons(lab: Pick<Lab, 'repo'>): void {
  mkdirSync(join(lab.repo, '.orbit'), { recursive: true });
  const store = KnowledgeStore.open(join(lab.repo, '.orbit', 'knowledge.sqlite'));
  try {
    for (const statement of ['Pin the clock in tests that format dates.', 'Prefer table-driven tests for every parser.']) {
      store.upsertLesson(makeLesson({ statement, status: 'validated', evidence: [ev('r1'), ev('r2')], applicability: { roles: ['implementer'] } }));
    }
  } finally {
    store.close();
  }
}

/** The lessons above, distilled into a candidate overlay. */
export function seedCandidateOverlay(lab: Pick<Lab, 'repo'>): PromptOverlay {
  seedLessons(lab);
  const store = KnowledgeStore.open(join(lab.repo, '.orbit', 'knowledge.sqlite'));
  try {
    const lessons = store.listLessons({ statuses: ['validated'], roles: ['implementer'] });
    const stats = store.statsMany(lessons.map((l) => l.id));
    return createCandidateOverlay(store, distillOverlay('implementer', lessons.map((lesson) => ({ lesson, stats: stats.get(lesson.id)! }))), 'repo');
  } finally {
    store.close();
  }
}
