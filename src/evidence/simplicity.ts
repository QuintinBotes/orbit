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

/** Exactly `simplicity` or `simplicity-...`, case-sensitive: any other name stays an ordinary check. */
export const SIMPLICITY_ID = /^simplicity(-.*)?$/;
export const isSimplicityCheck = (id: string): boolean => SIMPLICITY_ID.test(id);

/** Unknot before 0.4.0 ignores --baseline and prints no schema_version. */
export const MIN_UNKNOT: readonly [number, number, number] = [0, 4, 0];
const MIN_TEXT = MIN_UNKNOT.join('.');
/** Findings named in a failure note: with its header and the count of the rest, the note stays within the ten lines an excerpt keeps. */
const LISTED = 8;
const EVIDENCE_LISTED = 3;

export const UNKNOT_INIT = 'run /unknot:init in the repository and commit the .unknot directory, including .unknot/.gitignore';

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
  baseline?: { new?: number };
  findings?: UnknotFinding[];
  error?: { code?: string; message?: string };
}

const oneLine = (s: unknown, max = 200): string => String(s ?? '').split('\n')[0]!.trim().slice(0, max);

/** The end of the JSON object that starts at `start` (strings and escapes respected), or -1 when it never closes. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

/** The JSON document in a check's log, which interleaves unknot's stderr lines with it, before and after; null when there is none. */
function documentIn(body: string): UnknotDocument | null {
  const start = body.search(/^\{\s*"(?:schema_version|error|stats)"/m);
  const end = start < 0 ? -1 : objectEnd(body, start);
  if (end < 0) return null;
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
    // High ones first, then the rest in unknot's order: a lower severity is shown, not dropped.
    const ordered = [...high, ...doc.findings.filter((f) => f.severity !== 'high')];
    const total = Math.max(typeof doc.baseline?.new === 'number' ? doc.baseline.new : 0, ordered.length);
    const lines = ordered.slice(0, LISTED).map((f) => {
      const ev = evidenceOf(f);
      return `- [${oneLine(f.severity, 10) || '?'}] ${oneLine(f.kind, 60)} ${oneLine(f.location, 100) || '?'}: ${oneLine(f.title)}${ev ? ` (evidence: ${ev})` : ''}`;
    });
    if (ordered.length > LISTED) lines.push(`(${ordered.length - LISTED} more)`);
    const showing = ordered.length < total ? `, showing ${ordered.length}` : '';
    return { note: [`simplicity gate: ${total} new finding${total === 1 ? '' : 's'} against the base (${high.length} high-severity)${showing}`, ...lines].join('\n') };
  }
  // The shell could not start unknot (127, 126) or it was killed: the environment's failure, which the runner's own reading names.
  if (exitCode === 127 || exitCode === 126 || exitCode === null) return null;
  return { note: `simplicity gate: unknot failed (exit ${exitCode ?? 'none'}) with output that is unreadable as its schema 1.x document` };
}

/** What `unknot --version` did where the check will run it. */
export type UnknotProbe = { state: 'missing' } | { state: 'failed'; exitCode: number | null } | { state: 'ok'; output: string };

