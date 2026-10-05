import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { FakeAdapter } from '../../../src/adapters/fake.ts';
import { outputBudgetInstruction } from '../../../src/adapters/prompt.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { DEFAULT_OUTPUT_BUDGETS } from '../../../src/policy/config.ts';
import type { TaskSpec } from '../../../src/adapters/types.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { FAKE_CLAUDE, FAKE_CODEX, IMPLEMENTER_OUTPUT, REVIEW_OUTPUT, implementerSpec, makeFixture, waitFor, writeScenario, type Fixture } from './helpers.ts';

// G28: role output budgets. The Claude adapter enforces the budget through
// CLAUDE_CODE_MAX_OUTPUT_TOKENS (Claude Code's per-request max_tokens, checked
// below against the real CLI); Codex has no verified output cap, so its budget
// is an instruction in the prompt plus a recorded limitation.
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;

const fixtures: Fixture[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) rmSync(f.base, { recursive: true, force: true });
});
function fixture(configYaml?: string): Fixture {
  const f = makeFixture(configYaml);
  fixtures.push(f);
  return f;
}

function fakeClaude(): FakeAdapter {
  return new FakeAdapter({ provider: 'claude', script: FAKE_CLAUDE, tier: 'claude-sandbox', graceMs: 300, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, ANTHROPIC_API_KEY: 'sk-ant-fake-000' } });
}

async function run(a: FakeAdapter, spec: TaskSpec) {
  const handle = await a.startTask(spec);
  return { handle, result: await waitFor(() => a.collectResult(handle, spec), 30_000) };
}

function envKeysOf(f: Fixture): string[] {
  return (JSON.parse(readFileSync(f.argvLog, 'utf8').trim().split('\n')[0]!) as { envKeys: string[] }).envKeys;
}

describe.skipIf(!canStripTypes)('output budgets through the Claude adapter (fake CLI)', () => {
  it('gives the implementer the table default, sets the cap variable, tells the model, and records the budget on the usage report', async () => {
    const f = fixture();
    writeScenario(f, { roles: { implementer: [{ structured: IMPLEMENTER_OUTPUT }] } });
    const { handle, result } = await run(fakeClaude(), implementerSpec(f));
    expect(result.status).toBe('succeeded');
    expect(envKeysOf(f)).toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).toBe(`Change apps/a.ts.\n\n${outputBudgetInstruction(DEFAULT_OUTPUT_BUDGETS.implementer)}\n`);
    expect(result.usage.outputBudgetTokens).toBe(DEFAULT_OUTPUT_BUDGETS.implementer);
    expect((handle as { limitations?: string[] }).limitations?.join(' ') ?? '').not.toMatch(/output budget/i);
  });

  it('takes the budget from the policy snapshot routing.output_budgets, and an explicit TaskSpec value over both', async () => {
    const f = fixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["apps/**"]}\nrouting: {output_budgets: {implementer: 6000}}\n');
    writeScenario(f, { roles: { implementer: [{ structured: IMPLEMENTER_OUTPUT }] } });
    const a = fakeClaude();
    expect((await run(a, implementerSpec(f))).result.usage.outputBudgetTokens).toBe(6000);
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).toContain(outputBudgetInstruction(6000));

    const g = fixture();
    writeScenario(g, { roles: { implementer: [{ structured: IMPLEMENTER_OUTPUT }] } });
    expect((await run(a, implementerSpec(g, { outputTokens: 1500 }))).result.usage.outputBudgetTokens).toBe(1500);
  });

  it('runs without a cap or instruction when the budget is null', async () => {
    const f = fixture();
    writeScenario(f, { roles: { implementer: [{ structured: IMPLEMENTER_OUTPUT }] } });
    const { result } = await run(fakeClaude(), implementerSpec(f, { outputTokens: null }));
    expect(envKeysOf(f)).not.toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).toBe('Change apps/a.ts.');
    expect(result.usage.outputBudgetTokens).toBeNull();
  });

  it('refuses a budget that is not a positive integer', async () => {
    const f = fixture();
    await expect(fakeClaude().startTask(implementerSpec(f, { outputTokens: 0 }))).rejects.toThrow(/positive integer/);
  });

  it('measures time to first output from the worker log into the usage report and exit record', async () => {
    const f = fixture();
    writeScenario(f, { roles: { implementer: [{ sleepMs: 300, structured: IMPLEMENTER_OUTPUT }] } });
    const { result } = await run(fakeClaude(), implementerSpec(f));
    expect(result.usage.timeToFirstEventMs).toEqual(expect.any(Number));
    expect(result.usage.timeToFirstEventMs).toBeGreaterThanOrEqual(0);
  });
});

