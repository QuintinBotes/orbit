/**
 * `orbit doctor`: every capability a run depends on, each reported pass, warn
 * or fail with the exact capability that is missing and how to supply it
 * (spec section 4, and the verified checks in docs/interfaces/). It creates
 * nothing (an existing state database is only opened, as any command does),
 * calls no model except with --probe (tiny requests, a few cents), and never
 * prints a credential or a private term.
 */
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { randomInt } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { OrbitError } from '../../core/errors.ts';
import { execCapture } from '../../core/exec.ts';
import { redact } from '../../core/redact.ts';
import { defaultConfig, loadConfig } from '../../policy/index.ts';
import type { OrbitConfig } from '../../policy/types.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities } from '../../adapters/types.ts';
import { CLAUDE_SANDBOX_LIMITATIONS, CODEX_LIMITATIONS, CODEX_OS_SANDBOX_LIMITATIONS, compareVersions, claudeEnvCredential, codexEnvCredential, createAdapters, decideCodexTier, providerKind, type CodexTierDecision, type CodexTierSetting } from '../../adapters/index.ts';
import { CONTAINER_LIMITATIONS, RESOURCE_LIMIT_FIX, SRT_LIMITATIONS, credentialDenyPaths, getIsolation, noIsolationLimitations, resourceLimitRefusals } from '../../isolation/index.ts';
import { CHROMIUM_MACH_RENDEZVOUS_LIMITATION, SRT_VERIFIED_VERSION, type SandboxRuntimeIsolation } from '../../isolation/sandbox-runtime.ts';
import type { IsolationProvider, SandboxProfile } from '../../isolation/types.ts';
import { safeBaseEnv } from '../../ui/env.ts';
import { UI_SINGLE_SANDBOX, UI_SINGLE_SANDBOX_LIMITATION } from '../../ui/single-sandbox.ts';
import { ModelRegistry, allowMatch } from '../../routing/registry.ts';
import { selectReviewer } from '../../review/select.ts';
import { LOGIN_COMMANDS, validateCredentials } from '../../recovery/index.ts';
import { parseAuthStatus } from '../../delivery/github.ts';
import { defaultTermsPath, loadPublicationGuard } from '../../guard/publication.ts';
import { DELIVERY_MODES } from '../../policy/config.ts';
import { sharedCatalogPath } from '../../routing/shared-catalog.ts';
import { deliveryEnvironmentProblem, deliversThroughGithub } from '../../controller/delivery-env.ts';
import { openDb, type OrbitDb } from '../../storage/db.ts';
import { MIGRATIONS } from '../../storage/schema.ts';
import { orbitInstallDir, serviceLabel, serviceStatus, stateDbPath } from '../../controller/index.ts';
import type { Args, OptionSpec } from '../args.ts';
import { controllers, gitEnv, resolveRepo, type CliContext } from '../context.ts';
import { EXIT } from '../exit.ts';
import { ago, flat, json, line, oneLine } from '../io.ts';
import { lingerState } from './service.ts';
import { compileGlobs } from '../../policy/globs.ts';
import { proposeScope, trackedFiles } from '../layout.ts';
import { orbitHint } from '../../core/invocation.ts';
import { reviewFix } from '../review-fix.ts';

export const DOCTOR_OPTIONS: OptionSpec = {
  probe: { type: 'boolean', description: 'also make tiny live requests (a few cents): one per provider that has a probe to detect expired or revoked credentials, and one per eligible Claude model' },
};

export type CheckStatus = 'pass' | 'warn' | 'fail';

export interface DoctorCheck {
  id: string;
  area: string;
  status: CheckStatus;
  summary: string;
  details: string[];
  /** The exact capability that is absent, for warn and fail. */
  missing: string | null;
  fix: string | null;
}

export interface DoctorReport {
  repo: string | null;
  ok: boolean;
  counts: Record<CheckStatus, number>;
  checks: DoctorCheck[];
}

const MIN_NODE = '22.16.0';
const MIN_GIT = '2.31.0';

type Env = Readonly<Record<string, string | undefined>>;

/** First executable named `cmd` on `env.PATH` (or the path itself when it has a slash). */
export function which(cmd: string, env: Env, cwd = process.cwd()): string | null {
  const ok = (p: string): boolean => {
    try {
      return statSync(p).isFile() && (accessSync(p, constants.X_OK), true);
    } catch {
      return false;
    }
  };
  if (cmd.includes('/')) {
    const p = isAbsolute(cmd) ? cmd : resolve(cwd, cmd);
    return ok(p) ? p : null;
  }
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const p = join(dir, cmd);
    if (ok(p)) return p;
  }
  return null;
}

/**
 * What went wrong, for a check whose own code failed. A message Orbit wrote on purpose (an OrbitError, such as a policy the
 * isolation provider refuses) is shown whole: it says what to change. Anything else is an arbitrary exception text and is
 * cut, so one runaway message cannot swamp the report.
 */
function errText(err: unknown, max: number): string {
  if (err instanceof OrbitError) return flat(err.message);
  return oneLine(err instanceof Error ? err.message : String(err), max);
}

function pass(id: string, area: string, summary: string, details: string[] = []): DoctorCheck {
  return { id, area, status: 'pass', summary, details, missing: null, fix: null };
}
function warn(id: string, area: string, summary: string, missing: string | null, fix: string | null, details: string[] = []): DoctorCheck {
  return { id, area, status: 'warn', summary, details, missing, fix };
}
function fail(id: string, area: string, summary: string, missing: string | null, fix: string | null, details: string[] = []): DoctorCheck {
  return { id, area, status: 'fail', summary, details, missing, fix };
}

interface Probe {
  ctx: CliContext;
  repo: string | null;
  config: OrbitConfig;
  configLoaded: boolean;
  live: boolean;
}

/**
 * Providers' minimal environment: enough for them to find their login, nothing delivery-related.
 * USER and LOGNAME are required on macOS: without them a keychain (subscription) login reads as
 * logged out, so doctor would report missing credentials for a user who is signed in.
 */
export function toolEnv(env: Env): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CONFIG_HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CODEX_API_KEY']) if (env[k] !== undefined) out[k] = env[k];
  return out;
}

// ---------------------------------------------------------------------------

function checkNode(): DoctorCheck {
  const v = process.versions.node;
  return compareVersions(v, MIN_NODE) >= 0 ? pass('runtime.node', 'runtime', `Node v${v}`) : fail('runtime.node', 'runtime', `Node v${v} is older than ${MIN_NODE}`, `Node >= ${MIN_NODE} (node:sqlite timeout, isTransaction)`, 'install a current Node 22 LTS');
}

function checkSqlite(): DoctorCheck {
  let db: OrbitDb | null = null;
  try {
    db = openDb(':memory:');
    db.raw.exec('CREATE VIRTUAL TABLE doctor_fts USING fts5(x)');
    return pass('runtime.sqlite', 'runtime', 'node:sqlite works and includes FTS5 (the learning layer needs it)');
  } catch (err) {
    return fail('runtime.sqlite', 'runtime', `node:sqlite is not usable: ${errText(err, 160)}`, 'node:sqlite with FTS5', 'use Node >= 22.16');
  } finally {
    db?.close();
  }
}

