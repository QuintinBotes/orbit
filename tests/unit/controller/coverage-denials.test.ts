import { describe, expect, it } from 'vitest';
import { denialTarget, denialsFromTranscript } from '../../../src/controller/denials.ts';

const use = (id: string, name: string, input: unknown) => ({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const res = (id: string, content: unknown, isError = true) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });

describe('denialsFromTranscript: unusual transcripts', () => {
  it('skips events and blocks of an unknown shape without throwing', () => {
    const events = [
      { type: 'assistant' },
      { type: 'assistant', message: 'text' },
      { type: 'assistant', message: { content: 'not an array' } },
      { type: 'assistant', message: { content: ['x', null, { type: 'text' }, { type: 'tool_use' }, { type: 'tool_use', id: 5 }] } },
      { type: 'user', message: { content: [{ type: 'tool_result' }, { type: 'tool_result', tool_use_id: 7 }, 3] } },
      { type: 'result', permission_denials: 'none' },
      { type: 'system' },
    ];
    expect(denialsFromTranscript(events as never)).toEqual([]);
  });

  it('names a guard denial for a call the transcript never shows as unknown, with no target', () => {
    const found = denialsFromTranscript([res('t1', 'Orbit policy (  secret_scan ):  a token was found ')] as never);
    expect(found).toEqual([{ toolUseId: 't1', tool: 'unknown', rule: 'secret_scan', target: null, reason: 'a token was found', source: 'guard-hook' }]);
  });

  it('a tool use without a name or with a non-object input still pairs with its denial', () => {
    const found = denialsFromTranscript([
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'a', input: 'nope' }, { type: 'tool_use', id: 'b', name: 'Write', input: { path: '' } }] } },
      res('a', 'Orbit policy (r1): no'),
      res('b', 'Orbit policy (r2): no'),
    ] as never);
    expect(found.map((d) => [d.toolUseId, d.tool, d.target])).toEqual([
      ['a', 'unknown', null],
      ['b', 'Write', null],
    ]);
  });

  it('reads the target from the first of the known input keys that holds text', () => {
    const cases: [Record<string, unknown>, string | null][] = [
      [{ notebook_path: 'n.ipynb' }, 'n.ipynb'],
      [{ path: 'p.txt' }, 'p.txt'],
      [{ url: 'https://example.com/x' }, 'https://example.com/x'],
      [{ command: 'rm -rf x', file_path: 'a' }, 'a'],
      [{ command: 42 }, null],
    ];
    for (const [input, want] of cases) {
      const [d] = denialsFromTranscript([use('t', 'Tool', input), res('t', 'Orbit policy (r): no')] as never);
      expect(d?.target).toBe(want);
    }
  });

  it('a successful or unrelated error result is not a denial', () => {
    expect(denialsFromTranscript([use('t', 'Read', { path: 'a' }), res('t', 'Orbit policy (r): looks like a denial but succeeded', false), res('u', 'ordinary failure')] as never)).toEqual([]);
  });

  it('joins array results into the text and ignores parts without text', () => {
    const found = denialsFromTranscript([res('t', [{ text: 'Orbit policy (r): first' }, { type: 'image' }, 'raw', { text: 'second' }])] as never);
    expect(found[0]?.reason).toBe('first\n\n\nsecond');
    expect(denialsFromTranscript([res('t', { text: 'Orbit policy (r): x' })] as never)).toEqual([]);
  });

  it('reads permission denials from the result line with fallbacks for missing names and results', () => {
    const found = denialsFromTranscript([
      use('p1', 'Bash', { command: 'curl x' }),
      use('p2', 'Edit', { file_path: 'a.txt' }),
      res('p2', 'Permission to use Edit has been denied.'),
      { type: 'result', permission_denials: [{ tool_name: '', tool_use_id: 'p1' }, { tool_name: 'Edit', tool_use_id: 'p2' }, { tool_name: '', tool_use_id: 'ghost' }, { tool_use_id: '' }, null, { tool_name: 'X' }] },
    ] as never);
    expect(found.map((d) => [d.toolUseId, d.tool, d.rule, d.reason, d.source])).toEqual([
      ['p1', 'Bash', 'permission', null, 'permission-rules'],
      ['p2', 'Edit', 'permission', 'Permission to use Edit has been denied.', 'permission-rules'],
      ['ghost', 'unknown', 'permission', null, 'permission-rules'],
    ]);
  });

  it('a guard denial wins over the same call in the permission list', () => {
    const found = denialsFromTranscript([use('t', 'Edit', { file_path: 'a' }), res('t', 'Orbit policy (protected_path): no'), { type: 'result', permission_denials: [{ tool_name: 'Edit', tool_use_id: 't' }] }] as never);
    expect(found).toHaveLength(1);
    expect(found[0]?.source).toBe('guard-hook');
  });

  it('bounds and redacts long reasons and targets', () => {
    const long = 'x'.repeat(900);
    const [d] = denialsFromTranscript([use('t', 'Bash', { command: long }), res('t', `Orbit policy (r): ${long} sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEF`)] as never);
    expect(d?.reason?.endsWith('...')).toBe(true);
    expect(d?.reason?.length).toBe(503);
    expect(d?.reason).not.toContain('abcdefghijklmnopqrstuvwxyz');
    expect(d?.target?.length).toBe(303);
    expect(denialTarget('short')).toBe('short');
  });
});
