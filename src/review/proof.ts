/**
 * Done means proven (issue #200; the ADR 0014 addendum of 2026-11-20). Before delivery, under
 * `verification.fail_before: required`, three narrow checks run on the final candidate, each in a fresh reviewer session
 * that answers in the review output (schemas/review-output.schema.json) under the conventions below:
 *
 * - criterion audit (FR-001, FR-002): the auditor sees only the criterion's text and its mapped tests (with the
 *   test-owned files they import) and answers "would this test still pass if the criterion were false?". APPROVE with one
 *   info finding AUDIT-1 is "no"; REPAIR_REQUIRED with a finding AUDIT-1 is "yes". Anything else is no answer.
 * - conformance (FR-005 to FR-008): for one MUST, a finding under the MUST's id: info with `location` path:start-end and
 *   `evidence` the exact lines when met, any other severity when unmet; CALLER-n findings for a changed behaviour at a
 *   caller that no requirement covers. Orbit checks each quote byte for byte against the candidate and lists the callers
 *   of each changed function holding a quoted line.
 * - artifacts (FR-009): one finding per sentence of the pull request body or of a changed document that describes
 *   behaviour the candidate does not have; none when they match.
 *
 * This module is pure: it reads answers and file text it is given and judges them. controller/proof.ts runs the sessions.
 */
import type { CriterionKind } from '../contract/types.ts';
import type { CriterionFailBefore } from '../evidence/types.ts';
import type { ReviewVerdict } from './types.ts';

/** One finding of a proof answer, as the review output gives it (the raw text: a quote is checked byte for byte). */
export interface ProofFinding {
  id: string;
  severity: string;
  category: string;
  location: string | null;
  claim: string;
  evidence: string;
}

export interface ProofAnswer {
  verdict: ReviewVerdict | null;
  findings: ProofFinding[];
  /** Why there is no usable answer (a session that failed, a test too long to audit); null when the session answered. */
  missing: string | null;
}

export const AUDIT_FINDING_ID = 'AUDIT-1';
export const PROOF_RESULT_KIND = 'proof.result';

/** The one `proof.result` decision of a tree: what the completion gate and the report read. */
export function proofResultId(runId: string, treeHash: string): string {
  return `dec-${runId}-proof-result-${treeHash.slice(0, 12)}`;
}

/** The auditor's answer to "would this test still pass if the criterion were false?": yes, no, or none. */
export function auditAnswer(a: ProofAnswer): { answer: 'yes' | 'no' | null; reason: string } {
  if (a.missing !== null) return { answer: null, reason: a.missing };
  const f = a.findings.filter((x) => x.id === AUDIT_FINDING_ID);
  if (f.length !== 1 || a.findings.length !== 1) return { answer: null, reason: `the auditor gave no answer (expected exactly one finding ${AUDIT_FINDING_ID})` };
  const reason = f[0]!.claim.trim() || f[0]!.evidence.trim();
  if (reason === '') return { answer: null, reason: 'the auditor gave no reason' };
  if (a.verdict === 'APPROVE' && f[0]!.severity === 'info') return { answer: 'no', reason };
  if (a.verdict !== 'APPROVE' && f[0]!.severity !== 'info') return { answer: 'yes', reason };
  return { answer: null, reason: `the auditor's verdict ${a.verdict ?? 'none'} and the severity ${f[0]!.severity} of ${AUDIT_FINDING_ID} disagree` };
}

