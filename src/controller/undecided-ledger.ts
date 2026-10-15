/**
 * Needs-decision entries of the assumption ledger before success (spec section 10 "Ledger"). The Inquisition records an
 * entry as needs-decision for a choice it will not guess (a decision it refused to make on its own, a hidden decision,
 * sources of equal authority that disagree), and only a person's answer moves one on. A run that ends SUCCEEDED with
 * one open went ahead on a choice nobody made: on the 0.3.0 retest a run recorded three in two inquiries, asked nobody,
 * and succeeded. So, as CONTRACTING does for a needs-decision assumption, every open entry goes to a person before
 * delivery and success:
 *
 * - an entry an inquiry derived from its trigger while it put questions to a person was asked about through them, and
 *   a person's answer to one of them settles it;
 * - every other open entry is named in one question: `accept` settles each for this run, any other answer keeps the run
 *   from success (the choice is not this run's to make; a new run whose goal states it is the way forward).
 *
 * A settled entry becomes supported on the answer's decision record, the only evidence the ledger takes for it. Which
 * questions stand for which entries is recorded as a decision, so a restarted controller judges the same way.
 */
import { hashObject } from '../core/hash.ts';
import { answerDecisionId, isHumanActor } from '../inquisition/actors.ts';
import { transitionAssumption } from '../inquisition/ledger.ts';
import { findQuestion, insertQuestion, listLedger, type LedgerRecord, type QuestionRecord } from '../inquisition/store.ts';
import { getDecision, listDecisions } from '../storage/decisions.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { RunContext } from './context.ts';
import { decide, finishRun, type StepResult } from './steps/common.ts';

export const LEDGER_ASKED_KIND = 'inquisition.ledger-asked';
export const ACCEPT_LEDGER_DECISIONS = 'accept';
export const DECLINE_LEDGER_DECISIONS = 'decline';

interface AskedData {
  /** The needs-decision entries the questions stand for. */
  ledger_ids: string[];
  question_ids: string[];
  /** any: a person's answer to one of the questions settles the entries (an inquiry's questions); accept: only that answer does. */
  settles_on: 'any' | 'accept';
}

function askedRecords(ctx: RunContext): AskedData[] {
  return listDecisions(ctx.db, ctx.run.id, { kind: LEDGER_ASKED_KIND }).map((d) => d.data as AskedData);
}

function recordAsked(ctx: RunContext, data: AskedData, summary: string): void {
  const id = `dec-${ctx.run.id}-ledger-asked-${hashObject(data).slice(7, 23)}`;
  if (!getDecision(ctx.db, id)) decide(ctx, { id, kind: LEDGER_ASKED_KIND, summary, data });
}

/**
 * INQUISITION: the needs-decision entries an inquiry derived from its trigger (they carry its marker) were asked about
 * through the questions it put to a person. An entry the inquisitor added on a matter of its own, or an earlier inquiry's
 * entry this one only met again, was not, and is asked about before success.
 */
export function recordAskedLedger(ctx: RunContext, triggerKey: string, ledger: readonly LedgerRecord[], questions: readonly QuestionRecord[]): void {
  const marker = `trigger:${triggerKey}`;
  const ids = [...new Set(ledger.filter((e) => e.status === 'needs-decision' && e.evidence.some((x) => x.ref === marker)).map((e) => e.id))].sort();
  const asked = [...new Set(questions.map((q) => q.id))].sort();
  if (ids.length === 0 || asked.length === 0) return;
  recordAsked(ctx, { ledger_ids: ids, question_ids: asked, settles_on: 'any' }, `${ids.join(', ')} asked about through question(s) ${asked.join(', ')} (inquiry ${triggerKey})`.slice(0, 1000));
}

/**
 * Whether `answer` to `questionId` declines needs-decision entries: the question was asked about them so that only
 * `accept` settles them, and the answer is anything else. The run then cannot succeed (blockOnUndecidedLedger).
 */
export function declinesLedger(db: OrbitDb, runId: string, questionId: string, answer: string): boolean {
  if (answer.trim().toLowerCase() === ACCEPT_LEDGER_DECISIONS) return false;
  return listDecisions(db, runId, { kind: LEDGER_ASKED_KIND }).some((d) => {
    const a = d.data as Partial<AskedData> | null;
    return a?.settles_on === 'accept' && Array.isArray(a.question_ids) && a.question_ids.includes(questionId);
  });
}

