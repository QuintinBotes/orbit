/**
 * Keyword and path heuristics for decisions nobody wrote down: security,
 * privacy, billing, data and compatibility (spec section 10 triggers). They
 * are signals, never verdicts. They err toward flagging because a false alarm
 * costs one question, while a guessed security rule costs far more, and every
 * consumer treats a hit as "a decision may be hiding here", not as proof.
 */
import { redact } from '../core/redact.ts';

export const RISK_CATEGORIES = ['security', 'privacy', 'billing', 'data', 'compatibility'] as const;
export type RiskCategory = (typeof RISK_CATEGORIES)[number];

const TEXT: Record<RiskCategory, RegExp> = {
  security:
    /\b(authn|authz|authenticat\w*|authoriz\w*|oauth|jwt|passwords?|passwd|secrets?|credentials?|api[ _-]?keys?|permissions?|acl|rbac|crypto\w*|encrypt\w*|decrypt\w*|cors|csrf|xss|sql injection|sessions?|cookies?|sanitiz\w*|tls|certificates?|access tokens?|bearer|log[- ]?in|log[- ]?out|sign[- ]?in|sign[- ]?out|privileges?|privilege escalation)\b/i,
  privacy: /\b(pii|personal (?:data|information)|gdpr|ccpa|consent|anonymi[sz]\w*|pseudonymi[sz]\w*|data subjects?|email addresses?|phone numbers?|date of birth|ssn|tracking|telemetry|analytics|geolocation|ip addresses?)\b/i,
  billing: /\b(billing|invoices?|payments?|charges?|charged|pric(?:e|es|ing)|subscriptions?|refunds?|currency|currencies|taxes|tax rates?|checkout|credit cards?|payouts?|proration|quotas?|metering|overages?|fees?)\b/i,
  data: /\b(migrations?|schema changes?|alter table|drop column|rename column|drop table|delete from|truncate|backfill\w*|irreversible|data loss|hard[- ]delete\w*|purge\w*|destructive|retention polic\w*|cascade delete)\b/i,
  compatibility: /\b(breaking changes?|backwards?[- ]compat\w*|public api|deprecat\w*|api versions?|semver|wire format|on-disk format|file format|rename[sd]? exports?)\b/i,
};

const PATH: Record<RiskCategory, RegExp> = {
  security: /(^|\/)(auth|authn|authz|security|crypto|permissions?|acl|rbac|secrets?|iam)(\/|\.|-|_|$)/i,
  privacy: /(^|\/)[^/]*(privacy|gdpr|consent|pii)[^/]*(\/|$)/i,
  billing: /(^|\/)[^/]*(billing|payments?|invoices?|checkout|subscriptions?|pricing)[^/]*(\/|$)/i,
  data: /(^|\/)(migrations?|seeds?)(\/|$)|\.sql$|(^|\/)schema\.[a-z]+$/i,
  compatibility: /\.proto$|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|(^|\/)api\/v\d+(\/|$)/i,
};

export function riskCategoriesInText(text: string): RiskCategory[] {
  return RISK_CATEGORIES.filter((c) => TEXT[c].test(text));
}

/** Category -> the paths that matched it. */
export function riskCategoriesInPaths(paths: readonly string[]): Map<RiskCategory, string[]> {
  const out = new Map<RiskCategory, string[]>();
  for (const p of paths) {
    for (const c of RISK_CATEGORIES) {
      if (PATH[c].test(p)) out.set(c, [...(out.get(c) ?? []), p]);
    }
  }
  return out;
}

/**
 * Only added lines count: a removed line is a decision somebody already made,
 * and context lines are unchanged code the candidate did not touch.
 */
export function riskCategoriesInDiff(diff: string): Map<RiskCategory, string[]> {
  const out = new Map<RiskCategory, string[]>();
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const body = line.slice(1);
    // Code names its concepts in camelCase and snake_case; split them so word boundaries can see them.
    const words = body.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_+/g, ' ');
    for (const c of riskCategoriesInText(words)) {
      const hits = out.get(c) ?? [];
      // Diff lines are repository content and a line that trips the security heuristic is the likeliest to hold a credential: redact before the line becomes evidence anyone stores or shows.
      if (hits.length < 5) hits.push(redact(body.trim()).slice(0, 120));
      out.set(c, hits);
    }
  }
  return out;
}

/** Whether free text says the effect cannot be undone. */
export function mentionsIrreversible(text: string): boolean {
  return /\b(irreversibl\w*|cannot be undone|can't be undone|permanent(?:ly)?|hard[- ]delete\w*|drop table|data loss|destroy\w*|purge\w*)\b/i.test(text);
}
