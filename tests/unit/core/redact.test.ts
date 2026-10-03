import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  createRedactor,
  envSecretValues,
  isSecretEnvName,
  isSecretFieldName,
  redact,
  redactForProvider,
  redactValue,
} from '../../../src/core/redact.ts';

// An empty environment keeps these tests independent of whatever secrets the
// machine running them happens to export.
const r = createRedactor({ env: {} });
const R = (s: string): string => r.redact(s);

// Test values are assembled at runtime so this file never contains anything a
// secret scanner would flag as a real credential.
const rep = (c: string, n: number): string => c.repeat(n);
const GH = `ghp_${rep('a1B2', 9)}`;
const ANTHROPIC = `sk-ant-api03-${rep('Ab3_', 20)}`;
const OPENAI_PROJ = `sk-proj-${rep('aB3-', 12)}`;
const OPENAI_LEGACY = `sk-${rep('a1B2c3', 8)}`;
const AWS_ID = `AKIA${'IOSFODNN7EXAMPLE'}`;
const AWS_SECRET = `${rep('wJalrXUtnF', 3)}EMI/K7MDEN`;
const JWT = `eyJhbGciOiJIUzI1NiJ9.${'eyJzdWIiOiIxMjM0NTY3ODkwIn0'}.${rep('dozjgNryP4', 4)}`;
const SLACK = `xoxb-${rep('1234', 4)}-${rep('abcd', 4)}`;

