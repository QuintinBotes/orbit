import { sha256 } from '../core/hash.ts';
import { redact } from '../core/redact.ts';

/**
 * Failure fingerprints. Two runs of the same broken check should produce the
 * same fingerprint even though their timestamps, durations, temp directories,
 * ids, line numbers and (for parallel runners) line order differ; two
 * different failures should not. The scheduler's non-progress detection and
 * the repair brief both depend on that distinction.
 *
 * Only the failure-relevant lines (error messages, failing test names, the top
 * stack frame) feed the hash, so unrelated chatter, progress output and
 * summary counts cannot change it.
 */

export interface FingerprintOptions {
  exitCode?: number | null;
  timedOut?: boolean;
  /** Directories to replace with `<repo>` before the generic absolute-path rule (checkout, run dir, home). */
  roots?: readonly string[];
  /** Failure-relevant lines kept for the excerpt. Default 20. */
  maxLines?: number;
  /** Hard cap on the excerpt size. Default 2000 characters. */
  maxExcerptChars?: number;
}

export interface FailureFingerprint {
  /** `fp:` plus 16 hex characters. */
  fingerprint: string;
  /** Sanitized, bounded text for briefs and model context. Original wording, not normalized. */
  excerpt: string;
  /** The normalized lines the fingerprint was computed from, sorted and deduplicated. */
  signature: string[];
}

const DEFAULT_MAX_LINES = 20;
const DEFAULT_MAX_EXCERPT = 2000;
// A line this long is a minified bundle or a data dump, not a message.
const MAX_LINE = 400;
// Cap on lines scanned, so a runaway log cannot make this quadratic or slow.
const MAX_SCANNED_LINES = 200_000;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001B\[[0-9;?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)|\u001B[@-Z\\-_]/g;

const RELEVANT =
  /\b(error|errors|fail|failed|failure|failing|exception|assert|assertion|assertionerror|panic|fatal|expected|received|not ok|typeerror|referenceerror|syntaxerror|rangeerror|cannot find|enoent|eacces|traceback|unhandled|timeout|timed out|refused|denied|undefined is not|is not a function|is not defined)\b|[✗✖×]|^\s*FAIL\b|^\s*●|^\s*not ok\b/i;
// "Tests: 1 failed, 3 passed", "Test Files 1 failed | 3 passed": counts shift when tests are added, so they say nothing about the cause.
const SUMMARY = /\b\d+\s+(?:passed|failed|skipped|total|todo|pending|passing|failing)\b|\b(?:tests?|test files|suites?|duration|time|snapshots?)\s*:/i;
const STACK_FRAME = /^\s+at\s|^\s+\S+:\d+(?::\d+)?\s*$|^\s*File ".+", line \d+/;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '');
}

