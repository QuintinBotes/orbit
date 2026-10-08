/**
 * A test-only wrapper around the real (fake-backed) adapters. The fakes
 * replay static structured output, but a review must echo the candidate
 * commit and a repair brief must name the failure fingerprint, neither of
 * which exists before the run. Before each task starts, the scenario
 * template is rendered with `$CANDIDATE` and `$FINGERPRINT` taken from the
 * controller's own prompt, then the real adapter runs unchanged.
 *
 * Parallel writers (G14) and parallel review units start at once, so the
 * fake's per-role call order between them is a race. A template may give a
 * work unit its own steps under `<role>@<unit>` (for example `implementer@u2`),
 * and a review focus under `reviewer@security` or `reviewer@ui`; a task whose
 * prompt names that unit or focus gets a scenario file of its own with those
 * steps as the role's list, passed to the fake through the task environment.
 * A focus keeps one file for all its sessions, so a regenerated review takes
 * the focus's next step.
 *
 * Every scenario file is replaced, never rewritten in place: a fake that has
 * just started reads it while the next task's scenario is rendered, and a file
 * truncated and then written made that fake read an empty scenario and exit 1.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CredentialStatus, ProviderAdapter, ProviderCapabilities, ProviderEvent, TaskHandle, TaskResult, TaskSpec, UsageReport } from '../../../src/adapters/types.ts';

export class ScenarioAdapter implements ProviderAdapter {
  readonly id: string;
  private readonly inner: ProviderAdapter;
  private readonly templatePath: string;
  private readonly scenarioPath: string;
  /** `claude plugin list --json`, when the wrapped adapter can list plugins: what doctor and run start judge a worker's plugins by. */
  readonly listPlugins?: () => Promise<unknown>;

  constructor(inner: ProviderAdapter, templatePath: string, scenarioPath: string) {
    this.inner = inner;
    this.id = inner.id;
    this.templatePath = templatePath;
    this.scenarioPath = scenarioPath;
    const list = (inner as { listPlugins?: () => Promise<unknown> }).listPlugins;
    if (typeof list === 'function') this.listPlugins = () => list.call(inner);
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
    const focus = FOCUSES[/Focus: (security|the user interface)\./.exec(spec.prompt)?.[1] ?? ''];
    const key = unit ?? focus;
    const scenario = JSON.parse(text) as { roles?: Record<string, unknown> };
    const own = key ? scenario.roles?.[`${spec.role}@${key}`] : undefined;
    if (key && own) {
      // A unit has one session (its own file); a focus's sessions share one, so its call count goes on across regenerations.
      const path = join(dirname(this.scenarioPath), unit ? `scenario.${spec.workerId}.json` : `scenario.${spec.role}@${key}.json`);
      replaceFile(path, JSON.stringify({ ...scenario, roles: { ...scenario.roles, [spec.role]: own } }));
      return this.inner.startTask({ ...spec, env: { ...spec.env, ORBIT_FAKE_SCENARIO: path } });
    }
    replaceFile(this.scenarioPath, text);
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

/** The review focus a reviewer prompt names (FOCUS_TEXT in src/controller/steps/reviewing.ts) -> its scenario key. */
const FOCUSES: Record<string, string> = { security: 'security', 'the user interface': 'ui' };

/**
 * Write `text` to `path` as a fake reading it at any moment must see it: whole, the old content or the new. The
 * text goes to a file beside it, which is renamed over it (a rename replaces the name at once; writeFileSync would
 * empty the file a reader may be opening and then write it).
 */
export function replaceFile(path: string, text: string): void {
  const tmp = join(dirname(path), `.${randomBytes(6).toString('hex')}.tmp`);
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}