describe('redact: secret shapes', () => {
  const cases: [string, string, string][] = [
    ['anthropic-key', `key=${ANTHROPIC}`, `key=[REDACTED:anthropic-key]`],
    ['openai project key', `use ${OPENAI_PROJ} now`, 'use [REDACTED:openai-key] now'],
    ['openai legacy key', `"${OPENAI_LEGACY}"`, '"[REDACTED:openai-key]"'],
    ['github classic token', `remote ${GH}.`, 'remote [REDACTED:github-token].'],
    ['github oauth/user/server/refresh tokens', ['gho_', 'ghu_', 'ghs_', 'ghr_'].map((p) => `${p}${rep('Zz9', 12)}`).join(' '), Array(4).fill('[REDACTED:github-token]').join(' ')],
    ['github fine-grained token', `github_pat_11ABCDEFG0_${rep('xY7', 20)}`, '[REDACTED:github-token]'],
    ['aws access key id', `id ${AWS_ID} end`, 'id [REDACTED:aws-access-key] end'],
    ['aws temporary key id', `ASIA${rep('Q', 16)}`, '[REDACTED:aws-access-key]'],
    ['aws secret key by name', `aws_secret_access_key = ${AWS_SECRET}`, 'aws_secret_access_key = [REDACTED:aws-secret-key]'],
    ['aws secret key in JSON', `"SecretAccessKey": "${AWS_SECRET}"`, '"SecretAccessKey": "[REDACTED:aws-secret-key]"'],
    ['credentials file session token', `[default]\naws_session_token = IQoJb3JpZ2luX2VjE${rep('Ab+/', 10)}==\nregion = eu-west-1`, '[default]\naws_session_token = [REDACTED:token]\nregion = eu-west-1'],
    ['INI password with spaces', 'password = s3cr3t-Value!', 'password = [REDACTED:password]'],
    ['generated-looking key assigned to a name', `api_key = Zx81Qw67Er45Ty23Ui09Op`, 'api_key = [REDACTED:key]'],
    ['slack bot token', `token ${SLACK}`, 'token [REDACTED:slack-token]'],
    ['slack app token', `xapp-1-${rep('A1b2', 5)}`, '[REDACTED:slack-token]'],
    ['slack webhook', `post https://hooks.slack.com/services/T0000/B0000/${rep('X', 24)}`, 'post [REDACTED:slack-webhook]'],
    ['jwt', `cookie: session=${JWT};`, 'cookie: session=[REDACTED:jwt];'],
    ['url credentials', 'git clone https://user:hunter2@github.com/acme/app.git', 'git clone https://[REDACTED:url-credentials]@github.com/acme/app.git'],
    ['url credentials with @ in password', 'postgres://admin:p@ss@db.acme.test:5432/app', 'postgres://[REDACTED:url-credentials]@db.acme.test:5432/app'],
    ['password= assignment', 'export DB_PASSWORD=hunter22', 'export DB_PASSWORD=[REDACTED:password]'],
    ['secret= assignment', 'CLIENT_SECRET=abc123def', 'CLIENT_SECRET=[REDACTED:secret]'],
    ['token= in a query string', 'GET /cb?token=abc123&page=2', 'GET /cb?token=[REDACTED:token]&page=2'],
    ['--password= flag', 'mysql --password=s3cr3t -u root', 'mysql --password=[REDACTED:password] -u root'],
    ['quoted env assignment', 'API_KEY="abc def"', 'API_KEY="[REDACTED:key]"'],
    ['camelCase key', 'accessToken=zzz999', 'accessToken=[REDACTED:token]'],
    ['JSON field', '{"password":"hunter2","user":"bob"}', '{"password":"[REDACTED:password]","user":"bob"}'],
    ['JSON field with escaped quote', '{"token": "ab\\"cd"}', '{"token": "[REDACTED:token]"}'],
    ['quoted code literal', "const apiKey = 'abcdef123';", "const apiKey = '[REDACTED:key]';"],
    ['YAML value', 'db:\n  password: hunter2\n  user: app', 'db:\n  password: [REDACTED:password]\n  user: app'],
    ['bearer header', 'Authorization: Bearer abc.def-ghi', 'Authorization: Bearer [REDACTED:authorization]'],
    ['basic header', 'authorization: Basic dXNlcjpwYXNz', 'authorization: Basic [REDACTED:authorization]'],
    ['github-style token header', `Authorization: token ${GH}`, 'Authorization: token [REDACTED:github-token]'],
    ['bare bearer token', 'curl -H "Bearer abcdefghij0123456789"', 'curl -H "Bearer [REDACTED:bearer]"'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(R(input)).toBe(expected));
  }

  it('private key blocks, whole', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA1234567890abcdefABCDEF', 'abcdefABCDEF1234567890abcdef==', '-----END RSA PRIVATE KEY-----'].join('\n');
    expect(R(`before\n${pem}\nafter`)).toBe('before\n[REDACTED:private-key]\nafter');
    const openssh = pem.replace(/RSA /g, 'OPENSSH ');
    expect(R(openssh)).toBe('[REDACTED:private-key]');
    const pgp = '-----BEGIN PGP PRIVATE KEY BLOCK-----\n\nlQOYBGJ1234567890abcdef\n-----END PGP PRIVATE KEY BLOCK-----';
    expect(R(pgp)).toBe('[REDACTED:private-key]');
  });

  it('private key blocks cut off before their END line, including JSON-escaped ones', () => {
    const cut = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQC7\n';
    expect(R(`${cut}next log line (5)`)).toBe('[REDACTED:private-key]\nnext log line (5)');
    const escaped = '"key":"-----BEGIN EC PRIVATE KEY-----\\nMHcCAQEEIIrYSSNQFaA2Hwf1duRSxKtLYX5CB04f\\n"';
    expect(R(escaped)).toBe('"key":"[REDACTED:private-key]\\n"');
  });

  it('two blocks in a row are both removed, and public material is kept', () => {
    const one = '-----BEGIN PRIVATE KEY-----\nAAAABBBBCCCCDDDDEEEE\n-----END PRIVATE KEY-----';
    const pub = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE\n-----END PUBLIC KEY-----';
    expect(R(`${one}\n${pub}\n${one}`)).toBe(`[REDACTED:private-key]\n${pub}\n[REDACTED:private-key]`);
  });

  it('redacts several secrets in one text and is idempotent', () => {
    const text = `push with ${GH} then call ${ANTHROPIC} using password=hunter2 at https://u:p4ss@acme.test/x`;
    const once = R(text);
    expect(once).not.toContain(GH);
    expect(once).not.toContain(ANTHROPIC);
    expect(once).not.toContain('hunter2');
    expect(once).not.toContain('p4ss');
    expect(R(once)).toBe(once);
  });
});

