import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexDepth } from '../../../src/adapters/codex-events.ts';
import { buildFinalReport, renderMarkdown } from '../../../src/controller/report.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { claudeDepth, describeDepth, readReviewDepth, recordReviewDepth, REVIEW_DEPTH_KIND, type ReviewDepth } from '../../../src/controller/review-depth.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { recordReview } from '../../../src/review/store.ts';
import { TREE_A, candidateOf, dbFixture, ingested } from '../review/fixtures.ts';
import { makeUnitLab, type UnitLab } from './coverage-helpers.ts';

const dirs: string[] = [];
let lab: UnitLab | undefined;
afterEach(() => {
  lab?.cleanup();
  lab = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const jsonl = (rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;
const workerDirWith = (rows: unknown[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'orbit-depth-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'log.jsonl'), jsonl(rows));
  return dir;
};

const answerOnly = [
  { type: 'thread.started', thread_id: 't' },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: '{}' } },
  { type: 'turn.completed', usage: { input_tokens: 21242, cached_input_tokens: 0, output_tokens: 69, reasoning_output_tokens: 17 } },
];

describe('codexDepth', () => {
  it('counts no tool calls for an answer given from the prompt alone, and reads the reasoning tokens', () => {
    expect(codexDepth(answerOnly)).toEqual({ toolCalls: 0, reasoningTokens: 17 });
  });

  it('counts the commands that looked at the checkout, but not MCP calls, the answer, reasoning summaries or errors', () => {
    const events = [
      { type: 'item.completed', item: { type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'rg foo' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'sed -n 1,40p a.ts' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 's', tool: 't' } },
      { type: 'item.completed', item: { type: 'error', message: 'x' } },
      { type: 'item.started', item: { type: 'command_execution', command: 'not counted until it completes' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
      { type: 'turn.completed', usage: { output_tokens: 900, reasoning_output_tokens: 640 } },
    ];
    expect(codexDepth(events)).toEqual({ toolCalls: 2, reasoningTokens: 640 });
  });

  // The second 0.3.1 retest: a fresh reviewer asked to open the files looked for Read, Grep and Glob through MCP tool
  // discovery, found none, opened nothing and blocked the tree. Discovering tools is not inspecting the checkout.
  it('counts a session whose only tool calls were MCP tool discovery as having inspected nothing', () => {
    const discovery = [
      { type: 'item.completed', item: { type: 'agent_message', text: 'I will open the changed source.' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'codex', tool: 'list_tools', status: 'completed' } },
      { type: 'item.completed', item: { type: 'mcp_tool_call', server: 'codex', tool: 'list_tools', status: 'completed' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
      { type: 'turn.completed', usage: { output_tokens: 400, reasoning_output_tokens: 312 } },
    ];
    expect(codexDepth(discovery)).toEqual({ toolCalls: 0, reasoningTokens: 312 });
  });

  it('does not count a plan update or a reasoning-only turn as reading anything, as codexEvents does not', () => {
    const plan = [
      { type: 'item.started', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'Read the diff', completed: false }] } },
      { type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: '{}' } },
      { type: 'item.completed', item: { id: 'item_0', type: 'todo_list', items: [{ text: 'Read the diff', completed: false }] } },
      { type: 'turn.completed', usage: { output_tokens: 60, reasoning_output_tokens: 17 } },
    ];
    expect(codexDepth(plan)).toEqual({ toolCalls: 0, reasoningTokens: 17 });
    expect(describeDepth({ tool_calls: 0, reasoning_tokens: 17 })).toContain('NO TOOL CALLS');
  });

  it('does not count file changes or web searches as looking at the checkout', () => {
    const events = [
      { type: 'item.completed', item: { type: 'file_change', changes: [] } },
      { type: 'item.completed', item: { type: 'web_search', query: 'q' } },
    ];
    expect(codexDepth(events).toolCalls).toBe(0);
  });

  it('reports reasoning tokens as unknown, not zero, when the turn did not complete or the CLI does not say', () => {
    expect(codexDepth([{ type: 'item.completed', item: { type: 'agent_message', text: '{}' } }]).reasoningTokens).toBeNull();
    expect(codexDepth([{ type: 'turn.completed', usage: { output_tokens: 3 } }]).reasoningTokens).toBeNull();
  });
});

describe('claudeDepth', () => {
  it('counts each tool_use once, however often stream-json repeats its message, and reads the thinking tokens', () => {
    const use = (id: string, name: string) => ({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id, name, input: {} }] } });
    const events = [use('t1', 'Read'), use('t1', 'Read'), use('t2', 'Grep'), { type: 'result', usage: { output_tokens_details: { thinking_tokens: 714 } } }];
    expect(claudeDepth(events)).toEqual({ toolCalls: 2, reasoningTokens: 714 });
  });

  it('does not count the StructuredOutput tool_use, which is how a Claude worker delivers its answer', () => {
    const use = (id: string, name: string) => ({ type: 'assistant', message: { id: 'm', content: [{ type: 'tool_use', id, name, input: {} }] } });
    expect(claudeDepth([use('t1', 'Read'), use('t2', 'Read'), use('t3', 'StructuredOutput')])).toEqual({ toolCalls: 2, reasoningTokens: null });
    // A review that read no code and only answered is flagged, not credited with one call.
    const answerOnlyClaude = [use('t1', 'StructuredOutput'), { type: 'result', usage: { output_tokens_details: { thinking_tokens: 803 } } }];
    const depth = claudeDepth(answerOnlyClaude);
    expect(depth).toEqual({ toolCalls: 0, reasoningTokens: 803 });
    expect(describeDepth({ tool_calls: depth.toolCalls, reasoning_tokens: depth.reasoningTokens })).toContain('NO TOOL CALLS');
  });

  it('is zero tool calls and unknown reasoning for a session that only answered', () => {
    expect(claudeDepth([{ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }, { type: 'result' }])).toEqual({ toolCalls: 0, reasoningTokens: null });
  });
});

