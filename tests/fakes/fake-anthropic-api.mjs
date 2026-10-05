// A fake Anthropic Messages API for running the REAL `claude` CLI with no
// model spend. Derived from the verified probes in tests/fakes/reference/
// (anthropic-mock-server, mock2): SSE streaming in the Messages API event
// shape, a fake key, and the CLI pointed at it with ANTHROPIC_BASE_URL.
//
// Main-loop requests (those that carry tools) consume the scripted steps in
// order; the last step repeats once the script is exhausted. Requests
// without tools are Claude Code's side calls (titles, summaries) and get a
// short neutral reply that never consumes a step.
//
// Step shapes:
//   { text: "..." }                               plain assistant text, end_turn
//   { tool: "Write", input: {...} }               one tool_use block
//   { structured: {...} }                         calls the structured-output tool the
//                                                 CLI offers when --json-schema is set
//   { status: 401, error: { type, message } }     HTTP error reply (401, 403, 529, ...)
//   { delayMs: 30000, ...step }                   wait before replying (cancellation tests)
//   { usage: { input, output, cacheRead, cacheWrite } } overrides token counts
//
// Usage from a test:
//   const api = await startFakeAnthropicApi({ steps: [...] });
//   env.ANTHROPIC_BASE_URL = api.url; ... api.requests; await api.close();
// Standalone: node fake-anthropic-api.mjs <steps.json> [port]
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Tool names Claude Code has used for the --json-schema tool; matched case-insensitively. */
const STRUCTURED_TOOL_PATTERN = /structured.?output/i;

export async function startFakeAnthropicApi(options = {}) {
  let steps = Array.isArray(options.steps) ? options.steps : [{ text: 'ok' }];
  let mainCount = 0;
  let msgCount = 0;
  const requests = [];
  const pending = new Set();

  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let j = {};
      try {
        j = JSON.parse(body || '{}');
      } catch {
        j = {};
      }
      const url = req.url ?? '';
      if (url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"input_tokens":10}');
        return;
      }
      if (!url.startsWith('/v1/messages')) {
        requests.push({ url, method: req.method, unhandled: true });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{"type":"error","error":{"type":"not_found_error","message":"not found"}}');
        return;
      }
      const tools = Array.isArray(j.tools) ? j.tools.map((t) => t.name) : [];
      const main = tools.length > 0;
      const messages = Array.isArray(j.messages) ? j.messages : [];
      const step = main ? steps[Math.min(mainCount, steps.length - 1)] ?? { text: 'ok' } : { text: 'side reply' };
      if (main) mainCount++;
      requests.push({
        url,
        main,
        model: j.model,
        tools,
        stream: Boolean(j.stream),
        nMessages: messages.length,
        toolResults: messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((c) => c && c.type === 'tool_result') : [])),
        apiKey: req.headers['x-api-key'] ? 'set' : 'unset',
        authorization: req.headers.authorization ? 'set' : 'unset',
        step: main ? mainCount - 1 : null,
      });
      const reply = () => {
        pending.delete(timer);
        if (res.destroyed) return;
        if (typeof step.status === 'number' && step.status >= 400) {
          res.writeHead(step.status, { 'content-type': 'application/json', 'request-id': `req_fake${step.status}` });
          res.end(JSON.stringify({ type: 'error', error: step.error ?? { type: errorType(step.status), message: `fake ${step.status}` } }));
          return;
        }
        const block = contentFor(step, tools, ++msgCount);
        const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, ...(step.usage ?? {}) };
        const model = j.model || 'claude-fake';
        if (j.stream) {
          sse(res, streamEvents(block, model, usage, msgCount));
        } else {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(message(block, model, usage, msgCount)));
        }
      };
      const timer = setTimeout(reply, Math.max(0, Number(step.delayMs) || 0));
      pending.add(timer);
    });
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    requests,
    mainRequests: () => requests.filter((r) => r.main),
    setSteps(next) {
      steps = next;
      mainCount = 0;
    },
    async close() {
      for (const t of pending) clearTimeout(t);
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function errorType(status) {
  if (status === 401) return 'authentication_error';
  if (status === 403) return 'permission_error';
  if (status === 429) return 'rate_limit_error';
  if (status === 529) return 'overloaded_error';
  return 'api_error';
}

function contentFor(step, tools, n) {
  if (step.structured !== undefined) {
    const name = tools.find((t) => STRUCTURED_TOOL_PATTERN.test(t));
    // Without the tool (no --json-schema) the object is sent as text, which
    // is what a model ignoring the schema would do.
    if (!name) return { type: 'text', text: JSON.stringify(step.structured) };
    return { type: 'tool_use', id: `toolu_fake${n}`, name, input: step.structured };
  }
  if (step.tool) return { type: 'tool_use', id: `toolu_fake${n}`, name: step.tool, input: step.input ?? {} };
  return { type: 'text', text: String(step.text ?? 'ok') };
}

function message(block, model, usage, n) {
  return {
    id: `msg_fake${n}`,
    type: 'message',
    role: 'assistant',
    model,
    content: [block],
    stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: apiUsage(usage, usage.output),
  };
}

function apiUsage(usage, output) {
  return {
    input_tokens: usage.input,
    output_tokens: output,
    cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite,
  };
}

function streamEvents(block, model, usage, n) {
  const start = block.type === 'tool_use' ? { ...block, input: {} } : { type: 'text', text: '' };
  const delta = block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } : { type: 'text_delta', text: block.text };
  return [
    { type: 'message_start', message: { id: `msg_fake${n}`, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: apiUsage(usage, 1) } },
    { type: 'content_block_start', index: 0, content_block: start },
    { type: 'content_block_delta', index: 0, delta },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: block.type === 'tool_use' ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output } },
    { type: 'message_stop' },
  ];
}

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': 'req_fake' });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const steps = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], 'utf8')) : undefined;
  const api = await startFakeAnthropicApi({ steps, port: process.argv[3] ? Number(process.argv[3]) : 0 });
  process.stdout.write(`${api.url}\n`);
}