async function checkGit(p: Probe): Promise<DoctorCheck[]> {
  const { ctx, repo, config } = p;
  const out: DoctorCheck[] = [];
  const env = gitEnv(ctx.env);
  let v;
  try {
    v = await execCapture(['git', '--version'], { env, timeoutMs: 15_000 });
  } catch {
    return [fail('git.cli', 'git', 'git was not found', 'the git executable on PATH', 'install git (>= 2.31)')];
  }
  const ver = /(\d+\.\d+(?:\.\d+)?)/.exec(v.stdout)?.[1] ?? '0';
  out.push(compareVersions(ver, MIN_GIT) >= 0 ? pass('git.cli', 'git', `git ${ver}`) : warn('git.cli', 'git', `git ${ver} is older than ${MIN_GIT}`, `git >= ${MIN_GIT} (--path-format, worktree repair)`, 'upgrade git'));
  if (!repo) {
    out.push(fail('git.repo', 'git', 'not inside a git repository', 'a git repository to run in', 'run from a repository, or pass --repo <dir>'));
    return out;
  }
  const g = (args: string[]) => execCapture(['git', ...args], { cwd: repo, env, timeoutMs: 20_000 });
  const head = await g(['rev-parse', '--verify', 'HEAD']);
  if (head.exitCode !== 0) {
    out.push(fail('git.repo', 'git', `${repo} has no commits`, 'a base revision (at least one commit)', 'make an initial commit'));
    return out;
  }
  const wt = await g(['worktree', 'list', '--porcelain']);
  const details: string[] = [];
  const problems: { missing: string; fix: string; severity: CheckStatus }[] = [];
  if (wt.exitCode !== 0) {
    problems.push({ missing: 'git worktree support', fix: 'upgrade git (worktrees need git >= 2.5)', severity: 'fail' });
    details.push(`git worktree list failed: ${flat(wt.stderr)}`);
  }
  const base = await g(['rev-parse', '--verify', '--quiet', `refs/heads/${config.repository.base_branch}`]);
  if (base.exitCode !== 0) {
    problems.push({ missing: `base branch ${config.repository.base_branch}`, fix: `create it, or set repository.base_branch to an existing branch`, severity: 'warn' });
    details.push(`repository.base_branch "${config.repository.base_branch}" does not exist locally`);
  }
  const needsRemote = config.actions.push_task_branch && DELIVERY_MODES.has(config.mode);
  if (needsRemote) {
    const rem = await g(['remote', 'get-url', config.repository.remote]);
    if (rem.exitCode !== 0) {
      problems.push({ missing: `remote ${config.repository.remote}`, fix: `git remote add ${config.repository.remote} <url>, or choose a mode that does not deliver`, severity: 'warn' });
      details.push(`delivery pushes task branches but remote "${config.repository.remote}" is not configured`);
    }
  }
  const dirty = await g(['status', '--porcelain=v1', '--untracked-files=normal', '--', '.', ':(exclude).orbit']);
  if (dirty.stdout.trim() !== '' && !config.repository.allow_dirty_start) {
    problems.push({ missing: 'a clean working tree', fix: 'commit or stash the changes, or set repository.allow_dirty_start', severity: 'warn' });
    details.push(`${dirty.stdout.trim().split('\n').length} uncommitted path(s); a run would refuse to start (repository.allow_dirty_start is false)`);
  }
  if (problems.length === 0) {
    out.push(pass('git.repo', 'git', `repository ${repo}; worktrees supported`, details));
    return out;
  }
  const status: CheckStatus = problems.some((x) => x.severity === 'fail') ? 'fail' : 'warn';
  out.push({ id: 'git.repo', area: 'git', status, summary: `repository ${repo}: missing ${problems.map((x) => x.missing).join(', ')}`, details, missing: problems.map((x) => x.missing).join('; '), fix: problems.map((x) => x.fix).join('; ') });
  return out;
}

function checkConfig(p: Probe, error: unknown): DoctorCheck {
  if (p.configLoaded) return pass('config', 'config', `.orbit/config.yaml is valid (mode ${p.config.mode})`);
  if (error instanceof OrbitError && error.code === 'NOT_FOUND') return fail('config', 'config', 'no .orbit/config.yaml', 'the repository policy file', `run ${orbitHint('init')}, then define your checks`);
  const problems = error instanceof OrbitError && Array.isArray(error.details?.problems) ? (error.details.problems as string[]) : [error instanceof Error ? error.message : String(error)];
  return fail('config', 'config', `configuration is invalid (${problems.length} problem${problems.length === 1 ? '' : 's'})`, 'a valid .orbit/config.yaml', 'fix the problems below; checks use defaults until then', problems.slice(0, 12).map((x) => flat(x)));
}

function checkStorage(p: Probe): DoctorCheck {
  const { repo } = p;
  if (!repo) return warn('storage', 'storage', 'no repository, so no state database to check', 'a repository', null);
  const path = stateDbPath(repo);
  const dir = join(repo, '.orbit');
  let db: OrbitDb | null = null;
  try {
    if (!existsSync(path)) {
      // Prove the same properties on a scratch database, without creating anything in the repository.
      const scratch = mkdtempSync(join(tmpdir(), 'orbit-doctor-'));
      try {
        db = openDb(join(scratch, 'probe.sqlite'));
        const mode = String((db.get<{ journal_mode: string }>('PRAGMA journal_mode') ?? {}).journal_mode);
        if (mode.toLowerCase() !== 'wal') return fail('storage', 'storage', `SQLite cannot use WAL on this filesystem (journal_mode=${mode})`, 'WAL journaling', 'use a local disk, not a network or container bind mount');
      } finally {
        db?.close();
        db = null;
        rmSync(scratch, { recursive: true, force: true });
      }
      try {
        accessSync(existsSync(dir) ? dir : repo, constants.W_OK);
      } catch {
        return fail('storage', 'storage', `${existsSync(dir) ? dir : repo} is not writable`, 'a writable .orbit directory', 'fix permissions');
      }
      return pass('storage', 'storage', 'no state database yet; it will be created in .orbit/ (WAL works, directory writable)');
    }
    db = openDb(path);
    const mode = String((db.get<{ journal_mode: string }>('PRAGMA journal_mode') ?? {}).journal_mode);
    const version = Number((db.get<{ user_version: number }>('PRAGMA user_version') ?? { user_version: 0 }).user_version);
    db.tx(() => db!.run('CREATE TEMP TABLE IF NOT EXISTS doctor_probe (x)'));
    if (mode.toLowerCase() !== 'wal') return warn('storage', 'storage', `${path} is not in WAL mode (journal_mode=${mode})`, 'WAL journaling', 'it is set when Orbit opens the database; check the filesystem');
    return pass('storage', 'storage', `state database writable, WAL, schema version ${version}/${MIGRATIONS.length}`);
  } catch (err) {
    return fail('storage', 'storage', `state database problem: ${errText(err, 200)}`, 'a writable, current state.sqlite', 'check file permissions and that Orbit is not older than the database');
  } finally {
    db?.close();
  }
}

/** The word a configured check runs, resolved without executing anything. */
function checkWord(check: OrbitConfig['checks'][string]): string | null {
  if (check.shell) {
    const first = (check.command[0] ?? '').trim().split(/\s+/).find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
    return first ?? null;
  }
  return check.command[0] ?? null;
}

const SHELL_BUILTINS = new Set(['cd', 'export', 'set', 'test', '[', 'true', 'false', 'echo', 'exit', 'exec', ':', 'source', '.', 'eval', 'unset']);

