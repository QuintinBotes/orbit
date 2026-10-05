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
 */
import { accessSync, constants, existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { delimiter, dirname, join, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWrite, atomicWriteJson, readJsonIfExists } from '../core/fsx.ts';
import { execCapture } from '../core/exec.ts';
import { redact } from '../core/redact.ts';
import { git } from '../evidence/git.ts';
import type { PolicySnapshot } from '../policy/types.ts';

export interface SecretFinding {
  file: string;
  line: number | null;
  rule: string;
}

export interface SecretScanResult {
  scanner: 'gitleaks' | 'builtin';
  /** True when the scan ran to completion; false means nothing can be concluded. */
  completed: boolean;
  findings: SecretFinding[];
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
}

/** Orbit's trusted gitleaks configuration: the default rules, no allowlist the repository could widen. */
export const TRUSTED_GITLEAKS_CONFIG = 'title = "orbit trusted secret scan"\n\n[extend]\nuseDefault = true\n';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

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
  const prior = readJsonIfExists<SecretScanResult & { commit?: string }>(reportPath);
  // Bound to the commit: the same candidate is never scanned twice, a different one always is.
  if (prior && prior.completed && prior.commit === input.commit) return prior;

  const files = await changedFiles(input.repoRoot, input.baseRev, input.commit);
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
    result = { scanner: 'gitleaks', completed: true, findings: [], files: 0, note: 'gitleaks: the candidate adds or modifies no files', reportPath };
  }
  result ??= await builtinScan(input, files, reportPath, why);
  atomicWriteJson(reportPath, { ...result, commit: input.commit });
  return result;
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
    const size = Number((await git(input.repoRoot, ['cat-file', '-s', `${input.commit}:${rel}`])).trim());
    if (!Number.isFinite(size) || size > MAX_FILE_BYTES) continue;
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

/** Built-in fallback: the core/redact secret shapes over every added line. */
async function builtinScan(input: SecretScanInput, files: string[], reportPath: string, why: string): Promise<SecretScanResult> {
  const findings: SecretFinding[] = [];
  if (files.length > 0) {
    const diff = await git(input.repoRoot, ['diff', '-U0', '--no-renames', '--no-ext-diff', '--no-textconv', '--text', input.baseRev, input.commit, '--']);
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
