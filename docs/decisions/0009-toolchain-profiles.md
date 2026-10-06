# 0009. Toolchain sandbox profiles: read-only dependency caches, private build scratch

Status: accepted (2026-10-06)

## Context

Checks and workers run inside `srt` with a write allowlist. A check gets its
checkout, its artifacts directory, a private empty `HOME` and a private
`TMPDIR`; a worker gets its worktree, its worker directory, a private `TMPDIR`
and its provider's state directory, with the user's real `HOME`. Every
ecosystem's tools also want writable state that is neither of those: a
dependency cache (pip, NuGet, the Go module cache, Cargo's registry, Maven and
Gradle repositories) and per-build scratch (Go's build cache, `__pycache__`,
Cargo's `target` directory, a JVM temp directory). Issue #10 fixed .NET alone
(`DOTNET_*` settings and a prepared private home in `src/evidence/runner.ts`).
For the rest a check either downloaded everything again into its empty home on
every attempt (and needed registry hosts in its own `network_hosts` to do so) or,
in a worker, was denied writing the user's real caches under `~`.

A dependency cache is shared state, so who may write it is a security
question. A check runs repository code, which in a candidate is model-written.
If a check could write a cache that later checks read, one candidate could
plant a package (or a Go test result, keyed by a predictable action id) that a
later candidate's evidence silently depends on.

Measured under `srt` 0.0.78 on macOS (Seatbelt), with the profile below:

- Go 1.27: `go test` passes with `GOMODCACHE` read-only and `GOCACHE`/`GOPATH`
  in scratch. A write into `GOMODCACHE` fails with "operation not permitted".
  `go mod download` inside the sandbox cannot verify TLS certificates
  (`x509: OSStatus -26276`): Go on macOS verifies through the system trust
  service, which the sandbox does not let it reach.
- Cargo 1.98: `cargo fetch --locked` with `CARGO_HOME` writable populates it
  from `index.crates.io` and `static.crates.io`; `cargo build --locked` and
  `cargo test --locked` then pass with `CARGO_HOME` read-only and
  `CARGO_TARGET_DIR` in scratch; a write into `CARGO_HOME` is refused.
- Python 3.12: `python3 -m unittest` passes with `PYTHONPYCACHEPREFIX` in
  scratch (no `__pycache__` in the checkout); `python3 -m venv .venv` in the
  checkout works; pip with a read-only `PIP_CACHE_DIR` warns and disables its
  cache rather than failing.
- Java 21: `java Acme.java` (a single-file program) passes; `File.createTempFile`
  fails with "Operation not permitted" unless `java.io.tmpdir` is the check's
  `TMPDIR` (the JVM ignores `TMPDIR` on macOS). `srt` already sets
  `JAVA_TOOL_OPTIONS` for its proxy agent, so Orbit uses `JDK_JAVA_OPTIONS`.
  On GitHub's macOS runners `java` on `PATH` is Apple's `/usr/bin/java`
  stub and the JDK sits in the runner's tool cache, named only by
  `JAVA_HOME`; in a check environment without it the stub printed "Unable
  to locate a Java Runtime". With the host's `JAVA_HOME` it runs.
- .NET 9: `dotnet build` of a console project passes with `NUGET_PACKAGES`
  read-only and empty (it has no package references).

Maven and Gradle were not installed where this was measured.

## Decision

1. **One profile table keyed by toolchain** (`src/isolation/toolchains.ts`):
   `dotnet`, `go`, `jvm`, `python`, `rust`. Each entry names the executables
   and repository marker files that identify it, its dependency caches, its
   per-run scratch directories, the registry hosts its dependency install
   reaches, the argument `orbit doctor` starts it with, and the environment
   variables that point the tool at those directories.

2. **Detection** comes from the check's command (every word of the argv, or of
   a shell script, matched against the executables: `go`, `cargo`, `python3`,
   `pytest`, `./gradlew`...) and from marker files at the checkout root and in
   the check's `cwd` (`go.mod`, `Cargo.toml`, `pyproject.toml`, `pom.xml`, a
   `.csproj`...). So `make test` in a Go repository is a Go check. A worker
   gets the toolchains its worktree's markers name. A toolchain that is not
   detected gets nothing, and its tool falls back to its defaults under the
   private per-attempt `HOME`, as before.

3. **Dependency caches** live under the Orbit home, keyed by repository:
   `<orbit home>/toolchains/<repo key>/<cache>` (the repo key is the one
   `worktrees/` uses). Nothing is shared between repositories, and nothing
   points at the user's own caches (`~/.cargo`, `~/go`, `~/.m2`,
   `~/.nuget/packages`, `~/Library/Caches/pip`).
   - They are written only by Orbit's dependency-install step
     (`orbit-install`, and `orbit-install-scripts` after it): the install
     from the repository's lockfile (`npm ci`) or the configured
     `dependencies.install_command` (for example `cargo fetch --locked`).
     That step's sandbox has the detected toolchains' caches writable, and
     its network is the package registries: the npm registry plus the
     registry hosts of the detected toolchains.
   - Every other check, the dependency audit included, and every worker gets
     them read-only: they are on the profile's read-only list (re-allowed for
     reading inside the denied Orbit home) and never on its write list. A
     check that tries to write one is denied by the sandbox.
   - Without an Orbit home (a caller that passes none) the caches are
     per-attempt scratch like everything else.

