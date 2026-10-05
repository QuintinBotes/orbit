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
      const base = min === max ? `expected ${min} argument(s), got ${this.positionals.length}` : `expected ${min} to ${max} arguments, got ${this.positionals.length}`;
      // Name what is missing (a run id, a question id) from the usage line, so the message is not just a count.
      const missing = this.positionals.length < min ? usagePositionals(this.usage).slice(this.positionals.length, min) : [];
      throw new UsageError(missing.length > 0 ? `${base} (missing: ${missing.join(' ')})` : base, this.usage);
    }
    return this.positionals;
  }
}

/** The command words of a usage line, "orbit models list" for "orbit models list [--json]". */
export function usageCommand(usage: string): string {
  const words: string[] = [];
  for (const w of usage.trim().split(/\s+/)) {
    if (/^[\[<-]/.test(w) || w === '|') break;
    words.push(w);
  }
  return words.join(' ');
}

/** The required positional placeholders of a usage line: "<run-id>" and "<question-id>" for "orbit decide <run-id> <question-id> ...". */
export function usagePositionals(usage: string): string[] {
  const head = usage.split(/\s+\[|\s--/)[0] ?? '';
  return head.match(/<[^>]+>/g) ?? [];
}

/** The parser's own messages are one long sentence with a stray quote; say the same thing plainly. */
function plainParseError(err: unknown, usage: string, names: readonly string[]): string {
  const raw = err instanceof Error ? err.message.split('\n')[0]! : String(err);
  const code = (err as { code?: string } | null)?.code;
  const option = /'(-{1,2}[^\s'<]+)/.exec(raw)?.[1];
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' && option) {
    const command = usageCommand(usage) || 'orbit';
    return `unknown option "${option}" for "${command}" (it accepts ${names.map((n) => `--${n}`).join(', ')})`;
  }
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' && option) {
    return /missing/i.test(raw) ? `option ${option} needs a value` : `option ${option} does not take a value`;
  }
  return raw;
}

export function parseCommand(argv: readonly string[], spec: OptionSpec | undefined, usage: string): Args {
  const merged = { ...GLOBAL_OPTIONS, ...(spec ?? {}) };
  const options: Record<string, { type: 'string' | 'boolean'; short?: string; multiple?: boolean }> = {};
  for (const [name, d] of Object.entries(merged)) options[name] = { type: d.type, ...(d.short ? { short: d.short } : {}), ...(d.multiple ? { multiple: true } : {}) };
  try {
    const r = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    return new Args(r.values as Record<string, string | boolean | (string | boolean)[] | undefined>, r.positionals, usage);
  } catch (err) {
    throw new UsageError(plainParseError(err, usage, Object.keys(options)), usage);
  }
}
