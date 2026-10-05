import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clockTime } from '../../../src/cli/io.ts';
import { formatEvent } from '../../../src/cli/commands/drive.ts';

// Progress lines are read next to the terminal's own clock, so they use local time.
describe('clockTime', () => {
  // The suite runs in UTC; a zone two hours away proves these are local times, not UTC.
  const saved = process.env.TZ;
  beforeAll(() => { process.env.TZ = 'Europe/Amsterdam'; });
  afterAll(() => { process.env.TZ = saved; });
  it('runs in a zone that is not UTC', () => {
    expect(new Date(Date.UTC(2026, 9, 5, 12)).getHours()).toBe(14);
  });
  const ts = Date.UTC(2026, 9, 5, 16, 18, 19);
  const local = (ms: number) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':'); };
  it('formats epoch milliseconds and ISO strings in local time', () => {
    expect(clockTime(ts)).toBe(local(ts));
    expect(clockTime(new Date(ts).toISOString())).toBe(local(ts));
  });
  it('shows a placeholder for anything unparseable', () => {
    expect(clockTime('not a time')).toBe('--:--:--');
    expect(clockTime(undefined)).toBe('--:--:--');
  });
  it('is what the foreground progress lines show', () => {
    const lineText = formatEvent({ id: 1, run_id: 'r', ts, type: 'run.created', from_state: null, to_state: null, actor: 'cli', data_json: null } as never);
    expect(lineText.startsWith(`[${local(ts)}]`)).toBe(true);
  });
});
