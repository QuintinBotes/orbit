// The curator's output and turn bounds (e2e retest Nm6, P27 learning.failed). Live curators that had to retry their
// structured output ran out of turns (4 needed, 3 allowed) with 6500 output tokens over the session, ending
// learning.failed. The curator is sized like the other roles, gets the turns a structured-output retry needs, and a
// response that still overflows its cap is retried once with the cap doubled, as every other role is.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { DEFAULT_OUTPUT_BUDGETS } from '../../../src/policy/config.ts';
import { getDecision } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { runCurator, type CuratorHost } from '../../../src/controller/report.ts';
import { OUTPUT_CAP_DECISION_KIND } from '../../../src/controller/workers.ts';
import { initLedger, makeUnitLab, ORBIT_ROOT, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = { provider: 'claude', model: 'claude-haiku-x', inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.02, costSource: 'reported' as const };
const ok = (over: Partial<TaskResult> = {}): TaskResult => ({ status: 'succeeded', structured: { lessons: [], discarded: [] }, text: null, error: null, exitCode: 0, usage, durationMs: 4, ...over });
const overflow = (cap: number): TaskResult => ok({ status: 'failed', structured: null, error: `API Error: Claude's response exceeded the ${cap} output token maximum. To configure this behavior, set the CLAUDE_CODE_MAX_OUTPUT_TOKENS environment variable.`, exitCode: 1 });

function adapter(results: TaskResult[]): ProviderAdapter & { specs: TaskSpec[] } {
  const a = {
    id: 'claude',
    specs: [] as TaskSpec[],
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      a.specs.push(spec);
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(): Promise<TaskResult | null> {
      return results.shift() ?? ok();
    },
    async cancelTask(): Promise<void> {},
  };
  return a as unknown as ProviderAdapter & { specs: TaskSpec[] };
}

function host(a: ProviderAdapter, recorded: boolean): CuratorHost {
  const ctx = lab.ctx();
  return {
    deps: { adapters: { claude: a }, registry: lab.deps.registry, orbitInstallDir: lab.deps.orbitInstallDir, hostEnv: { PATH: process.env.PATH }, homeDir: join(lab.base, 'home2') },
    clock: lab.clock,
    snapshot: ctx.snapshot,
    policyPath: ctx.run.policyPath,
    policyHash: ctx.run.policyHash,
    runId: lab.runId,
    dir: join(ctx.runDir, 'learning'),
    budgetUsd: 0.25,
    ...(recorded ? { recorded: ctx } : {}),
  };
}

describe('curator output budget', () => {
  it('is sized like the other structured roles, in the defaults and in the init template', () => {
    expect(DEFAULT_OUTPUT_BUDGETS.curator).toBe(8000);
    const template = parse(readFileSync(join(ORBIT_ROOT, 'templates', 'config.yaml'), 'utf8')) as { routing: { output_budgets: Record<string, number> } };
    expect(template.routing.output_budgets.curator).toBe(8000);
  });

  it('gives the session enough turns for a tool call and two structured-output retries', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const a = adapter([ok()]);
    await runCurator(host(a, false), { prompt: 'p' }, null);
    expect(a.specs[0]!.maxTurns).toBeGreaterThanOrEqual(6);
  });

  it('a recorded curator whose response overflowed its cap is retried once with the cap doubled, and the raise is a decision', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    initLedger(lab);
    const a = adapter([overflow(8000), ok()]);
    const out = await runCurator(host(a, true), { prompt: 'p' }, null);
    expect(out.output).toEqual({ lessons: [], discarded: [] });
    expect(a.specs).toHaveLength(2);
    expect(a.specs[1]!.outputTokens).toBe(16000);
    expect(listWorkers(lab.db, { runId: lab.runId, role: 'curator' }).map((w) => w.resultStatus)).toEqual(['failed', 'succeeded']);
    expect(getDecision(lab.db, `dec-${lab.runId}-outcap-curate_1`)?.kind).toBe(OUTPUT_CAP_DECISION_KIND);
  });

  it('an unrecorded curator (learn ingest) is retried the same way, and a second overflow is not retried again', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const a = adapter([overflow(8000), overflow(16000)]);
    await expect(runCurator(host(a, false), { prompt: 'p' }, null)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
    expect(a.specs.map((s) => s.outputTokens)).toEqual([undefined, 16000]);
  });
});
