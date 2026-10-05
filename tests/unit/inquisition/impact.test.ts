import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../../src/core/clock.ts';
import { openDb } from '../../../src/storage/db.ts';
import { listDecisions } from '../../../src/storage/decisions.ts';
import { createRun } from '../../../src/controller/run-store.ts';
import { IMPACT_REGISTER_KIND, buildImpactRegister, recordImpactRegister } from '../../../src/inquisition/impact.ts';
import { defaultConfig } from '../../../src/policy/config.ts';

const diff = ['diff --git a/db/migrations/001.sql b/db/migrations/001.sql', '--- a/db/migrations/001.sql', '+++ b/db/migrations/001.sql', '+DROP TABLE legacy_users;', ''].join('\n');

function fixture() {
  const db = openDb(':memory:');
  const clock = new ManualClock();
  createRun(db, { id: 'run-1', repoRoot: '/repo/acme', goal: 'g', mode: 'autonomous', policyHash: 'sha256:x', policyPath: '/p' }, clock);
  return { db, clock, runDir: mkdtempSync(join(tmpdir(), 'orbit-impact-')) };
}

describe('impact register', () => {
  const policy = defaultConfig('autonomous-delivery');

  it('lists category, paths, reversibility and the authorization needed', () => {
    const reg = buildImpactRegister({ changedFiles: ['db/migrations/001.sql', 'src/auth/login.ts'], diff }, policy, { key: 'hidden_decision:x' });
    const data = reg.entries.find((e) => e.category === 'data')!;
    expect(data.affected_paths).toContain('db/migrations/001.sql');
    expect(data.reversibility).toBe('irreversible');
    expect(data.authorization_needed.length).toBeGreaterThan(0);
    expect(reg.entries.find((e) => e.category === 'security')!.affected_paths).toEqual(['src/auth/login.ts']);
  });

  it('is recorded as an inquisition.impact-register decision on risk-review only, idempotently', () => {
    const { db, clock, runDir } = fixture();
    const ctx = { db, clock, runId: 'run-1', runDir, policy, inquiry: { changedFiles: ['db/migrations/001.sql'], diff } };
    expect(recordImpactRegister(ctx, { key: 'k', mode: 'challenge' })).toBeNull();
    expect(listDecisions(db, 'run-1')).toHaveLength(0);
    recordImpactRegister(ctx, { key: 'k', mode: 'risk-review' });
    recordImpactRegister(ctx, { key: 'k', mode: 'risk-review' });
    const ds = listDecisions(db, 'run-1').filter((d) => d.kind === IMPACT_REGISTER_KIND);
    expect(ds).toHaveLength(1);
    expect((ds[0]!.data as { entries: { category: string }[] }).entries[0]!.category).toBe('data');
  });
});