describe('redact: exact values', () => {
  it('removes provided extra secrets wherever they appear, longest first, including URL-encoded', () => {
    const red = createRedactor({ env: {}, extraSecrets: ['tok/en+1', 'tok/en+12'] });
    expect(red.redact('a tok/en+12 b tok/en+1 c tok%2Fen%2B1')).toBe('a [REDACTED:secret] b [REDACTED:secret] c [REDACTED:secret]');
  });

  it('ignores extra secrets too short to be meaningful', () => {
    expect(createRedactor({ env: {}, extraSecrets: ['ab', ''] }).redact('ab cab')).toBe('ab cab');
  });

  it('the plain redact() accepts extra secrets too', () => {
    expect(redact('value: opaque-value-123', ['opaque-value-123'])).toBe('value: [REDACTED:secret]');
  });

  it('removes values of secret-named environment variables and names the variable', () => {
    const red = createRedactor({ env: { ACME_DEPLOY_TOKEN: 'q9w8e7r6t5y4', HOME: '/home/acme', PATH: '/usr/bin' } });
    expect(red.redact('auth with q9w8e7r6t5y4 from /home/acme')).toBe('auth with [REDACTED:env:ACME_DEPLOY_TOKEN] from /home/acme');
  });

  it('reads process.env by default, at call time', () => {
    const name = 'ORBIT_TEST_SECRET_KEY';
    process.env[name] = 'zx81-spectrum-48k';
    try {
      expect(redact('loaded zx81-spectrum-48k')).toBe(`loaded [REDACTED:env:${name}]`);
    } finally {
      delete process.env[name];
    }
    expect(redact('loaded zx81-spectrum-48k')).toBe('loaded zx81-spectrum-48k');
  });

  it('skips short, numeric and boolean env values that would redact ordinary words', () => {
    const values = envSecretValues({ MAX_TOKENS: '100000000', TOKENIZERS_PARALLELISM: 'false', API_KEY: 'short', GH_TOKEN: 'long-enough-value' });
    expect(values).toEqual([{ name: 'GH_TOKEN', value: 'long-enough-value' }]);
  });

  it('applies custom patterns from config', () => {
    const red = createRedactor({ env: {}, patterns: ['ACME-[0-9]{6}', /internal-[a-z]+/i] });
    expect(red.redact('ticket ACME-123456 on Internal-Wiki')).toBe('ticket [REDACTED:custom] on [REDACTED:custom]');
  });
});

describe('isSecretEnvName and isSecretFieldName', () => {
  it('recognises credential variable names', () => {
    for (const n of ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'AWS_SECRET_ACCESS_KEY', 'DB_PASSWORD', 'PGPASSWORD', 'GOOGLE_APPLICATION_CREDENTIALS', 'NPM_TOKEN', 'CODEX_API_KEY', 'APIKEY', 'my.secret.value']) {
      expect(isSecretEnvName(n), n).toBe(true);
    }
  });

  it('leaves ordinary variable names alone', () => {
    for (const n of ['PATH', 'HOME', 'SSH_AUTH_SOCK', 'KEYCHAIN_PATH', 'LANG', 'SHELL', 'TERM', 'MONKEYPATCH', 'NODE_OPTIONS']) {
      expect(isSecretEnvName(n), n).toBe(false);
    }
  });

  it('field names: credential fields yes, keys and counters no', () => {
    for (const n of ['password', 'apiKey', 'api_key', 'sessionToken', 'clientSecret', 'Authorization', 'privateKey', 'credentials']) expect(isSecretFieldName(n), n).toBe(true);
    for (const n of ['cacheKey', 'idempotencyKey', 'inputTokens', 'tokenCount', 'key', 'tokens', 'secretName']) expect(isSecretFieldName(n), n).toBe(false);
  });
});

