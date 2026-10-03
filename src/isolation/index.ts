import { OrbitError } from '../core/errors.ts';
import type { OrbitConfig } from '../policy/types.ts';
import { ContainerIsolation, type ContainerOptions } from './container.ts';
import { NoIsolation } from './none.ts';
import { SandboxRuntimeIsolation } from './sandbox-runtime.ts';
import type { IsolationProvider } from './types.ts';

export { SandboxRuntimeIsolation, buildSrtSettings, normalizeHost, seccompHelperFor, SRT_LIMITATIONS, DENIED_RESOLVED_ADDRESSES } from './sandbox-runtime.ts';
export type { SandboxRuntimeOptions, SrtSettings, SrtSource } from './sandbox-runtime.ts';
export { ContainerIsolation, DEFAULT_CONTAINER_IMAGE, DEFAULT_CONTAINER_LIMITS, CONTAINER_LIMITATIONS, containerEnvFor, planMounts } from './container.ts';
export type { ContainerOptions, ContainerWrappedCommand } from './container.ts';
export { NoIsolation, noIsolationLimitations } from './none.ts';
export {
  profileForWorker,
  profileForCheck,
  prepareWorkerTmpDir,
  workerTmpDir,
  orbitTmpRoot,
  providerDirs,
  repoParentDenial,
  PROVIDER_HOSTS,
  HOME_DENY_READ,
  SYSTEM_DENY_READ,
  CLAUDE_CONFIG_READ_ONLY,
  CODEX_HOME_READ_ONLY,
  WORKER_DIR_READ_ONLY,
} from './profiles.ts';
export type { BuiltProfile, CheckProfileInput, WorkerProfileInput, WorkerProvider, ProviderDirs } from './profiles.ts';
export type { IsolationProfile } from './util.ts';

type RunMode = OrbitConfig['mode'];

export interface GetIsolationOptions {
  /** Orbit's install directory, where a bundled srt may live. */
  orbitInstallDir: string;
  /**
   * The run's mode. Every mode but `supervised` runs unattended, and an
   * unattended run without isolation needs `allow_unisolated`. Omitted counts
   * as unattended, so a caller that forgets the mode cannot get 'none'.
   */
  mode?: RunMode;
  /** Explicit srt binary; when absent, PATH and then the install directory are searched. */
  srtPath?: string;
  /** Labels for containers, such as orbit.run=<run id>, so orphans can be found and removed. */
  labels?: Record<string, string>;
  /** Overrides for the container provider beyond what the config sets. */
  container?: Omit<ContainerOptions, 'image' | 'defaults' | 'labels'>;
}

export function isUnattended(mode: RunMode | undefined): boolean {
  return mode !== 'supervised';
}

/**
 * Pick the configured provider. Construction only: availability is async
 * and checked separately (`requireAvailable`), and every provider's wrap()
 * fails closed on its own when its tool is missing.
 */
export function getIsolation(cfg: OrbitConfig['isolation'], opts: GetIsolationOptions): IsolationProvider {
  switch (cfg.provider) {
    case 'sandbox-runtime':
      return new SandboxRuntimeIsolation({ srtPath: opts.srtPath, orbitInstallDir: opts.orbitInstallDir });
    case 'container': {
      const c = cfg.container;
      return new ContainerIsolation({
        ...opts.container,
        ...(c ? { image: c.image, defaults: { memoryMb: c.memory_mb, cpus: c.cpus, pids: c.pids } } : {}),
        labels: opts.labels,
      });
    }
    case 'none':
      if (isUnattended(opts.mode) && cfg.allow_unisolated !== true) {
        throw new OrbitError(
          'ISOLATION_UNAVAILABLE',
          `isolation provider 'none' is refused for ${opts.mode ?? 'unattended'} runs; use sandbox-runtime or container, or set isolation.allow_unisolated: true`,
          { rule: 'isolation.allow_unisolated', mode: opts.mode ?? null },
        );
      }
      return new NoIsolation();
    default: {
      const unknown: never = cfg.provider;
      throw new OrbitError('CONFIG_INVALID', `unknown isolation provider ${String(unknown)}`);
    }
  }
}

/** Preflight gate: an unavailable provider blocks the run instead of degrading to less isolation. */
export async function requireAvailable(provider: IsolationProvider): Promise<string> {
  const status = await provider.available();
  if (!status.ok) throw new OrbitError('ISOLATION_UNAVAILABLE', `${provider.kind} isolation is unavailable: ${status.detail}`, { provider: provider.kind });
  return status.detail;
}
