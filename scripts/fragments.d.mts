// Types for fragments.mjs, a plain ESM script the unit tests import.
export declare const CHANGELOG_SECTIONS: string[];
export declare function checkFragments(root?: string): string[];
export declare function directEdits(changedFiles: string[], versionBumped: boolean): string[];
export declare function foldFragments(root: string, version: string, date: string): { changelog: number; traceability: number };
