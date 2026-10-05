/** Model, worker, controller and subsystem identities can never answer a question: that would be a model authorizing itself. */
const NON_HUMAN = /^(planner|implementer|verifier|reviewer|inquisitor|inquisition|curator|worker|wrk|model|agent|subagent|assistant|claude|codex|gpt|gemini|controller|scheduler|recovery|delivery|evidence|routing|orbit|system|service|daemon|shim|hook|llm|ai|bot|fake)([:\-_/ ].*)?$/i;

export function isHumanActor(by: string): boolean {
  const trimmed = by.trim();
  return trimmed !== '' && !NON_HUMAN.test(trimmed);
}

/** The decision record a person's answer to a question becomes (`orbit decide`). */
export const ANSWER_DECISION_KIND = 'inquisition.answer';

/** Fixed per question, so a retried answer after a crash finds the same record. */
export function answerDecisionId(questionId: string): string {
  return `dec-answer-${questionId}`;
}
