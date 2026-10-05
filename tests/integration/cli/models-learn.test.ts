/** `models refresh` and `learn ingest` against the fake provider CLIs, as child processes. */
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ingestSourceId } from '../../../src/knowledge/ingest.ts';
import { makeSandbox, makeScratch, removeScratch, type Sandbox } from './helpers.ts';

const boxes: Sandbox[] = [];
afterEach(() => {
  boxes.splice(0).forEach((b) => b.close());
  removeScratch();
});
const box = (o: Parameters<typeof makeSandbox>[0] = {}) => {
  const b = makeSandbox(o);
  boxes.push(b);
  return b;
};

describe('orbit models refresh', () => {
  it('seeds the registry, reads the installed CLIs and registers the live Codex catalog', async () => {
    const b = box();
    const r = await b.run(['models', 'refresh', '--json']);
    expect(r.code, r.stderr).toBe(0);
    const j = JSON.parse(r.stdout) as { notes: string[]; models: { model: string; available: boolean }[] };
    expect(j.notes.join('\n')).toMatch(/seeded the registry: \d+ added/);
    expect(j.notes.join('\n')).toMatch(/provider claude: claude 2\.1\.288/);
    expect(j.notes.join('\n')).toMatch(/provider codex: \d+ model\(s\) listed/);
    expect(j.models.some((m) => m.model.startsWith('gpt-'))).toBe(true);

    const list = JSON.parse((await b.run(['models', 'list', '--json'])).stdout) as { persisted: boolean; models: { model: string; surface: string; availability: string }[] };
    expect(list.persisted).toBe(true);
    // A catalog that lists a model on this client makes it available on the codex surface; Claude models stay unvalidated.
    expect(list.models.find((m) => m.surface === 'codex-cli')?.availability).toBe('available');
    expect(list.models.find((m) => m.model === 'claude-sonnet-5-5')?.availability).toBe('unvalidated');
  });

  it('marks models an older claude cannot run as unavailable, with the reason', async () => {
    const b = box({ fakes: { claude: { ORBIT_FAKE_CLAUDE_VERSION: '2.1.270' } } });
    const r = await b.run(['models', 'refresh']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/claude-sonnet-5-5: unavailable \(needs claude >= 2\.1\.284\)/);
    const list = JSON.parse((await b.run(['models', 'list', '--json'])).stdout) as { models: { model: string; availability: string; availability_detail: string | null; eligible: boolean }[] };
    const sonnet = list.models.find((m) => m.model === 'claude-sonnet-5-5')!;
    expect(sonnet).toMatchObject({ availability: 'unavailable', eligible: false });
    expect(sonnet.availability_detail).toMatch(/installed claude 2\.1\.270 is older than 2\.1\.284/);
  });

  it('leaves the registry as it was when a provider CLI is missing', async () => {
    const b = box({ fakes: { claude: false, codex: false } });
    const r = await b.run(['models', 'refresh']);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/provider claude: claude CLI unavailable/);
    expect(r.stdout).toMatch(/provider codex: /);
  });
});

describe('orbit learn ingest through a curator model', () => {
  it('runs the curator as a worker and stores what it returns as low-confidence candidates', async () => {
    const material = 'Postmortem: retries amplified the outage until we added exponential backoff.\n';
    const sourceId = ingestSourceId({ kind: 'file', ref: 'postmortem.md', content: material });
    const lesson = {
      schema: 'orbit.lesson/1',
      kind: 'hazard',
      statement: 'Bound retries with exponential backoff and a maximum attempt count.',
      rationale: 'Unbounded retries turned a partial outage into a full one.',
      applicability: { languages: [], frameworks: [], paths: [], check_ids: [], fingerprints: [], roles: [], keywords: ['retries', 'backoff'] },
      verification: 'Retries in the changed code are bounded and use increasing delays.',
      evidence: [{ run_id: sourceId, artifact: sourceId, relation: 'supports' }],
      provenance: { source: 'ingest', uri: null, derived_from: [sourceId], generated_by: 'm', generated_at: '2026-10-03T08:00:00.000Z' },
      confidence: 'high',
      code_free: true,
      supersedes: null,
    };
    // The curator fake returns this structured output; its wrapper reads the scenario from its own environment.
    const scenario = join(makeScratch(), 'curator.json');
    writeFileSync(scenario, JSON.stringify({ auth: { loggedIn: true, authMethod: 'api_key' }, roles: { curator: [{ structured: { lessons: [lesson], discarded: [] }, usage: { inputTokens: 100, outputTokens: 50, costUSD: 0.001 } }] } }));
    const b = box({ fakes: { claude: { ORBIT_FAKE_SCENARIO: scenario }, codex: {} } });
    writeFileSync(join(b.repo, 'postmortem.md'), material);

    const r = await b.run(['learn', 'ingest', 'postmortem.md', '--json'], { timeoutMs: 120_000 });
    expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
    const j = JSON.parse(r.stdout) as { created: string[]; rejected: unknown[] };
    expect(j.rejected).toEqual([]);
    expect(j.created).toHaveLength(1);

    const shown = JSON.parse((await b.run(['learn', 'show', j.created[0]!, '--json'])).stdout) as { lesson: { status: string; confidence: string; provenance: { source: string; uri: string } } };
    expect(shown.lesson).toMatchObject({ status: 'candidate', confidence: 'low', provenance: { source: 'ingest', uri: 'postmortem.md' } });
    // The worker ran outside the repository, under a snapshot written next to Orbit's own state.
    expect(existsSync(join(b.orbitHome, 'ingest'))).toBe(true);
    expect(readdirSync(join(b.repo)).includes('ingest')).toBe(false);
  }, 180_000);
});
