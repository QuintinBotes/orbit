import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { defaultConfig } from '../../../src/policy/config.ts';
import { snapshotPolicy } from '../../../src/policy/snapshot.ts';
import { assertDeliverable, type GateInput } from '../../../src/delivery/gate.ts';

const TREE = 'a'.repeat(40);
let dir: string;
let make: () => GateInput;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-gate-'));
  const { snapshot, hash } = snapshotPolicy(defaultConfig('autonomous-delivery'), { runId: 'r1', repoRoot: dir, runDir: join(dir, 'run'), clock: new ManualClock() });
  make = () => ({
    run: { id: 'r1', repoRoot: dir, branch: 'orbit/r1', baseRevision: 'b'.repeat(40), policyHash: hash },
    candidate: { id: 'c1', commitSha: 'c'.repeat(40), treeHash: TREE, parentSha: 'b'.repeat(40) },
    evidence: { candidateId: 'c1', treeHash: TREE, policyHash: hash, verdict: 'PASS', checkConfigHash: 'sha256:cc' },
    review: { candidateId: 'c1', treeHash: TREE, verdict: 'APPROVE' },
    snapshot,
  });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function refused(change: (i: GateInput) => void, text: RegExp, code = 'STALE_EVIDENCE'): void {
  const input = make();
  change(input);
  expect(() => assertDeliverable(input)).toThrow(expect.objectContaining({ code, message: expect.stringMatching(text) }));
}

describe('assertDeliverable', () => {
  it('accepts exact, current, passing, approved evidence', () => {
    expect(() => assertDeliverable(make())).not.toThrow();
    expect(() => assertDeliverable({ ...make(), currentTree: TREE, expectedCheckConfigHash: 'sha256:cc' })).not.toThrow();
  });

  it('refuses evidence for another tree (one byte changed after review)', () => {
    refused((i) => void (i.candidate = { ...i.candidate, treeHash: `${'a'.repeat(39)}b` }), /evidence covers tree/);
  });

  it('refuses a review for another tree', () => {
    refused((i) => void (i.review = { ...i.review, treeHash: 'f'.repeat(40) }), /review covers tree/);
  });

  it('refuses when the worktree has changed since review', () => {
    refused((i) => void (i.currentTree = 'e'.repeat(40)), /worktree now has tree/);
  });

  it('refuses failing, incomplete or invalidated evidence', () => {
    refused((i) => void (i.evidence = { ...i.evidence, verdict: 'FAIL' }), /not PASS/);
    refused((i) => void (i.evidence = { ...i.evidence, verdict: 'INCOMPLETE' }), /not PASS/);
    refused((i) => void (i.evidence = { ...i.evidence, invalidatedAt: 5 }), /evidence was invalidated/);
  });

  it('refuses a review that is not an approval or was invalidated', () => {
    refused((i) => void (i.review = { ...i.review, verdict: 'REQUEST_CHANGES' }), /not APPROVE/);
    refused((i) => void (i.review = { ...i.review, invalidatedAt: 5 }), /review was invalidated/);
  });

  it('refuses evidence or a review that belongs to another candidate', () => {
    refused((i) => void (i.evidence = { ...i.evidence, candidateId: 'other' }), /different candidate/);
    refused((i) => void (i.review = { ...i.review, candidateId: 'other' }), /different candidate/);
  });

  it('refuses evidence from another policy snapshot or check configuration', () => {
    refused((i) => void (i.evidence = { ...i.evidence, policyHash: 'sha256:other' }), /different policy snapshot/);
    refused((i) => void (i.expectedCheckConfigHash = 'sha256:changed'), /different check configuration/);
  });

  it('reports every problem at once', () => {
    const input = make();
    input.evidence = { ...input.evidence, verdict: 'FAIL' };
    input.review = { ...input.review, verdict: 'REJECT' };
    try {
      assertDeliverable(input);
      expect.unreachable();
    } catch (err) {
      expect((err as { details: { problems: string[] } }).details.problems).toHaveLength(2);
    }
  });

  it('refuses a snapshot that no longer matches the hash recorded for the run', () => {
    refused((i) => void (i.run = { ...i.run, policyHash: 'sha256:' + '0'.repeat(64) }), /policy snapshot/, 'POLICY_TAMPERED');
  });

  it('refuses after a durable cancellation', () => {
    refused((i) => void (i.run = { ...i.run, cancelRequested: true }), /cancellation/, 'CANCELLED');
  });

  it('refuses a malformed tree hash', () => {
    refused((i) => void ((i.candidate = { ...i.candidate, treeHash: 'nope' }), (i.evidence = { ...i.evidence, treeHash: 'nope' }), (i.review = { ...i.review, treeHash: 'nope' })), /valid tree hash/);
  });
});
