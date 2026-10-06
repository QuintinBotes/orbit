import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The classification fixtures (ADR 0010) are the real output of real tools, captured on a real machine and then
// neutralised: the checkout is `/var/folders/acme/T/orbit-evidence-acme/checkout` or `/home/acme/checkout`, a process id
// is 4242 where one has to stay, and nothing that names the machine or the person who ran the tool stays at all. A
// capture that is added without that, a pid, a session GUID, a home directory or a user name, would publish it, so every
// file of those directories is read here and any such trace fails the test.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../../fixtures');

/** The directories of captured tool output. */
const CAPTURES = ['environment', 'misconfigured'];
/** A fixture that is an application, not a capture of output. */
const APPLICATIONS = ['ui-app'];

interface Rule {
  name: string;
  /** Every match of this is a trace of the machine or the person; `allowed` says which matches are neutral placeholders. */
  pattern: RegExp;
  allowed?: (match: string) => boolean;
}

// Lookarounds, not \b: VSTest writes `<pid>_<guid>`, and an underscore is a word character, so there is no boundary before the GUID.
const GUID = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;

const RULES: readonly Rule[] = [
  { name: 'a GUID (a session or correlation id of a real run)', pattern: GUID },
  { name: 'the session correlation id VSTest puts on a command line (a pid and a GUID)', pattern: /CorrelationId=\S+/g },
  // `acme` is the neutral user of the other fixtures: /home/acme/checkout, /home/acme/.npm/_logs.
  { name: 'a home directory of a real user', pattern: /\/Users\/|\/home\/(?!acme\/)|\\Users\\|\/root\//g },
  // `/var/folders/<two characters>/<hash>/T` is where macOS keeps a user's temporary files; `/private` precedes it in a real path.
  { name: 'the temporary directory of a real machine', pattern: /\/var\/folders\/(?!acme\/T\/)/g },
  // Seatbelt logs `Sandbox: dotnet(4242) deny(1) ...`: the number between the parentheses is a pid, and 4242 is the neutral
  // one. The runner's note on a check it stopped names the MSBuild node as `(pid 4242)` (evidence/msbuild.ts).
  { name: 'a process id', pattern: /\b(?:pid|process id)\b(?! 4242\b)|\w\((?!4242\))\d+\) deny\(/gi },
  // xunit v3 prints the unique id of the assembly it runs, a hash of what the machine holds.
  { name: 'a long hexadecimal id (a hash of the capturing machine)', pattern: /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi, allowed: (m) => /^(.)\1*$/.test(m) },
];

/** What of `text` is a trace of a machine or a person, as `rule: match` lines with their line numbers. */
function traces(text: string): string[] {
  const found: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const rule of RULES) {
      for (const m of line.matchAll(rule.pattern)) {
        if (rule.allowed?.(m[0])) continue;
        found.push(`line ${i + 1}: ${rule.name}: ${m[0].slice(0, 60)}`);
      }
    }
  });
  return found;
}

/** Every file below `dir`, as paths relative to it. */
function filesOf(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesOf(join(dir, e.name), `${prefix}${e.name}/`) : e.isFile() ? [`${prefix}${e.name}`] : []))
    .sort();
}

describe('the classification fixtures carry nothing of the machine or the person that captured them', () => {
  it('knows every fixture directory: a new capture directory is scanned too', () => {
    const dirs = readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    expect(dirs, 'add a directory of captured output to CAPTURES, an application to APPLICATIONS').toEqual([...CAPTURES, ...APPLICATIONS].sort());
  });

  for (const dir of CAPTURES) {
    it(`${dir}: no pid, GUID, home directory, machine temp directory or user name in any file`, () => {
      const files = filesOf(join(root, dir));
      expect(files.length, `fixtures in ${dir}`).toBeGreaterThanOrEqual(10);
      const dirty: Record<string, string[]> = {};
      for (const file of files) {
        const found = traces(readFileSync(join(root, dir, file), 'utf8'));
        if (found.length > 0) dirty[`${dir}/${file}`] = found;
      }
      expect(dirty).toEqual({});
    });
  }

  it('reads a capture put in a subdirectory too: nothing is skipped without a failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orbit-fixtures-neutral-'));
    try {
      mkdirSync(join(dir, 'sub', 'deeper'), { recursive: true });
      writeFileSync(join(dir, 'a.log'), 'a\n');
      writeFileSync(join(dir, 'sub', 'b.log'), 'b\n');
      writeFileSync(join(dir, 'sub', 'deeper', 'c.log'), 'c\n');
      expect(filesOf(dir)).toEqual(['a.log', 'sub/b.log', 'sub/deeper/c.log']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does recognise what it is meant to catch, and lets the neutral placeholders through', () => {
    // A scan that finds nothing anywhere proves nothing: each trace it exists to catch, as a real capture would show it.
    // The values are made up: a real session id, pid or machine hash here would publish it under another path.
    const caught: [string, string][] = [
      ['GUID', '-property:VSTestSessionCorrelationId=1234_12345678-1234-4123-8123-123456789abc'],
      ['GUID', 'ID = 12345678-1234-4123-8123-123456789abc'],
      ['GUID', 'session_12345678-1234-4123-8123-123456789abc'],
      ['GUID', '4242_00000000-0000-0000-0000-000000000000'],
      ['correlation id', '-property:VSTestSessionCorrelationId=4242_x'],
      ['home directory', 'File "/Users/dev/work/acme/tests/test_config.py", line 6'],
      ['home directory', 'inifile: /home/dev/checkout/pytest.ini'],
      ['home directory', 'C:\\Users\\dev\\work\\Acme.csproj'],
      ['temporary directory', '/var/folders/zz/x1y2z3w4v5u6t7s8r9/T/orbit-evidence-x/checkout/Acme.csproj'],
      ['temporary directory', '/private/var/folders/zz/x1y2z3w4v5u6t7s8r9/T/x'],
      ['process id', 'Sandbox: dotnet(31337) deny(1) file-write-create /System/acme'],
      ['process id', 'child pid 1234 exited'],
      ['process id', 'note=the check sandbox denied MSBuild node (pid 31337) its named pipe'],
      ['hexadecimal id', `Finished:    Acme.Tests (ID = '${'ab'.repeat(32)}')`],
    ];
    for (const [what, text] of caught) expect(traces(text), `${what}: ${text}`).not.toEqual([]);

    const neutral = [
      '/home/acme/checkout/pytest.ini',
      'npm error A complete log of this run can be found in: /home/acme/.npm/_logs/2026-10-06T15_48_06_869Z-debug-0.log',
      '/var/folders/acme/T/orbit-evidence-acme/checkout/src/Acme/Acme.csproj : error NU1301: x',
      '/private/var/folders/acme/T/orbit-evidence-acme/checkout/test.mjs:1:72',
      'Sandbox: dotnet(4242) deny(1) file-write-create /System/acme',
      'note=the check sandbox denied MSBuild node (pid 4242) its named pipe /tmp/MSBuild4242',
      "Finished:    Acme.Tests (ID = '0000000000000000000000000000000000000000000000000000000000000000')",
      'Failed to restore /usr/local/share/dotnet/sdk/9.0.305/NuGet.targets(186,5)',
    ];
    for (const text of neutral) expect(traces(text), text).toEqual([]);
  });
});
