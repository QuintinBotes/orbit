import { availableParallelism, freemem } from 'node:os';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import picomatch from 'picomatch';
import type { Clock } from '../core/clock.ts';
import { systemClock } from '../core/clock.ts';
import { OrbitError } from '../core/errors.ts';
import type { OrbitConfig } from '../policy/types.ts';
import { ROLE_COST_CEILING_USD, type BudgetLedger } from './budget.ts';
import type { BudgetPhase, Capacity, ObsoleteUnit, SchedulePlan, WorkUnit, WorkUnitStatus } from './types.ts';

/**
 * Agent scheduling (spec section 8). Decides which units of work may start
 * now: within capacity (configured parallelism, CPU, memory, rate-limit
 * backoff), with dependencies satisfied, and with writers isolated (never a
 * shared worktree, and in parallel only when their owned paths are provably
 * disjoint). It also names work made obsolete by a newer revision.
 *
 * The scheduler only plans; the controller spawns, records the spawn, and
 * cancels. Backoff state is in memory: after a restart the first rate-limited
 * response simply re-enters backoff.
 */

export interface SchedulerConfig {
  agents: Pick<OrbitConfig['agents'], 'default_parallelism' | 'cancel_obsolete_workers'>;
  scheduler: { hard_limits: Pick<OrbitConfig['scheduler']['hard_limits'], 'parallel_workers'> };
}

export interface SystemProbe {
  availableParallelism(): number;
  /** Bytes. */
  freemem(): number;
}

export interface SchedulerOptions {
  system?: SystemProbe;
  clock?: Clock;
  /** Resident memory one worker is expected to need (CLI process, sandbox, checks it runs). */
  perWorkerMemoryMb?: number;
  /** Memory left for the controller, the OS and the user. */
  memoryHeadroomMb?: number;
  backoff?: { baseMs: number; maxMs: number };
}

export interface AdmitContext {
  /** Units already running plus units started earlier in this plan: admitted work not yet charged. */
  committed: WorkUnit[];
}

export interface PlanOptions {
  /** Concurrency the controller asks for; defaults to agents.default_parallelism. Never above capacity. */
  parallelism?: number;
  /** Admission hook, typically budgetAdmission(ledger). It must count `committed`, or parallel units are each admitted against the same budget. */
  admit?: (unit: WorkUnit, context: AdmitContext) => { admitted: boolean; reasons?: string[] };
  /**
   * Context-duplication cost: a unit started beside an active unit on the same revision reads the same context
   * again, which costs this fraction of its estimate (its role ceiling when unknown) on top. Default 0.25; 0 off.
   */
  contextDuplication?: number;
  /**
   * Merge-overhead cost: a writer started while another writer is active must later be integrated serially with
   * it (rebuild the candidate, re-run the invalidated evidence, and on a conflict redo the work serially), which
   * costs this fraction of its estimate (its role ceiling when unknown) on top. Default 0.15; 0 turns it off.
   */
  mergeOverhead?: number;
}

export const DEFAULT_CONTEXT_DUPLICATION = 0.25;
export const DEFAULT_MERGE_OVERHEAD = 0.15;

/**
 * The admission hook backed by the budget ledger. Each unit's budget is its
 * estimate (unknown: the role's conservative ceiling), and every running or
 * just-started unit is passed as committed spend. A check runs no model, so
 * its unknown cost is zero; its unknown wall time is the verifier ceiling,
 * since checks run as part of verification.
 */
export function budgetAdmission(ledger: Pick<BudgetLedger, 'admit'>, phase: BudgetPhase | ((unit: WorkUnit) => BudgetPhase) = 'work'): NonNullable<PlanOptions['admit']> {
  return (unit, { committed }) => {
    const role = unit.role === 'check' ? null : unit.role;
    const d = ledger.admit({
      estimatedCostUsd: unit.budget.costUsd ?? (role === null ? 0 : null),
      estimatedWallMs: unit.budget.wallMs ?? null,
      role: role ?? 'verifier',
      phase: typeof phase === 'function' ? phase(unit) : phase,
      committed: committed.map((c) => ({ estimatedCostUsd: c.budget.costUsd ?? null, role: c.role })),
    });
    return { admitted: d.admitted, reasons: d.reasons };
  };
}

const DEFAULT_PER_WORKER_MB = 1024;
const DEFAULT_HEADROOM_MB = 1024;
const DEFAULT_BACKOFF = { baseMs: 30_000, maxMs: 15 * 60_000 };
/** Readers of a candidate revision; a newer revision makes their result worthless. */
const REVISION_BOUND_ROLES = new Set(['verifier', 'reviewer', 'check']);

