# 0011. Recognising test files in every mainstream language

Status: accepted (2026-10-07). Issue #30.

## Context

A green check is evidence about a change only when the change could have turned
it green (spec section 10, "green checks without proof"). The evidence report
therefore supports a criterion whose checks already passed on the base revision
only when the candidate adds or changes a test; otherwise the criterion is
`unverified` with "no new evidence" (docs/operations.md, traceability P2).

What counted as a test was `isTestPath`, which knew JavaScript/TypeScript,
Python and Go and returned false for any other file, even inside `tests/`. The
0.2.1 retest on a .NET repository found the result: a candidate that adds xunit
tests in `tests/Acme.Tests/CalculatorTests.cs` "adds or changes no test", every
criterion mapped to a check that passed at baseline (the normal case) is
unverified, the verdict is INCOMPLETE, and the run ends BLOCKED. The same holds
for C#, F#, VB, Java, Kotlin, Scala, Rust, Ruby, PHP, Swift, C and C++, Elixir
and Dart.

The predicate has four uses, and all four were wrong in the same way:

1. the new-evidence rule of the evidence report (`evidence/report.ts`);
2. the `test-file-deleted` weakening signal, and whether a changed file's
   timeouts and tolerances are a test's (`policy/weakening.ts`, run by the
   scope inspection);
3. the unexplained-architecture trigger, which does not count new tests as
   changes the plan failed to explain (`inquisition/triggers.ts`);
4. the review packet, which ranks a change's tests just below its code
   (`review/packet.ts`).

## Decision

One set of rules in `src/policy/test-files.ts` for all four uses. A false
"test" is the dangerous mistake for the evidence (it lets an unverified
criterion pass), so each rule follows what the language's test runner actually
runs, never a loose name match:

| Language | A test file is |
|---|---|
| JavaScript/TypeScript, Python, Go | as before: test directories, `.test.`/`.spec.` files, `test_*.py`, `*_test.py`, `conftest.py`, `*_test.go` |
| C#, F#, Visual Basic (`.cs`, `.fs`, `.vb`, `.razor`) | a source whose project (the nearest project file above it) is a test project |
| Java, Kotlin, Scala, Groovy | a source in a test source set: `src/test/`, `src/it/`, `src/<name>Test/` (Gradle, Android, Kotlin Multiplatform), `src/testDebug/` and `src/testRelease/` (Android build types); or under Bazel's `javatests/`. Not a helper source set (`src/testFixtures/`, `src/testUtils/`, `src/testSupport/`) |
| Rust | a file under a crate's `tests/`, or a source of a crate's `src/` that cargo compiles (a crate root, or a module the crate declares) whose change adds a `#[test]` function that is not ignored |
| Ruby | `*_spec.rb` under `spec/`, `*_test.rb` under `test/` |
| PHP | `*Test.php` under `tests/` |
| Swift | a source under `Tests/` or a `<Name>Tests/` folder, never under `Sources/` (Swift Package Manager compiles all of it into the module) |
| Elixir | `*_test.exs` under `test/` |
| Dart | `*_test.dart` under `test/` or `integration_test/` |
| C and C++ | a source or header under `test/` or `tests/`; a C++ `*_test`, `*_tests` or `*_unittest` `.cc`/`.cpp`/`.cxx` anywhere, except a production feature named that way (`self_test`, `ab_test`, `a_b_test`) |

Any other file is not a test. A language without a rule can only leave a
criterion unverified, never pass one.

### Two questions: is it a test, and was it one

The rules are asked in two ways, because the uses fail in opposite
directions. `isTestPath` asks whether a file is a test on every revision that
has it: the new-evidence rule, the unexplained-architecture filter and the
review packet ask this, since a false "test" there lets an unproven change
through. `isTestPathOnEitherRevision` asks whether it is a test on either
revision, by that revision's own project files: the weakening signals ask this,
since a missed test there hides a deleted or weakened one. A candidate that
turns a test project into a library, or deletes its project file, and deletes
or edits its tests in the same change still raises `test-file-deleted` and the
other signals. For a language whose rules are path conventions the two
questions are one.

### .NET: the project decides, not the file name

