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
import { join } from 'node:path';
import { atomicWrite, atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { redact } from '../core/redact.ts';
import { appendEvent } from '../storage/events.ts';
import { listDecisions } from '../storage/decisions.ts';
import { listWorkers } from '../storage/workers.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { Clock } from '../core/clock.ts';
import { listEvidenceReports } from '../evidence/store.ts';
import { listFindings, listReviews } from '../review/store.ts';
import { listLedger, listQuestions } from '../inquisition/store.ts';
import { summarizeUsage, recordUsage } from '../routing/usage.ts';
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
import type { TaskSpec } from '../adapters/types.ts';
import { getRun, type RunRecord } from './run-store.ts';
import { currentCandidate, homeOf, type RunContext } from './context.ts';
import { globalKnowledgePath, repoKnowledgePath } from './knowledge-hooks.ts';

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

/** Build and write final.md and final.json. Idempotent: the same records produce the same report. */
export function writeFinalReport(db: OrbitDb, runId: string, opts: WriteReportOptions): FinalReport {
  const run = getRun(db, runId);
  const report = buildFinalReport(db, run, opts);
  atomicWriteJson(join(opts.runDir, 'final.json'), report);
  atomicWrite(join(opts.runDir, 'final.md'), renderMarkdown(report));
  return report;
}

export function buildFinalReport(db: OrbitDb, run: RunRecord, opts: WriteReportOptions): FinalReport {
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
  const summary: { learn: LearnReport | null; skipped: string | null; settled: unknown; promoted: unknown } = { learn: null, skipped: null, settled: null, promoted: null };
  try {
    const admitted = curationAdmitted(ctx);
    if (run.state === 'CANCELLED') summary.skipped = 'cancelled runs are not curated';
    else if (!admitted.ok) summary.skipped = admitted.why;
    else summary.learn = await learnFromRun({ store, runDb: ctx.db, runId: run.id, runDir: ctx.runDir, clock: ctx.clock, curatorModel: admitted.model ?? 'claude-default', runCurator: (task) => runCurator(ctx, task, admitted.model) });

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
  } finally {
    store.close();
  }
  atomicWriteJson(join(ctx.runDir, 'learning.json'), summary);
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.completed', ctx.ownerId, { skipped: summary.skipped, created: summary.learn?.created.length ?? 0, merged: summary.learn?.merged.length ?? 0 }, ctx.clock.now()));
}

/** Curation spends from the closing reserve only when the reserve can still pay for it. */
function curationAdmitted(ctx: RunContext): { ok: true; model: string | null } | { ok: false; why: string } {
  const k = ctx.snapshot.config.knowledge;
  if (!(k.curator_budget_usd > 0)) return { ok: false, why: 'knowledge.curator_budget_usd is 0' };
  if (!ctx.deps.adapters.claude) return { ok: false, why: 'no claude adapter for the curator' };
  const ledger = ctx.db.get('SELECT 1 AS x FROM budget_counters WHERE run_id = ? LIMIT 1', ctx.run.id) ? new BudgetLedger(ctx.db, ctx.clock).attach(ctx.run.id, ctx.snapshot) : null;
  if (ledger) {
    const d = ledger.admit({ role: 'curator', estimatedCostUsd: k.curator_budget_usd, phase: 'final' });
    if (!d.admitted) return { ok: false, why: `the budget reserve cannot pay for curation: ${d.reasons.join('; ')}` };
  }
  const model = ctx.deps.registry.list().find((e) => e.provider === 'claude' && e.family === 'haiku' && e.surfaces.some((s) => s.surface === 'claude-cli' && s.available === true))?.modelId ?? null;
  return { ok: true, model };
}

/**
 * The curator runs after the run ended, so it has no worker row (the
 * workers table takes no new work for a terminal run); its intent is an
 * event written before the spawn, and its files live under learning/.
 * Bounded by its own timeout and the curator budget.
 */
async function runCurator(ctx: RunContext, task: { prompt: string }, model: string | null): Promise<unknown> {
  const adapter = ctx.deps.adapters.claude!;
  const n = Number(ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE run_id = ? AND type = 'learning.curator-planned'", ctx.run.id)?.n ?? 0) + 1;
  const workerId = `${ctx.run.id}-curator-${n}`;
  const workerDir = join(ctx.runDir, 'learning', `curator-${n}`);
  const cwd = join(ctx.runDir, 'learning', 'cwd');
  mkdirSync(workerDir, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  ctx.db.tx(() => appendEvent(ctx.db, ctx.run.id, 'learning.curator-planned', ctx.ownerId, { worker_id: workerId, model }, ctx.clock.now()));
  const env = ctx.deps.hostEnv ?? process.env;
  const home = homeOf(ctx.deps);
  const spec: TaskSpec & { maxBudgetUsd: number } = {
    runId: ctx.run.id,
    workerId,
    role: 'curator',
    model,
    effort: null,
    cwd,
    workerDir,
    prompt: task.prompt,
    systemPrompt: renderSystemPrompt('curator', ctx.deps.agentsDir ? { agentsDir: ctx.deps.agentsDir } : {}),
    outputSchema: MODEL_OUTPUT_SCHEMAS.curator,
    readOnly: true,
    maxTurns: 3,
    timeoutMs: CURATOR_TIMEOUT_MS,
    sandbox: profileForWorker({ worktree: cwd, workerDir, snapshot: ctx.snapshot, provider: 'claude', claudeConfigDir: env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), homeDir: home, policyPath: ctx.run.policyPath, readablePaths: [ctx.deps.orbitInstallDir], env }),
    policyPath: ctx.run.policyPath,
    policyHash: ctx.run.policyHash,
    env: {},
    maxBudgetUsd: ctx.snapshot.config.knowledge.curator_budget_usd,
  };
  const handle = await adapter.startTask(spec);
  const deadline = Date.now() + CURATOR_TIMEOUT_MS + 30_000;
  for (;;) {
    const r = await adapter.collectResult(handle, { outputSchema: MODEL_OUTPUT_SCHEMAS.curator });
    if (r) {
      recordUsage(ctx.db, { runId: ctx.run.id, workerId: null, provider: adapter.id, usage: r.usage, durationMs: r.durationMs }, ctx.clock);
      if (r.status !== 'succeeded') throw new Error(`curator ended ${r.status}${r.error ? `: ${r.error.slice(0, 200)}` : ''}`);
      return r.structured;
    }
    if (Date.now() > deadline) {
      await adapter.cancelTask(handle);
      throw new Error('curator timed out');
    }
    await new Promise((res) => setTimeout(res, 200));
  }
}
