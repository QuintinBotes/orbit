# 0010. Classifying a check that fails on the base revision: environment, misconfigured, missing target or pre-existing

Status: accepted (2026-10-06)

## Context

PREFLIGHT runs the mandatory checks on the base revision before anything is
changed (spec section 6). A check that already fails there is recorded as a
pre-existing failure, never blamed on the run, and becomes a question: should
that failure be accepted as a documented baseline exception? A person who
approves it (`orbit decide`, or a remote answer, ADR 0008) lets the run be green
while the check keeps failing with exactly that fingerprint. When the goal is to
make that check pass (the contract names it as the proof of a criterion), the
question is withdrawn instead: the failure is expected to flip (P18).

That rule assumes a failure on the base revision is a failure of the
repository's code. Two reports showed it is not always:

- Issue #10, retested. Three .NET checks died in the sandbox with
  `MSBUILD : error MSB1025: An internal failure occurred while running MSBuild.`
  and `System.Net.Sockets.SocketException (13): Permission denied`: MSBuild's
  worker node binds a named pipe, which .NET makes a Unix socket under `/tmp`,
  and the sandbox refused it (EACCES). PREFLIGHT said "preflight passed ...
  with 3 pre-existing failure(s)" and raised three baseline-exception
  questions. The first #10 fix recognised filesystem denials (EPERM, EROFS)
  only. Reproduced on macOS under Orbit's runner and `srt` 0.0.78: `dotnet
  test` of an xunit project that references two class libraries, packages
  restored beforehand, no `-m:1`, fails after about five minutes of MSBuild's
  node retries with ten such crashes
  (`tests/fixtures/environment/dotnet-test-msbuild-node-pipe-eacces.log`);
  the same check with `-m:1` passes in seconds.
- Issue #23. `dotnet build A.csproj B.csproj` is rejected by MSBuild with
  `MSBUILD : error MSB1008: Only one project can be specified.` and exit 1 in
  under a second. It was recorded as a pre-existing failure and offered as a
  baseline exception.

In both cases the check never tested the repository's code. Approving the
exception would let a run pass with a check that never ran; refusing it sends
the run into repair attempts that cannot help, because no change to the code
can fix a refused socket or a wrong command line. Both were reproduced end to
end with real failing commands (a stand-in `dotnet` that prints exactly what the
real one printed and exits as it did, in
`tests/integration/controller/base-failure-classification.test.ts`): both runs
went PREFLIGHT to CONTRACTING with their questions and spent their attempts
until EXHAUSTED.

## Decision

Every mandatory check that fails on the base revision is put in one of four
categories at PREFLIGHT, in this order:

1. **Misconfigured check (an argument error).** The tool the check's command
   runs rejected that command line itself: a switch or argument it does not
   know, more projects than it takes. No change to the repository makes such a
   command line right.
2. **Missing target.** The check's command names something the base revision
   does not have: a project, an npm script, a test file, a script of the
   repository, a dotnet or cargo command nothing provides yet. The goal may be
   to create it.
3. **Environment failure.** The sandbox or the host refused the check something
   before it ran anything of the repository, or it could not execute at all:
   the program it runs is not installed where it runs included.
4. **Pre-existing failure.** Everything else: a failure of the repository's
   code. Only this category is recorded as pre-existing.

A check in category 1 or 3 ends the run `BLOCKED` at PREFLIGHT, before any
model is asked anything, with no baseline-exception question. A check in
category 2 goes on to CONTRACTING and is settled there (below). The reason
names the checks, their classification, their first error line (and the line
that shows the cause, when that is a different one), their logs and the fix; a
misconfigured check also names the policy key that holds its command,
`checks.<id>.command`. Every sentence of a reason starts with a capital letter,
and checks that share a cause and its evidence lines are named once, before
that evidence, which follows once: three .NET checks with the same MSB1025
crash read "Checks build, test, format could not run on the base revision ...:
the sandbox or the operating system refused the tool a socket ...
("MSBUILD : error MSB1025: ...", "System.Net.Sockets.SocketException (13):
Permission denied"), output in .../build.log, .../test.log, .../format.log".

The decisions `baseline.check-misconfigured`, `baseline.missing-target` and
`baseline.environment-failure` carry each check with its classification and
evidence lines, and the outcome carries `misconfigured_checks` and
`environment_failures`. `orbit timeline` shows one line per decision, the
checks that share their first error line together, for example
`baseline.check-misconfigured: build classified as a misconfigured check
(checks.build.command), not a pre-existing failure: "MSBUILD : error MSB1008:
Only one project can be specified."`. The baseline report keeps each failure,
marked with its `classification` (and an environment failure with the
`signals` that showed it); a baseline that blocks is marked incomplete.

