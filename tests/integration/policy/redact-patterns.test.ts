import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createLogger } from '../../../src/core/log.ts';
import { redact, redactForProvider } from '../../../src/core/redact.ts';
import { renderWorkerPrompt } from '../../../src/adapters/prompt.ts';
import { buildReviewPacket } from '../../../src/review/packet.ts';
import { renderMarkdown, type FinalReport } from '../../../src/controller/report.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy, verifySnapshot } from '../../../src/policy/snapshot.ts';
import { contract, evidenceReport, snapshotOf } from '../../unit/review/fixtures.ts';

/**
 * S3.28 / gap G20: `retention.redact_patterns` from the run's policy is
 * applied everywhere a run writes or sends text. The controller of a run
 * verifies the run's snapshot before acting, and that is what puts the
 * patterns in force, so nothing here passes them explicitly.
 */

const gitAvailable = spawnSync('git', ['--version']).status === 0;
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Acme Dev', GIT_AUTHOR_EMAIL: 'dev@example.com', GIT_COMMITTER_NAME: 'Acme Dev', GIT_COMMITTER_EMAIL: 'dev@example.com' };
const clock = { now: () => Date.UTC(2026, 9, 5), sleep: async () => {} };

// Shapes no built-in rule knows: only the configured pattern can catch them.
const VERIFIED_SECRET = 'ACMEINT-482915-QX';
const FROZEN_SECRET = 'acme_bridge_77Zk2pQr';

let top: string;

function finalReport(goal: string): FinalReport {
  return {
    schema: 'orbit.final/1',
    run_id: 'orb-20261005-000000-abcdef',
    outcome: 'BLOCKED',
    outcome_reason: `blocked while handling ${goal}`,
    mode: 'autonomous-delivery',
    original_goal: goal,
    objective: null,
    criteria: [],
    checks: [],
    evidence: null,
    reviews: [],
    decisions: [{ kind: 'note', summary: `saw ${goal}`, at: 0 }],
    assumptions: [],
    repairs: [],
    revision: { base: null, candidate: null, tree: null, branch: null, delivered_commit: null, pull_request: null },
    budget: null,
    unverified: [],
    residual_risks: [],
    next_action: 'resume',
    generated_at: 0,
  };
}

function snapshotDir(name: string, patterns: string[]): { runDir: string; repo: string; yaml: string } {
  const repo = join(top, `${name}-repo`);
  const runDir = join(repo, '.orbit', 'runs', name);
  mkdirSync(runDir, { recursive: true });
  const yaml = `version: 1\nretention:\n  redact_patterns: [${patterns.map((p) => JSON.stringify(p)).join(', ')}]\n`;
  return { runDir, repo, yaml };
}

beforeAll(() => {
  top = mkdtempSync(join(tmpdir(), 'orbit-redact-patterns-'));
});

afterAll(() => {
  rmSync(top, { recursive: true, force: true });
});

