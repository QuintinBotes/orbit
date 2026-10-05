/**
 * The impact register a risk-review produces (spec S10.3).
 *
 * One entry per risk category the candidate touches: which paths are
 * affected, how hard the change is to undo, and which authorizations the
 * policy offers for it (checks and enabled actions, the same vocabulary an
 * experiment must name). A category nothing in the policy covers needs a
 * person's decision. The register is a decision record, so reports and later
 * inquiries read it from the same place as every other decision.
 *
 * The engine calls `recordImpactRegister` when the inquiry's mode is
 * `risk-review`; the function is a no-op for every other mode.
 */
import { hashObject } from '../core/hash.ts';
import { redact } from '../core/redact.ts';
import { recordDecision, type DecisionRecord } from '../storage/decisions.ts';
import type { Clock } from '../core/clock.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { Reversibility } from '../contract/model-outputs.ts';
import { RISK_CATEGORIES, riskCategoriesInDiff, riskCategoriesInPaths, type RiskCategory } from './heuristics.ts';
import { authorizationIds } from './resolve.ts';
import type { InquisitionSnapshot } from './triggers.ts';
import type { Trigger } from './types.ts';

export const IMPACT_REGISTER_KIND = 'inquisition.impact-register';

export interface ImpactEntry {
  category: RiskCategory;
  affected_paths: string[];
  reversibility: Reversibility;
  /** Policy authorizations (check ids, enabled actions) relevant to the category; empty when only a person can authorize. */
  authorizations_available: string[];
  /** What must exist before the change may proceed. */
  authorization_needed: string;
  evidence: string[];
}

export interface ImpactRegister {
  trigger: string;
  entries: ImpactEntry[];
}

const ID_HINT: Record<RiskCategory, RegExp> = {
  security: /secur|sast|audit|secret|scan/i,
  privacy: /privacy|pii|secret|scan/i,
  billing: /billing|payment|merge|deploy/i,
  data: /migrat|schema|data|deploy/i,
  compatibility: /compat|contract|api|typecheck|build/i,
};

const DESTRUCTIVE = /\b(drop (?:table|column)|truncate|delete from|hard[- ]delete\w*|purge\w*|data loss|irreversible|cascade delete)\b/i;

function reversibility(category: RiskCategory, evidence: string[]): Reversibility {
  if (category === 'data' && evidence.some((e) => DESTRUCTIVE.test(e))) return 'irreversible';
  if (category === 'billing' || category === 'privacy') return 'costly-to-reverse';
  if (category === 'data' || category === 'compatibility' || category === 'security') return 'costly-to-reverse';
  return 'reversible';
}

/** Files named by `+++ b/path` headers, attributed to the categories their added lines trip. */
function diffPathsByCategory(diff: string): Map<RiskCategory, string[]> {
  const out = new Map<RiskCategory, string[]>();
  const chunks = diff.split(/^diff --git /m).slice(1);
  for (const chunk of chunks) {
    const m = /^\+\+\+ b\/(.+)$/m.exec(chunk);
    if (!m?.[1]) continue;
    for (const c of riskCategoriesInDiff(chunk).keys()) out.set(c, [...(out.get(c) ?? []), m[1].trim()]);
  }
  return out;
}

export function buildImpactRegister(
  inquiry: Pick<InquisitionSnapshot, 'changedFiles' | 'diff'>,
  policy: Parameters<typeof authorizationIds>[0],
  trigger: Pick<Trigger, 'key'>,
): ImpactRegister {
  const fromPaths = riskCategoriesInPaths(inquiry.changedFiles);
  const fromDiff = inquiry.diff ? riskCategoriesInDiff(inquiry.diff) : new Map<RiskCategory, string[]>();
  const diffPaths = inquiry.diff ? diffPathsByCategory(inquiry.diff) : new Map<RiskCategory, string[]>();
  const known = authorizationIds(policy);
  const entries: ImpactEntry[] = [];
  for (const category of RISK_CATEGORIES) {
    const paths = [...new Set([...(fromPaths.get(category) ?? []), ...(diffPaths.get(category) ?? [])])].sort();
    const evidence = [...(fromDiff.get(category) ?? []), ...paths.map((p) => `path ${p}`)];
    if (paths.length === 0 && evidence.length === 0) continue;
    const available = known.filter((id) => ID_HINT[category].test(id)).sort();
    entries.push({
      category,
      affected_paths: paths,
      reversibility: reversibility(category, evidence),
      authorizations_available: available,
      authorization_needed: available.length > 0 ? `one of: ${available.join(', ')}` : 'a person\'s decision: the policy offers no authorization for this category',
      evidence: evidence.slice(0, 8).map((e) => redact(e)),
    });
  }
  return { trigger: trigger.key, entries };
}

/** Write the register as an `inquisition.impact-register` decision. Returns null outside risk-review or when nothing was touched. */
export function recordImpactRegister(
  ctx: { db: OrbitDb; clock: Clock; runId: string; runDir: string; policy: Parameters<typeof authorizationIds>[0]; inquiry: Pick<InquisitionSnapshot, 'changedFiles' | 'diff'> },
  trigger: Pick<Trigger, 'key' | 'mode'>,
): DecisionRecord | null {
  if (trigger.mode !== 'risk-review') return null;
  const register = buildImpactRegister(ctx.inquiry, ctx.policy, trigger);
  if (register.entries.length === 0) return null;
  const summary = `impact register: ${register.entries.map((e) => `${e.category} (${e.reversibility})`).join(', ')}`;
  return recordDecision(
    ctx.db,
    ctx.runDir,
    { id: `dec-impact-${hashObject({ run: ctx.runId, t: trigger.key }).slice(7, 19)}`, runId: ctx.runId, kind: IMPACT_REGISTER_KIND, summary, data: register },
    ctx.clock,
    { actor: 'inquisition' },
  );
}
