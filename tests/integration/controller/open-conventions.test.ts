// Issue #178, through the real controller loop with the fake providers: every worker prompt carries the repository's
// AGENTS.md, then CLAUDE.md, as fenced data and the run records which it read (FR-001); a finished lab run exports as
// OpenTelemetry traces whose worker spans carry model, tokens and cost under the pinned GenAI conventions (user story 2,
// scenario 1; FR-003), and its report is valid under the published, versioned run report schema (FR-002).
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../../../src/cli/cli.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { compileSchema } from '../../../src/core/schema.ts';
import { Controller } from '../../../src/controller/loop.ts';
import { getRun } from '../../../src/controller/run-store.ts';
import { GENAI_SEMCONV_VERSION, OTEL_SCHEMA_URL } from '../../../src/observability/otel.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import { baseScenario, implementMul, labDeps, makeLab, ORBIT_ROOT, startLabRun, writeScenario, type Lab } from './harness.ts';

const canStripTypes = Boolean((process as unknown as { features?: { typescript?: unknown } }).features?.typescript);

const labs: Lab[] = [];
afterEach(() => {
  for (const l of labs.splice(0)) l.close();
});

const AGENTS_MD = '# Agents\n\nRun the tests with `node tests/run.mjs`. ACME-AGENTS-RULE\n';
const CLAUDE_MD = '# Claude\n\nKeep functions pure. ACME-CLAUDE-RULE\n';
const GOAL = 'Add a mul function to the calculator, ACME-GOAL-TEXT.';

async function finishedRun(): Promise<{ l: Lab; runId: string }> {
  const l = makeLab({ files: { 'AGENTS.md': AGENTS_MD, 'CLAUDE.md': CLAUDE_MD } });
  labs.push(l);
  writeScenario(l, baseScenario({ implementer: [implementMul('*')] }));
  const run = startLabRun(l, GOAL);
  await new Controller({ mode: 'foreground', runId: run.id, deps: labDeps(l), tickIntervalMs: 20, leaseTtlMs: 30_000, graceMs: 300 }).start();
  const done = getRun(l.db(), run.id);
  expect(done.state, done.outcomeReason ?? '').toBe('SUCCEEDED');
  return { l, runId: run.id };
}

async function cli(l: Lab, argv: string[]) {
  const io = memoryIo();
  const code = await main(argv, { io, cwd: l.repo, homeDir: l.base, orbitHome: l.orbitHome, env: { ...process.env, ORBIT_HOME: l.orbitHome, HOME: l.base }, user: 'alice' });
  return { code, out: io.stdout, err: io.stderr };
}

/** Every prompt.md a worker was given, by its role line. */
function prompts(l: Lab): { role: string; text: string }[] {
  const found: { role: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'prompt.md') {
        const text = readFileSync(p, 'utf8');
        found.push({ role: /## Role\n\n(\w+)/.exec(text)?.[1] ?? 'unknown', text });
      }
    }
  };
  walk(l.base);
  return found;
}

type AnyValue = { stringValue?: string; intValue?: string; doubleValue?: number; boolValue?: boolean };
interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: { key: string; value: AnyValue }[];
  status: { code: number; message?: string };
}
interface Otlp {
  resourceSpans: { resource: { attributes: { key: string; value: AnyValue }[] }; schemaUrl: string; scopeSpans: { scope: { name: string; version: string }; schemaUrl: string; spans: OtlpSpan[] }[] }[];
}
const attr = (s: { attributes: { key: string; value: AnyValue }[] }, key: string): AnyValue | undefined => s.attributes.find((a) => a.key === key)?.value;

