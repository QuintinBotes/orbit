// The lab's ScenarioAdapter renders the shared scenario file before every task it starts. Tasks that start together
// (parallel review units, parallel writers) render it while a fake that has just started is reading it, so a reader
// must always find a whole scenario. A file emptied and then rewritten in place let the fake security reviewer of
// the parallel review test read it torn, exit 1 and be regenerated: three reviewer sessions instead of two (the
// v0.2.2 release gate).
import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderAdapter, TaskHandle, TaskSpec } from '../../../src/adapters/types.ts';
import { ScenarioAdapter } from './scenario-adapter.ts';

// What every fake does when it starts (tests/fakes/scenario.mjs, loadStep), in a loop until the stop file appears.
const READER = `
const { existsSync, readFileSync } = require('node:fs');
const [path, stop] = process.argv.slice(1);
let reads = 0, torn = 0;
process.stdout.write('ready\\n');
while (!existsSync(stop)) {
  reads++;
  try { JSON.parse(readFileSync(path, 'utf8')); } catch { torn++; }
}
process.stdout.write(JSON.stringify({ reads, torn }) + '\\n');
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('ScenarioAdapter', () => {
  it('a fake that reads the scenario while the next task renders it always reads a whole scenario', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-scenario-'));
    dirs.push(dir);
    const templatePath = join(dir, 'template.json');
    const scenarioPath = join(dir, 'scenario.json');
    const step = { sleepMs: 1_500, structured: { verdict: 'APPROVE', candidate_revision: '$CANDIDATE', findings: [], summary: 'x'.repeat(200) } };
    const template = JSON.stringify({ roles: { reviewer: Array.from({ length: 50 }, () => step) } });
    writeFileSync(templatePath, template);
    writeFileSync(scenarioPath, template);
    const inner = { id: 'stub', startTask: async (): Promise<TaskHandle> => ({}) as TaskHandle } as unknown as ProviderAdapter;
    const adapter = new ScenarioAdapter(inner, templatePath, scenarioPath);

    const stop = join(dir, 'stop');
    const reader = spawn(process.execPath, ['-e', READER, scenarioPath, stop], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    reader.stdout.on('data', (d: Buffer) => (out += d.toString()));
    const exited = new Promise<void>((resolve) => reader.once('exit', () => resolve()));
    await new Promise<void>((resolve) => reader.stdout.once('data', () => resolve()));

    const started = Date.now();
    let renders = 0;
    while (Date.now() - started < 1_500 || renders < 500) {
      await adapter.startTask({ role: 'reviewer', workerId: `wrk-${renders}`, env: {}, prompt: `- revision: ${'a'.repeat(40)}\n` } as unknown as TaskSpec);
      renders++;
    }
    writeFileSync(stop, '');
    await exited;
    const { reads, torn } = JSON.parse(out.trim().split('\n').at(-1)!) as { reads: number; torn: number };
    expect(reads, 'the reader overlapped the renders').toBeGreaterThan(100);
    expect(torn, `${torn} of ${reads} reads found the scenario emptied or half written (${renders} renders)`).toBe(0);
    // Nothing is left behind beside the scenario.
    expect(readdirSync(dir).sort()).toEqual(['scenario.json', 'stop', 'template.json']);
    expect(existsSync(scenarioPath)).toBe(true);
  }, 30_000);
});
