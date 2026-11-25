#!/usr/bin/env node
// Stand-in for the memory plugin's `recall --orbit` command and its stdio MCP server (`mcp`).
// FAKE_MEMORY_LOG: file that gets one JSON line per call. FAKE_MEMORY_ROWS: file whose lines `recall` prints.
// FAKE_MEMORY_FAIL=1: every call fails, as an unavailable store would.
import { appendFileSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [mode, ...rest] = process.argv.slice(2);
const log = (entry) => process.env.FAKE_MEMORY_LOG && appendFileSync(process.env.FAKE_MEMORY_LOG, `${JSON.stringify({ cwd: process.cwd(), ...entry })}\n`);

if (process.env.FAKE_MEMORY_FAIL === '1') {
  log({ kind: 'failed', mode });
  process.exit(1);
}
if (mode === 'recall') {
  log({ kind: 'recall', argv: rest });
  process.stdout.write(process.env.FAKE_MEMORY_ROWS ? readFileSync(process.env.FAKE_MEMORY_ROWS, 'utf8') : '');
} else if (mode === 'mcp') {
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    if (m.method === 'initialize') return console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'memory', version: 'fake' } } }));
    if (m.method === 'tools/call') {
      log({ kind: 'tool', name: m.params.name, args: m.params.arguments });
      return console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } }));
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } }));
  });
} else process.exit(2);
