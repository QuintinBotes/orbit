/**
 * The spend request of a run that reached its model cost cap (issue #254). The run waits BLOCKED on a material question
 * only a person can answer; approving raises that run's cap by its original cap, refusing ends it. While it waits, one
 * file in the owner's stack inbox says so (the spend contract of the claude-stack side):
 *
 *   ${XDG_STATE_HOME:-~/.local/state}/stack/inbox/spend/<id>.json  { title, usd, tradeoff, recommendation, command, at }
 *
 * The request is recorded as a `budget.spend-requested` event, which also says where its file is, so it is removed by
 * whoever ends the wait, whatever their environment says. An approval is a decision record the budget ledger adds to
 * the cap (scheduling/budget.ts); the frozen policy and the contract never change.
 */
import { chmodSync, mkdirSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { Clock } from '../core/clock.ts';
import { atomicWriteJson } from '../core/fsx.ts';
import { sha256 } from '../core/hash.ts';
import { isHumanActor } from '../inquisition/actors.ts';
import { findQuestion, insertQuestion, type QuestionRecord } from '../inquisition/store.ts';
import { SPEND_APPROVED_KIND } from '../scheduling/budget.ts';
import type { BudgetPhase } from '../scheduling/types.ts';
import type { OrbitDb } from '../storage/db.ts';
import { getDecision, recordDecision } from '../storage/decisions.ts';
import { appendEvent } from '../storage/events.ts';
import { shellQuote } from '../ui/runner.ts';
import { homeOf, type RunContext } from './context.ts';

import { removeSpendFiles, SPEND_REQUEST_EVENT } from './spend-files.ts';

export { removeSpendFiles, SPEND_REQUEST_EVENT };
export const SPEND_APPROVE = 'approve';
export const SPEND_REFUSE = 'refuse';
const EPS = 1e-9;

export interface SpendRequest {
  question_id: string;
  spent_usd: number;
  /** The cap the run reached. */
  cap_usd: number;
  /** What approving adds: the run's original cap. */
  increment_usd: number;
  /** The cap once approved, and the most the run can be allowed to spend then. */
  total_usd: number;
  phase: BudgetPhase;
  /** The command that approves it. */
  command: string;
  /** Where its file in the owner's inbox is. */
  file: string;
}

/**
 * `unanswered` is an answer that neither approves nor refuses (or a withdrawn question): nothing was granted, so the
 * run asks again if it is still at its cap.
 */
export type SpendStatus = 'open' | 'approved' | 'refused' | 'unanswered';

const money = (n: number): string => `$${n.toFixed(2)}`;
const roundUsd = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

/** The folder of the owner's spend inbox. A relative XDG_STATE_HOME is ignored, as the XDG specification says. */
export function spendInboxDir(env: Readonly<Record<string, string | undefined>>, homeDir: string): string {
  const xdg = env.XDG_STATE_HOME;
  return join(xdg && isAbsolute(xdg) ? xdg : join(homeDir, '.local', 'state'), 'stack', 'inbox', 'spend');
}

/** Stable per run and requested budget, so asking again replaces the file. */
export function spendFileId(runId: string, totalUsd: number): string {
  return `orbit-${runId}-${String(roundUsd(totalUsd)).replace('.', '_')}`;
}

/**
 * Write one inbox file atomically: a temporary file beside it whose name does not end in .json, renamed over it
 * (core/fsx.ts atomicWrite), mode 0600 in a folder of mode 0700.
 */
export function writeSpendFile(path: string, body: { title: string; usd: number; tradeoff: string; recommendation: string; command: string; at: string }): void {
  const dir = join(path, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  atomicWriteJson(path, body, 0o600);
}

export function spendRequests(db: OrbitDb, runId: string): SpendRequest[] {
  return db
    .all<{ data_json: string }>('SELECT data_json FROM events WHERE run_id = ? AND type = ? ORDER BY id', runId, SPEND_REQUEST_EVENT)
    .map((r) => JSON.parse(r.data_json) as SpendRequest);
}

/** The newest spend request of the run and where it stands, or null when it never asked. */
export function currentSpend(db: OrbitDb, runId: string): { request: SpendRequest; question: QuestionRecord | null; status: SpendStatus } | null {
  const request = spendRequests(db, runId).at(-1);
  if (!request) return null;
  const question = findQuestion(db, request.question_id);
  const status: SpendStatus =
    question?.status === 'open'
      ? 'open'
      : question?.status === 'answered' && question.answeredBy !== null && isHumanActor(question.answeredBy) && (question.answer === SPEND_APPROVE || question.answer === SPEND_REFUSE)
        ? question.answer === SPEND_APPROVE
          ? 'approved'
          : 'refused'
        : 'unanswered';
  return { request, question, status };
}

/** The request the run waits on (or was refused): no further model session may start for it. Null otherwise. */
export function spendHeld(db: OrbitDb, runId: string): SpendRequest | null {
  const s = currentSpend(db, runId);
  return s && s.status !== 'approved' ? s.request : null;
}

/** Remove every inbox file the run's requests wrote. Missing files are fine. */

/**
 * Apply the person's answer to the run's newest request: an approval is recorded as the decision that raises the cap,
 * and either answer removes the file. Idempotent. Not to be called inside a transaction.
 */
export function applySpendAnswer(input: { db: OrbitDb; clock: Clock; runDir: string }, runId: string): ReturnType<typeof currentSpend> {
  const s = currentSpend(input.db, runId);
  if (!s || (s.status !== 'approved' && s.status !== 'refused')) return s;
  const by = s.question!.answeredBy!;
  const id = `dec-spend-${s.request.question_id}`;
  if (s.status === 'approved' && !getDecision(input.db, id)) {
    recordDecision(
      input.db,
      input.runDir,
      {
        id,
        runId,
        kind: SPEND_APPROVED_KIND,
        summary: `${by} approved ${money(s.request.increment_usd)} more model spend: the cost cap is ${money(s.request.total_usd)}`,
        data: { question_id: s.request.question_id, increment_usd: s.request.increment_usd, total_usd: s.request.total_usd, approved_by: by },
      },
      input.clock,
      { actor: by },
    );
  }
  removeSpendFiles(input.db, runId);
  return s;
}

/**
 * Whether money stops the run, so it asks for more: its charged cost has reached what its phase may spend, or (a
 * `refusal`) the next session could not be funded from what is left. Sessions are funded below the limit, holding back
 * one worst-case request, so a refusal usually comes before charged cost reaches it. Nothing charged is never a reason
 * to ask: a cap too small for the first session ends the run as it always did (the owner's decision on #254).
 */
export function atCostCap(ctx: RunContext, phase: BudgetPhase, opts: { refusal?: boolean } = {}): boolean {
  if (!ctx.ledger || !ctx.policyVerified || ctx.deps.spendRequests === false) return false;
  const cost = ctx.ledger.state('cost_usd');
  if (cost.used <= 0) return false;
  if (opts.refusal === true) return true;
  const limit = phase === 'final' ? cost.hard_cap : cost.hard_cap - ctx.ledger.reserve().cost_usd;
  return cost.used >= limit - EPS;
}

/**
 * Ask for more spend: the question, its record and the inbox file. Asking again for the same total reuses the open
 * question and replaces the file.
 */
export function requestSpend(ctx: RunContext, phase: BudgetPhase): SpendRequest {
  const ledger = ctx.ledger!;
  const runId = ctx.run.id;
  const cost = ledger.state('cost_usd');
  const increment = ctx.snapshot.config.scheduler.hard_limits.model_cost_usd;
  const total = roundUsd(cost.hard_cap + increment);
  const earlier = spendRequests(ctx.db, runId).filter((r) => r.total_usd === total);
  const last = earlier.at(-1);
  let request = last && findQuestion(ctx.db, last.question_id)?.status === 'open' ? last : null;

  if (!request) {
    // Never the shape of a generated question id (q-<hex>), so no inquiry's question is read as a spend request.
    const questionId = `q-spend-${sha256(`${runId}:${total}`).slice(0, 10)}${earlier.length > 0 ? `-${earlier.length + 1}` : ''}`;
    const decide = `orbit decide ${runId} ${questionId}`;
    const repo = `--repo ${shellQuote(ctx.run.repoRoot)}`;
    const created: SpendRequest = {
      question_id: questionId,
      spent_usd: roundUsd(cost.used),
      cap_usd: cost.hard_cap,
      increment_usd: increment,
      total_usd: total,
      phase,
      command: `${decide} ${SPEND_APPROVE} ${repo}`,
      file: join(spendInboxDir(ctx.deps.hostEnv ?? process.env, homeOf(ctx.deps)), `${spendFileId(runId, total)}.json`),
    };
    ctx.db.tx(() => {
      insertQuestion(
        ctx.db,
        {
          id: questionId,
          runId,
          mode: 'decision-record',
          question: `Run ${runId} reached its model cost cap: ${money(created.spent_usd)} spent of the ${money(created.cap_usd)} cap. May it spend ${money(increment)} more (a new cap of ${money(total)})? To approve: ${created.command}`,
          evidence: [`charged model cost ${money(created.spent_usd)}, cap ${money(created.cap_usd)}`],
          options: [
            { label: SPEND_APPROVE, description: `raise this run's cost cap by ${money(increment)} to ${money(total)}`, consequences: 'the run continues and may spend up to the new cap' },
            { label: SPEND_REFUSE, description: 'spend nothing more', consequences: 'the run ends EXHAUSTED with its work preserved' },
          ],
          changes: ['authority'],
          recommendation: { option: SPEND_REFUSE, reason: 'approve only if the progress so far is worth the extra spend' },
          safeDefault: { exists: false, option: null, reason: 'more spend needs a person' },
          material: true,
          affected: ['model spend'],
          unblocked: [],
        },
        ctx.clock,
        ctx.ownerId,
      );
      appendEvent(ctx.db, runId, SPEND_REQUEST_EVENT, ctx.ownerId, created, ctx.clock.now());
    });
    request = created;
  }

  try {
    writeSpendFile(request.file, {
      title: `Orbit run ${runId} reached its ${money(request.cap_usd)} model cost cap`,
      usd: request.total_usd,
      tradeoff: `Approving lets this run spend up to ${money(request.total_usd)} in total: ${money(request.increment_usd)} more than its ${money(request.cap_usd)} cap, of which ${money(request.spent_usd)} is spent. Refusing ends it EXHAUSTED with its work preserved.`,
      recommendation: `Approve only if the progress so far is worth up to ${money(request.increment_usd)} more (orbit status ${runId} shows it). Otherwise refuse: orbit decide ${runId} ${request.question_id} ${SPEND_REFUSE} --repo ${shellQuote(ctx.run.repoRoot)}`,
      command: request.command,
      at: new Date(ctx.clock.now()).toISOString(),
    });
  } catch (err) {
    // The question still holds the run and names the command; only the inbox does not show it.
    ctx.db.tx(() => appendEvent(ctx.db, runId, 'budget.spend-file-failed', ctx.ownerId, { file: request.file, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) }, ctx.clock.now()));
    ctx.log.warn('could not write the spend request file', { file: request.file });
  }
  return request;
}

/** What the outcome reason of a run waiting on a request says, ending with the command. */
export function spendWaitingSentence(r: SpendRequest): string {
  return `Waiting for a person to approve more model spend: ${money(r.spent_usd)} spent of the ${money(r.cap_usd)} cap; approving adds ${money(r.increment_usd)} (new cap ${money(r.total_usd)}). To refuse, answer ${SPEND_REFUSE}; to approve: ${r.command}`;
}
