/**
 * Public surface of the evidence module. Callers outside evidence/ import
 * from here; `types.ts` holds the shared shapes.
 */
export type * from './types.ts';
export * from './store.ts';
export { snapshotCandidate, materializeCandidate, cleanupCandidateCheckout, candidateRef, diffStat, ORBIT_GIT_IDENTITY, type SnapshotCandidateInput, type SnapshotResult, type MaterializeOptions } from './candidate.ts';
export { runChecks, reattachCheck, resumeChecks, runCheckSet, candidateSubject, baselineSubject, candidateEvidenceDir, checkEnv, configHashFor, INSTALL_CHECK_ID, type RunnerContext, type RunChecksInput, type CheckSubject } from './runner.ts';
export { fingerprintFailure, sameFailure, normalizeLine, stripAnsi, type FailureFingerprint, type FingerprintOptions } from './fingerprint.ts';
export { buildEvidenceReport, saveEvidenceReport, reportPath, aggregateCheckConfigHash, type BuildReportInput, type UiResultInput } from './report.ts';
export { isFresh, staleReasons, invalidateEvidence, assertDeliverable, type FreshnessContext, type DeliverableInput, type ReviewBinding } from './freshness.ts';
export { runBaseline, installDependencies, planInstall, BASELINE_FILE, INSTALL_SCRIPTS_CHECK_ID, NPM_REGISTRY_HOSTS, type BaselineReport, type BaselineOutcome, type BaselineCheckEntry, type RunBaselineInput, type InstallOutcome, type InstallPlan } from './baseline.ts';
