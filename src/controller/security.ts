/**
 * Static security inputs for the gate (spec section 5, docs/decisions/0001):
 * a secret scan of what the candidate changed, and the SAST checks the
 * policy defines.
 *
 * The scan runs gitleaks when it is installed, always with Orbit's own
 * configuration and `--ignore-gitleaks-allow`, on a directory holding only
 * the files the candidate added or modified (so a repository's .gitleaks.toml,
 * .gitleaksignore or inline allow comments cannot switch it off; gaps V10).
 * Without gitleaks, the built-in secret patterns of core/redact run over the
 * added lines and the result says which scanner ran. Findings are recorded
 * redacted: a secret value never reaches a log, an artifact or a model.
 *
 * Severity and exceptions (spec section 5, "explicit scanner severity and
 * exception rules"): every secret finding gets a severity from its rule, and
 * SAST output written as SARIF gets one from the result's level or its
 * security-severity score. `static_security.block_severities` decides which
 * findings block; the rest are reported as advisory. An entry of
 * `static_security.exceptions` waives findings of one rule (optionally under
 * one path glob) until it expires, and the waiver and its reason are
 * recorded with the result. `findings` holds only the blocking ones, which is
 * what the static security gate fails on.
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, join, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { atomicWrite, atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { execCapture } from '../core/exec.ts';
import picomatch from 'picomatch';
import { redact } from '../core/redact.ts';
import { git, gitEnv } from '../evidence/git.ts';
import { defaultStaticSecurity } from '../policy/config.ts';
import type { PolicySnapshot, StaticSecurityConfig, StaticSeverity } from '../policy/types.ts';
import { exceptionExpiryMs } from '../review/resolve.ts';

export interface SecretFinding {
  file: string;
  line: number | null;
  rule: string;
  /** From the rule (secretSeverity); absent only in results recorded before severities existed. */
  severity?: StaticSeverity;
}

/** A finding a policy exception waived, with the exception's reason. */
export interface ExceptedFinding<F> {
  finding: F;
  rule_id: string;
  reason: string;
  expires: string | null;
}

export interface StaticClassification<F> {
  /** At or above a blocking severity and not excepted. */
  blocking: F[];
  /** Below every blocking severity: reported, not blocking. */
  advisory: F[];
  excepted: ExceptedFinding<F>[];
  /** Exceptions that matched a finding but had expired, so did not waive it. */
  expired: { rule_id: string; expires: string }[];
}

export interface SecretScanResult {
  scanner: 'gitleaks' | 'builtin';
  /** True when the scan ran to completion; false means nothing can be concluded. */
  completed: boolean;
  /** Findings that block under the static security policy. */
  findings: SecretFinding[];
  /** Findings below the blocking severities. */
  advisory?: SecretFinding[];
  /** Findings a policy exception waived, with its reason. */
  excepted?: ExceptedFinding<SecretFinding>[];
  files: number;
  /** Plain words for the evidence report: which scanner, and why not gitleaks when it did not run. */
  note: string;
  reportPath: string;
}

export interface SecretScanInput {
  repoRoot: string;
  baseRev: string;
  commit: string;
  /** Evidence directory for this candidate's security artifacts. */
  outDir: string;
  /** null forces the built-in patterns; undefined searches PATH. */
  gitleaksPath?: string | null;
  hostPath?: string;
  timeoutMs?: number;
  /** `static_security` from the run's policy snapshot. Default: block critical and high, no exceptions. */
  policy?: StaticSecurityConfig;
  /** Clock reading for exception expiry. Without it a dated exception cannot be shown to be current and does not apply. */
  now?: number;
  /** Largest file the built-in detector will stream. A larger one is reported as unscannable. Default 1 GiB. */
  maxScanBytes?: number;
}

/** Rule of the finding recorded for a changed file that no scanner could read; it blocks like a secret unless a policy exception waives it. */
export const UNSCANNABLE_RULE = 'unscannable-file';

/** Orbit's trusted gitleaks configuration: the default rules, no allowlist the repository could widen. */
export const TRUSTED_GITLEAKS_CONFIG = 'title = "orbit trusted secret scan"\n\n[extend]\nuseDefault = true\n';

