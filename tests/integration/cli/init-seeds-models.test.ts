/**
 * Issue 7: a fresh setup must not hit "no model qualified for review" as a second, separate failure. `orbit init`
 * seeds the model registry and reads the Codex catalog (read-only, no model call), so once the reviewer is made
 * eligible the reviewer gate passes without an `orbit models refresh`.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAdmission } from '../../../src/cli/admission.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { loadConfig } from '../../../src/policy/index.ts';
import { makeSandbox, TEST_CONFIG, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
afterEach(() => boxes.splice(0).forEach((b) => b.close()));

describe('orbit init seeds the model registry and the Codex catalog', () => {
  it('after init and making the reviewer eligible, admission needs no models refresh', async () => {
    const b = makeSandbox({ config: null });
    boxes.push(b);
    const init = await b.run(['init']);
    expect(init.code, init.stderr).toBe(0);
    expect(init.stdout).toMatch(/model registry seeded/);
    expect(init.stdout).toMatch(/provider codex: \d+ model\(s\) listed/);
    expect(existsSync(join(b.orbitHome, 'models', 'codex-catalog.json'))).toBe(true);
    // init still creates no state database: that appears with the first run.
    expect(existsSync(join(b.repo, '.orbit', 'state.sqlite'))).toBe(false);

    // The user's one remaining step in the issue: attest the reviewer. No pinned model, so the catalog must supply one.
    writeFileSync(join(b.repo, '.orbit', 'config.yaml'), TEST_CONFIG.replace(', model: gpt-6-astra', ''));
    const config = loadConfig(b.repo);
    const ctx = createContext({ io: memoryIo(), cwd: b.repo, env: b.env(), homeDir: b.home, orbitHome: b.orbitHome });
    const refused = await checkAdmission(ctx, { repo: b.repo, config, foreground: true });
    expect(refused, JSON.stringify(refused)).toBeNull();
  });

  it('reports the catalog in --json and leaves init usable when Codex is not installed', async () => {
    const b = makeSandbox({ config: null, fakes: { codex: false } });
    boxes.push(b);
    const init = await b.run(['init', '--json']);
    expect(init.code, init.stderr).toBe(0);
    const out = JSON.parse(init.stdout) as { models: string[] };
    expect(out.models[0]).toMatch(/model registry seeded/);
    expect(out.models.join('\n')).toMatch(/provider codex: .*orbit models refresh/);
    expect(readFileSync(join(b.repo, '.orbit', 'config.yaml'), 'utf8')).toContain('providers:');
  });
});
