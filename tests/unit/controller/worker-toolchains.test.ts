// A worker's toolchain profile (docs/decisions/0009-toolchain-profiles.md): the repository's dependency caches
// read-only, its build state private to the worker, and nothing pointing at the user's own caches.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { repoKey } from '../../../src/controller/context.ts';
import { implementingStep } from '../../../src/controller/steps/implementing.ts';
import { giveRepository, initLedger, makeUnitLab, okResult, scriptedAdapter, setContract, validateModels, type UnitLab } from './coverage-helpers.ts';

let lab: UnitLab;
afterEach(() => lab?.cleanup());

const IMPL = { summary: 's', changed_paths: [], tests_added: [], checks_run: [], evidence_refs: [], remaining_issues: [], next_action: { kind: 'request-verification', detail: 'd' } };

describe('worker toolchain profiles', () => {
  it('gives an implementer in a Rust repository the repository cache read-only and private build state in its worker directory', async () => {
    lab = makeUnitLab({ path: ['PREFLIGHT', 'CONTRACTING', 'PLANNING', 'IMPLEMENTING'], deps: { schedulerProbe: { availableParallelism: () => 16, freemem: () => 64_000 * 1024 * 1024 } } });
    const adapter = scriptedAdapter(lab, () => okResult(IMPL));
    lab.deps.adapters = { claude: adapter };
    validateModels(lab);
    const repo = await giveRepository(lab, { 'Cargo.toml': '[package]\nname = "acme"\n', 'apps/lib.rs': 'pub fn add() {}\n' });
    setContract(lab, { baseline_revision: repo.base });
    initLedger(lab);
    await implementingStep(lab.ctx());
    const spec = adapter.specs[0]!;
    const cache = join(lab.home, 'toolchains', repoKey(lab.repo), 'cargo');
    expect(spec.env).toMatchObject({ CARGO_HOME: cache, CARGO_TARGET_DIR: join(spec.workerDir, 'toolchains', 'cargo-target') });
    expect(spec.env).not.toHaveProperty('GOMODCACHE');
    const sandbox = spec.sandbox as typeof spec.sandbox & { readablePaths: string[] };
    expect(sandbox.readablePaths).toContain(cache);
    expect(sandbox.writablePaths).not.toContain(cache);
    expect(sandbox.writablePaths.some((p) => join(spec.workerDir, 'toolchains').startsWith(p))).toBe(true);
    expect(existsSync(cache)).toBe(true);
  });
});
