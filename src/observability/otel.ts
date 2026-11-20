/**
 * `orbit export --otel` (issue #178, FR-003): a run as OpenTelemetry traces in OTLP/JSON, the encoding a collector's
 * OTLP receiver and its otlpjsonfile receiver read without any mapping. One trace per run: a root span for the run and
 * one `invoke_agent` span per worker under it, with the worker's model, tokens and cost.
 *
 * The attributes follow the GenAI semantic conventions of one pinned OpenTelemetry semantic conventions release,
 * GENAI_SEMCONV_VERSION, named in every schemaUrl. Those conventions are still in development, so a later release can
 * rename an attribute (1.37.0 itself renamed gen_ai.system to gen_ai.provider.name); moving to one is a deliberate
 * change of this constant and its tests. Cost has no GenAI attribute, so it is Orbit's own (`orbit.cost_usd`, absent
 * when no one measured it, with `orbit.cost_source` saying so).
 *
 * Built only from durable records (the run row, workers, usage), so the same run exports the same trace. It never
 * carries prompt or source text: no goal, no message, no worker error (which can quote provider output), only ids,
 * roles, models, counts, states and times.
 */
import type { OrbitDb } from '../storage/db.ts';
import type { RunRecord } from '../controller/run-store.ts';
import { orbitVersionOf } from '../controller/run-store.ts';
import { listWorkers, type WorkerRecord } from '../storage/workers.ts';
import { inputIncludesCacheRead } from '../routing/pricing.ts';
import { providerFamily } from '../policy/config.ts';
import { sha256 } from '../core/hash.ts';
import { ORBIT_VERSION } from '../cli/version.ts';

/** The OpenTelemetry semantic conventions release the export follows. */
export const GENAI_SEMCONV_VERSION = '1.37.0';
export const OTEL_SCHEMA_URL = `https://opentelemetry.io/schemas/${GENAI_SEMCONV_VERSION}`;

export type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number };
export interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}
export interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  /** 1 internal, 3 client. */
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpAttribute[];
  /** 0 unset, 2 error. */
  status: { code: number };
}
export interface OtlpTraces {
  resourceSpans: { resource: { attributes: OtlpAttribute[] }; schemaUrl: string; scopeSpans: { scope: { name: string; version: string }; schemaUrl: string; spans: OtlpSpan[] }[] }[];
}

/** gen_ai.provider.name for each provider family; another id passes through as itself. */
const GENAI_PROVIDER: Readonly<Record<string, string>> = { claude: 'anthropic', codex: 'openai', muse: 'meta' };

const str = (key: string, v: string): OtlpAttribute => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): OtlpAttribute => ({ key, value: { intValue: String(Math.round(v)) } });
const nanos = (ms: number): string => `${Math.round(ms)}000000`;
const id = (text: string, hexChars: number): string => sha256(text).replace(/^sha256:/, '').slice(0, hexChars);

interface WorkerUsage {
  input: number | null;
  output: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  /** Null unless every usage record of the worker has a cost: a partial sum would read as the whole. */
  cost: number | null;
  source: 'reported' | 'estimated' | 'unavailable';
}

/** Every prompt token of a worker, cached ones included, as gen_ai.usage.input_tokens counts them. */
function inputTokens(provider: string, u: WorkerUsage): number | null {
  if (u.input === null) return null;
  return u.input + (u.cacheWrite ?? 0) + (inputIncludesCacheRead(provider) ? 0 : (u.cacheRead ?? 0));
}

function workerSpan(w: WorkerRecord, u: WorkerUsage | undefined, traceId: string, parent: string, runEnd: number): OtlpSpan {
  const family = providerFamily(w.provider);
  const attributes: OtlpAttribute[] = [
    str('gen_ai.operation.name', 'invoke_agent'),
    str('gen_ai.provider.name', (family && GENAI_PROVIDER[family]) ?? w.provider),
    str('gen_ai.agent.name', w.role),
    str('gen_ai.agent.id', w.id),
  ];
  if (w.model) attributes.push(str('gen_ai.request.model', w.model));
  const input = u ? inputTokens(w.provider, u) : null;
  if (input !== null) attributes.push(int('gen_ai.usage.input_tokens', input));
  if (u?.output != null) attributes.push(int('gen_ai.usage.output_tokens', u.output));
  if (u?.cost != null) attributes.push({ key: 'orbit.cost_usd', value: { doubleValue: u.cost } });
  attributes.push(str('orbit.cost_source', u?.source ?? 'unavailable'));
  attributes.push(str('orbit.worker.state', w.state));
  if (w.attempt !== null) attributes.push(int('orbit.attempt', w.attempt));
  const failed = w.state === 'FAILED' || w.state === 'LOST';
  if (failed) attributes.push(str('error.type', w.resultStatus ?? w.state.toLowerCase()));
  const start = w.spawnedAt ?? w.createdAt;
  return {
    traceId,
    spanId: id(`span:${w.id}`, 16),
    parentSpanId: parent,
    name: `invoke_agent ${w.role}`,
    kind: 3,
    startTimeUnixNano: nanos(start),
    endTimeUnixNano: nanos(Math.max(start, w.endedAt ?? runEnd)),
    attributes,
    status: { code: failed ? 2 : 0 },
  };
}

export function exportRunOtel(db: OrbitDb, run: RunRecord, now: number): OtlpTraces {
  const traceId = id(`trace:${run.id}`, 32);
  const rootId = id(`span:${run.id}`, 16);
  const runEnd = run.endedAt ?? now;
  const rows = db.all<{ worker_id: string; input: number | null; output: number | null; cache_read: number | null; cache_write: number | null; cost: number | null; priced: number; estimated: number; n: number }>(
    `SELECT worker_id, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cache_read_tokens) AS cache_read, SUM(cache_write_tokens) AS cache_write,
            SUM(cost_usd) AS cost, SUM(cost_usd IS NOT NULL AND cost_source != 'unavailable') AS priced, SUM(cost_source = 'estimated') AS estimated, COUNT(*) AS n
       FROM usage WHERE run_id = ? AND worker_id IS NOT NULL GROUP BY worker_id`,
    run.id,
  );
  const usage = new Map<string, WorkerUsage>();
  for (const r of rows) {
    const complete = r.priced === r.n;
    usage.set(r.worker_id, { input: r.input, output: r.output, cacheRead: r.cache_read, cacheWrite: r.cache_write, cost: complete ? r.cost : null, source: !complete ? 'unavailable' : r.estimated > 0 ? 'estimated' : 'reported' });
  }
  const root: OtlpSpan = {
    traceId,
    spanId: rootId,
    name: 'orbit run',
    kind: 1,
    startTimeUnixNano: nanos(run.createdAt),
    endTimeUnixNano: nanos(Math.max(run.createdAt, runEnd)),
    attributes: [str('orbit.run.id', run.id), str('orbit.run.state', run.state), str('orbit.run.mode', run.mode), str('orbit.version', orbitVersionOf(run)), ...(run.failureClass ? [str('orbit.failure_class', run.failureClass)] : [])],
    status: { code: 0 },
  };
  const spans = [root, ...listWorkers(db, { runId: run.id }).map((w) => workerSpan(w, usage.get(w.id), traceId, rootId, runEnd))];
  return {
    resourceSpans: [
      {
        resource: { attributes: [str('service.name', 'orbit'), str('service.version', ORBIT_VERSION)] },
        schemaUrl: OTEL_SCHEMA_URL,
        scopeSpans: [{ scope: { name: 'orbit', version: ORBIT_VERSION }, schemaUrl: OTEL_SCHEMA_URL, spans }],
      },
    ],
  };
}
