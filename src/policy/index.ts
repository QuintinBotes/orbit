/**
 * Public surface of the policy engine. Callers outside policy/ import from
 * here; the individual files stay free to reorganize.
 */
export { BUILTIN_CREDENTIAL_PATHS, BUILTIN_PROTECTED_PATHS, BUILTIN_PROTECTIONS, effectiveProtectedPaths } from './builtin.ts';
export {
  CONFIG_RELATIVE_PATH,
  DEFAULT_MODE,
  DELIVERY_ACTIONS,
  DELIVERY_MODES,
  RELEASE_ACTIONS,
  RUN_MODES,
  UNATTENDED_MODES,
  defaultCheck,
  checkCategory,
  sastCheckIds,
  defaultConfig,
  defaultUi,
  loadConfig,
  modelPermitted,
  parseConfig,
  validateConfig,
  type ConfigOptions,
  type RunMode,
} from './config.ts';
export {
  DEFAULT_REVIEW_FALLBACK,
  REVIEW_FALLBACKS,
  SUPPORTED_REVIEW_PROVIDERS,
  describeReviewPolicy,
  isSupportedReviewProvider,
  legacyReviewFallback,
  preferredReviewProvider,
  reviewFallback,
  reviewProviderOrder,
  type ReviewAvailabilitySettings,
  type ReviewFallback,
} from './review.ts';
export { POLICY_FILE, checkConfigHash, snapshotHash, snapshotPolicy, verifySnapshot, type SnapshotInput, type SnapshotResult } from './snapshot.ts';
export { canonicalize, isCaseInsensitiveFs, resolveDetailed, resolveInside, type Resolution } from './paths.ts';
export { authorize, type AuthorizeContext } from './authorize.ts';
export { BASH_CATEGORIES_BY_SEVERITY, classifyBash, type BashCategory, type BashClassification, type BashCommandInfo, type BashContext, type BashWrite } from './bash.ts';
export { inspectScope, type ScopeInput } from './scope.ts';
export { detectWeakening, isSnapshotPath, type WeakeningInput, type WeakeningSignal, type WeakeningSignalId } from './weakening.ts';
export { declaresCargoPackage, gitTreeReader, isDotnetTestProject, isTestPath, isTestPathOnEitherRevision, loadTestLayout, NO_LAYOUT, testedByContent, type LayoutOptions, type Owner, type TestLayout, type TreeReader } from './test-files.ts';
export { ENV_POLICY_HASH, ENV_POLICY_PATH, ENV_WORKTREE, handlePreToolUse, runGuardHook, runGuardHookProcess, type GuardOptions, type GuardResult } from './guard-hook.ts';
export { bashGrant, type BashGrant, type BashGrantInput } from './role-grants.ts';
export { hostAllowed, normalizeHost } from './hosts.ts';
