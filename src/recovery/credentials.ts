import type { Clock } from '../core/clock.ts';
import { isOrbitError } from '../core/errors.ts';
import { redact } from '../core/redact.ts';
import type { OrbitDb } from '../storage/db.ts';
import { appendEvent } from '../storage/events.ts';
import { transition, getRun, type RunRecord } from '../controller/run-store.ts';
import { TERMINAL_STATES } from '../core/run-states.ts';
import type { CredentialState, CredentialStatus, ProviderAdapter } from '../adapters/types.ts';

/**
 * Credential validation for the providers a run needs (spec section 4
 * "Block on expired credentials rather than retry indefinitely", section 14,
 * scenario 12). Expired, revoked or missing credentials move the run to
 * BLOCKED with a blocker that names the provider and the command the user
 * should run. Nothing here retries: an authentication failure is not
 * transient, and Orbit never handles the credentials themselves (ADR 0003).
 *
 * A check can honestly answer three ways, and the report keeps them apart:
 * `valid` (the provider verified it), `unverified` (a credential is present
 * but the cheap check cannot tell whether it still works; `claude auth
 * status` is like this), and `blocked`. Only a definite answer blocks, and
 * "unverified" is never reported as "valid".
 */

/** What the user runs to fix each provider; the provider's own documented command. */
export const LOGIN_COMMANDS: Readonly<Record<string, string>> = {
  claude: 'claude auth login',
  codex: 'codex login',
};

/** Providers whose key can be exported instead of a login, for unattended runs (ADR 0003). */
const KEY_ALTERNATIVES: Readonly<Record<string, string>> = {
  claude: 'set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN from `claude setup-token`)',
  codex: 'set CODEX_API_KEY',
};

export type BlockedCredentialState = Exclude<CredentialState, 'valid' | 'unknown'> | 'auth_failed';

export interface AuthBlocker {
  kind: 'authentication';
  provider: string;
  /** How we learned of it: a credential check state, or a worker that failed to authenticate. */
  state: BlockedCredentialState;
  /** The command the user should run. */
  command: string;
  /** Human-readable, truthful, safe to print. */
  message: string;
  detail: string | null;
}

export interface AuthBlockerInput {
  provider: string;
  state: BlockedCredentialState;
  detail?: string | null;
  runId?: string | null;
  loginCommands?: Readonly<Record<string, string>>;
}

const WHAT: Record<BlockedCredentialState, string> = {
  expired: 'are expired',
  invalid: 'were rejected as invalid',
  missing: 'are missing',
  auth_failed: 'were rejected while a worker was running',
};

/**
 * The blocker text for a provider whose credentials do not work. It says what
 * is wrong, what the user runs, that Orbit will not retry, and how to resume.
 */
export function authBlocker(input: AuthBlockerInput): AuthBlocker {
  const commands = input.loginCommands ?? LOGIN_COMMANDS;
  const command = commands[input.provider] ?? `${input.provider} login`;
  const alt = KEY_ALTERNATIVES[input.provider];
  const detail = input.detail ? redact(input.detail).slice(0, 300) : null;
  const resume = input.runId ? ` then resume the run with \`orbit resume ${input.runId}\`` : ' then resume the run with `orbit resume <run-id>`';
  const message =
    `Blocked: the ${input.provider} credentials ${WHAT[input.state]}. ` +
    `Run \`${command}\`${alt ? ` (or ${alt})` : ''},${resume}. ` +
    'Orbit does not retry authentication failures.' +
    (detail ? ` Provider detail: ${detail}` : '');
  return { kind: 'authentication', provider: input.provider, state: input.state, command, message, detail };
}

export type CredentialVerdict = 'valid' | 'unverified' | 'blocked' | 'error';

export interface CredentialCheck {
  provider: string;
  verdict: CredentialVerdict;
  /** The adapter's answer; null when the check itself failed. */
  status: CredentialStatus | null;
  /** True when the live probe (a minimal real request) was used instead of the status check. */
  live: boolean;
  /** Why the check failed, for verdict 'error'. */
  error: string | null;
}