export class AgentScheduler {
  private readonly config: SchedulerConfig;
  private readonly system: SystemProbe;
  private readonly clock: Clock;
  private readonly perWorkerMb: number;
  private readonly headroomMb: number;
  private readonly backoffCfg: { baseMs: number; maxMs: number };
  private readonly backoff = new Map<string, { until: number; consecutive: number }>();

  constructor(config: SchedulerConfig, opts: SchedulerOptions = {}) {
    this.config = config;
    const pw = config.scheduler?.hard_limits?.parallel_workers;
    if (!Number.isInteger(pw) || pw < 1) throw new OrbitError('CONFIG_INVALID', 'scheduler.hard_limits.parallel_workers must be a positive integer');
    const dp = config.agents?.default_parallelism;
    if (!Number.isInteger(dp) || dp < 1) throw new OrbitError('CONFIG_INVALID', 'agents.default_parallelism must be a positive integer');
    this.system = opts.system ?? { availableParallelism, freemem };
    this.clock = opts.clock ?? systemClock;
    this.perWorkerMb = opts.perWorkerMemoryMb ?? DEFAULT_PER_WORKER_MB;
    this.headroomMb = opts.memoryHeadroomMb ?? DEFAULT_HEADROOM_MB;
    this.backoffCfg = opts.backoff ?? DEFAULT_BACKOFF;
    if (!(this.perWorkerMb > 0)) throw new OrbitError('CONFIG_INVALID', 'perWorkerMemoryMb must be positive');
  }

  capacity(): Capacity {
    const configured = this.config.scheduler.hard_limits.parallel_workers;
    const notes: string[] = [];
    // A probe that returns NaN would make every comparison against the limit
    // false and admit without bound, so an unreadable value counts as the
    // most conservative one.
    let cores = this.system.availableParallelism();
    if (!Number.isFinite(cores) || cores < 1) {
      notes.push(`could not read the core count (${String(cores)}); assuming one core`);
      cores = 1;
    }
    let freeBytes = this.system.freemem();
    if (!Number.isFinite(freeBytes) || freeBytes < 0) {
      notes.push(`could not read free memory (${String(freeBytes)}); assuming none is free`);
      freeBytes = 0;
    }
    // Workers mostly wait on model APIs, but the checks they trigger are CPU
    // bound; one core stays with the controller.
    const cpu = Math.max(1, Math.floor(cores) - 1);
    const freeMb = Math.floor(freeBytes / (1024 * 1024));
    const memory = Math.max(0, Math.floor((freeMb - this.headroomMb) / this.perWorkerMb));
    const parts = { parallel_workers: configured, cpu, memory };
    const raw = Math.min(configured, cpu, memory);
    const limitedBy = (Object.entries(parts) as [string, number][]).filter(([, v]) => v === raw).map(([k]) => k);
    // A run must always be able to progress with one worker. Free memory is
    // an underestimate on some systems (macOS counts cached pages as used),
    // so memory pressure narrows parallelism but never stops the run.
    const slots = Math.max(1, raw);
    if (raw < 1) notes.push(`free memory (${freeMb} MB) is below headroom plus one worker estimate; limited to one worker so the run can progress`);
    const now = this.clock.now();
    const backoff: Capacity['backoff'] = {};
    for (const [provider, b] of this.backoff) if (b.until > now) backoff[provider] = { ...b };
    // Browsers are CPU heavy: one Playwright run per core pair.
    const browserSlots = Math.max(1, Math.floor(Math.floor(cores) / 2));
    return {
      browser_slots: browserSlots,
      slots,
      default_parallelism: this.config.agents.default_parallelism,
      limited_by: limitedBy,
      parts,
      memory: { free_mb: freeMb, per_worker_mb: this.perWorkerMb, headroom_mb: this.headroomMb },
      backoff,
      notes,
    };
  }

  /** A provider answered with a rate limit: stop starting its workers until the backoff passes. */
  noteRateLimit(provider: string, retryAfterMs?: number): { until: number; consecutive: number } {
    const prev = this.backoff.get(provider);
    const consecutive = (prev?.consecutive ?? 0) + 1;
    const computed = Math.min(this.backoffCfg.maxMs, this.backoffCfg.baseMs * 2 ** (consecutive - 1));
    const delay = typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? Math.min(this.backoffCfg.maxMs, retryAfterMs) : computed;
    const entry = { until: this.clock.now() + delay, consecutive };
    this.backoff.set(provider, entry);
    return { ...entry };
  }