4. **Build outputs and per-command scratch** (`GOCACHE`, `GOPATH`,
   `CARGO_TARGET_DIR`, `PYTHONPYCACHEPREFIX`, `PYTHONUSERBASE`, Gradle's user
   home, Maven's local repository, NuGet's HTTP and plugin caches) go to a
   private directory per check attempt (`<check dir>/toolchains/`, writable,
   removed with the attempt's home and temp directory) or per worker
   (`<worker dir>/toolchains/`). They are never shared between attempts, so a
   compiled object or a cached test result from one candidate cannot reach
   another's evidence. Virtual environments belong in the checkout (the
   install step creates them there; `POETRY_VIRTUALENVS_IN_PROJECT` and
   `PIPENV_VENV_IN_PROJECT` keep those tools from using a cache directory).

5. **Environment.** The variables per toolchain:

   | toolchain | dependency cache (read-only outside the install) | private per attempt |
   |---|---|---|
   | dotnet | `NUGET_PACKAGES` | `NUGET_HTTP_CACHE_PATH`, `NUGET_PLUGINS_CACHE_PATH` (and `DOTNET_CLI_HOME`, the private home; `NuGetAudit=false` in every mode, addendum item 12) |
   | go | `GOMODCACHE` | `GOCACHE`, `GOPATH` |
   | jvm | Gradle `GRADLE_RO_DEP_CACHE`; Maven `-Dmaven.repo.local.tail` (in `MAVEN_OPTS`) | `GRADLE_USER_HOME`, `-Dmaven.repo.local`, `JDK_JAVA_OPTIONS=-Djava.io.tmpdir=<TMPDIR>` (and `JAVA_HOME` set to the host's, read-only, so macOS's `/usr/bin/java` stub and the Maven and Gradle launchers find the JDK; not under the container provider) |
   | python | `PIP_CACHE_DIR` | `PYTHONPYCACHEPREFIX`, `PYTHONUSERBASE` |
   | rust | `CARGO_HOME` | `CARGO_TARGET_DIR` (and `RUSTUP_HOME` pointed at the existing rustup installation, read-only, so rustup's proxies find their toolchains under a private `HOME`; not under the container provider, whose image brings its own) |

   In the install step Gradle's user home and Maven's local repository are
   the caches themselves, so they fill them. The .NET first-run settings
   from #10 stay on every check, detected or not: they only switch optional
   behaviour off and point inside the check's own home. A check's own `env`
   overrides every variable here (`CARGO_TARGET_DIR: target`, say).

6. **Doctor.** `checks.sandbox` builds each probe with the check's toolchain
   environment and paths, and adds one line per detected toolchain: whether
   its executable starts in the check sandbox, where its dependency caches
   live (or that the first install creates them), and which build state is
   per attempt. A tool starts by the name `PATH` gives it, not by a link's
   target: rustup's `cargo` is a link to `rustup`, whose `--version`
   succeeds where `cargo` cannot choose a toolchain. Doctor writes nothing outside its scratch directory: a cache
   that does not exist yet is replaced by an empty scratch stand-in.

## Consequences

- A check no longer needs registry hosts in its own `network_hosts` to build:
  the install fills the cache once per repository and every check reads it.
  A check that needs a dependency the install did not fetch fails, with the
  tool's own "read-only" or "not permitted" message, instead of quietly
  downloading it.
- Repositories whose only lockfile is not npm's need
  `dependencies.install_command` (`cargo fetch --locked`, `dotnet restore
  --locked-mode -m:1`, a venv plus `pip install -r requirements.txt`, `./gradlew
  dependencies`). Orbit does not plan those by itself.
- Go module downloads inside `srt` on macOS fail TLS verification. Vendor the
  modules (`go mod vendor`, which needs no module cache at all), use
  `isolation.provider: container`, or run on Linux.
- The install step trusts its command. `npm ci --ignore-scripts`, `go mod
  download` and `cargo fetch` run no repository code and their cache entries
  are checked against the lockfile's hashes. A configured install command that
  evaluates repository code (MSBuild during `dotnet restore`, a Gradle build
  script, a Python sdist build) runs a candidate's code with the cache
  writable, so a candidate could plant files in its own repository's cache.
  That stays inside one repository and is visible on disk; remove
  `<orbit home>/toolchains/<repo key>` to start clean.
- Build state per attempt means `cargo build` and `cargo test` in two checks
  compile twice. Setting `CARGO_TARGET_DIR` (or `GOCACHE`) in a check's own
  `env` to a directory in the checkout shares it between that candidate's
  checks, at the cost of the isolation described in 4.
- Gradle and Maven wrapper distributions (`gradlew`, `mvnw`) are not shared:
  with a private `GRADLE_USER_HOME` each attempt downloads the distribution
  again, which needs `services.gradle.org` (or your mirror) in the check's
  `network_hosts`, or a `gradle` on `PATH`. Not verified here.

## Addendum (2026-10-06): MSBuild worker nodes, .NET HTTP clients, dotnet format, and a doctor probe that builds

Context. Issue #10 was reopened after a retest of 0.2.0 on a real .NET
repository (macOS, `srt` 0.0.78): `orbit doctor` passed, because its .NET probe
ran `dotnet help`, but every `dotnet test <project>` check hung for about five
minutes at restore and then failed with `MSBUILD : error MSB1025` and
`System.Net.Sockets.SocketException (13): Permission denied`. A later review
found that, on macOS, `dotnet restore` of a project with a package reference
failed in the sandbox before it reached the network. A last round found that a
`dotnet format` check still waited a minute (or MSBuild's five, in its implicit
restore) and then became a pre-existing failure with a baseline exception
question, and that doctor said nothing of NuGet on macOS until a run failed.

Measured under `srt` 0.0.78 through Orbit's runner and check profile (macOS
with .NET SDK 8.0.303 and 9.0.305; Debian 12 and Ubuntu 24.04 arm64 containers
with SDK 9.0.318 and 10.0.401), with a test project referencing two class
libraries:

