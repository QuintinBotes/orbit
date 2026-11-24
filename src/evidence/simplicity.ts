import { execCapture } from '../core/exec.ts';
import { compileGlobs } from '../policy/globs.ts';
import type { CheckStatus } from './types.ts';

/**
 * The simplicity gate (issue #232). A check whose id is `simplicity` runs Unknot's base-compared diagnosis on the
 * candidate's checkout, as the shell script
 *   unknot diagnose --baseline "$ORBIT_BASE_REVISION" --fail-on new:high --json
 * (ORBIT_BASE_REVISION is the candidate's parent, `HEAD` on the base revision itself, where nothing is new). Unknot
 * exits 1 for a new finding at the severity, 5 for a base it cannot map. No model and no network. This reads that
 * check's output into the note that names each new finding, and fails an Unknot too old to compare against a base.
 */

export const SIMPLICITY_ID = /^simplicity([-_.:].*)?$/i;
export const isSimplicityCheck = (id: string): boolean => SIMPLICITY_ID.test(id);

/** Unknot before 0.4.0 ignores --baseline and prints no schema_version. */
export const MIN_UNKNOT: readonly [number, number, number] = [0, 4, 0];
const MIN_TEXT = MIN_UNKNOT.join('.');
/** Findings named in a failure note: with its header and the count of the rest, the note stays within the ten lines an excerpt keeps. */
const LISTED = 8;
const EVIDENCE_LISTED = 3;

export const UNKNOT_INSTALL = 'claude plugin install unknot@quintinbotes, then node <plugin directory>/bin/unknot cli install (the launcher), or update with claude plugin update unknot@quintinbotes';

interface UnknotFinding {
  kind?: string;
  severity?: string;
  location?: string;
  title?: string;
  smallest_simplification?: string;
  evidence?: { summary?: string; source_ref?: string }[];
}
interface UnknotDocument {
  schema_version?: string;
  findings?: UnknotFinding[];
  error?: { code?: string; message?: string };
}

const oneLine = (s: unknown, max = 200): string => String(s ?? '').split('\n')[0]!.trim().slice(0, max);