  noteSuccess(provider: string): void {
    this.backoff.delete(provider);
  }

  /**
   * Which pending units may start now, in the given order (callers order by
   * priority). Running units occupy slots, worktrees and owned paths.
   * Independence is enforced structurally: a unit is runnable only once its
   * dependencies are done, and two writers run together only with disjoint
   * ownership.
   */
  plan(units: readonly WorkUnit[], opts: PlanOptions = {}): SchedulePlan {
    const byId = indexUnits(units);
    const capacity = this.capacity();
    const requested = opts.parallelism ?? this.config.agents.default_parallelism;
    if (!Number.isInteger(requested) || requested < 1) throw new OrbitError('SCHEMA_INVALID', 'parallelism must be a positive integer');
    const limit = Math.min(capacity.slots, requested);
    const active: WorkUnit[] = units.filter((u) => status(u) === 'running');
    const cyclic = cyclicUnits(units, byId);
    const start: WorkUnit[] = [];
    const deferred: SchedulePlan['deferred'] = [];
    const now = this.clock.now();
    const worktrees = new WorktreeIndex();
    const fraction = opts.contextDuplication ?? DEFAULT_CONTEXT_DUPLICATION;
    if (!(Number.isFinite(fraction) && fraction >= 0)) throw new OrbitError('SCHEMA_INVALID', 'contextDuplication must be a non-negative number');
    const duplication: SchedulePlan['context_duplication'] = [];
    const mergeFraction = opts.mergeOverhead ?? DEFAULT_MERGE_OVERHEAD;
    if (!(Number.isFinite(mergeFraction) && mergeFraction >= 0)) throw new OrbitError('SCHEMA_INVALID', 'mergeOverhead must be a non-negative number');
    const merges: SchedulePlan['merge_overhead'] = [];

    for (const unit of units) {
      if (status(unit) !== 'pending') continue;
      const shared = fraction > 0 && unit.revision !== null ? active.find((a) => a.revision === unit.revision) : undefined;
      const extra = shared ? duplicationUnit(unit, fraction) : null;
      const writers = unit.writer && mergeFraction > 0 ? active.filter((a) => a.writer && !isDuplication(a)) : [];
      const merge = writers.length > 0 ? overheadUnit(unit, mergeFraction, MERGE_SUFFIX) : null;
      const charged = [...active, ...(extra ? [extra] : []), ...(merge ? [merge] : [])];
      const reason = this.blocker(unit, byId, cyclic, active, limit, now, capacity, worktrees) ?? admission(unit, opts.admit, charged);
      if (reason) {
        deferred.push({ id: unit.id, reason });
        continue;
      }
      if (shared && extra) duplication.push({ id: unit.id, shared_with: shared.id, usd: extra.budget.costUsd ?? 0 });
      if (merge) merges.push({ id: unit.id, alongside: writers.map((w) => w.id), usd: merge.budget.costUsd ?? 0 });
      active.push(unit);
      // The duplicated reading and the later merge stay committed for the rest of this plan, like the unit itself.
      if (extra) active.push(extra);
      if (merge) active.push(merge);
      start.push(unit);
    }
    return { start, deferred, limit, running: units.filter((u) => status(u) === 'running').length, capacity, context_duplication: duplication, merge_overhead: merges };
  }

  /**
   * Units to cancel because their result can no longer matter: reviews and
   * verifications of a stale revision, units that asked to be cancelled when
   * the revision changes, and units whose dependency failed.
   */
  obsolete(units: readonly WorkUnit[], currentRevision: string | null): ObsoleteUnit[] {
    if (!this.config.agents.cancel_obsolete_workers) return [];
    const byId = indexUnits(units);
    const out: ObsoleteUnit[] = [];
    for (const unit of units) {
      const st = status(unit);
      if (st !== 'pending' && st !== 'running') continue;
      const revisionBound = REVISION_BOUND_ROLES.has(unit.role) || unit.cancelWhen.includes('revision-changed');
      if (revisionBound && unit.revision !== null && currentRevision !== null && unit.revision !== currentRevision) {
        out.push({ unit, reason: `stale revision ${unit.revision}; current revision is ${currentRevision}` });
        continue;
      }
      if (unit.cancelWhen.includes('dependency-failed')) {
        const failed = unit.dependsOn.find((d) => {
          const s = byId.get(d);
          return s !== undefined && (status(s) === 'failed' || status(s) === 'cancelled');
        });
        if (failed) out.push({ unit, reason: `dependency ${failed} ${status(byId.get(failed) as WorkUnit)}` });
      }
    }
    return out;
  }