- `dotnet build` and `dotnet test` pass MSBuild a bare `-m`: one node per
  processor. When a restore or build has two projects to work on at once,
  MSBuild starts a worker node (`dotnet MSBuild.dll /nodemode:1`), which binds a
  named pipe at `/tmp/MSBuild<pid>`. .NET implements the pipe as a Unix socket;
  MSBuild puts it under `/tmp` whatever `TMPDIR` says. The sandbox refuses it:
  Seatbelt logs a `file-write-create` of that socket as denied (macOS),
  and `srt`'s seccomp filter refuses the socket itself (Linux). The node dies
  (exit 134) and writes `MSBuild_pid-<pid>_<id>.failure.txt` into
  `$TMPDIR/MSBuildTemp<user>` (MSBuild 17) or `$TMPDIR/MSBuildTemp<random>`
  (MSBuild 18).
- What waits: on macOS the parent's connect to a socket that never appears
  fails with "not found", and MSBuild keeps trying for 30 s per node (a fixed
  timeout; `MSBUILDNODECONNECTIONTIMEOUT` did not change it) and starts the
  node ten times: 300 s, then `Build FAILED` with no error for `dotnet build`
  and MSB1025 for `dotnet test`. On Linux the parent's own socket is refused
  too, so MSBuild fails within a second, with no error and often before any
  node has written its report. `MSBUILDDISABLENODEREUSE=1`,
  `DOTNET_CLI_USE_MSBUILD_SERVER=0`, `MSBUILDUSESERVER=0` and
  `UseSharedCompilation=false` together did not help.
- `-m:1` in the command keeps MSBuild on one node and the build passes: `dotnet
  build`, `test`, `publish`, `pack`, `restore`, `clean` and `msbuild` each
  accept it (macOS SDK 9 through the runner). `dotnet run -m:1` does not: `run`
  hands the switch to the program and still builds with worker nodes, which
  the sandbox refuses; `dotnet build -m:1 && dotnet run --no-build` passes. An
  explicit `-m:2` starts workers as a bare `-m` does.
- The reported scenario, an xunit 2.9.3 test project with two project
  references, and the same with xunit 2.4.1 and a test that blocks on async
  code (`.Result`): `dotnet test --no-restore -m:1` passes through the runner
  under `srt` in about five seconds on macOS and on Ubuntu, and the test host
  reports the host's processor count (10).
- `DOTNET_PROCESSOR_COUNT=1` also keeps MSBuild on one node, but it reaches the
  test host: xunit before 2.8 runs a test assembly on a synchronization context
  with one thread per processor, so with one a test that blocks on async code
  waits forever for a continuation queued behind it. xunit 2.4.1, 2.6.1, 2.6.2
  and 2.7.1 hang with it and pass in about a second without it; 2.8.0 and
  2.9.2 pass either way (macOS, SDK 9.0.305, `Assert.Equal(1,
  Helper().Result)`).
- A worker (a Claude session running `dotnet build` itself) meets the same
  refusal: in the worker profile under `srt` on macOS, `dotnet build` of the
  test project waited 300.7 s, left ten node reports in the worker's temp
  directory and printed `Build FAILED` with no error; with `-m:1` it built in
  4.6 s.
