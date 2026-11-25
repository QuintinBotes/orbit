/**
 * The shared memory store as Orbit sees it (issue #233): one port with three calls. Recall reads lean rows through
 * the memory plugin's `recall --orbit` command; propose and feedback are its MCP tools, called over stdio. Orbit
 * writes only proposals and feedback, never an active item, and every call is bounded and best effort: the caller
 * records a failure and the run goes on without memory. Off unless `knowledge.shared_memory.enabled` is true.
 */
import { execFileSync, spawn } from 'node:child_process';

export interface SharedMemoryConfig {
  enabled: boolean;
  /** argv of the memory command, for example ["memory"] or ["node", "/path/to/memory.mjs"]; `recall` or `mcp` is appended. */
  command: string[];
}

export interface SharedRow {
  id: string;
  /** The lean row as memory printed it, still untrusted. */
  text: string;
}

export interface RecallAsk {
  paths: readonly string[];
  checkIds: readonly string[];
  fingerprints: readonly string[];
  maxTokens: number;
}

const TIMEOUT_MS = 10_000;
const MAX_ITEMS = 3;
const LIST_MAX = 20;

export function sharedMemoryOn(config: { shared_memory?: SharedMemoryConfig } | undefined): config is { shared_memory: SharedMemoryConfig } {
  const s = config?.shared_memory;
  return s?.enabled === true && s.command.length > 0;
}

/** Up to three rows that start with an item id, from the command's output. Throws when the command fails. */
export function recallShared(memory: SharedMemoryConfig, cwd: string, ask: RecallAsk): SharedRow[] {
  const flags = (flag: string, values: readonly string[]) => values.slice(0, LIST_MAX).flatMap((v) => [flag, v]);
  const context = [...flags('--path', ask.paths), ...flags('--check', ask.checkIds), ...flags('--fingerprint', ask.fingerprints)];
  // Memory refuses a call with no context, and a worker with nothing to match has nothing to recall.
  if (context.length === 0) return [];
  const [bin, ...head] = memory.command as [string, ...string[]];
  const out = execFileSync(bin, [...head, 'recall', '--orbit', ...context, '--max-tokens', String(ask.maxTokens)], { cwd, encoding: 'utf8', timeout: TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 1 << 20 });
  const rows: SharedRow[] = [];
  for (const line of out.split(/\r?\n/)) {
    const id = /^\[([^\]\s]{1,80})\]/.exec(line.trim())?.[1];
    if (id && !rows.some((r) => r.id === id)) rows.push({ id, text: line.trim() });
    if (rows.length === MAX_ITEMS) break;
  }
  return rows;
}

/** One tool call to memory's MCP server over stdio. Resolves with its text, rejects on a refusal, a failure or a timeout. */
export function callMemoryTool(memory: SharedMemoryConfig, cwd: string, name: 'memory_propose' | 'memory_feedback', args: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    const [bin, ...head] = memory.command as [string, ...string[]];
    const child = spawn(bin, [...head, 'mcp'], { cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    const timer = setTimeout(() => finish(new Error('memory timed out')), TIMEOUT_MS);
    function finish(err: Error | null, text = ''): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(text);
    }
    const send = (m: object): void => void child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    child.on('error', (e) => finish(e));
    child.stdin.on('error', (e) => finish(e));
    child.on('exit', (code) => finish(new Error(`memory exited with ${code}`)));
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString('utf8');
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        let m: { id?: number; error?: { message?: string }; result?: { isError?: boolean; content?: { text?: string }[] } };
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: 'notifications/initialized' });
          send({ id: 2, method: 'tools/call', params: { name, arguments: args } });
        } else if (m.id === 2) {
          const text = m.result?.content?.[0]?.text ?? '';
          finish(m.error || m.result?.isError ? new Error(m.error?.message ?? text.slice(0, 200)) : null, text);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'orbit', version: '1' } } });
  });
}