function checkConfiguredChecks(p: Probe): DoctorCheck {
  const { repo, config, ctx } = p;
  const entries = Object.values(config.checks);
  if (entries.length === 0) return warn('checks', 'checks', 'no checks are defined', 'at least one trusted check (a run cannot produce passing evidence without one)', 'define checks in .orbit/config.yaml (see the commented examples)');
  const details: string[] = [];
  let status: CheckStatus = 'pass';
  for (const c of entries) {
    const cwd = repo ? resolve(repo, c.cwd) : ctx.cwd;
    const word = checkWord(c);
    const bump = (s: CheckStatus) => {
      if (s === 'fail' || (s === 'warn' && status === 'pass')) status = s;
    };
    const level: CheckStatus = c.mandatory ? 'fail' : 'warn';
    if (!word) {
      details.push(`${c.id}: has no command`);
      bump(level);
      continue;
    }
    if (c.shell && SHELL_BUILTINS.has(word)) {
      details.push(`${c.id}: shell builtin "${word}" (not resolved)`);
      continue;
    }
    const found = which(word, ctx.env, cwd) ?? (repo && !word.includes('/') ? which(join(repo, 'node_modules', '.bin', word), ctx.env) : null);
    if (!found) {
      details.push(`${c.id}: "${word}" was not found${c.mandatory ? '' : ' (optional check)'}${c.cwd !== '.' ? ` (cwd ${c.cwd})` : ''}`);
      bump(level);
      continue;
    }
    // A package-manager script that does not exist is a failure the first run would otherwise discover.
    const script = c.shell ? undefined : packageScriptOf(c.command);
    if (script) {
      const pj = join(cwd, 'package.json');
      let defined = false;
      try {
        defined = typeof (JSON.parse(readFileSync(pj, 'utf8')) as { scripts?: Record<string, string> }).scripts?.[script] === 'string';
      } catch {
        defined = false;
      }
      if (!defined) {
        details.push(`${c.id}: ${word} script "${script}" is not defined in ${pj.startsWith(repo ?? '\0') ? pj.slice((repo ?? '').length + 1) : pj}`);
        bump(level);
        continue;
      }
    }
    details.push(`${c.id}: ${word} -> ${found}`);
  }
  const summary = status === 'pass' ? `${entries.length} check(s) resolve` : `${details.filter((d) => /not found|not defined|no command/.test(d)).length} of ${entries.length} check(s) cannot run`;
  return status === 'pass' ? pass('checks', 'checks', summary, details) : { id: 'checks', area: 'checks', status, summary, details, missing: 'the executable or script a configured check runs', fix: 'install it, or correct the check in .orbit/config.yaml' };
}

const SRT_INSTALL = 'npm install --global @anthropic-ai/sandbox-runtime';

/** The command that supplies the missing isolation, not a description of it; Orbit never degrades to less isolation. */
function isolationFix(kind: IsolationProvider['kind'], detail: string): string {
  if (kind === 'container') return 'start the Docker daemon (for example "open -a Docker" on macOS, or "sudo systemctl start docker" on Linux); Orbit refuses to degrade to less isolation';
  if (/not found|install @anthropic-ai\/sandbox-runtime/i.test(detail)) return `${SRT_INSTALL}; Orbit refuses to degrade to less isolation`;
  return `fix the cause named above, or reinstall with: ${SRT_INSTALL}; Orbit refuses to degrade to less isolation`;
}

/** P24: allowed_paths that match no tracked file authorize nothing, so a run would be unable to change anything. */
async function checkScope(p: Probe): Promise<DoctorCheck[]> {
  const { repo, config, ctx } = p;
  if (!repo || !p.configLoaded) return [];
  const files = await trackedFiles(ctx, repo);
  if (files.length === 0) return [];
  const globs = config.scope.allowed_paths;
  const matches = compileGlobs(globs, { nocase: false });
  const hit = files.filter((f) => matches(f)).length;
  if (hit > 0) return [pass('scope', 'config', `scope.allowed_paths (${globs.join(', ')}) matches ${hit} of ${files.length} tracked file(s)`)];
  const suggestion = (await proposeScope(ctx, repo, files)).allowed;
  return [
    warn(
      'scope',
      'config',
      `scope.allowed_paths (${globs.join(', ')}) matches no tracked file, so a worker could change nothing`,
      'allowed_paths that match files in this repository',
      suggestion.length > 0 ? `set scope.allowed_paths in .orbit/config.yaml, for example [${suggestion.map((x) => `"${x}"`).join(', ')}]` : 'set scope.allowed_paths in .orbit/config.yaml to globs that match the files a worker may change',
    ),
  ];
}

interface IsolationFacts {
  provider: IsolationProvider | null;
  available: boolean;
}

async function checkIsolation(p: Probe): Promise<{ check: DoctorCheck; facts: IsolationFacts }> {
  const { config, ctx } = p;
  let provider: IsolationProvider;
  try {
    provider = getIsolation(config.isolation, { orbitInstallDir: orbitInstallDir(), mode: config.mode });
  } catch (err) {
    return { check: fail('isolation', 'isolation', errText(err, 240), 'an isolation provider permitted for unattended runs', 'set isolation.provider to sandbox-runtime or container'), facts: { provider: null, available: false } };
  }
  const st = await provider.available();
  const limitations =
    provider.kind === 'sandbox-runtime'
      ? SRT_LIMITATIONS
      : provider.kind === 'container'
        ? CONTAINER_LIMITATIONS
        : noIsolationLimitations({ writablePaths: [], denyReadPaths: [], allowedHosts: [], limits: { timeoutMs: 0, memoryMb: null, cpus: null, pids: null } });
  const details = [`provider: ${provider.kind}`, ...limitations.map((l) => `limitation: ${l}`)];
  if (provider.kind === 'container' && config.isolation.container && st.ok) {
    const docker = await execCapture(['docker', 'image', 'inspect', '--format', '{{.Id}}', config.isolation.container.image], { env: toolEnv(ctx.env), timeoutMs: 30_000 }).catch(() => null);
    if (!docker || docker.exitCode !== 0) {
      return { check: fail('isolation', 'isolation', `container image ${config.isolation.container.image} is not present locally`, `the image ${config.isolation.container.image} (containers run with --pull never)`, `docker pull ${config.isolation.container.image}`, details), facts: { provider, available: false } };
    }
  }
  if (!st.ok) {
    // An offline plugin install reports success but leaves no node_modules (its `npm ci` could not run), so the sandbox
    // runtime that ships there is missing. Say so, with the way to restore it, rather than only "srt not found".
    const pluginRoot = ctx.env.ORBIT_PLUGIN_ROOT;
    if (provider.kind === 'sandbox-runtime' && pluginRoot && existsSync(join(pluginRoot, 'package.json')) && !existsSync(join(pluginRoot, 'node_modules'))) {
      return {
        check: fail(
          'isolation',
          'isolation',
          `sandbox-runtime isolation is unavailable: the plugin's node_modules is missing (${pluginRoot}); a plugin installed while offline does not get its dependencies. ${flat(st.detail)}`,
          'the plugin\'s node_modules (it holds the sandbox runtime, srt)',
          `reconnect and run "claude plugin update orbit" (or reinstall the plugin) to fetch it, or run "npm ci --omit=dev" in ${pluginRoot}; Orbit refuses to degrade to less isolation`,
          details,
        ),
        facts: { provider, available: false },
      };
    }
    return { check: fail('isolation', 'isolation', `${provider.kind} isolation is unavailable: ${flat(st.detail)}`, `${provider.kind} isolation (${provider.kind === 'sandbox-runtime' ? 'the srt binary and Seatbelt or bubblewrap' : 'a running Docker daemon'})`, isolationFix(provider.kind, st.detail), details), facts: { provider, available: false } };
  }
  // The policy requires every configured limit to be enforced; a run would be refused at preflight, so say so here.
  const unenforced = resourceLimitRefusals(config.isolation, provider.kind);
  if (unenforced.length > 0) {
    return { check: fail('isolation', 'isolation', flat(unenforced[0]!), 'a provider that enforces every configured isolation limit (isolation.require_resource_limits is true)', RESOURCE_LIMIT_FIX, [...details, ...unenforced.map((u) => `refused: ${u}`)]), facts: { provider, available: false } };
  }
  if (provider.kind === 'none') return { check: warn('isolation', 'isolation', `no isolation: workers and checks run with the Orbit user's full permissions (isolation.allow_unisolated)`, 'an isolation provider', 'use sandbox-runtime or container', details), facts: { provider, available: true } };
  return { check: pass('isolation', 'isolation', `${provider.kind}: ${flat(st.detail)}`, details), facts: { provider, available: true } };
}

