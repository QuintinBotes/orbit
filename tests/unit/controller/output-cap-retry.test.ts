/**
 * P29: a worker whose response exceeded its per-response output cap is retried once with the cap doubled
 * (bounded by a ceiling), with a recorded decision, instead of repeating the same failure until the run blocks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { latestAttempt, obtain, type ObtainOptions } from '../../../src/controller/steps/obtain.ts';
import { OUTPUT_CAP_CEILING, OUTPUT_CAP_DECISION_KIND, outputCapExceeded } from '../../../src/controller/workers.ts';
import { DEFAULT_OUTPUT_BUDGETS } from '../../../src/policy/config.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.2, costSource: 'reported' as const };
const result = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'succeeded', structured: { value: 1 }, text: null, error: null, exitCode: 0, usage, durationMs: 1, ...over });
const overflow = (cap: number): TaskResult =>
  result({ status: 'failed', structured: null, error: `API Error: Claude's response exceeded the ${cap} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.` });

/** Answers each worker by its purpose and how many times it was asked, and remembers every spec it was started with. */
function adapter(script: Record<string, TaskResult[]>, specs: TaskSpec[]): ProviderAdapter {
  const asked = new Map<string, number>();
  const a = {
    id: 'claude',
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      specs.push(spec);
      mkdirSync(spec.workerDir, { recursive: true });
      writeFileSync(join(spec.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(h: TaskHandle): Promise<TaskResult | null> {
      const purpose = lab.db.get<{ purpose: string }>('SELECT purpose FROM workers WHERE id = ?', h.workerId)?.purpose ?? '';
      const n = asked.get(purpose) ?? 0;
      asked.set(purpose, n + 1);
      const list = script[purpose] ?? script['*'] ?? [result()];
      return list[Math.min(n, list.length - 1)] ?? null;
    },
    async cancelTask(): Promise<void> {},
  };
  return a as unknown as ProviderAdapter;
}

function opts(over: Partial<ObtainOptions<number>> = {}): ObtainOptions<number> {
  return {
    base: 'plan',
    maxAttempts: 2,
    what: 'the planner',
    request: (purpose, attempt) => ({ role: 'planner', purpose, attempt, provider: 'claude', model: null, effort: null, cwd: lab.repo, readOnly: true, prompt: () => 'plan it' }),
    accept: (r) => (r.structured as { value: number }).value,
    ...over,
  };
}

async function settle(o: ObtainOptions<number>, max = 12) {
  let out = await obtain(lab.ctx(), o);
  for (let i = 0; i < max && !out.ok && /is running$/.test(out.step.waiting ?? ''); i++) out = await obtain(lab.ctx(), o);
  return out;
}

describe('outputCapExceeded', () => {
  it('reads the cap out of the exact error the Claude CLI reports', () => {
    expect(outputCapExceeded(overflow(4000).error)).toEqual({ cap: 4000 });
    expect(outputCapExceeded("API Error: Claude's response exceeded the 16,000 output token maximum.")).toEqual({ cap: 16000 });
    expect(outputCapExceeded('API Error: Claude\'s response exceeded the output token maximum')).toEqual({ cap: null });
  });
  it('says nothing for other failures', () => {
    expect(outputCapExceeded('API Error: 500')).toBeNull();
    expect(outputCapExceeded(null)).toBeNull();
  });
});

describe('output cap retry', () => {
  it('retries a planner that exceeded its output cap once with the cap doubled, and records the decision', async () => {
    const specs: TaskSpec[] = [];
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ 'plan#1': [overflow(4000)], 'plan#2': [result()] }, specs) } });
    const out = await settle(opts());
    expect(out).toMatchObject({ ok: true, attempt: 2 });
    expect(specs).toHaveLength(2);
    expect(specs[0]!.outputTokens).toBeUndefined();
    expect(specs[1]!.outputTokens).toBe(8000);
    const decisions = listDecisions(lab.db, lab.runId, { kind: OUTPUT_CAP_DECISION_KIND });
    expect(decisions).toHaveLength(1);
    expect(decisions[0]!.summary).toMatch(/planner/);
    expect(decisions[0]!.data).toMatchObject({ base: 'plan', role: 'planner', previous_cap: 4000, new_cap: 8000 });
  });

  it('does not raise twice: a second overflow under the doubled cap is an ordinary failure that blocks the run', async () => {
    const specs: TaskSpec[] = [];
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ 'plan#1': [overflow(4000)], 'plan#2': [overflow(8000)] }, specs) } });
    const out = await settle(opts());
    expect(out).toMatchObject({ ok: false, step: { done: true } });
    expect(getRun(lab.db, lab.runId).state).toBe('BLOCKED');
    expect(listDecisions(lab.db, lab.runId, { kind: OUTPUT_CAP_DECISION_KIND })).toHaveLength(1);
    expect(specs.map((s) => s.outputTokens)).toEqual([undefined, 8000]);
  });

  it('bounds the doubled cap by the ceiling and does not raise a cap that is already at it', async () => {
    const specs: TaskSpec[] = [];
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ 'plan#1': [overflow(OUTPUT_CAP_CEILING - 1000)], 'plan#2': [result()] }, specs) } });
    await settle(opts());
    expect(specs[1]!.outputTokens).toBe(OUTPUT_CAP_CEILING);

    lab.cleanup();
    const atCeiling: TaskSpec[] = [];
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ '*': [overflow(OUTPUT_CAP_CEILING)] }, atCeiling) } });
    const out = await settle(opts());
    expect(out).toMatchObject({ ok: false });
    expect(listDecisions(lab.db, lab.runId, { kind: OUTPUT_CAP_DECISION_KIND })).toEqual([]);
    expect(latestAttempt(lab.ctx(), 'plan')).toBe(2);
  });

  it('the raise survives a controller restart: a fresh context still starts the retry with the doubled cap', async () => {
    const specs: TaskSpec[] = [];
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ 'plan#1': [overflow(4000)], 'plan#2': [result()] }, specs) } });
    await obtain(lab.ctx(), opts());
    await obtain(lab.ctx(), opts());
    const out = await settle(opts());
    expect(out).toMatchObject({ ok: true, attempt: 2 });
    expect(specs.at(-1)!.outputTokens).toBe(8000);
  });

  it('other failures are not mistaken for an overflow', async () => {
    const specs: TaskSpec[] = [];
    lab = makeUnitLab({ path: ['PREFLIGHT'], adapters: { claude: adapter({ 'plan#1': [result({ status: 'failed', error: 'crashed' })], 'plan#2': [result()] }, specs) } });
    const out = await settle(opts());
    expect(out).toMatchObject({ ok: true, attempt: 2 });
    expect(specs.map((s) => s.outputTokens)).toEqual([undefined, undefined]);
    expect(listDecisions(lab.db, lab.runId, { kind: OUTPUT_CAP_DECISION_KIND })).toEqual([]);
  });
});

describe('default output budgets', () => {
  it('leave room for a realistic contract, file write or review, and a doubled cap stays under the ceiling', () => {
    // A planner contract for a multi-criterion UI goal, with extended thinking, needs more than 4000 (live demo 3 failed twice at it).
    expect(DEFAULT_OUTPUT_BUDGETS.planner).toBeGreaterThanOrEqual(12_000);
    expect(DEFAULT_OUTPUT_BUDGETS.implementer).toBeGreaterThanOrEqual(16_000);
    expect(DEFAULT_OUTPUT_BUDGETS.reviewer).toBeGreaterThanOrEqual(8_000);
    for (const [role, v] of Object.entries(DEFAULT_OUTPUT_BUDGETS)) {
      expect(v, role).toBeGreaterThanOrEqual(4_000);
      expect(v, role).toBeLessThanOrEqual(OUTPUT_CAP_CEILING);
    }
  });
});
