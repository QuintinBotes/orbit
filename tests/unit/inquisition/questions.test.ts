import { afterEach, describe, expect, it } from 'vitest';
import { isOrbitError } from '../../../src/core/errors.ts';
import { getDecision, readDecisionsMirror } from '../../../src/storage/decisions.ts';
import { ANSWER_DECISION_KIND, answerQuestion, classifyQuestion, criteriaBlockedByQuestions, isHumanActor, openQuestions, persistQuestion, validateQuestion } from '../../../src/inquisition/questions.ts';
import { getQuestion, listQuestions } from '../../../src/inquisition/store.ts';
import { RUN, goodQuestion, setup, type Env } from './helpers.ts';

let env: Env | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function problems(over: Parameters<typeof goodQuestion>[0], contract = false): string[] {
  env ??= setup();
  return validateQuestion(goodQuestion(over), contract ? { contract: env.contract } : {}).problems;
}

describe('validateQuestion: the spec example passes', () => {
  it('accepts a question that meets every rule', () => {
    env = setup();
    expect(validateQuestion(goodQuestion(), { contract: env.contract })).toEqual({ valid: true, problems: [] });
  });
});

describe('validateQuestion: rejections', () => {
  it('rejects non-objects', () => {
    expect(validateQuestion(null).valid).toBe(false);
    expect(validateQuestion('why?').problems).toEqual(['question must be an object']);
  });

  it('needs a real question', () => {
    expect(problems({ question: 'Decide the export format' }).join()).toContain('end with "?"');
    expect(problems({ question: 'Format?' }).join()).toContain('too short');
  });

  it('rejects questions the repository can answer', () => {
    for (const q of ['Where is the report query defined in this repository?', 'Which test runner does the project use today?', 'Does the repo already contain an export helper function?', 'Can you look at the pagination code and tell me how it works?']) {
      expect(problems({ question: q }).join(), q).toContain('answerable by inspecting');
    }
  });

  it('rejects permission-seeking and opinion questions', () => {
    for (const q of ['Should I proceed with the export implementation now?', 'Is this approach okay for the export feature here?', 'Do you want me to add pagination support to export?', 'What do you think about the export column order?']) {
      expect(problems({ question: q }).join(), q).toContain('permission or opinion');
    }
  });

  it('requires a stated change to implementation, proof, authority or scope', () => {
    expect(problems({ changes: [] }).join()).toContain('what the answer changes');
    expect(problems({ changes: ['vibes' as never] }).join()).toContain('changes must be drawn from');
  });

  it('requires evidence of inspection', () => {
    expect(problems({ evidence: [] }).join()).toContain('needs evidence');
    expect(problems({ evidence: ['n/a'] }).join()).toContain('each evidence entry');
    expect(problems({ evidence: ['none'] }).join()).toContain('each evidence entry');
  });

  it('requires at least two distinct options, each with consequences', () => {
    const one = goodQuestion().options.slice(0, 1);
    expect(problems({ options: one }).join()).toContain('at least two options');
    const noConsequence = goodQuestion().options.map((o, i) => (i === 1 ? { ...o, consequences: '' } : o));
    expect(problems({ options: noConsequence }).join()).toContain('option 2 needs its consequences');
    const sameLabel = goodQuestion().options.map((o) => ({ ...o, label: 'Same' }));
    expect(problems({ options: sameLabel, recommendation: 'Same', safe_default: { exists: false, option: null, reason: 'no safe default exists here' } }).join()).toContain('labels must be distinct');
    const sameSubstance = goodQuestion().options.map((o, i) => ({ ...o, description: 'Do the thing.', label: `Option ${i}` }));
    expect(problems({ options: sameSubstance, recommendation: 'Option 0' }).join()).toContain('differ in substance');
  });

  it('requires a recommendation that is one of the options, with a reason', () => {
    expect(problems({ recommendation: '' }).join()).toContain('recommended option');
    expect(problems({ recommendation: 'Something else' }).join()).toContain('label of one of the options');
    expect(problems({ recommendation_reason: '' }).join()).toContain('stated reason');
  });

  it('requires a coherent safe-default statement', () => {
    expect(problems({ safe_default: undefined as never }).join()).toContain('whether a safe default exists');
    expect(problems({ safe_default: { exists: true, option: null, reason: 'rejecting changes nothing here' } }).join()).toContain('safe_default.option must be the label');
    expect(problems({ safe_default: { exists: true, option: 'Current page', reason: '' } }).join()).toContain('safe_default needs a reason');
    expect(problems({ safe_default: { exists: false, option: 'Current page', reason: 'there is no safe default at all' } }).join()).toContain('must be null');
    expect(problems({ safe_default: { exists: true, option: 'Current page', reason: 'reversible and conservative choice' } })).toEqual([]);
  });

  it('requires affected work and a list of unblocked work', () => {
    expect(problems({ affected_work: [] }).join()).toContain('affected work');
    expect(problems({ unblocked_work: undefined as never }).join()).toContain('stays unblocked');
    expect(problems({ unblocked_work: [] })).toEqual([]);
    expect(problems({ affected_work: ['csv escaping'], unblocked_work: ['CSV escaping'] }).join()).toContain('both affected and unblocked');
  });

  it('with a contract, affected work must name real criteria that are not also unblocked', () => {
    expect(problems({ affected_work: ['csv export'] }, true).join()).toContain('at least one acceptance criterion');
    expect(problems({ affected_work: ['AC-9'] }, true).join()).toContain('do not exist: AC-9');
    expect(problems({ affected_work: ['AC-1'], unblocked_work: ['AC-1'] }, true).join()).toContain('both affected and unblocked');
  });
});

