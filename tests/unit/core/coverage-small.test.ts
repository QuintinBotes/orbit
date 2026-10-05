import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isOrbitError, isTransient, OrbitError } from '../../../src/core/errors.ts';
import { faultPoint, resetFaults } from '../../../src/core/faults.ts';
import { createLogger, isLogLevel, nullLogger, realClock } from '../../../src/core/log.ts';

describe('error classification', () => {
  it('isTransient is true only for PROVIDER_TRANSIENT OrbitErrors', () => {
    expect(isTransient(new OrbitError('PROVIDER_TRANSIENT', 'rate limited'))).toBe(true);
    expect(isTransient(new OrbitError('PROVIDER_UNAVAILABLE', 'down'))).toBe(false);
    expect(isTransient(new Error('PROVIDER_TRANSIENT'))).toBe(false);
    expect(isTransient({ code: 'PROVIDER_TRANSIENT' })).toBe(false);
    expect(isTransient(null)).toBe(false);
  });

  it('isOrbitError narrows by code and keeps details and cause', () => {
    const cause = new Error('root');
    const e = new OrbitError('NOT_FOUND', 'missing', { id: 7 }, { cause });
    expect(isOrbitError(e)).toBe(true);
    expect(isOrbitError(e, 'NOT_FOUND')).toBe(true);
    expect(isOrbitError(e, 'INTERNAL')).toBe(false);
    expect(e.details).toEqual({ id: 7 });
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('OrbitError');
  });
});

