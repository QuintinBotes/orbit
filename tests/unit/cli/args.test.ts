import { describe, expect, it } from 'vitest';
import { Args, GLOBAL_OPTIONS, parseCommand, type OptionSpec } from '../../../src/cli/args.ts';
import { UsageError } from '../../../src/cli/exit.ts';

const SPEC: OptionSpec = {
  goal: { type: 'string', description: 'the goal' },
  count: { type: 'string', description: 'a count' },
  detach: { type: 'boolean', short: 'd', description: 'detach' },
  tag: { type: 'string', multiple: true, description: 'tags' },
};
const USAGE = 'orbit demo [options]';

describe('parseCommand', () => {
  it('reads strings, booleans, short flags, repeated options and positionals', () => {
    const a = parseCommand(['one', '--goal', 'ship it', '-d', '--tag', 'a', '--tag=b', 'two'], SPEC, USAGE);
    expect(a.str('goal')).toBe('ship it');
    expect(a.bool('detach')).toBe(true);
    expect(a.bool('json')).toBe(false);
    expect(a.list('tag')).toEqual(['a', 'b']);
    expect(a.positionals).toEqual(['one', 'two']);
  });

  it('accepts the global options on every command', () => {
    const a = parseCommand(['--repo', '/tmp/x', '--json'], undefined, USAGE);
    expect(a.str('repo')).toBe('/tmp/x');
    expect(a.bool('json')).toBe(true);
    expect(Object.keys(GLOBAL_OPTIONS)).toEqual(['repo', 'json', 'help']);
  });

  it('rejects an unknown option with a usage error that carries the usage line', () => {
    try {
      parseCommand(['--nope'], SPEC, USAGE);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UsageError);
      expect((err as UsageError).usage).toBe(USAGE);
      expect((err as Error).message).toMatch(/nope/);
    }
  });

  it('rejects a string option with no value', () => {
    expect(() => parseCommand(['--goal'], SPEC, USAGE)).toThrow(UsageError);
  });

  it('keeps everything after -- as positionals', () => {
    const a = parseCommand(['--', '--goal', 'x'], SPEC, USAGE);
    expect(a.positionals).toEqual(['--goal', 'x']);
    expect(a.str('goal')).toBeUndefined();
  });

  it('validates numbers and enumerations when they are read', () => {
    const a = parseCommand(['--count', '12', '--goal', 'bogus'], SPEC, USAGE);
    expect(a.int('count')).toBe(12);
    expect(a.int('missing')).toBeUndefined();
    expect(() => a.oneOf('goal', ['a', 'b'] as const)).toThrow(/must be one of a, b/);
    expect(() => parseCommand(['--count', '1.5'], SPEC, USAGE).int('count')).toThrow(UsageError);
    expect(() => parseCommand(['--count', '-3'], SPEC, USAGE).int('count')).toThrow(UsageError);
    expect(parseCommand(['--count', '1.5'], SPEC, USAGE).num('count')).toBe(1.5);
  });

  it('checks how many positionals a command takes', () => {
    const a = new Args({}, ['x', 'y'], USAGE);
    expect(a.expect(2)).toEqual(['x', 'y']);
    expect(a.expect(1, 3)).toEqual(['x', 'y']);
    expect(() => a.expect(0)).toThrow(/expected 0 argument/);
    expect(() => a.expect(3, 4)).toThrow(/expected 3 to 4 arguments/);
  });
});
