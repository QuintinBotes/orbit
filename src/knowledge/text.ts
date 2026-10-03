import { sha256 } from '../core/hash.ts';
import { redactForProvider } from '../core/redact.ts';
import { visibleText } from './authority.ts';
import type { LessonKind } from './types.ts';

/**
 * Text helpers shared by the learning layer. Everything here is deterministic
 * and pure, so extraction, dedupe and retrieval give the same answer on every
 * machine and every replay.
 */

/**
 * Lowercased visible text (NFKC, invisible format characters removed) with
 * punctuation folded to spaces. Two curators phrasing the same lesson with
 * different capitalization, quoting, trailing punctuation or a stray
 * zero-width character land on one node instead of two.
 */
export function normalizeStatement(statement: string): string {
  return visibleText(statement)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/** Dedupe key: a lesson is the same lesson only when kind and normalized statement agree. */
export function lessonKey(kind: LessonKind, statement: string): string {
  return sha256(`${kind}\n${normalizeStatement(statement)}`);
}

/** Ids derive from the dedupe key so the same lesson gets the same id on every machine. */
export function lessonIdFor(kind: LessonKind, statement: string): string {
  return `les-${lessonKey(kind, statement).slice(0, 12)}`;
}

/** The prompt-size estimate used for every token budget in this layer. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Truncate at a word boundary and mark the cut, so a capped field never ends mid-word silently. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}\u2026`;
}

/** One line, no control characters: model text must not be able to forge structure in a prompt. */
export function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Neutralize anything that could close or open a fence in a prompt. Lessons
 * and ingested documents are untrusted; letting them end the advisory fence
 * would let them speak outside it.
 */
export function defang(text: string): string {
  return text
    .replace(/`{3,}/g, "'''")
    .replace(/~{3,}/g, '-~-')
    .replace(/<{3,}/g, '< < <')
    .replace(/>{3,}/g, '> > >')
    .replace(/<\/?orbit[^>]*>/gi, '[tag removed]');
}

/** Union preserving first-seen order, capped: schema arrays have maxItems. */
export function unionCapped(a: readonly string[], b: readonly string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of [...a, ...b]) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= cap) break;
  }
  return out;
}

const EMAIL = /(?<![\w.%+-])[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63}){0,8}\.[A-Za-z]{2,24}(?![\w-])/g;

/**
 * Remove credentials, home paths and email addresses before text is stored
 * or sent to a model. Secrets go through the shared redactor; emails are
 * removed on top because lessons may be shared across repositories and an
 * address identifies a person.
 */
export function redactText(text: string): string {
  return redactForProvider(text).replace(EMAIL, '[REDACTED:email]');
}

/** Redact, flatten and bound a piece of untrusted text for storage or a prompt. */
export function cleanUntrusted(text: string | null | undefined, max: number): string {
  if (!text) return '';
  return truncate(oneLine(redactText(text)), max);
}

const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'has', 'have', 'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'were', 'will', 'with', 'when', 'which', 'while', 'not', 'no', 'do', 'does', 'so', 'if', 'then',
]);

/** Search terms from free text: letters and digits only, so nothing reaches FTS5 query syntax. */
export function searchTerms(text: string, max = 32): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of text.normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const t = m[0];
    if (t.length < 2 || STOPWORDS.has(t) || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** The bare sha256 hex digest EvidenceRef accepts, from a bare or `sha256:`-prefixed value; null otherwise. */
export function asSha256(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value;
  return /^[0-9a-f]{64}$/.test(v) ? v : null;
}
