import { describe, expect, it } from 'vitest';
import { ago, iso, memoryIo, oneLine, table } from '../../../src/cli/io.ts';
import { formatEvent } from '../../../src/cli/commands/drive.ts';

describe('output never carries secrets', () => {
  it('redacts known secret shapes in everything printed, stdout and stderr alike', () => {
    const io = memoryIo();
    io.out('token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 done\n');
    io.err('gh ghp_abcdefghijklmnopqrstuvwxyz0123456789\n');
    expect(io.stdout).toContain('[REDACTED');
    expect(io.stdout).not.toContain('abcdefghijklmnop');
    expect(io.stderr).not.toContain('ghp_abc');
  });
});

describe('formatting helpers', () => {
  it('lays out a table with a header and trims trailing space', () => {
    expect(table([['a', 'bb'], ['ccc', 'd']], ['X', 'Y'])).toBe('X    Y\na    bb\nccc  d\n');
    expect(table([])).toBe('');
  });

  it('shortens text to one line', () => {
    expect(oneLine('a\n  b   c', 20)).toBe('a b c');
    expect(oneLine('x'.repeat(50), 10)).toBe('xxxxxxx...');
  });

  it('describes ages', () => {
    expect(ago(100_000, null)).toBe('never');
    expect(ago(100_000, 70_000)).toBe('30s ago');
    expect(ago(10_000_000, 10_000_000 - 20 * 60_000)).toBe('20m ago');
    expect(ago(10_000_000_000, 10_000_000_000 - 3 * 3_600_000)).toBe('3h ago');
    expect(iso(null)).toBe('-');
    expect(iso(0)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('formats events for a person watching a run', () => {
    const base = { id: 1, ts: Date.UTC(2026, 0, 2, 3, 4, 5), actor: 'c', from_state: null, to_state: null };
    expect(formatEvent({ ...base, type: 'state.transition', from_state: 'PLANNING', to_state: 'IMPLEMENTING', data_json: JSON.stringify({ reason: 'plan accepted' }) })).toBe('[03:04:05] PLANNING -> IMPLEMENTING  plan accepted');
    expect(formatEvent({ ...base, type: 'progress', data_json: JSON.stringify({ kind: 'check.finished' }) })).toBe('[03:04:05] progress: check.finished');
    expect(formatEvent({ ...base, type: 'worker.retry', data_json: 'not json' })).toBe('[03:04:05] worker.retry');
    // Events recorded without data are stored as the JSON text null, and arrays carry no reason.
    expect(formatEvent({ ...base, type: 'run.paused', data_json: 'null' })).toBe('[03:04:05] run.paused');
    expect(formatEvent({ ...base, type: 'x', data_json: '[1]' })).toBe('[03:04:05] x');
  });
});
