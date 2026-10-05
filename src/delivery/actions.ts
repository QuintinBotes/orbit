/**
 * The external-action ledger (spec §15, scenario 8). Every action that leaves
 * the machine (a commit that will be pushed, a push, a pull request, and in
 * release mode marking it ready, a merge or a deployment) goes
 * through `performAction`:
 *
 *   validate -> persist INTENT -> mark EXECUTING -> execute -> receipt (SUCCEEDED)
 *
 *   INTENT -> EXECUTING -> SUCCEEDED
 *                       -> UNKNOWN   (error, or a response that never arrived)
 *                       -> FAILED    (definitive: the remote refused, nothing happened)
 *   UNKNOWN | EXECUTING | FAILED -> reconcile (a read of the remote) -> SUCCEEDED
 *                                 -> or absent -> EXECUTING again, within the attempt budget
 *
 * The rule that makes a lost response harmless: once an action has been
 * attempted, nothing is executed again until `reconcile` has asked the remote
 * what actually happened. A crash while EXECUTING and a response lost after a
 * successful create look identical from here (we cannot tell), so both are
 * resolved by the same read. The idempotency key is UNIQUE in the table, so a
 * retried intent resumes the existing row rather than inserting a second one,
 * and a new ledger instance (a restarted controller) on the same database
 * picks up exactly where the old one stopped.
 */
import type { Clock } from '../core/clock.ts';
import type { OrbitDb } from '../storage/db.ts';
import type { AuthorizationDecision } from '../policy/types.ts';
import { OrbitError, isOrbitError, type OrbitErrorCode } from '../core/errors.ts';
import { faultPoint } from '../core/faults.ts';
import { canonicalJson } from '../core/hash.ts';
import { newId } from '../core/ids.ts';
import { redact } from '../core/redact.ts';
import { appendEvent } from '../storage/events.ts';
import { recordDecision } from '../storage/decisions.ts';