/** Why a probe is no use to the gate, or null when it is. */
export function unknotVersionProblem(probe: UnknotProbe): string | null {
  if (probe.state === 'missing') return 'unknot is not installed';
  if (probe.state === 'failed') return `unknot is installed but broken: --version exited ${probe.exitCode === null ? 'by signal' : `with exit ${probe.exitCode}`}`;
  const m = /(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?/.exec(probe.output);
  if (!m) return `cannot tell the version of unknot (--version printed ${JSON.stringify(oneLine(probe.output, 60))})`;
  const got = [Number(m[1]), Number(m[2]), Number(m[3])];
  const at = MIN_UNKNOT.findIndex((n, i) => got[i] !== n);
  // A prerelease of x.y.z is before x.y.z.
  const older = at !== -1 ? got[at]! < MIN_UNKNOT[at]! : m[4] !== undefined;
  return older ? `unknot ${m[0]} is older than ${MIN_TEXT}, which ignores --baseline` : null;
}

/** Why the repository is no Unknot project for a check, from its tracked files; null when it is. A check runs in a checkout of the candidate, so `unknot diagnose` finds a missing project (UK_NOT_INITIALIZED), and writes its own .gitignore where there is none, which shows as a change. */
export function unknotProjectProblem(tracked: readonly string[]): string | null {
  if (!tracked.some((f) => f.startsWith('.unknot/'))) return 'the repository has no committed .unknot directory, so unknot diagnose fails with UK_NOT_INITIALIZED in every checkout';
  if (!tracked.includes('.unknot/.gitignore')) return 'the committed .unknot has no .unknot/.gitignore, so a check would write one into its checkout, and its state would show as a change';
  return null;
}

/** `unknot --version` with `env` (the PATH the check will run with): missing, failed, or its first line. */
export async function probeUnknot(env: Readonly<Record<string, string | undefined>>, cwd: string): Promise<UnknotProbe> {
  try {
    const r = await execCapture(['unknot', '--version'], { cwd, env, timeoutMs: 15_000 });
    return r.exitCode === 0 ? { state: 'ok', output: oneLine(r.stdout) } : { state: 'failed', exitCode: r.exitCode };
  } catch {
    return { state: 'missing' };
  }
}

/** The planner's advisory text from `unknot diagnose --json` of the scope: its findings in Unknot's rank order, those in the goal's allowed paths, at most `limit`; null when none apply. */
export function simplifyFindingsBlock(text: string, allowedPaths: readonly string[], limit: number): string | null {
  const doc = documentIn(text);
  if (!doc?.schema_version?.startsWith('1.') || !Array.isArray(doc.findings)) return null;
  const inScope = compileGlobs(allowedPaths, { nocase: false });
  const keep = doc.findings.filter((f) => inScope(oneLine(f.location, 300).replace(/:\d+$/, ''))).slice(0, limit);
  if (keep.length === 0) return null;
  const head = "From unknot's map of the base revision, built for this plan (not the working copy), in unknot's rank order:\n";
  return head + keep
    .map((f, i) => {
      const fix = oneLine(f.smallest_simplification, 240);
      return `${i + 1}. [${oneLine(f.severity, 10) || '?'}] ${oneLine(f.kind, 60)} ${oneLine(f.location, 100) || '?'}: ${oneLine(f.title)}${fix ? `\n   smallest simplification: ${fix}` : ''}`;
    })
    .join('\n');
}

/** A goal labelled `simplify` (an issue's label): its planner is given the scope's findings, when the simplicity check is configured. */
export const isSimplifyGoal = (issue: { labels: readonly string[] } | null): boolean => issue?.labels.some((l) => l.trim().toLowerCase() === 'simplify') ?? false;

/**
 * Unknot's findings for `scope` (the allowed paths, which unknot takes as its own scope arguments), after mapping `dir`.
 * `dir` is the run's own worktree, not the user's checkout: unknot keeps its state in the project's ignored .unknot/state,
 * and the worktree is Orbit's to write to (admission requires the committed .unknot/.gitignore that keeps it out of a
 * candidate). It runs on the host because it is advisory input for the planner, which has no tool for it, and it reads
 * and maps only that worktree; a failure of any step gives null and the planner prompt is unchanged. The limit is
 * generous, since the caller filters by the goal's paths afterwards.
 */
export async function unknotFindings(dir: string, scope: readonly string[], env: Readonly<Record<string, string | undefined>>, timeoutSeconds: number): Promise<string | null> {
  try {
    const opts = { cwd: dir, env, timeoutMs: timeoutSeconds * 1000 };
    if ((await execCapture(['unknot', 'map'], opts)).exitCode !== 0) return null;
    const r = await execCapture(['unknot', 'diagnose', '--json', '--limit', '500', ...scope], opts);
    return r.exitCode === 0 ? r.stdout : null;
  } catch {
    return null;
  }
}
