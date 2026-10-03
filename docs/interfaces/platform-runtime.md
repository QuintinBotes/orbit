# Platform runtime interfaces: storage, service, process control, containers, dependencies

Verified 2026-10-03 on macOS 27.0.1 (build 26A434, arm64) with Node v22.18.0 (nvm), npm 11,
Docker 29.4.0 client and server (context `orbstack`, cgroup v2), and the libuv bundled with Node (1.51.0).
Evidence tags: **[local: `cmd`]** means local command output; **[doc: URL]** means an official doc page.
Anything not confirmed either way is marked **UNVERIFIED**.

Two Node binaries are on PATH: `~/.nvm/versions/node/v22.18.0/bin/node` (first) and
`/opt/homebrew/bin/node` at **v26.8.2** [local: `which -a node; /opt/homebrew/bin/node -v`].
A service started with a minimal PATH could pick up the wrong one (see §2 and §7).

---

## 1. `node:sqlite` on Node 22.18

### Availability and warning
- No flag is needed. `require('node:sqlite')` works and exports `DatabaseSync, StatementSync, constants, backup` [local: `node -e "console.log(Object.keys(require('node:sqlite')))"`]. Bundled SQLite is **3.50.2** [local: `select sqlite_version()`].
- The module was unflagged in v22.13.0 and is "still experimental" (Stability 1.1, Active development). `--no-experimental-sqlite` disables it [doc: https://nodejs.org/docs/latest-v22.x/api/cli.md, `--no-experimental-sqlite` history] [local: `node --help | grep sqlite`].
- The first load prints the following to stderr, once per process:
  `(node:PID) ExperimentalWarning: SQLite is an experimental feature and might change at any time` [local].
- Type stripping is on by default in 22.18 (`node file.ts` works and prints no type-stripping warning) [doc: cli.md `--no-experimental-strip-types`, "v22.18.0 Type stripping is enabled by default"] [local: `node h.ts`].

### Suppressing the warning (all tested)
| Method | Result | Notes |
|---|---|---|
| `node --disable-warning=ExperimentalWarning x.mjs` | suppressed; other warnings still print | Added in v21.3.0/v20.11.0, Stability 1.1. Allowed in `NODE_OPTIONS` [doc: cli.md] |
| `NODE_OPTIONS=--disable-warning=ExperimentalWarning` | suppressed | Use in launchd `EnvironmentVariables` or systemd `Environment=` |
| `#!/usr/bin/env -S node --disable-warning=ExperimentalWarning` | suppressed on macOS | `env -S` on Linux: UNVERIFIED (coreutils ≥ 8.30 has it, busybox unknown) |
| `--no-warnings` | suppresses **all** warnings | Too broad. With it, `process.listeners('warning').length` is 0; without it, 1 [local] |
| Programmatic filter (review-voice `src/warnings.ts`) | suppressed; others re-emitted through the original handlers | Works even when the static `import 'node:sqlite'` runs *before* the filter is installed (ESM and CJS both tested), because the warning is emitted on a later tick [local: `a_static_late.mjs`, `g.cjs`] |

The review-voice pattern, which is safe to copy:
```ts
export function suppressSqliteExperimentalWarning(): void {
  const handlers = process.listeners('warning');
  process.removeAllListeners('warning');
  process.on('warning', (w: Error) => {
    if (w.name === 'ExperimentalWarning' && /SQLite/i.test(w.message)) return;
    if (handlers.length > 0) { for (const h of handlers) h(w); return; }
    process.emitWarning(w.message, w.name);
  });
}
```
The filter must be called synchronously at the top level of the entry module. review-voice calls it after its imports, at the bottom of `cli.ts`, and that is fine.

### API surface (22.18) [doc: https://nodejs.org/docs/latest-v22.x/api/sqlite.html] [local: prototype listing]
- `new DatabaseSync(path, opts)` options: `open` (true), `readOnly` (false), `enableForeignKeyConstraints` (**true**), `enableDoubleQuotedStringLiterals` (false), `allowExtension` (false), `timeout` (ms, default 0, **added v22.16.0**), `readBigInts`, `returnArrays`, `allowBareNamedParameters` (true), `allowUnknownNamedParameters` (false).
  - Local checks: `timeout:1234` sets `PRAGMA busy_timeout` to 1234, the default is 0, and `foreign_keys` is 1 by default. `returnArrays` and `readBigInts` in the constructor work (`[1n, 2n]`) [local].
  - The doc fetch claimed that `readBigInts`, `returnArrays` and both `allow*` options were "added v22.5.0" as constructor options. That date is **UNVERIFIED**. It does not matter here because they work on 22.18 [local].
- `DatabaseSync` methods: `open() close() exec(sql) prepare(sql) function() aggregate() createSession() applyChangeset() enableLoadExtension() loadExtension() location()`, the getters `isOpen` (v22.15) and `isTransaction` (v22.16), and `[Symbol.dispose]`.
- **There is no `db.transaction()` helper**, unlike better-sqlite3 [local: prototype listing]. Use `exec('BEGIN IMMEDIATE')` / `exec('COMMIT')` / `exec('ROLLBACK')`.
- `StatementSync` methods: `run() get() all() iterate() columns() setReadBigInts() setReturnArrays() setAllowBareNamedParameters() setAllowUnknownNamedParameters()`, plus the getters `sourceSQL` and `expandedSQL`.
- `run()` returns `{ changes, lastInsertRowid }` as number, or bigint when `readBigInts` is set. Local result: `{ lastInsertRowid: 1, changes: 1 }`.
- `get()` returns a null-prototype object, or `undefined` when there is no row. `all()` and `iterate()` return null-prototype objects.
- Parameters: positional (`?`), `:name`, `$name`, or `@name`. A bare key (`{name}`) binds to a prefixed parameter by default [local].
- `INSERT ... RETURNING id` works through `.get()` [local].
- Errors are `Error` with `code: 'ERR_SQLITE_ERROR'`, `errcode` (the **extended** SQLite code) and `errstr`. Observed values [local]:
  - busy: `errcode 5`, `errstr 'database is locked'`
  - busy snapshot: `errcode 517`, same message
  - NOT NULL violation: `1299`
  - STRICT type violation: `3091`, `"cannot store TEXT value in INTEGER column u.a"`
- Compile options include `ENABLE_FTS5`, `ENABLE_MATH_FUNCTIONS`, `ENABLE_SESSION`, `ENABLE_COLUMN_METADATA`, `ENABLE_RTREE`, `DEFAULT_SYNCHRONOUS=2`, `DEFAULT_WAL_SYNCHRONOUS=2` and `THREADSAFE=1` [local: `PRAGMA compile_options`].

### STRICT and JSON functions [local]
- `CREATE TABLE ... ) STRICT` works. Inserting TEXT into an INTEGER column throws 3091. Inserting an INTEGER into a TEXT column is accepted and converted (standard SQLite STRICT behaviour).
- JSON is built in: `json_extract`, `json_valid`, `json_object`, `json_array`, `json_each`, the `->>` operator, and `jsonb()`/`json()` all work.

### WAL, busy timeout, and two-process contention [local: `worker.cjs`, two concurrent processes, 200 read-modify-write transactions each, transaction held 2 ms]
| Config | Result |
|---|---|
| `timeout:5000`, `BEGIN IMMEDIATE` | 400/400 committed, counter = 400, 0 errors |
| `timeout:5000`, deferred `BEGIN` (read, then write) | 178/400 committed. Errors were `errcode 5` and `errcode 517` (`SQLITE_BUSY_SNAPSHOT`), raised **immediately despite busy_timeout**. No lost updates (counter equals commits) |
| `timeout:0`, `BEGIN IMMEDIATE` | The losing process failed all 200 at once (`errcode 5`), and even schema setup threw `database is locked` |

- `PRAGMA journal_mode=WAL` is persistent in the file: a new connection reads `wal`. `PRAGMA synchronous` is per connection: a new connection reads 2 (FULL) [local].
- The `-wal` and `-shm` files disappear when the last connection closes cleanly [local: `ls c.db*`].
- **Rule:** every write transaction uses `BEGIN IMMEDIATE`, and every connection sets `timeout` (≥ 5000). Wrap transactions in try/catch, run `if (db.isTransaction) db.exec('ROLLBACK')` on failure, and retry a bounded number of times on `errcode` 5 or 517.

Recommended open sequence:
```ts
const db = new DatabaseSync(path, { timeout: 5000 });   // requires ≥22.16, or use PRAGMA busy_timeout=5000
db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
function tx<T>(fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { if (db.isTransaction) db.exec('ROLLBACK'); throw e; }
}
```
`synchronous=NORMAL` under WAL is SQLite's documented durability/performance trade-off. Whether to use it here is a design choice; the setting itself was verified locally.

---

## 2. macOS launchd user agents (macOS 27.0.1)

### Plist keys [local: `man launchd.plist`]
| Key | Type | Verified semantics |
|---|---|---|
| `Label` | string | Required; unique job id |
| `ProgramArguments` | array | argv for execvp. Without `Program`, the first element may be absolute, or relative and resolved via `_PATH_STDPATH` = `/usr/bin:/bin:/usr/sbin:/sbin` [local: SDK `paths.h`] |
| `RunAtLoad` | bool | Default false. The man page discourages it ("speculative job launches"), but it is needed for a login-started daemon |
| `KeepAlive` | bool or dict | Default false. The dict form `{SuccessfulExit:false}` restarts only after a non-zero exit, and implies RunAtLoad. `Crashed:true/false`, `PathState` and `OtherJobEnabled` also exist. When several dict keys are present, launchd ORs them |
| `ThrottleInterval` | int (s) | Default: no respawn more often than every 10 s |
| `ExitTimeOut` | int (s) | Time from SIGTERM to SIGKILL on stop. 0 means infinite and must not be used |
| `StandardOutPath` / `StandardErrorPath` | string | The file is created if missing. **Verified (gaps V7): launchd also creates missing parent directories.** `…/newdir/sub/out.log` was created with mode `drwxr--r--`. Pre-create the dirs anyway if you want 0700 |
| `EnvironmentVariables` | dict of strings | Non-string values are ignored |
| `WorkingDirectory` | string | chdir before exec |
| `ProcessType` | string | `Background`, `Standard` (same as unset), `Adaptive` or `Interactive`. Unset means light CPU and I/O throttling |
| `AbandonProcessGroup` | bool | By default launchd **kills the job's whole process group when the job dies**. Set true only if workers must outlive the controller |
| `Umask`, `LimitLoadToSessionType`, `Disabled` | | Present in the man page; optional |

- Location: `~/Library/LaunchAgents/<Label>.plist`. The file must be owned by the user and must not be group- or world-writable [local: `man launchctl`, LEGACY `load` section].
- `plutil -lint <plist>` validates syntax, and `plutil -convert json -o - <plist>` dumps it [local; a sample plist linted OK and was not installed].

### launchctl (modern subcommands) [local: `launchctl help`, `man launchctl`]
```sh
UID=$(id -u); L=dev.orbit.controller; P=~/Library/LaunchAgents/$L.plist
launchctl bootstrap gui/$UID "$P"        # load and start (RunAtLoad/KeepAlive)
launchctl bootout   gui/$UID/$L          # stop and unload (or: bootout gui/$UID "$P"); add --wait to block
launchctl kickstart -k gui/$UID/$L       # -k kills the running instance first; -p prints the PID
launchctl print     gui/$UID/$L          # human-readable; "NOT API in any sense"; do not parse
launchctl kill SIGTERM gui/$UID/$L
launchctl enable|disable gui/$UID/$L     # persistent across boots
launchctl print-disabled gui/$UID
launchctl error <code>                   # e.g. 5 = "Input/output error", 37 = "Operation already in progress", 113 = "Could not find specified service"
```
- `load` and `unload` are legacy; the man page recommends `bootstrap` | `bootout` | `enable` | `disable` instead.
- `launchctl print gui/$UID/<missing>` exits **113** with `Could not find service "<label>" in domain for user gui: 501` [local]. **A non-zero exit from `print` is a reliable "not loaded" probe. Do not parse the output.**
- **Verified (gaps V7)**, using an ephemeral agent bootstrapped from a temp plist (not from `~/Library/LaunchAgents`) and booted out afterwards:
  - The first `bootstrap` exited 0.
  - Bootstrapping the same label again printed `Bootstrap failed: 5: Input/output error` and exited **5**.
  - `print` exited 0 while the job was loaded and **113** after `bootout`.
  - `bootout` of a label that is not loaded printed `Boot-out failed: 3: No such process` and exited **3**.
  
  The install routine should be `bootout` (accept exit 3), then `bootstrap`.
- Login-item or "Background Items Added" user notifications on macOS 13+: **UNVERIFIED**.

### Sample plist (linted, not installed)
```xml
<dict>
  <key>Label</key><string>dev.orbit.controller</string>
  <key>ProgramArguments</key><array>
    <string>/ABS/PATH/TO/node</string><string>/ABS/orbit/dist/orbit.mjs</string><string>service</string><string>run</string></array>
  <key>WorkingDirectory</key><string>/Users/me</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>/ABS/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_OPTIONS</key><string>--disable-warning=ExperimentalWarning</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/Users/me/Library/Logs/orbit/controller.out.log</string>
  <key>StandardErrorPath</key><string>/Users/me/Library/Logs/orbit/controller.err.log</string>
</dict>
```

---

## 3. Linux systemd --user (doc-verified only; there is no Linux host here)
Sources:
- https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
- https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html
- https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html
- https://www.freedesktop.org/software/systemd/man/latest/sd_notify.html
- https://www.freedesktop.org/software/systemd/man/latest/systemd-notify.html
- https://www.freedesktop.org/software/systemd/man/latest/loginctl.html
- https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html

All were fetched as systemd 262 docs.

```ini
# ~/.config/systemd/user/orbit.service   (user unit search path includes ~/.config/systemd/user/*)
[Unit]
Description=Orbit controller
StartLimitIntervalSec=300
StartLimitBurst=10

[Service]
Type=exec
ExecStart=/ABS/PATH/TO/node /ABS/orbit/dist/orbit.mjs service run
WorkingDirectory=%h
Environment=NODE_OPTIONS=--disable-warning=ExperimentalWarning
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed
# Optional watchdog: requires WATCHDOG=1 pings, see below
# WatchdogSec=60
# NotifyAccess=all

[Install]
WantedBy=default.target
```

Directive semantics:
- `Restart=` takes `no` (default), `on-success`, `on-failure`, `on-abnormal`, `on-watchdog`, `on-abort` or `always`.
  - `on-failure` restarts on a non-zero exit, on death by signal, on an operation timeout, and on a watchdog timeout.
  - SIGHUP, SIGINT, SIGTERM and SIGPIPE count as **clean** exits and are not restarted.
  - A stop requested through systemd is never restarted.
- `RestartSec=` defaults to **100ms**, so always set it. `RestartSteps=` and `RestartMaxDelaySec=` provide exponential backoff.
- `StartLimitIntervalSec=` and `StartLimitBurst=` belong in **[Unit]**.
- `Type=exec` treats the unit as started once the binary has been executed; the docs prefer it over `simple`.
- `KillMode=` defaults to `control-group`, which kills every process in the cgroup on stop. `mixed` sends SIGTERM to the main process and SIGKILL to the rest.
- `WatchdogSec=` requires periodic `sd_notify("WATCHDOG=1")`. On a miss the service gets SIGABRT and restarts under `on-failure`. The timeout is passed in `WATCHDOG_USEC`. `NotifyAccess` is implicitly `main` when it is not set.
- **Node cannot send sd_notify natively.** `dgram.createSocket('unix_dgram')` throws `ERR_SOCKET_BAD_TYPE` and only `udp4`/`udp6` are valid [local].
  - Options are spawning `systemd-notify WATCHDOG=1` with `NotifyAccess=all` (the docs say a child sender requires `all`), or a native addon.
  - Recommendation: **skip WatchdogSec in v1** and use an in-database heartbeat plus external staleness detection.

Commands:
```sh
systemctl --user daemon-reload
systemctl --user enable --now orbit.service
systemctl --user restart|stop|status orbit.service
journalctl --user-unit=orbit.service
loginctl enable-linger "$USER"   # user manager starts at boot and survives logout (v233+); otherwise services die at logout
```
Exit codes of `systemctl` and the `is-active` probe semantics: **UNVERIFIED** (not fetched).

---

## 4. Process control from Node (macOS, local)

### Spawning, signalling and liveness
- `spawn(cmd, args, { detached: true, stdio: 'ignore' })` followed by `child.unref()`.
  - The docs say the child "will be made the leader of a new process group and session" (setsid) [doc: https://nodejs.org/docs/latest-v22.x/api/child_process.html].
  - Locally, `ps -o pid=,ppid=,pgid=` showed **pgid == child.pid**, and grandchildren inherited that pgid [local: `proc.mjs`].
  - On macOS, `ps -o sess=` prints 0, which is not useful.
- **Group kill:** `process.kill(-pgid, 'SIGTERM')` killed the shell and both grandchild `sleep`s. Afterwards `process.kill(-pgid, 0)` threw `ESRCH` [local].
- `subprocess.kill()` signals only the child, never the group [doc].
- **Liveness:** `process.kill(pid, 0)` returns normally if the process exists [doc: process.kill]. Observed errors [local]:
  - `ESRCH` means no such process (tested with pid 999999).
  - `EPERM` means the process exists but belongs to someone else (pid 1).
- **Zombie gotcha:** `kill(pid, 0)` **succeeds for a zombie (`<defunct>`, stat `Z`)** [local]. Confirm with `ps -o stat=` when it matters. Node reaps its own direct children automatically; the zombie case only appears with foreign parents.

### Start time for PID-reuse detection
- **macOS:** `LC_ALL=C TZ=UTC ps -o lstart= -p PID` returned `"Sat Oct  3 09:37:05 2026"`. It has 1-second resolution, and its `%c` format depends on locale and timezone, so always pin `LC_ALL=C TZ=UTC` [local: `man ps`: "lstart ... using the '%c' format"].
  - For a dead PID it prints nothing and **exits 1** [local].
  - `etime` is supported, but **`etimes` is not supported on macOS** (`ps: etimes: keyword not found`) [local].
- **Linux:** `/proc/<pid>/stat` field 22 is `starttime` in clock ticks since boot (divide by `sysconf(_SC_CLK_TCK)`, which was 100 in the container) [doc: https://man7.org/linux/man-pages/man5/proc_pid_stat.5.html].
  - Field 2, `comm`, is parenthesized and may contain spaces, so split **after the last `)`**. Field 22 is then index 19 (0-based) of the remainder.
  - Verified inside alpine: the line `6 (sleep) S 1 1 1 0 -1 ... 0 6762797 ...` gave field 22 = `6762797` [local: docker alpine].
  - Absolute time is `btime` (from `/proc/stat`) + starttime / CLK_TCK.
- Store the fingerprint `{pid, pgid, startTime: rawString, cmdHash}`. Before signalling, compare it **as a string**; if the fingerprint changed, the PID was reused.

### Atomic file writes [local: `atomic.mjs`]
```ts
const tmp = join(dir, `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
const fh = await open(tmp, 'wx', 0o600); await fh.writeFile(data); await fh.sync(); await fh.close();
await rename(tmp, path);                       // atomic only within one filesystem
const d = await open(dir, 'r'); await d.sync(); await d.close();   // persist the directory entry; works on macOS (APFS)
```
- In a test with 200 rewrites of a 200 KB file against 2000 concurrent reads, **no torn reads** occurred, and no `.tmp` files were left behind [local].
- On macOS, libuv `fsync` uses `fcntl(F_FULLFSYNC)`, falling back to `F_BARRIERFSYNC`, then `fsync`. On Linux it is plain `fsync` [doc: libuv v1.51.0 `src/unix/fs.c` `uv__fs_fsync`, which is the version Node reports in `process.versions.uv`]. So `fh.sync()` is a real durability barrier on macOS.
- `writeFile(path, data, { flush: true })` is accepted and fsyncs, but it is **not** atomic. Use it only for append-style logs [doc: fs.md "flush" option] [local].

---

## 5. Docker via OrbStack: hardened check runner [local: `docker run --help`, runs below]
- `docker run --rm alpine true` takes 2.7 s on the first run (including the pull of `alpine:latest`) and **0.27–0.37 s warm** [local].
- The engine is OrbStack: cgroup v2, `cgroupfs` driver, built-in seccomp, 10 CPUs, about 16.8 GB RAM [local: `docker info`].

Verified flag set (all flags exist in `docker run --help` and were exercised in a single run):
```sh
docker run --rm --pull never --name orbit-chk-<id> --label orbit.run=<run-id> \
  --network none --memory 256m --memory-swap 256m --cpus 1 --pids-limit 64 \
  --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --cap-drop ALL --security-opt no-new-privileges \
  --user "$(id -u):$(id -g)" --init --stop-timeout 5 \
  -v "$WS:/work:ro" -v "$OUT:/out:rw" -w /work  IMAGE CMD...
```
Observed inside the container:
- `uid=501 gid=20`.
- Writing `/work` or `/etc` failed with `Read-only file system`.
- `/tmp` and `/out` were writable, and output files on the host were owned by the invoking user.
- Executing from `/tmp` failed with `Permission denied` because of `noexec`.
- `wget` gave `Network unreachable`, and only the loopback interface existed.
- `memory.max=268435456`, `pids.max=64`, `cpu.max=100000 100000`.
- `CapEff: 0000000000000000`, `NoNewPrivs: 1`.

Flag notes:
- `--memory-swap` equal to `--memory` means no swap. `-1` means unlimited swap.
- `--pids-limit -1` means unlimited.
- `--pull` takes `always`, `missing` or `never`.
- `--user` takes `<name|uid>[:<group|gid>]`.
- `--init` runs an init that forwards signals and reaps zombies.

Exit codes [local]:
| Situation | Exit |
|---|---|
| Container exit passes through | `exit 3` gives 3 |
| Executable not found | 127 |
| Unknown docker flag | 125 |
| Missing image with `--pull never` | 125 |
| OOM | 137, and `docker inspect -f '{{.State.OOMKilled}}'` gives `true` (only without `--rm`) |
| pids limit hit | `sh: can't fork: Resource temporarily unavailable` (the container still exits 0) |

**Gotcha:**
- **SIGKILL of the `docker run` CLI leaves the container running.** `docker ps` showed it `Up` [local].
- SIGTERM to the CLI (default sig-proxy, with `--init`) stopped the container, and the CLI exited 143 [local].
- So always pass `--name` and `--label`. Enforce timeouts with `docker kill <name>` or `docker rm -f <name>` (about 0.2 s), and reconcile orphans with `docker ps -a --filter label=orbit.run=<id>`.

---

## 6. npm dependencies [local: `npm view <pkg> version license engines dependencies`]
| Need | Package | Version | License | Notes |
|---|---|---|---|---|
| YAML | `yaml` | 2.9.1 | ISC | Ships its own types. CJS on the `node` export condition, ESM at `browser/`. Node ≥ 14.6 |
| JSON Schema 2020-12 | `ajv` | 8.20.0 | MIT | Use `ajv/dist/2020.js`. 4 small dependencies |
| Formats | `ajv-formats` | 3.0.1 | MIT | Peer to ajv 8 |
| Globs | `picomatch` | 4.0.7 | MIT | Add `@types/picomatch` 4.0.3 (MIT). Node ≥ 12 |
| CLI args | `node:util` `parseArgs` | built in | | Stable since v20.0.0 [doc: util.md] |
| CLI args (alternative) | `commander` | 15.0.0 | MIT | ESM-only (`type: module`). **engines node ≥ 22.12.0** |

All five installed together came to 10 packages and 4.5 MB [local].

Behaviour checks [local: `t.mts`]:
- **yaml**
  - Duplicate keys throw `YAMLParseError` with code `DUPLICATE_KEY`.
  - `parseDocument()` collects `errors[]` with `code` and `linePos` (e.g. `BAD_INDENT` at line 2).
  - `!!js/function` is **not executed**: it resolves to a plain string with a `TAG_RESOLVE_FAILED` YAMLWarning printed through `process.emitWarning`. Pass `{ logLevel: 'error' }` to silence it, or inspect `doc.warnings`.
- **ajv**
  - `new Ajv2020({ allErrors: true, strict: true })` plus `addFormats(ajv)` validates `$schema: https://json-schema.org/draft/2020-12/schema`, `unevaluatedProperties`, `prefixItems`, `format: uuid` and `format: date-time`.
  - Errors take the form `instancePath + keyword`.
  - Under ESM, the CJS default needs `(mod as any).default ?? mod` interop for both ajv and ajv-formats.
  - **Strict-mode gotchas:** `prefixItems` without matching `minItems` throws at compile time (`strictTuples`), and unknown keywords throw. A draft-07 `$schema` under `Ajv2020` throws `no schema with key or ref "http://json-schema.org/draft-07/schema#"`, so use 2020-12 for every schema.
- **picomatch**
  - **An array with `!negation` is OR'd.** `picomatch(['src/**/*.ts','!src/**/*.test.ts'])('src/a/b.test.ts') === true`, which means it is broken as an exclude.
  - Use `picomatch(include, { ignore: excludes })` instead (gives `true`/`false` as expected), or separate matchers.
  - Dotfiles are not matched unless `{ dot: true }`.
  - Backslashes are not separators unless `{ windows: true }`.
- **parseArgs**
  - Throws `ERR_PARSE_ARGS_UNKNOWN_OPTION` in strict mode.
  - Supports `allowPositionals`, `default`, `tokens`, and negative options (v22.4+).

**Bundling (esbuild 0.28.2, `--format=esm --platform=node --target=node22`)** [local]:
- A plain ESM bundle of yaml, ajv, ajv-formats, picomatch, commander and `node:sqlite` **crashes at load** with `Dynamic require of "process" is not supported`. The cause is CJS dependencies (`yaml` dist) calling `require` on builtins (`process`, `buffer`).
- Fix A, which review-voice uses: alias `yaml` to its ESM `browser/dist/index.js`.
- Fix B, generic and tested: add the banner `import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);`.
- With fix B the bundle is about 750 KB unminified and runs [local].
- `node:sqlite` is left external automatically: the bundle contains `import { DatabaseSync } from "node:sqlite"` [local: review-voice dist].

---

## 7. Implications for Orbit
1. **Node floor.** Set `engines.node` to **`>=22.16`**; it is `>=22.13` today. The `timeout` constructor option, `isTransaction` and `columns()` arrive in 22.16, and `@types/node` 22.20.5 already types them. If 22.13 must stay, use `PRAGMA busy_timeout=5000` and track transaction state manually. `orbit doctor` should report `process.version` and the result of an in-memory `DatabaseSync` probe, loaded lazily via `require` as review-voice's `doctor.ts` does.
2. **Warning suppression.** Install the review-voice filter at the top of the CLI entry, and also set `NODE_OPTIONS=--disable-warning=ExperimentalWarning` in the service definitions. Avoid `--no-warnings`.
3. **Storage discipline.**
   - Use one `DatabaseSync` per process with `{ timeout: 5000 }`, `journal_mode=WAL` and `foreign_keys` on (already the default).
   - **All writes go through `BEGIN IMMEDIATE`.** Deferred transactions produced immediate 5/517 errors under contention.
   - Retry 5 and 517 with bounded jittered backoff, use STRICT tables and JSON columns, and `RETURNING` for ids.
   - Keep `state.sqlite` on the local disk and **never inside a container bind mount**. WAL relies on shared-memory locking, and its behaviour across the OrbStack VM boundary is UNVERIFIED.
   - With git worktrees, keep a single DB in the primary checkout's `.orbit/`, not one per worktree.
4. **Service definitions.**
   - Generate a launchd plist (macOS) or a systemd user unit (Linux) with an **absolute `process.execPath`**, because PATH holds both nvm Node 22.18 and Homebrew Node 26.8.2.
   - Use an explicit `PATH`, absolute log paths with pre-created directories, `KeepAlive={SuccessfulExit:false}` or `Restart=on-failure`, `ThrottleInterval` or `RestartSec` ≥ 5, and `ExitTimeOut` or `TimeoutStopSec` = 30.
   - Install by `bootout` (ignore errors), then `bootstrap`. Probe with the exit code of `launchctl print gui/$UID/<label>` (0 means loaded, 113 means missing). Never parse the output.
   - On Linux, `doctor` must warn when linger is off.
5. **Worker processes vs the service manager.** launchd kills the job's process group, and systemd `KillMode=control-group` kills the cgroup, whenever the controller dies or stops. Workers spawned `detached:true` get a new pgid, so they escape the launchd group kill, but they **remain in the systemd cgroup**.
   - **Verified on launchd (gaps V7).** After `launchctl kill SIGKILL gui/$UID/<label>` on a Node job, the job's ordinary child (same pgid) was gone. Its `detached:true` child (own pgid) **survived**, reparented to PID 1.
   - So on macOS, detached workers outlive a controller crash by default. Option (a) below is not automatic on macOS; it must be enforced by reconciliation. Two consistent options:
   - (a) Accept that workers die with the controller and reconcile from durable state on restart. This is simpler and recommended.
   - (b) Use `AbandonProcessGroup=true` with `KillMode=process`, which is discouraged by the docs.
   With (a), reconciliation still needs fingerprints for the crash window.
6. **Orphan reconciliation.**
   - Persist `{pid, pgid, startTime(raw), cmdHash, containerName}` in a lease row before the spawn completes.
   - On startup, a PID counts as alive only when `kill(pid,0)` succeeds, the start time matches, and `ps -o stat=` is not `Z`.
   - Terminate with `kill(-pgid,'SIGTERM')`, wait for the grace period, then `SIGKILL`.
   - For containers, use `docker rm -f` by name or label.
7. **Heartbeat and watchdog.** Write `heartbeat_at` and `last_progress_at` to SQLite on a timer, and have `orbit status`/`doctor` flag staleness. Skip systemd `WatchdogSec` in v1, since Node has no sd_notify without `systemd-notify` and `NotifyAccess=all`.
8. **Atomic artifacts.** Write `contract.json`, `policy.json` and `final.md` with temp + `fh.sync()` + `rename` + directory fsync. Write `decisions.jsonl` with `appendFile` and `flush:true`, never with rename.
9. **Evidence runner (container mode).**
   - Use the §5 flag set. Defaults: `--network none` (opt-in network per check), the repo worktree as a read-only mount, a separate writable `/out` for artifacts, and a non-root `--user`.
   - Pass `--pull never` after an explicit `docker pull` during preflight. Missing images then fail fast with exit 125, which must be classified as an infrastructure failure, distinct from check failure.
   - Treat 137 with `OOMKilled` as a resource failure (inspect before `--rm` removes the container, or skip `--rm` and remove after inspecting).
   - Enforce timeouts with `docker kill` by name, not by killing the CLI.
10. **Dependencies.**
    - Use `yaml`, `ajv` (Ajv2020) with `ajv-formats`, and `picomatch` with `ignore:` for excludes.
    - For CLI parsing prefer **`node:util` `parseArgs`**: zero dependencies, stable, enough for ~9 subcommands with a small dispatcher. `commander` 15 is acceptable but adds an ESM-only dependency and an engines floor of 22.12.
    - Bundle with esbuild using the `createRequire` banner, or alias yaml to its ESM build as review-voice does. Add a CI smoke test that executes `dist/orbit.mjs --help` so a broken bundle fails the build.

## UNVERIFIED items (summary)
- ~~Whether launchd creates missing parent directories~~: resolved, it does (gaps V7).
- ~~The exact `launchctl bootstrap` error when a label is already loaded~~: resolved, `Bootstrap failed: 5: Input/output error`, exit 5 (gaps V7).
- macOS 13+ "Background Items" login notifications for user agents.
- `env -S` shebang support on Linux distributions (busybox).
- `systemctl` exit-code semantics.
- Any execution of the systemd unit. All systemd content is doc-only; there is no Linux host or systemd container.
- The "added v22.5.0" dates for the `readBigInts`, `returnArrays` and `allow*` constructor options (from summarized docs). They work on 22.18 regardless.
- WAL safety across OrbStack/virtiofs bind mounts (not tested; avoid by design).
