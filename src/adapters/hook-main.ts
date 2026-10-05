/**
 * Stand-alone entry for the PreToolUse guard hook, for running it from
 * source (tests, development). The shipped path is
 * `orbit hook pre-tool-use`, which runs the same function.
 */
import { runGuardHookProcess } from '../policy/guard-hook.ts';

await runGuardHookProcess();
