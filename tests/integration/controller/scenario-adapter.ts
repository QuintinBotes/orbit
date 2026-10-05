/**
 * A test-only wrapper around the real (fake-backed) adapters. The fakes
 * replay static structured output, but a review must echo the candidate
 * commit and a repair brief must name the failure fingerprint, neither of
 * which exists before the run. Before each task starts, the scenario
 * template is rendered with `$CANDIDATE` and `$FINGERPRINT` taken from the
 * controller's own prompt, then the real adapter runs unchanged.
 *
 * Parallel writers (G14) start at once, so the fake's per-role call order
 * between them is a race. A template may give a work unit its own steps under
 * `<role>@<unit>` (for example `implementer@u2`); a task whose prompt names
 * that unit gets a scenario file of its own with those steps as the role's
 * list, passed to the fake through the task environment.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities, ProviderEvent, TaskHandle, TaskResult, TaskSpec, UsageReport } from '../../../src/adapters/types.ts';

export class ScenarioAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly inner: ProviderAdapter;
  private readonly templatePath: string;
  private readonly scenarioPath: string;

  constructor(inner: ProviderAdapter, templatePath: string, scenarioPath: string) {
    this.inner = inner;
    this.id = inner.id;
    this.templatePath = templatePath;
    this.scenarioPath = scenarioPath;
  }

  discoverCapabilities(): Promise<ProviderCapabilities> {
    return this.inner.discoverCapabilities();
  }

  validateCredentials(): Promise<CredentialStatus> {
    return this.inner.validateCredentials();
  }

  startTask(spec: TaskSpec): Promise<TaskHandle> {
    let text = readFileSync(this.templatePath, 'utf8');
    const rev = /- revision: ([0-9a-f]{40})/.exec(spec.prompt)?.[1];
    const fp = /Failure fingerprint: (\S+)/.exec(spec.prompt)?.[1];
    if (rev) text = text.split('$CANDIDATE').join(rev);
    if (fp) text = text.split('$FINGERPRINT').join(fp);
    const unit = /You are work unit (u\d+) of/.exec(spec.prompt)?.[1];
    const scenario = JSON.parse(text) as { roles?: Record<string, unknown> };
    const own = unit ? scenario.roles?.[`${spec.role}@${unit}`] : undefined;
    if (unit && own) {
      const path = join(dirname(this.scenarioPath), `scenario.${spec.workerId}.json`);
      writeFileSync(path, JSON.stringify({ ...scenario, roles: { ...scenario.roles, [spec.role]: own } }));
      return this.inner.startTask({ ...spec, env: { ...spec.env, ORBIT_FAKE_SCENARIO: path } });
    }
    writeFileSync(this.scenarioPath, text);
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
    const r = (this.inner as { reattach?: (d: string) => TaskHandle | null }).reattach;
    return typeof r === 'function' ? r.call(this.inner, workerDir) : null;
  }
}
