/**
 * The final report (spec section 19) and the end-of-run learning hook.
 *
 * final.md is for a person; final.json is its machine-readable twin. Both
 * are built only from durable records (run row, contract, evidence reports,
 * reviews, decisions, budget counters, usage, delivery receipts), so a
 * report written by a restarted controller says the same thing. Anything
 * that was not established is listed as unverified, and missing cost
 * measurement is stated as such.
 *
 * Learning (ADR 0002) runs after the terminal transition and never changes
 * the outcome: extract, curate when the budget reserve allows, settle the
 * lessons that were shown, and promote to the global graph only when the
 * repository opted in and the publication guard clears the text.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { atomicWrite, atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { redact, redactValue } from '../core/redact.ts';
import { appendEvent } from '../storage/events.ts';
import { listDecisions } from '../storage/decisions.ts';
import { finishWorker, listWorkers, markWorkerRunning, planWorker, type WorkerRecord } from '../storage/workers.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { listEvidenceReports } from '../evidence/store.ts';
import { listFindings, listReviews } from '../review/store.ts';
import { readSecurityPolicy } from '../review/resolve.ts';
import { listLedger, listQuestions } from '../inquisition/store.ts';
import { summarizeUsage } from '../routing/usage.ts';
import { BudgetLedger } from '../scheduling/budget.ts';
import type { BudgetSnapshot } from '../scheduling/budget.ts';
import { DELIVERY_MODES } from '../policy/config.ts';
import type { PolicySnapshot } from '../policy/types.ts';
import type { GoalContract } from '../contract/types.ts';
import { MODEL_OUTPUT_SCHEMAS } from '../contract/model-outputs.ts';
import { KnowledgeStore } from '../knowledge/store.ts';
import { learnFromRun, type LearnReport } from '../knowledge/learn.ts';
import { settleRun } from '../knowledge/feedback.ts';
import { promoteToGlobal } from '../knowledge/global.ts';
import { checkPublication, loadPublicationGuard } from '../guard/publication.ts';
import { profileForWorker } from '../isolation/profiles.ts';
import { renderSystemPrompt } from '../adapters/prompt.ts';
import type { TaskHandle, TaskResult, TaskSpec } from '../adapters/types.ts';
import { getRun, type RunRecord } from './run-store.ts';
import { currentCandidate, type ControllerDeps, type RunContext } from './context.ts';
import { assertLeaseHeld } from './run-store.ts';
import { accountWorker, outcomeOf, recordSpendCap } from './workers.ts';
import { autoEvaluateOverlays } from './eval-runner.ts';
import { checkLiveOverlays, globalKnowledgePath, repoKnowledgePath } from './knowledge-hooks.ts';

export interface FinalReport {
  schema: 'orbit.final/1';
  run_id: string;
  outcome: string;
  outcome_reason: string | null;
  mode: string;
  original_goal: string;
  objective: string | null;
  criteria: { id: string; statement: string; mandatory: boolean; status: string; artifacts: string[] }[];
  checks: { id: string; status: string; exit_code: number | null; flaky: boolean; log: string }[];
  evidence: { report_id: string; verdict: string; tree_hash: string; candidate_revision: string } | null;
  reviews: { id: string; provider: string; model: string | null; verdict: string; tree_hash: string; findings: number }[];
  decisions: { kind: string; summary: string; at: number }[];
  assumptions: { id: string; statement: string; status: string }[];
  /** The engineering practices (spec section 5) the plan selected or omitted, with the reason for each; empty for a contract that predates the selection. */
  practices?: { practice: string; applicable: boolean; justification: string }[];
  repairs: { attempt: number; source: string; fingerprint: string | null }[];
  revision: { base: string | null; candidate: string | null; tree: string | null; branch: string | null; delivered_commit: string | null; pull_request: { number: number; url: string | null } | null };
  budget: { counters: BudgetSnapshot['counters']; cost_measurement: string; cost_usd: number; cost_complete: boolean; tokens: { input: number; output: number; cache_read: number; cache_write: number } } | null;
  unverified: string[];
  residual_risks: string[];
  next_action: string;
  generated_at: number;
}

export interface WriteReportOptions {
  runDir: string;
  clock: Clock;
  /** The verified snapshot, when there is one; a report for a run whose policy failed verification omits budget limits. */
  snapshot?: PolicySnapshot | null;
}

