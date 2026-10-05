import { chmodSync, constants, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ManualClock } from '../../../src/core/clock.ts';
import { hashObject } from '../../../src/core/hash.ts';
import { redact, registeredRedactPatterns } from '../../../src/core/redact.ts';
import { parseConfig } from '../../../src/policy/config.ts';
import { applySnapshotRedaction, snapshotPolicy, verifySnapshot } from '../../../src/policy/snapshot.ts';

let dir: string;
const config = parseConfig('version: 1\nchecks:\n  lint: {command: [npm, run, lint]}\n');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orbit-snap-cov-'));
});
afterEach(() => {
  vi.doUnmock('node:fs');
  vi.resetModules();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function snap(): { path: string; hash: string; text: string } {
  const r = snapshotPolicy(config, { runId: 'orb-c', repoRoot: dir, runDir: join(dir, 'runs', 'orb-c'), clock: new ManualClock(1_700_000_000_000) });
  return { path: r.path, hash: r.hash, text: readFileSync(r.path, 'utf8') };
}

/** Write `body` as a read-only file the way a snapshot is written, so only its content differs. */
function plant(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, { mode: 0o444 });
  chmodSync(p, 0o444);
  return p;
}

const HASH = `sha256:${'0'.repeat(64)}`;

function expectTampered(fn: () => unknown, message: RegExp): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toMatchObject({ code: 'POLICY_TAMPERED' });
  expect((caught as Error).message).toMatch(message);
}

describe('verifySnapshot rejects malformed arguments and files', () => {
  it('a missing or malformed expected hash', () => {
    const { path } = snap();
    for (const bad of [undefined, '', 'sha256:abc', `md5:${'0'.repeat(64)}`, `sha256:${'G'.repeat(64)}`]) {
      expectTampered(() => verifySnapshot(path, bad as string), /expected policy hash is missing or malformed/);
    }
  });

  it('a missing, empty or NUL-containing path', () => {
    for (const bad of [undefined, '', 'a\0b', 42]) {
      expectTampered(() => verifySnapshot(bad as string, HASH), /policy path is missing or malformed/);
    }
  });

  it('a path that cannot be opened, naming the errno', () => {
    expectTampered(() => verifySnapshot(join(dir, 'absent.json'), HASH), /cannot be opened \(ENOENT\)/);
  });

  it('a directory in place of the file', () => {
    mkdirSync(join(dir, 'asdir'));
    expectTampered(() => verifySnapshot(join(dir, 'asdir'), HASH), /not a regular file/);
  });

  it('a snapshot owned by another user', () => {
    const { path, hash } = snap();
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    expectTampered(() => verifySnapshot(path, hash), /owned by another user/);
  });

  it('skips the owner check where the platform has no getuid', () => {
    const { path, hash } = snap();
    const real = process.getuid;
    (process as { getuid?: unknown }).getuid = undefined;
    try {
      expect(verifySnapshot(path, hash).run_id).toBe('orb-c');
    } finally {
      process.getuid = real;
    }
  });

  it('content that is not JSON, or JSON of the wrong shape', () => {
    expectTampered(() => verifySnapshot(plant('junk.json', '{not json'), HASH), /not valid JSON/);
    for (const body of ['5', 'null', '[]', '{}', '{"schema":"orbit.policy/2"}']) {
      expectTampered(() => verifySnapshot(plant(`shape-${Buffer.from(body).toString('hex')}.json`, body), HASH), /does not have the orbit\.policy\/1 shape/);
    }
    const valid = JSON.parse(snap().text) as Record<string, unknown>;
    for (const [field, value] of [
      ['run_id', 3],
      ['repo_root', null],
      ['config', null],
      ['config', 'x'],
      ['effective_protected_paths', {}],
      ['check_config_hashes', null],
      ['check_config_hashes', 'x'],
    ] as const) {
      const bad = JSON.stringify({ ...valid, [field]: value });
      expectTampered(() => verifySnapshot(plant(`bad-${field}-${String(value)}.json`, bad), HASH), /shape/);
    }
  });

  it('a key that would become a prototype, wherever it hides, before the hash is compared', () => {
    const valid = snap().text;
    const base = valid.trim().slice(0, -1);
    expectTampered(() => verifySnapshot(plant('p1.json', `${base},"__proto__":{"x":1}}`), HASH), /contains the key "__proto__"/);
    expectTampered(() => verifySnapshot(plant('p2.json', `${base},"extra":[1,{"constructor":1}]}`), HASH), /contains the key "extra\[1\]\.constructor"/);
    expectTampered(() => verifySnapshot(plant('p3.json', `${base},"extra":{"a":{"prototype":null}}}`), HASH), /contains the key "extra\.a\.prototype"/);
  });

  it('an edit the hash can see, reporting the actual hash', () => {
    const { text, hash } = snap();
    const edited = JSON.parse(text) as { run_id: string };
    edited.run_id = 'orb-other';
    const path = plant('edited.json', JSON.stringify(edited));
    let caught: { details?: { actual?: string } } | undefined;
    try {
      verifySnapshot(path, hash);
    } catch (e) {
      caught = e as typeof caught;
    }
    expect(caught?.details?.actual).toBe(hashObject(edited));
    expect(caught?.details?.actual).not.toBe(hash);
  });
});