describe.skipIf(!canStripTypes)('controller: Orbit speaks the open conventions (issue #178)', () => {
  it('FR-001: every worker prompt carries AGENTS.md, then CLAUDE.md, as data, and the run records which it read', async () => {
    const { l, runId } = await finishedRun();
    const all = prompts(l);
    expect(new Set(all.map((p) => p.role))).toEqual(new Set(['planner', 'implementer', 'reviewer']));
    for (const p of all) {
      const at = p.text.indexOf('## Repository instructions');
      expect(at, p.role).toBeGreaterThan(-1);
      const section = p.text.slice(at);
      expect(section.indexOf('Untrusted data (AGENTS.md)'), p.role).toBeGreaterThan(-1);
      expect(section.indexOf('ACME-AGENTS-RULE'), p.role).toBeLessThan(section.indexOf('Untrusted data (CLAUDE.md)'));
      expect(section, p.role).toContain('ACME-CLAUDE-RULE');
    }
    const record = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', runId, 'repo-instructions.json'), 'utf8')) as { files: { path: string; sha256: string }[] };
    expect(record.files.map((f) => f.path)).toEqual(['AGENTS.md', 'CLAUDE.md']);
    const events = l.db().all<{ data_json: string }>("SELECT data_json FROM events WHERE run_id = ? AND type = 'repo.instructions-read'", runId);
    expect(events.map((e) => JSON.parse(e.data_json) as unknown)).toEqual([{ files: ['AGENTS.md', 'CLAUDE.md'], revision: getRun(l.db(), runId).baseRevision }]);
  }, 60_000);

  it('user story 2, scenario 1: a finished run exports spans for each worker with model, tokens and cost under the pinned GenAI conventions, and no prompt text', async () => {
    const { l, runId } = await finishedRun();
    const r = await cli(l, ['export', runId, '--otel']);
    expect(r.code, r.err).toBe(0);
    // One OTLP/JSON request per line: the form a collector's otlpjsonfile receiver reads.
    expect(r.out.endsWith('\n')).toBe(true);
    expect(r.out.trimEnd().split('\n')).toHaveLength(1);
    const otlp = JSON.parse(r.out) as Otlp;

    expect(GENAI_SEMCONV_VERSION).toBe('1.37.0');
    const rs = otlp.resourceSpans[0]!;
    expect(rs.schemaUrl).toBe(OTEL_SCHEMA_URL);
    expect(rs.scopeSpans[0]!.schemaUrl).toBe('https://opentelemetry.io/schemas/1.37.0');
    expect(attr(rs.resource, 'service.name')).toEqual({ stringValue: 'orbit' });
    const spans = rs.scopeSpans[0]!.spans;
    const root = spans.find((s) => s.parentSpanId === undefined)!;
    expect(root.name).toBe('orbit run');
    expect(attr(root, 'orbit.run.id')).toEqual({ stringValue: runId });
    expect(attr(root, 'orbit.run.state')).toEqual({ stringValue: 'SUCCEEDED' });

    const workers = listWorkers(l.db(), { runId });
    expect(workers.length).toBeGreaterThanOrEqual(3);
    for (const w of workers) {
      const span = spans.find((s) => attr(s, 'gen_ai.agent.id')?.stringValue === w.id);
      expect(span, w.id).toBeDefined();
      expect(span!.traceId).toBe(root.traceId);
      expect(span!.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span!.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span!.parentSpanId).toBe(root.spanId);
      expect(span!.name).toBe(`invoke_agent ${w.role}`);
      expect(span!.kind).toBe(3);
      expect(BigInt(span!.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(span!.startTimeUnixNano));
      expect(attr(span!, 'gen_ai.operation.name')).toEqual({ stringValue: 'invoke_agent' });
      expect(attr(span!, 'gen_ai.agent.name')).toEqual({ stringValue: w.role });
      expect(attr(span!, 'gen_ai.provider.name')).toEqual({ stringValue: w.provider === 'codex' ? 'openai' : 'anthropic' });
      expect(attr(span!, 'gen_ai.request.model')?.stringValue, w.id).toBe(w.model ?? undefined);
      const usage = l.db().get<{ input: number; output: number; cost: number | null }>('SELECT SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost FROM usage WHERE worker_id = ?', w.id)!;
      expect(usage.output, w.id).toBeGreaterThan(0);
      expect(Number(attr(span!, 'gen_ai.usage.output_tokens')?.intValue), w.id).toBe(usage.output);
      expect(Number(attr(span!, 'gen_ai.usage.input_tokens')?.intValue), w.id).toBeGreaterThanOrEqual(usage.input);
      // A cost no one measured is absent and says so; it is never written as 0.
      expect(attr(span!, 'orbit.cost_usd')?.doubleValue, w.id).toBe(usage.cost ?? undefined);
      expect(attr(span!, 'orbit.cost_source')?.stringValue, w.id).toMatch(usage.cost === null ? /^unavailable$/ : /^(reported|estimated)$/);
    }
    // The Claude workers report their cost (the fake says 0.0123 per session).
    expect(spans.filter((s) => (attr(s, 'orbit.cost_usd')?.doubleValue ?? 0) > 0).length).toBeGreaterThanOrEqual(2);
    // Edge case: no prompt or source text unless asked; the goal, the repository's instructions and the code stay out.
    for (const text of ['ACME-GOAL-TEXT', 'ACME-AGENTS-RULE', 'ACME-CLAUDE-RULE', 'export const add']) expect(r.out).not.toContain(text);
    expect(r.out).not.toMatch(/gen_ai\.(input|output)\.messages|gen_ai\.system_instructions/);

    const file = join(l.base, 'traces.jsonl');
    const w = await cli(l, ['export', runId, '--otel', '--out', file]);
    expect(w.code, w.err).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe(r.out);
    expect((await cli(l, ['export', runId])).err).toContain('--otel');
  }, 60_000);

  it('FR-002: the run report of a lab run is valid under the published, versioned run report schema', async () => {
    const { l, runId } = await finishedRun();
    const validate = compileSchema(join(ORBIT_ROOT, 'schemas', 'run-report.schema.json'));
    const saved = JSON.parse(readFileSync(join(l.repo, '.orbit', 'runs', runId, 'final.json'), 'utf8')) as { schema: string };
    expect(saved.schema).toBe('orbit.final/1');
    expect(validate(saved), JSON.stringify(validate.errors)).toBe(true);
    const r = await cli(l, ['report', runId, '--json', '--interim']);
    expect(r.code, r.err).toBe(0);
    expect(validate(JSON.parse(r.out)), JSON.stringify(validate.errors)).toBe(true);
  }, 60_000);
});