  private blocker(
    unit: WorkUnit,
    byId: Map<string, WorkUnit>,
    cyclic: Set<string>,
    active: WorkUnit[],
    limit: number,
    now: number,
    capacity: Capacity,
    worktrees: WorktreeIndex,
  ): string | null {
    if (cyclic.has(unit.id)) return 'dependency cycle';
    for (const d of unit.dependsOn) {
      const dep = byId.get(d);
      if (!dep) return `unknown dependency ${d}`;
      const st = status(dep);
      if (st === 'failed' || st === 'cancelled') return `dependency ${d} ${st}`;
      if (st !== 'done') return `waiting for ${d}`;
    }
    if (unit.provider) {
      const b = this.backoff.get(unit.provider);
      if (b && b.until > now) return `${unit.provider} rate limited until ${new Date(b.until).toISOString()}`;
    }
    const occupying = active.filter((a) => !isDuplication(a));
    if (occupying.length >= limit) {
      return `at capacity: ${occupying.length} active of ${limit} (limited by ${limit < capacity.slots ? 'requested parallelism' : capacity.limited_by.join(', ')})`;
    }
    if (unit.browser) {
      const browsers = occupying.filter((a) => a.browser === true).length;
      if (browsers >= capacity.browser_slots) return `browser capacity: ${browsers} Playwright run(s) active of ${capacity.browser_slots} (one per core pair)`;
    }
    for (const other of occupying) {
      if ((unit.writer || other.writer) && unit.worktree && other.worktree && worktrees.overlap(unit.worktree, other.worktree)) {
        return `worktree ${unit.worktree} is in use by ${other.id}${unit.worktree === other.worktree ? '' : ` (${other.worktree})`}; writers never share a worktree`;
      }
      if (unit.writer && other.writer && pathsOverlap(unit.ownedPaths, other.ownedPaths)) return `owned paths overlap with writer ${other.id}`;
    }
    return null;
  }
}

const DUPLICATION_SUFFIX = '#context-duplication';
const MERGE_SUFFIX = '#merge-overhead';

/** A committed-cost entry for re-reading a shared context; it occupies no slot. */
function duplicationUnit(unit: WorkUnit, fraction: number): WorkUnit {
  return overheadUnit(unit, fraction, DUPLICATION_SUFFIX);
}

/** A committed-cost entry (context duplication, merge overhead) worth `fraction` of the unit's estimate; it occupies no slot. */
function overheadUnit(unit: WorkUnit, fraction: number, suffix: string): WorkUnit {
  const role = unit.role === 'check' ? null : unit.role;
  const base = unit.budget.costUsd ?? (role === null ? 0 : ROLE_COST_CEILING_USD[role]);
  const usd = Math.round(base * fraction * 1e6) / 1e6;
  return { id: `${unit.id}${suffix}`, role: unit.role, writer: false, ownedPaths: [], dependsOn: [], revision: unit.revision, cancelWhen: [], budget: { costUsd: usd }, provider: null, worktree: null, status: 'running' };
}

/** A cost-only entry: it occupies no slot, worktree or ownership. */
function isDuplication(u: WorkUnit): boolean {
  return u.id.endsWith(DUPLICATION_SUFFIX) || u.id.endsWith(MERGE_SUFFIX);
}

function admission(unit: WorkUnit, admit: PlanOptions['admit'], active: readonly WorkUnit[]): string | null {
  if (!admit) return null;
  const r = admit(unit, { committed: [...active] });
  return r.admitted ? null : `not admitted by budget: ${(r.reasons ?? []).join('; ') || 'no reason given'}`;
}

/**
 * Worktree identity for the "writers never share a worktree" rule. Paths are
 * compared after resolving `.`/`..`, trailing slashes and symlinks (macOS
 * /tmp is /private/tmp), case-insensitively (the default macOS file system
 * is), and a worktree nested inside another counts as shared, since a writer
 * in the outer one can write into it. Errs towards "shared".
 */
class WorktreeIndex {
  private readonly cache = new Map<string, string>();

  overlap(a: string, b: string): boolean {
    const x = this.canonical(a);
    const y = this.canonical(b);
    return x === y || within(x, y) || within(y, x);
  }

  private canonical(p: string): string {
    let c = this.cache.get(p);
    if (c === undefined) {
      let abs = resolve(p);
      try {
        abs = realpathSync.native(abs);
      } catch {
        // Not created yet: the lexical form is all there is to compare.
      }
      c = abs.normalize('NFC').toLowerCase();
      this.cache.set(p, c);
    }
    return c;
  }
}

