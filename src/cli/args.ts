/**
 * Command-line parsing on node:util parseArgs, strict, so an unknown option
 * is an error rather than being silently ignored. Every failure becomes a
 * UsageError (exit code 2) that names the command's usage line.
 */
import { parseArgs } from 'node:util';
import { UsageError } from './exit.ts';

export interface OptionDef {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  /** One line for the help text. */
  description: string;
  /** Placeholder shown for string options, e.g. "path". */
  valueName?: string;
}

export type OptionSpec = Readonly<Record<string, OptionDef>>;

/** Accepted by every command. */
export const GLOBAL_OPTIONS: OptionSpec = {
  repo: { type: 'string', description: 'repository to operate on (default: the git repository containing the current directory)', valueName: 'dir' },
  json: { type: 'boolean', description: 'machine-readable output' },
  help: { type: 'boolean', short: 'h', description: 'show help for the command' },
};

export class Args {
  readonly values: Readonly<Record<string, string | boolean | (string | boolean)[] | undefined>>;
  readonly positionals: readonly string[];
  private readonly usage: string;

  constructor(values: Args['values'], positionals: readonly string[], usage: string) {
    this.values = values;
    this.positionals = positionals;
    this.usage = usage;
  }

  str(name: string): string | undefined {
    const v = this.values[name];
    return typeof v === 'string' ? v : undefined;
  }

  bool(name: string): boolean {
    return this.values[name] === true;
  }

  list(name: string): string[] {
    const v = this.values[name];
    if (v === undefined) return [];
    return (Array.isArray(v) ? v : [v]).filter((x): x is string => typeof x === 'string');
  }

  /** A non-negative integer option, or undefined when absent. */
  int(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (!/^\d+$/.test(v)) throw new UsageError(`--${name} must be a non-negative integer, got ${JSON.stringify(v)}`, this.usage);
    return Number(v);
  }

  /** A number option (decimals allowed), or undefined when absent. */
  num(name: string): number | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} must be a non-negative number, got ${JSON.stringify(v)}`, this.usage);
    return n;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[]): T | undefined {
    const v = this.str(name);
    if (v === undefined) return undefined;
    if (!(allowed as readonly string[]).includes(v)) throw new UsageError(`--${name} must be one of ${allowed.join(', ')}, got ${JSON.stringify(v)}`, this.usage);
    return v as T;
  }

  /** Exactly the number of positionals the command takes, or a usage error. */
  expect(min: number, max: number = min): readonly string[] {
    if (this.positionals.length < min || this.positionals.length > max) {
      throw new UsageError(min === max ? `expected ${min} argument(s), got ${this.positionals.length}` : `expected ${min} to ${max} arguments, got ${this.positionals.length}`, this.usage);
    }
    return this.positionals;
  }
}

export function parseCommand(argv: readonly string[], spec: OptionSpec | undefined, usage: string): Args {
  const merged = { ...GLOBAL_OPTIONS, ...(spec ?? {}) };
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {};
  for (const [name, d] of Object.entries(merged)) options[name] = { type: d.type, ...(d.short ? { short: d.short } : {}), ...(d.multiple ? { multiple: true } : {}) };
  try {
    const r = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    return new Args(r.values as Record<string, string | boolean | (string | boolean)[] | undefined>, r.positionals, usage);
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0]! : String(err);
    throw new UsageError(message, usage);
  }
}