describe('redact: no false redaction of ordinary code and text', () => {
  const unchanged: [string, string][] = [
    [
      'typescript using credentials as variables',
      [
        'export async function login(user: string, password: string): Promise<Token> {',
        '  const token = await fetchToken(user, password);',
        "  if (!token) throw new Error('no token');",
        '  const headers = { Authorization: `Bearer ${token}` };',
        '  headers.Authorization = "Bearer " + token;',
        '  return { token, expiresAt: Date.now() + ttl };',
        '}',
        'interface Config {',
        '  apiKey: string;',
        '  secret?: string;',
        '  token: process.env.TOKEN,',
        '}',
        'const tokenize = (s: string) => s.split(/\\s+/);',
        'if (password.length < 8 || token === undefined || secret == null) return;',
        'const passwordHint = "Enter your password";',
        "const env = { TOKEN: process.env.GH_TOKEN ?? '' };",
      ].join('\n'),
    ],
    ['python keyword arguments passing variables', 'client = connect(user=user, password=password, token=self.token, api_key=settings.API_KEY)'],
    ['python type hints', 'class Creds:\n    password: str\n    token: Optional[str] = None'],
    ['python module-level assignments of variables and calls', 'token = default_token\napi_key = settings.API_KEY\nsecret = load_secret()\npassword = None\ntoken = tokens[0]'],
    ['calls and comparisons', 'token=getToken(); ok = password==expected; f = (token)=>token; let secret = await vault.read()'],
    ['placeholders', 'export GITHUB_TOKEN=${GITHUB_TOKEN}\npassword: "${DB_PASSWORD}"\nAPI_KEY=$API_KEY\ntoken: {{ secrets.TOKEN }}\nsecret=<your-secret>\nPASSWORD=****'],
    ['git output', 'commit 3f786850e387550fdab836ed7e6dc881de23001b\nAuthor: Dev Example\n\n    fix: rotate token handling (#123)'],
    ['hashes and ids', 'tree sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855 orb-20261003-093705-a1b2c3 dec-0123456789ab'],
    ['css and package names', '.sk-spinner-fading-circle { color: red } scikit-learn task-runner-with-a-long-name-1'],
    ['prose about secrets', 'Bearer authentication is used. The token expired; rotate the secret and update the password policy.'],
    ['urls without credentials', 'see https://acme.test/docs?page=2 and git@github.com:acme/app.git and ssh://git@github.com/acme/app'],
    ['shell env dump of ordinary values', 'PWD=/repo\nOLDPWD=/\nSSH_AUTH_SOCK=/tmp/agent.sock\nTOKENIZERS_PARALLELISM=false'],
    ['yaml with block scalar and anchors', 'secret: |\n  multi\npassword: *default_password\nkey: value'],
    ['short jwt-like and key-like words', 'eyJ is a prefix; sk-short; ghp_short; AKIA1234'],
  ];
  for (const [name, text] of unchanged) {
    it(name, () => expect(R(text)).toBe(text));
  }
});

describe('redactForProvider', () => {
  it('replaces the home directory and other user homes with ~ after redacting', () => {
    const home = homedir();
    const text = `open ${home}/repo/a.ts and /Users/someone/x and /home/bob/.ssh/id with password=hunter22`;
    expect(redactForProvider(text)).toBe('open ~/repo/a.ts and ~/x and ~/.ssh/id with password=[REDACTED:password]');
  });

  it('does not touch lookalike paths', () => {
    expect(r.forProvider('/Users/Shared/data https://acme.test/home/page /var/home-ish')).toBe('/Users/Shared/data https://acme.test/home/page /var/home-ish');
  });

  it('replaces a bare home path and one followed by punctuation', () => {
    const home = homedir();
    expect(r.forProvider(`"${home}" (${home}), ${home}`)).toBe('"~" (~), ~');
  });
});

describe('redactValue', () => {
  it('redacts strings at any depth and wholesale under credential-named fields', () => {
    const out = redactValue(
      { msg: `token ${GH}`, nested: [{ password: 'hunter2', count: 3 }], credentials: { user: 'u', pass: 'p' }, inputTokens: 12, apiKey: '' },
      R,
    );
    expect(out).toEqual({
      msg: 'token [REDACTED:github-token]',
      nested: [{ password: '[REDACTED:password]', count: 3 }],
      credentials: { user: '[REDACTED:credential]', pass: '[REDACTED:credential]' },
      inputTokens: 12,
      apiKey: '',
    });
  });

  it('copies instead of mutating, and marks cycles', () => {
    const input: Record<string, unknown> = { a: `x ${GH}` };
    input.self = input;
    const out = redactValue(input, R) as Record<string, unknown>;
    expect(input.a).toBe(`x ${GH}`);
    expect(out.a).toBe('x [REDACTED:github-token]');
    expect(out.self).toBe('[Circular]');
  });

  it('keeps shared (non-circular) references', () => {
    const shared = { v: 'plain' };
    expect(redactValue({ a: shared, b: shared }, R)).toEqual({ a: { v: 'plain' }, b: { v: 'plain' } });
  });
});