interface Probing {
  probeCredentials?: (opts?: { timeoutMs?: number }) => Promise<CredentialStatus>;
}

/** The live probe of an adapter, looking through wrappers that expose the adapter they wrap as `inner` (FakeAdapter, and wrappers of it). */
function probeOf(adapter: ProviderAdapter): ((opts?: { timeoutMs?: number }) => Promise<CredentialStatus>) | null {
  let candidate: unknown = adapter;
  for (let depth = 0; depth < 4 && candidate; depth++) {
    const p = (candidate as Probing).probeCredentials;
    if (typeof p === 'function') {
      const self = candidate;
      return (opts) => p.call(self, opts);
    }
    candidate = (candidate as { inner?: unknown }).inner;
  }
  return null;
}

export interface ValidateOptions {
  adapters: Readonly<Record<string, ProviderAdapter>>;
  providers: readonly string[];
  /** Use each adapter's live probe when it has one. It costs a tiny request but detects expiry. Default false. */
  live?: boolean;
  /** Use the live probe for these providers only (for example Claude, whose status check cannot see expiry). */
  liveProviders?: readonly string[];
  timeoutMs?: number;
}

/** Ask each provider's adapter whether its credentials work. Never throws for one provider's failure. */
export async function validateCredentials(opts: ValidateOptions): Promise<CredentialCheck[]> {
  const out: CredentialCheck[] = [];
  for (const provider of [...new Set(opts.providers)]) {
    const adapter = opts.adapters[provider];
    if (!adapter) {
      out.push({ provider, verdict: 'error', status: null, live: false, error: `no adapter for provider ${provider}` });
      continue;
    }
    const probe = opts.live || opts.liveProviders?.includes(provider) ? probeOf(adapter) : null;
    try {
      const status = probe ? await probe({ ...(opts.timeoutMs === undefined ? {} : { timeoutMs: opts.timeoutMs }) }) : await adapter.validateCredentials();
      out.push({ provider, verdict: verdictOf(status.state), status, live: probe !== null, error: null });
    } catch (err) {
      // The CLI is missing or timed out: not evidence about the credential, so not a block.
      out.push({ provider, verdict: 'error', status: null, live: probe !== null, error: redact(err instanceof Error ? err.message : String(err)).slice(0, 300) });
    }
  }
  return out;
}

export function verdictOf(state: CredentialState): CredentialVerdict {
  if (state === 'valid') return 'valid';
  if (state === 'unknown') return 'unverified';
  return 'blocked';
}

/** Providers the run's workers use, plus any the caller knows are needed (a reviewer the run has not started yet). */
export function providersForRun(db: OrbitDb, runId: string, extra: readonly string[] = []): string[] {
  const rows = db.all<{ provider: string }>('SELECT DISTINCT provider FROM workers WHERE run_id = ? ORDER BY provider', runId);
  return [...new Set([...rows.map((r) => r.provider), ...extra])];
}

export const CREDENTIALS_CHECKED_EVENT = 'credentials.checked';

/** Whether a periodic check is due: none yet, or the last one is at least `intervalMs` old. */
export function credentialCheckDue(db: OrbitDb, runId: string, clock: Clock, intervalMs: number): boolean {
  const last = db.get<{ ts: number | null }>('SELECT MAX(ts) AS ts FROM events WHERE run_id = ? AND type = ?', runId, CREDENTIALS_CHECKED_EVENT)?.ts ?? null;
  return last === null || clock.now() - last >= intervalMs;
}

export type BlockOutcome =
  | { outcome: 'blocked'; run: RunRecord; blocker: AuthBlocker }
  /** Already BLOCKED for this provider's credentials: nothing to add, and nothing retried. */
  | { outcome: 'already-blocked'; run: RunRecord; blocker: AuthBlocker }
  /** A durable cancellation request wins over a block. */
  | { outcome: 'cancel-pending'; run: RunRecord; blocker: AuthBlocker }
  | { outcome: 'not-applicable'; run: RunRecord; blocker: AuthBlocker };

