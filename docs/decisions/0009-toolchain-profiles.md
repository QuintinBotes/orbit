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
   | dotnet | `NUGET_PACKAGES` | `NUGET_HTTP_CACHE_PATH`, `NUGET_PLUGINS_CACHE_PATH` (and `DOTNET_CLI_HOME`, the private home) |
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
   per attempt. Doctor writes nothing outside its scratch directory: a cache
   that does not exist yet is replaced by an empty scratch stand-in.

## Consequences

- A check no longer needs registry hosts in its own `network_hosts` to build:
  the install fills the cache once per repository and every check reads it.
  A check that needs a dependency the install did not fetch fails, with the
  tool's own "read-only" or "not permitted" message, instead of quietly
  downloading it.
- Repositories whose only lockfile is not npm's need
  `dependencies.install_command` (`cargo fetch --locked`, `dotnet restore
  --locked-mode`, a venv plus `pip install -r requirements.txt`, `./gradlew
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
