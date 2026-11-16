type Env = Readonly<Record<string, string | undefined>>;

/** Whether this is a CI run, which provides every capability the suite probes for (ps, Chromium, srt). */
export function onCi(env: Env = process.env): boolean {
  return Boolean(env.CI) && env.CI !== 'false' && env.CI !== '0';
}

/**
 * Skip the current test, saying why, when `reason` names a capability that is missing here; under CI fail it with that
 * reason instead, so a runner that lost the capability never passes by skipping.
 */
export function skipOrFailOnCi(ctx: { skip(condition: boolean, note?: string): void }, reason: string | null, env: Env = process.env): void {
  if (reason === null) return;
  if (onCi(env)) throw new Error(`${reason}; CI provides it, so this test fails instead of skipping`);
  ctx.skip(true, reason);
}

/** An availability probe as it is, except that under CI an unavailable one throws, failing the file with its reason. */
export function requiredOnCi<T extends { ok: boolean; detail: string }>(probe: T, env: Env = process.env): T {
  if (!probe.ok && onCi(env)) throw new Error(`${probe.detail}; CI provides it, so these tests fail instead of skipping`);
  return probe;
}