interface ProviderFacts {
  capabilities: Record<string, ProviderCapabilities>;
  credentials: Record<string, CredentialStatus | undefined>;
  adapters: Record<string, ProviderAdapter>;
}

async function checkProviders(p: Probe, iso: IsolationFacts, registry: ModelRegistry): Promise<{ checks: DoctorCheck[]; facts: ProviderFacts }> {
  const { config, ctx } = p;
  const checks: DoctorCheck[] = [];
  const facts: ProviderFacts = { capabilities: {}, credentials: {}, adapters: {} };
  let adapters: Record<string, ProviderAdapter>;
  try {
    adapters = createAdapters(config, { isolation: null, baseEnv: toolEnv(ctx.env), clock: ctx.clock });
  } catch (err) {
    return { checks: [fail('providers', 'providers', errText(err, 240), 'valid provider settings', 'fix providers in .orbit/config.yaml')], facts };
  }
  facts.adapters = adapters;
  const ids = Object.keys(adapters);
  const required = new Set<string>(['claude']);
  if (config.review.independent_provider_required) required.add(config.review.preferred_provider);
  const caps = await Promise.all(
    ids.map(async (id) => {
      try {
        return await adapters[id]!.discoverCapabilities();
      } catch (err) {
        return { provider: id, available: false, version: null, models: [], structuredOutput: false, readOnlySandbox: false, usageReporting: 'none' as const, costReporting: false, detail: err instanceof Error ? err.message : String(err) };
      }
    }),
  );
  ids.forEach((id, i) => (facts.capabilities[id] = caps[i]!));
  const creds = await validateCredentials({ adapters, providers: ids.filter((id) => facts.capabilities[id]!.available), live: p.live, timeoutMs: 90_000 });
  for (const c of creds) facts.credentials[c.provider] = c.status ?? undefined;

  for (const id of ids) {
    const cap = facts.capabilities[id]!;
    const needed = required.has(id);
    const level = needed ? fail : warn;
    const kind = providerKind(id);
    const exe = config.providers[id]!.command;
    if (!cap.available) {
      checks.push(level(`${id}.cli`, 'providers', `${id} is not usable: ${flat(cap.detail)}`, `the ${kind} CLI (${exe}) on PATH${kind === 'claude' ? ', >= 2.1.284 for Sonnet 5.5' : ''}`, kind === 'claude' ? 'install Claude Code (https://code.claude.com)' : 'install the Codex CLI', needed ? [] : ['not required for this configuration']));
      continue;
    }
    const cliDetails = [`structured output: ${cap.structuredOutput ? 'yes' : 'no'}`, `read-only sandbox: ${cap.readOnlySandbox ? 'yes' : 'no'}`, `usage reporting: ${cap.usageReporting}`, `cost reporting: ${cap.costReporting ? 'yes' : 'no'}`];
    checks.push(pass(`${id}.cli`, 'providers', `${kind} ${cap.version ?? 'version unknown'} at ${which(exe, ctx.env) ?? exe}`, cliDetails));

    const cred = creds.find((c) => c.provider === id);
    if (!cred) continue;
    const st = cred.status;
    if (cred.verdict === 'blocked' && st) {
      const alt = kind === 'claude' ? 'or set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN from "claude setup-token")' : 'or set CODEX_API_KEY';
      checks.push(level(`${id}.auth`, 'providers', `${id} credentials are ${st.state}: ${flat(st.detail)}`, `a working ${kind} credential`, `${LOGIN_COMMANDS[kind] ?? 'log in'} ${alt}`));
    } else if (cred.verdict === 'error') {
      checks.push(level(`${id}.auth`, 'providers', `${id} credentials could not be checked: ${cred.error ?? 'unknown error'}`, `a ${kind} credential check`, null));
    } else if (st) {
      const subscription = st.method === 'claude.ai' || st.method === 'chatgpt';
      const detail = [`method: ${st.method ?? 'unknown'}`, flat(st.detail)];
      if (subscription) detail.push('unattended service runs should use API-key authentication (docs/decisions/0003-authentication.md); a subscription login is fine for foreground runs');
      const summary = cred.verdict === 'valid' ? `${id} credential valid (${st.method ?? 'unknown method'})${cred.live ? ', confirmed by a live request' : ''}` : `${id} credential present (${st.method ?? 'unknown method'}); not verified${p.live ? '' : ' (use --probe for a live check)'}`;
      checks.push(pass(`${id}.auth`, 'providers', summary, detail));
    }
    if (kind === 'claude') {
      const envCred = claudeEnvCredential(ctx.env);
      if (iso.available && iso.provider?.kind === 'sandbox-runtime' && envCred) checks.push(pass(`${id}.worker-tier`, 'providers', `workers run in the os-sandbox tier (${envCred} is set, so the whole claude process is confined)`));
      else {
        const why = !envCred ? 'no ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the environment (a keychain login is invisible inside srt)' : 'sandbox-runtime isolation is not in use';
        checks.push(warn(`${id}.worker-tier`, 'providers', `workers run in the claude-sandbox tier: ${why}`, 'an exported Claude credential plus sandbox-runtime for the strongest tier', 'export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN (claude setup-token)', CLAUDE_SANDBOX_LIMITATIONS.map((l) => `limitation: ${l}`)));
      }
    } else checks.push(codexTierCheck(id, config.providers[id]!.tier ?? 'auto', codexEnvCredential(ctx.env), iso.available && iso.provider?.kind === 'sandbox-runtime', level));
  }

  // Independent review: judged exactly as a run would judge it.
  if (config.review.independent_provider_required || ids.some((i) => i !== 'claude')) {
    const sel = selectReviewer({ snapshot: { config }, capabilities: facts.capabilities, credentials: facts.credentials, implementer: { provider: 'claude', model: null }, registry });
    if (sel.decision === 'SELECT') checks.push(pass('review', 'providers', `independent review: ${sel.provider}/${sel.model ?? 'default'} (${sel.independent ? 'independent' : 'same provider'})`, sel.alternatives.map((a) => `not used: ${a.provider}: ${flat(a.reason)}`)));
    else {
      const mandatory = config.review.independent_provider_required;
      const c = (mandatory ? fail : warn)('review', 'providers', `independent review would block: ${flat(sel.reason)}`, 'a usable, data-policy-eligible reviewer from another provider', reviewFix(sel.alternatives), sel.alternatives.map((a) => `${a.provider}: ${flat(a.reason)}`));
      checks.push(c);
    }
  }
  return { checks, facts };
}

/**
 * The tier the Codex reviewer will use and why: the adapter's own decision
 * (decideCodexTier) applied to what doctor can see, so the report and a run
 * cannot disagree. An explicit os-sandbox without srt would fail the run
 * (ISOLATION_UNAVAILABLE), so it is judged like a missing reviewer.
 */
