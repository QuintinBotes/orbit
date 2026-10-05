/**
 * Exit codes of the `orbit` CLI. They are part of its contract (scripts and
 * the plugin skills branch on them), so they are listed once, here, and
 * `orbit help exit-codes` prints this table.
 *
 * `orbit hook pre-tool-use` is the one exception: it speaks Claude Code's
 * hook protocol, where 2 means "block" and anything else lets the tool call
 * through, so it exits 0 (allow or deny JSON) or 2 and nothing else.
 */
import { isOrbitError, type OrbitErrorCode } from '../core/errors.ts';

export const EXIT = {
  OK: 0,
  /** An unexpected error, or `doctor` found a failing check. */
  FAILURE: 1,
  /** Bad command line. */
  USAGE: 2,
  /** A run, question, lesson, model or file that does not exist. */
  NOT_FOUND: 3,
  /** Configuration, policy or input that does not validate. */
  CONFIG: 4,
  /** The request conflicts with the run's current state or owner. */
  CONFLICT: 5,
  /** A provider, credential or isolation capability is missing. */
  ENVIRONMENT: 7,
  /** `run --foreground` and `resume --foreground`: the run ended in the named state. */
  BLOCKED: 10,
  EXHAUSTED: 11,
  IMPOSSIBLE: 12,
  CANCELLED: 13,
  /** `run --foreground` interrupted with Ctrl-C: the run is paused, not cancelled. */
  PAUSED: 20,
} as const;

export const EXIT_CODE_DOCS: readonly { code: number; name: string; meaning: string }[] = [
  { code: EXIT.OK, name: 'OK', meaning: 'the command succeeded (a foreground run reached SUCCEEDED)' },
  { code: EXIT.FAILURE, name: 'FAILURE', meaning: 'an unexpected error, or doctor reported at least one failing check' },
  { code: EXIT.USAGE, name: 'USAGE', meaning: 'unknown command or option, or a missing argument' },
  { code: EXIT.NOT_FOUND, name: 'NOT_FOUND', meaning: 'no such run, question, lesson, overlay, model or file' },
  { code: EXIT.CONFIG, name: 'CONFIG', meaning: 'configuration, policy snapshot, contract or input failed validation, or an action was refused by policy' },
  { code: EXIT.CONFLICT, name: 'CONFLICT', meaning: 'the run is in a state that does not allow this (owned by a live controller, open questions, already finished)' },
  { code: EXIT.ENVIRONMENT, name: 'ENVIRONMENT', meaning: 'a provider CLI, credential, isolation provider or other capability is missing' },
  { code: EXIT.BLOCKED, name: 'BLOCKED', meaning: 'a foreground run ended BLOCKED; resolve the reason, then orbit resume' },
  { code: EXIT.EXHAUSTED, name: 'EXHAUSTED', meaning: 'a foreground run ended EXHAUSTED (a hard budget cap was reached)' },
  { code: EXIT.IMPOSSIBLE, name: 'IMPOSSIBLE', meaning: 'a foreground run ended IMPOSSIBLE (the goal cannot be met under the policy)' },
  { code: EXIT.CANCELLED, name: 'CANCELLED', meaning: 'a foreground run ended CANCELLED' },
  { code: EXIT.PAUSED, name: 'PAUSED', meaning: 'a foreground run was interrupted (Ctrl-C) and is paused; orbit resume continues it' },
];

/** A mistake in the command line, reported with the command's usage and exit code 2. */
export class UsageError extends Error {
  readonly usage: string | undefined;

  constructor(message: string, usage?: string) {
    super(message);
    this.name = 'UsageError';
    this.usage = usage;
  }
}

const BY_CODE: Partial<Record<OrbitErrorCode, number>> = {
  NOT_FOUND: EXIT.NOT_FOUND,
  CONFIG_INVALID: EXIT.CONFIG,
  CONTRACT_INVALID: EXIT.CONFIG,
  SCHEMA_INVALID: EXIT.CONFIG,
  POLICY_DENIED: EXIT.CONFIG,
  POLICY_TAMPERED: EXIT.CONFIG,
  SCOPE_VIOLATION: EXIT.CONFIG,
  TRANSITION_INVALID: EXIT.CONFLICT,
  CONCURRENT_UPDATE: EXIT.CONFLICT,
  LEASE_LOST: EXIT.CONFLICT,
  CANCELLED: EXIT.CONFLICT,
  AUTH_EXPIRED: EXIT.ENVIRONMENT,
  AUTH_MISSING: EXIT.ENVIRONMENT,
  PROVIDER_UNAVAILABLE: EXIT.ENVIRONMENT,
  ISOLATION_UNAVAILABLE: EXIT.ENVIRONMENT,
};

export function exitCodeFor(err: unknown): number {
  if (err instanceof UsageError) return EXIT.USAGE;
  if (isOrbitError(err)) return BY_CODE[err.code] ?? EXIT.FAILURE;
  return EXIT.FAILURE;
}

/** The exit code a foreground run reports for the state it ended in. */
export function exitCodeForState(state: string): number {
  switch (state) {
    case 'SUCCEEDED':
      return EXIT.OK;
    case 'BLOCKED':
      return EXIT.BLOCKED;
    case 'EXHAUSTED':
      return EXIT.EXHAUSTED;
    case 'IMPOSSIBLE':
      return EXIT.IMPOSSIBLE;
    case 'CANCELLED':
      return EXIT.CANCELLED;
    default:
      return EXIT.FAILURE;
  }
}
