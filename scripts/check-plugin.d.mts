// Types for check-plugin.mjs, a plain ESM script the plugin tests import.
export declare const SKILL_KEYS: ReadonlySet<string>;
export declare const AGENT_KEYS: ReadonlySet<string>;
export declare const PLUGIN_DIR: string;
export declare function frontmatter(text: string): unknown;
export declare function lint(pluginDir?: string): string[];
export declare function payloadProblems(pluginDir?: string, opts?: { srtVersion?: string }): string[];