const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_SCAN_BYTES = 1024 * 1024 * 1024;
/** Streaming scan: text is judged in windows of this size, each overlapping the last so a secret on a very long line is not cut. */
const SCAN_WINDOW = 1024 * 1024;
const SCAN_OVERLAP = 8 * 1024;

export function findOnPath(name: string, pathVar: string | undefined = process.env.PATH): string | null {
  for (const dir of (pathVar ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, name);
    try {
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return p;
    } catch {
      /* not here */
    }
  }
  return null;
}

/** Files the candidate added, copied or modified (deletions cannot leak), as repository-relative paths. */
async function changedFiles(repoRoot: string, base: string, commit: string): Promise<string[]> {
  const out = await git(repoRoot, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=ACMRT', base, commit, '--']);
  return out.split('\0').filter((p) => p.length > 0);
}

export async function scanCandidateSecrets(input: SecretScanInput): Promise<SecretScanResult> {
  const reportPath = join(input.outDir, 'secret-scan.json');
  const prior = readJsonIfExists<SecretScanResult & { commit?: string; raw?: SecretFinding[] }>(reportPath);
  // Bound to the commit: the same candidate is never scanned twice, a different one always is. The policy is applied
  // to the recorded raw findings again, so a reused scan is judged by the policy in force now.
  if (prior && prior.completed && prior.commit === input.commit) {
    const { raw, commit: _commit, ...rest } = prior;
    return withPolicy({ ...rest, findings: raw ?? prior.findings }, input);
  }

  const changed = await changedFiles(input.repoRoot, input.baseRev, input.commit);
  const { small: files, large, unscannable } = await partitionBySize(input, changed);
  const gitleaks = input.gitleaksPath === null ? null : (input.gitleaksPath ?? findOnPath('gitleaks', input.hostPath));
  let result: SecretScanResult | null = null;
  let why = gitleaks ? '' : 'gitleaks is not installed';
  if (gitleaks && files.length > 0) {
    try {
      result = await runGitleaks(gitleaks, input, files, reportPath);
    } catch (err) {
      why = `gitleaks could not complete (${err instanceof Error ? err.message : String(err)})`;
    }
  } else if (gitleaks) {
    result = { scanner: 'gitleaks', completed: true, findings: [], files: 0, note: changed.length === 0 ? 'gitleaks: the candidate adds or modifies no files' : 'gitleaks: every changed file is above its input limit', reportPath };
  }
  result ??= await builtinScan(input, files, reportPath, why);
  // Files above the gitleaks input limit are not skipped: the built-in detector streams them in chunks. A file
  // that cannot be read at all is a blocking finding of its own, so the scan is not reported as clean.
  if (large.length > 0 || unscannable.length > 0) {
    const bigFindings: SecretFinding[] = [];
    for (const rel of large) {
      try {
        bigFindings.push(...(await scanBlobInChunks(input.repoRoot, input.commit, rel)));
      } catch {
        unscannable.push(rel);
      }
    }
    for (const rel of unscannable) bigFindings.push({ file: rel, line: null, rule: UNSCANNABLE_RULE, severity: 'critical' });
    // `files` stays what the main scan covered; the files streamed here are counted in the note.
    const noteBits = [`${large.length} file(s) above ${MAX_FILE_BYTES} bytes scanned by the built-in detector in chunks`];
    if (unscannable.length > 0) noteBits.push(`${unscannable.length} file(s) could not be scanned: ${unscannable.slice(0, 10).join(', ')}`);
    result = { ...result, findings: [...result.findings, ...bigFindings], note: `${result.note}; ${noteBits.join('; ')}` };
  }
  const raw = result.findings.map((f) => ({ ...f, severity: f.severity ?? secretSeverity(f.rule) }));
  const judged = withPolicy({ ...result, findings: raw }, input);
  atomicWriteJson(reportPath, { ...judged, raw, commit: input.commit });
  return judged;
}

function withPolicy(result: SecretScanResult, input: Pick<SecretScanInput, 'policy' | 'now'>): SecretScanResult {
  const all = result.findings.map((f) => ({ ...f, severity: f.severity ?? secretSeverity(f.rule) }));
  const c = classifyStaticFindings(all, input.policy ?? defaultStaticSecurity(), input.now);
  // A file nobody could read is not a finding to weigh against block_severities: it means the scan did not look at
  // it. Unless a policy exception waives it (path and rule), it blocks and the scan is incomplete, whatever the
  // blocking severities are; the exception is what restores completeness.
  const unreadable = new Set(c.advisory.filter((f) => f.rule === UNSCANNABLE_RULE));
  const blocking = unreadable.size === 0 ? c.blocking : all.filter((f) => unreadable.has(f) || c.blocking.includes(f));
  const advisory = unreadable.size === 0 ? c.advisory : c.advisory.filter((f) => !unreadable.has(f));
  const parts = [baseNote(result.note)];
  if (c.excepted.length > 0) parts.push(`${c.excepted.length} finding(s) waived by static_security.exceptions: ${c.excepted.slice(0, 10).map((e) => `${e.finding.rule} at ${e.finding.file}${e.finding.line ? `:${e.finding.line}` : ''} (${e.reason})`).join('; ')}`);
  if (advisory.length > 0) parts.push(`${advisory.length} advisory finding(s) below the blocking severities: ${advisory.slice(0, 10).map((f) => `${f.rule} [${f.severity}] at ${f.file}${f.line ? `:${f.line}` : ''}`).join('; ')}`);
  if (c.expired.length > 0) parts.push(`expired exception(s) not applied: ${c.expired.map((e) => `${e.rule_id} (expired ${e.expires})`).join(', ')}`);
  const completed = !blocking.some((f) => f.rule === UNSCANNABLE_RULE);
  return { ...result, completed, findings: blocking, advisory, excepted: c.excepted, note: parts.join('; ') };
}

/** The scanner's own note, without the policy summary a previous judgement appended. */
function baseNote(note: string): string {
  const i = note.search(/; (?:\d+ finding\(s\) waived|\d+ advisory finding|expired exception)/);
  return i === -1 ? note : note.slice(0, i);
}

// ---------------------------------------------------------------------------
// Severity and exceptions

/**
 * Credentials that grant access to an account, a cloud or a signing identity
 * are critical; any other detected secret is high. Both block under the
 * default policy, so only an explicit policy can make a secret advisory.
 */
const CRITICAL_SECRET_RULE = /(?:^|[:_-])(?:private-key|aws|gcp|azure|github|gitlab|anthropic|openai|stripe|slack-(?:bot|user|app|legacy)|npm-access|pypi|twilio|sendgrid|heroku|digitalocean|doppler|hashicorp|vault|age-secret|jwt-base64)(?:[:_-]|$)/i;

export function secretSeverity(rule: string): StaticSeverity {
  return CRITICAL_SECRET_RULE.test(rule) ? 'critical' : 'high';
}

/**
 * Split findings by the policy: an exception for the finding's rule (and
 * path, when it names a glob) that has not expired waives it; otherwise it
 * blocks when its severity is listed in `block_severities` and is advisory
 * when it is not. An exception's `rule_id` matches the rule exactly, or the
 * built-in scanner's `builtin:<kind>` by its kind.
 */
export function classifyStaticFindings<F extends { file: string | null; rule: string; severity?: StaticSeverity }>(findings: readonly F[], policy: StaticSecurityConfig, now: number | undefined): StaticClassification<F> {
  const out: StaticClassification<F> = { blocking: [], advisory: [], excepted: [], expired: [] };
  const matchers = policy.exceptions.map((e) => (e.path_glob === null ? () => true : picomatch(e.path_glob, { dot: true })));
  for (const f of findings) {
    const severity = f.severity ?? secretSeverity(f.rule);
    let waived = false;
    for (let i = 0; i < policy.exceptions.length; i++) {
      const e = policy.exceptions[i]!;
      if (e.rule_id !== f.rule && `builtin:${e.rule_id}` !== f.rule) continue;
      if (!matchers[i]!(f.file ?? '')) continue;
      if (e.expires !== null && (now === undefined || now > exceptionExpiryMs(e.expires))) {
        if (!out.expired.some((x) => x.rule_id === e.rule_id && x.expires === e.expires)) out.expired.push({ rule_id: e.rule_id, expires: e.expires });
        continue;
      }
      out.excepted.push({ finding: f, rule_id: e.rule_id, reason: e.reason, expires: e.expires });
      waived = true;
      break;
    }
    if (waived) continue;
    if (policy.block_severities.includes(severity)) out.blocking.push(f);
    else out.advisory.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------
// SAST output (SARIF)

export interface SastFinding {
  file: string | null;
  line: number | null;
  rule: string;
  severity: StaticSeverity;
  message: string;
}

/**
 * Findings from a SARIF 2.1 log. Severity comes from the rule's or result's
 * `security-severity` property (a CVSS score, as CodeQL and Semgrep write
 * it) when present, otherwise from the result level: error is high, warning
 * medium, note and none low. Messages are redacted and bounded.
 */
export function parseSarif(text: string): SastFinding[] {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('the SARIF file is not valid JSON');
  }
  const runs = (doc as { runs?: unknown }).runs;
  if (!Array.isArray(runs)) throw new Error('the SARIF file has no runs array');
  const out: SastFinding[] = [];
  for (const run of runs as { results?: unknown; tool?: { driver?: { rules?: unknown } } }[]) {
    const rules = new Map<string, Record<string, unknown>>();
    const ruleList = run?.tool?.driver?.rules;
    if (Array.isArray(ruleList)) for (const r of ruleList as Record<string, unknown>[]) if (typeof r?.id === 'string') rules.set(r.id, r);
    if (!Array.isArray(run?.results)) continue;
    for (const res of run.results as Record<string, unknown>[]) {
      const ruleId = typeof res.ruleId === 'string' ? res.ruleId : typeof (res.rule as { id?: unknown })?.id === 'string' ? String((res.rule as { id: string }).id) : 'sast';
      const rule = rules.get(ruleId);
      const score = securitySeverity(res.properties) ?? securitySeverity(rule?.properties);
      const level = typeof res.level === 'string' ? res.level : typeof (rule?.defaultConfiguration as { level?: unknown })?.level === 'string' ? String((rule!.defaultConfiguration as { level: string }).level) : 'warning';
      const loc = Array.isArray(res.locations) ? (res.locations[0] as { physicalLocation?: { artifactLocation?: { uri?: unknown }; region?: { startLine?: unknown } } }) : undefined;
      const uri = loc?.physicalLocation?.artifactLocation?.uri;
      const line = loc?.physicalLocation?.region?.startLine;
      const message = typeof (res.message as { text?: unknown })?.text === 'string' ? String((res.message as { text: string }).text) : '';
      out.push({
        file: typeof uri === 'string' ? uri.replace(/^file:\/\//, '').replace(/^\.\//, '') : null,
        line: typeof line === 'number' ? line : null,
        rule: ruleId,
        severity: score !== null ? severityFromScore(score) : level === 'error' ? 'high' : level === 'warning' ? 'medium' : 'low',
        message: redact(message).slice(0, 300),
      });
    }
  }
  return out;
}

function securitySeverity(props: unknown): number | null {
  const v = (props as Record<string, unknown> | undefined)?.['security-severity'];
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function severityFromScore(score: number): StaticSeverity {
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  return 'low';
}

export interface SastVerdict {
  checkId: string;
  /**
   * The status the static security gate should judge. A failed check whose
   * SARIF holds only advisory or waived findings counts as PASSED; a check
   * that passed but reports blocking findings counts as FAILED. Without
   * SARIF the check's own status stands.
   */
  status: string | null;
  sarif: boolean;
  classification: StaticClassification<SastFinding> | null;
  note: string | null;
}

/**
 * Judge one SAST check's result under the policy, from the SARIF files
 * (`*.sarif`, `*.sarif.json`) it wrote to its artifacts directory
 * ($ORBIT_ARTIFACTS_DIR). Unreadable SARIF leaves the status as it was.
 */
export function judgeSastResult(
  result: { checkId: string; status: string | null; artifacts?: readonly { path: string; kind?: string }[] } | null | undefined,
  checkId: string,
  policy: StaticSecurityConfig,
  now: number | undefined,
): SastVerdict {
  if (!result) return { checkId, status: null, sarif: false, classification: null, note: null };
  const files = (result.artifacts ?? []).map((a) => a.path).filter((p) => /\.sarif(?:\.json)?$/i.test(p));
  if (files.length === 0 || (result.status !== 'PASSED' && result.status !== 'FAILED')) return { checkId, status: result.status, sarif: false, classification: null, note: null };
  const findings: SastFinding[] = [];
  try {
    for (const f of files) findings.push(...parseSarif(readFileSync(f, 'utf8')));
  } catch (err) {
    return { checkId, status: result.status, sarif: false, classification: null, note: `SAST check ${checkId}: SARIF output unreadable (${(err as Error).message}); its exit status stands` };
  }
  const c = classifyStaticFindings(findings, policy, now);
  const status = c.blocking.length > 0 ? 'FAILED' : 'PASSED';
  const bits = [`${c.blocking.length} blocking`, `${c.advisory.length} advisory`, `${c.excepted.length} waived`];
  const waived = c.excepted.slice(0, 10).map((e) => `${e.finding.rule} at ${e.finding.file ?? '?'} (${e.reason})`);
  return { checkId, status, sarif: true, classification: c, note: `SAST check ${checkId}: ${bits.join(', ')} finding(s) under static_security${waived.length ? `; waived: ${waived.join('; ')}` : ''}` };
}

async function runGitleaks(bin: string, input: SecretScanInput, files: string[], reportPath: string): Promise<SecretScanResult> {
  const work = join(input.outDir, 'secret-scan');
  rmSync(work, { recursive: true, force: true });
  const scanRoot = join(work, 'tree');
  // gitleaks honours a .gitleaksignore at the root of the scanned directory even with -i (verified on
  // 8.30.1), and the candidate's own files would put one there. They go one level down instead, where it
  // reads none, so a candidate cannot waive findings by fingerprint; the file itself is still scanned.
  const tree = join(scanRoot, 'files');
  const trusted = join(work, 'trusted');
  mkdirSync(tree, { recursive: true, mode: 0o700 });
  mkdirSync(trusted, { recursive: true, mode: 0o700 });
  const config = join(trusted, 'gitleaks.toml');
  atomicWrite(config, TRUSTED_GITLEAKS_CONFIG, 0o444);
  let copied = 0;
  for (const rel of files) {
    const target = normalize(join(tree, rel));
    if (!target.startsWith(tree + sep)) continue;
    const content = await git(input.repoRoot, ['cat-file', 'blob', `${input.commit}:${rel}`]);
    mkdirSync(dirname(target), { recursive: true });
    atomicWrite(target, content, 0o600);
    copied++;
  }
  const raw = join(work, 'gitleaks-report.json');
  const r = await execCapture([bin, 'dir', scanRoot, '-c', config, '-i', trusted, '--ignore-gitleaks-allow', '--redact', '-f', 'json', '-r', raw, '--no-banner', '--exit-code', '1'], {
    // GITLEAKS_CONFIG and friends from the host would outrank nothing here (-c wins), but the scan needs nothing from it either.
    env: { PATH: input.hostPath ?? process.env.PATH ?? '/usr/bin:/bin', HOME: tmpdir() },
    cwd: work,
    timeoutMs: input.timeoutMs ?? 120_000,
  });
  if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`exit ${r.exitCode ?? r.signal}: ${redact(r.stderr).slice(0, 300)}`);
  const parsed = existsSync(raw) ? (readJsonIfExists<{ File?: string; StartLine?: number; RuleID?: string }[]>(raw) ?? []) : [];
  const findings = parsed.map((f) => ({ file: relativeTo(tree, f.File ?? ''), line: typeof f.StartLine === 'number' ? f.StartLine : null, rule: String(f.RuleID ?? 'secret') }));
  if (r.exitCode === 1 && findings.length === 0) throw new Error('reported leaks but wrote no readable report');
  rmSync(scanRoot, { recursive: true, force: true });
  return { scanner: 'gitleaks', completed: true, findings, files: copied, note: 'gitleaks with Orbit\'s trusted configuration and --ignore-gitleaks-allow', reportPath };
}

function relativeTo(root: string, p: string): string {
  return p.startsWith(root + sep) ? p.slice(root.length + 1) : p;
}

/** Changed files split by size: under the gitleaks input limit, streamable above it, and unreadable (unknown size or above the hard limit). */
async function partitionBySize(input: SecretScanInput, changed: string[]): Promise<{ small: string[]; large: string[]; unscannable: string[] }> {
  const max = input.maxScanBytes ?? MAX_SCAN_BYTES;
  const small: string[] = [];
  const large: string[] = [];
  const unscannable: string[] = [];
  for (const rel of changed) {
    let size = NaN;
    try {
      size = Number((await git(input.repoRoot, ['cat-file', '-s', `${input.commit}:${rel}`])).trim());
    } catch {
      /* unknown size: unscannable */
    }
    if (!Number.isFinite(size) || size > max) unscannable.push(rel);
    else if (size > MAX_FILE_BYTES) large.push(rel);
    else small.push(rel);
  }
  return { small, large, unscannable };
}

/** The core/redact secret shapes over a whole blob, read as a stream in bounded windows. Throws when git cannot deliver the blob. */
async function scanBlobInChunks(repoRoot: string, commit: string, rel: string): Promise<SecretFinding[]> {
  const found = new Map<string, SecretFinding>();
  let line = 1;
  const judge = (text: string, at: number): void => {
    const red = redact(text);
    if (red === text) return;
    for (const m of red.matchAll(/\[REDACTED:([a-z0-9_-]+)\]/gi)) found.set(`${at}:${m[1]}`, { file: rel, line: at, rule: `builtin:${m[1]}` });
  };
  const child = spawn('git', ['cat-file', 'blob', `${commit}:${rel}`], { cwd: repoRoot, env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60_000);
  try {
    child.stdout.setEncoding('latin1');
    let carry = '';
    for await (const chunk of child.stdout as AsyncIterable<string>) {
      carry += chunk;
      let start = 0;
      for (let nl = carry.indexOf('\n', start); nl !== -1; nl = carry.indexOf('\n', start)) {
        judge(carry.slice(start, nl), line);
        line++;
        start = nl + 1;
      }
      carry = carry.slice(start);
      while (carry.length > SCAN_WINDOW) {
        judge(carry.slice(0, SCAN_WINDOW), line);
        carry = carry.slice(SCAN_WINDOW - SCAN_OVERLAP);
      }
    }
    if (carry.length > 0) judge(carry, line);
    const code = await exited;
    if (code !== 0) throw new Error(`git cat-file exited ${code}`);
  } finally {
    clearTimeout(timer);
    child.kill();
  }
  return [...found.values()];
}

/** Built-in fallback: the core/redact secret shapes over every added line. */
async function builtinScan(input: SecretScanInput, files: string[], reportPath: string, why: string): Promise<SecretScanResult> {
  const findings: SecretFinding[] = [];
  if (files.length > 0) {
    // `files` holds only the files under the input limit: larger ones are streamed by the caller, so a huge diff never has to fit in memory.
    const diff = await git(input.repoRoot, ['diff', '-U0', '--no-renames', '--no-ext-diff', '--no-textconv', '--text', input.baseRev, input.commit, '--', ...files.map((f) => `:(top,literal)${f}`)]);
    let file = '';
    let line = 0;
    for (const raw of diff.split('\n')) {
      if (raw.startsWith('+++ ')) {
        file = raw.slice(4).replace(/^b\//, '');
        continue;
      }
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
      if (hunk) {
        line = Number(hunk[1]);
        continue;
      }
      if (raw.startsWith('+')) {
        const text = raw.slice(1);
        const red = redact(text);
        if (red !== text) {
          for (const m of red.matchAll(/\[REDACTED:([a-z0-9_-]+)\]/gi)) findings.push({ file, line, rule: `builtin:${m[1]}` });
        }
        line++;
      }
    }
  }
  return {
    scanner: 'builtin',
    completed: true,
    findings,
    files: files.length,
    note: `built-in secret patterns (core/redact) over the added lines${why ? `, because ${why}` : ''}; these cover fewer secret shapes than gitleaks`,
    reportPath,
  };
}

const SAST_ID = /^(sast|semgrep|codeql|bandit|static[-_]?analysis|security[-_]scan)([-_.:].*)?$/i;

/** Check ids the policy defines as static analysis (SAST). The policy has no separate field, so the id names it. */
export function sastCheckIds(snapshot: PolicySnapshot): string[] {
  return Object.keys(snapshot.config.checks).filter((id) => SAST_ID.test(id)).sort();
}
