/**
 * Every failure Orbit acts on carries a code. The controller maps codes to
 * outcomes (BLOCKED, EXHAUSTED, retry...) so behaviour never depends on parsing
 * an error message.
 */
export type OrbitErrorCode =
  | 'CONFIG_INVALID'
  | 'CONTRACT_INVALID'
  | 'SCHEMA_INVALID'
  | 'POLICY_DENIED'
  | 'POLICY_TAMPERED'
  | 'SCOPE_VIOLATION'
  | 'LEASE_LOST'
  | 'TRANSITION_INVALID'
  | 'CONCURRENT_UPDATE'
  | 'AUTH_EXPIRED'
  | 'AUTH_MISSING'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_TRANSIENT'
  | 'MALFORMED_OUTPUT'
  | 'BUDGET_EXHAUSTED'
  | 'STALE_EVIDENCE'
  | 'CANCELLED'
  | 'ISOLATION_UNAVAILABLE'
  | 'GIT_FAILED'
  | 'DELIVERY_FAILED'
  | 'NOT_FOUND'
  | 'INTERNAL';

export class OrbitError extends Error {
  readonly code: OrbitErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: OrbitErrorCode, message: string, details?: Record<string, unknown>, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OrbitError';
    this.code = code;
    this.details = details;
  }
}

export function isOrbitError(err: unknown, code?: OrbitErrorCode): err is OrbitError {
  return err instanceof OrbitError && (code === undefined || err.code === code);
}

/** Errors worth retrying with backoff; everything else is decided, not retried. */
export function isTransient(err: unknown): boolean {
  return isOrbitError(err, 'PROVIDER_TRANSIENT');
}
