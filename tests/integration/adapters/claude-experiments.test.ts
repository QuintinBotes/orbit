import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeAdapter } from '../../../src/adapters/claude.ts';
import { startFakeAnthropicApi } from '../../fakes/fake-anthropic-api.mjs';
import { MODEL_OUTPUT_SCHEMAS } from '../../../src/contract/model-outputs.ts';
import { implementerSpec, makeFixture, waitFor, type Fixture } from './helpers.ts';

// NM2, with the REAL claude CLI against a local fake Messages API (no model spend): a read-only diagnosis
// worker runs a test command, and still cannot write the worktree.
const which = spawnSync('/bin/sh', ['-c', 'command -v claude'], { encoding: 'utf8' });
const CLAUDE = which.status === 0 ? which.stdout.trim() : null;
const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

type Api = Awaited<ReturnType<typeof startFakeAnthropicApi>>;
let api: Api;
let configDir: string;
const fixtures: Fixture[] = [];

const DIAGNOSIS_OUT = { repair_brief: {}, fingerprint_comparison: {}, competing_hypotheses: [], chosen_hypothesis_id: 'H1' };

function toolResults(f: Fixture): string[] {
  return readFileSync(join(f.workerDir, 'log.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; message?: { content?: unknown } })
    .filter((e) => e.type === 'user' && Array.isArray(e.message?.content))
    .flatMap((e) => (e.message!.content as { type: string; content?: unknown }[]).filter((c) => c.type === 'tool_result').map((c) => JSON.stringify(c.content)));
}

describe.skipIf(!CLAUDE || !canStripTypes)('a diagnosis worker runs experiments (NM2; skipped when claude is not installed)', () => {
  beforeAll(async () => {
    api = await startFakeAnthropicApi({ steps: [{ text: 'ok' }] });
    configDir = mkdtempSync(join(tmpdir(), 'orbit-claude-cfg-'));
  });
  afterAll(async () => {
    await api?.close();
    rmSync(configDir, { recursive: true, force: true });
    for (const f of fixtures) rmSync(f.base, { recursive: true, force: true });
  });

  async function diagnose(experiments: boolean): Promise<{ f: Fixture; results: string[] }> {
    api.setSteps([
      { tool: 'Bash', input: { command: `node -e "console.log('experiment ran: ' + (require('fs').readFileSync('apps/a.ts','utf8').includes('a = 1') ? 'pass' : 'fail'))"`, description: 'run the experiment' } },
      { tool: 'Bash', input: { command: 'echo scratch > "$TMPDIR/scratch.txt" && cat "$TMPDIR/scratch.txt"', description: 'write scratch' } },
      { tool: 'Bash', input: { command: 'echo x > apps/exp.txt', description: 'write the worktree' } },
      { structured: DIAGNOSIS_OUT },
    ]);
    const f = makeFixture('version: 1\nmode: supervised\nscope: {allowed_paths: ["apps/**"]}\nnetwork: {allowed_hosts: []}\n');
    fixtures.push(f);
    const a = new ClaudeAdapter({
      command: [CLAUDE!],
      tier: 'claude-sandbox',
      graceMs: 2_000,
      baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'dumb', ANTHROPIC_BASE_URL: api.url, ANTHROPIC_API_KEY: 'sk-ant-fake-000', CLAUDE_CONFIG_DIR: configDir },
    });
    const spec = implementerSpec(f, { env: {}, model: 'sonnet', role: 'verifier', readOnly: true, outputSchema: MODEL_OUTPUT_SCHEMAS.diagnosis, ...(experiments ? { experiments: true } : {}) });
    const handle = await a.startTask(spec);
    await waitFor(() => a.collectResult(handle, spec), 60_000, 100);
    return { f, results: toolResults(f) };
  }

  it('runs a test command and writes scratch files, but cannot write the worktree', async () => {
    const { f, results } = await diagnose(true);
    expect(results[0]).toContain('experiment ran: pass');
    expect(results[1]).toContain('scratch');
    expect(existsSync(join(f.repo, 'apps', 'exp.txt'))).toBe(false);
    expect(readFileSync(join(f.repo, 'apps', 'a.ts'), 'utf8')).toBe('export const a = 1;\n');
  });

  it('without the experiment grant a read-only worker still cannot run Bash', async () => {
    const { results } = await diagnose(false);
    expect(results[0]).not.toContain('experiment ran');
  });
});
