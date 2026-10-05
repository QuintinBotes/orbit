/** Public surface of the controller. The CLI composes these; other modules never import the controller. */
export { Controller, type ControllerOptions, type TickReport } from './loop.ts';
export { step, STEPS, type StepFn } from './steps/index.ts';
export type { StepResult } from './steps/common.ts';
export { loadRunContext, currentCandidate, runWorktreeRoot, repoKey, DEFAULT_TIMING, type ControllerDeps, type ControllerTiming, type RunContext } from './context.ts';
export * from './gates.ts';
export { scanCandidateSecrets, sastCheckIds, TRUSTED_GITLEAKS_CONFIG, type SecretScanResult, type SecretFinding } from './security.ts';
export { writeFinalReport, buildFinalReport, renderMarkdown, finalizeRun, learnAtTerminal, type FinalReport } from './report.ts';
export * from './service.ts';
export { startRun, defaultControllerDeps, stateDbPath, orbitDir, defaultOrbitHome, orbitInstallDir, type StartRunInput, type DefaultDepsInput } from './start.ts';
export { githubClientFor } from './steps/delivering.ts';