describe('redact: linear time on hostile input', () => {
  const hostile: [string, string][] = [
    ['jwt prefixes', 'eyJ'.repeat(300_000)],
    ['jwt segments without dots', `eyJ${'a'.repeat(1_000_000)}`],
    ['sk- prefixes', 'sk-'.repeat(300_000)],
    ['sk- without digits', `sk-${'a'.repeat(1_000_000)}`],
    ['repeated BEGIN without END', '-----BEGIN PRIVATE KEY-----\n'.repeat(40_000)],
    ['BEGIN, many fake ENDs', `-----BEGIN PRIVATE KEY-----\n${'-----END NOPE-----\n'.repeat(50_000)}`],
    ['schemes without hosts', 'a://'.repeat(250_000)],
    ['scheme and long userinfo', `https://${'u'.repeat(500_000)}:${'p'.repeat(500_000)}`],
    ['assignment keys', 'password='.repeat(100_000)],
    ['open quotes', 'password: "'.repeat(100_000)],
    ['long key prefix runs', `${'a_'.repeat(400_000)}password`],
    ['yaml lines', 'token: a b\n'.repeat(100_000)],
    ['authorization headers', 'Authorization: '.repeat(70_000)],
    ['bearer words', 'Bearer '.repeat(140_000)],
    ['plain megabyte', 'x'.repeat(1_000_000)],
  ];
  for (const [name, text] of hostile) {
    it(name, () => {
      const t0 = performance.now();
      R(text);
      expect(performance.now() - t0).toBeLessThan(1_500);
    });
  }
});

