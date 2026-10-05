/** `orbit decide` records a person's answer to a persisted question; `orbit questions` lists them. */
import { dirname } from 'node:path';
import { OrbitError } from '../../core/errors.ts';
import { isTerminal } from '../../controller/states.ts';
import { answerQuestion, listQuestions, openQuestions, type QuestionRecord } from '../../inquisition/index.ts';
import type { OrbitDb } from '../../storage/db.ts';
import type { Args, OptionSpec } from '../args.ts';
import { findRunByPrefix, resolveRepo, withState, type CliContext } from '../context.ts';
import { EXIT, UsageError } from '../exit.ts';
import { json, line, oneLine } from '../io.ts';

export const DECIDE_OPTIONS: OptionSpec = {
  by: { type: 'string', description: 'who is deciding (default: your user name). Models, workers and subsystems cannot decide', valueName: 'name' },
};

export const QUESTIONS_OPTIONS: OptionSpec = {
  all: { type: 'boolean', description: 'include answered and withdrawn questions' },
};

function matchQuestion(db: OrbitDb, runId: string, ref: string): QuestionRecord {
  const all = listQuestions(db, runId);
  const exact = all.find((q) => q.id === ref);
  if (exact) return exact;
  const hits = ref.length >= 3 ? all.filter((q) => q.id.startsWith(ref)) : [];
  if (hits.length === 1) return hits[0]!;
  if (hits.length > 1) throw new OrbitError('NOT_FOUND', `"${ref}" matches more than one question of run ${runId} (${hits.map((q) => q.id).join(', ')})`);
  throw new OrbitError('NOT_FOUND', `run ${runId} has no question ${ref}${all.length ? `; its questions: ${all.map((q) => q.id).join(', ')}` : ' (it has asked none)'}`);
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
  return withState(repo, (db) => {
    const run = findRunByPrefix(db, runRef);
    if (isTerminal(run.state) && run.state !== 'BLOCKED') throw new OrbitError('TRANSITION_INVALID', `run ${run.id} is ${run.state}; its questions can no longer change anything`);
    const q = matchQuestion(db, run.id, qRef);
    const result = answerQuestion(db, dirname(run.policyPath), q.id, answer, by, ctx.clock);
    const remaining = openQuestions(db, run.id);
    if (args.bool('json')) {
      json(ctx.io, { run_id: run.id, question_id: q.id, answer: result.question.answer, chosen_option: result.chosenOption?.label ?? null, decision_id: result.decision.id, unblocks: result.unblocks, open_questions: remaining.map((x) => x.id), run_state: run.state });
      return EXIT.OK;
    }
    line(ctx.io, `recorded ${result.decision.id}: ${result.chosenOption ? `chose option ${result.chosenOption.label}` : 'free-text answer'} by ${by}`);
    if (result.unblocks.length > 0) line(ctx.io, `unblocks: ${result.unblocks.join(', ')}`);
    if (remaining.length > 0) line(ctx.io, `${remaining.length} question(s) still open: ${remaining.map((x) => x.id).join(', ')}`);
    if (run.state === 'BLOCKED') line(ctx.io, `The run is BLOCKED. Continue it with: orbit resume ${run.id}`);
    else line(ctx.io, 'A controller picks the answer up at the run\'s next inquiry; nothing else is needed.');
    return EXIT.OK;
  });
}

export async function questionsCommand(args: Args, ctx: CliContext): Promise<number> {
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