describe('readReviewDepth', () => {
  it('reads a Codex transcript, a Claude transcript, and leaves a missing or empty one unknown', () => {
    expect(readReviewDepth({ provider: 'codex', workerDir: workerDirWith(answerOnly) })).toEqual({ toolCalls: 0, reasoningTokens: 17 });
    const claude = workerDirWith([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read' }] } }]);
    expect(readReviewDepth({ provider: 'claude', workerDir: claude })).toEqual({ toolCalls: 1, reasoningTokens: null });
    const empty = mkdtempSync(join(tmpdir(), 'orbit-depth-'));
    dirs.push(empty);
    expect(readReviewDepth({ provider: 'codex', workerDir: empty })).toEqual({ toolCalls: null, reasoningTokens: null });
    expect(readReviewDepth({ provider: 'codex', workerDir: join(empty, 'missing') })).toEqual({ toolCalls: null, reasoningTokens: null });
  });

  it('chooses the parser by provider family: a Codex alias is read as Codex, a Claude alias as Claude, any other family stays unknown', () => {
    const codex = workerDirWith([
      { type: 'item.completed', item: { type: 'command_execution', command: 'rg foo' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'sed -n 1,40p a.ts' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
      { type: 'turn.completed', usage: { output_tokens: 900, reasoning_output_tokens: 640 } },
    ]);
    expect(readReviewDepth({ provider: 'codex-review', workerDir: codex })).toEqual({ toolCalls: 2, reasoningTokens: 640 });
    expect(readReviewDepth({ provider: 'codex_second', workerDir: codex })).toEqual({ toolCalls: 2, reasoningTokens: 640 });
    const claude = workerDirWith([{ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', name: 'Read' }] } }]);
    expect(readReviewDepth({ provider: 'claude-review', workerDir: claude })).toEqual({ toolCalls: 1, reasoningTokens: null });
    expect(readReviewDepth({ provider: 'claude_alt', workerDir: claude })).toEqual({ toolCalls: 1, reasoningTokens: null });
    // Not a known family: never parsed as Claude (which would count zero tool calls), so never flagged.
    expect(readReviewDepth({ provider: 'gemini', workerDir: codex })).toEqual({ toolCalls: null, reasoningTokens: null });
    expect(readReviewDepth({ provider: 'codexy', workerDir: codex })).toEqual({ toolCalls: null, reasoningTokens: null });
  });

  it('records the depth of a review by a Codex alias from its Codex transcript, without the no-tool-call flag', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const workerDir = workerDirWith([
      { type: 'item.completed', item: { type: 'command_execution', command: 'rg foo' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '{}' } },
      { type: 'turn.completed', usage: { output_tokens: 90, reasoning_output_tokens: 40 } },
    ]);
    recordReviewDepth(lab.ctx(), { id: 'wrk-2', provider: 'codex-review', model: 'gpt-6.1-sol', workerDir }, 'rev-wrk-2');
    const recorded = listDecisions(lab.db, lab.runId, { kind: REVIEW_DEPTH_KIND });
    expect(recorded[0]!.data).toMatchObject({ provider: 'codex-review', tool_calls: 1, reasoning_tokens: 40 });
    expect(recorded[0]!.summary).not.toContain('NO TOOL CALLS');
  });
});

describe('describeDepth', () => {
  it('says a review without tool calls in words, and unknown counts as unavailable', () => {
    expect(describeDepth({ tool_calls: 0, reasoning_tokens: 17 })).toBe('NO TOOL CALLS (judged from the packet alone), 17 reasoning tokens');
    expect(describeDepth({ tool_calls: 1, reasoning_tokens: 1204 })).toBe('1 tool call, 1204 reasoning tokens');
    expect(describeDepth({ tool_calls: null, reasoning_tokens: null })).toBe('tool calls unavailable, reasoning tokens unavailable');
  });
});

describe('recordReviewDepth', () => {
  it('records one review.depth decision per review session and keeps the first on a repeat', () => {
    lab = makeUnitLab({ path: ['PREFLIGHT'] });
    const workerDir = workerDirWith(answerOnly);
    const worker = { id: 'wrk-1', provider: 'codex', model: 'gpt-6.1-sol', workerDir };
    recordReviewDepth(lab.ctx(), worker, 'rev-wrk-1');
    rmSync(join(workerDir, 'log.jsonl'));
    recordReviewDepth(lab.ctx(), worker, 'rev-wrk-1');
    const recorded = listDecisions(lab.db, lab.runId, { kind: REVIEW_DEPTH_KIND });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.data).toMatchObject({ review_id: 'rev-wrk-1', worker_id: 'wrk-1', provider: 'codex', tool_calls: 0, reasoning_tokens: 17 });
    expect(recorded[0]!.summary).toContain('NO TOOL CALLS');
  });
});

describe('the final report shows review depth', () => {
  function reported(depth: Pick<ReviewDepth, 'tool_calls' | 'reasoning_tokens'> | null) {
    const fx = dbFixture();
    recordReview(
      fx.db,
      { id: 'rev-1', runId: 'run-1', candidateId: candidateOf(TREE_A), treeHash: TREE_A, round: 1, provider: 'codex', model: 'codex-alpha', workerId: null, verdict: 'APPROVE', packetSha256: null, findings: [ingested({ externalId: 'X-1', claim: 'Fine.' })] },
      fx.clock,
    );
    if (depth) {
      fx.db.run(
        'INSERT INTO decisions (id, run_id, kind, summary, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        'dec-depth-1',
        'run-1',
        REVIEW_DEPTH_KIND,
        'depth',
        JSON.stringify({ review_id: 'rev-1', worker_id: 'wrk-1', provider: 'codex', model: 'codex-alpha', ...depth }),
        1,
      );
    }
    return buildFinalReport(fx.db, getRun(fx.db, 'run-1'), { runDir: fx.runDir, clock: fx.clock });
  }

  it('adds tool calls and reasoning tokens to the review table, and flags a review that made no tool calls', () => {
    const r = reported({ tool_calls: 0, reasoning_tokens: 17 });
    expect(r.reviews[0]).toMatchObject({ id: 'rev-1', tool_calls: 0, reasoning_tokens: 17 });
    expect(renderMarkdown(r)).toContain('(1 finding(s)); NO TOOL CALLS (judged from the packet alone), 17 reasoning tokens');
    expect(r.residual_risks.some((x) => x.startsWith('review depth: codex/codex-alpha review rev-1 made no tool calls'))).toBe(true);
  });

  it('shows the counts of a review that looked at the code, without a flag', () => {
    const r = reported({ tool_calls: 6, reasoning_tokens: 1204 });
    expect(renderMarkdown(r)).toContain('(1 finding(s)); 6 tool calls, 1204 reasoning tokens');
    expect(r.residual_risks.some((x) => x.startsWith('review depth:'))).toBe(false);
  });

  it('leaves the table as it was for a run with no depth record', () => {
    const r = reported(null);
    expect(r.reviews[0]).not.toHaveProperty('tool_calls');
    expect(renderMarkdown(r)).toContain('(1 finding(s))\n');
  });
});