/** A location `path:12-18`, `path:12` or `path#L12-L18`; null when it names no line. */
export function parseRange(location: string | null): { path: string; start: number; end: number } | null {
  if (location === null) return null;
  const m = /^(.+?)(?::|#L)(\d+)(?:\s*[-–]\s*L?(\d+))?$/.exec(location.trim());
  if (!m) return null;
  const start = Number(m[2]);
  const end = m[3] === undefined ? start : Number(m[3]);
  if (start < 1 || end < start) return null;
  return { path: m[1]!.replace(/^\.\//, ''), start, end };
}

/**
 * Whether `quote` is exactly lines start..end of `text` (FR-006): byte for byte, save one final newline either may have.
 * Returns why not, or null when it matches.
 */
export function quoteMismatch(text: string | null, range: { path: string; start: number; end: number }, quote: string): string | null {
  if (text === null) return `${range.path} is not in the candidate`;
  const lines = text.split('\n');
  if (range.end > lines.length) return `${range.path} has ${lines.length} lines, fewer than ${range.end}`;
  const actual = lines.slice(range.start - 1, range.end).join('\n');
  const q = quote.endsWith('\n') ? quote.slice(0, -1) : quote;
  return actual === q ? null : `the quote is not lines ${range.start}-${range.end} of ${range.path} as the candidate has them`;
}

const DECLARATIONS: readonly RegExp[] = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*[(<]/,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*[([]/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly|export)\s+)*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::\s*[^{=;]+)?\{\s*$/,
];
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'return', 'function', 'constructor']);

/** A function declared on this line, by name; null when the line declares none this search recognizes. */
export function declaredFunction(line: string): string | null {
  for (const re of DECLARATIONS) {
    const name = re.exec(line)?.[1];
    if (name && !NOT_NAMES.has(name)) return name;
  }
  return null;
}

const indentOf = (line: string): number => /^\s*/.exec(line)![0].length;

/**
 * The function that holds line `lineNo` (1-based) of `text`: the nearest declaration above it, and its extent up to the
 * next declaration at the same or a lower indentation. A search by declaration, in any language it recognizes; null when
 * no declaration lies above the line.
 * shortcut: declarations are recognized by pattern (JS/TS, Python, Go, Rust, methods), not parsed; a language whose
 * functions none of DECLARATIONS matches gets no callers listed until the repository map of #175 is used instead.
 */
export function enclosingFunction(text: string, lineNo: number): { name: string; start: number; end: number } | null {
  const lines = text.split('\n');
  for (let i = Math.min(lineNo, lines.length) - 1; i >= 0; i--) {
    const name = declaredFunction(lines[i]!);
    if (name === null) continue;
    const indent = indentOf(lines[i]!);
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (declaredFunction(lines[j]!) !== null && indentOf(lines[j]!) <= indent) {
        end = j;
        break;
      }
    }
    if (lineNo > end) return null;
    return { name, start: i + 1, end };
  }
  return null;
}

/** Changed line numbers on the new side of a `git diff -U0` of one file. */
export function changedLines(diff: string): Set<number> {
  const out = new Set<number>();
  for (const m of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
    const start = Number(m[1]);
    const count = m[2] === undefined ? 1 : Number(m[2]);
    for (let i = 0; i < count; i++) out.add(start + i);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Judgement

export interface CriterionInput {
  id: string;
  statement: string;
  kind: CriterionKind;
  tests: string[];
  /** A UI criterion keeps the browser probe of ADR 0016, judged by its journeys rather than by a test run alone. */
  ui?: boolean;
  /** The criterion's fail-before entry from the candidate's evidence report. */
  failBefore: CriterionFailBefore | null;
  /** The audit answer; null when none was asked (a person-checked criterion). */
  audit: ProofAnswer | null;
}

export interface CriterionProof {
  criterion_id: string;
  kind: CriterionKind;
  status: 'proven' | 'unproven' | 'waiting-on-person';
  tests: string[];
  audit: { answer: 'yes' | 'no' | null; reason: string } | null;
  fail_before: { outcome: string; reason: string; accepted_by?: string } | null;
  reason: string;
}

export interface RequirementInput {
  id: string;
  wording: string;
  answer: ProofAnswer;
  /** Text of a candidate file by path, null when it is not in the candidate; read only for quoted paths. */
  file: (path: string) => string | null;
  /** Callers of the changed function holding a quoted line, found by search; empty when none or not a changed function. */
  callers: (path: string, start: number, end: number) => { function: string; callers: string[] } | null;
}

export interface RequirementProof {
  id: string;
  wording: string;
  status: 'met' | 'unmet';
  quotes: { path: string; start: number; end: number; text: string }[];
  callers: { function: string; callers: string[] }[];
  reason: string;
}

export interface ProofFindingRecord {
  /** The subject whose answer raised it: a requirement id, or ARTIFACTS. */
  from: string;
  id: string;
  location: string | null;
  sentence: string;
  claim: string;
}

export interface ProofResult {
  tree_hash: string;
  criteria: CriterionProof[];
  requirements: RequirementProof[];
  /** A changed behaviour at a caller that no requirement covers (FR-008). */
  caller_findings: ProofFindingRecord[];
  /** A sentence of the pull request body or a changed document describing behaviour the candidate does not have (FR-009). */
  artifact_findings: ProofFindingRecord[];
  /** Every open result, one line each; empty when the candidate is done. */
  open: string[];
}

const PROVEN_BEFORE = new Set(['failed-before', 'kept']);

export function judgeCriterion(c: CriterionInput): CriterionProof {
  const base = { criterion_id: c.id, kind: c.kind, tests: [...c.tests] };
  if (c.kind === 'person') return { ...base, status: 'waiting-on-person', audit: null, fail_before: null, reason: `${c.id} is person-checked: it waits on a person and is never proven by a test` };
  const fb = c.failBefore;
  const own = fb !== null && (fb.tests !== undefined || c.ui === true);
  const fbOk = own && (PROVEN_BEFORE.has(fb.outcome) || fb.accepted !== undefined);
  const audit = c.audit === null ? { answer: null, reason: 'no audit was run' } : auditAnswer(c.audit);
  const why: string[] = [];
  if (c.tests.length === 0) why.push('no test is mapped to it');
  if (!own) why.push('it has no fail-before outcome of its own');
  else if (!fbOk) why.push(`fail-before: ${fb.outcome}: ${fb.reason}`);
  if (audit.answer === 'yes') why.push(`the auditor answered yes, the test would still pass if it were false: ${audit.reason}`);
  else if (audit.answer === null) why.push(`no audit verdict: ${audit.reason}`);
  const fail_before = fb === null ? null : { outcome: fb.outcome, reason: fb.reason, ...(fb.accepted ? { accepted_by: fb.accepted.by } : {}) };
  if (why.length > 0) return { ...base, status: 'unproven', audit, fail_before, reason: why.join('; ') };
  return { ...base, status: 'proven', audit, fail_before, reason: `${fb!.accepted ? `accepted without fail-before by ${fb!.accepted.by}` : fb!.reason}; the auditor answered no: ${audit.reason}` };
}

export function judgeRequirement(r: RequirementInput): RequirementProof {
  const base = { id: r.id, wording: r.wording };
  const unmet = (reason: string, quotes: RequirementProof['quotes'] = [], callers: RequirementProof['callers'] = []): RequirementProof => ({ ...base, status: 'unmet', quotes, callers, reason });
  if (r.answer.missing !== null) return unmet(`no conformance answer: ${r.answer.missing}`);
  const mine = r.answer.findings.filter((f) => f.id === r.id);
  if (mine.length === 0) return unmet(`the conformance answer has no finding ${r.id}`);
  const quotes: RequirementProof['quotes'] = [];
  const callers: RequirementProof['callers'] = [];
  for (const f of mine) {
    const range = parseRange(f.location);
    if (range) quotes.push({ ...range, text: f.evidence });
    if (f.severity !== 'info') return unmet(`unmet: ${f.claim}`, quotes);
  }
  if (quotes.length === 0) return unmet('the answer quotes no file and line range');
  for (const q of quotes) {
    const wrong = quoteMismatch(r.file(q.path), q, q.text);
    if (wrong !== null) return unmet(`the quote does not match the candidate byte for byte: ${wrong}`, quotes);
    const c = r.callers(q.path, q.start, q.end);
    if (c !== null && !callers.some((x) => x.function === c.function)) callers.push(c);
  }
  return { ...base, status: 'met', quotes, callers, reason: mine.map((f) => f.claim).join('; ') };
}

/** Findings of a conformance or artifact answer other than the requirement's own: open findings. */
export function otherFindings(from: string, a: ProofAnswer, own: string | null): ProofFindingRecord[] {
  return a.findings.filter((f) => f.id !== own && f.severity !== 'info').map((f) => ({ from, id: f.id, location: f.location, sentence: f.evidence, claim: f.claim }));
}

export function judgeProof(input: { treeHash: string; criteria: CriterionInput[]; requirements: RequirementInput[]; artifacts: ProofAnswer | null }): ProofResult {
  const criteria = input.criteria.map(judgeCriterion);
  const requirements = input.requirements.map(judgeRequirement);
  const seen = new Set<string>();
  const caller_findings = input.requirements.flatMap((r) => otherFindings(r.id, r.answer, r.id)).filter((f) => {
    const key = `${f.location ?? ''}\n${f.claim}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const artifact_findings: ProofFindingRecord[] = input.artifacts === null ? [] : otherFindings('ARTIFACTS', input.artifacts, null);
  const open = [
    ...criteria.filter((c) => c.status === 'unproven').map((c) => `${c.criterion_id} is unproven: ${c.reason}`),
    ...requirements.filter((r) => r.status === 'unmet').map((r) => `${r.id} is unmet: ${r.reason}`),
    ...caller_findings.map((f) => `${f.id}${f.location ? ` at ${f.location}` : ''}: ${f.claim}`),
    ...(input.artifacts?.missing ? [`the artifact check gave no answer: ${input.artifacts.missing}`] : []),
    ...artifact_findings.map((f) => `${f.id}${f.location ? ` at ${f.location}` : ''}: "${f.sentence}": ${f.claim}`),
  ];
  return { tree_hash: input.treeHash, criteria, requirements, caller_findings, artifact_findings, open };
}