`dotnet test` runs test projects only: a `CalculatorTests.cs` in the library
project is compiled into the library and never run (measured with SDK 9.0.305:
`dotnet test` of a solution with a library holding such a file and an xunit
project ran the xunit project's two tests and nothing else). So `*Tests.cs` and
`*Test.cs` count because they live in a test project, not because of their
names, and a production file named `Test.cs` (a record of an exam application)
is not a test.

A project is a test project when its project file sets
`<IsTestProject>true</IsTestProject>`, references one of
`Microsoft.NET.Test.Sdk`, `xunit`, `xunit.v3`, `NUnit`, `MSTest`,
`MSTest.TestFramework` or `TUnit`, or uses the `MSTest.Sdk` project SDK, and
does not set `<IsTestProject>false</IsTestProject>` (anywhere, even under a
condition: in doubt, a project is not a test project). A legacy .NET Framework
project counts by a `Reference` to a test framework assembly (`nunit.framework`,
`xunit.core`, `Microsoft.VisualStudio.QualityTools.UnitTestFramework`,
`Microsoft.VisualStudio.TestPlatform.TestFramework`) or the test project type
GUID `{3AC096D0-A1C2-E12C-1390-A8335801FDAB}` in `ProjectTypeGuids`. Comments
are ignored; a reference to an assertion or analyzer package alone
(`xunit.assert`, `NUnit.Analyzers`, `FluentAssertions`) is not enough, and
neither is a `PackageVersion` entry. Nothing under a condition counts: an
element with a `Condition` attribute is dropped with everything it holds (a
conditional `PropertyGroup`, `ItemGroup` or reference), and so is `Choose`,
since which branch applies is MSBuild's to evaluate.

A source is owned, on each revision that has it, by the nearest folder above it
holding a project file on that revision. It is a test only when it is owned on
every such revision, and every owner is a test project by every project file
the folder holds, on every revision that has one. So a candidate cannot make
its production files count as tests by adding `IsTestProject` to the production
project, nor by adding a test project around them (`src/Acme/Calc/Calc.csproj`
inside the production `src/Acme/`: the base still owns `Calculator.cs` in the
production project, and SDK globbing still compiles it there). A file whose
test project the candidate deletes is no longer a test, since nothing builds it
as one. A test project the candidate adds is judged by the candidate's project
file; one it deletes, by the base's, so its deleted files raise
`test-file-deleted`.

What a `Directory.Build.props` adds is not read: MSBuild conditions there
(`'$(IsTestProject)' == 'true'`, project-name tests) decide which projects get
the packages, and reading them without evaluating MSBuild would count
production projects. Such a test project is recognised once its project file
declares `<IsTestProject>true</IsTestProject>` or references its test SDK, on
the base revision too: a candidate that adds the declaration during the run is
judged by the base's project file as well, which does not say so.

### Rust: tests/ of a crate, and #[test] functions the change adds

Cargo builds `tests/*.rs` of a crate (a directory whose `Cargo.toml` has a
`[package]` table, on every revision that has it) as integration tests; files
below `tests/` are their modules. A virtual workspace manifest builds no tests:
measured with cargo, a panicking `#[test]` in `tests/` beside a
`[workspace]`-only `Cargo.toml` never ran, while the member crate's `tests/`
did.

Most Rust unit tests live in the source file, in a `#[cfg(test)] mod tests`,
which no path rule can see. So a source counts when its diff adds a line that
is a test attribute (`#[test]`, a runtime's `#[path::test]` such as
`#[tokio::test(...)]` and `#[async_std::test]`, `#[rstest]`, `#[test_case(...)]`),
but only where `cargo test` runs it. Measured with cargo 1.98 on one crate with
a test function in each place: `cargo test` ran the ones in `src/lib.rs`,
`src/bin/tool.rs` and `tests/t.rs`, inside or outside `cfg(test)`, and none in
`benches/`, `examples/`, `build.rs`, a `src/` file no `mod` declares, or one
marked `#[ignore]`. So the source must belong to a crate (on every revision
that has it), sit in that crate's `src/`, and be a crate root (`src/lib.rs`,
`src/main.rs`, `src/bin/*.rs`, `src/bin/*/main.rs`) or a module the crate
declares: `loadTestLayout` follows the `mod` declarations of the candidate from
`src/a/b.rs` (or `src/a/b/mod.rs`) to `mod b;` in `src/a.rs` or `src/a/mod.rs`,
and on up to a crate root. A test function whose attributes (the attributes,
comments and blank lines before it) include `#[ignore]`, `#[ignore = "..."]` or
a `cfg_attr(..., ignore)` does not count. A `#[cfg(test)]` module with no test
function, a comment, a removed test, an edited assertion of an existing test
and any other attribute do not count either. Editing only the body of an
existing inline test is therefore not a test change (the safe direction: the
criterion is unverified).

