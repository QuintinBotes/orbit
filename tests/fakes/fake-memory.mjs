#!/usr/bin/env node
// Stand-in for the memory plugin's `recall --orbit` command and its stdio MCP server (`mcp`). It is configured through
// files beside the working directory's parent (Orbit passes memory no test environment): <parent>/memory.mode is JSON
// {"recall": <mode>, "mcp": <mode>}, <parent>/memory.rows holds the lines `recall` prints, <parent>/memory.log gets one JSON
// line per call and <parent>/memory.pid the pid of a call that hangs. Modes: fail (exit 1), hang (never answer),
// ignore-term (never answer and ignore SIGTERM), big (answer with 2 MB and no newline), reply-exit (mcp: answer, then exit
// at once), env (log the environment's names).
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const [cmd, ...rest] = process.argv.slice(2);
const at = (name) => join(process.cwd(), '..', name);
const modes = existsSync(at('memory.mode')) ? JSON.parse(readFileSync(at('memory.mode'), 'utf8')) : {};
const mode = modes[cmd];
const log = (entry) => appendFileSync(at('memory.log'), `${JSON.stringify({ cwd: process.cwd(), ...entry })}\n`);
const park = () => {
  writeFileSync(at('memory.pid'), String(process.pid));
  if (mode === 'ignore-term') process.on('SIGTERM', () => {});
  setInterval(() => {}, 1000);
};

if (mode === 'fail') {
  log({ kind: 'failed', mode: cmd });
  process.exit(1);
}
if (cmd === 'recall') {
  log({ kind: 'recall', argv: rest, ...(mode === 'env' ? { env: Object.keys(process.env) } : {}) });
  if (mode === 'hang' || mode === 'ignore-term') park();
  else if (mode === 'big') process.stdout.write('x'.repeat(2_000_000));
  else process.stdout.write(existsSync(at('memory.rows')) ? readFileSync(at('memory.rows'), 'utf8') : '');
} else if (cmd === 'mcp') {
  if (mode === 'env') log({ kind: 'mcp-env', env: Object.keys(process.env) });
  createInterface({ input: process.stdin }).on('line', (line) => {
    const m = JSON.parse(line);
    if (m.id === undefined) return;
    if (m.method === 'initialize') return console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'memory', version: 'fake' } } }));
    if (m.method === 'tools/call') {
      log({ kind: 'tool', name: m.params.name, args: m.params.arguments });
      if (mode === 'hang' || mode === 'ignore-term') return park();
      if (mode === 'big') return void process.stdout.write('x'.repeat(2_000_000));
      const reply = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok' }] } });
      if (mode === 'reply-exit') return void (process.stdout.write(`${reply}\n`), process.exit(0));
      return console.log(reply);
    }
    console.log(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } }));
  });
} else process.exit(2);