function codexTierCheck(id: string, setting: CodexTierSetting, apiKeyVar: string | null, srtInUse: boolean, level: typeof fail): DoctorCheck {
  const check = `${id}.worker-tier`;
  let decision: CodexTierDecision;
  try {
    decision = decideCodexTier({ setting, providerId: id, apiKeyVar, srt: { ok: srtInUse, why: 'sandbox-runtime isolation is not in use' } });
  } catch (err) {
    return level(check, 'providers', errText(err, 300), 'sandbox-runtime isolation, or providers.<id>.tier set to auto or codex-sandbox', 'set isolation.provider to sandbox-runtime, or set the tier to auto or codex-sandbox');
  }
  const summary = `the Codex reviewer runs in the ${decision.tier} tier: ${flat(decision.reason)}`;
  const limitations = (decision.tier === 'os-sandbox' ? CODEX_OS_SANDBOX_LIMITATIONS : CODEX_LIMITATIONS).map((l) => `limitation: ${l}`);
  if (decision.tier === 'os-sandbox') {
    if (!decision.risky) return pass(check, 'providers', summary, limitations);
    return warn(check, 'providers', summary, 'an exported API key (CODEX_API_KEY or OPENAI_API_KEY), or an API-key login in CODEX_HOME', 'export CODEX_API_KEY or OPENAI_API_KEY, or set the tier to auto', limitations);
  }
  if (!decision.automatic) return pass(check, 'providers', summary, limitations);
  return warn(check, 'providers', summary, 'an exported API key (CODEX_API_KEY or OPENAI_API_KEY) plus sandbox-runtime for the os-sandbox tier', 'export CODEX_API_KEY or OPENAI_API_KEY (an API-key login, not a ChatGPT login)', limitations);
}

async function checkModels(p: Probe, registry: ModelRegistry, facts: ProviderFacts): Promise<DoctorCheck> {
  const { config } = p;
  const claudeVersion = Object.values(facts.capabilities).find((c) => c.provider === 'claude' || providerKindSafe(c.provider) === 'claude')?.version ?? null;
  const details: string[] = [];
  let usable = 0;
  // --probe: one tiny live request per eligible model, so "eligible" means "answered", not just "allowed".
  const probe = p.live ? liveProbeOf(facts.adapters.claude) : null;
  const claudeCred = facts.credentials.claude;
  const canProbe = probe !== null && claudeCred !== undefined && claudeCred.state !== 'missing' && claudeCred.state !== 'invalid' && claudeCred.state !== 'expired';
  for (const e of registry.list().filter((m) => m.provider === 'claude')) {
    const match = allowMatch(e, config.routing.allowed_models);
    const surface = e.surfaces.find((s) => s.surface === 'claude-cli');
    const min = e.eligibility.minCliVersion;
    const reasons: string[] = [];
    if (match === null) reasons.push('not in routing.allowed_models');
    else if (match === 'wildcard' && e.eligibility.requiresExplicitPolicy) reasons.push('needs an explicit routing.allowed_models entry');
    if (surface?.available === false) reasons.push(`unavailable: ${surface.detail ?? 'a check said so'}`);
    if (min && claudeVersion && compareVersions(claudeVersion, min) < 0) reasons.push(`needs claude >= ${min}, installed ${claudeVersion}`);
    const state = surface?.available === true ? 'validated' : 'unvalidated (validated on first use, or "orbit models refresh --probe")';
    if (reasons.length === 0) {
      usable++;
      let live = '';
      if (canProbe) {
        const st = await probe!({ model: e.eligibility.cliAlias ?? e.modelId, timeoutMs: 90_000 }).catch((err: unknown) => ({ state: 'unknown' as const, method: null, detail: err instanceof Error ? err.message : String(err) }));
        live = st.state === 'valid' ? '; live probe answered' : `; live probe inconclusive (${st.state}: ${flat(st.detail)})`;
      }
      details.push(`${e.modelId}: eligible, ${state}${live}`);
    } else details.push(`${e.modelId}: excluded, ${reasons.join('; ')}`);
  }
  if (usable === 0) return fail('models', 'models', 'no allowed Claude model is eligible', 'at least one routing.allowed_models entry that the installed claude CLI can run', 'allow sonnet, opus or haiku in routing.allowed_models and upgrade claude if a minimum version is listed', details);
  return pass('models', 'models', `${usable} Claude model(s) eligible under the policy`, details);
}

type LiveProbe = (opts: { model?: string; timeoutMs?: number }) => Promise<CredentialStatus>;

/** The adapter's live probe, looking through a wrapper that exposes the real adapter as `inner` (the fakes). */
function liveProbeOf(adapter: ProviderAdapter | undefined): LiveProbe | null {
  for (const candidate of [adapter, (adapter as { inner?: unknown } | undefined)?.inner]) {
    const fn = (candidate as { probeCredentials?: LiveProbe } | undefined)?.probeCredentials;
    if (typeof fn === 'function') return (opts) => fn.call(candidate, opts);
  }
  return null;
}

function providerKindSafe(id: string): string | null {
  try {
    return providerKind(id);
  } catch {
    return null;
  }
}

// -- browsers -----------------------------------------------------------------

/**
 * Whether a package is installed where `req` resolves from. Resolving "<name>/package.json" is not
 * enough: packages with a restrictive exports map (such as @axe-core/playwright) refuse it with
 * ERR_PACKAGE_PATH_NOT_EXPORTED while being installed, so that error counts as present, and the
 * package's main entry is tried as well.
 */
/** The package-manager script a check runs (`npm run --silent lint` is "lint"), or undefined when it runs none. */
export function packageScriptOf(argv: readonly string[]): string | undefined {
  const [pm, sub, ...rest] = argv;
  if (!pm || !['npm', 'pnpm', 'yarn'].includes(pm)) return undefined;
  if (sub === 'test') return 'test';
  if (sub !== 'run' && sub !== 'run-script') return undefined;
  return rest.find((a) => !a.startsWith('-'));
}

export function packageInstalled(req: NodeJS.Require, name: string): boolean {
  try {
    req.resolve(`${name}/package.json`);
    return true;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') return true;
  }
  try {
    req.resolve(name);
    return true;
  } catch {
    return false;
  }
}

function playwrightCache(env: Env, home: string, platform: NodeJS.Platform): string {
  const override = env.PLAYWRIGHT_BROWSERS_PATH;
  if (override && override !== '0') return override;
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'ms-playwright');
  if (platform === 'win32') return join(env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'ms-playwright');
  return join(env.XDG_CACHE_HOME ?? join(home, '.cache'), 'ms-playwright');
}