function within(child: string, parent: string): boolean {
  return child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
}

function status(u: WorkUnit): WorkUnitStatus {
  return u.status ?? 'pending';
}

function indexUnits(units: readonly WorkUnit[]): Map<string, WorkUnit> {
  const byId = new Map<string, WorkUnit>();
  for (const u of units) {
    if (byId.has(u.id)) throw new OrbitError('SCHEMA_INVALID', `duplicate work unit id ${u.id}`);
    byId.set(u.id, u);
  }
  return byId;
}

/** Units on or behind a dependency cycle can never start; they are reported rather than waited on. */
function cyclicUnits(units: readonly WorkUnit[], byId: Map<string, WorkUnit>): Set<string> {
  const state = new Map<string, 'visiting' | 'ok' | 'cyclic'>();
  const visit = (id: string): boolean => {
    const s = state.get(id);
    if (s === 'visiting' || s === 'cyclic') return true;
    if (s === 'ok') return false;
    state.set(id, 'visiting');
    let cyc = false;
    for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d) && visit(d)) cyc = true;
    state.set(id, cyc ? 'cyclic' : 'ok');
    return cyc;
  };
  for (const u of units) visit(u.id);
  return new Set([...state].filter(([, s]) => s === 'cyclic').map(([id]) => id));
}

// ---------------------------------------------------------------------------
// Conservative glob overlap: answers "could some path be owned by both?" and
// errs towards yes. A wrong yes serializes two writers; a wrong no would let
// them edit the same file.

/** True when any glob of `a` might match a path that some glob of `b` matches. Empty ownership means everything. */
export function pathsOverlap(a: readonly string[], b: readonly string[]): boolean {
  const left = a.length ? a : ['**'];
  const right = b.length ? b : ['**'];
  return left.some((x) => right.some((y) => globsOverlap(x, y)));
}

const GLOB_CHARS = /[*?[\]{}()!+@]/;

export function globsOverlap(x: string, y: string): boolean {
  const a = normalize(x);
  const b = normalize(y);
  if (a === null || b === null) return true;
  if (needsPrefixFallback(a) || needsPrefixFallback(b)) {
    const pa = staticPrefix(a);
    const pb = staticPrefix(b);
    return isSegmentPrefix(pa, pb) || isSegmentPrefix(pb, pa);
  }
  const sa = a.split('/');
  const sb = b.split('/');
  for (let i = 0; ; i++) {
    const ea = sa[i];
    const eb = sb[i];
    // One pattern ended: a literal owns everything beneath it, and a glob that
    // matched a directory name might too, so assume overlap.
    if (ea === undefined || eb === undefined) return true;
    if (ea === '**' || eb === '**') return true;
    const ga = GLOB_CHARS.test(ea);
    const gb = GLOB_CHARS.test(eb);
    if (!ga && !gb) {
      if (ea !== eb) return false;
      continue;
    }
    if (ga && gb) continue;
    const [glob, literal] = ga ? [ea, eb] : [eb, ea];
    if (!picomatch.isMatch(literal, glob, { dot: true, nocase: true })) return false;
  }
}

/**
 * null means "cannot reason about this pattern"; the caller then assumes
 * overlap. Two spellings of one file must compare equal, so `.` segments are
 * dropped, Unicode is put in one normal form (macOS file names may arrive
 * decomposed) and case is folded (the default macOS file system ignores it).
 */
function normalize(p: string): string | null {
  let s = p.trim().replace(/\\/g, '/').normalize('NFC').toLowerCase();
  if (!s || s.startsWith('!')) return null;
  // Ownership is repository-relative. An absolute or home-relative pattern
  // may name the same files as a relative one, which cannot be told here.
  if (s.startsWith('/') || s.startsWith('~') || /^[a-z]:/.test(s)) return null;
  const segs = s.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (segs.some((seg) => seg === '..')) return null;
  s = segs.join('/');
  return s || '**';
}

/** Braces spanning a slash and extglobs cannot be compared segment by segment. */
function needsPrefixFallback(p: string): boolean {
  if (/[!+@?*]\(/.test(p)) return true;
  let depth = 0;
  for (const ch of p) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '/' && depth > 0) return true;
  }
  return false;
}

function staticPrefix(p: string): string[] {
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (GLOB_CHARS.test(seg)) break;
    out.push(seg);
  }
  return out;
}

function isSegmentPrefix(prefix: string[], of: string[]): boolean {
  return prefix.length <= of.length && prefix.every((s, i) => s === of[i]);
}
