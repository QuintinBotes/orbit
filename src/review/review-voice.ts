/**
 * Review Voice as the same-family review pass (issue #231, review.mode: review-voice). The controller runs Review Voice's
 * CLI on the exact candidate diff, outside any worker, so the reviewer worker stays read-only and the owner's corpus never
 * enters a worker session. The CLI prints a `review-output` document (Review Voice's schemas/review-output.schema.json)
 * for `--base <rev> --head <rev>`; this module maps its verified findings onto Orbit review findings.
 *
 * Severity: blocking is high, important medium, minor low, nit and question info. A blocking finding asks for repair; any
 * other finding is advisory or ranks as Orbit ranks its own reviewer's findings of that severity.
 */
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { redact } from '../core/redact.ts';
import { OrbitError } from '../core/errors.ts';
import type { IngestedFinding, IngestedReview, FindingSeverity } from './types.ts';

/** The decision recorded when Review Voice could not give the review and the default reviewer stood in. */
export const REVIEW_VOICE_FALLBACK_KIND = 'review.review-voice-fallback';

/** The model name a Review Voice review is recorded under: no model reviewed, the CLI did. */
export const REVIEW_VOICE_MODEL = 'review-voice';

export const REVIEW_VOICE_SEVERITY: Readonly<Record<string, FindingSeverity>> = Object.freeze({ blocking: 'high', important: 'medium', minor: 'low', nit: 'info', question: 'info' });

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A review-output document as an Orbit review of `commit`. Throws MALFORMED_OUTPUT for anything else. */
export function mapReviewVoiceOutput(raw: unknown, commit: string): IngestedReview {
  if (!isRecord(raw) || !Array.isArray(raw.findings)) throw new OrbitError('MALFORMED_OUTPUT', 'the Review Voice output is not a review-output document (no findings list)');
  const findings: IngestedFinding[] = [];
  const seen = new Set<string>();
  for (const f of raw.findings) {
    if (!isRecord(f) || typeof f.finding_id !== 'string' || typeof f.path !== 'string' || typeof f.line !== 'number' || typeof f.text !== 'string') {
      throw new OrbitError('MALFORMED_OUTPUT', 'a Review Voice finding lacks finding_id, path, line or text');
    }
    const severity = REVIEW_VOICE_SEVERITY[String(f.severity)];
    if (!severity) throw new OrbitError('MALFORMED_OUTPUT', `Review Voice finding ${f.finding_id} has the unknown severity ${JSON.stringify(f.severity)}`);
    if (seen.has(f.finding_id)) throw new OrbitError('MALFORMED_OUTPUT', `Review Voice output repeats finding id ${f.finding_id}`);
    seen.add(f.finding_id);
    const path = redact(f.path).trim();
    const location = `${path}:${f.line}`;
    findings.push({
      externalId: f.finding_id,
      severity,
      category: typeof f.category === 'string' && f.category.trim() ? redact(f.category).trim() : 'review-voice',
      location,
      path,
      line: f.line,
      claim: redact(f.text).trim(),
      evidence: `Review Voice ${String(f.severity)} finding ${f.finding_id} at ${location}; Review Voice's own pipeline verified it on this candidate's diff.`,
      suggestedValidation: null,
    });
  }
  return { verdict: findings.some((f) => f.severity === 'high') ? 'REPAIR_REQUIRED' : 'APPROVE', candidateRevision: commit, findings, warnings: [] };
}

/** Each of stdout and stderr is held to this many bytes; a CLI that prints more is killed and counts as a failure. */
export const REVIEW_VOICE_MAX_BUFFER = 16 * 1024 * 1024;

export type ReviewVoiceExec = (file: string, args: string[], opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; maxBuffer?: number }) => Promise<{ stdout: string; timedOut: boolean }>;

export const execReviewVoice: ReviewVoiceExec = (file, args, opts) =>
  new Promise((resolve, reject) => {
    // No shell. SIGKILL, not the default SIGTERM: a CLI that ignores SIGTERM would hang the controller. The callback runs on 'close'.
    execFile(file, args, { cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs, killSignal: 'SIGKILL', maxBuffer: opts.maxBuffer ?? REVIEW_VOICE_MAX_BUFFER, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (!err) return resolve({ stdout, timedOut: false });
      if ((err as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return reject(new Error('Review Voice printed more than the output cap'));
      if ((err as { killed?: boolean }).killed === true) return resolve({ stdout: '', timedOut: true });
      reject(new Error(`${err.message}${stderr ? `: ${String(stderr).trim().slice(0, 300)}` : ''}`));
    });
  });

export type ReviewVoiceRun = { ok: true; output: unknown; attempts: number } | { ok: false; reason: string; attempts: number };

/** One run, retried once after any failure (a timeout, a non-zero exit, output that is not JSON); then the caller falls back. */
export async function runReviewVoice(
  input: { command: readonly string[]; cwd: string; base: string; head: string; timeoutMs: number; env: NodeJS.ProcessEnv; maxBuffer?: number },
  exec: ReviewVoiceExec = execReviewVoice,
): Promise<ReviewVoiceRun> {
  const [file, ...prefix] = input.command;
  let reason = 'no command';
  for (let attempts = 1; attempts <= 2; attempts++) {
    try {
      const r = await exec(file!, [...prefix, '--base', input.base, '--head', input.head, '--json'], { cwd: input.cwd, timeoutMs: input.timeoutMs, env: input.env, ...(input.maxBuffer !== undefined ? { maxBuffer: input.maxBuffer } : {}) });
      if (r.timedOut) reason = `Review Voice timed out after ${Math.round(input.timeoutMs / 1000)} s`;
      else {
        try {
          return { ok: true, output: JSON.parse(r.stdout), attempts };
        } catch {
          reason = 'Review Voice output is not valid JSON';
        }
      }
    } catch (err) {
      reason = `Review Voice could not be run: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  return { ok: false, reason, attempts: 2 };
}

/** Review Voice's data directory, as its own CLI resolves it (src/store/paths.ts there). */
export function reviewVoiceDataDir(env: NodeJS.ProcessEnv): string {
  const override = env.REVIEW_VOICE_DATA_DIR;
  if (override) return override;
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'review-voice');
  if (process.platform === 'win32') return join(env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'review-voice');
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'review-voice');
}

function executable(path: string): boolean {
  try {
    return statSync(path).isFile() && (accessSync(path, constants.X_OK), true);
  } catch {
    return false;
  }
}

/** Whether the command is configured and installed and Review Voice is set up (its database exists); the reason when not. */
export function reviewVoiceAvailability(setting: { command: readonly string[] } | undefined, env: NodeJS.ProcessEnv): { ok: true } | { ok: false; reason: string } {
  const cmd = setting?.command?.[0];
  if (!cmd) return { ok: false, reason: 'review.review_voice.command is not set' };
  const found = cmd.includes('/') ? executable(cmd) : (env.PATH ?? '').split(delimiter).some((d) => d !== '' && executable(join(d, cmd)));
  if (!found) return { ok: false, reason: `Review Voice is not installed: ${cmd} was not found or is not executable` };
  if (!existsSync(join(reviewVoiceDataDir(env), 'review-voice.db'))) return { ok: false, reason: `Review Voice is not set up: no database in ${reviewVoiceDataDir(env)} (run /review-voice:init)` };
  return { ok: true };
}