function checkPlaywright(p: Probe): DoctorCheck {
  const { config, repo, ctx } = p;
  const wanted = config.ui !== null || Object.values(config.checks).some((c) => c.kind === 'playwright');
  if (!wanted) return pass('playwright', 'ui', 'not required: no ui section and no playwright check is configured');
  const level = fail;
  if (!repo) return level('playwright', 'ui', 'no repository to look for Playwright in', 'a repository', null);
  const req = createRequire(join(repo, 'package.json'));
  let pwTest: string | null = null;
  try {
    pwTest = req.resolve('@playwright/test/package.json');
  } catch {
    pwTest = null;
  }
  if (!pwTest) return level('playwright', 'ui', '@playwright/test is not installed in this repository', '@playwright/test in the repository (a devDependency)', 'npm install -D @playwright/test, then npx playwright install');
  const details: string[] = [];
  let core: string | null = null;
  try {
    core = req.resolve('playwright-core/package.json');
  } catch {
    core = null;
  }
  if (!core) return level('playwright', 'ui', 'playwright-core is missing next to @playwright/test', 'playwright-core', 'reinstall dependencies');
  let revisions: Record<string, string> = {};
  try {
    const bj = JSON.parse(readFileSync(join(core, '..', 'browsers.json'), 'utf8')) as { browsers?: { name: string; revision: string }[] };
    revisions = Object.fromEntries((bj.browsers ?? []).map((b) => [b.name, b.revision]));
  } catch {
    details.push('browsers.json could not be read; browser revisions are not checked');
  }
  const cache = playwrightCache(ctx.env, ctx.homeDir, ctx.platform);
  const names = config.ui?.browsers ?? ['chromium'];
  const missing: string[] = [];
  for (const b of names) {
    const dirs = b === 'chromium' ? ['chromium', 'chromium_headless_shell'] : [b];
    const revs = dirs.map((d) => ({ d, rev: revisions[d] ?? revisions[b] ?? null }));
    const present = revs.some((r) => (r.rev ? existsSync(join(cache, `${r.d}-${r.rev}`)) : false));
    details.push(`${b}: ${present ? `installed (${cache})` : `not found in ${cache}`}`);
    if (!present && revs.some((r) => r.rev)) missing.push(b);
  }
  if (config.ui?.accessibility.enabled) {
    if (packageInstalled(req, '@axe-core/playwright')) {
      details.push('@axe-core/playwright: installed');
    } else {
      details.push('@axe-core/playwright: not installed (accessibility scans are enabled in the ui policy)');
      missing.push('@axe-core/playwright');
    }
  }
  if (missing.length > 0) return level('playwright', 'ui', `missing: ${missing.join(', ')}`, `Playwright browsers/packages: ${missing.join(', ')}`, `npx playwright install ${missing.filter((m) => !m.startsWith('@')).join(' ')}`.trim(), details);
  return pass('playwright', 'ui', 'Playwright and its browsers are installed', details);
}

// -- browser isolation ----------------------------------------------------------

/** Runs a wrapped command and reports how it ended; the real one is execCapture, tests pass their own. */
export type BrowserLaunch = (argv: string[], opts: { cwd: string; env: Record<string, string>; timeoutMs: number }) => Promise<{ exitCode: number | null; output: string }>;

const launchWrapped: BrowserLaunch = async (argv, opts) => {
  const r = await execCapture(argv, { ...opts, maxOutputBytes: 256 * 1024 });
  return { exitCode: r.timedOut ? null : r.exitCode, output: `${r.stdout}\n${r.stderr}`.trim() };
};

function isExecutable(p: string): boolean {
  try {
    return statSync(p).isFile() && (accessSync(p, constants.X_OK), true);
  } catch {
    return false;
  }
}

/** Where Playwright's headless shell keeps its binary inside chromium_headless_shell-<revision>, newest layout first. */
function headlessShellLayouts(arch: string): string[] {
  const cft = ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell'];
  const old = ['chrome-mac-arm64/headless_shell', 'chrome-mac/headless_shell'];
  return arch === 'arm64' ? [...cft, ...old] : [cft[1]!, cft[0]!, old[1]!, old[0]!];
}

/**
 * Playwright's headless Chromium (the headless shell its `chromium.launch()` starts) for the revision the repository's
 * Playwright names, in the browser cache. Only files are read (package resolution and browsers.json); no code of the
 * repository runs.
 */
export function headlessChromiumOf(repo: string, cache: string, arch: string = process.arch): { exe: string; revision: string } | { problem: string } {
  let browsersJson: string;
  try {
    browsersJson = join(createRequire(join(repo, 'package.json')).resolve('playwright-core/package.json'), '..', 'browsers.json');
  } catch {
    return { problem: 'Playwright is not installed in this repository' };
  }
  let revision: string | undefined;
  try {
    const bj = JSON.parse(readFileSync(browsersJson, 'utf8')) as { browsers?: { name?: unknown; revision?: unknown }[] };
    const rev = (name: string) => bj.browsers?.find((b) => b.name === name && typeof b.revision === 'string')?.revision as string | undefined;
    revision = rev('chromium-headless-shell') ?? rev('chromium');
  } catch {
    return { problem: `Playwright's browsers.json could not be read (${browsersJson})` };
  }
  if (!revision) return { problem: "Playwright's browsers.json names no Chromium revision" };
  const dir = join(cache, `chromium_headless_shell-${revision}`);
  const exe = headlessShellLayouts(arch).map((rel) => join(dir, rel)).find((p) => isExecutable(p));
  return exe ? { exe, revision } : { problem: `Playwright's headless Chromium (revision ${revision}) is not installed in ${cache}` };
}

/**
 * A page whose script writes `orbit-<a>-<b>` into it. The source holds only the parts, so the joined text in what the
 * browser prints proves a renderer ran the script.
 */
function noncePage(): { url: string; expect: string } {
  const a = randomInt(100_000, 1_000_000_000);
  const b = randomInt(100_000, 1_000_000_000);
  const html = `<p id=o></p><script>document.getElementById('o').textContent=['orbit',${a},${b}].join('-')</script>`;
  return { url: `data:text/html,${encodeURIComponent(html)}`, expect: `orbit-${a}-${b}` };
}

export interface BrowserIsolationInput {
  /** A ui section or a playwright check is configured. */
  wanted: boolean;
  provider: IsolationProvider | null;
  available: boolean;
  repo: string | null;
  env: Env;
  /** Whose credentials are denied and where the browser cache is; env.HOME, then the account's home directory. */
  homeDir?: string;
  launch?: BrowserLaunch;
}

/**
 * ui.browser-isolation: what a UI check's browser gets under sandbox-runtime (docs/decisions/0001-runtime-choices.md,
 * "Browsers under sandbox-runtime on macOS"). On macOS, srt must be the version the Chromium preload was verified
 * against, and Playwright's real headless Chromium must start through the preload and render a page; the limitation
 * is stated. The launch is Orbit's own command against the browser binary: no JavaScript of the repository runs, and
 * the profile read-denies every credential path, Orbit's state and the repository. On Linux there is no Mach and no
 * rule; every srt sandbox has its own loopback, so the journey checks run in one sandbox (ui/single-sandbox.ts) and
 * exploration is refused, which it says.
 */