// Defects found in adversarial review. Each case leaked a credential (or part
// of one) before the fix.
describe('redact: adversarial review', () => {
  const cases: [string, string, string][] = [
    // A literal glued to brackets or separators was mistaken for a call, or cut short.
    ['env password containing a parenthesis', 'DB_PASSWORD=x8#Kd(2mQ', 'DB_PASSWORD=[REDACTED:password]'],
    ['exported password shaped like a call', 'export DB_PASSWORD=Kd8x(2mQ', 'export DB_PASSWORD=[REDACTED:password]'],
    ['password containing braces', 'PASSWORD=abc{def}', 'PASSWORD=[REDACTED:password]'],
    ['password containing a comma', 'DB_PASSWORD=p,ssw0rd', 'DB_PASSWORD=[REDACTED:password]'],
    ['password containing a semicolon', 'DB_PASSWORD=pa;ss next', 'DB_PASSWORD=[REDACTED:password] next'],
    ['a value longer than the pattern bound', `TOKEN=${'a1'.repeat(3000)}TAIL rest`, 'TOKEN=[REDACTED:token] rest'],
    ['an authorization header longer than the pattern bound', `Authorization: Bearer ${'b2'.repeat(3000)}TAIL rest`, 'Authorization: Bearer [REDACTED:authorization] rest'],
    // Common credential names that do not end in one of the original keywords.
    ['SECRET_KEY env', 'SECRET_KEY=django-insecure-abcdef1234567890', 'SECRET_KEY=[REDACTED:secret]'],
    ['SECRET_KEY in source', "SECRET_KEY = 'django-insecure-abcdef1234567890'", "SECRET_KEY = '[REDACTED:secret]'"],
    ['prefixed secret key', 'STRIPE_SECRET_KEY=sk_live_abcdefABCDEF1234567890', 'STRIPE_SECRET_KEY=[REDACTED:secret]'],
    ['secret_key JSON field', '"secret_key": "abcdefgh12345"', '"secret_key": "[REDACTED:secret]"'],
    ['encryption key', 'ENCRYPTION_KEY=0123456789abcdef0123456789abcdef', 'ENCRYPTION_KEY=[REDACTED:key]'],
    ['short PASS suffix', 'export DB_PASS=hunter2hunter2', 'export DB_PASS=[REDACTED:password]'],
    // Trailing comments hid the value from the line-oriented rules.
    ['YAML value with a trailing comment', 'db:\n  password: s3cr3t-Value  # production\n', 'db:\n  password: [REDACTED:password]  # production\n'],
    ['INI value with a trailing comment', 'password = s3cr3t-Value # prod', 'password = [REDACTED:password] # prod'],
    ['YAML value with trailing punctuation', 'password: s3cr3t-Value!,', 'password: [REDACTED:password],'],
    // Quoted literals are not shell expansions or YAML indicators.
    ['JSON value starting with $', '"password": "$ecretP4ss"', '"password": "[REDACTED:password]"'],
    ['JSON value starting with >', '"password": ">Xy7!abc"', '"password": "[REDACTED:password]"'],
    ['JSON value starting with =', '"password": "=Xy7!abc"', '"password": "[REDACTED:password]"'],
    ['single-quoted shell value starting with $', "PASSWORD='$ecretP4ss'", "PASSWORD='[REDACTED:password]'"],
    // URL userinfo shapes the pattern did not accept.
    ['URL with an empty user name', 'redis://:s3cr3tpass@redis.acme.test:6379', 'redis://[REDACTED:url-credentials]@redis.acme.test:6379'],
    ['URL with a long password', `https://u:${'p9'.repeat(200)}@acme.test/x`, 'https://[REDACTED:url-credentials]@acme.test/x'],
  ];
  for (const [name, input, expected] of cases) {
    it(name, () => expect(R(input)).toBe(expected));
  }

  const unchanged: [string, string][] = [
    ['calls, index expressions and keyword arguments still pass', 'token=getToken(); key=tokens[0]; f(password=password); g(token=self.token)'],
    ['a closing bracket or separator after a variable stays outside the redaction', 'connect(user=user, password=password)\ncall(token=tok, retries=3)'],
    ['shell expansion of an upper-case variable inside double quotes', 'PASSWORD="$DB_PASS"'],
    ['template placeholders in JSON', '"password": "${DB_PASSWORD}", "token": "${{ secrets.TOKEN }}", "api_key": "$API_KEY"'],
    ['words that merely contain "pass"', 'bypass=true compass=north'],
    ['YAML prose with a comment', 'password: see the vault entry # todo'],
  ];
  for (const [name, text] of unchanged) {
    it(`unchanged: ${name}`, () => expect(R(text)).toBe(text));
  }

  it('keeps punctuation that ends a sentence or a markdown link after a bare value', () => {
    expect(R('see [docs](https://acme.test/cb?token=abc-123). Then retry!')).toBe('see [docs](https://acme.test/cb?token=[REDACTED:token]). Then retry!');
  });

  it('keeps a query string readable: only the secret goes', () => {
    expect(R('GET /cb?token=abc123&page=2&secret=zzz999')).toBe('GET /cb?token=[REDACTED:token]&page=2&secret=[REDACTED:secret]');
  });

  it('keeps separators that end a value: closing brackets, commas and semicolons before whitespace', () => {
    expect(R('f(password="x", token=abc-123) and TOKEN=abc-123; next')).toBe('f(password="[REDACTED:password]", token=[REDACTED:token]) and TOKEN=[REDACTED:token]; next');
  });

  it('recognises PASS-suffixed and other credential names consistently in env and structured data', () => {
    expect(isSecretEnvName('DB_PASS')).toBe(true);
    expect(isSecretEnvName('SMTP_PASS')).toBe(true);
    expect(isSecretEnvName('COMPASS_DIR')).toBe(false);
    for (const n of ['secret_key_base', 'signingKey', 'encryption_key', 'dbPass', 'db_pass']) expect(isSecretFieldName(n), n).toBe(true);
    for (const n of ['bypass', 'compass', 'isBypass']) expect(isSecretFieldName(n), n).toBe(false);
  });

  it('redactValue: numbers under credential fields, literal $ values and secret-shaped keys are removed', () => {
    const out = redactValue({ password: 123456, pin: 1234, apiKey: '$ecretP4ss', db: { secret: 98765n }, [GH]: 'x', count: 3 }, R);
    expect(out).toEqual({ password: '[REDACTED:password]', pin: 1234, apiKey: '[REDACTED:key]', db: { secret: '[REDACTED:secret]' }, '[REDACTED:github-token]': 'x', count: 3 });
  });

  const hostile: [string, string][] = [
    ['glued values', 'password=a(b'.repeat(100_000)],
    ['calls with distant closers', `${'token=getToken('.repeat(60_000)}${')'.repeat(60_000)}`],
    ['query strings', 'token=a&'.repeat(150_000)],
    ['separators before whitespace', 'token=abc), '.repeat(100_000)],
    ['yaml comments', 'password: a # b\n'.repeat(100_000)],
    ['ini comments', 'password = a # b\n'.repeat(100_000)],
    ['empty userinfo', 'a://:'.repeat(200_000)],
    ['long password without host', `https://:${'p'.repeat(1_000_000)}`],
  ];
  for (const [name, text] of hostile) {
    it(`linear time: ${name}`, () => {
      const t0 = performance.now();
      R(text);
      expect(performance.now() - t0).toBeLessThan(1_500);
    });
  }
});
