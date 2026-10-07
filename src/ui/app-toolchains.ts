import { redact } from '../core/redact.ts';
import { findMsbuildNodeDenial, msbuildNodeDenialNote, msbuildNodeFix, nodeDenialSubject, type MsbuildNodeDenial } from '../evidence/msbuild.ts';
import { DOTNET_CHECK_ENV } from '../evidence/runner.ts';
import { commandToolchains, prepareToolchainLayout, type ToolchainLayout } from '../isolation/toolchains.ts';
import type { IsolationProvider } from '../isolation/types.ts';

/**
 * The application under test's toolchain profile (issue #26; docs/decisions/0009-toolchain-profiles.md, addendum, item
 * 14): what a check gets, found the same way from `ui.environment.start_command` and the checkout's marker files. The
 * repository's dependency caches are read-only (the application is repository code, like a check; only Orbit's install
 * step writes them), its build state goes to a directory private to the UI run, and for .NET it gets the check's .NET
 * settings (first-run steps and SourceLink's git queries off) and the NIS domain name rule, and is stopped as soon as
 * MSBuild records a worker node the sandbox refused its named pipe, which the readiness probe cannot see.
 *
 * Measured under srt on macOS (SDK 9.0.305) with a web project referencing two libraries, before: `[dotnet, run,
 * --project, Web]` was not ready after 100 s with "(no output)" while four node reports sat in its temp directory, and
 * built with -m:1 first it ran but its HttpClient died on "GetDomainName: -1" (the NIS rule) once the polling file
 * watcher let its host start (isolation/sandbox-runtime.ts DOTNET_POLLING_WATCHER_ENV).
 */

/** The field the application's command comes from, which the fix names. */
export const APP_FIELD = 'ui.environment.start_command';
const APP_SUBJECT = nodeDenialSubject('the application');
/** How often the application's temp directory is looked at for a refused node, as the check runner does. */
const DENIAL_SCAN_MS = 1_000;

export interface AppToolchainsInput {
  command: readonly string[];
  checkoutDir: string;
  /** The repository's dependency caches (isolation/toolchains.ts toolchainCacheRoot), or null: private scratch then. */
  cacheRoot: string | null;
  /** Private to this UI run: the application's build state. */
  scratchRoot: string;
  tmpDir: string;
  isolation: IsolationProvider['kind'];
  /** The hosts the application's sandbox lets it reach: none of its own, or the journey check's when it shares that sandbox. */
  networkHosts: readonly string[];
  /** The account's real home, only to find an existing rustup installation. */
  homeDir?: string;
  hostEnv?: Readonly<Record<string, string | undefined>>;
}

export interface AppToolchains {
  layout: ToolchainLayout;
  /** Variables for the application only: its toolchains', and a check's .NET settings when it uses .NET. */
  env: Record<string, string>;
  /** What the application's sandbox adds to the check profile it is built from. */
  extraWritable: string[];
  readablePaths: string[];
  nisDomainName: boolean;
}

/** The application's toolchain layout, its directories created. */
export function appToolchains(input: AppToolchainsInput): AppToolchains {
  const layout = commandToolchains({
    command: input.command,
    roots: [input.checkoutDir],
    mode: 'check',
    cacheRoot: input.cacheRoot,
    scratchRoot: input.scratchRoot,
    tmpDir: input.tmpDir,
    isolation: input.isolation,
    networkHosts: input.networkHosts,
    ...(input.homeDir ? { hostHome: input.homeDir } : {}),
    ...(input.hostEnv ? { hostEnv: input.hostEnv } : {}),
  });
  prepareToolchainLayout(layout);
  return {
    layout,
    env: { ...layout.env, ...(layout.toolchains.includes('dotnet') ? DOTNET_CHECK_ENV : {}) },
    extraWritable: layout.writable,
    readablePaths: layout.readOnly,
    nisDomainName: layout.nisDomainName,
  };
}

/**
 * The note for an application MSBuild recorded a refused worker node for, with its start command fixed. Its exception
 * line comes from a file the application could write: redacted like its output.
 */
export function appNodeDenialNote(command: readonly string[], d: MsbuildNodeDenial, stopped: boolean): string {
  return redact(msbuildNodeDenialNote(d, msbuildNodeFix({ id: 'ui-app', command: [...command], shell: false }, { command: APP_FIELD, env: null }), stopped, APP_SUBJECT));
}

/**
 * startApp's stopWhen for an application: a worker node MSBuild recorded as refused in its temp directory, looked for at
 * most once a second while it is not ready (MSBuild would wait 30 s for each of ten node starts, past the ready timeout),
 * and once more when it exited before it was ready.
 */
export function appNodeDenialWatch(command: readonly string[], tmpDir: string, now: () => number = Date.now): (exited: boolean) => string | null {
  let next = 0;
  return (exited) => {
    if (!exited && now() < next) return null;
    next = now() + DENIAL_SCAN_MS;
    const d = findMsbuildNodeDenial(tmpDir);
    return d ? appNodeDenialNote(command, d, !exited) : null;
  };
}
