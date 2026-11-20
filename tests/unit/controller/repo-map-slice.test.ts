import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ProviderAdapter, TaskHandle, TaskResult, TaskSpec } from '../../../src/adapters/types.ts';
import { contractingStep } from '../../../src/controller/steps/contracting.ts';
import { estimateTokens } from '../../../src/knowledge/text.ts';
import type { OrbitConfig } from '../../../src/policy/types.ts';
import { PLANNER_OUTPUT } from '../../integration/controller/harness.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'acme', GIT_AUTHOR_EMAIL: 'dev@acme.test', GIT_COMMITTER_NAME: 'acme', GIT_COMMITTER_EMAIL: 'dev@acme.test' };

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const usage = { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.1, costSource: 'reported' as const };

/** A planner that records its prompt and answers with the harness plan. */
function planner(prompts: string[]): ProviderAdapter {
  return {
    id: 'claude',
    async startTask(spec: TaskSpec): Promise<TaskHandle> {
      prompts.push(spec.prompt);
      mkdirSync(spec.workerDir, { recursive: true });
      writeFileSync(join(spec.workerDir, 'pid.json'), JSON.stringify({ version: 1, shimPid: 2_000_000_000, shimStart: 'x', pgid: 2_000_000_000, childPid: null, childStart: null, sessionId: null, argvHash: 'h', startedAt: 1 }));
      return { provider: 'claude', workerId: spec.workerId, workerDir: spec.workerDir, pid: 2_000_000_000, pgid: 2_000_000_000, procStart: 'x', logPath: '', exitPath: '' };
    },
    async collectResult(): Promise<TaskResult | null> {
      return { status: 'succeeded', structured: PLANNER_OUTPUT, text: null, error: null, exitCode: 0, usage, durationMs: 1 };
    },
    async cancelTask(): Promise<void> {},
  } as unknown as ProviderAdapter;
}

const FILES: Record<string, string> = {
  'apps/calc/add.mjs': "import { check } from '../util/check.mjs';\nexport const add = (a, b) => check(a) + b;\n",
  'apps/calc/mul.mjs': 'export const mul = (a, b) => a * b;\n',
  'apps/util/check.mjs': 'export const check = (x) => x;\n',
  'apps/report/csv.mjs': 'export const csv = () => "";\n',
  'tests/calc/add.test.mjs': "import { add } from '../../apps/calc/add.mjs';\n",
};

/** The planner's prompt for a goal naming two modules, under a policy changed by `tweak`. */
async function plannerPrompt(tweak: (c: OrbitConfig) => void): Promise<string> {
  const prompts: string[] = [];
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING'], adapters: { claude: planner(prompts) }, tweak });
  for (const [rel, text] of Object.entries(FILES)) {
    mkdirSync(dirname(join(lab.repo, rel)), { recursive: true });
    writeFileSync(join(lab.repo, rel), text);
  }
  const git = (...args: string[]) => execFileSync('git', args, { cwd: lab.repo, env: GIT_ENV, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  lab.db.run('UPDATE runs SET goal = ?, base_revision = ?, worktree_path = ? WHERE id = ?', 'Add division to apps/calc and a total row to apps/report/csv.mjs.', git('rev-parse', 'HEAD'), lab.repo, lab.runId);
  lab.deps.registry.seed();
  for (const e of lab.deps.registry.list()) if (e.provider === 'claude') lab.deps.registry.markAvailability(e.modelId, 'claude-cli', true, 'test');
  await contractingStep(lab.ctx());
  expect(prompts).toHaveLength(1);
  return prompts[0]!;
}

describe("the planner's repository map slice (#175 US2)", () => {
  it('is off by default: the prompt has no map', async () => {
    const prompt = await plannerPrompt(() => {});
    expect(prompt).not.toContain('Repository map of tree');
  });

  it("when switched on, holds the named modules' files, imports and tests, in no more than the configured tokens", async () => {
    const prompt = await plannerPrompt((c) => {
      c.repo_map = { prompt_slice: true, prompt_slice_tokens: 200, prompt_slice_min_files: 0 };
    });
    const block = /~{4,}text untrusted\n(Repository map of tree[\s\S]*?)~{4,}/.exec(prompt)?.[1];
    expect(block).toBeDefined();
    expect(block).toContain('apps/calc/add.mjs (');
    expect(block).toContain('imports: apps/util/check.mjs');
    expect(block).toContain('tests: tests/calc/add.test.mjs');
    expect(block).toContain('apps/calc/mul.mjs (');
    expect(block).toContain('apps/report/csv.mjs (');
    expect(block).not.toContain('apps/util/check.mjs (');
    expect(estimateTokens(block!)).toBeLessThanOrEqual(200);
  });

  it('a repository under the size threshold gets no slice', async () => {
    const prompt = await plannerPrompt((c) => {
      c.repo_map = { prompt_slice: true, prompt_slice_tokens: 1500, prompt_slice_min_files: 500 };
    });
    expect(prompt).not.toContain('Repository map of tree');
  });
});
