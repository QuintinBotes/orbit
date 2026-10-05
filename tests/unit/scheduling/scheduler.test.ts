import { describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { isOrbitError } from '../../../src/core/errors.ts';
import { AgentScheduler, globsOverlap, pathsOverlap, type SchedulerConfig, type SystemProbe } from '../../../src/scheduling/scheduler.ts';
import type { WorkUnit } from '../../../src/scheduling/types.ts';

const MB = 1024 * 1024;

function config(patch: { parallel?: number; defaultParallelism?: number; cancelObsolete?: boolean } = {}): SchedulerConfig {
  return {
    agents: { default_parallelism: patch.defaultParallelism ?? 1, cancel_obsolete_workers: patch.cancelObsolete ?? true },
    scheduler: { hard_limits: { parallel_workers: patch.parallel ?? 4 } },
  };
}

function system(cores: number, freeMb: number): SystemProbe {
  return { availableParallelism: () => cores, freemem: () => freeMb * MB };
}

function scheduler(patch: Parameters<typeof config>[0] = {}, sys: SystemProbe = system(16, 64_000), clock = new ManualClock()) {
  return new AgentScheduler(config(patch), { system: sys, clock });
}

function unit(id: string, patch: Partial<WorkUnit> = {}): WorkUnit {
  return { id, role: 'implementer', writer: false, ownedPaths: [], dependsOn: [], revision: null, cancelWhen: [], budget: {}, ...patch };
}

function writer(id: string, ownedPaths: string[], patch: Partial<WorkUnit> = {}): WorkUnit {
  return unit(id, { writer: true, ownedPaths, ...patch });
}

describe('capacity', () => {
  it('takes the minimum of configured workers, cores less one, and memory', () => {
    expect(scheduler({ parallel: 4 }, system(16, 64_000)).capacity()).toMatchObject({ slots: 4, limited_by: ['parallel_workers'], parts: { parallel_workers: 4, cpu: 15 } });
    expect(scheduler({ parallel: 8 }, system(3, 64_000)).capacity()).toMatchObject({ slots: 2, limited_by: ['cpu'] });
    // (4096 - 1024 headroom) / 1024 per worker = 3
    expect(scheduler({ parallel: 8 }, system(16, 4096)).capacity()).toMatchObject({ slots: 3, limited_by: ['memory'], memory: { free_mb: 4096, per_worker_mb: 1024, headroom_mb: 1024 } });
  });

  it('never drops below one slot, so a run under memory pressure still progresses', () => {
    const c = scheduler({ parallel: 4 }, system(1, 512)).capacity();
    expect(c.slots).toBe(1);
    expect(c.parts.memory).toBe(0);
    expect(c.notes[0]).toMatch(/limited to one worker/);
  });

  it('rejects invalid configuration', () => {
    for (const bad of [config({ parallel: 0 }), config({ defaultParallelism: 0 }), config({ parallel: 1.5 })]) {
      let err: unknown;
      try {
        new AgentScheduler(bad, { system: system(4, 8000) });
      } catch (e) {
        err = e;
      }
      expect(isOrbitError(err, 'CONFIG_INVALID')).toBe(true);
    }
  });
});

describe('scenario 15: parallel work respects isolation and resource limits', () => {
  it('serializes writers whose owned paths overlap and runs disjoint writers together', () => {
    const s = scheduler({ parallel: 4 });
    const plan = s.plan(
      [writer('w-api', ['apps/api/**']), writer('w-api-export', ['apps/api/export/**']), writer('w-web', ['apps/web/**']), writer('w-tests', ['tests/reports/**'])],
      { parallelism: 4 },
    );
    expect(plan.start.map((u) => u.id)).toEqual(['w-api', 'w-web', 'w-tests']);
    expect(plan.deferred).toEqual([{ id: 'w-api-export', reason: 'owned paths overlap with writer w-api' }]);
  });

  it('respects capacity, counting units already running', () => {
    const s = scheduler({ parallel: 3 });
    const units = [unit('r0', { role: 'verifier', status: 'running' }), ...['r1', 'r2', 'r3', 'r4'].map((id) => unit(id, { role: 'reviewer' }))];
    const plan = s.plan(units, { parallelism: 10 });
    expect(plan.limit).toBe(3);
    expect(plan.running).toBe(1);
    expect(plan.start.map((u) => u.id)).toEqual(['r1', 'r2']);
    expect(plan.deferred.map((d) => d.id)).toEqual(['r3', 'r4']);
    expect(plan.deferred[0]?.reason).toMatch(/at capacity: 3 active of 3 \(limited by parallel_workers\)/);
  });

  it('defaults to one worker at a time and is bounded by resources even when more is requested', () => {
    expect(scheduler({ parallel: 4 }).plan([unit('a'), unit('b')]).start.map((u) => u.id)).toEqual(['a']);
    const lowCpu = scheduler({ parallel: 4 }, system(2, 64_000)).plan([unit('a'), unit('b')], { parallelism: 4 });
    expect(lowCpu.start).toHaveLength(1);
    expect(lowCpu.deferred[0]?.reason).toMatch(/limited by cpu/);
  });

  it('never lets a writer share a worktree, even with disjoint paths', () => {
    const s = scheduler({ parallel: 4 });
    const plan = s.plan(
      [writer('w1', ['src/a/**'], { worktree: '/wt/1', status: 'running' }), writer('w2', ['src/b/**'], { worktree: '/wt/1' }), unit('reader', { role: 'reviewer', worktree: '/wt/1' }), writer('w3', ['src/c/**'], { worktree: '/wt/3' })],
      { parallelism: 4 },
    );
    expect(plan.start.map((u) => u.id)).toEqual(['w3']);
    expect(plan.deferred.map((d) => d.reason)).toEqual([
      'worktree /wt/1 is in use by w1; writers never share a worktree',
      'worktree /wt/1 is in use by w1; writers never share a worktree',
    ]);
  });

  it('treats a writer without declared ownership as owning everything', () => {
    const s = scheduler({ parallel: 4 });
    const plan = s.plan([writer('w1', ['docs/**'], { status: 'running' }), writer('w2', []), unit('r1', { role: 'reviewer' })], { parallelism: 4 });
    expect(plan.start.map((u) => u.id)).toEqual(['r1']);
    expect(plan.deferred[0]).toEqual({ id: 'w2', reason: 'owned paths overlap with writer w1' });
  });
});

describe('dependencies, rate limits and admission', () => {
  it('starts a unit only after its dependencies are done', () => {
    const s = scheduler({ parallel: 4 });
    const plan = s.plan(
      [
        unit('plan', { role: 'planner', status: 'done' }),
        unit('impl', { dependsOn: ['plan'] }),
        unit('verify', { role: 'verifier', dependsOn: ['impl'] }),
        unit('ghost', { dependsOn: ['nope'] }),
        unit('after-fail', { dependsOn: ['broken'] }),
        unit('broken', { status: 'failed' }),
        unit('c1', { dependsOn: ['c2'] }),
        unit('c2', { dependsOn: ['c1'] }),
        unit('behind-cycle', { dependsOn: ['c1'] }),
      ],
      { parallelism: 4 },
    );
    expect(plan.start.map((u) => u.id)).toEqual(['impl']);
    expect(Object.fromEntries(plan.deferred.map((d) => [d.id, d.reason]))).toEqual({
      verify: 'waiting for impl',
      ghost: 'unknown dependency nope',
      'after-fail': 'dependency broken failed',
      c1: 'dependency cycle',
      c2: 'dependency cycle',
      'behind-cycle': 'dependency cycle',
    });
  });

  it('backs off a rate-limited provider exponentially and resumes after success', () => {
    const clock = new ManualClock();
    const s = new AgentScheduler(config({ parallel: 4 }), { system: system(16, 64_000), clock, backoff: { baseMs: 1000, maxMs: 5000 } });
    const units = [unit('c1', { provider: 'claude' }), unit('x1', { provider: 'codex', role: 'reviewer' }), unit('check', { role: 'check' })];
    expect(s.noteRateLimit('claude')).toEqual({ until: clock.now() + 1000, consecutive: 1 });
    let plan = s.plan(units, { parallelism: 4 });
    expect(plan.start.map((u) => u.id)).toEqual(['x1', 'check']);
    expect(plan.deferred[0]?.reason).toMatch(/^claude rate limited until /);
    expect(plan.capacity.backoff.claude?.consecutive).toBe(1);
    expect(s.noteRateLimit('claude').until).toBe(clock.now() + 2000);
    expect(s.noteRateLimit('claude').until).toBe(clock.now() + 4000);
    expect(s.noteRateLimit('claude').until).toBe(clock.now() + 5000);
    expect(s.noteRateLimit('claude', 60_000).until).toBe(clock.now() + 5000);
    clock.advance(5001);
    plan = s.plan(units, { parallelism: 4 });
    expect(plan.start.map((u) => u.id)).toEqual(['c1', 'x1', 'check']);
    expect(plan.capacity.backoff).toEqual({});
    s.noteRateLimit('claude', 10);
    s.noteSuccess('claude');
    expect(s.plan(units, { parallelism: 4 }).start).toHaveLength(3);
  });

  it('defers units the budget does not admit', () => {
    const s = scheduler({ parallel: 4 });
    const plan = s.plan([unit('cheap', { budget: { costUsd: 1 } }), unit('pricey', { budget: { costUsd: 50 } })], {
      parallelism: 4,
      admit: (u) => ((u.budget.costUsd ?? 0) > 10 ? { admitted: false, reasons: ['cost exceeds the remaining budget'] } : { admitted: true }),
    });
    expect(plan.start.map((u) => u.id)).toEqual(['cheap']);
    expect(plan.deferred).toEqual([{ id: 'pricey', reason: 'not admitted by budget: cost exceeds the remaining budget' }]);
  });

  it('rejects duplicate ids and invalid parallelism', () => {
    const s = scheduler();
    for (const fn of [() => s.plan([unit('a'), unit('a')]), () => s.plan([unit('a')], { parallelism: 0 })]) {
      let err: unknown;
      try {
        fn();
      } catch (e) {
        err = e;
      }
      expect(isOrbitError(err, 'SCHEMA_INVALID')).toBe(true);
    }
  });
});

describe('obsolete work', () => {
  it('cancels reviews and verifications of a stale revision and units whose dependency failed', () => {
    const s = scheduler();
    const units = [
      unit('review-old', { role: 'reviewer', revision: 'tree-1', status: 'running' }),
      unit('verify-old', { role: 'verifier', revision: 'tree-1' }),
      unit('review-new', { role: 'reviewer', revision: 'tree-2' }),
      unit('review-done', { role: 'reviewer', revision: 'tree-1', status: 'done' }),
      unit('impl-old', { role: 'implementer', revision: 'tree-1', writer: true, ownedPaths: ['src/**'] }),
      unit('impl-bound', { role: 'implementer', revision: 'tree-1', cancelWhen: ['revision-changed'] }),
      unit('broken', { status: 'failed' }),
      unit('needs-broken', { dependsOn: ['broken'], cancelWhen: ['dependency-failed'] }),
      unit('waits-broken', { dependsOn: ['broken'] }),
    ];
    const out = s.obsolete(units, 'tree-2');
    expect(out.map((o) => [o.unit.id, o.reason])).toEqual([
      ['review-old', 'stale revision tree-1; current revision is tree-2'],
      ['verify-old', 'stale revision tree-1; current revision is tree-2'],
      ['impl-bound', 'stale revision tree-1; current revision is tree-2'],
      ['needs-broken', 'dependency broken failed'],
    ]);
  });

  it('cancels nothing when policy disables cancellation of obsolete workers', () => {
    const s = scheduler({ cancelObsolete: false });
    expect(s.obsolete([unit('r', { role: 'reviewer', revision: 'old' })], 'new')).toEqual([]);
  });
});

describe('glob overlap', () => {
  const cases: [string, string, boolean][] = [
    ['src/**', 'src/a/b.ts', true],
    ['src/a/**', 'src/b/**', false],
    ['apps/api/**', 'apps/api/export/**', true],
    ['src/index.ts', 'src/*.css', false],
    ['src/index.ts', 'src/*.ts', true],
    ['src/*.ts', 'src/*.css', true], // conservative: both are globs at the same segment
    ['docs/readme.md', 'src/**', false],
    ['apps/web/**', 'apps/*/test/**', true],
    ['apps/web/**', 'apps/{api,cli}/**', false],
    ['{src/a,lib}/**', 'src/a/x.ts', true], // brace spanning a slash: prefix fallback
    ['{src/a,lib}/**', 'docs/x.md', true], // fallback is conservative
    ['!src/**', 'docs/**', true],
    ['../outside', 'x', true],
    ['./src/a.ts', 'src/a.ts', true],
    ['src/', 'src/a.ts', true],
    ['src', 'src/deep/file.ts', true],
    ['tests/reports/**', 'tests/report.ts', false],
    ['.github/**', '.*/**', true],
    ['', 'anything', true],
  ];
  it.each(cases)('%s vs %s -> %s', (a, b, expected) => {
    expect(globsOverlap(a, b)).toBe(expected);
    expect(globsOverlap(b, a)).toBe(expected);
  });

  it('treats empty ownership as everything', () => {
    expect(pathsOverlap([], ['docs/**'])).toBe(true);
    expect(pathsOverlap(['src/a/**', 'src/b/**'], ['src/c/**', 'docs/**'])).toBe(false);
    expect(pathsOverlap(['src/a/**', 'src/b/**'], ['src/c/**', 'src/b/x.ts'])).toBe(true);
  });
});

describe('browser capacity and context duplication (spec section 8; docs/gaps.md G14)', () => {
  it('allows one Playwright run per core pair, whatever the other slots allow', () => {
    const s = scheduler({ parallel: 8, defaultParallelism: 8 }, system(4, 64_000));
    expect(s.capacity().browser_slots).toBe(2);
    const plan = s.plan([unit('ui-1', { browser: true }), unit('ui-2', { browser: true }), unit('ui-3', { browser: true }), unit('plain')]);
    expect(plan.start.map((u) => u.id)).toEqual(['ui-1', 'ui-2', 'plain']);
    expect(plan.deferred).toEqual([{ id: 'ui-3', reason: 'browser capacity: 2 Playwright run(s) active of 2 (one per core pair)' }]);
    // A one-core machine still gets one browser.
    expect(scheduler({}, system(1, 64_000)).capacity().browser_slots).toBe(1);
  });

  it('charges a unit started beside another on the same revision for re-reading the shared context, and admits by it', () => {
    const s = scheduler({ parallel: 4, defaultParallelism: 4 });
    const seen: { id: string; committed: { id: string; cost: number | null | undefined }[] }[] = [];
    const admit = (u: WorkUnit, c: { committed: WorkUnit[] }) => {
      seen.push({ id: u.id, committed: c.committed.map((x) => ({ id: x.id, cost: x.budget.costUsd })) });
      const total = c.committed.reduce((n, x) => n + (x.budget.costUsd ?? 0), 0) + (u.budget.costUsd ?? 0);
      return { admitted: total <= 9, reasons: [`total ${total}`] };
    };
    const reviewers = [
      unit('review-security', { role: 'reviewer', revision: 'tree-1', cancelWhen: ['revision-changed'], budget: { costUsd: 4 } }),
      unit('review-ui', { role: 'reviewer', revision: 'tree-1', cancelWhen: ['revision-changed'], budget: { costUsd: 4 } }),
      unit('review-other', { role: 'reviewer', revision: 'tree-2', budget: { costUsd: 0.5 } }),
    ];
    const plan = s.plan(reviewers, { admit });
    expect(plan.start.map((u) => u.id)).toEqual(['review-security', 'review-ui']);
    expect(plan.context_duplication).toEqual([{ id: 'review-ui', shared_with: 'review-security', usd: 1 }]);
    expect(seen[1]!.committed).toEqual([{ id: 'review-security', cost: 4 }, { id: 'review-ui#context-duplication', cost: 1 }]);
    // 4 + 4 + 1 duplication + 0.5 = 9.5 > 9: the third unit no longer fits.
    expect(plan.deferred).toEqual([{ id: 'review-other', reason: 'not admitted by budget: total 9.5' }]);
    // Off: no duplication is charged.
    expect(s.plan(reviewers, { admit: () => ({ admitted: true }), contextDuplication: 0 }).context_duplication).toEqual([]);
  });

  it('a new revision makes both parallel reviewers obsolete', () => {
    const s = scheduler({ parallel: 4, defaultParallelism: 4 });
    const running = [unit('review-security', { role: 'reviewer', revision: 'tree-1', cancelWhen: ['revision-changed'], status: 'running' }), unit('review-ui', { role: 'reviewer', revision: 'tree-1', cancelWhen: ['revision-changed'], status: 'running' })];
    expect(s.obsolete(running, 'tree-2').map((o) => o.unit.id)).toEqual(['review-security', 'review-ui']);
    expect(s.obsolete(running, 'tree-1')).toEqual([]);
  });
});

describe('merge overhead (spec section 8; docs/gaps.md G14)', () => {
  it('charges a writer started beside another active writer for its later serial integration, and admits by it', () => {
    const s = scheduler({ parallel: 4, defaultParallelism: 4 });
    const seen: { id: string; committed: { id: string; cost: number | null | undefined }[] }[] = [];
    const admit = (u: WorkUnit, c: { committed: WorkUnit[] }) => {
      seen.push({ id: u.id, committed: c.committed.map((x) => ({ id: x.id, cost: x.budget.costUsd })) });
      const total = c.committed.reduce((n, x) => n + (x.budget.costUsd ?? 0), 0) + (u.budget.costUsd ?? 0);
      return { admitted: total <= 9, reasons: [`total ${total}`] };
    };
    const units = [writer('unit-a', ['apps/a/**'], { budget: { costUsd: 4 } }), writer('unit-b', ['apps/b/**'], { budget: { costUsd: 4 } }), writer('unit-c', ['apps/c/**'], { budget: { costUsd: 0.2 } })];
    const plan = s.plan(units, { admit, mergeOverhead: 0.25 });
    expect(plan.start.map((u) => u.id)).toEqual(['unit-a', 'unit-b']);
    expect(plan.merge_overhead).toEqual([{ id: 'unit-b', alongside: ['unit-a'], usd: 1 }]);
    expect(seen[1]!.committed).toEqual([{ id: 'unit-a', cost: 4 }, { id: 'unit-b#merge-overhead', cost: 1 }]);
    // 4 + 4 + 1 merge + 0.2 + its own merge with two writers (0.05) = 9.25 > 9: the third writer waits and runs later, serially.
    expect(plan.deferred).toEqual([{ id: 'unit-c', reason: 'not admitted by budget: total 9.25' }]);
    // The merge entry occupies no slot: with room, a third writer would start.
    expect(s.plan(units, { admit: () => ({ admitted: true }), mergeOverhead: 0.25 }).start).toHaveLength(3);
  });

  it('charges nothing to a writer alone, to readers, or when turned off', () => {
    const s = scheduler({ parallel: 4, defaultParallelism: 4 });
    expect(s.plan([writer('only', ['apps/**'])]).merge_overhead).toEqual([]);
    expect(s.plan([writer('w', ['apps/**']), unit('review', { role: 'reviewer' })]).merge_overhead).toEqual([]);
    expect(s.plan([writer('a', ['apps/a/**']), writer('b', ['apps/b/**'])], { mergeOverhead: 0 }).merge_overhead).toEqual([]);
    // Unknown estimates fall back to the role ceiling, like context duplication.
    const [m] = s.plan([writer('a', ['apps/a/**']), writer('b', ['apps/b/**'])]).merge_overhead;
    expect(m).toMatchObject({ id: 'b', alongside: ['a'] });
    expect(m!.usd).toBeGreaterThan(0);
  });
});
