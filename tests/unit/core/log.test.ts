import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { OrbitError } from '../../../src/core/errors.ts';
import { createLogger, isLogLevel, nullLogger } from '../../../src/core/log.ts';
import { createRedactor } from '../../../src/core/redact.ts';

const GH = `ghp_${'a1B2'.repeat(9)}`;
const redactor = createRedactor({ env: {} }).redact;

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'debug', base?: Record<string, unknown>) {
  const lines: string[] = [];
  const clock = new ManualClock(Date.UTC(2026, 9, 3, 9, 37, 5, 123));
  const log = createLogger({ level, clock, redactor, sink: (l) => lines.push(l), ...(base ? { base } : {}) });
  const records = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, lines, records, clock };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-log-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('writes one JSON object per line with ts, level, msg first and base fields', () => {
    const { log, lines, records } = capture('info', { component: 'controller' });
    log.info('lease acquired', { run_id: 'r1', ttl_ms: 30_000 });
    expect(lines).toHaveLength(1);
    expect(Object.keys(records()[0]!).slice(0, 3)).toEqual(['ts', 'level', 'msg']);
    expect(records()[0]).toEqual({ ts: '2026-10-03T09:37:05.123Z', level: 'info', msg: 'lease acquired', component: 'controller', run_id: 'r1', ttl_ms: 30_000 });
  });

  it('takes the timestamp from the injected clock', () => {
    const { log, records, clock } = capture();
    log.info('a');
    clock.advance(1_000);
    log.info('b');
    expect(records().map((r) => r.ts)).toEqual(['2026-10-03T09:37:05.123Z', '2026-10-03T09:37:06.123Z']);
  });

  it('filters by level', () => {
    const { log, records } = capture('warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');
    log.log('error', 'e2');
    expect(records().map((r) => r.level)).toEqual(['warn', 'error', 'error']);
    expect(log.isEnabled('info')).toBe(false);
    expect(log.isEnabled('error')).toBe(true);
  });

  it('redacts the message and every string field at any depth', () => {
    const { log, lines, records } = capture();
    log.info(`pushing with ${GH}`, { argv: ['git', 'push', `https://x:${GH}@github.com/acme/app`], nested: { deep: [{ note: `token=${GH}` }] }, password: 'hunter2' });
    expect(lines[0]).not.toContain(GH);
    expect(lines[0]).not.toContain('hunter2');
    const rec = records()[0]!;
    expect(rec.msg).toBe('pushing with [REDACTED:github-token]');
    expect(rec.argv).toEqual(['git', 'push', 'https://[REDACTED:url-credentials]@github.com/acme/app']);
    expect(rec.password).toBe('[REDACTED:password]');
  });

  it('uses the default redactor, which includes secret environment values', () => {
    process.env.ORBIT_LOG_TEST_TOKEN = 'value-from-env-123';
    try {
      const lines: string[] = [];
      createLogger({ sink: (l) => lines.push(l) }).info('got value-from-env-123');
      expect(lines[0]).toContain('[REDACTED:env:ORBIT_LOG_TEST_TOKEN]');
    } finally {
      delete process.env.ORBIT_LOG_TEST_TOKEN;
    }
  });

  it('child loggers add bound fields, nest, and do not leak them to the parent', () => {
    const { log, records } = capture('debug', { component: 'controller' });
    const run = log.child({ run_id: 'r1' });
    const worker = run.child({ worker_id: 'w1' });
    worker.info('spawned', { pid: 42 });
    run.info('step');
    log.info('tick');
    const [a, b, c] = records();
    expect(a).toMatchObject({ component: 'controller', run_id: 'r1', worker_id: 'w1', pid: 42 });
    expect(b).toMatchObject({ run_id: 'r1' });
    expect(b).not.toHaveProperty('worker_id');
    expect(c).not.toHaveProperty('run_id');
    expect(worker.level).toBe('debug');
  });

  it('per-call fields override bound ones, but never ts, level or msg', () => {
    const { log, records } = capture();
    log.child({ run_id: 'r1' }).info('m', { run_id: 'r2', level: 'error', msg: 'forged', ts: 'x' });
    expect(records()[0]).toMatchObject({ run_id: 'r2', level: 'info', msg: 'm', ts: '2026-10-03T09:37:05.123Z' });
  });

  it('serializes errors with code, details and cause, redacted', () => {
    const { log, records } = capture();
    const err = new OrbitError('AUTH_EXPIRED', `token ${GH} rejected`, { host: 'github.com' }, { cause: new Error('401') });
    log.error('push failed', { err });
    const e = records()[0]!.err as Record<string, unknown>;
    expect(e).toMatchObject({ name: 'OrbitError', message: 'token [REDACTED:github-token] rejected', code: 'AUTH_EXPIRED', details: { host: 'github.com' }, cause: { name: 'Error', message: '401' } });
    expect(String(e.stack)).not.toContain(GH);
  });

  it('renders values JSON handles badly: dates, maps, sets, bigints, buffers, functions, cycles, undefined', () => {
    const { log, records } = capture();
    const cyclic: Record<string, unknown> = { name: 'c' };
    cyclic.self = cyclic;
    log.info('m', {
      at: new Date(Date.UTC(2026, 0, 1)),
      map: new Map([['k', 'v']]),
      set: new Set([1, 2]),
      big: 12345678901234567890n,
      buf: Buffer.from('secret bytes'),
      fn: function named() {},
      cyclic,
      skip: undefined,
      nested: { list: [new Date(0)] },
    });
    const rec = records()[0]!;
    expect(rec.at).toBe('2026-01-01T00:00:00.000Z');
    expect(rec.map).toEqual({ k: 'v' });
    expect(rec.set).toEqual([1, 2]);
    expect(rec.big).toBe('12345678901234567890');
    expect(rec.buf).toBe('[Buffer 12 bytes]');
    expect(rec.fn).toBe('[Function named]');
    expect(rec.cyclic).toEqual({ name: 'c', self: '[Circular]' });
    expect(rec).not.toHaveProperty('skip');
    expect(rec.nested).toEqual({ list: ['1970-01-01T00:00:00.000Z'] });
  });

  it('appends to a file, creating parent directories', () => {
    const file = join(dir, 'runs', 'r1', 'logs', 'controller.jsonl');
    const log = createLogger({ file, level: 'info', redactor });
    log.info('one');
    log.warn('two', { password: 'x', masked: { token: '****' } });
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.map((l) => l.msg)).toEqual(['one', 'two']);
    expect(lines[1]!.password).toBe('[REDACTED:password]');
    expect(lines[1]!.masked).toEqual({ token: '****' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'runs', 'r1', 'logs')).mode & 0o777).toBe(0o700);
  });

  it('never throws when the file cannot be written, and recovers when it can', () => {
    const blocker = join(dir, 'not-a-dir');
    writeFileSync(blocker, '');
    const bad = createLogger({ file: join(blocker, 'x.jsonl'), redactor });
    expect(() => bad.error('lost')).not.toThrow();

    if (process.getuid?.() === 0) return; // root ignores directory modes
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    chmodSync(locked, 0o500);
    const file = join(locked, 'log.jsonl');
    const log = createLogger({ file, redactor });
    try {
      expect(() => log.info('dropped')).not.toThrow();
    } finally {
      chmodSync(locked, 0o700);
    }
    log.info('kept');
    expect(readFileSync(file, 'utf8')).toContain('"kept"');
  });

  it('never throws when a field throws during serialization', () => {
    const { log, records } = capture();
    const hostile = {
      get boom(): string {
        throw new Error('getter exploded');
      },
    };
    expect(() => log.info('m', { hostile })).not.toThrow();
    expect(records()[0]).toMatchObject({ msg: 'm', log_error: 'unserializable fields' });
  });

  it('never throws when stderr or the sink throws', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => {
      throw new Error('EPIPE');
    });
    const log = createLogger({ stderr: true, redactor, sink: () => {
      throw new Error('sink');
    } });
    expect(() => log.error('x')).not.toThrow();
  });

  it('writes to stderr when asked', () => {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    createLogger({ stderr: true, redactor }).info('to stderr');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]![0])).toMatch(/^\{"ts":.*"msg":"to stderr"\}\n$/);
  });

  it('defaults to info level', () => {
    const lines: string[] = [];
    const log = createLogger({ sink: (l) => lines.push(l), redactor });
    log.debug('hidden');
    log.info('shown');
    expect(lines).toHaveLength(1);
    expect(log.level).toBe('info');
  });
});

