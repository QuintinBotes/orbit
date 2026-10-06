/**
 * Nm10: a plugin installed offline has no node_modules (its install runs `npm ci` for the sandbox runtime), so srt is
 * missing, and doctor says that, with the way out, instead of only "srt not found".
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeLab, type Lab } from './lab.ts';

vi.mock('../../../src/isolation/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/isolation/index.ts')>();
  return { ...actual, getIsolation: () => ({ kind: 'sandbox-runtime', available: async () => ({ ok: false, detail: 'srt not found on PATH, and no node_modules/.bin/srt in the installation' }), wrap: () => ({}) }) } as unknown as typeof actual;
});

const labs: Lab[] = [];
afterEach(() => labs.splice(0).forEach((l) => l.close()));

async function isolation(root: string | null, withModules: boolean) {
  const l = makeLab();
  labs.push(l);
  await l.cli(['init']);
  let env: Record<string, string | undefined> = { ...process.env, HOME: l.home };
  if (root !== null) {
    const plugin = join(l.base, root);
    mkdirSync(plugin, { recursive: true });
    writeFileSync(join(plugin, 'package.json'), '{}');
    if (withModules) mkdirSync(join(plugin, 'node_modules'), { recursive: true });
    env = { ...env, ORBIT_PLUGIN_ROOT: plugin };
  }
  const report = JSON.parse((await l.cli(['doctor', '--json'], { env })).out) as { checks: { id: string; status: string; summary: string; missing?: string; fix?: string }[] };
  return report.checks.find((c) => c.id === 'isolation')!;
}

describe('doctor: srt missing from a plugin install', () => {
  it('says the plugin\'s node_modules is missing and how to restore it', async () => {
    const c = await isolation('plugin', false);
    expect(c.status).toBe('fail');
    expect(c.summary).toMatch(/the plugin's node_modules is missing/);
    expect(c.summary).toMatch(/offline/);
    expect(c.fix).toContain('claude plugin update orbit');
    expect(c.fix).toMatch(/npm ci --omit=dev/);
  });

  it('does not blame node_modules when it is there, or when this is not a plugin install', async () => {
    for (const c of [await isolation('plugin', true), await isolation(null, false)]) {
      expect(c.summary).not.toMatch(/node_modules is missing/);
      expect(c.fix).not.toContain('claude plugin update');
    }
  });
});
