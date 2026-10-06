/**
 * NM6: the Codex catalog `orbit models refresh` reads belongs to the user and the Codex installation, not to one
 * repository, so a refresh in repository A serves repository B: the validated catalog is kept under ORBIT_HOME and a
 * repository whose own registry has no Codex models adopts it. Nothing is probed on the way.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkAdmission } from '../../../src/cli/admission.ts';
import { createContext } from '../../../src/cli/context.ts';
import { memoryIo } from '../../../src/cli/io.ts';
import { loadConfig } from '../../../src/policy/index.ts';
import { git, makeSandbox, TEST_CONFIG, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
afterEach(() => boxes.splice(0).forEach((b) => b.close()));

function secondRepo(b: Sandbox): string {
  const repo = join(b.base, 'repo-b');
  mkdirSync(join(repo, '.orbit'), { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  writeFileSync(join(repo, 'README.md'), '# acme b\n');
  // No pinned reviewer model: which one is used depends on the catalog, which is what this is about.
  // review.when_unavailable: block (the default before decision 0007, #6 and #8), so admission needs the Codex reviewer.
  writeFileSync(join(repo, '.orbit', 'config.yaml'), TEST_CONFIG.replace(', model: gpt-6-astra', '').replace('knowledge:', 'review:\n  when_unavailable: block\nknowledge:'));
  git(repo, 'add', 'README.md');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}

describe('models refresh is shared across repositories of one user', () => {
  it('a refresh in repository A makes the Codex models available in repository B, without a second refresh', async () => {
    const b = makeSandbox();
    boxes.push(b);
    const repoB = secondRepo(b);
    const before = JSON.parse((await b.run(['models', 'list', '--json'], { cwd: repoB })).stdout) as { models: { surface: string; availability: string }[] };
    expect(before.models.some((m) => m.surface === 'codex-cli' && m.availability === 'available')).toBe(false);

    const refresh = await b.run(['models', 'refresh']);
    expect(refresh.code, refresh.stderr).toBe(0);

    const after = JSON.parse((await b.run(['models', 'list', '--json'], { cwd: repoB })).stdout) as { models: { surface: string; availability: string }[] };
    expect(after.models.find((m) => m.surface === 'codex-cli')?.availability).toBe('available');
  });

  it('admission in repository B passes the reviewer gate after a refresh in repository A', async () => {
    const b = makeSandbox();
    boxes.push(b);
    const repoB = secondRepo(b);
    const ctx = () => createContext({ io: memoryIo(), cwd: repoB, env: b.env(), homeDir: b.home, orbitHome: b.orbitHome });
    const config = loadConfig(repoB);

    const refused = await checkAdmission(ctx(), { repo: repoB, config, foreground: true });
    expect(refused?.reasons.join(' ')).toMatch(/no model qualified for review|no independent reviewer/);
    expect(refused?.fix).toContain('orbit models refresh');

    expect((await b.run(['models', 'refresh'])).code).toBe(0);
    const admitted = await checkAdmission(ctx(), { repo: repoB, config, foreground: true });
    expect(admitted, JSON.stringify(admitted)).toBeNull();
  });

  it('keeps the catalog under ORBIT_HOME and ignores one that is too old', async () => {
    const b = makeSandbox();
    boxes.push(b);
    const repoB = secondRepo(b);
    expect((await b.run(['models', 'refresh'])).code).toBe(0);
    const file = join(b.orbitHome, 'models', 'codex-catalog.json');
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { saved_at: number; catalog: unknown };
    expect(Array.isArray(saved.catalog) || typeof saved.catalog === 'object').toBe(true);
    writeFileSync(file, JSON.stringify({ ...saved, saved_at: Date.now() - 30 * 24 * 3600 * 1000 }));
    const stale = JSON.parse((await b.run(['models', 'list', '--json'], { cwd: repoB })).stdout) as { models: { surface: string; availability: string }[] };
    expect(stale.models.some((m) => m.surface === 'codex-cli' && m.availability === 'available')).toBe(false);
  });
});
