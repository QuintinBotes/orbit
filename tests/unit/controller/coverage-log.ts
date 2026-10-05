import { createLogger, type Logger } from '../../../src/core/log.ts';

export interface CapturedLog {
  logger: Logger;
  lines: () => { level: string; msg: string; [k: string]: unknown }[];
}

/** A logger that keeps what it writes, so a test can assert what was reported. */
export function capturingLogger(): CapturedLog {
  const out: string[] = [];
  const logger = createLogger({ level: 'debug', sink: (l) => out.push(l) });
  return { logger, lines: () => out.map((l) => JSON.parse(l) as { level: string; msg: string }) };
}