/** Replace everything that varies between two runs of the same failure with a fixed placeholder. */
export function normalizeLine(line: string, roots: readonly string[] = []): string {
  let s = stripAnsi(line).replace(/\r/g, '');
  for (const root of [...roots].filter((r) => r.length > 1).sort((a, b) => b.length - a.length)) s = s.split(root).join('<repo>');
  s = s
    // Temp directories and per-run scratch names.
    .replace(/(?:\/private)?\/var\/folders\/[^\s'"():]+/g, '<tmp>')
    .replace(/(?:\/private)?\/tmp\/[^\s'"():]+/g, '<tmp>')
    .replace(/\b(?:orbit|tmp|temp)[-_.][A-Za-z0-9]{6,}\b/g, '<tmp>')
    // Timestamps in the usual shapes.
    .replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?\b/g, '<time>')
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d+)?\b/g, '<time>')
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{1,2}(?:,?\s+\d{4})?\b/g, '<time>')
    .replace(/\b1[5-9]\d{11}\b/g, '<time>')
    // Durations: "(12ms)", "in 1.2s", "took 340 ms", "0.45 seconds".
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds?|µs|us|ns|seconds?|secs?|s|minutes?|mins?)\b/gi, '<dur>')
    // Identifiers: uuids, pointers, long hex (shas, hashes, random suffixes).
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b0x[0-9a-f]+\b/gi, '<hex>')
    .replace(/\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8,}\b/gi, '<hex>')
    .replace(/\b\d{7,}\b/g, '<n>')
    .replace(/\b(pid|process|port)\s*[:=]?\s*\d+\b/gi, '$1 <n>')
    .replace(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]):\d{2,5}\b/g, '$1:<port>')
    // Other absolute paths keep their last two segments, which is where the file identity lives.
    .replace(/(?<![\w:/.~<>-])\/(?:[^\s:'"()<>[\]]+\/)+[^\s:'"()<>[\]]+/g, (m) => `<path>/${m.split('/').filter(Boolean).slice(-2).join('/')}`)
    // Line and column numbers move whenever the file is edited.
    .replace(/(\.[A-Za-z0-9]{1,6}):\d+(?::\d+)?/g, '$1:<n>')
    .replace(/\b(line|col|column|ln)\s+\d+\b/gi, '$1 <n>')
    .replace(/\((\d+):(\d+)\)/g, '(<n>:<n>)')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > MAX_LINE ? s.slice(0, MAX_LINE) : s;
}

function isRelevant(line: string): boolean {
  return RELEVANT.test(line) && !SUMMARY.test(line);
}

export function fingerprintFailure(output: string, check: { id: string }, options: FingerprintOptions = {}): FailureFingerprint {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = options.maxExcerptChars ?? DEFAULT_MAX_EXCERPT;
  const roots = options.roots ?? [];
  const lines = stripAnsi(output).split('\n', MAX_SCANNED_LINES);

  const picked: { raw: string; norm: string }[] = [];
  let expectFrame = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim()) {
      expectFrame = false;
      continue;
    }
    if (isRelevant(line)) {
      picked.push({ raw: line.slice(0, MAX_LINE), norm: normalizeLine(line, roots) });
      expectFrame = true;
    } else if (expectFrame && STACK_FRAME.test(line)) {
      // Only the top frame after an error line: deeper frames differ by runner version and call depth.
      picked.push({ raw: line.slice(0, MAX_LINE), norm: normalizeLine(line, roots) });
      expectFrame = false;
    } else {
      expectFrame = false;
    }
  }

  // Sorted and deduplicated: parallel runners interleave and repeat lines in a different order every run.
  let signature = [...new Set(picked.map((p) => p.norm).filter(Boolean))].sort();
  if (signature.length === 0) {
    // Silent failures still need a stable identity: the tail of the output, then how the process ended.
    const tail = lines
      .map((l) => normalizeLine(l, roots))
      .filter(Boolean)
      .slice(-3);
    signature = [...tail, `exit:${options.timedOut ? 'timeout' : String(options.exitCode ?? 'signal')}`].sort();
  }
  const fingerprint = `fp:${sha256(JSON.stringify([check.id, signature])).slice(0, 16)}`;

  // First occurrence order, so the excerpt reads like the log; capped in lines and characters.
  const seen = new Set<string>();
  const excerptLines: string[] = [];
  for (const p of picked) {
    if (seen.has(p.norm)) continue;
    seen.add(p.norm);
    excerptLines.push(p.raw.trimEnd());
    if (excerptLines.length >= maxLines) break;
  }
  if (excerptLines.length === 0) {
    excerptLines.push(...lines.filter((l) => l.trim()).slice(-Math.min(maxLines, 10)).map((l) => l.slice(0, MAX_LINE)));
    if (options.timedOut) excerptLines.push('[orbit: check timed out]');
  }
  let excerpt = redact(excerptLines.join('\n'));
  if (excerpt.length > maxChars) excerpt = `${excerpt.slice(0, maxChars)}\n[orbit: excerpt truncated]`;
  return { fingerprint, excerpt, signature };
}

/** Same failure: equal fingerprints. Accepts the bare strings or the objects fingerprintFailure returns. */
export function sameFailure(a: string | { fingerprint: string } | null | undefined, b: string | { fingerprint: string } | null | undefined): boolean {
  const fa = typeof a === 'string' ? a : a?.fingerprint;
  const fb = typeof b === 'string' ? b : b?.fingerprint;
  return fa !== undefined && fb !== undefined && fa === fb;
}