/**
 * Move the run to BLOCKED with the blocker as its outcome. The caller must
 * hold the run's lease (transition() enforces it). Safe to call repeatedly:
 * a run already blocked on the same provider is left as it is.
 */
export function blockRunOnCredentials(db: OrbitDb, clock: Clock, ownerId: string, runId: string, blocker: AuthBlocker): BlockOutcome {
  return db.tx(() => {
    const run = getRun(db, runId);
    if (run.state === 'BLOCKED') {
      const prior = parseBlocker(run.outcomeJson);
      if (prior?.kind === 'authentication' && prior.provider === blocker.provider) return { outcome: 'already-blocked', run, blocker };
      return { outcome: 'not-applicable', run, blocker };
    }
    if (TERMINAL_STATES.has(run.state)) return { outcome: 'not-applicable', run, blocker };
    if (run.cancelRequested) return { outcome: 'cancel-pending', run, blocker };
    const next = transition(
      db,
      {
        runId,
        to: 'BLOCKED',
        ownerId,
        reason: `${blocker.provider} credentials ${blocker.state}`,
        actor: ownerId,
        expectedFrom: run.state,
        data: { kind: blocker.kind, provider: blocker.provider, state: blocker.state, command: blocker.command },
        patch: { outcomeReason: blocker.message, outcomeJson: JSON.stringify({ blocker }) },
      },
      clock,
    );
    return { outcome: 'blocked', run: next, blocker };
  });
}

function parseBlocker(json: string | null): AuthBlocker | null {
  if (!json) return null;
  try {
    const o = JSON.parse(json) as { blocker?: AuthBlocker };
    return o.blocker ?? null;
  } catch {
    return null;
  }
}

export interface RunCredentialCheckOptions extends ValidateOptions {
  db: OrbitDb;
  clock: Clock;
  /** The lease holder for the run. */
  ownerId: string;
  runId: string;
  loginCommands?: Readonly<Record<string, string>>;
}

export interface RunCredentialReport {
  runId: string;
  checks: CredentialCheck[];
  /** Set when the run was blocked (or already is) because of these credentials. */
  blocked: BlockOutcome | null;
}

/**
 * Validate the providers a run needs and block the run on the first
 * definite failure. One event records the verdicts (never credential
 * material) whether or not anything failed, which is also what
 * `credentialCheckDue` reads for the periodic schedule.
 */
export async function checkRunCredentials(opts: RunCredentialCheckOptions): Promise<RunCredentialReport> {
  const checks = await validateCredentials(opts);
  const now = opts.clock.now();
  opts.db.tx(() =>
    appendEvent(
      opts.db,
      opts.runId,
      CREDENTIALS_CHECKED_EVENT,
      opts.ownerId,
      { providers: checks.map((c) => ({ provider: c.provider, verdict: c.verdict, state: c.status?.state ?? null, method: c.status?.method ?? null, live: c.live })) },
      now,
    ),
  );
  const failed = checks.find((c) => c.verdict === 'blocked');
  if (!failed || !failed.status) return { runId: opts.runId, checks, blocked: null };
  const blocker = authBlocker({ provider: failed.provider, state: failed.status.state as BlockedCredentialState, detail: failed.status.detail, runId: opts.runId, ...(opts.loginCommands ? { loginCommands: opts.loginCommands } : {}) });
  let blocked: BlockOutcome;
  try {
    blocked = blockRunOnCredentials(opts.db, opts.clock, opts.ownerId, opts.runId, blocker);
  } catch (err) {
    // Not the lease holder (or the run changed under us): report the finding, let the owner act on it.
    if (isOrbitError(err, 'LEASE_LOST') || isOrbitError(err, 'CONCURRENT_UPDATE') || isOrbitError(err, 'TRANSITION_INVALID')) return { runId: opts.runId, checks, blocked: { outcome: 'not-applicable', run: getRun(opts.db, opts.runId), blocker } };
    throw err;
  }
  return { runId: opts.runId, checks, blocked };
}
