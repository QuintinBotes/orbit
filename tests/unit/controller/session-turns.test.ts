// worker_turns_per_session (0.3.0 retest): the demo ui implementer wrk-257fa51d2bd7 "used 61 turns against a hard cap
// of 30" with no event. It was one session (one init, one result, no resume) launched with --max-turns 30, and it made
// 30 model requests, the last one its structured output: the CLI enforced the cap. Its result's num_turns counts the
// prompt and every tool result as a turn, and the session ran 60 tool calls, many of them in parallel, so it said 61.
// The cap Orbit reports must be the cap it enforces: the record counts model requests, and a session the cap stopped,
// or one that went past it, leaves a budget event.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TaskResult } from '../../../src/adapters/types.ts';
import { buildClaudeArgv } from '../../../src/adapters/claude.ts';
import { classifyClaudeTranscript } from '../../../src/adapters/claude-transcript.ts';
import { parseJsonLines, sessionIdFor } from '../../../src/adapters/supervise.ts';
import { accountWorker, ensureWorker } from '../../../src/controller/workers.ts';
import { buildFinalReport, renderMarkdown } from '../../../src/controller/report.ts';
import { planWorker, type WorkerRecord } from '../../../src/storage/workers.ts';
import { initLedger, makeUnitLab, okResult, OWNER, scriptedAdapter, validateModels, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const SCHEMA = { type: 'object', additionalProperties: false, required: ['answer'], properties: { answer: { type: 'string' } } };
const INIT = { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5-5', permissionMode: 'dontAsk', mcp_servers: [], tools: ['Read'] };

/** A stream-json transcript of `responses` model requests; each response calls `tools` tools in parallel, the last one only StructuredOutput. */
function transcript(responses: number, tools: number): { events: Record<string, unknown>[]; numTurns: number } {
  const lines: object[] = [INIT];
  let results = 0;
  for (let r = 1; r <= responses; r++) {
    const id = `msg_${r}`;
    const calls = r === responses ? 1 : tools;
    lines.push({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'thinking', thinking: '...' }] } });
    for (let t = 0; t < calls; t++) {
      // stream-json repeats the message once per content block.
      lines.push({ type: 'assistant', parent_tool_use_id: null, message: { id, content: [{ type: 'tool_use', id: `t${r}-${t}`, name: r === responses ? 'StructuredOutput' : 'Read', input: {} }] } });
    }
    for (let t = 0; t < calls; t++) {
      lines.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${r}-${t}` }] } });
      results++;
    }
  }
  // num_turns: the prompt plus every tool result.
  const numTurns = results + 1;
  lines.push({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', num_turns: numTurns, structured_output: { answer: 'ok' }, total_cost_usd: 1.33, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 60, outputTokens: 53976, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 1.33 } }, permission_denials: [], terminal_reason: 'completed' });
  return { events: parseJsonLines(lines.map((l) => JSON.stringify(l)).join('\n')).events, numTurns };
}

const classify = (events: Record<string, unknown>[]) =>
  classifyClaudeTranscript({ events, malformedTail: false, exit: { version: 1, code: 0, signal: null, timedOut: false, cancelled: false, aborted: null, escalation: [], error: null, startedAt: 1, endedAt: 2 }, outputSchema: SCHEMA });

function worker(id: string): WorkerRecord {
  return planWorker(lab.db, { id, runId: lab.runId, role: 'implementer', purpose: `implement:${id}`, provider: 'claude', model: null, workerDir: join(lab.base, 'w', id), cwd: lab.repo }, lab.clock, OWNER);
}

const turns = (over: Partial<TaskResult> & { numTurns?: number | null; modelRequests?: number | null; sessionId?: string }): TaskResult => ({ ...okResult({}), usage: { provider: 'claude', model: null, inputTokens: 1, outputTokens: 1, cacheReadTokens: null, cacheWriteTokens: null, costUsd: 0.01, costSource: 'reported' }, ...over });
const exhaustions = () => lab.db.all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'budget.exhausted'", lab.runId).map((e) => JSON.parse(e.data_json) as Record<string, unknown>);

function setup(): void {
  lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING'] });
  initLedger(lab);
}

describe('the turn count is what --max-turns limits', () => {
  it('a transcript counts its model requests, once per message id, whatever num_turns says', () => {
    const t = transcript(30, 3);
    expect(t.numTurns).toBe(89);
    const r = classify(t.events);
    expect(r).toMatchObject({ status: 'succeeded', numTurns: 89, modelRequests: 30 });
  });

  it('API error messages and a subagent\'s messages are not requests of the session, and a transcript without any message has no count', () => {
    const t = transcript(2, 1);
    const extra = [
      { type: 'assistant', error: 'overloaded', is_api_error_message: true, message: { id: 'msg_err', content: [] } },
      { type: 'assistant', parent_tool_use_id: 't1-0', message: { id: 'msg_sub', content: [{ type: 'text', text: 'sub' }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'no id' }] } },
    ];
    expect(classify([...t.events.slice(0, -1), ...extra, t.events.at(-1)!]).modelRequests).toBe(3);
    expect(classify([INIT, t.events.at(-1)!]).modelRequests).toBeNull();
  });

  it('the ui implementer: 30 requests and num_turns 61 is recorded as 30 against the cap of 30, with no event', () => {
    setup();
    accountWorker(lab.ctx(), worker('wrk-257fa51d2bd7'), turns({ numTurns: 61, modelRequests: 30, sessionId: 'sess-1' }));
    const ledger = lab.ctx().ledger!;
    expect(ledger.state('worker_turns_per_session')).toMatchObject({ used: 30, hard_cap: 30 });
    expect(exhaustions()).toEqual([]);
    const ctx = lab.ctx();
    const md = renderMarkdown(buildFinalReport(lab.db, ctx.run, { runDir: ctx.runDir, clock: lab.clock, snapshot: ctx.snapshot }));
    expect(md).toContain('- worker_turns_per_session: 30 model requests at most in one session; cap 30 per session, enforced by the Claude CLI (--max-turns)\n');
    expect(md).toContain('- worker_turns_per_session:wrk-257fa51d2bd7:sess-1: 30 model requests\n');
    expect(md).not.toContain('61');
  });

  it('a session the cap stopped leaves a budget event, once', () => {
    setup();
    const w = worker('wrk-capped');
    const r = turns({ status: 'max_turns', numTurns: 31, modelRequests: 30, sessionId: 'sess-2', structured: null });
    accountWorker(lab.ctx(), w, r);
    accountWorker(lab.ctx(), w, r);
    expect(exhaustions()).toEqual([{ counter: 'worker_turns_per_session', session: 'wrk-capped:sess-2', used: 30, allowance: 30, hard_cap: 30, limit: 'hard_cap', ended_by_cap: true }]);
  });

  it('a session that went past the cap is recorded as it ran, with a budget event saying the cap did not stop it', () => {
    setup();
    const w = worker('wrk-over');
    accountWorker(lab.ctx(), w, turns({ numTurns: 70, modelRequests: 31, sessionId: 'sess-3' }));
    expect(lab.ctx().ledger!.state('worker_turns_per_session').used).toBe(31);
    expect(exhaustions()).toEqual([{ counter: 'worker_turns_per_session', session: 'wrk-over:sess-3', used: 31, allowance: 30, hard_cap: 30, limit: 'hard_cap', ended_by_cap: false }]);
    // Report building accounts every worker again; the event is not repeated.
    const ctx = lab.ctx();
    buildFinalReport(lab.db, ctx.run, { runDir: ctx.runDir, clock: lab.clock, snapshot: ctx.snapshot });
    expect(exhaustions()).toHaveLength(1);
  });

  it('a stored result without a request count (before 0.3.1) still records the reported num_turns', () => {
    setup();
    accountWorker(lab.ctx(), worker('wrk-old'), turns({ numTurns: 7, sessionId: 'sess-4' }));
    expect(lab.ctx().ledger!.snapshot().num_turns_sessions).toEqual([expect.objectContaining({ counter: 'num_turns:wrk-old:sess-4', used: 7 })]);
  });

  it('enforcement: every worker session is started with --max-turns set to the per-session cap the ledger reports', async () => {
    setup();
    validateModels(lab);
    const adapter = scriptedAdapter(lab, () => null);
    lab.deps.adapters = { claude: adapter };
    await ensureWorker(lab.ctx(), { role: 'planner', purpose: 'plan:x#1', provider: 'claude', model: null, effort: null, cwd: lab.repo, readOnly: true, prompt: () => 'p' });
    const cap = lab.ctx().ledger!.maxTurnsPerSession();
    expect(adapter.specs[0]!.maxTurns).toBe(cap);
    const argv = buildClaudeArgv({ command: ['claude'], sessionId: 's', model: null, effort: null, maxTurns: adapter.specs[0]!.maxTurns, maxBudgetUsd: null, readOnly: true, tier: 'claude-sandbox', allowedHosts: [], settingsPath: '/s', systemPromptPath: '/p', outputSchema: SCHEMA, permissionPrompts: false, extraArgs: [] });
    expect(argv[argv.indexOf('--max-turns') + 1]).toBe(String(cap));
    // Never a resumed session: each launch is a new session under its own --session-id with the whole cap, and a
    // restarted worker gets a new id (so the count is per session, never cumulative across invocations).
    expect(argv.some((a) => ['--resume', '-r', '--continue', '-c', '--fork-session'].includes(a))).toBe(false);
    expect(argv[argv.indexOf('--session-id') + 1]).toBe('s');
    expect(sessionIdFor('wrk-257fa51d2bd7', 0)).not.toBe(sessionIdFor('wrk-257fa51d2bd7', 1));
  });
});

// A result stored by 0.3.0 has num_turns and no request count. Rebuilding the report of such a run (orbit report
// --interim, or a resumed 0.3.0 run) recorded num_turns 61 as "61 model requests" for the ui implementer and added a
// "went past the cap" event about the very session the request count cleared (verifier, fix/031-budget): its
// transcript shows 30 requests. 0.3.0 had already written num_turns into the session's record and the run's maximum.
describe('sessions recorded before 0.3.1', () => {
  const OLD_SESSION = 'wrk-257fa51d2bd7:s1';

  /** The records 0.3.0 left: the session's num_turns as its turns, and as the run's maximum. */
  function recordedBy030(session: string, numTurns: number): void {
    lab.db.run('INSERT INTO budget_counters (run_id, counter, used, allowance, hard_cap) VALUES (?, ?, ?, 30, 30)', lab.runId, `worker_turns_per_session:${session}`, numTurns);
    lab.db.run("UPDATE budget_counters SET used = MAX(used, ?) WHERE run_id = ? AND counter = 'worker_turns_per_session'", numTurns, lab.runId);
  }

  function writeLog(w: WorkerRecord, events: Record<string, unknown>[], attempt?: number): void {
    const dir = attempt === undefined ? w.workerDir : join(w.workerDir, 'attempts', String(attempt));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'log.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }

  const report = (): string => {
    const ctx = lab.ctx();
    return renderMarkdown(buildFinalReport(lab.db, ctx.run, { runDir: ctx.runDir, clock: lab.clock, snapshot: ctx.snapshot }));
  };

  it('are counted from their transcript, which replaces the num_turns 0.3.0 recorded, with no event', () => {
    setup();
    const t = transcript(30, 3);
    recordedBy030(OLD_SESSION, t.numTurns);
    const w = worker('wrk-257fa51d2bd7');
    writeLog(w, t.events);
    lab.db.run('UPDATE workers SET state = ?, result_status = ?, result_json = ? WHERE id = ?', 'SUCCEEDED', 'succeeded', JSON.stringify(turns({ numTurns: t.numTurns, sessionId: 's1' })), w.id);
    const md = report();
    const ledger = lab.ctx().ledger!;
    expect(ledger.state('worker_turns_per_session').used).toBe(30);
    expect(ledger.snapshot().sessions).toEqual([expect.objectContaining({ counter: `worker_turns_per_session:${OLD_SESSION}`, used: 30 })]);
    expect(exhaustions()).toEqual([]);
    expect(md).toContain('- worker_turns_per_session: 30 model requests at most in one session; cap 30 per session, enforced by the Claude CLI (--max-turns)\n');
    expect(md).toContain(`- worker_turns_per_session:${OLD_SESSION}: 30 model requests\n`);
    expect(md).not.toContain('89');
    // Rebuilt after the run's artifacts were pruned: the count from the transcript stands.
    rmSync(join(w.workerDir, 'log.jsonl'));
    report();
    expect(ledger.snapshot().sessions).toEqual([expect.objectContaining({ counter: `worker_turns_per_session:${OLD_SESSION}`, used: 30 })]);
    expect(ledger.snapshot().num_turns_sessions).toBeUndefined();
    expect(ledger.state('worker_turns_per_session').used).toBe(30);
  });

  it('find their transcript among the archived attempts by session id', () => {
    setup();
    const t = transcript(12, 2);
    const w = worker('wrk-257fa51d2bd7');
    writeLog(w, t.events, 1);
    writeLog(w, transcript(3, 1).events.map((e) => ('session_id' in e ? { ...e, session_id: 's2' } : e)));
    accountWorker(lab.ctx(), w, turns({ numTurns: t.numTurns, sessionId: 's1' }));
    expect(lab.ctx().ledger!.snapshot().sessions).toEqual([expect.objectContaining({ counter: `worker_turns_per_session:${OLD_SESSION}`, used: 12 })]);
  });

  it('without a transcript keep num_turns, labelled as num_turns: not the run\'s model requests, and never past the cap', () => {
    setup();
    recordedBy030(OLD_SESSION, 61);
    accountWorker(lab.ctx(), worker('wrk-new'), turns({ numTurns: 25, modelRequests: 10, sessionId: 's9' }));
    const w = worker('wrk-257fa51d2bd7');
    lab.db.run('UPDATE workers SET state = ?, result_status = ?, result_json = ? WHERE id = ?', 'SUCCEEDED', 'succeeded', JSON.stringify(turns({ numTurns: 61, sessionId: 's1' })), w.id);
    const md = report();
    const snap = lab.ctx().ledger!.snapshot();
    expect(snap.counters.find((c) => c.counter === 'worker_turns_per_session')?.used).toBe(10);
    expect(snap.sessions.map((s) => s.counter)).toEqual(['worker_turns_per_session:wrk-new:s9']);
    expect(snap.num_turns_sessions).toEqual([expect.objectContaining({ counter: `num_turns:${OLD_SESSION}`, used: 61 })]);
    expect(exhaustions()).toEqual([]);
    expect(md).toContain('- worker_turns_per_session: 10 model requests at most in one session; cap 30 per session, enforced by the Claude CLI (--max-turns)\n');
    expect(md).toContain(`- num_turns:${OLD_SESSION}: 61 num_turns (the CLI's count of the prompt and every tool result, not model requests: the session's transcript is gone)\n`);
    expect(md).not.toContain('61 model requests');
    // Accounted again, nothing changes.
    report();
    expect(lab.ctx().ledger!.snapshot()).toEqual(snap);
    expect(exhaustions()).toEqual([]);
  });
});