/**
 * Build and write final.md and final.json. Idempotent: the same records produce the same report.
 * Both files, and the returned report, carry the redacted form (see `buildFinalReport`).
 */
export function writeFinalReport(db: OrbitDb, runId: string, opts: WriteReportOptions): FinalReport {
  const run = getRun(db, runId);
  const report = buildFinalReport(db, run, opts);
  atomicWriteJson(join(opts.runDir, 'final.json'), report);
  atomicWrite(join(opts.runDir, 'final.md'), renderMarkdown(report));
  return report;
}

/**
 * The report as built from the durable records, deeply redacted with the policy redactor (S3.28): every string,
 * at any depth, passes through `redactValue`, which applies the built-in secret shapes and the
 * `retention.redact_patterns` in force. A goal, outcome reason, decision summary or finding that quoted a secret
 * is therefore never stored in final.json, printed by `orbit report --json`, or read by the learning layer.
 */
export function buildFinalReport(db: OrbitDb, run: RunRecord, opts: WriteReportOptions): FinalReport {
  return redactValue(assembleFinalReport(db, run, opts)) as FinalReport;
}

function assembleFinalReport(db: OrbitDb, run: RunRecord, opts: WriteReportOptions): FinalReport {
  const contract = parseContract(run.contractJson);
  const cand = currentCandidate(db, run.id);
  const reports = listEvidenceReports(db, run.id);
  const ev = (cand ? reports.filter((r) => r.candidateId === cand.id).at(-1) : null) ?? reports.at(-1) ?? null;
  const criteria = (contract?.acceptance_criteria ?? []).map((c) => {
    const e = ev?.report.acceptance_evidence.find((a) => a.criterion_id === c.id);
    return { id: c.id, statement: c.statement, mandatory: c.mandatory, status: e?.status ?? 'unverified', artifacts: e?.artifacts ?? [] };
  });
  const reviews = listReviews(db, run.id, { includeInvalidated: true });
  const findings = listFindings(db, run.id);
  const decisions = listDecisions(db, run.id).map((d) => ({ kind: d.kind, summary: d.summary, at: d.createdAt }));
  const delivery = readJsonIfExists<{ commit: string; branch: string; pr: { number: number; url?: string } | null }>(join(opts.runDir, 'delivery.json'));
  const outcomeJson = parseJson<{ branch?: string; commit?: string }>(run.outcomeJson);

  let budget: FinalReport['budget'] = null;
  const usage = summarizeUsage(db, run.id);
  if (opts.snapshot && db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', run.id)) {
    try {
      const snap = new BudgetLedger(db, opts.clock).attach(run.id, opts.snapshot).snapshot();
      budget = { counters: snap.counters, cost_measurement: snap.cost_measurement.note, cost_usd: usage.totals.costUsd, cost_complete: usage.costComplete, tokens: tokens(usage.totals) };
    } catch {
      budget = null;
    }
  }
  if (!budget) budget = { counters: [], cost_measurement: usage.note, cost_usd: usage.totals.costUsd, cost_complete: usage.costComplete, tokens: tokens(usage.totals) };

  const unverified = [...(ev?.report.unverified ?? [])];
  for (const c of criteria) if (c.mandatory && c.status !== 'supported') unverified.push(`${c.id} is ${c.status}`);
  const risks: string[] = [];
  const env = readJsonIfExists<{ gate?: { notes?: string[] } }>(join(opts.runDir, 'environment.json'));
  risks.push(...(env?.gate?.notes ?? []));
  if (!usage.costComplete || budget.cost_measurement.includes('unmeasured')) risks.push(`model spend: ${budget.cost_measurement}`);
  for (const f of findings.filter((x) => x.status === 'advisory' || x.status === 'open' || x.status === 'claim_pending')) risks.push(`review finding ${f.externalId ?? f.id} (${f.severity}, ${f.status}): ${f.claim.slice(0, 160)}`);
  // Confirmed defects not yet resolved are blocking; they must never vanish from the report.
  for (const f of findings.filter((x) => x.status === 'accepted')) risks.push(`review finding ${f.externalId ?? f.id} (${f.severity}, accepted, unresolved, blocking): ${f.claim.slice(0, 160)}`);
  let exceptions: { expires?: string }[] = [];
  try {
    if (opts.snapshot) exceptions = readSecurityPolicy(opts.snapshot).exceptions;
  } catch {
    exceptions = [];
  }
  for (const f of findings.filter((x) => x.status === 'excepted')) {
    const ex = (f.resolutionJson as { exception?: { index?: unknown; reason?: unknown } } | null)?.exception;
    const index = typeof ex?.index === 'number' ? ex.index : -1;
    const expires = exceptions[index]?.expires;
    const reason = typeof ex?.reason === 'string' ? ex.reason : (f.resolution ?? 'no reason recorded');
    risks.push(`review finding ${f.externalId ?? f.id} (${f.severity}, excepted by policy): ${f.claim.slice(0, 120)}; exception reason: ${reason.slice(0, 160)}; expires: ${expires ?? 'never'}`);
  }
  for (const q of listQuestions(db, run.id, { status: 'open' })) risks.push(`open question: ${q.question.slice(0, 200)}`);
  for (const c of ev?.report.checks.filter((x) => x.flaky) ?? []) risks.push(`check ${c.id} passed only on a rerun (flaky)`);

  const prNumber = delivery?.pr?.number ?? null;
  const branch = delivery?.branch ?? outcomeJson?.branch ?? run.branch;
  return {
    schema: 'orbit.final/1',
    run_id: run.id,
    outcome: run.state,
    outcome_reason: run.outcomeReason,
    mode: run.mode,
    original_goal: run.goal,
    objective: contract?.objective ?? null,
    criteria,
    checks: ev?.report.checks.map((c) => ({ id: c.id, status: c.status, exit_code: c.exit_code, flaky: c.flaky, log: c.log })) ?? [],
    evidence: ev ? { report_id: ev.id, verdict: ev.verdict, tree_hash: ev.treeHash, candidate_revision: ev.report.candidate_revision } : null,
    reviews: reviews.map((r) => ({ id: r.id, provider: r.provider, model: r.model, verdict: r.verdict, tree_hash: r.treeHash, findings: findings.filter((f) => f.reviewId === r.id).length })),
    decisions,
    assumptions: [...(contract?.assumptions ?? []).map((a) => ({ id: a.id, statement: a.statement, status: a.status })), ...listLedger(db, run.id).map((l) => ({ id: l.id, statement: l.claim, status: l.status }))],
    practices: (contract?.practices ?? []).map((p) => ({ practice: p.practice, applicable: p.applicable, justification: p.justification })),
    repairs: repairs(opts.runDir),
    revision: {
      base: run.baseRevision,
      candidate: cand?.commitSha ?? null,
      tree: cand?.treeHash ?? null,
      branch,
      delivered_commit: delivery?.commit ?? outcomeJson?.commit ?? null,
      pull_request: prNumber === null ? null : { number: prNumber, url: delivery?.pr?.url ?? null },
    },
    budget,
    unverified: [...new Set(unverified)],
    residual_risks: [...new Set(risks)],
    next_action: nextAction(run, branch, prNumber),
    generated_at: opts.clock.now(),
  };
}

