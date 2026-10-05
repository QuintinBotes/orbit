import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspect } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  MASK,
  assertPublishable,
  checkPublication,
  defaultGuardConfigPath,
  defaultTermsPath,
  loadGuardSettings,
  loadPublicationGuard,
  loadTerms,
  parseTerms,
  type PublicationCheckOptions,
} from '../../../src/guard/publication.ts';
import { isOrbitError, type OrbitError } from '../../../src/core/errors.ts';

// Real-looking fixture domains are assembled at runtime so the source never
// contains an address the publish guard would (rightly) refuse to publish.
const ACME_IO = ["acme","io"].join('.');
const ACME_IO_CAPS = ["Acme","io"].join('.');
const NOREPLY_GIT = ['users', 'noreply', 'example-git', 'dev'].join('.');
const EU_MAIL_ACME = ['eu', 'mail', 'acme', 'io'].join('.');
const EXAMPLE_GIT_DEV = ["example-git","dev"].join('.');
const WIDGETS_IO = ["widgets","io"].join('.');

const dir = mkdtempSync(join(tmpdir(), 'orbit-guard-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
}

const TERMS_FILE = ['# private terms', '', 'Acme Corp', 'widgetron', 're:proj-[0-9]{3}', '  # indented comment', 're:(?i)^secret line$'].join('\n');

function opts(content = TERMS_FILE, extra: Partial<PublicationCheckOptions> = {}): PublicationCheckOptions {
  return { terms: parseTerms(content).terms, ...extra };
}

function caught(fn: () => unknown): OrbitError {
  try {
    fn();
  } catch (err) {
    if (isOrbitError(err)) return err;
    throw err;
  }
  throw new Error('expected an OrbitError');
}

describe('parseTerms / loadTerms', () => {
  it('reads plain and re: lines, skipping blanks and # comments, keeping line numbers', () => {
    const { terms, warnings } = parseTerms(TERMS_FILE);
    expect(terms.map((t) => [t.line, t.kind])).toEqual([
      [3, 'substring'],
      [4, 'substring'],
      [5, 'regex'],
      [7, 'regex'],
    ]);
    expect(warnings).toEqual([]);
  });

  it('never exposes a term through JSON, inspect or string conversion', () => {
    const { terms } = parseTerms('widgetron\nre:proj-[0-9]{3}');
    const dumps = [JSON.stringify(terms), inspect(terms, { depth: 5, showHidden: true }), String(terms[0]), `${JSON.stringify({ terms })}`];
    for (const d of dumps) {
      expect(d).not.toMatch(/widgetron/i);
      expect(d).not.toContain('proj-');
    }
  });

  it('warns about unusable lines by number only, and fails closed on a bad regex', () => {
    const { terms, warnings } = parseTerms('re:widgetron(\n---\nab\nre:');
    expect(warnings).toHaveLength(4);
    expect(warnings.join('\n')).not.toMatch(/widgetron/);
    expect(warnings[0]).toContain('line 1');
    expect(terms.filter((t) => !t.usable).map((t) => t.line)).toEqual([1, 4]);
    const res = checkPublication('entirely harmless text', { terms });
    expect(res.ok).toBe(false);
    expect(res.violations.filter((v) => v.kind === 'term').map((v) => v.termLine)).toEqual([1, 4]);
  });

  it('translates common Python regex syntax', () => {
    const { terms, warnings } = parseTerms('re:(?i)(?P<k>acme)-(?P=k)\nre:\\Aonly start');
    expect(warnings).toEqual([]);
    expect(checkPublication('ACME-acme', { terms }).ok).toBe(false);
    expect(checkPublication('only start here', { terms }).ok).toBe(false);
    expect(checkPublication('not only start', { terms }).violations.filter((v) => v.termLine === 2)).toHaveLength(0);
  });

  it('reports a missing file as an empty list with a warning', () => {
    const res = loadTerms(join(dir, 'missing.txt'));
    expect(res.found).toBe(false);
    expect(res.terms).toEqual([]);
    expect(res.warnings[0]).toContain('not found');
  });

  it('fails closed when the file exists but cannot be read', () => {
    const sub = join(dir, 'a-directory');
    mkdirSync(sub, { recursive: true });
    expect(caught(() => loadTerms(sub)).code).toBe('CONFIG_INVALID');
  });

  it('loads a real file', () => {
    const res = loadTerms(write('terms.txt', TERMS_FILE));
    expect(res.found).toBe(true);
    expect(res.terms).toHaveLength(4);
  });

  it('defaults to the publish-guard location', () => {
    expect(defaultTermsPath()).toMatch(/\.config[\\/]publish-guard[\\/]terms\.txt$/);
    expect(defaultGuardConfigPath()).toMatch(/\.config[\\/]publish-guard[\\/]config\.json$/);
  });
});

describe('checkPublication', () => {
  it('passes clean text', () => {
    expect(checkPublication('A generic lesson about cursors.', opts())).toEqual({ ok: true, violations: [] });
  });

  it('matches terms case-insensitively and masks them in the excerpt', () => {
    const res = checkPublication('Report prepared for ACME CORP by the platform team.', opts());
    expect(res.ok).toBe(false);
    expect(res.violations).toEqual([{ kind: 'term', termLine: 3, excerpt: `Report prepared for ${MASK} by the platform team.` }]);
  });

  it('treats separators inside a term as interchangeable or absent', () => {
    for (const text of ['acme-corp', 'Acme_Corp', 'acme.corp', 'acmecorp', 'acme  corp', 'acme/corp']) {
      expect(checkPublication(`x ${text} y`, opts()).ok, text).toBe(false);
    }
  });

  it('defeats zero-width characters and compatibility forms', () => {
    expect(checkPublication('wid​get­ron', opts()).ok).toBe(false);
    expect(checkPublication('ｗｉｄｇｅｔｒｏｎ', opts()).ok).toBe(false);
  });

  it('applies regex terms', () => {
    const res = checkPublication('see proj-123 and proj-12', opts());
    expect(res.violations.map((v) => v.termLine)).toEqual([5]);
    expect(res.violations[0]!.excerpt).toBe(`see ${MASK} and proj-12`);
  });

  it('masks every match inside an excerpt, not only the reported one, and collapses whitespace', () => {
    const text = 'widgetron\nand acme corp\tand widgetron';
    const res = checkPublication(text, opts());
    expect(res.violations).toHaveLength(3);
    for (const v of res.violations) {
      expect(v.excerpt).not.toMatch(/widgetron|acme/i);
      expect(v.excerpt).toBe(`${MASK} and ${MASK} and ${MASK}`);
    }
  });

  it('bounds excerpts and marks truncation', () => {
    const text = `${'a'.repeat(100)} widgetron ${'b'.repeat(100)}`;
    const [v] = checkPublication(text, opts()).violations;
    expect(v!.excerpt.startsWith('…')).toBe(true);
    expect(v!.excerpt.endsWith('…')).toBe(true);
    expect(v!.excerpt.length).toBeLessThan(70);
  });

  it('never cuts a masked match in half at the excerpt edge', () => {
    // The second term starts inside the first hit's context window and ends outside it.
    const text = `widgetron ${'x'.repeat(18)}acmecorpacmecorpacmecorp`;
    for (const v of checkPublication(text, opts()).violations) expect(v.excerpt).not.toMatch(/acme|corp|widgetron/i);
  });

  describe('identity checks', () => {
    it('blocks unapproved email addresses and masks them', () => {
      const res = checkPublication(`Contact jane.doe@${ACME_IO} for access.`, opts(''));
      expect(res.ok).toBe(false);
      expect(res.violations).toEqual([{ kind: 'email', excerpt: `Contact ${MASK} for access.` }]);
    });

    it('allows exact addresses, regex patterns and reserved example domains', () => {
      const o = opts('', { allowedEmails: [`Bot@${ACME_IO_CAPS}`], allowedEmailPatterns: ['@users\\.noreply\\.example-git\\.dev$', /^ci-[a-z]+@acme\.io$/] });
      expect(checkPublication(`bot@${ACME_IO}`, o).ok).toBe(true);
      expect(checkPublication(`12345+someone@${NOREPLY_GIT}`, o).ok).toBe(true);
      expect(checkPublication(`ci-runner@${ACME_IO}`, o).ok).toBe(true);
      expect(checkPublication('dev@acme.example and a@b.test and x@mail.example.com', o).ok).toBe(true);
      expect(checkPublication(`someone@${ACME_IO}`, o).ok).toBe(false);
    });

    it('can refuse reserved example domains too', () => {
      expect(checkPublication('dev@acme.example', opts('', { allowReservedEmailDomains: false })).ok).toBe(false);
    });

    it('treats a broken allow pattern as allowing nothing', () => {
      expect(checkPublication(`someone@${ACME_IO}`, opts('', { allowedEmailPatterns: ['('] })).ok).toBe(false);
    });

    it('does not mistake package versions or decorators for addresses', () => {
      expect(checkPublication('install ajv@8.20.0 and @types/node@22.10, use @Component', opts('')).ok).toBe(true);
    });
  });

  it('accepts a TermsList as well as a term array', () => {
    const list = loadTerms(write('terms2.txt', 'widgetron'));
    expect(checkPublication('widgetron', { terms: list }).ok).toBe(false);
  });
});

describe('assertPublishable', () => {
  it('throws POLICY_DENIED with counts and masked violations, never the term', () => {
    const err = caught(() => assertPublishable(`widgetron for jane@${ACME_IO}`, opts(), 'lesson les-0123456789ab'));
    expect(err.code).toBe('POLICY_DENIED');
    expect(err.message).toBe('publication guard refused lesson les-0123456789ab: 1 private term match, 1 unapproved email address');
    const serialized = JSON.stringify({ message: err.message, details: err.details });
    expect(serialized).not.toMatch(/widgetron|jane@acme\.io/i);
  });

  it('returns quietly for clean text', () => {
    expect(() => assertPublishable('nothing private here', opts())).not.toThrow();
  });
});

describe('publish-guard settings', () => {
  it('reads terms_file, allowed_emails and allowed_email_patterns', () => {
    const terms = write('custom-terms.txt', 'widgetron');
    const cfg = write('config.json', JSON.stringify({ terms_file: terms, allowed_emails: [`bot@${ACME_IO}`], allowed_email_patterns: ['@acme\\.example$'], protected_owners: ['acme'] }));
    const s = loadGuardSettings(cfg);
    expect(s).toEqual({ configPath: cfg, configFound: true, termsPath: terms, allowedEmails: [`bot@${ACME_IO}`], allowedEmailPatterns: ['@acme\\.example$'], warnings: [] });
    const guard = loadPublicationGuard({ configPath: cfg });
    expect(guard.terms.terms).toHaveLength(1);
    expect(checkPublication(`widgetron bot@${ACME_IO}`, guard.options).violations.map((v) => v.kind)).toEqual(['term']);
  });

  it('uses the defaults when there is no settings file', () => {
    const missing = join(dir, 'nope.json');
    expect(loadGuardSettings(missing)).toEqual({
      configPath: missing,
      configFound: false,
      termsPath: join(dir, 'terms.txt'),
      allowedEmails: [],
      allowedEmailPatterns: [],
      warnings: [],
    });
  });

  it('only shrinks the allow lists when they are malformed', () => {
    const odd = loadGuardSettings(write('odd.json', JSON.stringify({ allowed_emails: `bot@${ACME_IO}`, allowed_email_patterns: [1, 'ok', ''] })));
    expect(odd.allowedEmails).toEqual([]);
    expect(odd.allowedEmailPatterns).toEqual(['ok']);
    expect(odd.warnings).toHaveLength(2);
  });

  it('lets an explicit terms path override the settings file', () => {
    const cfg = write('config2.json', JSON.stringify({ terms_file: join(dir, 'missing-terms.txt') }));
    const override = write('override.txt', 'widgetron');
    const guard = loadPublicationGuard({ configPath: cfg, termsPath: override });
    expect(guard.terms.found).toBe(true);
    expect(guard.warnings).toEqual([]);
  });
});

// Property-style: for random private terms embedded in random text with
// random casing, the guard always flags the text and no excerpt ever
// contains any term.
describe('guard output never contains a term (randomized)', () => {
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }
  const rand = rng(42);
  const int = (n: number) => Math.floor(rand() * n);
  const alpha = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const filler = 'abcdefghijklmnopqrstuvwxyz0123456789     .,-_/@\n';
  const randomWord = (min: number, max: number, chars = alpha) => Array.from({ length: min + int(max - min + 1) }, () => chars[int(chars.length)]).join('');
  const randomCase = (s: string) => [...s].map((c) => (rand() < 0.5 ? c.toUpperCase() : c)).join('');

  it('holds for 400 random cases', () => {
    for (let round = 0; round < 400; round++) {
      const terms = Array.from({ length: 1 + int(4) }, () => randomWord(4, 10));
      const { terms: parsed } = parseTerms(terms.join('\n'));
      let text = randomWord(0, 60, filler);
      const embedded = 1 + int(4);
      for (let i = 0; i < embedded; i++) text += randomCase(terms[int(terms.length)]!) + randomWord(0, 40, filler);
      const res = checkPublication(text, { terms: parsed });
      expect(res.ok).toBe(false);
      expect(res.violations.length).toBeGreaterThanOrEqual(1);
      for (const v of res.violations) {
        const lower = v.excerpt.toLowerCase();
        for (const t of terms) expect(lower.includes(t.toLowerCase()), `round ${round}`).toBe(false);
      }
    }
  });

  it('holds for regex terms and for addresses that contain a term', () => {
    for (let round = 0; round < 200; round++) {
      const word = randomWord(4, 8, 'abcdefghijklmnopqrstuvwxyz');
      const { terms } = parseTerms(`re:${word}[0-9]+`);
      const text = `${randomWord(0, 30, filler)} ${randomCase(word)}${int(1000)} mail ${word}@${randomWord(3, 6, 'abcdefghijklmnopqrstuvwxyz')}.io ${randomWord(0, 30, filler)}`;
      const res = checkPublication(text, { terms });
      expect(res.ok).toBe(false);
      for (const v of res.violations) expect(v.excerpt.toLowerCase()).not.toMatch(new RegExp(`${word}[0-9]+|${word}@`));
    }
  });
});