describe('classifyQuestion: material vs reversible', () => {
  it('upgrades but never downgrades', () => {
    const q = goodQuestion({ material: false, safe_default: { exists: true, option: 'Current page', reason: 'conservative and easily reversed later' }, changes: ['implementation'] });
    const c = classifyQuestion(q);
    expect(c).toMatchObject({ material: false, reversible: true });
    expect(classifyQuestion({ ...q, material: true }).material).toBe(true);
  });

  it('no safe default means material', () => {
    const c = classifyQuestion(goodQuestion({ material: false }));
    expect(c.material).toBe(true);
    expect(c.reasons.join()).toContain('no safe default');
  });

  it('authority or scope changes are material', () => {
    const base = { material: false, safe_default: { exists: true, option: 'Current page', reason: 'conservative and easily reversed' } };
    expect(classifyQuestion(goodQuestion({ ...base, changes: ['authority'] })).material).toBe(true);
    expect(classifyQuestion(goodQuestion({ ...base, changes: ['scope'] })).material).toBe(true);
  });

  it('security, billing and irreversible data text makes it material whatever the worker said', () => {
    const base = { material: false, changes: ['implementation' as const], safe_default: { exists: true, option: 'Current page', reason: 'conservative and easily reversed' } };
    const sec = classifyQuestion(goodQuestion({ ...base, question: 'Should exported files be encrypted with a per-user key or a shared key?' }));
    expect(sec.categories).toContain('security');
    expect(sec.material).toBe(true);
    const bill = classifyQuestion(goodQuestion({ ...base, question: 'Should the export charge a fee per thousand rows exported?' }));
    expect(bill.categories).toContain('billing');
    const data = classifyQuestion(goodQuestion({ ...base, evidence: ['The cleanup would permanently delete rows older than a year and cannot be undone.'] }));
    expect(data.material).toBe(true);
  });

  it('contract material topics make it material', () => {
    env = setup();
    const q = goodQuestion({ material: false, changes: ['implementation'], question: 'Should the export apply the security rules of the report owner or of the requester?', safe_default: { exists: true, option: 'Current page', reason: 'conservative and easily reversed' } });
    expect(classifyQuestion(q, { contract: env.contract }).reasons.join()).toContain('security rules');
  });
});