describe('snapshotPolicy', () => {
  it('rejects a repository root that does not exist with NOT_FOUND', () => {
    expect(() => snapshotPolicy(config, { runId: 'r', repoRoot: join(dir, 'nope'), runDir: join(dir, 'run'), clock: new ManualClock() })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', details: { code: 'ENOENT' } }),
    );
  });
});

describe('verifySnapshot against an unreliable filesystem (injected fs)', () => {
  async function loadWith(patch: Record<string, unknown>): Promise<typeof import('../../../src/policy/snapshot.ts')> {
    vi.resetModules();
    vi.doMock('node:fs', async (orig) => ({ ...(await orig<typeof import('node:fs')>()), ...patch }));
    return import('../../../src/policy/snapshot.ts');
  }

  it('maps a read failure to POLICY_TAMPERED with the errno, or "error" when there is none', async () => {
    const { path, hash } = snap();
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    for (const [thrown, expected] of [
      [Object.assign(new Error('io'), { code: 'EIO' }), /cannot be read \(EIO\)/],
      ['plain', /cannot be read \(error\)/],
    ] as const) {
      const mod = await loadWith({
        readFileSync: (target: unknown, ...rest: unknown[]) => {
          if (typeof target === 'number') throw thrown;
          return (real.readFileSync as (...a: unknown[]) => unknown)(target, ...rest);
        },
      });
      expectTampered(() => mod.verifySnapshot(path, hash), expected);
    }
  });

  it('reports "error" when open fails without an errno', async () => {
    const { path, hash } = snap();
    const mod = await loadWith({
      openSync: () => {
        throw new Error('no code');
      },
    });
    expectTampered(() => mod.verifySnapshot(path, hash), /cannot be opened \(error\)/);
  });

  it('opens without O_NOFOLLOW where the platform lacks it and still verifies', async () => {
    const { path, hash } = snap();
    const open = vi.fn();
    const real = await vi.importActual<typeof import('node:fs')>('node:fs');
    const { O_NOFOLLOW: _dropped, ...rest } = constants as Record<string, number>;
    const mod = await loadWith({
      constants: rest,
      openSync: (p: string, flags: number) => {
        open(flags);
        return real.openSync(p, flags);
      },
    });
    expect(mod.verifySnapshot(path, hash).run_id).toBe('orb-c');
    expect(open).toHaveBeenCalledWith(constants.O_RDONLY);
  });
});

describe('applySnapshotRedaction', () => {
  it('registers only string patterns from retention.redact_patterns and ignores a missing or non-array value', () => {
    const before = registeredRedactPatterns().length;
    applySnapshotRedaction({ config: {} as never });
    applySnapshotRedaction({ config: { retention: {} } as never });
    applySnapshotRedaction({ config: { retention: { redact_patterns: 'not-an-array' } } as never });
    expect(registeredRedactPatterns()).toHaveLength(before);
    applySnapshotRedaction({ config: { retention: { redact_patterns: [7, null, 'ACME-[0-9]{6}'] } } as never });
    expect(registeredRedactPatterns()).toHaveLength(before + 1);
    expect(redact('ticket ACME-123456 filed')).not.toContain('ACME-123456');
  });
});