### A missing target and P18

A missing target is not a failure of the code, and it is not necessarily a
wrong command either: `dotnet build` in a repository with no project yet,
`npm run lint` before the script exists and `pytest tests/test_new.py` before
the file exists are what a goal that creates them is checked with. So PREFLIGHT
lets the run go on and asks the baseline-exception question as for any failure,
and CONTRACTING settles it against the contract
(`controller/steps/baseline-questions.ts`):

- the contract names the check as the proof of a criterion: the goal is to
  create what the command names, so the check is expected to flip. The
  question is withdrawn with a `baseline.expected-to-flip` decision
  (`missing_target: true`), and the check has to pass on the candidate;
- the contract does not: nothing in the run is expected to create it, so the
  check is misconfigured after all. The run ends `BLOCKED` at CONTRACTING with
  the same classification and evidence as a misconfigured check at PREFLIGHT,
  and says that the contract does not name the check. Its advice is its own
  (`missingTargetAdvice`), by cause, and not the generic frozen-policy advice
  or the fix of an argument error: when the goal is meant to create what the
  command names, say so in the goal of a new run, so that the contract names
  the check; when a tool that is not installed or restored yet provides it (a
  cargo plugin, a dotnet local tool), install or restore it and then start a new
  run; when the command
  is wrong, correct `checks.<id>.command` and start a new run. Every cause
  needs a new run, because CONTRACTING reads the baseline PREFLIGHT recorded: a
  resume reads the same failure and blocks again, so the advice does not offer
  `orbit resume --force`. Its question is withdrawn. It is still a
  frozen-policy block (the reason starts "Check X is misconfigured", and
  `finishRun` records the setting with the advice it was given instead of the
  generic one), so `orbit resume` refuses, exit 5. The refusal repeats that
  advice and the foreground run summary points to it, and neither sends a person
  to fix `.orbit/config.yaml`, which is the cause in only one of the three
  (`missingTargetChecks` tells this block from an argument error blocked at
  PREFLIGHT, whose cause is the command). The notification of a frozen-policy
  block names the report, not a resume. The row that keeps the reason cuts its
  evidence, never the advice at its end. The block comes before the
  contract is written and before any other check's question is settled against
  it: like a contract the intake gate rejects, it is not the run's.

A missing target is never accepted as a baseline exception, whoever approves it
and however: a check whose target does not exist tests nothing, and accepting
its failure would make a meaningless check green.

### Evidence for a misconfigured check or a missing target

`src/evidence/check-misconfigured.ts`, with `src/evidence/check-command.ts`.
All of:

- a usage-error signature from the table below: the tool's own words for a
  command line it rejected, each verified against the real tool;
- it comes from the check's own direct invocation of the tool. The command's
  program, after a leading env assignment (`CI=1 npm run lint`), `env` and its
  options, an npx-style runner (`npx`, `pnpm exec`, `yarn dlx`, `bunx`, `uvx`,
  `uv run`, `poetry run`, `pipenv run`, `pdm run`) or `python -m`, is the tool;
  and the command is one simple command, not a shell chain or pipeline (`&&`,
  `||`, `;`, `|`), a background job, a subshell, a substitution or a second
  line. A shell command (`shell: true`, or an argv that hands a script to `sh
  -c`) is read the same way, quotes and redirections resolved. For MSBuild the
  dotnet command must be one that hands its arguments to MSBuild (`build`,
  `test`, `pack`, `publish`, `restore`, `clean`, `msbuild`): `dotnet run
  --project build/Build.csproj` runs a program of the repository, which may
  print MSB1008 of its own. `npm test` whose script runs a missing `npm run
  lint`, a script that hands the same name to a nested npm (`"test": "cd client
  && npm test"` with no test script in `client`), and a chain such as `dotnet
  restore && npm test`, put the error in code of the repository, which a change
  may fix: they stay pre-existing failures;
