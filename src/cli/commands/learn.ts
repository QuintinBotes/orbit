/**
 * `orbit learn list|show|ingest|export|overlays|eval` (ADR 0002). Everything
 * here handles lessons and overlays, which are advisory text outside the
 * trust boundary: nothing in this file can change a policy, a check or a
 * protected path.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { atomicWrite } from '../../core/fsx.ts';
import { redact } from '../../core/redact.ts';
import { loadConfig } from '../../policy/index.ts';
import { snapshotPolicy } from '../../policy/snapshot.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../../contract/model-outputs.ts';
import { renderSystemPrompt } from '../../adapters/prompt.ts';
import type { TaskSpec } from '../../adapters/types.ts';
import { profileForWorker } from '../../isolation/profiles.ts';
import { defaultControllerDeps, repoKey } from '../../controller/index.ts';
import { KnowledgeStore, type LessonFilters } from '../../knowledge/store.ts';
import { LESSON_KINDS, type Lesson, type LessonKind, type LessonScope, type LessonStatus, type OverlayStatus, type PromptOverlay, type EvalMetrics } from '../../knowledge/types.ts';
import { acceptIngestOutput, buildIngestTask, INGEST_CONTENT_MAX, type IngestSource } from '../../knowledge/ingest.ts';
import { createCandidateOverlay, completeEvaluation, distillOverlay, rollbackOverlay, startEvaluation } from '../../knowledge/overlays.ts';
import { buildReplaySuite, evaluateOverlay, type EvalRunner } from '../../knowledge/evals.ts';
import { openState, resolveRepo, type CliContext } from '../context.ts';
import type { Args, OptionSpec } from '../args.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, line, oneLine, table } from '../io.ts';

const STATUSES: readonly LessonStatus[] = ['candidate', 'validated', 'deprecated', 'rejected'];
const OVERLAY_STATUSES: readonly OverlayStatus[] = ['candidate', 'evaluating', 'active', 'retired', 'rolled_back', 'rejected'];

export const LEARN_SCOPE_OPTIONS: OptionSpec = {
  global: { type: 'boolean', description: 'use the global graph in ~/.orbit instead of this repository\'s' },
};

function knowledgePath(ctx: CliContext, repo: string, global: boolean): string {
  return global ? join(ctx.orbitHome, 'knowledge.sqlite') : join(repo, '.orbit', 'knowledge.sqlite');
}

/** Open an existing graph; reading commands do not create one. */
function openExisting(ctx: CliContext, repo: string, global: boolean): KnowledgeStore {
  const path = knowledgePath(ctx, repo, global);
  if (!existsSync(path)) throw new OrbitError('NOT_FOUND', `no ${global ? 'global' : 'repository'} knowledge graph at ${path}; it is created by the first run that learns something, or by "orbit learn ingest"`);
  return KnowledgeStore.open(path, { clock: ctx.clock });
}

function lessonRow(l: Lesson, support: number, contradict: number): string[] {
  return [l.id, l.status, l.kind, l.confidence, `${support}/${contradict}`, oneLine(l.statement, 90)];
}

export const LEARN_LIST_OPTIONS: OptionSpec = {
  ...LEARN_SCOPE_OPTIONS,
  status: { type: 'string', description: `one of ${STATUSES.join(', ')}`, valueName: 'status' },
  kind: { type: 'string', description: `one of ${LESSON_KINDS.join(', ')}`, valueName: 'kind' },
  search: { type: 'string', description: 'full-text search over lessons', valueName: 'text' },
  limit: { type: 'string', description: 'at most this many lessons (default 50)', valueName: 'n' },
};

export async function learnListCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const status = args.oneOf('status', STATUSES);
  const kind = args.oneOf('kind', LESSON_KINDS);
  const limit = args.int('limit') ?? 50;
  const repo = await resolveRepo(ctx, args.str('repo'));
  const store = openExisting(ctx, repo, args.bool('global'));
  try {
    const filters: LessonFilters = { ...(status ? { statuses: [status] } : {}), ...(kind ? { kinds: [kind as LessonKind] } : {}), limit };
    const search = args.str('search');
    const lessons = search ? store.search(search, filters).map((h) => h.lesson) : store.listLessons(filters);
    const stats = store.statsMany(lessons.map((l) => l.id));
    if (args.bool('json')) {
      json(ctx.io, lessons.map((l) => ({ ...l, stats: stats.get(l.id) ?? null })));
      return EXIT.OK;
    }
    if (lessons.length === 0) line(ctx.io, 'no lessons match');
    else ctx.io.out(table(lessons.map((l) => lessonRow(l, stats.get(l.id)?.support ?? 0, stats.get(l.id)?.contradict ?? 0)), ['ID', 'STATUS', 'KIND', 'CONFIDENCE', 'SUPPORT/CONTRADICT', 'STATEMENT']));
    return EXIT.OK;
  } finally {
    store.close();
  }
}

