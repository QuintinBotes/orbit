/**
 * Recovery and self-healing (spec sections 4 and 14): reconciliation of
 * workers, checks, UI fixtures and external actions on controller start,
 * bounded backoff and failure classification, the watchdog, and credential
 * validation that blocks instead of retrying.
 */
export { isAlive, isGroupAlive, processInfo, processStartTime, terminateGroup, killGroup } from '../core/proc.ts';
export { reconcileOnStart, stopWorker, isRunTerminal } from './reconcile.ts';
export type { ReconcileOptions, ReconcileReport, RunReconcileReport, WorkerReport, WorkerObservation, CheckReport, CheckObservation, AppReport, ActionReport } from './reconcile.ts';
export { backoffCeilingMs, backoffDelayMs, classifyFailure, decideRetry, retryWithBackoff, DEFAULT_BACKOFF, DEFAULT_MAX_REGENERATIONS, DEFAULT_MAX_RETRY_AFTER_MS } from './backoff.ts';
export type { BackoffPolicy, Classification, FailureKind, FailureSignal, RandomSource, RetryBudget, RetryContext, RetryDecision, RetryOptions, StopLimit } from './backoff.ts';
export { watchdogTick, watchdogLoop, DEFAULT_WATCHDOG } from './watchdog.ts';
export type { WatchdogConfig, WatchdogFinding, WatchdogFindingKind, WatchdogLoopOptions, WatchdogOptions, WatchdogReport } from './watchdog.ts';
export { authBlocker, blockRunOnCredentials, checkRunCredentials, credentialCheckDue, providersForRun, validateCredentials, verdictOf, LOGIN_COMMANDS, CREDENTIALS_CHECKED_EVENT } from './credentials.ts';
export type { AuthBlocker, AuthBlockerInput, BlockOutcome, BlockedCredentialState, CredentialCheck, CredentialVerdict, RunCredentialCheckOptions, RunCredentialReport, ValidateOptions } from './credentials.ts';
export { enterRecovery, spendRecoveryAttempt, DEFAULT_FALLBACK_RECOVERIES, RECOVERY_ATTEMPT_EVENT } from './budget.ts';
export type { EnterRecoveryInput, EnterRecoveryOutcome, LedgerFor, RecoveryLedger } from './budget.ts';
export { groupOwnership, processOwnership, startToEpochMs } from './identity.ts';
export type { GroupOwnership } from './identity.ts';