- what the error names is what the command names: the script npm reports
  missing is the one the command runs (`npm run x`, `npm test`) and npm ran no
  script before it (npm prints a lifecycle banner, `> acme@1.0.0 test`, only
  for a script it found and ran, and looks for the command's own script before
  it runs a pre-script, so the command's own missing script never has one), the
  switch
  MSBuild rejects is one the command passes (not one from a response file of
  the repository, `Directory.Build.rsp`), the arguments pytest does not know are
  the command's (not the repository's `addopts`), the path pytest cannot find,
  the flag go rejects and the command go or cargo does not have are the
  command's;
- the check exited, with the exit code the tool gives that error where it has
  one, and with the usage line the tool always prints with it where the same
  words could come from another program;
- no sign that the repository's code was compiled or tested and failed.

| signature | kind | tool | the tool's line | also required |
|---|---|---|---|---|
| `msbuild-unknown-switch` | argument | dotnet (MSBuild command), msbuild | `MSBUILD : error MSB1001: Unknown switch.` | the switch is the command's |
| `msbuild-one-project` | argument | dotnet (MSBuild command), msbuild | `MSBUILD : error MSB1008: Only one project can be specified.` | the switch is the command's |
| `msbuild-ambiguous-project` | argument | dotnet (MSBuild command), msbuild | `MSBUILD : error MSB1011: Specify which project or solution file to use ...` | |
| `go-flag` | argument | go | `flag provided but not defined: -x` (or `flag needs an argument`, `invalid value ... for flag`) | exit 2, go's usage line, the flag is the command's |
| `go-unknown-command` | argument | go | `go x: unknown command` (`go mod: unknown command` for `go mod x`) | exit 2, the command's words |
| `pytest-unrecognized-arguments` | argument | pytest | `pytest: error: unrecognized arguments: --x` (also an option of a plugin that is not installed, `--cov` without pytest-cov, which the cause names) | exit 4, every argument the command's |
| `cargo-unexpected-argument` | argument | cargo | `error: unexpected argument '--x' found` | exit 1, `Usage: cargo`, the argument the command's |
| `msbuild-no-project` | missing target | dotnet (MSBuild command), msbuild | `MSBUILD : error MSB1003: Specify a project or solution file. ...` | |
| `msbuild-project-missing` | missing target | dotnet (MSBuild command), msbuild | `MSBUILD : error MSB1009: Project file does not exist.` | the project is the command's |
| `dotnet-no-such-command` | missing target | dotnet, with a first argument that is no dotnet command | `Could not execute because the specified command or file was not found.` | |
| `npm-missing-script` | missing target | npm | `npm error Missing script: "x"` (`npm ERR!` before npm 10) | `x` is the script the command runs, no lifecycle banner (`> ...`) in the output |
| `pytest-path-not-found` | missing target | pytest | `ERROR: file or directory not found: x` | exit 4, `x` the command's |
| `cargo-no-such-command` | missing target | cargo | `error: no such command: ...` (a misspelling, or a plugin or alias nothing provides yet) | exit 101, the command's subcommand |
| `script-not-found` | missing target | the shell, env | `sh: ./x: No such file or directory`, dash's `./x: not found`, zsh's `no such file or directory: ./x`, `env: ./x: ...` | exit 127, `./x` the command's program, a relative path |

Verified with the .NET 9.0.305 SDK, npm 11, pytest 8.4, go 1.27, cargo 1.98,
macOS `/bin/sh` and `env` (`tests/fixtures/misconfigured`, and
`tests/integration/evidence/check-misconfigured.int.test.ts`, which runs each
real tool as a check where it is installed, and runs a `npm test` whose script
runs a missing script, one whose script runs `npm test` in a package with no
test script, and a chain, which stay pre-existing). `MSB1025` is not
in the table: it is MSBuild crashing, not a command line it rejected.

