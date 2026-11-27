/** `orbit decide` records a person's answer to a persisted question; `orbit questions` lists them. */
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { OrbitError, isOrbitError } from '../../core/errors.ts';
import { isTerminal } from '../../controller/states.ts';
import { getRun, listRuns, transition, type RunRecord } from '../../controller/run-store.ts';
import { loadRunContext } from '../../controller/context.ts';
import { resumeTarget } from '../../controller/resume.ts';
import { holdForSpend } from '../../controller/steps/common.ts';
import { applySpendAnswer, spendRequests, SPEND_APPROVE, SPEND_REFUSE, type SpendRequest } from '../../controller/spend-request.ts';
import { cliLeaseDeps } from './control.ts';
import { declinesLedger } from '../../controller/undecided-ledger.ts';
import { stateDbPath } from '../../controller/start.ts';
import { amendmentIdOfQuestion, answerQuestion, applyAmendmentAnswers, listQuestions, openQuestions, type AmendmentAnswerOutcome, type QuestionRecord } from '../../inquisition/index.ts';
import { appendEvent } from '../../storage/events.ts';
import { redact } from '../../core/redact.ts';
import type { BaselineApplyOutcome } from '../../inquisition/baseline-exception.ts';
import type { OrbitDb } from '../../storage/db.ts';
import type { Args, OptionSpec } from '../args.ts';
import { continueCommand, findRunByPrefix, resolveRepo, withCliLease, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, line, oneLine } from '../io.ts';

export const DECIDE_OPTIONS: OptionSpec = {
  by: { type: 'string', description: 'who is deciding (default: your user name). Models, workers and subsystems cannot decide', valueName: 'name' },
};

export const QUESTIONS_OPTIONS: OptionSpec = {
  all: { type: 'boolean', description: 'include answered and withdrawn questions' },
  pending: { type: 'boolean', description: 'instead of one run: the open questions of every unfinished run in the repository' },
  quiet: { type: 'boolean', description: 'with --pending: print nothing when no question is open (what the SessionStart hook uses)' },
};

export const QUESTIONS_USAGE = 'orbit questions <run-id> [--all] [--json]   |   orbit questions --pending [--quiet] [--json]';

function matchQuestion(db: OrbitDb, runId: string, ref: string): QuestionRecord {
  const all = listQuestions(db, runId);
  const exact = all.find((q) => q.id === ref);
  if (exact) return exact;
  // Ids are lower case; "Q-8F50" typed from a screen is the same question.
  const lower = ref.toLowerCase();
  const hits = ref.length >= 3 ? all.filter((q) => q.id.toLowerCase().startsWith(lower)) : [];
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new OrbitError('NOT_FOUND', `"${ref}" matches more than one question of run ${runId} (${hits.map((q) => q.id).join(', ')})`);
  throw new OrbitError('NOT_FOUND', `run ${runId} has no question ${ref}${all.length ? `; its questions: ${all.map((q) => q.id).join(', ')}` : ' (it has asked none)'}`);
}

/** What an answer to a baseline-exception question did to the contract, in one line. */
function describeBaselineException(o: BaselineApplyOutcome): string {
  const check = `check ${o.checkId}`;
  const why = o.detail ? ` (${oneLine(o.detail, 200)})` : '';
  switch (o.status) {
    case 'applied':
      return `baseline exception recorded: the contract now accepts the pre-existing failure of ${check}, bound to its recorded fingerprint`;
    case 'already-applied':
      return `baseline exception for ${check} was already in the contract`;
    case 'deferred':
      return `baseline exception for ${check} approved; it is applied as soon as the run has a contract`;
    case 'refused':
      return `baseline exception for ${check} refused${why}: the contract is unchanged`;
    default:
      return `baseline exception for ${check} not accepted${why}: the contract is unchanged`;
  }
}