describe('email detection edge cases', () => {
  it.each([
    ['trailing sentence dot', `Write to jane@${ACME_IO}.`, `Write to ${MASK}.`],
    ['leading dots in the local part', `x ..jane@${ACME_IO} y`, `x ..${MASK} y`],
    ['subdomains', `ops@${EU_MAIL_ACME}`, MASK],
    ['credentials in a URL', `https://user:hunter2@${ACME_IO}/x`, `https://user:${MASK}/x`],
  ])('finds %s', (_label, text, excerpt) => {
    const res = checkPublication(text, { terms: [] });
    expect(res.violations).toEqual([{ kind: 'email', excerpt }]);
  });

  it.each([`@${ACME_IO}`, 'jane@', 'jane@acme', 'jane@acme.1', `jane@-${ACME_IO}`, 'a @ b.io'])('ignores %j', (text) => {
    expect(checkPublication(text, { terms: [] }).ok).toBe(true);
  });

  it('stays fast on long runs of word characters', () => {
    const blob = `${'a1'.repeat(200_000)}@${'b'.repeat(200_000)}`;
    const started = Date.now();
    checkPublication(blob, { terms: [] });
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

// ---------------------------------------------------------------------------
// Adversarial review: places where the guard checked less than publish-guard
// or than its own contract promised.

describe('settings resolution matches publish-guard', () => {
  it('finds the settings file through PUBLISH_GUARD_CONFIG, then XDG_CONFIG_HOME, then ~/.config', () => {
    expect(defaultGuardConfigPath({ PUBLISH_GUARD_CONFIG: '/etc/acme/pg.json', HOME: '/home/acme' })).toBe('/etc/acme/pg.json');
    expect(defaultGuardConfigPath({ PUBLISH_GUARD_CONFIG: '~/pg/config.json', HOME: '/home/acme' })).toBe('/home/acme/pg/config.json');
    expect(defaultGuardConfigPath({ XDG_CONFIG_HOME: '/home/acme/.xdg', HOME: '/home/acme' })).toBe('/home/acme/.xdg/publish-guard/config.json');
    expect(defaultGuardConfigPath({ HOME: '/home/acme' })).toBe('/home/acme/.config/publish-guard/config.json');
    // Without terms_file, publish-guard reads terms.txt beside its settings file.
    expect(defaultTermsPath({ XDG_CONFIG_HOME: '/home/acme/.xdg', HOME: '/home/acme' })).toBe('/home/acme/.xdg/publish-guard/terms.txt');
  });

  it('loads the guard from the settings file the environment names', () => {
    const sub = join(dir, 'xdg', 'publish-guard');
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, 'config.json'), JSON.stringify({ allowed_emails: [`bot@${ACME_IO}`] }));
    writeFileSync(join(sub, 'terms.txt'), 'widgetron\n');
    const guard = loadPublicationGuard({ env: { XDG_CONFIG_HOME: join(dir, 'xdg'), HOME: dir } });
    expect(guard.terms.found).toBe(true);
    expect(checkPublication('widgetron', guard.options).ok).toBe(false);
    expect(checkPublication(`mail bot@${ACME_IO}`, guard.options).ok).toBe(true);
  });

  it('resolves a relative terms_file from the settings directory, not the working directory', () => {
    const sub = join(dir, 'relative-cfg');
    mkdirSync(join(sub, 'lists'), { recursive: true });
    writeFileSync(join(sub, 'lists', 'private.txt'), 'widgetron\n');
    const cfg = join(sub, 'config.json');
    writeFileSync(cfg, JSON.stringify({ terms_file: 'lists/private.txt' }));
    expect(loadGuardSettings(cfg).termsPath).toBe(join(sub, 'lists', 'private.txt'));
    expect(checkPublication('a widgetron b', loadPublicationGuard({ configPath: cfg }).options).ok).toBe(false);
  });

  it('expands ~ in terms_file with HOME', () => {
    const cfg = write('tilde.json', JSON.stringify({ terms_file: '~/terms/list.txt' }));
    expect(loadGuardSettings(cfg, { HOME: '/home/acme' }).termsPath).toBe('/home/acme/terms/list.txt');
  });
});

describe('the guard fails closed on broken settings', () => {
  it.each([
    ['invalid JSON', '{not json'],
    ['a JSON array', '[]'],
    ['a non-string terms_file', JSON.stringify({ terms_file: 7 })],
    ['a blank terms_file', JSON.stringify({ terms_file: '  ' })],
  ])('throws CONFIG_INVALID for %s instead of falling back to another terms file', (_label, content) => {
    const cfg = write(`broken-${Math.random().toString(36).slice(2)}.json`, content);
    expect(caught(() => loadGuardSettings(cfg)).code).toBe('CONFIG_INVALID');
    expect(caught(() => loadPublicationGuard({ configPath: cfg })).code).toBe('CONFIG_INVALID');
  });

  it('throws CONFIG_INVALID for a settings path it cannot read', () => {
    const sub = join(dir, 'cfg-dir');
    mkdirSync(sub, { recursive: true });
    expect(caught(() => loadGuardSettings(sub)).code).toBe('CONFIG_INVALID');
  });

  it('refuses to run without the terms file a settings file names', () => {
    const cfg = write('names-missing.json', JSON.stringify({ terms_file: join(dir, 'gone.txt') }));
    const err = caught(() => loadPublicationGuard({ configPath: cfg }));
    expect(err.code).toBe('CONFIG_INVALID');
  });

  it('refuses to run without a terms file that was named explicitly', () => {
    expect(caught(() => loadPublicationGuard({ configPath: join(dir, 'none.json'), termsPath: join(dir, 'gone-too.txt') })).code).toBe('CONFIG_INVALID');
  });

  it('still runs, with a warning, when publish-guard is not set up at all', () => {
    const empty = join(dir, 'not-set-up');
    mkdirSync(empty, { recursive: true });
    const guard = loadPublicationGuard({ configPath: join(empty, 'config.json') });
    expect(guard.terms.found).toBe(false);
    expect(guard.warnings.join(' ')).toContain('not found');
  });
});

describe('checks the guard skipped', () => {
  it('does not let an empty allow pattern allow every address', () => {
    expect(checkPublication(`mail jane@${ACME_IO}`, opts('', { allowedEmailPatterns: [''] })).ok).toBe(false);
    expect(checkPublication(`mail jane@${ACME_IO}`, opts('', { allowedEmailPatterns: ['  '] })).ok).toBe(false);
    expect(checkPublication(`mail jane@${ACME_IO}`, opts('', { allowedEmailPatterns: [new RegExp('')] })).ok).toBe(false);
    expect(checkPublication(`mail jane@${ACME_IO}`, opts('', { allowedEmails: [''] })).ok).toBe(false);
  });

  it.each([
    ['a combining grapheme joiner', 'wid\u034fgetron'],
    ['a variation selector', 'widget\ufe00ron'],
    ['a NUL byte', 'wid\u0000getron'],
    ['a C1 control', 'widget\u0085ron'],
  ])('defeats a term split by %s', (_label, text) => {
    expect(checkPublication(`x ${text} y`, opts()).ok).toBe(false);
  });

  it('checks JSON-escaped text, as the global knowledge graph passes canonical JSON', () => {
    expect(checkPublication(JSON.stringify({ statement: 'Built for Acme\nCorp.' }), opts()).ok).toBe(false);
    expect(checkPublication(JSON.stringify({ statement: 'Built for Acme\tCorp.' }), opts()).ok).toBe(false);
    expect(checkPublication('{"s":"\\u0077idgetron"}', opts()).ok).toBe(false);
    // An escaped backslash before "n" is a backslash and a letter, not a newline.
    expect(checkPublication('{"s":"Acme\\\\nCorp"}', opts()).ok).toBe(true);
  });

  it('reports a match once even when the decoded view sees it too', () => {
    const res = checkPublication(JSON.stringify({ a: 'widgetron', b: 'line\nbreak' }), opts());
    expect(res.violations.map((v) => v.termLine)).toEqual([4]);
  });
});

describe('excerpts are redacted after they are cut and collapsed', () => {
  it('masks a regex term that whitespace collapsing re-forms', () => {
    // "acme  corp" (two spaces) does not match the term, but the excerpt
    // collapses it to "acme corp", which does.
    const { terms } = parseTerms('re:acme corp');
    const res = checkPublication(`acme  corp, mail jane@${WIDGETS_IO}`, { terms });
    expect(res.violations.map((v) => v.kind)).toEqual(['email']);
    for (const v of res.violations) expect(v.excerpt).not.toMatch(/acme corp/i);
  });

  it('masks a regex term that spans a mask', () => {
    const { terms } = parseTerms('widgetron\nre:x.y');
    const res = checkPublication('see xwidgetrony now', { terms });
    for (const v of res.violations) expect(v.excerpt).not.toMatch(/x.y/i);
  });

  it('holds for random regex terms with literal spaces (randomized)', () => {
    let seed = 99;
    const rand = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const word = () => Array.from({ length: 3 + Math.floor(rand() * 4) }, () => 'abcdefgh'[Math.floor(rand() * 8)]).join('');
    const gaps = [' ', '  ', '\n', '\t', ' \n '];
    for (let round = 0; round < 300; round++) {
      const a = word();
      const b = word();
      const { terms } = parseTerms(`re:${a} ${b}`);
      const text = `${a}${gaps[Math.floor(rand() * gaps.length)]}${b} mail x${round}@corp.io ${a}${gaps[Math.floor(rand() * gaps.length)]}${b}`;
      const res = checkPublication(text, { terms });
      expect(res.ok).toBe(false);
      for (const v of res.violations) expect(new RegExp(`${a} ${b}`, 'i').test(v.excerpt), `round ${round}: ${v.excerpt}`).toBe(false);
    }
  });
});