describe('nullLogger and isLogLevel', () => {
  it('nullLogger accepts everything and its children are null loggers', () => {
    expect(() => nullLogger.child({ a: 1 }).error('x', { y: 1 })).not.toThrow();
    expect(nullLogger.isEnabled('error')).toBe(false);
  });

  it('isLogLevel recognises exactly the four levels', () => {
    expect(['debug', 'info', 'warn', 'error'].every(isLogLevel)).toBe(true);
    expect(isLogLevel('trace')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
    expect(isLogLevel('toString')).toBe(false);
  });
});

describe('createLogger: adversarial review', () => {
  it('falls back to info for a level it does not know, instead of writing everything while isEnabled says nothing is', () => {
    const lines: string[] = [];
    const log = createLogger({ level: 'trace' as 'info', redactor, sink: (l) => lines.push(l) });
    log.debug('hidden');
    log.info('shown');
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(['shown']);
    expect(log.level).toBe('info');
    expect(log.isEnabled('info')).toBe(true);
    expect(log.isEnabled('debug')).toBe(false);
  });

  it('redacts secrets used as map or object keys', () => {
    const { log, lines } = capture();
    log.info('m', { byToken: new Map([[GH, 1]]), plain: { [GH]: 'x' } });
    expect(lines[0]).not.toContain(GH);
  });

  it('redacts numeric credentials, which YAML config parses from `password: 123456`', () => {
    const { log, records } = capture();
    log.info('m', { db: { password: 12345678 } });
    expect(records()[0]!.db).toEqual({ password: '[REDACTED:password]' });
  });
});
