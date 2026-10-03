/**
 * Network destinations. The documented allowlist forms are:
 *
 *   example.com      exactly that host
 *   192.0.2.10       exactly that IPv4 address
 *   *.example.com    any subdomain at any depth (a.example.com, a.b.example.com),
 *                    but not example.com itself
 *
 * No scheme, port, path or bare `*`: a port-less allowlist keeps the guard's
 * check and the sandbox's egress list in the same shape, and a bare wildcard
 * would silently disable the control.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function isHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  if (IPV4.test(host)) return true;
  const labels = host.split('.');
  // A single label (localhost) is fine; numeric-only dotted strings that are not valid IPv4 are not.
  if (labels.every((l) => /^\d+$/.test(l))) return false;
  return labels.every((l) => LABEL.test(l));
}

/** Why an allowlist entry is unacceptable, or null. */
export function hostEntryProblem(entry: unknown): string | null {
  if (typeof entry !== 'string' || entry.length === 0) return 'must be a non-empty string';
  if (entry !== entry.toLowerCase()) return 'must be lower case';
  if (entry === '*') return "a bare '*' would allow every host; list hosts explicitly";
  if (/[/:@?#\s]/.test(entry)) return 'must be a host name only (no scheme, port, user or path)';
  if (entry.startsWith('*.')) {
    const rest = entry.slice(2);
    if (rest.includes('*')) return "only one leading '*.' is allowed";
    if (IPV4.test(rest)) return 'wildcards apply to domain names, not addresses';
    if (!rest.includes('.')) return "a wildcard needs a registrable domain after '*.' (for example '*.example.com')";
    return isHostname(rest) ? null : 'is not a valid host name';
  }
  if (entry.includes('*')) return "wildcards are only allowed as a leading '*.'";
  return isHostname(entry) ? null : 'is not a valid host name or IPv4 address';
}

/**
 * Canonical host for comparison, or null when it cannot be a host: lower
 * case, trailing dot removed, a numeric `:port` suffix dropped, IPv6 brackets
 * kept so an IPv6 literal can never match a name entry.
 */
export function normalizeHost(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  let h = raw.trim().toLowerCase();
  if (h.length === 0 || h.includes('\0')) return null;
  if (h.startsWith('[')) {
    const close = h.indexOf(']');
    if (close < 0) return null;
    const rest = h.slice(close + 1);
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null;
    return h.slice(0, close + 1);
  }
  const colon = h.lastIndexOf(':');
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(h.slice(colon + 1))) return null;
    h = h.slice(0, colon);
  }
  if (h.endsWith('.')) h = h.slice(0, -1);
  return isHostname(h) ? h : null;
}

/** True when `host` is covered by one of the allowlist entries. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = normalizeHost(host);
  if (h === null) return false;
  for (const entry of allowed) {
    if (entry === h) return true;
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(1);
      if (h.length > suffix.length && h.endsWith(suffix)) return true;
    }
  }
  return false;
}

/**
 * True when every host a narrower list could reach is reachable under the
 * broader one; used to keep a check's network_hosts inside the policy's.
 */
export function hostEntryCovered(entry: string, allowed: readonly string[]): boolean {
  if (allowed.includes(entry)) return true;
  if (entry.startsWith('*.')) {
    const suffix = entry.slice(1);
    return allowed.some((a) => a.startsWith('*.') && suffix.endsWith(a.slice(1)) && suffix.length > a.length - 1);
  }
  return hostAllowed(entry, allowed);
}