/** What an answer to a contract amendment's approval question did to the contract, in one line. */
function describeAmendment(o: AmendmentAnswerOutcome): string {
  const why = o.detail ? ` (${oneLine(o.detail, 200)})` : '';
  switch (o.status) {
    case 'applied':
      return `amendment ${o.amendmentId} applied: the run continues on the amended contract, and its evidence is checked again`;
    case 'rejected':
      return `amendment ${o.amendmentId} rejected${why}: the contract is unchanged`;
    case 'deferred':
      return `amendment ${o.amendmentId} approved; it is applied as soon as the run has a contract`;
    default:
      return `amendment ${o.amendmentId} not applied${why}: the contract is unchanged`;
  }
}

export async function decideCommand(args: Args, ctx: CliContext): Promise<number> {
  const usage = 'orbit decide <run-id> <question-id> <answer...>';
  const [runRef, qRef, ...rest] = args.positionals;
  if (!runRef || !qRef) throw new UsageError('a run id, a question id and an answer are required', usage);
  let answer = rest.join(' ').trim();
  if (answer === '-') answer = (await ctx.io.readStdin()).trim();
  if (!answer) throw new UsageError('an answer is required (an option label such as "A", or free text)', usage);
  const repo = await resolveRepo(ctx, args.str('repo'));
  const by = (args.str('by') ?? ctx.user).trim();
  return withState(repo, async (db) => {
    const run = findRunByPrefix(db, runRef);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is ${run.state}; its questions can no longer change anything`);
    const q = matchQuestion(db, run.id, qRef);
    const runDir = dirname(run.policyPath);
    const spend = spendRequests(db, run.id).find((r) => r.question_id === q.id);
    if (spend) return decideSpend(args, ctx, { db, repo, run, request: spend, answer, by });
    const result = answerQuestion(db, runDir, q.id, answer, by, ctx.clock);
    // The answer to a contract amendment's approval question is applied to the run's contract now, while the person
    // is answering; a failure here is retried by the controller at its next safe point.
    let amendment: AmendmentAnswerOutcome | null = null;
    if (amendmentIdOfQuestion(q.id) !== null) {
      try {
        amendment = applyAmendmentAnswers({ db, clock: ctx.clock, runId: run.id, runDir }, { questionId: q.id }).outcomes[0] ?? null;
      } catch (err) {
        db.tx(() => appendEvent(db, run.id, 'amendment.apply-failed', by, { question_id: q.id, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 500) }, ctx.clock.now()));
      }
    }
    const remaining = openQuestions(db, run.id);
    if (args.bool('json')) {
      json(ctx.io, { run_id: run.id, question_id: q.id, answer: result.question.answer, chosen_option: result.chosenOption?.label ?? null, decision_id: result.decision.id, unblocks: result.unblocks, baseline_exception: result.baselineException, amendment, open_questions: remaining.map((x) => x.id), run_state: run.state });
      return EXIT.OK;
    }
    line(ctx.io, `recorded ${result.decision.id}: ${result.chosenOption ? `chose option ${result.chosenOption.label}` : 'free-text answer'} by ${by}`);
    if (result.baselineException) line(ctx.io, describeBaselineException(result.baselineException));
    if (amendment) line(ctx.io, describeAmendment(amendment));
    if (result.unblocks.length > 0) line(ctx.io, `unblocks: ${result.unblocks.join(', ')}`);
    if (remaining.length > 0) line(ctx.io, `${remaining.length} question(s) still open: ${remaining.map((x) => x.id).join(', ')}`);
    // A declined needs-decision ledger entry keeps the run from success, and a resume would only block again on it.
    if (run.state === 'BLOCKED' && declinesLedger(db, run.id, q.id, answer)) {
      line(ctx.io, `The run cannot succeed with a decision a person declined, so resuming would only block again: "orbit cancel ${run.id}" and start a new run whose goal states the decision, with "orbit run".`);
    } else if (run.state === 'BLOCKED') line(ctx.io, `The run is BLOCKED. Continue it with: ${continueCommand(db, run.id, ctx.clock.now())}`);
    else line(ctx.io, 'A controller picks the answer up at the run\'s next inquiry; nothing else is needed.');
    return EXIT.OK;
  });
}

/**
 * A person's answer to a spend request (issue #254). Only "approve" and "refuse" are answers: free text grants nothing,
 * so it is not recorded. A model, worker or subsystem is refused by answerQuestion, as for any question (and the CLI
 * refuses `decide` in a worker process altogether). The answer also releases the block: an approved run goes back to the
 * stage it stopped in, and a refused one is ended here, EXHAUSTED, with no session started.
 */
async function decideSpend(args: Args, ctx: CliContext, input: { db: OrbitDb; repo: string; run: RunRecord; request: SpendRequest; answer: string; by: string }): Promise<number> {
  const { db, repo, run, request, by } = input;
  const word = input.answer.toLowerCase();
  if (word !== SPEND_APPROVE && word !== SPEND_REFUSE) throw new UsageError(`question ${request.question_id} asks for more model spend: answer "${SPEND_APPROVE}" or "${SPEND_REFUSE}"`, 'orbit decide <run-id> <question-id> approve|refuse');
  const runDir = dirname(run.policyPath);
  const result = answerQuestion(db, runDir, request.question_id, word, by, ctx.clock);
  const approved = word === SPEND_APPROVE;
  applySpendAnswer({ db, clock: ctx.clock, runDir }, run.id);

  let ownedElsewhere = false;
  const current = getRun(db, run.id);
  if (current.state === 'BLOCKED' && !current.cancelRequested) {
    try {
      await withCliLease(ctx, db, run.id, async (ownerId) => {
        // Loaded first: a run whose policy no longer verifies is left BLOCKED.
        const rc = loadRunContext(cliLeaseDeps(ctx, repo, db, ownerId), run.id, new AbortController().signal);
        const to = resumeTarget(db, current);
        db.tx(() => {
          transition(db, { runId: run.id, to, ownerId, reason: `${by} ${approved ? 'approved' : 'refused'} more model spend`, actor: `cli:${ctx.user}`, expectedFrom: 'BLOCKED' }, ctx.clock);
          appendEvent(db, run.id, 'run.resumed', `cli:${ctx.user}`, { from: 'BLOCKED', to, forced: false, by: 'spend-answer' }, ctx.clock.now());
        });
        if (!approved) {
          rc.refresh();
          await holdForSpend(rc);
        }
      });
    } catch (err) {
      if (!isOrbitError(err, 'CONCURRENT_UPDATE')) throw err;
      ownedElsewhere = true;
    }
  }

  const after = getRun(db, run.id);
  if (args.bool('json')) {
    json(ctx.io, { run_id: run.id, question_id: request.question_id, answer: word, decision_id: result.decision.id, cap_usd: approved ? request.total_usd : request.cap_usd, run_state: after.state });
    return EXIT.OK;
  }
  line(ctx.io, `recorded ${result.decision.id}: ${word} by ${by}`);
  if (approved) line(ctx.io, `the cost cap of run ${run.id} is now $${request.total_usd.toFixed(2)} (was $${request.cap_usd.toFixed(2)}); the spend request file is removed`);
  else line(ctx.io, `no more model spend for run ${run.id}; the spend request file is removed`);
  if (ownedElsewhere) line(ctx.io, 'A controller holds the run and applies the answer at its next safe point.');
  else if (approved) line(ctx.io, `run ${run.id} is released at ${after.state}. A running service continues it; otherwise: ${continueCommand(db, run.id, ctx.clock.now())}`);
  else line(ctx.io, `run ${run.id} is ${after.state}: ${oneLine(after.outcomeReason ?? '', 600)}`);
  return EXIT.OK;
}

export async function questionsCommand(args: Args, ctx: CliContext): Promise<number> {
  if (args.bool('pending')) return pendingQuestions(args, ctx);
  if (args.bool('quiet')) throw new UsageError('--quiet goes with --pending', QUESTIONS_USAGE);
  const [runRef] = args.expect(1);
  const repo = await resolveRepo(ctx, args.str('repo'));
  return withState(repo, (db) => {
    const run = findRunByPrefix(db, runRef!);
    const qs = args.bool('all') ? listQuestions(db, run.id) : openQuestions(db, run.id);
    if (args.bool('json')) {
      json(ctx.io, qs);
      return EXIT.OK;
    }
    if (qs.length === 0) {
      line(ctx.io, args.bool('all') ? `run ${run.id} has asked no questions` : `run ${run.id} has no open questions`);
      return EXIT.OK;
    }
    for (const q of qs) {
      line(ctx.io, `${q.id}  [${q.status}]${q.material ? ' [material]' : ''}  ${oneLine(q.question, 300)}`);
      if (q.evidence.length > 0) line(ctx.io, `  evidence: ${q.evidence.map((e) => oneLine(e, 160)).join(' | ')}`);
      for (const o of q.options) line(ctx.io, `  ${o.label}) ${oneLine(o.description, 200)}${o.consequences ? ` (consequences: ${oneLine(o.consequences, 200)})` : ''}`);
      if (q.recommendation) line(ctx.io, `  recommended: ${q.recommendation.option} (${oneLine(q.recommendation.reason, 200)})`);
      if (q.safeDefault?.exists) line(ctx.io, `  safe default: ${q.safeDefault.option ?? 'yes'} (${oneLine(q.safeDefault.reason, 200)})`);
      if (q.affected.length > 0) line(ctx.io, `  blocks: ${q.affected.join(', ')}`);
      if (q.status === 'answered') line(ctx.io, `  answered by ${q.answeredBy}: ${oneLine(q.answer ?? '', 200)}`);
    }
    if (qs.some((q) => q.status === 'open')) line(ctx.io, `\nAnswer with: orbit decide ${run.id} <question-id> <answer>`);
    return EXIT.OK;
  });
}

/**
 * `orbit questions --pending`: the open questions of every run that can still use an answer (unfinished, or BLOCKED),
 * for the SessionStart hook and anyone returning to the repository. Before any run exists there is nothing pending.
 */
async function pendingQuestions(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  if (args.bool('all')) throw new UsageError('--all and --pending cannot be combined', QUESTIONS_USAGE);
  const quiet = args.bool('quiet');
  const repo = await resolveRepo(ctx, args.str('repo'));
  const pending: { run: { id: string; state: string }; questions: QuestionRecord[] }[] = [];
  if (existsSync(stateDbPath(repo))) {
    await withState(repo, (db) => {
      for (const run of listRuns(db, { limit: 200 })) {
        if (isTerminal(run.state) && run.state !== 'BLOCKED') continue;
        const qs = openQuestions(db, run.id);
        if (qs.length > 0) pending.push({ run: { id: run.id, state: run.state }, questions: qs });
      }
    });
  }
  if (args.bool('json')) {
    json(ctx.io, pending.map((p) => ({ run_id: p.run.id, state: p.run.state, questions: p.questions })));
    return EXIT.OK;
  }
  if (pending.length === 0) {
    if (!quiet) line(ctx.io, 'no open questions in this repository');
    return EXIT.OK;
  }
  for (const { run, questions } of pending) {
    line(ctx.io, `run ${run.id} (${run.state}): ${questions.length} open question(s)`);
    for (const q of questions) {
      line(ctx.io, `  ${q.id}${q.material ? ' [material]' : ''}  ${oneLine(q.question, 300)}`);
      if (q.recommendation) line(ctx.io, `    recommended: ${q.recommendation.option}`);
    }
    line(ctx.io, `  answer with: orbit decide ${run.id} <question-id> <answer>, or /orbit:inquisition --run ${run.id}`);
  }
  return EXIT.OK;
}