describe('configured redaction patterns reach every output of a run', () => {
  it('verifying a run snapshot puts its patterns in force for the controller log, worker prompts and final.md', () => {
    expect(redact(`token ${VERIFIED_SECRET}`)).toContain(VERIFIED_SECRET);

    // Freeze in a child process, so this process only ever verifies the snapshot, as a restarted controller would.
    const { runDir, repo, yaml } = snapshotDir('orb-verify', ['ACMEINT-[0-9]{6}-[A-Z]{2}']);
    const script = [
      `import { parseConfig } from ${JSON.stringify(new URL('../../../src/policy/config.ts', import.meta.url).href)};`,
      `import { snapshotPolicy } from ${JSON.stringify(new URL('../../../src/policy/snapshot.ts', import.meta.url).href)};`,
      `const r = snapshotPolicy(parseConfig(${JSON.stringify(yaml)}), { runId: 'orb-verify', repoRoot: ${JSON.stringify(repo)}, runDir: ${JSON.stringify(runDir)}, clock: { now: () => 0, sleep: async () => {} } });`,
      'process.stdout.write(JSON.stringify({ hash: r.hash, path: r.path }));',
    ].join('\n');
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
    const { hash, path } = JSON.parse(out) as { hash: string; path: string };
    expect(redact(`token ${VERIFIED_SECRET}`)).toContain(VERIFIED_SECRET);

    verifySnapshot(path, hash);

    // Controller log: the default logger redaction.
    const logFile = join(runDir, 'logs', 'controller.jsonl');
    const lines: string[] = [];
    const log = createLogger({ file: logFile, sink: (l) => lines.push(l), clock });
    log.info(`worker said ${VERIFIED_SECRET}`, { detail: { nested: `value ${VERIFIED_SECRET}` } });
    const written = readFileSync(logFile, 'utf8');
    expect(written).not.toContain(VERIFIED_SECRET);
    expect(written).toContain('[REDACTED:custom]');
    expect(lines.join('\n')).not.toContain(VERIFIED_SECRET);

    // Worker prompt: untrusted blocks, briefs and evidence excerpts.
    const prompt = renderWorkerPrompt({
      role: 'implementer',
      task: 'Fix the export.',
      contract: null,
      policySummary: 'edit apps/** only',
      candidate: null,
      briefs: [{ label: 'repair brief', content: `the log mentions ${VERIFIED_SECRET}` }],
      evidenceRefs: [{ id: 'E1', path: 'evidence/1/unit.log', sha256: 'a'.repeat(64), excerpt: `FAIL ${VERIFIED_SECRET}` }],
      untrusted: [{ label: 'ci log', content: `deploy key ${VERIFIED_SECRET}` }],
    });
    expect(prompt).not.toContain(VERIFIED_SECRET);
    expect(prompt).toContain('[REDACTED:custom]');

    // final.md
    const md = renderMarkdown(finalReport(`ship ${VERIFIED_SECRET}`));
    expect(md).not.toContain(VERIFIED_SECRET);
    expect(md).toContain('[REDACTED:custom]');
  });

  it.skipIf(!gitAvailable)('freezing a run snapshot puts its patterns in force for the review packet', async () => {
    expect(redactForProvider(`x ${FROZEN_SECRET}`)).toContain(FROZEN_SECRET);
    const { runDir, repo, yaml } = snapshotDir('orb-freeze', ['acme_bridge_[0-9A-Za-z]{8}']);
    snapshotPolicy(parseConfig(yaml), { runId: 'orb-freeze', repoRoot: repo, runDir, clock });

    const work = join(top, 'packet-repo');
    mkdirSync(work);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: work, env: GIT_ENV, encoding: 'utf8' }).trim();
    const write = (rel: string, content: string) => {
      mkdirSync(dirname(join(work, rel)), { recursive: true });
      writeFileSync(join(work, rel), content);
    };
    git('init', '-q', '-b', 'main');
    write('src/export.ts', 'export const a = 1;\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'base');
    const base = git('rev-parse', 'HEAD');
    write('src/export.ts', `export const a = 1;\nexport const bridge = "${FROZEN_SECRET}";\n`);
    git('add', '-A');
    git('commit', '-q', '-m', 'candidate');
    const cand = git('rev-parse', 'HEAD');
    const tree = git('rev-parse', 'HEAD^{tree}');

    const packet = await buildReviewPacket({
      contract: contract({ objective: `Wire the bridge ${FROZEN_SECRET}` }),
      snapshot: snapshotOf(),
      candidate: { commitSha: cand, treeHash: tree },
      baseRev: base,
      repoRoot: work,
      evidenceReport: evidenceReport(tree),
      ledger: [],
      questions: [],
      provider: 'codex',
    });
    expect(packet.text).toContain('src/export.ts');
    expect(packet.text).not.toContain(FROZEN_SECRET);
    expect(packet.text).toContain('[REDACTED:custom]');
    expect(packet.redacted).toBe(true);
  });
});