function tokens(t: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) {
  return { input: t.inputTokens, output: t.outputTokens, cache_read: t.cacheReadTokens, cache_write: t.cacheWriteTokens };
}

function repairs(runDir: string): FinalReport['repairs'] {
  const dir = join(runDir, 'briefs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /^attempt-\d+\.json$/.test(f))
    .map((f) => readJsonIfExists<{ attempt: number; source: string; fingerprint: string | null }>(join(dir, f)))
    .filter((b): b is { attempt: number; source: string; fingerprint: string | null } => b !== null)
    .map((b) => ({ attempt: b.attempt, source: b.source, fingerprint: b.fingerprint }))
    .sort((a, b) => a.attempt - b.attempt);
}

function nextAction(run: RunRecord, branch: string | null, pr: number | null): string {
  switch (run.state) {
    case 'SUCCEEDED':
      return DELIVERY_MODES.has(run.mode)
        ? `Review${pr !== null ? ` pull request #${pr}` : ` branch ${branch ?? 'orbit/<run>'}`} and merge it if you accept it; Orbit does not merge.`
        : `Inspect the local branch ${branch ?? `orbit/${run.id}`} (the reviewed candidate) and merge it yourself if you accept it.`;
    case 'BLOCKED':
      return `${run.outcomeReason ?? 'The run is blocked.'} Resolve that, then run \`orbit resume ${run.id}\`.`;
    case 'EXHAUSTED':
      return `The authorized budget is spent (${run.outcomeReason ?? 'see decisions'}). The worktree and evidence are preserved; continue by hand from them or start a new run with a revised goal or limits.`;
    case 'IMPOSSIBLE':
      return `${run.outcomeReason ?? 'No authorized way to meet the contract was found.'} Revise the goal or the authorization before trying again.`;
    case 'CANCELLED':
      return 'Nothing further: the run was cancelled on request and its artifacts are preserved.';
    default:
      return `The run is ${run.state}; this report is provisional.`;
  }
}

export function renderMarkdown(r: FinalReport): string {
  const out: string[] = [];
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '- none');
  out.push(`# Orbit run ${r.run_id}: ${r.outcome}`, '');
  out.push('## Outcome', '', `${r.outcome}${r.outcome_reason ? `: ${r.outcome_reason}` : ''}`, '');
  out.push('## Original goal', '', r.original_goal, '');
  if (r.objective) out.push('## Delivered behaviour', '', r.objective, '');
  out.push('## Criterion evidence', '', list(r.criteria.map((c) => `${c.id}${c.mandatory ? '' : ' (optional)'} [${c.status}]: ${c.statement}${c.artifacts.length ? ` (evidence: ${c.artifacts.join(', ')})` : ''}`)), '');
  out.push('## Checks', '', list(r.checks.map((c) => `${c.id}: ${c.status}${c.exit_code !== null ? ` (exit ${c.exit_code})` : ''}${c.flaky ? ', flaky' : ''}, log ${c.log}`)), '');
  if (r.evidence) out.push(`Evidence report ${r.evidence.report_id}: ${r.evidence.verdict} on tree ${r.evidence.tree_hash}.`, '');
  out.push('## Reviews', '', list(r.reviews.map((v) => `${v.provider}/${v.model ?? 'default'}: ${v.verdict} on tree ${v.tree_hash} (${v.findings} finding(s))`)), '');
  out.push('## Decisions', '', list(r.decisions.map((d) => `${d.kind}: ${d.summary}`)), '');
  out.push('## Assumptions', '', list(r.assumptions.map((a) => `${a.id} [${a.status}]: ${a.statement}`)), '');
  if (r.practices && r.practices.length > 0) out.push('## Engineering practices', '', list(r.practices.map((p) => `${p.practice} [${p.applicable ? 'selected' : 'omitted'}]: ${p.justification}`)), '');
  out.push('## Repairs', '', list(r.repairs.map((x) => `attempt ${x.attempt}: ${x.source} brief${x.fingerprint ? ` for ${x.fingerprint}` : ''}`)), '');
  const rv = r.revision;
  out.push('## Revision, branch and pull request', '', list([`base: ${rv.base ?? 'none'}`, `candidate: ${rv.candidate ?? 'none'} (tree ${rv.tree ?? 'none'})`, `branch: ${rv.branch ?? 'none'}`, `delivered commit: ${rv.delivered_commit ?? 'none'}`, `pull request: ${rv.pull_request ? `#${rv.pull_request.number}${rv.pull_request.url ? ` ${rv.pull_request.url}` : ''}` : 'none'}`]), '');
  if (r.budget) {
    const b = r.budget;
    out.push('## Budget consumption', '', list([...b.counters.map((c) => `${c.counter}: ${round(c.used)} used of ${round(c.allowance)} allowed (hard cap ${round(c.hard_cap)})`), `model cost: $${b.cost_usd.toFixed(4)} (${b.cost_complete ? 'measured' : 'incomplete: some usage has no cost'}); ${b.cost_measurement}`, `tokens: ${b.tokens.input} in, ${b.tokens.output} out, ${b.tokens.cache_read} cache read, ${b.tokens.cache_write} cache write`]), '');
  }
  out.push('## Not verified', '', list(r.unverified), '');
  out.push('## Residual risks', '', list(r.residual_risks), '');
  out.push('## Next action', '', r.next_action, '');
  return redact(`${out.join('\n')}`);
}

function round(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function parseContract(json: string | null): GoalContract | null {
  return parseJson<GoalContract>(json);
}

function parseJson<T>(json: string | null): T | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Terminal hook

/** Report, then learning. Neither may change the outcome or throw past this point. */
export async function finalizeRun(ctx: RunContext): Promise<void> {
  try {
    writeFinalReport(ctx.db, ctx.run.id, { runDir: ctx.runDir, clock: ctx.clock, snapshot: ctx.policyVerified ? ctx.snapshot : null });
  } catch (err) {
    ctx.log.error('final report failed', { error: err instanceof Error ? err.message : String(err) });
  }
  if (!ctx.policyVerified) return;
  try {
    await learnAtTerminal(ctx);
  } catch (err) {
    ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.failed', ctx.ownerId, { error: redact(err instanceof Error ? err.message : String(err)).slice(0, 500) }, ctx.clock.now()));
  }
}

const CURATOR_TIMEOUT_MS = 5 * 60_000;

export async function learnAtTerminal(ctx: RunContext): Promise<void> {
  const k = ctx.snapshot.config.knowledge;
  if (!k?.enabled) return;
  const run = ctx.refresh();
  const store = KnowledgeStore.open(repoKnowledgePath(ctx), { clock: ctx.clock });
  const summary: { learn: LearnReport | null; skipped: string | null; settled: unknown; promoted: unknown; overlays: unknown } = { learn: null, skipped: null, settled: null, promoted: null, overlays: null };
  try {
    const admitted = curationAdmitted(ctx);
    if (run.state === 'CANCELLED') summary.skipped = 'cancelled runs are not curated';
    else if (!admitted.ok) summary.skipped = admitted.why;
    else {
      const host = curatorHostFor(ctx);
      summary.learn = await learnFromRun({ store, runDb: ctx.db, runId: run.id, runDir: ctx.runDir, clock: ctx.clock, curatorModel: admitted.model ?? 'claude-default', runCurator: async (task) => (await runCurator(host, task, admitted.model)).output });
    }
    if (summary.skipped !== null) ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.curation-skipped', ctx.ownerId, { reason: summary.skipped }, ctx.clock.now()));

    const ev = listEvidenceReports(ctx.db, run.id).at(-1);
    summary.settled = settleRun(store, run.id, {
      succeeded: run.state === 'SUCCEEDED',
      attempts: listWorkers(ctx.db, { runId: run.id, role: 'implementer' }).length,
      verifiedCriteria: ev?.report.acceptance_evidence.filter((a) => a.status === 'supported').map((a) => a.criterion_id) ?? [],
      contradictedLessonIds: [],
      artifact: existsSync(join(ctx.runDir, 'final.md')) ? { path: 'final.md', sha256: sha256(readFileSync(join(ctx.runDir, 'final.md'))) } : { path: 'final.md', sha256: null },
    });

    if (k.share_globally) {
      const guard = loadPublicationGuard(ctx.snapshot.config.guard.terms_file ? { termsPath: ctx.snapshot.config.guard.terms_file } : {});
      const global = KnowledgeStore.open(globalKnowledgePath(ctx), { clock: ctx.clock });
      try {
        summary.promoted = await promoteToGlobal(store, global, { shareGlobally: true, guard: (text) => checkPublication(text, { ...guard.options, allowedEmails: [...(guard.options.allowedEmails ?? []), ...ctx.snapshot.config.guard.allowed_emails] }) });
      } finally {
        global.close();
      }
    }

    // Overlays (ADR 0002): a settled run is live evidence about the active overlay, and the moment to try a waiting candidate.
    if (run.state !== 'CANCELLED') {
      const live = checkLiveOverlays(ctx, store);
      const evaluated = await autoEvaluateOverlays(ctx, store);
      summary.overlays = { live, evaluated };
    }
  } finally {
    store.close();
  }
  atomicWriteJson(join(ctx.runDir, 'learning.json'), summary);
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.completed', ctx.ownerId, { skipped: summary.skipped, created: summary.learn?.created.length ?? 0, merged: summary.learn?.merged.length ?? 0 }, ctx.clock.now()));
}

/** The curator for this run's learning: a recorded worker of the run, files under its learning/ directory. */
function curatorHostFor(ctx: RunContext): CuratorHost {
  return {
    deps: ctx.deps,
    clock: ctx.clock,
    snapshot: ctx.snapshot,
    policyPath: ctx.run.policyPath,
    policyHash: ctx.run.policyHash,
    runId: ctx.run.id,
    dir: join(ctx.runDir, 'learning'),
    budgetUsd: ctx.snapshot.config.knowledge.curator_budget_usd,
    recorded: ctx,
  };
}

/** Curation spends from the closing reserve only when the reserve can still pay for it; otherwise it is skipped and the reason recorded. */
function curationAdmitted(ctx: RunContext): { ok: true; model: string | null } | { ok: false; why: string } {
  const k = ctx.snapshot.config.knowledge;
  if (!(k.curator_budget_usd > 0)) return { ok: false, why: 'knowledge.curator_budget_usd is 0' };
  if (!ctx.deps.adapters.claude) return { ok: false, why: 'no claude adapter for the curator' };
  const ledger = ctx.ledger ?? (ctx.db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', ctx.run.id) ? new BudgetLedger(ctx.db, ctx.clock).attach(ctx.run.id, ctx.snapshot) : null);
  if (ledger) {
    const d = ledger.admit({ role: 'curator', estimatedCostUsd: k.curator_budget_usd, phase: 'final' });
    if (!d.admitted) return { ok: false, why: `the budget reserve cannot pay for curation: ${d.reasons.join('; ')}` };
  }
  return { ok: true, model: curatorModelFor(ctx.deps.registry) };
}

/**
 * Everything the curator needs, so the same code runs it for a finished run
 * (a recorded worker of that run) and for `orbit learn ingest` (no run: only
 * its files and its usage return to the caller).
 */
export interface CuratorHost {
  deps: Pick<ControllerDeps, 'adapters' | 'registry' | 'orbitInstallDir' | 'agentsDir' | 'hostEnv' | 'homeDir'>;
  clock: Clock;
  snapshot: PolicySnapshot;
  policyPath: string;
  policyHash: string;
  /** The run id the worker is attributed to (an ingest id when there is no run). */
  runId: string;
  /** Where the curator's own files live: <dir>/cwd always, and <dir>/curator-<n> when it is not recorded. */
  dir: string;
  /** Spend ceiling for the curator's own budget flag (knowledge.curator_budget_usd). */
  budgetUsd: number;
  /** Host environment, for the provider's configuration directory. */
  env?: Readonly<Record<string, string | undefined>>;
  homeDir?: string;
  timeoutMs?: number;
  /**
   * When set, the curator is a recorded worker of this run: the row is planned
   * before the spawn (the workers table takes a curator on a terminal run and
   * no other role), finished with the adapter's classification, and its cost
   * charged to the run's final-phase budget and its usage recorded.
   */
  recorded?: RunContext;
}

export interface CuratorOutcome {
  output: unknown;
  model: string | null;
  workerId: string | null;
}

/** The Haiku model validated on the CLI surface, or null for the provider's default. */
export function curatorModelFor(registry: ControllerDeps['registry']): string | null {
  return registry.list().find((e) => e.provider === 'claude' && e.family === 'haiku' && e.surfaces.some((s) => s.surface === 'claude-cli' && s.available !== false))?.modelId ?? null;
}

/**
 * Run the curator on `task` and return its structured output. Throws an
 * OrbitError when the worker ends in anything but success (AUTH_EXPIRED for a
 * rejected credential, PROVIDER_UNAVAILABLE otherwise); a recorded worker row
 * and its usage are written before the error leaves.
 */
export async function runCurator(host: CuratorHost, task: { prompt: string }, model: string | null = curatorModelFor(host.deps.registry)): Promise<CuratorOutcome> {
  const adapter = host.deps.adapters.claude;
  if (!adapter) throw new OrbitError('PROVIDER_UNAVAILABLE', 'no claude provider is configured; the curator runs on Claude');
  const ctx = host.recorded ?? null;
  const timeoutMs = host.timeoutMs ?? CURATOR_TIMEOUT_MS;
  const env = host.env ?? host.deps.hostEnv ?? process.env;
  const home = host.homeDir ?? host.deps.homeDir ?? homedir();
  const cwd = join(host.dir, 'cwd');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });

  let row: WorkerRecord | null = null;
  let workerId: string;
  let workerDir: string;
  let purpose: string | null = null;
  if (ctx) {
    const n = listWorkers(ctx.db, { runId: ctx.run.id, role: 'curator' }).length + 1;
    workerId = `${ctx.run.id}-curator-${n}`;
    purpose = `curate:${n}`;
    workerDir = join(ctx.runDir, 'workers', workerId);
    mkdirSync(workerDir, { recursive: true, mode: 0o700 });
    recordSpendCap(ctx, purpose, host.budgetUsd, 0);
    const ctxNow = ctx;
    row = ctx.db.tx(() => {
      assertLeaseHeld(ctxNow.db, ctxNow.run.id, ctxNow.ownerId, ctxNow.clock.now());
      return planWorker(ctxNow.db, { id: workerId, runId: ctxNow.run.id, role: 'curator', purpose, provider: adapter.id, model, effort: null, workerDir, cwd }, ctxNow.clock, ctxNow.ownerId);
    });
  } else {
    workerId = `${host.runId}-curator`;
    workerDir = join(host.dir, 'curator');
    mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  }

  const spec: TaskSpec & { maxBudgetUsd: number } = {
    runId: host.runId,
    workerId,
    role: 'curator',
    model,
    effort: null,
    cwd,
    workerDir,
    prompt: task.prompt,
    systemPrompt: renderSystemPrompt('curator', host.deps.agentsDir ? { agentsDir: host.deps.agentsDir } : {}),
    outputSchema: MODEL_OUTPUT_SCHEMAS.curator,
    readOnly: true,
    maxTurns: 3,
    timeoutMs,
    sandbox: profileForWorker({ worktree: cwd, workerDir, snapshot: host.snapshot, provider: 'claude', claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), homeDir: home, policyPath: host.policyPath, readablePaths: [host.deps.orbitInstallDir], env }),
    policyPath: host.policyPath,
    policyHash: host.policyHash,
    env: {},
    maxBudgetUsd: host.budgetUsd,
  };

  let handle: TaskHandle;
  try {
    handle = await adapter.startTask(spec);
  } catch (err) {
    if (ctx && row) finishWorker(ctx.db, row.id, { state: 'FAILED', resultStatus: 'failed', error: redact(err instanceof Error ? err.message : String(err)).slice(0, 2000) }, ctx.clock, ctx.ownerId);
    throw err;
  }
  if (ctx && row) row = markWorkerRunning(ctx.db, row.id, { pid: handle.pid, pgid: handle.pgid, procStart: handle.procStart }, ctx.clock, ctx.ownerId);

  const deadline = Date.now() + timeoutMs + 30_000;
  let result: TaskResult | null = null;
  let timedOut = false;
  for (;;) {
    result = await adapter.collectResult(handle, { outputSchema: MODEL_OUTPUT_SCHEMAS.curator });
    if (result) break;
    if (Date.now() > deadline) {
      timedOut = true;
      await adapter.cancelTask(handle);
      const stop = Date.now() + 5_000;
      while (!(result = await adapter.collectResult(handle, { outputSchema: MODEL_OUTPUT_SCHEMAS.curator })) && Date.now() < stop) await new Promise((res) => setTimeout(res, 100));
      break;
    }
    await new Promise((res) => setTimeout(res, 200));
  }

  if (ctx && row) {
    const done = finishWorker(ctx.db, row.id, result ? outcomeOf(result) : { state: 'LOST', resultStatus: 'lost', error: 'the curator did not stop after it timed out' }, ctx.clock, ctx.ownerId);
    if (result) {
      try {
        accountWorker(ctx, done, result, 'final');
      } catch (err) {
        ctx.log.warn('curator cost could not be charged', { error: err instanceof Error ? err.message : String(err) });
      }
    }
  }
  if (!result || timedOut) throw new OrbitError('PROVIDER_UNAVAILABLE', 'the curator timed out');
  if (result.status !== 'succeeded') {
    throw new OrbitError(result.status === 'auth_failed' ? 'AUTH_EXPIRED' : 'PROVIDER_UNAVAILABLE', `the curator ended ${result.status}${result.error ? `: ${redact(result.error).slice(0, 200)}` : ''}`);
  }
  return { output: result.structured, model, workerId: ctx ? workerId : null };
}
