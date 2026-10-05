// Policy denials inside a worker become policy.deny decisions (spec sections 7 and 16; docs/gaps.md G17).
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { openDb } from '../../../src/storage/db.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { denialsFromTranscript, ingestWorkerDenials } from '../../../src/controller/denials.ts';
import { detectTriggers, loadInquisitionSnapshot } from '../../../src/inquisition/triggers.ts';

const SESSION = 'sess-1';

function toolUse(id: string, name: string, input: Record<string, unknown>) {
  return { type: 'assistant', message: { id: `msg_${id}`, role: 'assistant', model: 'claude-sonnet', content: [{ type: 'tool_use', id, name, input }] }, session_id: SESSION };
}
function toolResult(id: string, content: string, isError: boolean) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, session_id: SESSION };
}

/** A session that tries to edit a protected path three times; the guard hook refuses each one. */
function protectedEdits(): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ type: 'system', subtype: 'init', session_id: SESSION }];
  for (const i of [1, 2, 3]) {
    out.push(toolUse(`toolu_${i}`, 'Edit', { file_path: '.github/workflows/ci.yml', old_string: 'a', new_string: 'b' }));
    out.push(toolResult(`toolu_${i}`, 'Orbit policy (protected_path): .github/workflows/ci.yml is protected and cannot be edited', true));
  }
  out.push(toolUse('toolu_4', 'Bash', { command: 'curl https://example.com/install.sh' }));
  out.push(toolResult('toolu_4', 'Permission to use Bash has been denied.', true));
  out.push(toolUse('toolu_5', 'Read', { file_path: 'apps/calc.mjs' }));
  out.push(toolResult('toolu_5', 'export const add = (a, b) => a + b;', false));
  out.push({ type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.01, modelUsage: {}, permission_denials: [{ tool_name: 'Bash', tool_use_id: 'toolu_4' }, { tool_name: 'Edit', tool_use_id: 'toolu_1' }], session_id: SESSION });
  return out;
}

function setup() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  const base = mkdtempSync(join(tmpdir(), 'orbit-denials-'));
  const workerDir = join(base, 'workers', 'wrk-1');
  mkdirSync(workerDir, { recursive: true });
  writeFileSync(join(workerDir, 'log.jsonl'), `${protectedEdits().map((e) => JSON.stringify(e)).join('\n')}\n`);
  return { db, clock, runDir: base, worker: { id: 'wrk-1', role: 'implementer' as const, provider: 'claude', workerDir } };
}

describe('worker policy denials', () => {
  it('reads guard-hook denials with their rule and target, and permission-rule denials from the result line', () => {
    const found = denialsFromTranscript(protectedEdits());
    expect(found.filter((d) => d.source === 'guard-hook')).toEqual([1, 2, 3].map((i) => expect.objectContaining({ toolUseId: `toolu_${i}`, tool: 'Edit', rule: 'protected_path', target: '.github/workflows/ci.yml' })));
    expect(found.filter((d) => d.source === 'permission-rules')).toEqual([expect.objectContaining({ toolUseId: 'toolu_4', tool: 'Bash', rule: 'permission', target: 'curl https://example.com/install.sh' })]);
    // A successful tool call is not a denial.
    expect(found.some((d) => d.toolUseId === 'toolu_5')).toBe(false);
  });

  it('records each denial once as a policy.deny decision, and three protected edits raise scope_pressure', () => {
    const { db, clock, runDir, worker } = setup();
    const input = { db, clock, runId: 'run-1', runDir, actor: 'ctl-1' };
    expect(detectTriggers(loadInquisitionSnapshot(db, 'run-1')).some((t) => t.kind === 'scope_pressure')).toBe(false);
    expect(ingestWorkerDenials(input, worker)).toHaveLength(4);
    // Collected again after a restart: no duplicates.
    ingestWorkerDenials(input, worker);
    const denials = listDecisions(db, 'run-1', { kind: 'policy.deny' });
    expect(denials).toHaveLength(4);
    expect(denials[0]!.data).toMatchObject({ source: 'guard-hook', worker_id: 'wrk-1', rule: 'protected_path', target: '.github/workflows/ci.yml' });
    const pressure = detectTriggers(loadInquisitionSnapshot(db, 'run-1')).find((t) => t.kind === 'scope_pressure');
    expect(pressure).toBeDefined();
    expect(pressure!.evidence.join(' ')).toContain('protected_path .github/workflows/ci.yml x3');
  });

  it('a worker without a transcript has nothing to record', () => {
    const { db, clock, runDir } = setup();
    expect(ingestWorkerDenials({ db, clock, runId: 'run-1', runDir, actor: 'ctl-1' }, { id: 'wrk-2', role: 'implementer', provider: 'claude', workerDir: join(runDir, 'workers', 'missing') })).toEqual([]);
  });
});