export function ledgerQuestionId(runId: string, ledgerIds: readonly string[]): string {
  return `q-ledger-${hashObject({ run: runId, entries: [...ledgerIds].sort() }).slice(7, 19)}`;
}

function answeredByPerson(q: QuestionRecord | null): q is QuestionRecord & { answer: string; answeredBy: string } {
  return q !== null && q.status === 'answered' && q.answer !== null && q.answeredBy !== null && isHumanActor(q.answeredBy);
}

function accepts(q: QuestionRecord): boolean {
  return (q.answer ?? '').trim().toLowerCase() === ACCEPT_LEDGER_DECISIONS;
}

/** Settle `e` on a person's answer to `q`; false when the ledger refuses it (the answer's decision record is missing). */
function settle(ctx: RunContext, e: LedgerRecord, q: QuestionRecord & { answer: string; answeredBy: string }): boolean {
  try {
    transitionAssumption(ctx.db, e.id, 'supported', [{ kind: 'decision', ref: answerDecisionId(q.id), note: `${q.answeredBy} answered ${q.id}: ${q.answer.slice(0, 200)}` }], ctx.clock, 'controller');
    return true;
  } catch {
    return false;
  }
}

function ask(ctx: RunContext, entries: readonly LedgerRecord[]): QuestionRecord {
  const ids = entries.map((e) => e.id);
  const id = ledgerQuestionId(ctx.run.id, ids);
  const named = ids.join(', ');
  const q =
    findQuestion(ctx.db, id) ??
    insertQuestion(
      ctx.db,
      {
        id,
        runId: ctx.run.id,
        mode: 'decision-record',
        question: `Accept the ${ids.length === 1 ? 'decision' : 'decisions'} this run recorded without a person: ${named}?`,
        evidence: [
          'only a person may settle a needs-decision entry of the assumption ledger, and the run cannot succeed while one is open',
          ...entries.map((e) => `${e.id} (${e.source}; ${e.reversibility}; if wrong: ${e.consequence ?? 'not stated'}): ${e.claim.slice(0, 500)}`),
        ],
        options: [
          { label: ACCEPT_LEDGER_DECISIONS, description: `Accept ${named} as recorded, for this run`, consequences: 'each entry is settled on your answer and reported as supported; the run goes on to delivery after orbit resume' },
          { label: DECLINE_LEDGER_DECISIONS, description: `Do not accept ${named}`, consequences: 'the run cannot succeed with these decisions and stays blocked; cancel it and start a new run whose goal states the decision' },
        ],
        changes: ['implementation'],
        recommendation: { option: DECLINE_LEDGER_DECISIONS, reason: 'each entry is a choice the run made without a person; accept only the ones you have read and agree with' },
        safeDefault: { exists: true, option: DECLINE_LEDGER_DECISIONS, reason: 'declining delivers nothing that rests on a choice nobody made' },
        material: true,
        affected: [],
        unblocked: [],
      },
      ctx.clock,
      'controller',
    );
  recordAsked(ctx, { ledger_ids: [...ids].sort(), question_ids: [q.id], settles_on: 'accept' }, `asked a person to decide ${named} (question ${q.id})`.slice(0, 1000));
  return q;
}

/**
 * Before `stage` (delivery, success): settle each open needs-decision entry a person decided, and block with a question
 * for the rest, naming each. Null when none is left open.
 */