describe.skipIf(!canStripTypes)('output budgets through the Codex adapter (fake CLI)', () => {
  it('has no verified cap: the budget is an instruction, a recorded limitation and a recorded usage budget, and no Claude variable is set', async () => {
    const f = fixture();
    writeScenario(f, { roles: { reviewer: [{ structured: REVIEW_OUTPUT }] } });
    const a = new FakeAdapter({ provider: 'codex', script: FAKE_CODEX, graceMs: 300, baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME } });
    const spec: TaskSpec = { ...implementerSpec(f), role: 'reviewer', model: 'gpt-6-astra', effort: 'high', readOnly: true, outputSchema: MODEL_OUTPUT_SCHEMAS.review, prompt: 'Review candidate abc123.', systemPrompt: 'You are the reviewer.' };
    const { handle, result } = await run(a, spec);
    expect(result.usage.outputBudgetTokens).toBe(DEFAULT_OUTPUT_BUDGETS.reviewer);
    expect(readFileSync(join(f.workerDir, 'prompt.md'), 'utf8')).toContain(outputBudgetInstruction(DEFAULT_OUTPUT_BUDGETS.reviewer));
    expect((handle as { limitations?: string[] }).limitations?.join(' ')).toContain(`Output budget of ${DEFAULT_OUTPUT_BUDGETS.reviewer} tokens is an instruction only`);
    expect(envKeysOf(f)).not.toContain('CLAUDE_CODE_MAX_OUTPUT_TOKENS');
  });
});

// The verified mechanism, against the real CLI: the Messages API request body
// carries the cap. A forwarding proxy records max_tokens of each request.
describe.skipIf(!CLAUDE || !canStripTypes)('CLAUDE_CODE_MAX_OUTPUT_TOKENS reaches the request (real claude CLI, fake API)', () => {
  let api: Awaited<ReturnType<typeof startFakeAnthropicApi>>;
  let proxy: Server;
  let proxyUrl = '';
  let configDir: string;
  const seen: { max_tokens: number | null; tools: number }[] = [];

  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
    proxy = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        try {
          const j = JSON.parse(body.toString('utf8')) as { max_tokens?: number; tools?: unknown[] };
          if ((req.url ?? '').startsWith('/v1/messages') && Array.isArray(j.tools) && j.tools.length > 0) seen.push({ max_tokens: j.max_tokens ?? null, tools: j.tools.length });
        } catch {
          /* not JSON */
        }
        const target = new URL(req.url ?? '/', api.url);
        const up = httpRequest(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        });
        up.on('error', () => res.writeHead(502).end());
        up.end(body);
      });
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => proxy?.close(() => r()));
    await api?.close();
    rmSync(configDir, { recursive: true, force: true });
  });

  async function maxTokensFor(over: Partial<TaskSpec>): Promise<(number | null)[]> {
    seen.length = 0;
    api.setSteps([{ structured: IMPLEMENTER_OUTPUT }]);
    const f = fixture();
    const a = new ClaudeAdapter({
      command: [CLAUDE!],
      tier: 'claude-sandbox',
      graceMs: 2_000,
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: proxyUrl, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
    });
    const spec = implementerSpec(f, { env: {}, model: 'sonnet', ...over });
    const handle = await a.startTask(spec);
    await waitFor(() => a.collectResult(handle, spec), 60_000, 100);
    return seen.map((s) => s.max_tokens);
  }

  it('sends the role budget as the request max_tokens, and the model default when the budget is null', async () => {
    const budgeted = await maxTokensFor({});
    expect(budgeted.length).toBeGreaterThan(0);
    expect(new Set(budgeted)).toEqual(new Set([DEFAULT_OUTPUT_BUDGETS.implementer]));
    const custom = await maxTokensFor({ outputTokens: 2500 });
    expect(new Set(custom)).toEqual(new Set([2500]));
    const uncapped = await maxTokensFor({ outputTokens: null });
    expect(uncapped.length).toBeGreaterThan(0);
    expect(uncapped.every((n) => typeof n === 'number' && n > DEFAULT_OUTPUT_BUDGETS.implementer)).toBe(true);
  }, 240_000);
});
