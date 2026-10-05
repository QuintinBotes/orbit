/**
 * Authority written in a goal (spec section 20). A goal may say "run
 * unsupervised using the autonomous-delivery profile", "open a draft PR" or
 * "do not merge", but authority comes only from the frozen policy. This
 * matcher reads those phrases and reports where the prose and the policy
 * disagree, so a mismatch is surfaced as a recorded decision instead of being
 * silently ignored.
 *
 * It never grants anything: a phrase the policy does not back is reported as
 * `exceeds-policy` and the policy still governs. A phrase that asks for less
 * than the policy allows is reported as `stricter-than-policy`; the contract
 * already keeps merge off unless a human turns it on, so such a phrase is
 * honoured and recorded rather than escalated.
 *
 * Pure and deterministic: the same goal and policy give the same result.
 */
import type { OrbitConfig, RunMode } from '../policy/types.ts';

export type AuthorityMismatchKind = 'exceeds-policy' | 'stricter-than-policy';

export interface AuthorityMismatch {
  kind: AuthorityMismatchKind;
  /** `mode:<mode>` or `actions.<action>`. */
  subject: string;
  /** The words of the goal that carry the claim. */
  phrase: string;
  /** One sentence for the decision record. */
  detail: string;
}

/** Modes ordered by how much authority they carry. */
const MODE_RANK: Record<RunMode, number> = { supervised: 0, autonomous: 1, 'autonomous-delivery': 2, release: 3 };

type ActionName = 'merge' | 'deploy_production' | 'push_task_branch' | 'open_pull_request';

interface ActionPattern {
  action: ActionName;
  label: string;
  re: RegExp;
}

const ACTION_PATTERNS: readonly ActionPattern[] = [
  { action: 'merge', label: 'merge', re: /\bmerg(?:e|es|ed|ing)\b(?!\s+conflicts?\b)/gi },
  { action: 'deploy_production', label: 'deploy to production', re: /\b(?:deploy(?:s|ed|ing)?|ship(?:s|ped|ping)?|releas(?:e|es|ed|ing))\b[^.;\n]{0,30}\b(?:production|prod)\b/gi },
  { action: 'push_task_branch', label: 'push a branch', re: /\bpush(?:es|ed|ing)?\b[^.;\n]{0,25}\b(?:branch|branches|origin|remote|changes|commits?|code)\b/gi },
  { action: 'open_pull_request', label: 'open a pull request', re: /\b(?:open|opens|opened|opening|create|creates|created|creating|raise|submit)\b[^.;\n]{0,20}\b(?:pull[- ]requests?|prs?)\b/gi },
];

const NEGATION = /\b(?:do not|don'?t|dont|never|must not|mustn'?t|should not|shouldn'?t|without|no|not|avoid|skip|refrain from)\b/i;

/** The text of the clause (up to a sentence or list break) that precedes `index`. */
function clauseBefore(text: string, index: number): string {
  const head = text.slice(Math.max(0, index - 60), index);
  const cut = Math.max(head.lastIndexOf('.'), head.lastIndexOf(';'), head.lastIndexOf('\n'), head.lastIndexOf('!'), head.lastIndexOf('?'));
  return cut >= 0 ? head.slice(cut + 1) : head;
}

function isNegated(text: string, index: number): boolean {
  return NEGATION.test(clauseBefore(text, index));
}

const MODE_WORDS = '(autonomous[- ]delivery|release|supervised|autonomous)';
// "autonomous-delivery" is distinctive enough to stand alone; the other words also occur in ordinary goals, so they need a mode cue.
const MODE_PHRASES: readonly RegExp[] = [
  /\b(autonomous[- ]delivery)\b(?:\s+(?:mode|profile))?/gi,
  new RegExp(`\\b${MODE_WORDS}\\s+(?:mode|profile)\\b`, 'gi'),
  new RegExp(`\\b(?:in|under|using|use|with|switch(?:ing)? to|set(?:ting)? (?:the )?mode to|mode:?)\\s+(?:the\\s+)?(?:mode\\s+)?${MODE_WORDS}\\s+(?:mode|profile)\\b`, 'gi'),
];

function normalizeMode(word: string): RunMode | null {
  const w = word.toLowerCase().replace(/\s+/g, '-');
  if (w === 'autonomous-delivery' || w === 'autonomous') return w as RunMode;
  if (w === 'supervised' || w === 'release') return w as RunMode;
  return null;
}

/** Modes the goal asks for in words, in order of first mention. */
export function modesRequestedInGoal(goal: string): { mode: RunMode; phrase: string }[] {
  const out: { mode: RunMode; phrase: string }[] = [];
  for (const re of MODE_PHRASES) {
    for (const m of goal.matchAll(re)) {
      const word = m[1];
      const mode = word === undefined ? null : normalizeMode(word);
      if (mode === null || out.some((o) => o.mode === mode)) continue;
      if (isNegated(goal, m.index ?? 0)) continue;
      out.push({ mode, phrase: m[0].trim() });
    }
  }
  return out;
}

/** What the goal's prose claims about modes and actions, compared with the policy it will run under. */
export function reconcileAuthority(goal: string, config: Pick<OrbitConfig, 'mode' | 'actions'>): AuthorityMismatch[] {
  const out: AuthorityMismatch[] = [];

  for (const { mode, phrase } of modesRequestedInGoal(goal)) {
    if (mode === config.mode) continue;
    const more = MODE_RANK[mode] > MODE_RANK[config.mode];
    out.push({
      kind: more ? 'exceeds-policy' : 'stricter-than-policy',
      subject: `mode:${mode}`,
      phrase,
      detail: more
        ? `the goal asks for mode ${mode}, but the policy freezes mode ${config.mode}; the policy governs`
        : `the goal asks for mode ${mode}, which carries less authority than the policy's ${config.mode}; the run keeps the policy's mode and only uses what the goal allows`,
    });
  }

  for (const p of ACTION_PATTERNS) {
    const seen = new Set<string>();
    for (const m of goal.matchAll(p.re)) {
      const negated = isNegated(goal, m.index ?? 0);
      const allowed = config.actions[p.action] === true;
      const phrase = m[0].trim();
      const key = `${negated}:${p.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (negated && allowed) {
        out.push({ kind: 'stricter-than-policy', subject: `actions.${p.action}`, phrase, detail: `the goal forbids ${p.label}, which the policy allows; the run does not ${p.label}` });
      } else if (!negated && !allowed) {
        out.push({ kind: 'exceeds-policy', subject: `actions.${p.action}`, phrase, detail: `the goal asks to ${p.label}, but the policy does not allow it (actions.${p.action} is false); the policy governs` });
      }
    }
  }
  return out;
}