export async function blockOnUndecidedLedger(ctx: RunContext, stage: string): Promise<StepResult | null> {
  const open = listLedger(ctx.db, ctx.run.id, { status: 'needs-decision' });
  if (open.length === 0) return null;
  const records = askedRecords(ctx);
  const left: LedgerRecord[] = [];
  const unasked: LedgerRecord[] = [];
  const waiting = new Map<string, { q: QuestionRecord; ids: string[] }>();
  const declined = new Map<string, { q: QuestionRecord; ids: string[] }>();
  const add = (into: Map<string, { q: QuestionRecord; ids: string[] }>, q: QuestionRecord, id: string) => into.set(q.id, { q, ids: [...(into.get(q.id)?.ids ?? []), id] });
  for (const e of open) {
    const asked = records.filter((r) => r.ledger_ids.includes(e.id)).flatMap((r) => r.question_ids.map((id) => ({ q: findQuestion(ctx.db, id), settlesOn: r.settles_on })));
    const decided = asked.find(({ q, settlesOn }) => answeredByPerson(q) && (settlesOn === 'any' || accepts(q)));
    if (decided && answeredByPerson(decided.q) && settle(ctx, e, decided.q)) continue;
    left.push(e);
    const pending = asked.filter(({ q }) => q?.status === 'open');
    const refused = asked.find(({ q, settlesOn }) => settlesOn === 'accept' && answeredByPerson(q) && !accepts(q));
    if (pending.length > 0) for (const { q } of pending) add(waiting, q!, e.id);
    else if (refused) add(declined, refused.q!, e.id);
    else unasked.push(e);
  }
  if (left.length === 0) return null;
  const claim = (id: string) => `${id} (${left.find((e) => e.id === id)!.claim.slice(0, 160)})`;
  const entries = (n: number) => `needs-decision assumption ledger ${n === 1 ? 'entry' : 'entries'}`;
  const ledgerDeclined = [...declined.values()].map((d) => ({ question_id: d.q.id, ledger_ids: d.ids }));
  if (declined.size > 0) {
    // The run cannot succeed with a decision a person declined, and the question is not asked again, so a resume would only
    // block again (controller/resume.ts newRunNeeded reads ledger_declined): nothing else is asked, and nobody is told to resume.
    const n = ledgerDeclined.reduce((sum, d) => sum + d.ledger_ids.length, 0);
    const parts = [
      ...[...declined.values()].map((d) => `${d.ids.map(claim).join('; ')} (question ${d.q.id}, answered "${(d.q.answer ?? '').slice(0, 80)}" by ${d.q.answeredBy})`),
      ...[...waiting.values()].map((w) => `${w.ids.map(claim).join('; ')} also ${w.ids.length === 1 ? 'waits' : 'wait'} for question ${w.q.id} (${w.q.question.slice(0, 160)})`),
      ...(unasked.length > 0 ? [`${unasked.map((e) => claim(e.id)).join('; ')} also ${unasked.length === 1 ? 'needs' : 'need'} a person's decision`] : []),
    ];
    return finishRun(
      ctx,
      'BLOCKED',
      `a person declined ${n} ${entries(n)} recorded during the run, so it cannot reach ${stage}: ${parts.join('; ')}. The run cannot succeed with a decision a person declined, and orbit resume would only block again on it: cancel the run (orbit cancel ${ctx.run.id}) and start a new run whose goal states the decision.`,
      { outcome: { ledger_entries: left.map((e) => e.id), questions: [...waiting.keys(), ...declined.keys()], ledger_declined: ledgerDeclined } },
    );
  }
  const q = unasked.length > 0 ? ask(ctx, unasked) : null;
  const parts = [
    ...(q ? [`question ${q.id} asks a person to decide ${unasked.map((e) => claim(e.id)).join('; ')}`] : []),
    ...[...waiting.values()].map((w) => `${w.ids.map(claim).join('; ')} ${w.ids.length === 1 ? 'waits' : 'wait'} for question ${w.q.id} (${w.q.question.slice(0, 160)})`),
  ];
  const answers = [...(q ? [`orbit decide ${ctx.run.id} ${q.id} ${ACCEPT_LEDGER_DECISIONS} (or ${DECLINE_LEDGER_DECISIONS})`] : []), ...[...waiting.keys()].map((id) => `orbit decide ${ctx.run.id} ${id} <answer>`)];
  const n = left.length;
  return finishRun(ctx, 'BLOCKED', `${n} ${entries(n)} recorded during the run ${n === 1 ? 'waits' : 'wait'} for a person before ${stage}: ${parts.join('; ')}. Answer with ${answers.join(' and ')}, then orbit resume ${ctx.run.id}.`, {
    outcome: { ledger_entries: left.map((e) => e.id), questions: [...(q ? [q.id] : []), ...waiting.keys()] },
  });
}
