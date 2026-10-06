/**
 * Scenario-driven stand-ins for the provider CLIs, for integration,
 * fault-injection and acceptance tests. A FakeAdapter is the real Claude or
 * Codex adapter pointed at tests/fakes/fake-claude.mjs or fake-codex.mjs:
 * the same argv, settings, environment scrubbing, shim, files and
 * classification run, and only the model is replaced by a script that
 * follows ORBIT_FAKE_SCENARIO (format in tests/fakes/README.md).
 */
import { basename } from 'node:path';
import { OrbitError } from '../core/errors.ts';
import { ClaudeAdapter, type ClaudeAdapterOptions } from './claude.ts';
import { CodexAdapter, type CodexAdapterOptions } from './codex.ts';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities, ProviderEvent, TaskHandle, TaskResult, TaskSpec, UsageReport } from './types.ts';

/** Variables the fake scripts read; passed from the adapter's base environment to the fake. */
export const FAKE_ENV_KEYS: readonly string[] = ['ORBIT_FAKE_SCENARIO', 'ORBIT_FAKE_ARGV_LOG', 'ORBIT_FAKE_CLAUDE_VERSION', 'ORBIT_FAKE_CODEX_VERSION'];

export const FAKE_SCRIPTS = { claude: 'fake-claude.mjs', codex: 'fake-codex.mjs' } as const;
export type FakeProvider = keyof typeof FAKE_SCRIPTS;

/** Which fake a configured command names, by file name; null for anything else. */
export function fakeKind(command: string): FakeProvider | null {
  const name = basename(command);
  if (name === FAKE_SCRIPTS.claude) return 'claude';
  if (name === FAKE_SCRIPTS.codex) return 'codex';
  return null;
}

export type FakeAdapterOptions =
  | ({ provider: 'claude'; script: string } & Omit<ClaudeAdapterOptions, 'command'>)
  | ({ provider: 'codex'; script: string } & Omit<CodexAdapterOptions, 'command'>);

export class FakeAdapter implements ProviderAdapter {
  readonly id: string;
  readonly provider: FakeProvider;
  readonly inner: ClaudeAdapter | CodexAdapter;
  /**
   * `claude plugin list --json` through the real Claude adapter (the fake answers it from the scenario's `plugins`), so
   * doctor and run start judge a fake's plugins exactly as they judge the CLI's. Absent for Codex, which has no plugins.
   */
  readonly listPlugins?: ClaudeAdapter['listPlugins'];

  constructor(opts: FakeAdapterOptions) {
    if (fakeKind(opts.script) !== opts.provider) {
      throw new OrbitError('CONFIG_INVALID', `${opts.script} is not the ${opts.provider} fake (${FAKE_SCRIPTS[opts.provider]})`);
    }
    this.provider = opts.provider;
    const command = [process.execPath, opts.script];
    const passEnv = [...new Set([...FAKE_ENV_KEYS, ...(opts.passEnv ?? [])])];
    const { provider: _p, script: _s, ...rest } = opts;
    this.inner =
      opts.provider === 'claude'
        ? new ClaudeAdapter({ ...(rest as Omit<ClaudeAdapterOptions, 'command'>), command, passEnv, id: opts.id ?? 'claude' })
        : new CodexAdapter({ ...(rest as Omit<CodexAdapterOptions, 'command'>), command, passEnv, id: opts.id ?? 'codex' });
    this.id = this.inner.id;
    if (this.inner instanceof ClaudeAdapter) {
      const claude = this.inner;
      this.listPlugins = () => claude.listPlugins();
    }
  }

  discoverCapabilities(): Promise<ProviderCapabilities> {
    return this.inner.discoverCapabilities();
  }

  validateCredentials(): Promise<CredentialStatus> {
    return this.inner.validateCredentials();
  }

  startTask(spec: TaskSpec): Promise<TaskHandle> {
    return this.inner.startTask(spec);
  }

  streamEvents(handle: TaskHandle, fromOffset: number): Promise<{ events: ProviderEvent[]; nextOffset: number }> {
    return this.inner.streamEvents(handle, fromOffset);
  }

  cancelTask(handle: TaskHandle): Promise<void> {
    return this.inner.cancelTask(handle);
  }

  collectResult(handle: TaskHandle, spec: Pick<TaskSpec, 'outputSchema'>): Promise<TaskResult | null> {
    return this.inner.collectResult(handle, spec);
  }

  reportUsage(handle: TaskHandle): Promise<UsageReport> {
    return this.inner.reportUsage(handle);
  }

  reattach(workerDir: string): TaskHandle | null {
    return this.inner.reattach(workerDir);
  }
}