describe('persistQuestion', () => {
  it('stores a valid question with its classification', () => {
    env = setup();
    const { question, created, classification } = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock, { contract: env.contract });
    expect(created).toBe(true);
    expect(classification.material).toBe(true);
    expect(question).toMatchObject({ status: 'open', material: true, affected: ['AC-1'], unblocked: ['AC-2', 'AC-3'], changes: ['implementation', 'proof'] });
    expect(question.recommendation).toEqual({ option: 'All matching records', reason: expect.any(String) });
    expect(question.safeDefault?.exists).toBe(false);
    const events = env.db.all<{ type: string }>("SELECT type FROM events WHERE type = 'question.created'");
    expect(events).toHaveLength(1);
  });

  it('rejects a weak question with its problems and stores nothing', () => {
    env = setup();
    try {
      persistQuestion(env.db, RUN, 'clarify', goodQuestion({ options: [] }), env.clock);
      throw new Error('expected rejection');
    } catch (err) {
      expect(isOrbitError(err, 'SCHEMA_INVALID')).toBe(true);
      expect((err as { details?: { problems: string[] } }).details?.problems.join()).toContain('two options');
    }
    expect(listQuestions(env.db, RUN)).toEqual([]);
  });

  it('returns the open question instead of a duplicate', () => {
    env = setup();
    const a = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock);
    const b = persistQuestion(env.db, RUN, 'clarify', goodQuestion({ question: 'Should export include every matching record, or only the current page?' }), env.clock);
    expect(b.created).toBe(false);
    expect(b.question.id).toBe(a.question.id);
    expect(listQuestions(env.db, RUN)).toHaveLength(1);
  });

  it('criteriaBlockedByQuestions counts open material questions only', () => {
    env = setup();
    const a = persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
    persistQuestion(env.db, RUN, 'clarify', goodQuestion({ question: 'Should dates in the export use UTC or the local time zone of the user?', affected_work: ['AC-2'], unblocked_work: [], material: false, changes: ['implementation'], safe_default: { exists: true, option: 'Current page', reason: 'conservative and reversible choice' } }), env.clock);
    expect(criteriaBlockedByQuestions(openQuestions(env.db, RUN))).toEqual(['AC-1']);
    expect(a.status).toBe('open');
  });
});

describe('answerQuestion (orbit decide)', () => {
  function asked() {
    env = setup();
    return persistQuestion(env.db, RUN, 'clarify', goodQuestion(), env.clock).question;
  }

  it('records the answer on the question and as a decision, matching an option by label', () => {
    const q = asked();
    const res = answerQuestion(env!.db, env!.runDir, q.id, 'all matching records', 'alice', env!.clock);
    expect(res.question).toMatchObject({ status: 'answered', answer: 'All matching records', answeredBy: 'alice' });
    expect(res.chosenOption?.label).toBe('All matching records');
    expect(res.unblocks).toEqual(['AC-1']);
    expect(res.decision.kind).toBe(ANSWER_DECISION_KIND);
    expect(getDecision(env!.db, `dec-answer-${q.id}`)?.data).toMatchObject({ chosen_option: 'All matching records', free_text: false, answered_by: 'alice' });
    expect(readDecisionsMirror(env!.runDir).map((l) => l.id)).toEqual([`dec-answer-${q.id}`]);
    expect(openQuestions(env!.db, RUN)).toEqual([]);
  });

  it('keeps a free-text answer as written', () => {
    const q = asked();
    const res = answerQuestion(env!.db, env!.runDir, q.id, 'Only rows visible after the active filter, capped at 50k.', 'alice', env!.clock);
    expect(res.chosenOption).toBeNull();
    expect(res.decision.data).toMatchObject({ free_text: true, chosen_option: null });
  });

  it('is idempotent for the same answer and refuses a different second answer', () => {
    const q = asked();
    const first = answerQuestion(env!.db, env!.runDir, q.id, 'Current page', 'alice', env!.clock);
    const again = answerQuestion(env!.db, env!.runDir, q.id, 'Current page', 'alice', env!.clock);
    expect(again.decision.id).toBe(first.decision.id);
    expect(readDecisionsMirror(env!.runDir)).toHaveLength(1);
    try {
      answerQuestion(env!.db, env!.runDir, q.id, 'All matching records', 'alice', env!.clock);
      throw new Error('expected rejection');
    } catch (err) {
      expect(isOrbitError(err, 'CONCURRENT_UPDATE')).toBe(true);
    }
  });

  it('refuses model, worker and controller identities: a model cannot answer for the person', () => {
    const q = asked();
    for (const by of ['inquisitor', 'worker:wrk-1', 'claude', 'Controller', 'codex-reviewer', 'agent_7', '  ']) {
      try {
        answerQuestion(env!.db, env!.runDir, q.id, 'Current page', by, env!.clock);
        throw new Error(`expected refusal for ${by}`);
      } catch (err) {
        expect(isOrbitError(err, 'POLICY_DENIED'), by).toBe(true);
      }
    }
    expect(getQuestion(env!.db, q.id).status).toBe('open');
    expect(isHumanActor('quintin')).toBe(true);
  });

  it('rejects an empty answer and an unknown question', () => {
    const q = asked();
    expect(() => answerQuestion(env!.db, env!.runDir, q.id, '   ', 'alice', env!.clock)).toThrow(/cannot be empty/);
    try {
      answerQuestion(env!.db, env!.runDir, 'q-missing', 'x', 'alice', env!.clock);
      throw new Error('expected NOT_FOUND');
    } catch (err) {
      expect(isOrbitError(err, 'NOT_FOUND')).toBe(true);
    }
  });
});
