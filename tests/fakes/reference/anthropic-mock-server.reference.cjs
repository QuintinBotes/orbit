// Minimal mock of the Anthropic Messages API for hook-contract probing. No real model calls.
const http = require('http');
const fs = require('fs');
const LOG = process.env.MOCK_LOG;
const WORK = process.env.WORK;
const port = +process.env.PORT;
let mainCount = 0; let sideCount = 0; const sideSteps = process.env.SIDE_STEPS ? JSON.parse(process.env.SIDE_STEPS) : null;
const steps = process.env.STEPS ? JSON.parse(process.env.STEPS) : [
  { tool: 'Bash', input: { command: 'echo orbit-probe', description: 'probe bash' } },
  { tool: 'Write', input: { file_path: WORK + '/written.txt', content: 'hello' } },
  { tool: 'Edit', input: { file_path: WORK + '/existing.txt', old_string: 'a', new_string: 'b', replace_all: false } },
  { tool: 'NotebookEdit', input: { notebook_path: WORK + '/nb.ipynb', cell_id: 'c1', new_source: 'print(1)', cell_type: 'code', edit_mode: 'replace' } },
  { text: 'first done' },
  { text: 'second done' },
];
function log(o) { fs.appendFileSync(LOG, JSON.stringify(o) + '\n'); }
function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_mock' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
function build(step, model) {
  const ev = [{ type: 'message_start', message: { id: 'msg_' + Date.now(), type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
  let stop;
  if (step.tool) {
    ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_mock' + mainCount, name: step.tool, input: {} } });
    ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
    stop = 'tool_use';
  } else {
    ev.push({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    ev.push({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } });
    stop = 'end_turn';
  }
  ev.push({ type: 'content_block_stop', index: 0 });
  ev.push({ type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 5 } });
  ev.push({ type: 'message_stop' });
  return ev;
}
http.createServer((req, res) => {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    let j = {}; try { j = JSON.parse(body || '{}'); } catch {}
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, {'content-type':'application/json'}); return res.end('{"input_tokens":10}'); }
    if (!req.url.startsWith('/v1/messages')) { log({ url: req.url, method: req.method, unhandled: true }); res.writeHead(404); return res.end('{}'); }
    const hasTools = Array.isArray(j.tools) && j.tools.length > 0;
    const msgs = j.messages || [];
    const last = msgs[msgs.length - 1];
    let step;
    if (hasTools) { step = steps[Math.min(mainCount, steps.length - 1)]; mainCount++; }
    else { step = sideSteps ? { text: sideSteps[Math.min(sideCount, sideSteps.length-1)] } : { text: '{"ok": true, "reason": "mock side request"}' }; sideCount++; if (process.env.SIDE_FULL) fs.appendFileSync(process.env.SIDE_FULL, JSON.stringify({model: j.model, system: j.system, messages: j.messages, output_config: j.output_config, tool_choice: j.tool_choice}) + '\n'); }
    if (hasTools && process.env.FULL) fs.appendFileSync(process.env.FULL, JSON.stringify(j.messages) + '\n');
    log({ url: req.url, model: j.model, hasTools, toolNames: hasTools ? j.tools.map(t => t.name) : undefined, stream: !!j.stream, nMsgs: msgs.length, lastUser: last, toolResults: msgs.flatMap(m => Array.isArray(m.content) ? m.content.filter(c => c.type === "tool_result") : []), roles: msgs.map(m=>m.role), reply: step });
    if (j.stream) return sse(res, build(step, j.model || 'mock'));
    const content = step.tool ? [{ type: 'tool_use', id: 'toolu_mock' + mainCount, name: step.tool, input: step.input }] : [{ type: 'text', text: step.text }];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'msg_x', type: 'message', role: 'assistant', model: j.model, content, stop_reason: step.tool ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
  });
}).listen(port, '127.0.0.1', () => console.log('mock listening ' + port));