- .NET HTTP on macOS: every .NET HTTP client builds a `CookieContainer`, whose
  type initializer asks libc for the NIS domain name, which libc reads from the
  sysctl `kern.nisdomainname`. `srt`'s Seatbelt profile allows only listed
  sysctl reads, and that one is not listed (`deny(1) sysctl-read
  kern.nisdomainname`), so `getdomainname` returns -1 and the initializer throws
  `GetDomainName: -1`. NuGet's restore failed with `NU1301 ... The type
  initializer for 'System.Net.CookieContainer' threw an exception`, and a check
  whose program fetched a page from a server it started on loopback failed the
  same way. With the sysctl allowed both get past it.
- HTTPS on macOS then stops at the certificate check: .NET verifies a server
  certificate through the system trust service, and `srt` denies the lookup of
  `com.apple.trustd.agent` (`NU1301: The SSL connection could not be
  established`). Allowing that lookup as well (srt's `allowMachLookup`) made the
  restore from nuget.org pass. On Linux .NET reads the CA bundle and needs
  neither: the install step restores a package from nuget.org and the checks
  build from the cache with no network (Ubuntu 24.04, SDK 9.0.318). Ubuntu's
  own SDK package (8.0.131) also downloads the app host pack at restore, so
  there even a project without package references needs the dependency install.
- A restore in a check, with the cache filled and no network, passes with
  `warning NU1900` (the vulnerability audit cannot reach nuget.org) on SDK 9;
  with Ubuntu's SDK 8.0.131 it failed with "Unable to load the service index".
  In a project that treats warnings as errors (`TreatWarningsAsErrors`,
  `-warnaserror`, `-p:TreatWarningsAsErrors=true`, or the variable in the
  environment) that warning is `error NU1900: Warning As Error`: on macOS
  (SDK 9.0.305, through the runner under `srt`) the dependency install
  `dotnet restore -m:1` and the check `dotnet build -m:1` failed on it after
  the cache was filled, and each restore waited about 6 s on the audit first.
  With `NuGetAudit=false` in their environment (MSBuild reads it as a
  property) both passed with no NU1900, on SDK 8.0.303 and 9.0.305; a
  `<NuGetAudit>true</NuGetAudit>` in the project overrides the environment and
  failed again, and `<NuGetAudit Condition="'$(NuGetAudit)' == ''">true</NuGetAudit>`
  did not.
  `--no-restore` after the dependency install passes on both.
- `dotnet format` (SDK 8.0.303 and 9.0.305 on macOS through the runner; SDK
  10.0.401 under `srt` in a Linux arm64 container, with the paths and variables
  of a check's profile): every form but `dotnet format whitespace --folder` loads the project
  through Roslyn's MSBuildWorkspace, which evaluates it in a build host, a
  separate process (`BuildHost-netcore`) that binds a named pipe its parent
  connects to. Roslyn names that pipe with an absolute path under `/tmp`
  (`/tmp/<guid>`) whatever `TMPDIR` says, as MSBuild does `/tmp/MSBuild<pid>`:
  the Seatbelt log stream (`log stream --predicate 'sender == "Sandbox"'`)
  showed `deny(1) file-write-create /tmp/<guid>` from the build host
  while the check's `TMPDIR` was its private directory. On macOS the parent
  then waited out its 60 s connect timeout (`System.TimeoutException` in
  `NamedPipeClientStream.ConnectInternal` under `BuildHostProcessManager`,
  61.4 s, nothing in the output naming a denial); on Linux srt's seccomp filter
  refused the socket and the format failed within a second ("The build host was
  started but we were unable to connect to it's pipe", `SocketException (13)`).
  `--no-restore` after `dotnet restore -m:1` changes nothing. The implicit
  restore of `dotnet format` is a `dotnet restore` without `-m:1`, which no
  switch of `dotnet format` reaches: for a test project with two project
  references it was refused a worker node, and the runner stopped it within 1.5
  s ("Restore operation failed"); before the early stop it took the five
  minutes. `dotnet format whitespace --folder --verify-no-changes` reads the
  files without loading a project and passed in about a second on both. SDK
  8.0.303's `dotnet format` evaluates projects in its own process: with
  `--no-restore` after `dotnet restore -m:1` it passed in 3.7 s. The .NET
  runtime's own diagnostics socket, `dotnet-diagnostic-<pid>-...-socket` in the
  private `TMPDIR`, is refused too (`network-bind`), for every .NET process,
  with no effect on a build.

Decision.

1. **Orbit never changes a check's processor count.** A dotnet check pins one
   MSBuild node in its own command: `-m:1` (or `-maxcpucount:1`). Considered and
   rejected:
   - `DOTNET_PROCESSOR_COUNT=1` on every check (the first version of this
     addendum). It reaches the test host, where xunit before 2.8 deadlocks
     tests that block on async code (measured above), and it silently changes
     how a repository's tests run, which undermines the evidence a check is.
   - Allowing Unix sockets under `/tmp` (or `/tmp/MSBuild*`). The pipe's path is
     fixed under `/tmp`, so it cannot be moved into the check's private temp
     directory; `/tmp` is shared by every repository's checks and by the
     user's own MSBuild, and a check that could connect there could hand work
     to an idle MSBuild node of the user's, outside the sandbox.
   - A `Directory.Build.rsp` with `-m:1` above the checkout (the dotnet CLI
     passes its own bare `-maxcpucount` on the command line, which wins, and a
     repository's own file would shadow it), and an environment variable for
     the node count (none exists: `MSBUILDNODELIMITOFFSET` only adds).
2. **`orbit doctor` judges each command before any probe**
   (`evidence/msbuild.ts`). A check that runs `dotnet build`, `test`,
   `publish`, `pack`, `restore`, `clean`, `msbuild` or `run` itself (its argv,
   the command `env` starts, or a command of a shell line or `sh -c` script
   that is a chain of plain commands joined by `&&`, `;` or a new line) without
   `-m:1`, or with a switch asking for more nodes, is refused without being
   started: doctor fails when the check is mandatory and warns otherwise, and
   the fix is the check's command with `-m:1` added, ready to paste
   (`checks.<id>.command: ["dotnet", "test", "tests/Acme.Tests", "-m:1"]`; for
   `dotnet run`, a shell line that builds with `-m:1` and runs with
   `--no-build`, which doctor then passes). A `-m:1` after the `--` of `dotnet
   test` does not count: the test runner gets it, and the runner was refused a
   worker node with it; after the `--` of the other verbs MSBuild gets it, and
   `dotnet build <project> -- -m:1` built. `dependencies.install_command` is
   judged the same way, and always as mandatory. A command whose MSBuild call is
   indirect (make, a script, a wrapper, a shell line with a pipe, `||`, a
   substitution or a redirection) cannot be judged from its definition: doctor
   warns that it cannot tell and names the same fix for every MSBuild call it
   starts. `DOTNET_PROCESSOR_COUNT=1` in the check's own `env` gives every
   MSBuild it starts one node, through make or a script too, as the runner
   measured (`dotnet build` of the test project above, no switch, passed under
   `srt`): doctor accepts it as pinned unless a switch asks for more nodes, and
   names it in the fix, after the fixed commands and once for all of them, as an
   alternative that changes the test host's processor count, which deadlocks
   xunit before 2.8 (item 7).
3. **The runner stops a refused build at once**, which covers what doctor
   cannot judge. It looks in the check's private `TMPDIR` once a second for a
   node report of a pipe the sandbox refused, reading at most 4096 names there
   and opening a report without following a link or waiting (the check owns
   that directory, and a FIFO swapped in for a report blocked the controller's
   event loop in `open()`, timeouts and cancellation included, until a review
   caught it). It records the check FAILED with the node, the pipe and the fix
   for that check's command, whatever the stopped process exits with. The note
   names the node as `pid <n>`, which the failure fingerprint normalizes. On
   macOS this ends what was a five minute wait within about two seconds; on
   Linux MSBuild fails first, usually before the runner looks. The note ends
   the check's log, on the footer only the runner writes, and PREFLIGHT reads
   it as the environment's failure (`pipe-denied`,
   `evidence/environment-failure.ts`): on the base revision the run blocks with
   the fix and no baseline exception question. (Before, the note's `Permission
   denied` matched none of the classifier's denials, so a refused node on the
   base revision became a pre-existing failure with a baseline exception
   question.) On a candidate `pipe-denied` follows ADR 0010's rule for the
   denials it added: it counts only when the same check showed it on the base
   revision, and otherwise the failure goes to repair. The runner writing the
   note does not make it a denial no change can bring: the note relays
   MSBuild's report from the check's own `TMPDIR`, and whether MSBuild starts a
   node depends on the repository (a second project under a check without
   `-m:1`, a test that runs `dotnet build`). It is also the refusal that
   ADR 0010's `socket-denied` reads from `dotnet test`'s `MSB1025`, which is
   gated the same way, so a candidate's outcome does not depend on whether the
   runner's scan saw the report before MSBuild printed its error.
4. **Doctor's .NET probe builds**, three generated projects with no packages (a
   library referencing two others, `net$(NETCoreAppMaximumVersion)`, empty
   `Directory.Build` files so nothing above the scratch directory is imported),
   offline, in the sandbox of the check that uses .NET, its `env` included,
   with a 180 s limit and the same early stop. It carries over the node
   switches MSBuild gets from that check's dotnet commands that build, so
   doctor and the runner agree: `-m:1` or `-maxcpucount:1` builds, no switch is
   refused as the check would be, and `DOTNET_PROCESSOR_COUNT=1` in the check's
   `env` builds without one, on one node. A `-m:1` after the `--` of `dotnet
   test`, or on `dotnet run`, is not carried, since MSBuild does not get it. For
   a check whose commands do not build with dotnet themselves (make, a script,
   `dotnet format`) it builds with `-m:1`, the fix doctor names, since whether
   those pass it is what doctor cannot tell. A refused toolchain fails doctor
   when a mandatory check runs the toolchain's executable itself, and warns
   otherwise, for every toolchain.
5. **`orbit init` proposes `dotnet build <target> -m:1` and `dotnet test
   <target> -m:1`**, with the reason in the comment above each proposed check.
6. **Workers are told.** The policy summary of every worker in a repository
   with .NET markers, under `srt`, carries one line: pass `-m:1` to every
   dotnet build, test, publish, pack, restore, clean or msbuild, and run a
   project with `dotnet run --no-build` after such a build. A worker's commands
   cannot be judged in advance, its processor count stays the host's for the
   same reason as a check's, and a note costs nothing outside .NET
   repositories. A guard that refuses `dotnet build` without `-m:1` was not
   chosen: it would parse every shell command a worker runs, for one
   toolchain. Not verified with a live model session.
7. **`checks.dotnet-tests`** is for a check whose own `env` sets
   `DOTNET_PROCESSOR_COUNT=1`, which `checks.sandbox` accepts as one MSBuild
   node (item 2): doctor warns when such a check may run tests and a tracked
   test project references xunit before 2.8, with the fix (drop the variable
   and pass `-m:1` instead, or upgrade xunit). The note on a timed-out check's
   record and the warning for checks with Orbit's own setting are gone with the
   setting. (A review found that doctor first failed this alternative, which
   its own fix named and the runner passes, so this warning could hardly be
   reached.)
8. **.NET may read the NIS domain name.** Each sandbox that gets .NET's
   toolchain profile (a check or the dependency install whose toolchains include
   dotnet, a worker whose worktree does, doctor's probes) gets one more Seatbelt
   rule on macOS,
   `(allow sysctl-read (sysctl-name "kern.nisdomainname"))`, added by the
   preload that adds Chromium's rules (ADR 0001), now with named rule sets in
   the query of its URL (`?rules=nis-domainname`). The name is the NIS (YP)
   domain of a machine bound to NIS, empty on any Mac that is not; it is no
   secret (NIS clients announce it on their network) and says less than the
   host name, which `srt` already lets every process read. The rule is
   read-only and names one sysctl. It needs the `srt` the preload was verified
   against (0.0.78, which the plugin ships); with another `srt` the command runs
   without the rule and its record says so, rather than refusing, since the
   rule only lets .NET's HTTP clients start. Approved operations (an approved
   `dotnet add package`), the UI app (`ui.environment.start_command`) and
   release commands get no toolchain profile, so neither this rule nor `-m:1`
   handling: .NET there meets the denials this addendum describes, and a `dotnet
   run` app start would wait out MSBuild's five minutes. Not addressed here.
9. **The system trust service stays out of reach.** `srt` documents the lookup
   of `com.apple.trustd.agent` as an exfiltration path: a process that may ask
   trustd to evaluate a certificate can make it fetch the certificate's issuer
   and revocation URLs from any host, outside the egress allowlist. The
   dependency install runs repository code (MSBuild evaluates the project
   during a restore), so allowing it there would let a candidate reach any host.
   On macOS a restore from nuget.org therefore fails inside the sandbox; the
   ways out are below. Allowing it for the dependency install alone, as an
   explicit opt-in, is left to a later decision. The maintainer confirmed it
   stays denied.
10. **`dotnet format` is judged, not opened** (`evidence/dotnet-format.ts`).
    `orbit doctor` fails a mandatory check that runs `dotnet format` in a form
    that loads the project (any form but `dotnet format whitespace --folder`,
    `--version` or `--help`; its argv, the command `env` starts, a command of a
    chain or of `sh -c`, or the words of another shell line) before any probe,
    and warns for an optional one. The fix is the check's command with `dotnet
    format whitespace --folder --verify-no-changes` in place of that `dotnet
    format`, ready to paste, with the reason once: it checks whitespace only,
    so the style and analyzer checks belong outside Orbit, in CI. The folder
    form reads the folder of the solution or project the check named and keeps
    its `--include`, `--exclude` and `--include-generated` (measured: `--exclude`
    is read from that folder), so the pasted check covers the same files. A
    check that also runs MSBuild without `-m:1` (`dotnet build && dotnet format
    --verify-no-changes`) gets one command with both changes and both reasons,
    in doctor and in the runner's note: the first review found that the
    pasted `-m:1` fix was refused again for its format. Make or a
    script that runs `dotnet format` is not in the definition and is not judged.
    The runner reads the build host failure from the check's output (a
    `BuildHostProcessManager` frame and a pipe connect that timed out or was
    refused) as the environment's failure (`pipe-denied`), and names the folder
    form, not `-m:1`, when it stops such a check for its implicit restore's
    refused worker node. No earlier signal reaches the runner: the build host
    aborts as soon as its bind is refused (`SocketException (13)` in
    `NamedPipeUtil.CreateServer`, then SIGABRT, measured by starting it alone
    under `srt`), its error goes to its parent, which does not print it, nothing
    is left in the check's temp directory, and the denial is only in the system
    log, so on macOS the check ends at the parent's 60 s timeout, on Linux at
    once. Workers are told which form of
    `dotnet format` runs. SDK 8 loads the project in dotnet format's own
    process, with no build host, so doctor and the runner read the nearest
    `global.json` from the check's directory up to the repository (or the run's
    checkout): when it pins SDK 8 or earlier with a `rollForward` that keeps the
    major version, every form is accepted except one that restores first
    (no `--no-restore`, and no `DOTNET_PROCESSOR_COUNT=1` in the check's
    `env`), whose restore is refused worker nodes; its fix is a `dotnet restore
    <workspace> -m:1` before it and `--no-restore` (a shell line for an argv).
    Measured under `srt` through the runner on macOS with SDK 8.0.303 and a
    project with two references: the plain form failed in about a second on
    the refused node, the fixed one passed, and so did the plain form with
    `DOTNET_PROCESSOR_COUNT=1`. Without a `global.json` the SDK is the newest
    installed, which a definition does not show, so it is judged as SDK 9;
    other SDK 8 feature bands than 8.0.3xx were not measured. Considered and
    rejected:
    - Allowing Unix socket bind and connect under the check's private `TMPDIR`
      on macOS only (`srt`'s `network.allowUnixSockets`, which adds
      `system-socket` for `AF_UNIX` and `network-bind`/`network-outbound` for
      that subpath; `srt` ignores it on Linux, where seccomp can only allow
      every Unix socket, the Docker socket and SSH agent included). The
      directory is private to one check attempt (owner-only, under
      `/tmp/orbit-<uid>`, read-denied to every other sandbox, removed after the
      attempt), so nothing unsandboxed would listen there and nothing would be
      shared between repositories; but the build host's pipe is not there.
      Roslyn's pipe path, like MSBuild's, is fixed under `/tmp`, so the rule
      would open something and fix nothing. Pipes that .NET does create from a
      relative name under `TMPDIR` (`CoreFxPipe_<name>`, the diagnostics
      socket) were not needed by any check measured; SDK 10's
      Microsoft.Testing.Platform pipes and VSTest's were not measured on macOS.
    - Allowing `/tmp/<guid>` or `/tmp` itself: shared by every process of the
      user, including unsandboxed MSBuild and Roslyn servers a check could hand
      work to (item 1).
    - Refusing to start such a check in the runner from its definition: SDK 8
      runs it, and the output signal is reliable.
11. **`checks.dotnet-packages`** (`cli/commands/doctor-dotnet.ts`) says before a
    run what item 9 means for a repository: on macOS under `srt`, when a check
    or the dependency install uses .NET and the tracked files show packages (a
    `PackageReference` in a project, `Directory.Build.props` or
    `Directory.Build.targets`, or a `packages.lock.json`,
    `Directory.Packages.props` or `packages.config`), it names the reason in one
    sentence and the one command that fills the repository's NuGet cache outside
    the sandbox, with the real path: `(cd <repo> && NUGET_PACKAGES=<orbit
    home>/toolchains/<repo key>/nuget dotnet restore -m:1)`, the dependency
    install's own command with `-m:1` when that is a dotnet restore, or a
    restore of each solution (else each project, at most 20, saying how many it
    leaves out) when the repository root holds no single one. It warns, and
    fails when `dependencies.install_command` restores packages and the cache is
    empty or missing, since that install cannot succeed. It reads tracked files
    only and never creates the cache. The `toolchain dotnet` line of
    `checks.sandbox` says on macOS, for a repository with packages, that they
    are restored into the cache outside the sandbox (and only that: the first
    review found it also said the first install creates it). After the first
    review: the fill command restores the projects' packages and the local
    tools (`dotnet tool restore`, when the root has a tool manifest or the
    install restores tools), whatever part of them the install restores; local
    tools are NuGet packages in the same cache, and a check restores them
    itself from it, since its home is its own (measured under `srt`: the
    install's `dotnet tool restore` and a check's `dotnet tool restore &&
    dotnet csharpier --version` passed with no network). A tool manifest and
    an MSBuild SDK that NuGet resolves (`Sdk="Name/Version"`, `<Sdk Name
    Version>`, `msbuild-sdks` in `global.json`) count as packages (measured:
    the fill restore caches `Microsoft.Build.NoTargets/3.7.56` and a build then
    resolves it with no network). A floating version (`13.*`) is looked up at
    the source at every restore, cache or not (measured: `NU1301` with the
    cache filled), unless a tracked lock file pins it (measured: restores
    offline): doctor names it, fails while the install restores projects, and
    promises the offline restore only once nothing floats. Verified end to end on macOS (SDK 9.0.305): a
    scratch repository with one project referencing Newtonsoft.Json, doctor
    failing with the command, the command run in a terminal, doctor warning
    with one package in the cache, then checks with no network (`dotnet build
    -m:1`, and `dotnet build -m:1 && dotnet run --no-build`, which printed the
    package's output) passing under `srt` with `warning NU1900` (before item
    12; with the audit off there is none); an
    integration test does the same through the install step, which then had
    nothing to download, and checks with and without `--no-restore`.
12. **NuGet's vulnerability audit is off in the sandbox.** The .NET profile sets
    `NuGetAudit=false` for the dependency install, checks, workers and doctor's
    probes (`isolation/toolchains.ts`; MSBuild reads it from the environment).
    The audit fetches from the package source at every restore, which nothing
    in the sandbox reaches on macOS (item 9) and a check or worker does not
    reach on Linux (no network, unless a check lists the host); there it could
    only wait and add `NU1900`, which fails every restore of a repository that
    treats warnings as errors, however full its cache, and on the base revision
    turned that into a baseline exception question, the symptom #10 is about.
    It is the same in every mode, the Linux install included (which could
    reach nuget.org), so a check's restore matches the install's;
    vulnerability auditing belongs to CI. A check's own `env` sets it back. A project or MSBuild import that
    sets `NuGetAudit` itself overrides the environment, so
    **`checks.dotnet-audit`** (`cli/commands/doctor-dotnet.ts`; macOS under
    `srt`, a .NET repository with packages) reads the tracked project and
    `.props`/`.targets` files, the checks' and the install's commands and the
    checks' `env`: when something turns the audit on (`NuGetAudit` true, unless
    its condition defers to `$(NuGetAudit)`; `-p:NuGetAudit=true`; a check's
    `env`) while warnings are errors (`TreatWarningsAsErrors` or
    `MSBuildTreatWarningsAsErrors` true, `NU1900` in `WarningsAsErrors`,
    `-warnaserror` without codes or naming `NU1900`), and neither `NoWarn` nor
    `WarningsNotAsErrors` names `NU1900`, it names the setting and the change:
    `<NuGetAudit Condition="'$(NuGetAudit)' == ''">true</NuGetAudit>` in each
    file, which keeps the audit everywhere else, or the setting removed from
    the check. It fails when the dependency install or a mandatory check
    restores (a dotnet restore, or a build verb without `--no-restore` or
    `--no-build`), and warns when only optional checks, make or a script, or a
    setting under a condition doctor does not evaluate are involved.
    `checks.dotnet-packages` then promises the offline restore only once the
    audit no longer fails it. Rejected: naming
    `<WarningsNotAsErrors>$(WarningsNotAsErrors);NU1900</WarningsNotAsErrors>`
    for every repository that treats warnings as errors: measured, a project
    that sets its own `WarningsNotAsErrors` after `Directory.Build.props`
    drops it, and under `-warnaserror` a `Directory.Build.targets` one came too
    late, so it would ask each repository for a change that does not always
    hold, where one variable needs none. Verified on macOS (SDK 9.0.305) through
    the runner under `srt`, in integration tests: a project with
    `TreatWarningsAsErrors`, its cache filled outside the sandbox, passes the
    install and both checks with no `NU1900`; with `<NuGetAudit>true</NuGetAudit>`
    in `Directory.Build.props` doctor fails and the install fails on `error
    NU1900`; with the form doctor names, doctor says nothing and the install
    and checks pass.

Consequences.

- A .NET repository's checks carry `-m:1` (or `DOTNET_PROCESSOR_COUNT=1` in
  their `env`, at the test host's cost), and `orbit doctor` fails a mandatory
  one that does not. Checks written for 0.2.0 (`dotnet test`) fail doctor with
  their fixed command until they are edited. A single-project `dotnet build`
  without `-m:1` builds under `srt` (one project needs no worker node), but
  doctor fails it too: it cannot tell from a definition how many projects a
  build walks. A check builds one
  project at a time (one MSBuild node), so large solutions build more slowly
  than outside Orbit; the test host keeps the host's processor count.
- A check that runs MSBuild through make or a script is a doctor warning until
  its definition shows the MSBuild call; if the call lacks `-m:1`, the run
  fails at once with the refused node and the fix in the check's record.
- `dotnet run` checks build first: `dotnet build -m:1 && dotnet run
  --no-build` (a shell line).
- On macOS a .NET repository with packages fills its NuGet cache outside the
  sandbox, once and again when its packages change, with the cache path
  `orbit doctor` prints: `NUGET_PACKAGES=<that path> dotnet restore -m:1` in
  the repository. The dependency install (`[dotnet, restore, -m:1]`) and the
  checks then restore from it with nothing to download; NuGet's vulnerability
  audit is off there (item 12), so `NU1900` does not fail a repository that
  treats warnings as errors, unless the repository sets `NuGetAudit` itself
  (`checks.dotnet-audit`). NuGet's vulnerability audit does not run in
  Orbit's sandbox, on any platform; it runs where the repository's CI runs it.
  On Linux, or
  with `isolation.provider: container`, the dependency install downloads the
  packages itself. Checks after the install build with `--no-restore`, which
  needs no network on any SDK measured.
- Every check, dependency install, worker and doctor probe that runs .NET
  under `srt` on macOS can read one more sysctl; a check's evidence record (the
  dependency install's included) says so, in the limitation that names the
  rule.
- A `dotnet format` check under `srt` is `dotnet format whitespace --folder
  --verify-no-changes`, or, with SDK 8 pinned by `global.json`, any form whose
  restore is pinned; otherwise doctor fails it (mandatory) or warns
  (optional); `dotnet format --verify-no-changes` runs in CI. One that runs
  anyway (through make, say) blocks the run with the fix within about a
  minute on macOS (about two seconds when its restore is refused a node)
  instead of becoming a pre-existing failure. On Linux the build host's
  refusal is read from the output (a measured log); a refused restore is read
  only when MSBuild recorded the node, which the runner now also looks for when
  the check has already failed; whether MSBuild records it before failing on
  Linux was not measured.
- No Unix socket is allowed in any sandbox; the evaluation above found none
  that would help.
- Not verified: `dotnet test -m:1` in the Microsoft.Testing.Platform mode of
  SDK 10, `dotnet format` with SDK 10 on macOS, and a worker session following
  the note.
