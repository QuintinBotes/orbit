import type { IsolationProvider, SandboxProfile, WrappedCommand } from './types.ts';
import { assertArgv } from './util.ts';

/**
 * No isolation at all. It exists for supervised runs on hosts where neither
 * srt nor Docker works, and for unattended runs only when the user set
 * `isolation.allow_unisolated` (getIsolation enforces that). Its limitations
 * list every protection a profile asked for and did not get, so the evidence
 * record says plainly what ran unconfined.
 */
export class NoIsolation implements IsolationProvider {
  readonly kind = 'none' as const;

  async available(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'no isolation: commands run with every permission of the Orbit user' };
  }

  wrap(argv: string[], profile: SandboxProfile, opts: { cwd: string; env: Record<string, string> }): WrappedCommand {
    assertArgv(argv);
    return {
      argv: [...argv],
      env: { ...opts.env },
      cleanup: () => {},
      limitations: noIsolationLimitations(profile),
    };
  }
}

export function noIsolationLimitations(profile: SandboxProfile): string[] {
  const hosts = profile.allowedHosts.length ? `only ${profile.allowedHosts.join(', ')} were allowed` : 'no network was allowed';
  return [
    `No filesystem write restriction: the command can write anywhere the Orbit user can (the main checkout, .orbit state and policy snapshots, shell rc files), not just ${profile.writablePaths.length} allowed path(s).`,
    `No read restriction: none of the ${profile.denyReadPaths.length} denied path(s) (credentials such as ~/.ssh and ~/.aws, Orbit state, other projects) is protected.`,
    `No network restriction: every host is reachable, although ${hosts}.`,
    'No CPU, memory or process-count limits.',
    "No wall-clock enforcement beyond the caller killing the command's process group.",
    'Sockets and agents reachable from the environment (SSH agent, Docker or other container-control sockets) are reachable from the command.',
    'Mandatory protections of git hooks, git config and shell rc files are absent.',
  ];
}