/** The JSON document in a check's log, which interleaves unknot's stderr lines with it; null when there is none. */
function documentIn(body: string): UnknotDocument | null {
  const start = body.search(/^\{\s*"(?:schema_version|error|stats)"/m);
  if (start < 0) return null;
  const end = body.lastIndexOf('}');
  try {
    const v = JSON.parse(body.slice(start, end + 1)) as UnknotDocument;
    return v !== null && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

const evidenceOf = (f: UnknotFinding): string =>
  (f.evidence ?? [])
    .slice(0, EVIDENCE_LISTED)
    .map((e) => `${oneLine(e.source_ref, 80)} ${oneLine(e.summary, 100)}`.trim())
    .filter(Boolean)
    .join('; ');

export interface SimplicityVerdict {
  /** Set only when the check's own status must change (a pass that checked nothing becomes a failure). */
  status?: 'FAILED';
  note: string;
}

/** What the gate says about a finished simplicity check, or null when its own status and log stand (a pass, or a failure that is not the gate's to explain). */
export function judgeSimplicity(input: { body: string; exitCode: number | null; status: CheckStatus; timeoutSeconds: number }): SimplicityVerdict | null {
  const { body, exitCode, status } = input;
  if (status === 'TIMEOUT') {
    return { note: `simplicity gate: unknot did not finish mapping within ${input.timeoutSeconds} s; raise this check's timeout_seconds or map a smaller scope` };
  }
  if (status !== 'PASSED' && status !== 'FAILED') return null;
  const doc = documentIn(body);
  if (status === 'PASSED') {
    if (doc?.schema_version?.startsWith('1.')) return null;
    return { status: 'FAILED', note: `simplicity gate: the output is not unknot's schema 1.x document, so it compared nothing against the base; the gate needs unknot ${MIN_TEXT} or newer (${UNKNOT_INSTALL})` };
  }
  if (exitCode === 5 || doc?.error?.code === 'UK_BASELINE_INVALID') return { note: `simplicity gate: the base could not be mapped: ${oneLine(doc?.error?.message) || 'unknot exited 5'}` };
  if (exitCode === 1 && doc?.schema_version?.startsWith('1.') && Array.isArray(doc.findings)) {
    const high = doc.findings.filter((f) => f.severity === 'high');
    const listed = high.length > 0 ? high : doc.findings;
    const lines = listed.slice(0, LISTED).map((f) => {
      const ev = evidenceOf(f);
      return `- [${oneLine(f.severity, 10) || '?'}] ${oneLine(f.kind, 60)} ${oneLine(f.location, 100) || '?'}: ${oneLine(f.title)}${ev ? ` (evidence: ${ev})` : ''}`;
    });
    if (listed.length > LISTED) lines.push(`(${listed.length - LISTED} more)`);
    return { note: [`simplicity gate: ${listed.length} new high-severity finding${listed.length === 1 ? '' : 's'} against the base`, ...lines].join('\n') };
  }
  // The shell could not start unknot (127, 126) or it was killed: the environment's failure, which the runner's own reading names.
  if (exitCode === 127 || exitCode === 126 || exitCode === null) return null;
  return { note: `simplicity gate: unknot failed (exit ${exitCode ?? 'none'}) with output that is unreadable as its schema 1.x document` };
}

/** Why `unknot --version` output is no use to the gate, or null when it is (an unrecognised form is not refused: the run says what it found). */
export function unknotVersionProblem(output: string | null): string | null {
  if (output === null) return 'unknot is not installed';
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(output);
  if (!m) return null;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = MIN_UNKNOT.findIndex((n, i) => got[i] !== n);
  return at !== -1 && got[at]! < MIN_UNKNOT[at]! ? `unknot ${got.join('.')} is older than ${MIN_TEXT}, which ignores --baseline` : null;
}

/** `unknot --version` where `cwd` and `env` resolve it: its first line, or null when it is not installed or does not answer. */
export async function probeUnknot(env: Readonly<Record<string, string | undefined>>, cwd: string): Promise<string | null> {
  try {
    const r = await execCapture(['unknot', '--version'], { cwd, env: env as NodeJS.ProcessEnv, timeoutMs: 15_000 });
    return r.exitCode === 0 ? oneLine(r.stdout) || 'unknown' : null;
  } catch {
    return null;
  }
}

/** The planner's advisory text from `unknot diagnose --json` of the scope: its findings in Unknot's rank order, those in the goal's allowed paths, at most `limit`; null when none apply. */
export function simplifyFindingsBlock(text: string, allowedPaths: readonly string[], limit: number): string | null {
  const doc = documentIn(text);
  if (!doc?.schema_version?.startsWith('1.') || !Array.isArray(doc.findings)) return null;
  const inScope = compileGlobs(allowedPaths, { nocase: false });
  const keep = doc.findings.filter((f) => inScope(oneLine(f.location, 300).replace(/:\d+$/, ''))).slice(0, limit);
  if (keep.length === 0) return null;
  return keep
    .map((f, i) => {
      const fix = oneLine(f.smallest_simplification, 240);
      return `${i + 1}. [${oneLine(f.severity, 10) || '?'}] ${oneLine(f.kind, 60)} ${oneLine(f.location, 100) || '?'}: ${oneLine(f.title)}${fix ? `\n   smallest simplification: ${fix}` : ''}`;
    })
    .join('\n');
}

/** A goal labelled `simplify` (an issue's label): its planner is given the scope's findings, when the simplicity check is configured. */
export const isSimplifyGoal = (issue: { labels: readonly string[] } | null): boolean => issue?.labels.some((l) => l.trim().toLowerCase() === 'simplify') ?? false;

/** The findings of the whole repository, ranked, from `unknot diagnose --json` in `repo`; null when unknot gave none (not installed, not initialised, over `timeoutSeconds`). */
export async function unknotFindings(repo: string, env: Readonly<Record<string, string | undefined>>, timeoutSeconds: number): Promise<string | null> {
  try {
    const r = await execCapture(['unknot', 'diagnose', '--json', '--limit', '50'], { cwd: repo, env, timeoutMs: timeoutSeconds * 1000 });
    return r.exitCode === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}