export async function browserIsolationCheck(input: BrowserIsolationInput): Promise<DoctorCheck> {
  const id = 'ui.browser-isolation';
  if (!input.wanted) return pass(id, 'ui', 'not required: no ui section and no playwright check is configured');
  const provider = input.provider;
  if (!provider || !input.available) return warn(id, 'ui', 'not checked: isolation is unavailable (see the isolation check)', 'an available isolation provider', null);
  if (provider.kind !== 'sandbox-runtime' || !('browserIsolation' in provider)) return pass(id, 'ui', `not needed: browser checks run under ${provider.kind}, which needs no browser rule`);
  const info = (provider as SandboxRuntimeIsolation).browserIsolation();
  const limitation = `limitation: ${CHROMIUM_MACH_RENDEZVOUS_LIMITATION}`;
  if (!info.rules) {
    return pass(id, 'ui', `Linux: no Mach rule is needed; every srt sandbox has its own loopback, so each journey check runs the application and the browser in one sandbox (${UI_SINGLE_SANDBOX}); UI exploration is not available under srt on Linux`, [info.detail, `limitation: ${UI_SINGLE_SANDBOX_LIMITATION}`]);
  }
  if (!info.verified) {
    return fail(id, 'ui', `${info.detail}; browser checks are refused`, `srt ${SRT_VERIFIED_VERSION} (@anthropic-ai/sandbox-runtime)`, `install @anthropic-ai/sandbox-runtime@${SRT_VERIFIED_VERSION}`, [info.detail, limitation]);
  }
  if (!input.repo) return warn(id, 'ui', 'not launched: no repository to find Playwright in', 'a repository', null, [info.detail, limitation]);
  const home = input.homeDir ?? input.env.HOME ?? homedir();
  const cache = playwrightCache(input.env, home, 'darwin');
  const browser = headlessChromiumOf(input.repo, cache);
  if ('problem' in browser) {
    return warn(id, 'ui', `not launched: ${browser.problem}`, "Playwright's headless Chromium for the repository's Playwright", 'npm install -D @playwright/test, then npx playwright install chromium', [info.detail, limitation]);
  }
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'orbit-doctor-browser-')));
  try {
    const repo = realpathSync(input.repo);
    const exe = realpathSync(browser.exe);
    const denyReadPaths = [...credentialDenyPaths({ homeDir: home, env: input.env }), ...(exe.startsWith(`${repo}/`) ? [] : [repo])];
    const profile: SandboxProfile = { writablePaths: [dir], denyReadPaths, allowedHosts: [], allowLocalBinding: false, chromiumMachRendezvous: true, limits: { timeoutMs: 90_000, memoryMb: null, cpus: null, pids: null } };
    const env = { ...safeBaseEnv(input.env), TMPDIR: dir };
    const page = noncePage();
    const argv = [browser.exe, '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', page.url];
    const wrapped = provider.wrap(argv, profile, { cwd: dir, env });
    let r: { exitCode: number | null; output: string };
    try {
      r = await (input.launch ?? launchWrapped)(wrapped.argv, { cwd: dir, env: wrapped.env, timeoutMs: 90_000 });
    } finally {
      wrapped.cleanup();
    }
    const details = [info.detail, `browser: ${browser.exe} (revision ${browser.revision})`, limitation];
    if (r.exitCode !== 0) {
      return fail(id, 'ui', `headless Chromium did not start under srt ${info.srtVersion} (exit ${r.exitCode ?? 'timeout'}): ${oneLine(redact(r.output), 240) || '(no output)'}`, "a Chromium that starts under srt (Playwright's bundled Chromium)", 'npx playwright install chromium; see docs/troubleshooting.md', details);
    }
    if (!r.output.includes(page.expect)) {
      return fail(id, 'ui', `headless Chromium did not render the test page under srt ${info.srtVersion} (exit 0): ${oneLine(redact(r.output), 240) || '(no output)'}`, "a Chromium that starts under srt (Playwright's bundled Chromium)", 'npx playwright install chromium; see docs/troubleshooting.md', details);
    }
    return pass(id, 'ui', `Chromium starts under srt ${info.srtVersion} with the two Mach rendezvous rules`, details);
  } catch (err) {
    return fail(id, 'ui', `headless Chromium could not be launched under srt: ${errText(err, 240)}`, 'a sandbox-runtime that can wrap the browser', 'see docs/troubleshooting.md', [info.detail, limitation]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// -- delivery -----------------------------------------------------------------

async function checkDelivery(p: Probe): Promise<DoctorCheck> {
  const { config, ctx } = p;
  if (!deliversThroughGithub(config)) return pass('delivery', 'delivery', `not required: ${config.delivery.provider === 'fake' ? 'delivery uses the fake provider' : `mode ${config.mode} does not deliver`}`);
  // The presence checks are the ones `orbit run` applies at admission (controller/delivery-env.ts).
  const missing = deliveryEnvironmentProblem(config, ctx.env);
  if (missing) return fail('delivery', 'delivery', missing.summary, missing.missing, missing.fix);
  const gh = which('gh', ctx.env)!;
  const token = ctx.env.GH_TOKEN!;
  const env: Record<string, string | undefined> = { ...toolEnv(ctx.env), GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
  const r = await execCapture([gh, 'auth', 'status', '--json', 'hosts'], { env, timeoutMs: 30_000 }).catch((err: unknown) => err as Error);
  if (r instanceof Error) return fail('delivery', 'delivery', `gh could not run: ${flat(r.message)}`, 'a working gh CLI', null);
  if (r.exitCode !== 0) return fail('delivery', 'delivery', `gh auth status failed: ${flat(redact(`${r.stderr}${r.stdout}`))}`, 'a valid GitHub credential', 'gh auth login, or export a valid GH_TOKEN');
  try {
    const st = parseAuthStatus(r.stdout, 'github.com', true);
    if (!st.ok) return fail('delivery', 'delivery', `GitHub credential is not usable: ${st.error ?? 'unknown'}`, 'a valid GH_TOKEN', 'export a valid fine-grained GH_TOKEN');
    return pass('delivery', 'delivery', `gh authenticated as ${st.login ?? 'unknown'} via ${st.tokenSource ?? 'unknown'}`, [`scopes: ${st.scopes ?? 'not reported (fine-grained tokens carry repository permissions instead)'}`]);
  } catch (err) {
    return warn('delivery', 'delivery', `gh auth status gave an unreadable answer: ${errText(err, 160)}`, 'a gh version that supports "auth status --json hosts"', 'upgrade gh');
  }
}

function checkGitleaks(p: Probe): DoctorCheck {
  const found = which('gitleaks', p.ctx.env);
  return found
    ? pass('gitleaks', 'security', `gitleaks at ${found} (the secret scan uses Orbit's trusted configuration)`)
    : warn('gitleaks', 'security', 'gitleaks is not installed; Orbit\'s built-in secret patterns are used and the evidence says so', 'the gitleaks executable (optional)', 'install gitleaks for a stronger secret scan');
}

// -- service ------------------------------------------------------------------

async function checkService(p: Probe): Promise<DoctorCheck> {
  const { repo, ctx } = p;
  if (!repo) return warn('service', 'service', 'no repository, so no service to check', 'a repository', null);
  if (ctx.platform !== 'darwin' && ctx.platform !== 'linux') return warn('service', 'service', `persistent service is not supported on ${ctx.platform}`, 'launchd (macOS) or systemd --user (Linux)', 'use "orbit run --foreground"');
  let status;
  try {
    status = await serviceStatus(serviceLabel(repo), { platform: ctx.platform, homeDir: ctx.homeDir, uid: ctx.uid, ...(ctx.seams.serviceRunner ? { run: ctx.seams.serviceRunner } : {}) });
  } catch (err) {
    return warn('service', 'service', `service status could not be read: ${errText(err, 160)}`, 'launchctl or systemctl', null);
  }
  const details = [`label: ${status.label}`, `definition: ${status.definitionPath}`];
  const now = ctx.clock.now();
  let beat = 'no controller has registered in this repository';
  let stale = false;
  let live = false;
  if (existsSync(stateDbPath(repo))) {
    let db: OrbitDb | null = null;
    try {
      db = openDb(stateDbPath(repo));
      const all = controllers(db, now, { limit: 5 });
      live = all.some((c) => c.live);
      const unstopped = all.filter((c) => c.record.stoppedAt === null);
      stale = unstopped.length > 0 && !live;
      if (all.length > 0) beat = all.map((c) => `${c.record.mode} controller pid ${c.record.pid}: heartbeat ${ago(now, c.record.heartbeatAt)}${c.live ? ' (live)' : c.record.stoppedAt ? ' (stopped)' : ' (stale)'}`).join('; ');
    } catch {
      beat = 'the state database could not be read';
    } finally {
      db?.close();
    }
  }
  details.push(`heartbeat: ${beat}`);
  const linger = await lingerState(ctx);
  if (linger === 'no') details.push(`lingering is off for ${ctx.user}: the service stops at logout (loginctl enable-linger ${ctx.user})`);
  if (!status.installed) return warn('service', 'service', 'no service is installed, so runs only progress while a terminal is attached', 'an installed background service (survives terminal closure and restarts after failure)', orbitHint('service install', undefined, { quote: false }), details);
  if (status.loaded !== true) return warn('service', 'service', `service installed but ${status.loaded === false ? 'not loaded' : `state unknown (${status.detail})`}`, 'a loaded service', `${orbitHint('service install', undefined, { quote: false })} (reloads it)`, details);
  if (stale) return warn('service', 'service', 'service is loaded but its controller heartbeat is stale', 'a fresh controller heartbeat (it may be wedged or still starting)', `check ${join(ctx.orbitHome, 'logs')}, then ${orbitHint('service install', undefined, { quote: false })} to restart it`, details);
  if (linger === 'no') return warn('service', 'service', 'service is loaded; lingering is off', 'systemd lingering', `loginctl enable-linger ${ctx.user}`, details);
  return pass('service', 'service', live ? 'service loaded and its controller heartbeat is fresh' : 'service loaded; the controller has not published a heartbeat yet', details);
}

// -- guard --------------------------------------------------------------------

function checkGuard(p: Probe): DoctorCheck {
  const { config, ctx } = p;
  const env = { ...ctx.env, HOME: ctx.homeDir };
  const path = config.guard.terms_file ?? defaultTermsPath(env);
  const shares = config.knowledge.share_globally;
  try {
    const g = loadPublicationGuard(config.guard.terms_file ? { termsPath: config.guard.terms_file, env } : { env });
    if (g.terms.found) return pass('guard.terms', 'guard', `publish-guard terms file present (${g.terms.terms.length} term(s); never printed)`, [`path: ${g.terms.path}`, ...g.warnings.slice(0, 5)]);
    return (shares ? fail : warn)('guard.terms', 'guard', `no publish-guard terms file at ${path}`, 'the private-terms file (checked before anything leaves this repository)', shares ? 'create it, or set knowledge.share_globally: false' : 'create it to have private terms checked before publication; Orbit never reads or copies its contents into a repository');
  } catch (err) {
    return fail('guard.terms', 'guard', `the publication guard cannot load its terms: ${errText(err, 200)}`, 'a readable terms file', 'fix the path or permissions; Orbit refuses to publish without it once it is configured');
  }
}

// ---------------------------------------------------------------------------

export async function runDoctor(ctx: CliContext, opts: { repoFlag?: string; probe: boolean }): Promise<DoctorReport> {
  let repo: string | null = null;
  try {
    repo = await resolveRepo(ctx, opts.repoFlag);
  } catch {
    repo = null;
  }
  let config = defaultConfig();
  let configLoaded = false;
  let configError: unknown = null;
  if (repo) {
    try {
      config = loadConfig(repo);
      configLoaded = true;
    } catch (err) {
      configError = err;
    }
  } else configError = new OrbitError('NOT_FOUND', 'not inside a git repository');
  const p: Probe = { ctx, repo, config, configLoaded, live: opts.probe };

  const checks: DoctorCheck[] = [];
  const safely = async (id: string, area: string, fn: () => Promise<DoctorCheck | DoctorCheck[]> | DoctorCheck | DoctorCheck[]): Promise<void> => {
    try {
      const r = await fn();
      checks.push(...(Array.isArray(r) ? r : [r]));
    } catch (err) {
      checks.push(fail(id, area, `this check crashed: ${errText(err, 200)}`, null, 'report this as an Orbit bug'));
    }
  };

  await safely('runtime.node', 'runtime', checkNode);
  await safely('runtime.sqlite', 'runtime', checkSqlite);
  await safely('git', 'git', () => checkGit(p));
  await safely('config', 'config', () => checkConfig(p, configError));
  await safely('storage', 'storage', () => checkStorage(p));
  await safely('checks', 'checks', () => checkConfiguredChecks(p));
  await safely('scope', 'config', () => checkScope(p));

  let isoFacts: IsolationFacts = { provider: null, available: false };
  await safely('isolation', 'isolation', async () => {
    const r = await checkIsolation(p);
    isoFacts = r.facts;
    return r.check;
  });

  // The registry for eligibility: the repository's, if it has one, otherwise the shipped seed in memory.
  let regDb: OrbitDb | null = null;
  try {
    const persisted = repo !== null && existsSync(stateDbPath(repo));
    regDb = persisted ? openDb(stateDbPath(repo!)) : openDb(':memory:');
    const registry = new ModelRegistry(regDb, ctx.clock).useSharedCatalog(sharedCatalogPath(ctx.orbitHome));
    if (!persisted || registry.list().length === 0) registry.seed();
    registry.adoptSharedCatalog();
    let facts: ProviderFacts = { capabilities: {}, credentials: {}, adapters: {} };
    await safely('providers', 'providers', async () => {
      const r = await checkProviders(p, isoFacts, registry);
      facts = r.facts;
      return r.checks;
    });
    await safely('models', 'models', () => checkModels(p, registry, facts));
  } catch (err) {
    checks.push(fail('models', 'models', `the model registry could not be read: ${errText(err, 200)}`, 'a readable model registry', null));
  } finally {
    regDb?.close();
  }

  await safely('playwright', 'ui', () => checkPlaywright(p));
  await safely('ui.browser-isolation', 'ui', () =>
    browserIsolationCheck({ wanted: config.ui !== null || Object.values(config.checks).some((c) => c.kind === 'playwright'), provider: isoFacts.provider, available: isoFacts.available, repo, env: ctx.env, homeDir: ctx.homeDir }),
  );
  await safely('delivery', 'delivery', () => checkDelivery(p));
  await safely('gitleaks', 'security', () => checkGitleaks(p));
  await safely('service', 'service', () => checkService(p));
  await safely('guard.terms', 'guard', () => checkGuard(p));

  const counts: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;
  return { repo, ok: counts.fail === 0, counts, checks };
}

export async function doctorCommand(args: Args, ctx: CliContext): Promise<number> {
  args.expect(0);
  const report = await runDoctor(ctx, { ...(args.str('repo') ? { repoFlag: args.str('repo')! } : {}), probe: args.bool('probe') });
  if (args.bool('json')) {
    json(ctx.io, report);
    return report.ok ? EXIT.OK : EXIT.FAILURE;
  }
  line(ctx.io, `orbit doctor${report.repo ? `  (${report.repo})` : ''}`);
  line(ctx.io);
  const tag = { pass: 'PASS', warn: 'WARN', fail: 'FAIL' } as const;
  for (const c of report.checks) {
    line(ctx.io, `${tag[c.status]}  ${c.id.padEnd(18)} ${c.summary}`);
    if (c.status !== 'pass') {
      if (c.missing) line(ctx.io, `      missing: ${c.missing}`);
      if (c.fix) line(ctx.io, `      fix:     ${c.fix}`);
    }
    for (const d of c.details) line(ctx.io, `      ${d}`);
  }
  line(ctx.io);
  line(ctx.io, `${report.counts.pass} passed, ${report.counts.warn} warning(s), ${report.counts.fail} failed`);
  return report.ok ? EXIT.OK : EXIT.FAILURE;
}