export async function learnShowCommand(args: Args, ctx: CliContext): Promise<number> {
  const [ref] = args.expect(1);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const store = openExisting(ctx, repo, args.bool('global'));
  try {
    let lesson = store.getLesson(ref!);
    if (!lesson) {
      const hits = store.listLessons({}).filter((l) => l.id.startsWith(ref!));
      if (hits.length === 1) lesson = hits[0]!;
      else throw new OrbitError('NOT_FOUND', hits.length > 1 ? `"${ref}" matches ${hits.length} lessons; use a longer id` : `no lesson ${ref}`);
    }
    const stats = store.stats(lesson.id);
    const edges = store.edges({ src: lesson.id });
    const events = store.events(lesson.id);
    if (args.bool('json')) {
      json(ctx.io, { lesson, stats, edges, events });
      return EXIT.OK;
    }
    line(ctx.io, `${lesson.id}  [${lesson.status}] ${lesson.kind}, ${lesson.confidence} confidence, scope ${lesson.scope}${lesson.code_free ? ', code-free' : ''}`);
    line(ctx.io, `statement:    ${lesson.statement}`);
    line(ctx.io, `rationale:    ${lesson.rationale}`);
    line(ctx.io, `verification: ${lesson.verification}`);
    line(ctx.io, `applies to:   ${[...lesson.applicability.languages, ...lesson.applicability.frameworks, ...lesson.applicability.check_ids].join(', ') || 'anything'}`);
    line(ctx.io, `evidence:     ${stats.support} supporting run(s), ${stats.contradict} contradicting; retrieved in ${stats.retrieved} run(s)`);
    line(ctx.io, `provenance:   ${lesson.provenance.source}${lesson.provenance.uri ? ` (${lesson.provenance.uri})` : ''}, generated by ${lesson.provenance.generated_by} at ${lesson.provenance.generated_at}`);
    for (const e of edges) line(ctx.io, `edge:         ${e.type} -> ${e.dst}`);
    for (const ev of events) line(ctx.io, `history:      ${new Date(ev.ts).toISOString()} ${ev.type}`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

export const LEARN_EXPORT_OPTIONS: OptionSpec = {
  ...LEARN_SCOPE_OPTIONS,
  out: { type: 'string', description: 'write the JSON-LD here instead of standard output', valueName: 'file' },
};

export async function learnExportCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const store = openExisting(ctx, repo, args.bool('global'));
  try {
    const doc = JSON.stringify(store.exportJsonLd(), null, 2);
    const out = args.str('out');
    if (out) {
      atomicWrite(resolve(ctx.cwd, out), `${doc}\n`);
      line(ctx.io, `exported ${store.count()} lesson(s) as JSON-LD to ${resolve(ctx.cwd, out)}`);
    } else ctx.io.out(`${doc}\n`);
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Ingest

export const LEARN_INGEST_OPTIONS: OptionSpec = {
  label: { type: 'string', description: 'a short name for pasted text (stdin)', valueName: 'text' },
  'print-task': { type: 'boolean', description: 'print the curator task (redacted, fenced) and stop; nothing is sent anywhere' },
  'curator-output': { type: 'string', description: 'accept this curator JSON file instead of running a curator model', valueName: 'file' },
};

const FETCH_MAX_BYTES = 2 * 1024 * 1024;

async function readSource(ctx: CliContext, repo: string, ref: string, label: string | undefined): Promise<IngestSource> {
  if (ref === '-') {
    const content = await ctx.io.readStdin();
    if (!content.trim()) throw new UsageError('nothing was read from standard input', 'orbit learn ingest <file|url|-> [--label text]');
    return { kind: 'text', ref: label ?? 'pasted text', content };
  }
  if (/^https?:\/\//i.test(ref)) {
    // Fetched by Orbit, not by a model, and handed on only as redacted, fenced data.
    const res = await fetch(ref, { signal: AbortSignal.timeout(30_000), redirect: 'follow', headers: { accept: 'text/*, application/json' } });
    if (!res.ok) throw new OrbitError('NOT_FOUND', `${ref} answered HTTP ${res.status}`);
    const type = res.headers.get('content-type') ?? '';
    if (!/^(text\/|application\/(json|xml|xhtml))/i.test(type)) throw new OrbitError('SCHEMA_INVALID', `${ref} is ${type || 'of unknown type'}, not text`);
    // Read with a cap: a server that never stops sending must not be able to fill memory before the size check.
    const tooBig = () => new OrbitError('SCHEMA_INVALID', `${ref} is larger than ${FETCH_MAX_BYTES} bytes`);
    if (Number(res.headers.get('content-length') ?? 0) > FETCH_MAX_BYTES) {
      await res.body?.cancel();
      throw tooBig();
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    const reader = res.body?.getReader();
    for (;;) {
      const next = reader ? await reader.read() : { done: true as const, value: undefined };
      if (next.done) break;
      total += next.value.byteLength;
      if (total > FETCH_MAX_BYTES) {
        await reader!.cancel();
        throw tooBig();
      }
      chunks.push(next.value);
    }
    return { kind: 'url', ref, content: Buffer.concat(chunks).toString('utf8') };
  }
  const path = resolve(ctx.cwd, ref);
  if (!existsSync(path)) throw new OrbitError('NOT_FOUND', `${path} does not exist`);
  const st = statSync(path);
  if (!st.isFile()) throw new OrbitError('SCHEMA_INVALID', `${path} is not a regular file`);
  if (st.size > FETCH_MAX_BYTES) throw new OrbitError('SCHEMA_INVALID', `${path} is larger than ${FETCH_MAX_BYTES} bytes`);
  const rel = relative(repo, path);
  // The reference is stored in the lesson's provenance: keep it repository-relative, never an absolute home path.
  return { kind: 'file', ref: !rel.startsWith('..') && !isAbsolute(rel) ? rel : basename(path), content: readFileSync(path, 'utf8') };
}

const CURATOR_TIMEOUT_MS = 5 * 60_000;

async function runIngestCurator(ctx: CliContext, repo: string, config: OrbitConfig, prompt: string): Promise<{ output: unknown; model: string | null }> {
  if (!(config.knowledge.curator_budget_usd > 0)) throw new OrbitError('CONFIG_INVALID', 'knowledge.curator_budget_usd is 0, so no curator may run; raise it, or supply the curator output with --curator-output');
  const db = openState(repo, { create: true });
  try {
    const factory = ctx.seams.controllerDeps ?? defaultControllerDeps;
    const deps = factory({ repoRoot: repo, db, clock: ctx.clock, config, env: ctx.env, orbitHome: ctx.orbitHome });
    const adapter = deps.adapters.claude;
    if (!adapter) throw new OrbitError('PROVIDER_UNAVAILABLE', 'no claude provider is configured; the curator runs on Claude');
    deps.registry.seed();
    const model = deps.registry.list().find((e) => e.provider === 'claude' && e.family === 'haiku' && e.surfaces.some((s) => s.surface === 'claude-cli' && s.available !== false))?.modelId ?? null;
    // A task needs a policy snapshot to be a worker at all; this one lives under ~/.orbit, outside the repository.
    const id = `ingest-${ctx.clock.now().toString(36)}`;
    const dir = join(ctx.orbitHome, 'ingest', repoKey(repo), id);
    const workerDir = join(dir, 'curator');
    const cwd = join(dir, 'cwd');
    mkdirSync(workerDir, { recursive: true, mode: 0o700 });
    mkdirSync(cwd, { recursive: true, mode: 0o700 });
    const snap = snapshotPolicy(config, { runId: id, repoRoot: repo, runDir: dir, clock: ctx.clock });
    const home = ctx.homeDir;
    const spec: TaskSpec & { maxBudgetUsd: number } = {
      runId: id,
      workerId: `${id}-curator`,
      role: 'curator',
      model,
      effort: null,
      cwd,
      workerDir,
      prompt,
      systemPrompt: renderSystemPrompt('curator', deps.agentsDir ? { agentsDir: deps.agentsDir } : {}),
      outputSchema: MODEL_OUTPUT_SCHEMAS.curator,
      readOnly: true,
      maxTurns: 3,
      timeoutMs: CURATOR_TIMEOUT_MS,
      sandbox: profileForWorker({ worktree: cwd, workerDir, snapshot: snap.snapshot, provider: 'claude', claudeConfigDir: ctx.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), homeDir: home, policyPath: snap.path, readablePaths: [deps.orbitInstallDir], env: ctx.env }),
      policyPath: snap.path,
      policyHash: snap.hash,
      env: {},
      maxBudgetUsd: config.knowledge.curator_budget_usd,
    };
    const handle = await adapter.startTask(spec);
    const deadline = Date.now() + CURATOR_TIMEOUT_MS + 30_000;
    for (;;) {
      const r = await adapter.collectResult(handle, { outputSchema: MODEL_OUTPUT_SCHEMAS.curator });
      if (r) {
        if (r.status !== 'succeeded') throw new OrbitError(r.status === 'auth_failed' ? 'AUTH_EXPIRED' : 'PROVIDER_UNAVAILABLE', `the curator ended ${r.status}${r.error ? `: ${redact(r.error).slice(0, 200)}` : ''}`);
        return { output: r.structured, model };
      }
      if (Date.now() > deadline) {
        await adapter.cancelTask(handle);
        throw new OrbitError('PROVIDER_UNAVAILABLE', 'the curator timed out');
      }
      await new Promise((res) => setTimeout(res, 200));
    }
  } finally {
    db.close();
  }
}

export async function learnIngestCommand(args: Args, ctx: CliContext): Promise<number> {
  const [ref] = args.expect(1);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const config = loadConfig(repo);
  if (!config.knowledge.enabled) throw new OrbitError('CONFIG_INVALID', 'knowledge.enabled is false in this repository\'s policy; ingest is refused while learning is off');
  const source = await readSource(ctx, repo, ref!, args.str('label'));
  if (source.content.length > INGEST_CONTENT_MAX) ctx.io.err(`note: the material is longer than ${INGEST_CONTENT_MAX} characters; only the first ${INGEST_CONTENT_MAX} are shown to the curator\n`);
  const task = buildIngestTask(source, { clock: ctx.clock });
  if (args.bool('print-task')) {
    ctx.io.out(task.prompt);
    return EXIT.OK;
  }
  let output: unknown;
  let model: string | null = null;
  const prepared = args.str('curator-output');
  if (prepared) {
    try {
      output = JSON.parse(readFileSync(resolve(ctx.cwd, prepared), 'utf8'));
    } catch (err) {
      throw new OrbitError('SCHEMA_INVALID', `${prepared} is not readable JSON: ${err instanceof Error ? oneLine(err.message, 120) : 'error'}`);
    }
  } else ({ output, model } = await runIngestCurator(ctx, repo, config, task.prompt));
  const result = acceptIngestOutput(output, source, ctx.clock, model ? { curatorModel: model } : {});
  mkdirSync(join(repo, '.orbit'), { recursive: true });
  const store = KnowledgeStore.open(join(repo, '.orbit', 'knowledge.sqlite'), { clock: ctx.clock });
  const created: string[] = [];
  const merged: string[] = [];
  const rejected = [...result.rejected];
  try {
    for (const lesson of result.accepted) {
      try {
        const r = store.upsertLesson(lesson);
        (r.created ? created : merged).push(r.lesson.id);
      } catch (err) {
        rejected.push({ index: -1, statement: lesson.statement.slice(0, 120), reason: err instanceof Error ? err.message : String(err) });
      }
    }
  } finally {
    store.close();
  }
  if (args.bool('json')) json(ctx.io, { source: { kind: source.kind, ref: source.ref }, created, merged, rejected, discarded: result.discarded });
  else {
    line(ctx.io, `ingested ${source.kind} ${source.ref}: ${created.length} new lesson(s), ${merged.length} merged into existing ones, ${rejected.length} rejected`);
    for (const r of rejected.slice(0, 10)) line(ctx.io, `  rejected: ${oneLine(r.statement ?? '(unreadable)', 80)} (${oneLine(r.reason, 120)})`);
    line(ctx.io, 'They enter as low-confidence candidates and are never retrieved as validated until run evidence corroborates them.');
  }
  return EXIT.OK;
}

// ---------------------------------------------------------------------------
// Overlays

export const LEARN_OVERLAYS_OPTIONS: OptionSpec = {
  ...LEARN_SCOPE_OPTIONS,
  role: { type: 'string', description: 'only this role', valueName: 'role' },
  status: { type: 'string', description: `one of ${OVERLAY_STATUSES.join(', ')}`, valueName: 'status' },
  reason: { type: 'string', description: 'why (for "rollback")', valueName: 'text' },
};

function overlayMetrics(m: EvalMetrics | undefined): string {
  return m ? `pass ${(m.verified_pass_rate * 100).toFixed(0)}%, attempts ${m.mean_attempts.toFixed(1)}, cost ${m.mean_cost_usd === null ? 'unknown' : `$${m.mean_cost_usd.toFixed(2)}`}, false-pass ${(m.false_pass_rate * 100).toFixed(0)}%` : '-';
}

export async function learnOverlaysCommand(args: Args, ctx: CliContext): Promise<number> {
  const [action, id] = args.positionals;
  const repo = await resolveRepo(ctx, args.str('repo'));
  const store = openExisting(ctx, repo, args.bool('global'));
  try {
    if (action === 'rollback') {
      if (!id) throw new UsageError('an overlay id is required', 'orbit learn overlays rollback <overlay-id> [--reason text]');
      const r = rollbackOverlay(store, id, args.str('reason') ?? `rolled back by ${ctx.user}`);
      if (args.bool('json')) json(ctx.io, r);
      else line(ctx.io, `overlay ${r.rolledBack.id} (${r.rolledBack.role} v${r.rolledBack.version}) rolled back${r.restored ? `; restored ${r.restored.id} (v${r.restored.version})` : '; the base prompt is in force again'}`);
      return EXIT.OK;
    }
    if (action !== undefined) throw new UsageError(`unknown overlays action "${action}"`, 'orbit learn overlays [rollback <overlay-id>] [--role r] [--status s]');
    const status = args.oneOf('status', OVERLAY_STATUSES);
    const overlays = store.listOverlays({ ...(args.str('role') ? { role: args.str('role')! } : {}), scope: (args.bool('global') ? 'global' : 'repo') as LessonScope }).filter((o) => !status || o.status === status);
    if (args.bool('json')) {
      json(ctx.io, overlays);
      return EXIT.OK;
    }
    if (overlays.length === 0) line(ctx.io, 'no overlays');
    else {
      ctx.io.out(table(overlays.map((o) => [o.id, o.role, `v${o.version}`, o.status, String(o.lesson_ids.length), o.eval ? overlayMetrics(o.eval.candidate) : '-']), ['OVERLAY', 'ROLE', 'VERSION', 'STATUS', 'LESSONS', 'REPLAY METRICS']));
    }
    return EXIT.OK;
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// Replay evaluation

export const LEARN_EVAL_OPTIONS: OptionSpec = {
  role: { type: 'string', description: 'distill a candidate overlay for this role from validated lessons and evaluate it', valueName: 'role' },
  overlay: { type: 'string', description: 'evaluate this existing candidate (or evaluating) overlay', valueName: 'id' },
  limit: { type: 'string', description: 'replay at most this many past successful runs (default 20)', valueName: 'n' },
  metrics: { type: 'string', description: 'JSON file {cases, suite_id?, baseline, candidate} measured elsewhere; skips the replay', valueName: 'file' },
};

/** Stops replay once the evaluation budget is spent: measured cost counts, and a case with unknown cost is counted as spent. */
function budgeted(runner: EvalRunner, budgetUsd: number): EvalRunner {
  let spent = 0;
  return {
    async runCase(suite, c, overlay) {
      if (spent >= budgetUsd) throw new OrbitError('BUDGET_EXHAUSTED', `the evaluation budget of $${budgetUsd.toFixed(2)} is spent after $${spent.toFixed(2)}; raise knowledge.eval_budget_usd to continue`);
      const r = await runner.runCase(suite, c, overlay);
      spent += r.cost_usd ?? 0;
      return r;
    },
  };
}

const MAX_EVALUATIONS = 3;

export async function learnEvalCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const role = args.str('role');
  const overlayId = args.str('overlay');
  if (!role && !overlayId) throw new UsageError('name a --role to distill a candidate for, or an existing --overlay', 'orbit learn eval --role <role> | --overlay <id> [--limit n] [--metrics file]');
  const repo = await resolveRepo(ctx, args.str('repo'));
  const config = loadConfig(repo);
  if (!(config.knowledge.eval_budget_usd > 0)) throw new OrbitError('CONFIG_INVALID', 'knowledge.eval_budget_usd is 0, which disables replay evaluations and with them automatic overlay adoption; set a budget to evaluate');
  const metricsFile = args.str('metrics');
  const runner = ctx.seams.evalRunner;
  if (!runner && !metricsFile) {
    throw new OrbitError('PROVIDER_UNAVAILABLE', 'this installation has no replay runner (the controller does not provide one yet), so a candidate cannot be replayed here. Supply metrics measured elsewhere with --metrics <file>, or use "orbit learn overlays" to inspect candidates');
  }
  const db = openState(repo);
  const store = KnowledgeStore.open(join(repo, '.orbit', 'knowledge.sqlite'), { clock: ctx.clock });
  try {
    let overlay: PromptOverlay | null;
    if (overlayId) {
      overlay = store.getOverlay(overlayId);
      if (!overlay) throw new OrbitError('NOT_FOUND', `no overlay ${overlayId}`);
      if (overlay.status !== 'candidate' && overlay.status !== 'evaluating') throw new OrbitError('TRANSITION_INVALID', `overlay ${overlay.id} is ${overlay.status}; only a candidate can be evaluated`);
    } else {
      const lessons = store.listLessons({ statuses: ['validated'], roles: [role!] });
      const stats = store.statsMany(lessons.map((l) => l.id));
      const draft = distillOverlay(role!, lessons.map((lesson) => ({ lesson, stats: stats.get(lesson.id)! })));
      if (draft.lesson_ids.length === 0) throw new OrbitError('NOT_FOUND', `no validated lessons apply to ${role}; there is nothing to distill`);
      overlay = createCandidateOverlay(store, draft, 'repo');
    }
    const suite = buildReplaySuite(db, { limit: args.int('limit') ?? 20, role: overlay.role }, ctx.clock);
    if (!metricsFile && suite.cases.length === 0) throw new OrbitError('NOT_FOUND', `candidate ${overlay.id} was recorded, but there are no successful runs to replay it against yet`);
    if (overlay.status === 'candidate') overlay = startEvaluation(store, overlay.id);

    let outcome: ReturnType<typeof completeEvaluation> | null = null;
    for (let attempt = 1; attempt <= MAX_EVALUATIONS && !outcome; attempt++) {
      const baseline = store.activeOverlay(overlay.role, overlay.scope);
      let input: { cases: number; suite_id: string; baseline: EvalMetrics; candidate: EvalMetrics };
      if (metricsFile) {
        let m: { cases?: unknown; suite_id?: unknown; baseline?: EvalMetrics; candidate?: EvalMetrics };
        try {
          m = JSON.parse(readFileSync(resolve(ctx.cwd, metricsFile), 'utf8')) as typeof m;
        } catch (err) {
          throw new OrbitError('SCHEMA_INVALID', `${metricsFile} is not readable JSON: ${err instanceof Error ? oneLine(err.message, 120) : 'error'}`);
        }
        if (!m.baseline || !m.candidate || typeof m.cases !== 'number') throw new OrbitError('SCHEMA_INVALID', `${metricsFile} needs {cases, baseline, candidate}`);
        input = { cases: m.cases, suite_id: typeof m.suite_id === 'string' ? m.suite_id : suite.id, baseline: m.baseline, candidate: m.candidate };
      } else {
        const r = await evaluateOverlay(budgeted(runner!, config.knowledge.eval_budget_usd), suite, baseline, overlay);
        input = { cases: r.cases, suite_id: r.suite_id, baseline: r.baseline, candidate: r.candidate };
      }
      try {
        // The baseline's identity travels with its metrics: adopting over an overlay that changed meanwhile compares nothing.
        outcome = completeEvaluation(store, overlay.id, { ...input, baseline_overlay_id: baseline?.id ?? null });
      } catch (err) {
        if (!isOrbitError(err, 'CONCURRENT_UPDATE')) throw err;
        if (metricsFile || attempt === MAX_EVALUATIONS) throw err;
        ctx.io.err(`the active overlay changed during the replay; evaluating again (${attempt}/${MAX_EVALUATIONS})\n`);
      }
    }
    if (!outcome) throw new OrbitError('CONCURRENT_UPDATE', 'the active overlay kept changing; evaluate again later');
    if (args.bool('json')) json(ctx.io, outcome);
    else {
      line(ctx.io, `overlay ${outcome.overlay.id} (${outcome.overlay.role} v${outcome.overlay.version}): ${outcome.decision.adopt ? 'ADOPTED' : 'not adopted'} (${outcome.decision.reason})`);
      if (outcome.overlay.eval) {
        line(ctx.io, `  baseline:  ${overlayMetrics(outcome.overlay.eval.baseline)}`);
        line(ctx.io, `  candidate: ${overlayMetrics(outcome.overlay.eval.candidate)}`);
      }
    }
    return EXIT.OK;
  } finally {
    store.close();
    db.close();
  }
}