/** Exported for the knowledge extractor and reports, which must not copy the list. */
export const ACTION_STATES = ['INTENT', 'EXECUTING', 'SUCCEEDED', 'UNKNOWN', 'FAILED'] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/** Kinds Orbit's delivery performs. The kind names the fault points: `delivery.<kind>.after-execute`. */
export const ACTION_KINDS = ['commit', 'push', 'pr_create', 'pr_update', 'pr_ready', 'merge', 'deploy'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export const DEFAULT_MAX_ATTEMPTS = 3;

export interface ActionRecord {
  id: string;
  runId: string;
  kind: string;
  idempotencyKey: string;
  target: unknown;
  candidateId: string | null;
  treeHash: string | null;
  commitSha: string | null;
  state: ActionState;
  /** Executions started (not reconciliations). */
  attempts: number;
  receipt: unknown;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ActionInput {
  runId: string;
  kind: ActionKind | (string & {});
  /** Stable for the logical action; a retry or a restarted controller must compute the same key. */
  idempotencyKey: string;
  target: unknown;
  candidateId?: string | null;
  treeHash?: string | null;
  commitSha?: string | null;
}

export interface ActionContext {
  action: ActionRecord;
  /** 1-based number of this execution (0 while reconciling before the first). */
  attempt: number;
}

export interface ActionHandlers<T> {
  /** Perform the action. Must be safe to call only after `reconcile` returned null. */
  execute(ctx: ActionContext): Promise<T>;
  /** Ask the remote what happened. The receipt when the action took effect, null when it certainly did not. */
  reconcile(ctx: ActionContext): Promise<T | null>;
}

export interface PerformOptions {
  /** The caller's validated `authorize()` decision for this action; a denial refuses before anything is persisted. */
  authorization: AuthorizationDecision;
  /**
   * Re-run the freshness gate and any other validation. Called before the
   * intent is persisted and again before every execution, so evidence that
   * went stale while a retry waited cannot authorize the retry.
   */
  precheck?: () => void | Promise<void>;
}

export interface ActionResult<T> {
  action: ActionRecord;
  receipt: T;
  /** executed: this call did it; reconciled: a read of the remote showed it already happened; already-done: an earlier call finished it. */
  outcome: 'executed' | 'reconciled' | 'already-done';
}

export interface LedgerOptions {
  /** Run directory; when given, each reconciliation is also recorded as a decision (spec §16). */
  runDir?: string;
  maxAttempts?: number;
  /** Delay before re-executing after a failure within one call. Default 500 ms doubling, capped at 30 s. */
  backoffMs?: (attempt: number) => number;
  actor?: string;
}

/** Failures that mean the remote refused: nothing happened, and repeating the request cannot help. */
const DEFINITIVE_CODES: ReadonlySet<OrbitErrorCode> = new Set([
  'AUTH_EXPIRED',
  'AUTH_MISSING',
  'POLICY_DENIED',
  'POLICY_TAMPERED',
  'SCOPE_VIOLATION',
  'STALE_EVIDENCE',
  'CANCELLED',
  'CONFIG_INVALID',
  'LEASE_LOST',
]);

export function isDefinitiveFailure(err: unknown): boolean {
  if (!isOrbitError(err)) return false;
  return DEFINITIVE_CODES.has(err.code) || err.details?.definitive === true;
}

interface ActionRow {
  id: string;
  run_id: string;
  kind: string;
  idempotency_key: string;
  target_json: string;
  candidate_id: string | null;
  tree_hash: string | null;
  commit_sha: string | null;
  state: string;
  attempts: number;
  receipt_json: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
}

function toRecord(row: ActionRow): ActionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    idempotencyKey: row.idempotency_key,
    target: JSON.parse(row.target_json) as unknown,
    candidateId: row.candidate_id,
    treeHash: row.tree_hash,
    commitSha: row.commit_sha,
    state: row.state as ActionState,
    attempts: row.attempts,
    receipt: row.receipt_json === null ? null : (JSON.parse(row.receipt_json) as unknown),
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ActionLedger {
  private readonly maxAttempts: number;
  private readonly actor: string;

  /** Public so delivery can re-read the recorded evidence bindings in the same database. */
  readonly db: OrbitDb;
  private readonly clock: Clock;
  private readonly opts: LedgerOptions;

  constructor(db: OrbitDb, clock: Clock, opts: LedgerOptions = {}) {
    this.db = db;
    this.clock = clock;
    this.opts = opts;
    this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.actor = opts.actor ?? 'delivery';
    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) throw new OrbitError('INTERNAL', 'maxAttempts must be a positive integer');
  }

  /** Append a run event (for callers that finish a multi-action step). */
  event(runId: string, type: string, data: unknown): void {
    const now = this.clock.now();
    this.db.tx(() => appendEvent(this.db, runId, type, this.actor, data, now));
  }

  find(idempotencyKey: string): ActionRecord | null {
    const row = this.db.get<ActionRow>('SELECT * FROM actions WHERE idempotency_key = ?', idempotencyKey);
    return row ? toRecord(row) : null;
  }

  get(id: string): ActionRecord {
    const row = this.db.get<ActionRow>('SELECT * FROM actions WHERE id = ?', id);
    if (!row) throw new OrbitError('NOT_FOUND', `no action ${id}`);
    return toRecord(row);
  }

  list(runId: string, opts: { kind?: string; state?: ActionState } = {}): ActionRecord[] {
    const rows = this.db.all<ActionRow>('SELECT * FROM actions WHERE run_id = ? ORDER BY created_at, rowid', runId);
    return rows.map(toRecord).filter((a) => (opts.kind === undefined || a.kind === opts.kind) && (opts.state === undefined || a.state === opts.state));
  }

  /**
   * Persist the intent, or resume the row that already has this key. A key
   * reused for a different action is a bug (or a collision) and is refused
   * rather than silently executed as the old one.
   */
  recordIntent(input: ActionInput): { action: ActionRecord; created: boolean } {
    const targetJson = canonicalJson(input.target);
    const now = this.clock.now();
    return this.db.tx(() => {
      const existing = this.db.get<ActionRow>('SELECT * FROM actions WHERE idempotency_key = ?', input.idempotencyKey);
      if (existing) {
        const same =
          existing.run_id === input.runId &&
          existing.kind === input.kind &&
          canonicalJson(JSON.parse(existing.target_json)) === targetJson &&
          (existing.tree_hash ?? null) === (input.treeHash ?? null) &&
          (existing.commit_sha ?? null) === (input.commitSha ?? null);
        if (!same) {
          throw new OrbitError('CONCURRENT_UPDATE', `idempotency key ${input.idempotencyKey} already names a different action`, {
            existing: existing.id,
            kind: existing.kind,
          });
        }
        return { action: toRecord(existing), created: false };
      }
      const id = newId('act');
      this.db.run(
        `INSERT INTO actions (id, run_id, kind, idempotency_key, target_json, candidate_id, tree_hash, commit_sha, state, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'INTENT', 0, ?, ?)`,
        id,
        input.runId,
        input.kind,
        input.idempotencyKey,
        JSON.stringify(input.target),
        input.candidateId ?? null,
        input.treeHash ?? null,
        input.commitSha ?? null,
        now,
        now,
      );
      appendEvent(this.db, input.runId, 'action.intent', this.actor, { action_id: id, kind: input.kind, key: input.idempotencyKey, tree_hash: input.treeHash ?? null, commit_sha: input.commitSha ?? null }, now);
      return { action: this.get(id), created: true };
    });
  }

  /** INTENT | EXECUTING | UNKNOWN | FAILED -> EXECUTING, counting the attempt. The attempt count is a compare-and-set, so two executors cannot both start the same attempt. */
  markExecuting(action: ActionRecord): ActionRecord {
    const now = this.clock.now();
    return this.db.tx(() => {
      const run = this.db.get<{ cancel_requested: number }>('SELECT cancel_requested FROM runs WHERE id = ?', action.runId);
      // A new external side effect after a durable cancellation would outlive the run's authority.
      if (run?.cancel_requested) throw new OrbitError('CANCELLED', `run ${action.runId} has a durable cancellation request; ${action.kind} will not start`, { actionId: action.id });
      const res = this.db.run(
        `UPDATE actions SET state = 'EXECUTING', attempts = attempts + 1, error = NULL, updated_at = ?
         WHERE id = ? AND attempts = ? AND state IN ('INTENT', 'EXECUTING', 'UNKNOWN', 'FAILED')`,
        now,
        action.id,
        action.attempts,
      );
      if (res.changes !== 1) throw new OrbitError('CONCURRENT_UPDATE', `action ${action.id} changed under this executor`, { actionId: action.id });
      appendEvent(this.db, action.runId, 'action.executing', this.actor, { action_id: action.id, kind: action.kind, attempt: action.attempts + 1 }, now);
      return this.get(action.id);
    });
  }

  recordReceipt(action: ActionRecord, receipt: unknown, via: 'execute' | 'reconcile'): ActionRecord {
    const now = this.clock.now();
    const json = JSON.stringify(receipt ?? null);
    return this.db.tx(() => {
      this.db.run("UPDATE actions SET state = 'SUCCEEDED', receipt_json = ?, error = NULL, updated_at = ? WHERE id = ?", json, now, action.id);
      appendEvent(this.db, action.runId, 'action.succeeded', this.actor, { action_id: action.id, kind: action.kind, via, attempts: action.attempts }, now);
      return this.get(action.id);
    });
  }

  markUnknown(action: ActionRecord, reason: string): ActionRecord {
    return this.markFailedOrUnknown(action, 'UNKNOWN', reason, 'action.unknown');
  }

  markFailed(action: ActionRecord, reason: string): ActionRecord {
    return this.markFailedOrUnknown(action, 'FAILED', reason, 'action.failed');
  }

  private markFailedOrUnknown(action: ActionRecord, state: 'UNKNOWN' | 'FAILED', reason: string, event: string): ActionRecord {
    const now = this.clock.now();
    const message = redact(reason).slice(0, 2000);
    return this.db.tx(() => {
      this.db.run('UPDATE actions SET state = ?, error = ?, updated_at = ? WHERE id = ? AND state != ?', state, message, now, action.id, 'SUCCEEDED');
      appendEvent(this.db, action.runId, event, this.actor, { action_id: action.id, kind: action.kind, attempts: action.attempts, error: message }, now);
      return this.get(action.id);
    });
  }

  async performAction<T>(input: ActionInput, handlers: ActionHandlers<T>, options: PerformOptions): Promise<ActionResult<T>> {
    if (!options.authorization.allowed) {
      const now = this.clock.now();
      this.db.tx(() => appendEvent(this.db, input.runId, 'action.denied', this.actor, { kind: input.kind, key: input.idempotencyKey, rule: options.authorization.rule, reason: options.authorization.reason }, now));
      throw new OrbitError('POLICY_DENIED', `${input.kind} is not authorized: ${options.authorization.reason}`, { rule: options.authorization.rule, kind: input.kind });
    }
    await options.precheck?.();

    let { action } = this.recordIntent(input);
    if (action.state === 'SUCCEEDED') return { action, receipt: action.receipt as T, outcome: 'already-done' };

    let lastError: unknown = null;
    for (;;) {
      // Wait before the reconciling read too: a read sent straight into a rate limit fails and aborts the call.
      if (lastError !== null) await this.clock.sleep(this.delayBefore(action.attempts, lastError));
      // Anything attempted before (this call, an earlier call, a crashed predecessor) may have taken effect.
      if (action.attempts > 0 || action.state === 'EXECUTING' || action.state === 'UNKNOWN') {
        const found = await this.reconcileOnce(action, handlers);
        if (found.action.state === 'SUCCEEDED') return { action: found.action, receipt: found.action.receipt as T, outcome: 'reconciled' };
        action = found.action;
      }

      if (action.attempts >= this.maxAttempts) {
        throw new OrbitError('DELIVERY_FAILED', `${input.kind} did not complete after ${action.attempts} attempts; remote state was queried and the action is not present`, {
          actionId: action.id,
          kind: action.kind,
          attempts: action.attempts,
          lastError: action.error,
        }, lastError ? { cause: lastError } : undefined);
      }

      await options.precheck?.();
      action = this.markExecuting(action);
      const ctx: ActionContext = { action, attempt: action.attempts };

      // A fault here leaves the row EXECUTING, as a crash would: the next call reconciles first.
      faultPoint(`delivery.${action.kind}.before-execute`);

      let receipt: T;
      try {
        receipt = await handlers.execute(ctx);
      } catch (err) {
        if (isDefinitiveFailure(err)) {
          this.markFailed(action, errorText(err));
          throw err;
        }
        lastError = err;
        action = this.markUnknown(action, errorText(err));
        continue;
      }

      // The remote has acted; losing the response here is exactly the case reconciliation exists for.
      if (faultPoint(`delivery.${action.kind}.after-execute`) === 'lose-response') {
        lastError = new OrbitError('PROVIDER_TRANSIENT', 'response lost after the action was performed');
        action = this.markUnknown(action, 'response lost after execute');
        continue;
      }
      const done = this.recordReceipt(action, receipt, 'execute');
      return { action: done, receipt, outcome: 'executed' };
    }
  }

  private async reconcileOnce<T>(action: ActionRecord, handlers: ActionHandlers<T>): Promise<{ action: ActionRecord }> {
    const ctx: ActionContext = { action, attempt: action.attempts };
    let found: T | null;
    try {
      found = await handlers.reconcile(ctx);
    } catch (err) {
      // We still do not know; never fall through to a blind retry.
      if (action.state === 'EXECUTING') this.markUnknown(action, `reconcile failed: ${errorText(err)}`);
      throw err;
    }
    const now = this.clock.now();
    this.db.tx(() => appendEvent(this.db, action.runId, 'action.reconciled', this.actor, { action_id: action.id, kind: action.kind, attempts: action.attempts, found: found !== null }, now));
    if (this.opts.runDir) {
      recordDecision(
        this.db,
        this.opts.runDir,
        {
          id: `dec-${action.id}-r${action.attempts}-${found !== null ? 'found' : 'absent'}`,
          runId: action.runId,
          kind: 'action.reconcile',
          summary: `${action.kind}: remote state queried before any retry; ${found !== null ? 'the action had taken effect' : 'the action is not present'}`,
          data: { action_id: action.id, key: action.idempotencyKey, attempts: action.attempts, found: found !== null },
        },
        this.clock,
        { actor: this.actor },
      );
    }
    if (found === null) return { action };
    return { action: this.recordReceipt(action, found, 'reconcile') };
  }

  private delayBefore(attempts: number, err: unknown): number {
    const hinted = isOrbitError(err) && typeof err.details?.retryAfterMs === 'number' ? err.details.retryAfterMs : 0;
    const backoff = this.opts.backoffMs ? this.opts.backoffMs(attempts) : Math.min(30_000, 500 * 2 ** Math.max(0, attempts - 1));
    return Math.max(hinted, backoff);
  }
}

function errorText(err: unknown): string {
  if (isOrbitError(err)) return `${err.code}: ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}
