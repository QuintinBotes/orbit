/**
 * What a default-mode (no review.mode) lab run leaves behind, normalised so two runs of the same code agree: the decision
 * kinds and summaries, the reviewer sessions, the state path and the final report, plus the hash of the default config.
 * tests/acceptance/review-voice-default.fixture.json holds the capture of origin/next before issue #231.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashObject } from '../../../src/core/hash.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { listWorkers } from '../../../src/storage/workers.ts';
import type { Lab } from './lab.ts';
import { transitions } from './invariants.ts';

export function normalize(text: string): string {
  return text
    .replace(/orb-\d{8}-\d{6}-[0-9a-f]+/g, 'RUN')
    .replace(/\b[0-9a-f]{40}\b/g, 'SHA')
    .replace(/\b[0-9a-f]{12,16}\b/g, 'HEX')
    .replace(/\/(?:private\/)?var\/folders\/\S*?orbit-acc-\w+/g, 'LAB')
    .replace(/\b(?:dec|rev|wrk|cand)-[\w~.:-]+/g, 'ID')
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, 'TIME')
    .replace(/\$\d+(?:\.\d+)?/g, '$COST')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|min)\b/g, 'DURATION')
    .replace(/\b\d{3,}\b/g, 'N');
}

export function captureDefaultRun(l: Lab, runId: string): unknown {
  const db = l.db();
  return {
    default_config_hash: hashObject(parseConfig('version: 1\n')),
    state_path: transitions(db, runId),
    decisions: listDecisions(db, runId, {}).map((d) => ({ kind: d.kind, summary: normalize(d.summary) })).sort((a, b) => (a.kind + a.summary).localeCompare(b.kind + b.summary)),
    reviewers: listWorkers(db, { runId, role: 'reviewer' }).map((w) => ({ provider: w.provider, purpose: normalize(w.purpose ?? '') })).sort((a, b) => a.purpose.localeCompare(b.purpose)),
    report: normalize(readFileSync(join(l.runDir(runId), 'final.md'), 'utf8')),
  };
}
