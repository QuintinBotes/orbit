// Types for check-release-versions.mjs, a plain ESM script the unit tests import.
export declare function parseTag(tag: string): { version: string; prerelease: boolean } | null;
export declare function checkReleaseVersions(tag: string, root?: string): string[];
