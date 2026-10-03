/**
 * node:sqlite prints an ExperimentalWarning on Node 22. Users did not choose
 * that dependency, so the one warning is filtered; every other warning still
 * reaches stderr. Must run before node:sqlite is first loaded, which is why
 * storage/db.ts loads it lazily with require().
 */
let installed = false;

export function suppressSqliteExperimentalWarning(): void {
  if (installed) return;
  installed = true;
  const original = process.emitWarning.bind(process);
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message;
    const type = typeof rest[0] === 'string' ? rest[0] : (rest[0] as { type?: string } | undefined)?.type;
    const name = typeof warning === 'string' ? type : warning.name;
    if (name === 'ExperimentalWarning' && /SQLite/i.test(text)) return;
    (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as typeof process.emitWarning;
}