describe('faultPoint actions without a child process', () => {
  const saved = process.env.ORBIT_FAULTS;
  beforeEach(() => resetFaults());
  afterEach(() => {
    if (saved === undefined) delete process.env.ORBIT_FAULTS;
    else process.env.ORBIT_FAULTS = saved;
    resetFaults();
    vi.restoreAllMocks();
  });

  it('crash writes a diagnostic and exits 137', () => {
    process.env.ORBIT_FAULTS = 'p.crash=crash';
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${String(code)}`);
    }) as never);
    expect(() => faultPoint('p.crash')).toThrow('exit:137');
    expect(exit).toHaveBeenCalledWith(137);
    expect(String(write.mock.calls[0]![0])).toBe('orbit: fault injected at p.crash: crash\n');
  });

  it('hang blocks on Atomics.wait for an hour and then returns undefined', () => {
    process.env.ORBIT_FAULTS = 'p.hang=hang';
    const wait = vi.spyOn(Atomics, 'wait').mockImplementation(() => 'timed-out');
    expect(faultPoint('p.hang')).toBeUndefined();
    expect(wait).toHaveBeenCalledTimes(1);
    expect(wait.mock.calls[0]![3]).toBe(3_600_000);
  });

  it('throw raises and then stays quiet unless the point repeats', () => {
    process.env.ORBIT_FAULTS = 'once=throw,again=throw*';
    expect(() => faultPoint('once')).toThrow('fault injected at once');
    expect(faultPoint('once')).toBeUndefined();
    expect(() => faultPoint('again')).toThrow();
    expect(() => faultPoint('again')).toThrow();
  });

  it('ignores malformed entries, unknown actions and unnamed points; trims point names', () => {
    process.env.ORBIT_FAULTS = ',noequals,=throw,empty=,bogus=explode, spaced =lose-response,good=lose-response*';
    expect(faultPoint('noequals')).toBeUndefined();
    expect(faultPoint('empty')).toBeUndefined();
    expect(faultPoint('bogus')).toBeUndefined();
    expect(faultPoint('spaced')).toBe('lose-response');
    expect(faultPoint('good')).toBe('lose-response');
    expect(faultPoint('good')).toBe('lose-response');
    expect(faultPoint('unlisted')).toBeUndefined();
  });

  it('is inert when ORBIT_FAULTS is unset', () => {
    delete process.env.ORBIT_FAULTS;
    expect(faultPoint('anything')).toBeUndefined();
  });
});

describe('suppressSqliteExperimentalWarning', () => {
  const original = process.emitWarning;
  afterEach(() => {
    process.emitWarning = original;
    vi.resetModules();
  });

  async function install(): Promise<{ passed: unknown[][]; emit: typeof process.emitWarning; again: () => void }> {
    vi.resetModules();
    const passed: unknown[][] = [];
    process.emitWarning = ((...args: unknown[]) => {
      passed.push(args);
    }) as typeof process.emitWarning;
    const mod = await import('../../../src/core/warnings.ts');
    mod.suppressSqliteExperimentalWarning();
    return { passed, emit: process.emitWarning, again: () => mod.suppressSqliteExperimentalWarning() };
  }

  it('drops only the SQLite ExperimentalWarning, however it is described', async () => {
    const { passed, emit } = await install();
    emit('SQLite is an experimental feature', 'ExperimentalWarning');
    emit('SQLite is an experimental feature', { type: 'ExperimentalWarning' } as never);
    const err = new Error('sqlite is experimental');
    err.name = 'ExperimentalWarning';
    emit(err);
    expect(passed).toEqual([]);
  });

  it('forwards every other warning untouched', async () => {
    const { passed, emit } = await install();
    emit('SQLite is mentioned but this is a DeprecationWarning', 'DeprecationWarning');
    emit('fs.promises is experimental', 'ExperimentalWarning');
    emit('plain string without type');
    emit('opts without type', {} as never);
    emit('SQLite as an untyped string');
    const other = new Error('SQLite trouble');
    emit(other);
    expect(passed).toHaveLength(6);
    expect(passed[5]![0]).toBe(other);
    expect(passed[0]).toEqual(['SQLite is mentioned but this is a DeprecationWarning', 'DeprecationWarning']);
  });

  it('installs the filter once', async () => {
    const { emit, again } = await install();
    again();
    expect(process.emitWarning).toBe(emit);
  });
});

describe('logger edge cases', () => {
  it('nullLogger swallows every call and is its own child', () => {
    nullLogger.debug('a');
    nullLogger.info('b');
    nullLogger.warn('c');
    nullLogger.error('d');
    nullLogger.log('info', 'e');
    expect(nullLogger.isEnabled('error')).toBe(false);
    expect(nullLogger.child({ x: 1 })).toBe(nullLogger);
  });

  it('isLogLevel accepts the four levels only', () => {
    for (const l of ['debug', 'info', 'warn', 'error']) expect(isLogLevel(l)).toBe(true);
    for (const l of ['toString', 'fatal', 3, null, undefined]) expect(isLogLevel(l)).toBe(false);
  });

  it('log() falls back to info for an unknown level and honours the threshold', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), level: 'warn' });
    logger.log('verbose' as never, 'dropped');
    logger.log('error', 'kept');
    expect(lines.map((l) => JSON.parse(l).msg)).toEqual(['kept']);
    const info = createLogger({ sink: (l) => lines.push(l) });
    info.log('verbose' as never, 'as info');
    expect(JSON.parse(lines.at(-1)!)).toMatchObject({ level: 'info', msg: 'as info' });
  });

  it('falls back to the wall clock for the timestamp when the injected clock throws', () => {
    const lines: string[] = [];
    const logger = createLogger({
      sink: (l) => lines.push(l),
      clock: {
        now: () => {
          throw new Error('broken clock');
        },
        sleep: async () => {},
      },
    });
    logger.info('hello');
    const rec = JSON.parse(lines[0]!);
    expect(rec.msg).toBe('hello');
    expect(Math.abs(Date.parse(rec.ts) - Date.now())).toBeLessThan(5_000);
  });

  it('the default clock reads wall time and sleeps for the requested time', async () => {
    const before = Date.now();
    expect(Math.abs(realClock.now() - before)).toBeLessThan(1_000);
    await realClock.sleep(20);
    expect(Date.now() - before).toBeGreaterThanOrEqual(15);
  });

  it('uses the real clock by default', () => {
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l) }).info('now');
    expect(Math.abs(Date.parse(JSON.parse(lines[0]!).ts) - Date.now())).toBeLessThan(5_000);
  });

  it('renders functions, symbols, invalid dates, buffers, toJSON objects and deep nesting as plain data', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    let deep: Record<string, unknown> = { leaf: 'x' };
    for (let i = 0; i < 14; i++) deep = { n: deep };
    function named(): void {}
    logger.info('shapes', {
      fn: named,
      anon: (() => () => 1)(),
      sym: Symbol('tag'),
      badDate: new Date('nope'),
      okDate: new Date(Date.UTC(2026, 0, 2)),
      buf: Buffer.from('abc'),
      json: { toJSON: () => ({ viaToJson: true }) },
      deep,
      dropped: undefined,
      big: 10n,
      cleaned: { keep: 1, drop: undefined },
    });
    const rec = JSON.parse(lines[0]!);
    expect(rec.fn).toBe('[Function named]');
    expect(rec.anon).toBe('[Function anonymous]');
    expect(rec.sym).toBe('Symbol(tag)');
    expect(rec.badDate).toBe('Invalid Date');
    expect(rec.okDate).toBe('2026-01-02T00:00:00.000Z');
    expect(rec.buf).toBe('[Buffer 3 bytes]');
    expect(rec.json).toEqual({ viaToJson: true });
    expect(JSON.stringify(rec.deep)).toContain('[MaxDepth]');
    expect('dropped' in rec).toBe(false);
    expect(rec.big).toBe('10');
    expect(rec.cleaned).toEqual({ keep: 1 });
  });

  it('serializes Errors with code, details, cause and stack, and tolerates a missing stack', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const cause = new Error('inner');
    const err = new OrbitError('CONFIG_INVALID', 'outer', { path: 'a.b' }, { cause });
    const stackless = new Error('no stack');
    delete stackless.stack;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    logger.error('failed', { err, stackless, map: new Map([[1, 'one']]), set: new Set(['a']), circular });
    const rec = JSON.parse(lines[0]!);
    expect(rec.err).toMatchObject({ name: 'OrbitError', message: 'outer', code: 'CONFIG_INVALID', details: { path: 'a.b' }, cause: { message: 'inner' } });
    expect(typeof rec.err.stack).toBe('string');
    expect(rec.stackless).toEqual({ name: 'Error', message: 'no stack' });
    expect(rec.map).toEqual({ '1': 'one' });
    expect(rec.set).toEqual(['a']);
    expect(rec.circular).toEqual({ self: '[Circular]' });
  });

  it('keeps reserved field names from overriding ts, level and msg', () => {
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l), base: { app: 'orbit', level: 'x' } }).info('real', { msg: 'fake', ts: 'fake', extra: 1 });
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ msg: 'real', level: 'info', app: 'orbit', extra: 1 });
    expect(rec.ts).not.toBe('fake');
  });

  it('degrades to a minimal line when a field cannot be serialized', () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l) });
    const hostile = {
      get boom(): never {
        throw new Error('getter exploded');
      },
    };
    logger.warn('bad fields', { hostile });
    const rec = JSON.parse(lines[0]!);
    expect(rec).toMatchObject({ level: 'warn', msg: 'bad fields', log_error: 'unserializable fields' });
  });

  it('gives up silently when even the fallback line cannot be written', () => {
    const logger = createLogger({
      sink: () => {
        throw new Error('sink down');
      },
      redactor: () => {
        throw new Error('redactor down');
      },
    });
    expect(() => logger.info('x')).not.toThrow();
  });

  describe('destinations', () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'orbit-log-cov-'));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      vi.restoreAllMocks();
    });

    it('creates the log directory privately, appends, and survives a path that cannot be created', () => {
      const file = join(dir, 'nested', 'orbit.log');
      const logger = createLogger({ file });
      logger.info('one');
      logger.info('two');
      expect(readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).msg)).toEqual(['one', 'two']);
      expect(statSync(join(dir, 'nested')).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);

      const blocker = join(dir, 'blocker');
      writeFileSync(blocker, 'x');
      const lines: string[] = [];
      const broken = createLogger({ file: join(blocker, 'sub', 'orbit.log'), sink: (l) => lines.push(l) });
      expect(() => broken.info('still logs elsewhere')).not.toThrow();
      expect(lines).toHaveLength(1);
    });

    it('writes to stderr when asked and ignores a closed stderr', () => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      createLogger({ stderr: true }).info('to stderr');
      expect(JSON.parse(String(write.mock.calls[0]![0])).msg).toBe('to stderr');
      write.mockImplementation(() => {
        throw new Error('EPIPE');
      });
      expect(() => createLogger({ stderr: true }).info('closed')).not.toThrow();
    });
  });
});

describe('ids', () => {
  it('run ids carry a sortable UTC timestamp and a random suffix', async () => {
    const { newRunId } = await import('../../../src/core/ids.ts');
    const id = newRunId(Date.UTC(2026, 0, 2, 3, 4, 5));
    expect(id).toMatch(/^orb-20260102-030405-[0-9a-f]{6}$/);
    expect(newRunId(Date.UTC(2026, 0, 2, 3, 4, 5))).not.toBe(id);
    expect(newRunId(Date.UTC(2026, 0, 2, 3, 4, 6)) > id.slice(0, 19)).toBe(true);
    expect(newRunId()).toMatch(/^orb-\d{8}-\d{6}-[0-9a-f]{6}$/);
  });

  it('prefixed ids and owner ids are unique and name their origin', async () => {
    const { newId, newOwnerId } = await import('../../../src/core/ids.ts');
    expect(newId('chk')).toMatch(/^chk-[0-9a-f]{12}$/);
    expect(newId('chk')).not.toBe(newId('chk'));
    const owner = newOwnerId();
    expect(owner.split(':')).toHaveLength(3);
    expect(owner).toContain(`:${process.pid}:`);
    expect(owner).not.toBe(newOwnerId());
  });
});

describe('clocks', () => {
  it('the system clock reports wall time and sleeps for the requested time', async () => {
    const { systemClock, ManualClock } = await import('../../../src/core/clock.ts');
    const before = Date.now();
    expect(Math.abs(systemClock.now() - before)).toBeLessThan(1_000);
    await systemClock.sleep(20);
    expect(Date.now() - before).toBeGreaterThanOrEqual(15);
    const manual = new ManualClock(100);
    await manual.sleep(50);
    manual.advance(5);
    expect(manual.now()).toBe(155);
  });
});
