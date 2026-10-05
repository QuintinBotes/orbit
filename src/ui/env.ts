/**
 * The environment UI processes get. The application under test and the
 * browser run repository code, so they receive a short allowlist rather than
 * Orbit's own environment: no GH_TOKEN, no provider keys, no SSH agent. HOME
 * stays because the browser cache lives under it.
 */
const PASS_THROUGH = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'TMPDIR',
  'TERM',
  'PLAYWRIGHT_BROWSERS_PATH',
  'PLAYWRIGHT_SKIP_BROWSER_GC',
  'XDG_CACHE_HOME',
  'XDG_CONFIG_HOME',
];

export function safeBaseEnv(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of PASS_THROUGH) {
    const v = source[name];
    if (typeof v === 'string') out[name] = v;
  }
  return out;
}
