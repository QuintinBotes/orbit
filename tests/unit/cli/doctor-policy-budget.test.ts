/** Alternate policy doctor checks and the wall-time admission floor are both decided before a run exists. */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stateDbPath } from '../../../src/controller/start.ts';
import { makeLab, type Lab } from './lab.ts';

const labs: Lab[] = [];
const lab = (): Lab => {
  const value = makeLab();
  labs.push(value);
  return value;
};
afterEach(() => labs.splice(0).forEach((value) => value.close()));

function policy(checkId: string, command: string, wallMinutes = 120): string {
  return [
    'version: 1',
    'mode: autonomous',
    'isolation:',
    '  provider: none',
    '  allow_unisolated: true',
    'scheduler:',
    '  hard_limits:',
    `    wall_minutes: ${wallMinutes}`,
    'checks:',
    `  ${checkId}:`,
    `    command: [${command}]`,
    '',
  ].join('\n');
}

function writePolicy(l: Lab, relative: string, text: string): string {
  const path = join(l.repo, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe('doctor --policy', () => {
  it('loads the alternative policy, reporting its check failure and not the repository default policy check', async () => {
    const l = lab();
    writePolicy(l, '.orbit/config.yaml', policy('default-only', 'orbit-default-only-missing'));
    writePolicy(l, 'alternative.yaml', policy('alternative-only', 'orbit-alternative-only-missing'));

    const result = await l.cli(['doctor', '--policy', 'alternative.yaml', '--json']);
    const report = JSON.parse(result.out) as { checks: Array<{ id: string; details: string[] }> };
    const checks = report.checks.find((check) => check.id === 'checks')!;
    expect(checks.details.join('\n')).toContain('alternative-only');
    expect(checks.details.join('\n')).not.toContain('default-only');
  });
});

describe('wall-time minimum before a run starts', () => {
  it('doctor and run name the 38 min minimum for one implementation attempt, and run creates no state', async () => {
    const l = lab();
    writePolicy(l, '.orbit/config.yaml', policy('unit', 'node', 20));

    const doctor = await l.cli(['doctor', '--json']);
    const report = JSON.parse(doctor.out) as { checks: Array<{ id: string; status: string; summary: string; fix: string | null }> };
    expect(report.checks.find((check) => check.id === 'budget.wall-time')).toMatchObject({
      status: 'fail',
      summary: expect.stringContaining('38 min minimum'),
      fix: 'set scheduler.hard_limits.wall_minutes to at least 38 min',
    });

    const run = await l.cli(['run', '--goal', 'test the low wall-time admission', '--detach']);
    expect(run.code).not.toBe(0);
    expect(run.err).toContain('38 min minimum');
    expect(run.err).toContain('No run was created');
    expect(existsSync(stateDbPath(l.repo))).toBe(false);
  });
});