### A program that is not installed: an environment failure

A program the check's own command runs that the shell or `env` cannot find
(exit 127), named by a bare name or an absolute path, is an environment
failure (`classifyProgramNotFound`, signal `program-not-found`), not a
misconfigured check. The same program spawned directly is already one: the
runner cannot start it (`start-failed`), and a check should not change category
because its command went through a shell or `srt`'s `env`. The usual cause and
fix are the environment's (the tool is not installed where the check runs, or
not on its PATH), so `orbit resume` runs the baseline again once it is
installed, without `--force`. The fix names `checks.<id>.command` too, for a
misspelled name, which needs a new run. A relative path is a script of the
repository: a missing target.

### Evidence for an environment failure

`src/evidence/environment-failure.ts` (`classifyNotExecuted`,
`classifyCouldNotRun`). The output must show no sign that the repository's code
was compiled or tested and failed: no compiler diagnostic (`error CS1002`,
`error[E0425]`, `file.c:3:1: error:`, `SyntaxError`), no failing test report
(TAP `not ok`, `FAIL`, `--- FAIL:`, `FAILED path::test`, `Failed!  - Failed: 1`,
`test result: FAILED`, `# fail 1`, `N failed` on one line, a count after its
word that ends there (`failed: 1`, `Failed: 1,`), an `AssertionError`, Python
unittest's `FAILED (errors=1)` and `ERROR: test_x (...)`, the line
Microsoft.Testing.Platform prints for each failing test (`failed WritesCache
(12ms)`) and xunit's (`Acme.Tests.CacheTests.WritesCache [FAIL]`)) and no error
count (`N errors`, MSBuild's `N Error(s)`). A denial next to any of those is the
code's failure. The .NET runners were captured with `dotnet run` of real test
projects: Microsoft.Testing.Platform's report (`failed X (12ms)`, then `Test
run summary: Failed!` with `  total: 2` and `  failed: 1` on their own lines,
from MSTest 3.6.4's and 4.4.1's runners, TUnit 1.72.16 and xunit v3 3.2.2 in
its platform mode) and xunit v3's own in-process runner (`[FAIL]`, `Total: 2, Errors: 0, Failed: 1, ...`),
each for a test that writes under `/System` (EPERM) or reads `/etc/sudoers`
(EACCES). A count must share a line with its word: `GetDomainName: -1` with
`Failed to restore` on the next line is no failed test, and matching across the
line break had read the platform's `total: 2` then `failed: 1` as a count only
by accident (a review found the platform's report unrecognised once the count
was held to one line). MSBuild's error count is the one exception: when every
error it counted is a NuGet restore error (`NUxxxx`, or the restore task's own
uncoded error from `NuGet.targets`) or its internal failure (`MSB1025`),
nothing of the repository was compiled, and the count is not read as a code
failure (a restore the network refused inside `dotnet build` used to stay a
pre-existing failure because of it). That holds for the base revision; on a
candidate it holds only when the same check's base-revision failure was an
environment failure, so a restore failure a change brings (a package it adds)
reads as the change's, as every count did before this decision. Then one of:

- the process was killed by a crash signal before it printed anything of its
  own, or the runner could not start it (unchanged);
- a denial on a filesystem call that names an absolute path outside the
  check's checkout and its own scratch directories: EPERM or "operation not
  permitted", EROFS or "read-only file system" (`filesystem-denied`,
  unchanged), and now EACCES or "permission denied" (and .NET's "Access to the
  path '...' is denied"), which covers a Unix socket the sandbox refuses when
  the tool names its path (`listen EACCES: permission denied /tmp/x.pipe`;
  `permission-denied`);
- a Seatbelt deny line, for a file operation only on such a path (unchanged);
- new: the sandbox's network proxy refusing a connection (`network-denied`).
  `srt`'s own refusal (`Connection blocked by network allowlist`,
  `X-Proxy-Error: blocked-by-allowlist`) or a client's report of the proxy's 403
  to the tunnel it asked for (`CONNECT tunnel failed, response 403` from curl,
  libcurl and git; `The proxy tunnel request to proxy '...' failed with status
  code '403'` from .NET's HttpClient, so NuGet: captured with the real NuGet
  through `srt`'s real proxy, `dotnet-build-nuget-proxy-403.log`). Under `srt`
  every proxy a check talks to is `srt`'s;
- new: NuGet's HTTP client failing to start in the sandbox
  (`nuget-http-denied`): on macOS under `srt` a check's restore fails before it
  reaches the network, with `error NU1301: The type initializer for
  'System.Net.CookieContainer' threw an exception` next to `GetDomainName: -1`
  (captured under Orbit's runner, `dotnet-build-nuget-cookiecontainer.log`);
- new: a permission denial on a socket (`SocketException (13): Permission
  denied` or `(1): Operation not permitted`, or a bind, listen or connect
  refused with EACCES or EPERM) inside the tool's own crash (`socket-denied`):
  MSBuild's internal failure `MSBUILD : error MSB1025`, or a stack frame in the
  .NET SDK's own assemblies (`Microsoft.Build`, `Microsoft.DotNet`, `NuGet`,
  `Microsoft.CodeAnalysis`, the test platform's host). Such a denial names no
  path, so it cannot show whose socket it was; the crash of the tool around it
  does. The evidence is the first MSB1025 line and one denial line, however
  often the crash repeats them. The fix is the verified one: build on one
  MSBuild node, `-m:1` on the check's dotnet command, for a command that hands
  its arguments to MSBuild. `dotnet format` takes no `-m:1` (it reads it as the
  project to format: "The file '-m:1' does not appear to be a valid project or
  solution file"), so a `dotnet format` check is given its own fix, measured
  under Orbit's runner and `srt` on macOS with the .NET 9.0.305 SDK: its own
  restore fails after five minutes ("Restore operation failed"), and with
  `--no-restore` after a restore its project loader times out connecting to its
  build host over a named pipe; `dotnet format whitespace --folder
  --verify-no-changes`, which loads no project, passes in about a second. The
  fix is the check's command in that form, reading the folder of the solution
  or project it names and keeping its `--include` and `--exclude`, as
  `orbit doctor` names it. A style or analyzer check needs the projects loaded,
  which the check sandbox does not allow with SDK 9 and later (SDK 8, pinned by
  `global.json`, loads them in its own process). Neither of those two `dotnet
  format` failures prints a denial; ADR 0009's addendum reads both as
  `pipe-denied`: the build host's failure from its own output, and the refused
  restore from the note the runner writes when it stops the check for the
  MSBuild node it records. When that reading finds the refused pipe, the
  `SocketException` in the same crash is the same pipe and is not read again
  as `socket-denied`.

Not evidence of an environment failure: the same `SocketException (13)` from
the repository's own program (its stack is in its own code; captured under
`srt` on macOS, where a Unix socket bind is refused anywhere), a socket denial
with no crash of the tool around it (`listen EPERM: operation not permitted
127.0.0.1`), a denial inside the checkout or with no path, a DNS failure
(`ENOTFOUND`, which an offline host or a wrong name gives too), and any denial
in the output of a failing test. A test whose assertion message says
"permission denied" is a failing test, and so is a Python unittest that errors
with `PermissionError: [Errno 13] Permission denied: '/etc/...'`.

### On a candidate, a new denial goes to repair

Only the base revision is judged with the whole of this. The usage-error table
is never applied to a candidate: the same error there is the change's (a
candidate that deletes the project the check builds), and the repair loop keeps
it. When VERIFYING applies `classifyCouldNotRun` to a candidate
(`checksNotExecutedFor`), the signals this decision added (`permission-denied`,
`socket-denied`, `network-denied`, `nuget-http-denied`, `program-not-found`)
and ADR 0009's `pipe-denied` (`BASE_GATED_SIGNALS`) count only when the same
check's base-revision result had the same classification with the same signal
(the baseline report records each environment failure's signals). Otherwise
the change brought the denial (a test that opens a file it may not read, a
package from a host the check may not reach, a second project under a check
without `-m:1`) and it goes to repair. `pipe-denied` is gated although the
runner writes the note it reads (ADR 0009, addendum, item 3). In practice a run that reaches VERIFYING has no
such base-revision result: PREFLIGHT blocks on any environment failure, and a
resumed baseline that passes records none. So on a candidate these signals
always go to repair today; the gate is what keeps that so if a later decision
lets a run go on past a base-revision environment failure. The denials that
predate this decision (EPERM,
EROFS, a Seatbelt deny line, a crash before any output) keep their earlier
rule.

### Never an exception

`applyBaselineExceptionAnswers` refuses an approval for a failure the baseline
marks with a classification, and reads a usage error and a program that was not
found again from the recorded log, the exit code and the command in the frozen
policy, so a question raised before this decision existed cannot be approved
either. A missing target is refused with its own reason. Both `orbit decide`
and remote answers apply answers there. The refusal is recorded as a rejected
amendment, and the contract is unchanged.

### A resumed baseline runs those checks again

The check runner reuses a recorded result for the same tree, check
configuration and policy, so a resumed PREFLIGHT re-read the old failure and
blocked again however the environment had been fixed. A baseline that follows
one with classified failures sets those checks' recorded results aside
(`RunnerContext.setAside`) and runs them again. A failure of the code is still
reused as recorded.

## Why conservative

The wrong answers cost differently. A check wrongly called pre-existing still
reaches a person, whose question recommends Reject, and the run goes on under
the normal rules; a check wrongly called misconfigured or an environment
failure blocks the run with no question and tells the person to change
something that is not wrong; a check wrongly called a missing target is decided
by the contract. A real code failure must also never leave the repair loop. So
a category needs evidence that only the tool or the environment produces: a
signature from an explicit table, printed by the check's own direct invocation
of the tool about what the command names, the exit code, and nothing in the
output that shows the code ran and failed; and on a candidate, the same
denial on the base revision. A fast exit proves nothing, and duration is not
used.

## Consequences

- A mistyped command line, a missing program or a sandbox refusal now stops the
  run at PREFLIGHT in seconds, before any model call, instead of after
  contracting, planning and repair attempts.
- A misconfigured check is a frozen-policy block: the command lives in the
  run's policy, so `orbit resume` refuses (exit 5). Correct
  `checks.<id>.command` and start a new run. Its reason and the refusal name a
  new run only, which clears the block whatever the cause. `orbit resume
  --force`, which the advice for other frozen-policy blocks offers for a fix
  outside the policy, runs the same command again (a PREFLIGHT block marks the
  baseline incomplete, so the check runs again): it blocks again unless the
  tool changed outside the policy, a plugin installed for instance. At
  CONTRACTING it does not even run it again but reads the recorded baseline,
  and blocks again.
- A missing target the goal creates is checked as the goal's proof; one it does
  not create blocks at CONTRACTING, after the planner ran, as a misconfigured
  check, with the advice of its own above. A target a tool provides that is not
  installed or restored yet (a cargo plugin, a dotnet local tool) needs a new
  run once it is there: CONTRACTING reads the recorded baseline, which `orbit
  resume` does not run again. cargo's `no such command` and dotnet's "Could not execute
  ..." cannot tell a misspelled command of their own from a plugin or tool not
  provided yet (cargo suggests `test` for an uninstalled `nextest` as it does for
  `tset`), so both are missing targets: a misspelled one the contract names as a
  proof goes through repair until the run is EXHAUSTED.
- An environment failure is not a frozen-policy block: fix the environment and
  `orbit resume <run-id>`, which runs those checks again.
- Left as pre-existing failures, each still with its question: a usage error
  printed by a script of the repository, a chain or a program the check runs
  (`dotnet run`); `go test` passing an unknown flag to the test binary and
  `cargo run` passing one to the program, whose words are the program's; tools
  and errors not in the table; a DNS refusal.
- The table grows one verified signature at a time: an entry needs the tool's
  real output as a fixture and a test (`tests/unit/evidence/check-misconfigured.test.ts`
  requires one case per entry, and names each entry's kind).
