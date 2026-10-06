// Types for srt-chromium-preload.mjs, which stays plain JavaScript because node loads it with --import before srt.
export declare const REFUSAL_EXIT_CODE: 97;
export declare const REFUSAL_FILE: 'chromium-preload-refused';
export declare const CHROMIUM_RULES: readonly string[];
export declare const NIS_DOMAINNAME_RULES: readonly string[];
export declare const RULE_SETS: Readonly<Record<'chromium' | 'nis-domainname', readonly string[]>>;
export declare function rulesFor(url: string): string[];
export declare function patchSandboxExecCommand(command: unknown, rules?: readonly string[]): string;
export declare function installSandboxExecHook(
  cp: Record<string, (...args: never[]) => unknown>,
  proc: { on(event: 'exit', listener: () => void): unknown; exit(code: number): unknown; stderr: { write(text: string): unknown }; exitCode?: number | undefined },
  sync: () => void,
  record?: (why: string) => void,
  rules?: readonly string[],
): void;
export declare function refusalRecorder(argv: unknown): (why: string) => void;
