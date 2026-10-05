/**
 * Policy denials that happened inside a worker (spec sections 7 and 16): the
 * PreToolUse guard hook refusing an edit or command, and Claude Code's own
 * permission rules refusing a tool call. Neither reaches the controller as an
 * error, so they are read back from the worker's transcript when its result is
 * collected and recorded as `policy.deny` decisions with the rule and the
 * target. That feeds the scope_pressure trigger (inquisition/triggers) and the
 * report, the same way the controller's own scope inspection does.
 *
 * Transcript shapes (docs/interfaces/claude-code-plugin.md section 4 and the
 * stream-json transcript): a hook denial comes back as a `tool_result` with
 * `is_error` and the hook's reason, which the guard writes as
 * "Orbit policy (<rule>): <reason>"; the result line lists every refused call
 * in `permission_denials` ({ tool_name, tool_use_id }). A denial is recorded
 * once per tool call, keyed by the worker and the tool_use id.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { redact } from '../core/redact.ts';
import type { OrbitDb } from '../storage/db.ts';
import { recordDecision } from '../storage/decisions.ts';
import type { WorkerRecord } from '../storage/workers.ts';
import { readLogLines } from '../adapters/supervise.ts';
import { LOG_FILE } from '../adapters/shim.ts';

export interface WorkerDenial {
  toolUseId: string;
  tool: string;
  /** The policy rule the guard named, or `permission` for Claude Code's own permission rules. */
  rule: string;
  /** The path, command or URL the call targeted, when the transcript shows it. */
  target: string | null;
  reason: string | null;
  source: 'guard-hook' | 'permission-rules';
}

const GUARD_REASON = /Orbit policy \(([^)]+)\):\s*([\s\S]*)/;

/** The denials one Claude transcript records. Unknown shapes are skipped; nothing throws. */
export function denialsFromTranscript(events: readonly Record<string, unknown>[]): WorkerDenial[] {
  const uses = new Map<string, { name: string; input: Record<string, unknown> }>();
  const results = new Map<string, { text: string; isError: boolean }>();
  let listed: { tool_name: string; tool_use_id: string }[] = [];
  for (const e of events) {
    const message = isObject(e.message) ? e.message : null;
    const content = message && Array.isArray(message.content) ? (message.content as unknown[]) : [];
    if (e.type === 'assistant') {
      for (const b of content) {
        if (!isObject(b) || b.type !== 'tool_use' || typeof b.id !== 'string') continue;
        uses.set(b.id, { name: typeof b.name === 'string' ? b.name : 'unknown', input: isObject(b.input) ? b.input : {} });
      }
    } else if (e.type === 'user') {
      for (const b of content) {
        if (!isObject(b) || b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
        results.set(b.tool_use_id, { text: textOf(b.content), isError: b.is_error === true });
      }
    } else if (e.type === 'result' && Array.isArray(e.permission_denials)) {
      listed = (e.permission_denials as unknown[]).filter(isObject).map((d) => ({ tool_name: String(d.tool_name ?? ''), tool_use_id: String(d.tool_use_id ?? '') }));
    }
  }
  const out = new Map<string, WorkerDenial>();
  // Guard denials are visible in the tool result even when the session ended before writing a result line.
  for (const [id, r] of results) {
    if (!r.isError) continue;
    const m = GUARD_REASON.exec(r.text);
    if (!m) continue;
    const use = uses.get(id);
    out.set(id, { toolUseId: id, tool: use?.name ?? 'unknown', rule: m[1]!.trim(), target: targetOf(use?.input), reason: clip(m[2]!.trim()), source: 'guard-hook' });
  }
  for (const d of listed) {
    if (!d.tool_use_id || out.has(d.tool_use_id)) continue;
    const use = uses.get(d.tool_use_id);
    const r = results.get(d.tool_use_id);
    out.set(d.tool_use_id, { toolUseId: d.tool_use_id, tool: d.tool_name || use?.name || 'unknown', rule: 'permission', target: targetOf(use?.input), reason: r ? clip(r.text) : null, source: 'permission-rules' });
  }
  return [...out.values()];
}

export interface IngestInput {
  db: OrbitDb;
  clock: Clock;
  runId: string;
  runDir: string;
  actor: string;
}

/** Record a finished worker's in-session denials as `policy.deny` decisions, once each. Returns what was found. */
export function ingestWorkerDenials(input: IngestInput, w: Pick<WorkerRecord, 'id' | 'role' | 'provider' | 'workerDir'>): WorkerDenial[] {
  const path = join(w.workerDir, LOG_FILE);
  if (!existsSync(path)) return [];
  const found = denialsFromTranscript(readLogLines(path).events);
  for (const d of found) {
    recordDecision(
      input.db,
      input.runDir,
      {
        id: `dec-${input.runId}-deny-${w.id}-${d.toolUseId.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 200),
        runId: input.runId,
        kind: 'policy.deny',
        summary: `${w.role} ${w.id}: ${d.tool} denied by ${d.source === 'guard-hook' ? 'the guard hook' : 'the permission rules'} (${d.rule})${d.target ? ` on ${d.target}` : ''}`.slice(0, 1000),
        data: { source: d.source, worker_id: w.id, role: w.role, provider: w.provider, tool: d.tool, tool_use_id: d.toolUseId, rule: d.rule, target: d.target, reason: d.reason },
      },
      input.clock,
      { actor: input.actor },
    );
  }
  return found;
}

/** A command or URL as a denial records it (redacted, bounded), so a grant can be matched to exactly it. */
export function denialTarget(v: string): string {
  return clip(v, 300);
}

function targetOf(input: Record<string, unknown> | undefined): string | null {
  if (!input) return null;
  for (const k of ['file_path', 'notebook_path', 'path', 'command', 'url']) {
    const v = input[k];
    if (typeof v === 'string' && v.length > 0) return denialTarget(v);
  }
  return null;
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (isObject(c) && typeof c.text === 'string' ? c.text : '')).join('\n');
  return '';
}

function clip(s: string, max = 500): string {
  const r = redact(s);
  return r.length > max ? `${r.slice(0, max)}...` : r;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