The diff is passed only by the new-evidence rule, which asks whether the change
adds a test. The weakening signals and the trigger filter ask what a file is, so
`src/lib.rs` stays a source file there, and its production timeouts are never
read as test timeouts.

### Where the layout comes from

`loadTestLayout(reader, base, candidate, changedPaths)` reads both trees
through the caller's own hardened git (`gitTreeReader`). Only the directories
above a changed .NET or Rust file can own it, so only they are listed: one
non-recursive `git ls-tree -z --name-only` per revision (in batches of 200
directories), never `ls-tree -r` of the whole tree. A whole-tree listing went
through git runners that keep only the first 8 MiB of output and drop the rest
without an error; on a repository of about 140,000 files the listing stopped
before `tests/`, the xunit project was never seen and its tests did not count.
A listing that does not end in its record terminator was cut short and is
refused. Only the project files and Cargo manifests that own a changed file are
read. With no such file changed it reads nothing. The scope inspection, the
evidence base comparison, the pending-trigger check and the review packet each
load it for their candidate. The evidence comparison also asks for the Rust
modules the crate compiles (`rustModules`), reading the declaring sources of
the changed modules, and reads the diffs of changed Rust sources (at most 50)
when no changed path is a test by itself.

## Why conservative

Each rule is the language's own test layout, so it covers the mainstream
layouts and nothing more. Known gaps, all in the safe direction (a missing test
leaves the criterion unverified, it never passes one): Ant and Mill layouts and
a JVM `test/` directory outside `src/`; Android product flavor source sets
(`src/testFree/`), which no name tells apart from a helper source set;
`test_*.c` outside a test directory (Unity and CMocka keep them in `test/`,
where they count); Minitest's `test_*.rb`; test projects declared only through
`Directory.Build.props` (common in larger .NET repositories), or only under a
condition; Unity test assemblies, defined by an `.asmdef` with no committed
project file; Rust tests in a `[[test]]` target with a custom path, in a crate
whose library or binaries are not at cargo's default paths, or in a module
declared through `#[path]`, inside an inline module or by a macro; languages
without a rule (Haskell, Clojure, Lua, Zig and others).

Known false "tests", which the rules cannot see without reading the build:
a file the runner's own configuration or build leaves out still counts by its
layout (a test file a Vitest `include` pattern skips, a C++ file under `tests/`
no CMake target lists, a helper module under a crate's `tests/` no test target
declares, a crate the workspace does not list as a member, a .NET test project
missing from the solution the check builds). Like adding an empty test file,
each is a change the reviewer sees, not a test the green check ran. A line
inside a Rust raw string that starts with `#[test]` counts as a test attribute
(no lexer reads the string); it takes a deliberately misleading change.

The weakening signals still read assertion, skip and focus idioms for
JavaScript/TypeScript, Python and Go only; xunit's `Skip =` and JUnit's
`@Disabled` are not yet signals (an ignored Rust test added in a source file is
simply not new evidence, above).

## Consequences

A candidate that adds tests in any of these languages can verify its criteria;
the deletion of such a test is a `test-file-deleted` signal; new tests in a
.NET test project or a crate no longer count as changes the plan did not
explain. `pendingTrigger` became asynchronous, since it reads the layout through
git.

The test files of every recognised language now get the same weakening
heuristics as JavaScript tests, which were tuned on JavaScript. Raising a
timeout, raising or newly setting a `delta`, `threshold`, `tolerance` or
`retries` number, or lowering a `lines`, `branches`, `functions` or
`statements` number (in any `key = number` or `key: number` form) in a C#,
Java, Ruby or other test file raises `oracle_weakening`, makes the verdict
INCOMPLETE and opens an Inquisition, as the same edit in a JavaScript test
always did. An honest edit of that kind is answered there.
