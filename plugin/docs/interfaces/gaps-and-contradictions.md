# Interface gaps, contradictions, and completeness-critic verification

Written 2026-10-03 by the completeness-critic pass over the five files in this folder, measured against `orbit-complete-spec.md`.
Environment: Claude Code 2.1.288, codex-cli 0.153.4, macOS 27.0.1 (build 26A434), Node v22.18.0, gitleaks 8.30.1, npm 11.6.0, Playwright 1.63.0.

**Evidence rules**
- `[mock]` means a local mock API in the session scratchpad with a fake key. No paid model calls were made.
  - For Claude, the mock speaks the Anthropic Messages API (`ANTHROPIC_BASE_URL=http://127.0.0.1:47811`).
  - For Codex, it speaks the OpenAI Responses API, configured as a custom `model_providers.mock`.
- `[local]` means a local command run. `[doc]` means an official doc page.
- No user config was modified. Every Claude or Codex run used a fresh `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (`mktemp -d`).
- The one launchd probe bootstrapped from a temp plist and was booted out afterwards.

The mocks and harness are in `<scratchpad>/gap/` (`mock2.js`, `respmock.js`, `cc.sh`, `ccsig.py`). That location is ephemeral; copy the files into `tests/` if you want them for integration and fault-injection tests.

---

## 1. Coverage matrix: spec requirement vs interface file

| Spec need | File | Status after this pass |
|---|---|---|
| Plugin manifest, skills, agents, hooks (§3, §4) | plugin | Verified. Gap: plugin-agent `permissionMode`/`hooks`/`mcpServers` being ignored at runtime is documented but never observed |
| Headless worker launch, permissions, result parsing (§3 Claude adapter) | headless | Verified. Fixes in place (V1–V4, V9) |
| Worker isolation from user config, plugins and repo config (§5 "repository instructions … untrusted") | none | **Was missing. Now verified (V4)** |
| Turn and budget caps (§5 scheduler, §17 "exhausted budgets") | headless | Was UNVERIFIED. **Now verified (V1)**: `--max-budget-usd` overshoots |
| Expired or invalid credentials → truthful blocker (§4, §14, scenario 12) | headless, codex | Claude: **verified (V2)**. Codex: messages verified from source only; JSONL surfacing UNVERIFIED |
| Model registry, alias → ID, limits (§8) | headless | `haiku` mapping was UNVERIFIED; **now verified (V3)**. `maxOutputTokens` semantics **corrected** |
| Isolation: FS, network, CPU, mem, pids (§5) | headless (srt), platform (docker) | srt-wrapped `claude` was UNVERIFIED; **now verified (V5)**, with two blockers found |
| Cross-provider review: success path, schema (§12) | codex | Was UNVERIFIED; **now verified against a mock (V6)**. Codex does not validate output locally |
| Persistent service and orphan handling (§4) | platform | launchd parent dirs, re-bootstrap and child survival were UNVERIFIED; **now verified (V7)** |
| UI runner cancellation (§13, §17 "cancellation during checks") | playwright | SIGINT was UNVERIFIED; **now verified (V8)** |
| Delivery credentials (§5 "separate delivery credentials", §15) | playwright-github | Push permission now doc-verified (V8). Check-runs permission still UNVERIFIED |
| Claude worker cancellation and resume (§14, scenario 20) | headless | Doc-only before; **now verified (V9)**: SIGINT exits 0 with no result |
| **Static security gate: secret scan, SAST (§5 gate table)** | **none** | **Was missing.** Secret scan verified with gitleaks (V10). **SAST: no tool installed (semgrep absent)**, UNVERIFIED |
| **Dependency gate: vulnerability and license policy (§5 Baseline)** | **none** | **Was missing.** `npm audit --json` verified (V11). License policy tooling UNVERIFIED |
| `install_scripts: deny-unless-allowlisted` (§5 config) | none | **Missing.** `npm ci --ignore-scripts` behaviour not probed (UNVERIFIED). The plugin doc covers only marketplace auto-install |
| `orbit` CLI on the user's PATH outside Claude (§4 Runtime CLI) | plugin (`bin/` only applies inside Claude's Bash tool) | **Missing.** npm `-g` / `npm link` distribution not verified |
| Claude workers in a Docker container (§3 "Container or equivalent") | none | **Missing.** Not run. The Linux container cannot use the macOS Keychain, so env credentials are required (see V5) |
| Wall-clock timeouts for checks | platform | **Gotcha [local]: macOS has no `timeout`/`gtimeout`** (`which timeout gtimeout` → not found). Use Node timers plus process-group kill, never `timeout` |

---

## 2. Contradictions between files, and how they were resolved

| # | Contradiction | Resolution |
|---|---|---|
| C1 | The headless worker template used `--setting-sources user`. The plugin doc recommends `--plugin-dir` + `--settings` so that enforcement doesn't depend on user state. | **Verified (V4):** `user` loads user hooks **and user-enabled plugins**. Here that means `codex@openai-codex` with a 900 s Stop hook (`$CLAUDE_CONFIG_DIR/plugins/cache/openai-codex/codex/1.0.6/hooks/hooks.json`). **Fixed in both files** to `--setting-sources "" --strict-mcp-config --plugin-dir <orbit> --settings <run>` |
| C2 | headless §6 wants detached `claude -p` workers that survive a controller crash. platform §7.5 recommends that workers die with the controller (option a). | **Verified (V7):** under launchd, detached children survive the job's SIGKILL and are reparented to PID 1, while non-detached children die. systemd kills the whole cgroup (doc). The behaviour differs by OS. **Lead decision needed**; see Implications 2. Platform doc annotated |
| C3 | headless says `--bare` "skips plugins". The plugin doc saw `--plugin-dir` skills load under `--bare`. | Not a real conflict: both agree **hooks never run under `--bare`**, and "plugins" there means installed plugins. No edit needed; just never use `--bare` for policy-enforced workers |
| C4 | headless §7.2 classified auth failures by result text (`Failed to authenticate`). | **Verified (V2):** the same 401 produced `Invalid API key · Fix external API key` (the text documented in `errors#invalid-api-key`). Text is unstable. **Fixed** to use `api_error_status`, `system/api_retry.error`, `assistant.error` |
| C5 | headless §1.3 called `ModelUsage.maxOutputTokens` a "runtime model limit", while the model table says Haiku has 64K and Fable 128K max output. | **Verified (V3):** `maxOutputTokens` is Claude Code's request `max_tokens` (haiku 32000, fable 64000). **Fixed** |
| C6 | The plugin doc table says `CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/<id>` (as the doc does); the probe shows `$CLAUDE_CONFIG_DIR/plugins/data/<id>`. | **Fixed** the table: follow `CLAUDE_CONFIG_DIR`, which is `$CLAUDE_CONFIG_DIR` on this machine |
| C7 | headless §7.5 suggests wrapping the whole `claude` in srt, with the nesting question left UNVERIFIED. | **Verified (V5):** it works only with env credentials and extra writable paths. Nested Seatbelt fails. **Fixed** |
| C8 | The Codex docs list `--full-auto` and `-a`, and the codex file says exec rejects both. | Spot-checked; the codex file is right (S1) |
| C9 | The playwright file listed `use.screenshot` as `off|on|only-on-failure`. | **Fixed:** 1.63.0 types also have `'on-first-failure'` (S6) |
| C10 | headless escalation: the Agent SDK policy on third-party claude.ai login, versus V5's finding that keychain login is invisible under srt. | Both push isolated workers toward **API key or `CLAUDE_CODE_OAUTH_TOKEN` env auth**. This is a **lead and product decision**, not resolved here |

---

## 3. Verified results (V1–V11)

### V1. `--max-turns` / `--max-budget-usd` exit codes [mock]
Commands (cwd is a git repo; `cc.sh` = `env -i HOME PATH TERM ANTHROPIC_BASE_URL=mock ANTHROPIC_API_KEY=fake CLAUDE_CONFIG_DIR=<tmp> CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude …`):
- `claude -p "loop please" --output-format json --max-turns 2 --permission-mode dontAsk --allowedTools "Bash(echo *)"`, with the mock always replying with a Bash `tool_use`:
  - **exit 1**
  - `{"subtype":"error_max_turns","is_error":true,"num_turns":3,"terminal_reason":"max_turns","stop_reason":"tool_use","errors":["Reached maximum number of turns (2)"]}`, with no `result` key
  - The mock saw 2 model requests, but `num_turns` = max+1.
- Same command with `--max-turns 10 --max-budget-usd 0.5`, and the mock reporting 200k input + 20k output tokens per request:
  - **exit 1**
  - `{"subtype":"error_max_budget_usd","is_error":true,"num_turns":1,"terminal_reason":"budget_exhausted","errors":["Reached maximum budget ($0.5)"],"total_cost_usd":1.2}`
  - One request. **The budget is checked after the spend, so it overshoots by up to one request.**
- Result keys actually present: `duration_api_ms, duration_ms, errors, fast_mode_disabled_reason, fast_mode_state, is_error, modelUsage, num_turns, permission_denials, queued_turn_count, result_index, session_id, stop_reason, subagent_stats, subtype, terminal_reason, total_cost_usd, type, usage, uuid`.
- `modelUsage[model]` carried `canonicalModel`, `provider:"firstParty"` and `costBasis:"list"`.

### V2. Invalid credentials: retries and detection [mock + doc]
- The mock returned HTTP 401 `{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`.
- Command: `CLAUDE_CODE_MAX_RETRIES=2 claude -p hi --output-format stream-json --verbose --max-turns 1 --permission-mode dontAsk`.
- **3 requests** reached the mock. Exit 1; `duration_ms` 2687, about 5 s wall clock. The stream:
  ```jsonl
  {"type":"system","subtype":"api_retry","attempt":1,"max_retries":2,"retry_delay_ms":592,"error_status":401,"error":"authentication_failed"}
  {"type":"system","subtype":"api_retry","attempt":2,"max_retries":2,"retry_delay_ms":1250,"error_status":401,"error":"authentication_failed"}
  {"type":"assistant","error":"authentication_failed","request_id":"req_mock401","is_api_error_message":true,...}
  {"type":"result","subtype":"success","is_error":true,"api_error_status":401,"terminal_reason":"api_error","result":"Invalid API key · Fix external API key",...}
  ```
- **Doc contradiction confirmed:** `errors.md#automatic-retries` lists 401/403 retries only for `apiKeyHelper`, yet a plain `ANTHROPIC_API_KEY` 401 was retried.
- Docs: default retries are `CLAUDE_CODE_MAX_RETRIES=10`, capped at 15 (`env-vars.md`). `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429/529 indefinitely. **Do not set the watchdog for Orbit workers**, because spec §4 requires a bounded block.

### V3. Model alias resolution and tool set [mock]
`claude -p hi --model <alias> --output-format stream-json --verbose`. The ID comes from `system/init.model`, the request body and the `modelUsage` key, which all agreed:

| alias | resolved ID | `contextWindow` | `maxOutputTokens` (= request `max_tokens`) |
|---|---|---|---|
| `haiku` | `claude-haiku-4-5-20251001` | 200000 | 32000 |
| `sonnet` | `claude-sonnet-5-5` | 1000000 | 128000 |
| `opus` | `claude-opus-5-5` | 1000000 | 128000 |
| `fable` | `claude-fable-5-1` | 1000000 | 64000 |
| `best` | `claude-fable-5-1` | 1000000 | 64000 |
| `default` | `claude-opus-5-5` | 1000000 | 128000 |
| `opusplan` (in `-p`) | `claude-sonnet-5-5` | 1000000 | 128000 |

- Caveat: these runs used API-key auth and a custom base URL. What `default` resolves to for a subscription login is UNVERIFIED.
- **Tool flags, from the init `tools[]`:**
  - `--allowedTools Glob Grep Read` adds `Glob`/`Grep` to the default set.
  - `--tools "Read,Glob,Grep,Edit,Bash"` yields exactly those five.
  - **`--tools "default,Glob,Grep"` yields only `Glob, Grep`.**
  - Init `tools[]` names the Agent tool **`Task`**, while the API request uses `Agent`.
  - A Haiku session gets `TaskCreate/TaskGet/TaskList/TaskUpdate` instead of the default task tools.

### V4. Isolating workers from user and repo config [mock + marker hooks]
**Setup**
- An isolated config dir holds:
  - a user `settings.json` with SessionStart and Stop hooks
  - a user-installed plugin, `userplug@gapmkt`, added with `claude plugin marketplace add` and `claude plugin install` into the temp config
- The repo has `.claude/settings.json` with a SessionStart hook, and a `.mcp.json` stdio server.
- A `--plugin-dir` plugin, `orbitmini`, has SessionStart and Stop hooks.
- `flaghooks.json` is passed with `--settings`.

| flags | plugins loaded (non-builtin) | hooks that fired | repo MCP |
|---|---|---|---|
| none | userplug | usersettings, userplug, **projectsettings** | **spawned** (`status:"pending", source:"project"`) |
| `--setting-sources user` | userplug | usersettings, userplug | — |
| `--setting-sources project,local` | — | — | — |
| `--setting-sources ""` | — | — | — |
| `--setting-sources "" --settings flaghooks.json --plugin-dir orbitmini [--strict-mcp-config]` | orbitmini | **flagsettings, orbitmini** | none |
| `--settings '{"disableAllHooks":true}' --plugin-dir orbitmini` | orbitmini, userplug (loaded) | none (Orbit's hooks are disabled too) | — |
| `--settings '{"enabledPlugins":{"userplug@gapmkt":false}}' --plugin-dir orbitmini` | orbitmini | usersettings, orbitmini | — |

- Built-ins `cc-plugin-agents-md@builtin` and `cc-plugin-plugin-authoring@builtin` load in every mode. Docs: AGENTS.md loading is controlled by `pluginConfigs["agents-md@builtin"].options.instructionFiles` [doc settings-reference]. `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1` stops CLAUDE.md loading [doc env-vars].
- **Orphan:** the repo `.mcp.json` stdio server process was **still running after `claude -p` exited** (found with `ps`, then killed).
- Edited in place: the headless worker template (§7.1, §7.2, §1.1 `--setting-sources`) and plugin doc recommendation 8.

### V5. `claude` under srt 0.0.78 on macOS [local + mock]
- **argv gotcha:** srt consumes its own flags anywhere in argv. Always use `srt --settings f.json -- claude …`.
  - `srt --settings f claude --version` → `0.0.78` (srt's own version)
  - `srt --settings f -- claude --version` → `2.1.288 (Claude Code)`
- **Minimal writable set** for `claude -p` with the Bash tool, verified working:
  - the worktree and `$CLAUDE_CONFIG_DIR`
  - `/tmp/claude` and `/private/tmp/claude`
  - `/private/tmp/claude-<uid>` and `/tmp/claude-<uid>`
  - `/tmp/claude-*-cwd` and `/private/tmp/claude-*-cwd` (globs work on macOS)
  - The config used `network.allowedDomains:["127.0.0.1","localhost"]`, `allowLocalBinding:true` and `allowAllUnixSockets:true`.
  - Without the `claude-<uid>` paths the tool result was `EPERM: operation not permitted, mkdir '/private/tmp/claude-<uid>/…'`. Without the `-cwd` glob: `zsh:1: operation not permitted: /tmp/claude-a909-cwd`.
- **Nested Seatbelt fails.** Inside srt, `--settings '{"sandbox":{"enabled":true,"failIfUnavailable":true,"allowUnsandboxedCommands":false}}'` gave the tool results below. Claude did **not** exit at startup despite `failIfUnavailable`; each Bash call failed closed.
  - first: `Sandbox is required but failed to initialize: EPERM … listen '/tmp/claude/srt-mux-….sock'`
  - after allowing unix sockets: `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71)
- **Keychain login is invisible under srt.**
  - On the host, `claude auth status --json` gave `loggedIn:true, authMethod:"claude.ai", subscriptionType:"max"`.
  - Under srt it gave `loggedIn:false, authMethod:"none"` (exit 1). That held even with `allowMachLookup:["*"]` and `api.anthropic.com`, `claude.ai` and `platform.claude.com` allowed, and although `security list-keychains` worked inside srt.
  - The root cause is UNVERIFIED. Isolated workers need env credentials. `ANTHROPIC_API_KEY` works under srt (mock run exit 0).
- srt's debug log showed `auth status` contacting `api.anthropic.com:443` and `http-intake.logs.us5.datadoghq.com:443` (the latter was denied).

### V6. Codex exec success path against a mock Responses API [mock]
- Command and output were added to codex-cli.md §3 D′.
- Request: `POST /v1/responses`, `store:false`, `stream:true`, `text.format={"type":"json_schema","strict":true,"schema":…,"name":"codex_output_schema"}`.
- Tools offered: `exec_command, write_stdin, request_user_input, view_image, multi_agent_v1`, plus **`web_search` when `-c web_search='"disabled"'` is omitted**.
- `--disable multi_agent` removes `multi_agent_v1`. `codex features list` shows `multi_agent stable true` and `hooks stable true`.
- Exit 0, with `turn.completed.usage` = `{input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}`. The `-o` file was written.
- **No local schema validation.** Replies `not json at all` and `{"verdict":"MAYBE","extra":1}` each gave exit 0 and an `-o` file holding that text.

### V7. launchd user agent behaviour (macOS 27.0.1) [local]
- A temp plist was bootstrapped into `gui/501` (label `dev.orbit.gapprobe.<rand>`) and booted out afterwards. Nothing was written to `~/Library/LaunchAgents`.
- **Parent dirs:** missing parent dirs of `StandardOutPath` are **created** (`newdir/sub/` with mode `drwxr--r--`).
- **launchctl exit codes:**
  - `bootstrap` again on a loaded label → `Bootstrap failed: 5: Input/output error`, exit 5
  - `print` → 0 while loaded, 113 after bootout
  - `bootout` of a label that isn't loaded → `Boot-out failed: 3: No such process`, exit 3
- **Child survival:** `launchctl kill SIGKILL gui/$UID/<label>` killed the job and its non-detached child (same pgid). The `spawn(...,{detached:true})` child **survived**, with ppid → 1. It was killed manually afterwards.

### V8. Playwright SIGINT and GitHub PAT [local + doc]
- **SIGINT:** `npx playwright test -c sig.config.js --update-snapshots=none` was started with `start_new_session`, and SIGINT was sent after 8 s.
  - **Exit 130** in 0.3 s, whether sent to the group or to the child alone.
  - The report was written with `stats {expected:0, skipped:1, unexpected:0, flaky:0}`, `errors:[]` and `results[0].status:'interrupted'`. The port was released.
- **Push permission:** https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens lists "Push access to repositories" as `contents=write`, and the "Core-loop token" example adds `pull_requests=write` (+ `workflows=write` only to edit workflows).
- **Check runs:** https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens has **no Checks section**. https://docs.github.com/en/rest/checks/runs says "Write permission for the REST API to interact with checks is only available to GitHub Apps".

### V9. Claude cancellation and resume [mock]
- Setup: `--session-id <uuid>`, with the mock delaying 30 s and the signal sent 4 s in (`ccsig.py`).
- **SIGINT → exit 0** in 0.04 s with **no result line**. The last event is `{"type":"user","message":{"content":[{"type":"text","text":"[Request interrupted by user]"}]}}`.
- **SIGTERM → exit 143**, no result line.
- In both cases `$CLAUDE_CONFIG_DIR/projects/*/<uuid>.jsonl` existed.
- `claude -p continue --resume <uuid>` after SIGTERM gave exit 0, `subtype:"success"` and the same `session_id`, and the request carried the prior 5 messages.

### V10. Secret scanning gate: gitleaks 8.30.1 (`/opt/homebrew/bin/gitleaks`) [local]
- Subcommands: `dir`, `git`, `stdin`. Flags: `-c/--config`, `-i/--gitleaks-ignore-path` (default `.`), `--ignore-gitleaks-allow`, `--redact[=N]`, `-f json|csv|junit|sarif|template`, `-r <path|->`, `--exit-code` (default 1), `--baseline-path`, `--timeout`, `--max-target-megabytes`.
- **Config precedence (help text):** `--config` > `GITLEAKS_CONFIG` > `GITLEAKS_CONFIG_TOML` > **`(target path)/.gitleaks.toml`** > default. A worker-written config is therefore honoured unless `-c` is passed.
- Lab: synthetic `ghp_` tokens in two files, one with a `# gitleaks:allow` comment.

  | invocation | exit | findings |
  |---|---|---|
  | `gitleaks dir . --redact -f json -r out.json` | 1 | 1 (the inline `gitleaks:allow` was honoured) |
  | `+ --ignore-gitleaks-allow` | 1 | 2 |
  | Repo `.gitleaks.toml` with `[allowlist] paths=[".*"]` | **0** | **0** (poisoned) |
  | `+ -c <trusted>/gitleaks.toml -i <trusted dir>` | 1 | 2 |
  | `--exit-code 7` with leaks | 7 | — |

- JSON finding keys: `Author Commit Date Description Email EndColumn EndLine Entropy File Fingerprint Match Message RuleID Secret StartColumn StartLine SymlinkFile Tags`. With `--redact`, `Secret` and `Match` are `"REDACTED"`. `Fingerprint` = `a.txt:github-pat:1` for `dir`.
- **SAST:** `semgrep`, `trufflehog` and `osv-scanner` are **not installed** (`which` → not found). A SAST gate cannot run on this machine. `orbit doctor` must report it and the gate must be "unverified", not "pass".

### V11. Dependency vulnerability gate: `npm audit` (npm 11.6.0) [local, registry network]
- Clean lockfile: `npm audit --json` → exit 0, keys `auditReportVersion (2), metadata, vulnerabilities`, `metadata.vulnerabilities={info,low,moderate,high,critical,total}`.
- `lodash@4.17.15` lockfile (made with `npm install --package-lock-only --ignore-scripts`):
  - `npm audit --json` → **exit 1**, high = 1
  - `vulnerabilities.lodash` = `{name, severity:"high", isDirect:true, range:"<=4.17.23", fixAvailable:true, effects, nodes, via}`
  - `--audit-level=critical` → exit 0; `--audit-level=none` → exit 0
- Use the JSON, not the exit code, for severity policy. License policy is not covered (UNVERIFIED tooling).

---

## 4. Spot-checks of claims in the other files

| # | Claim (file) | Re-run | Result |
|---|---|---|---|
| S1 | `codex exec --full-auto` / `-a never` exit 2 (codex) | `codex exec --full-auto "x"`, `codex exec -a never "x"` | Confirmed: `error: unexpected argument '--full-auto' found` / `'-a' found`, exit 2 |
| S2 | Invalid `--effort` only warns (headless) | `claude -p hi --effort bogus` (fresh config) | Confirmed: `Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort. Valid values: low, medium, high, xhigh, max.` `--effort ultracode` printed no warning (documented in cli-reference ≥2.1.203) |
| S3 | `launchctl print` on a missing label exits 113 (platform) | after bootout (V7) | Confirmed: 113 |
| S4 | `ps -o etimes` is unsupported on macOS (platform) | `ps -o etimes= -p $$` | Confirmed: `ps: etimes: keyword not found`, exit 1 |
| S5 | A root `CLAUDE.md` gives a validate warning, and `--strict` fails (plugin) | `claude plugin validate vp [--strict]` | Confirmed: non-strict exit 0, strict exit 1, `root: CLAUDE.md at the plugin root is not loaded as project context…` |
| S6 | `use.screenshot` is `off\|on\|only-on-failure` (playwright) | `grep ScreenshotMode node_modules/playwright/types/test.d.ts` | **Wrong, fixed:** `'off' \| 'on' \| 'only-on-failure' \| 'on-first-failure'` |
| S7 | An unknown docker flag exits 125 (platform) | `docker run --bogus-flag alpine true` | Confirmed: 125 |
| S8 | `git ls-remote` patterns match ref tails (playwright-github) | bare-repo lab with `refs/heads/x/orbit/run-1` | Confirmed: pattern `orbit/run-1` matched (exit 0). `--exit-code … refs/heads/orbit/run-1` → exit 2 |
| S9 | Header "macOS 27.0.1 (build 26A434)" (platform) | `sw_vers` | Confirmed verbatim |
| S10 | `codex login status` with an empty home → `Not logged in`, exit 1 (codex) | temp `CODEX_HOME` | Confirmed |
| S11 | `claude auth status` reports a fake key as logged in (headless) | `ANTHROPIC_API_KEY=sk-ant-invalid claude auth status --json` | Confirmed: `loggedIn:true, authMethod:"api_key", apiKeySource:"ANTHROPIC_API_KEY"`, exit 0 |
| S12 | Default `-p` tools omit Glob/Grep (plugin, headless) | init `tools[]` (V3) | Confirmed; `--tools "default,…"` gotcha added |

**Corrections made in place** (each is marked "Corrected", "Verified" or "gaps Vn" in its file):
- **claude-headless-and-sandbox.md**
  - §1.1: `--max-turns` and `--max-budget-usd` exit codes, plus the overshoot
  - §1.1: `--tools` combination gotcha and `Task`/`Agent` naming
  - §1.1: `--setting-sources ""` semantics
  - §1.2: SIGINT exits 0 with no result
  - §1.3: `maxOutputTokens` semantics
  - §2.4: 401 retry confirmed
  - §4.2: srt `--` gotcha
  - §5: `haiku` → `claude-haiku-4-5-20251001` and all aliases
  - §7.1: template changed to `--setting-sources "" --plugin-dir`
  - §7.2: auth classification by structured fields
  - §7.5: nested Seatbelt fails, keychain invisible under srt, writable set
  - §7.9: SIGINT and MCP orphan
- **claude-code-plugin.md:** `CLAUDE_PLUGIN_DATA` follows `CLAUDE_CONFIG_DIR`; recommendation 8 now adds `--setting-sources "" --strict-mcp-config`.
- **codex-cli.md**
  - §0: `--disable multi_agent`
  - §3: D′ mock success capture
  - §4: no local validation
  - §11: UNVERIFIED list updated
- **platform-runtime.md:** launchd parent-dir creation, re-bootstrap exit 5, bootout exit 3, detached-child survival, UNVERIFIED list.
- **playwright-and-github.md:** SIGINT exit 130 and the `interrupted` guard, the `on-first-failure` screenshot mode, PAT push = Contents write (doc), check-runs status, UNVERIFIED list.

---

## 5. Remaining UNVERIFIED (consolidated, highest impact first)

1. **Why Keychain subscription auth is invisible under srt**, and whether `CLAUDE_CODE_OAUTH_TOKEN` works for srt- or container-wrapped workers. This needs a real authenticated call.
2. Whether the **Agent SDK third-party login policy** applies to open-source Orbit driving a user's own `claude` login (lead or legal decision).
3. **SAST tooling**: none installed. **License-policy tooling**: none chosen. **`npm ci --ignore-scripts`** behaviour: not probed.
4. Reading check runs with a **fine-grained PAT**, `gh pr checks` with one, `gh pr checks` exit 8 (pending), and the `gh pr create` "already exists" path. Each needs a private sandbox repo, so a push.
5. **Codex:**
   - a real OpenAI success capture
   - how expired ChatGPT tokens and strict-schema rejections surface in JSONL
   - the reviewer calling `request_user_input` (presumably exit 1)
   - whether `--disable hooks` or `--ignore-user-config` skip `$CODEX_HOME/hooks.json` (this user has hooks on all events)
   - whether resume restores the sandbox
   - SIGTERM child cleanup
6. **Claude:**
   - what `default` resolves to for a subscription login
   - whether plugin-agent `permissionMode`/`hooks`/`mcpServers` are really ignored at runtime
   - `/goal` evaluator model and cap interaction
   - `defer`
   - PowerShell/Agent `tool_input` (doc only)
   - running `claude` inside a Linux container
7. **Platform:**
   - systemd: everything (no Linux host)
   - WAL on bind mounts
   - the BTM "Background Items Added" notification. None appeared to this session for a temp-path bootstrap, but that was not observable here.
8. **Playwright:** the full `ConsoleMessage.type()` list, and whether `error-context.md` ever contains a DOM snapshot.

---

## 6. Implications for Orbit (new or changed by this pass)

1. **Worker launch (Claude adapter):** use `claude -p --setting-sources "" --strict-mcp-config --plugin-dir <orbit> --settings <run.json> --permission-mode dontAsk --permission-prompts none --session-id <uuid> --output-format stream-json --verbose`, with:
   - explicit `--model <full id>`, `--max-turns` and `--max-budget-usd`
   - `--tools` or `--allowedTools` naming `Glob`/`Grep` explicitly
   - **never** `--tools "default,…"`
   - env: `CLAUDE_CODE_MAX_RETRIES` ≤ 4, no `CLAUDE_CODE_RETRY_WATCHDOG`, and optionally `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and `CLAUDE_CODE_DISABLE_CLAUDE_MDS=1`
   - Assert `system/init.plugins` contains only `orbit` + `cc-plugin-*@builtin`, and that `mcp_servers` is empty.
2. **Crash semantics (decide, C2):** on macOS, detached workers survive controller death (verified); on Linux, they die with the cgroup.
   - Recommendation: make it uniform. Either use `KillMode=process` on Linux and always reconcile via `--session-id` + `--resume` (verified to work after SIGTERM),
   - or do not detach and treat every worker as dead after a controller restart.
   - Either way, persist `{pid, pgid, startTime, sessionId}` before spawn.
3. **Result classification:** success requires all of: a `type:"result"` line, exit 0, `is_error:false` and `subtype:"success"`. **A missing result line (SIGINT exits 0) means cancelled or crashed.** Map the remaining outcomes as follows:

   | Signal | Classification |
   |---|---|
   | `error_max_turns` | allowance exhausted |
   | `error_max_budget_usd` | budget exhausted |
   | `api_error_status`∈{401,403}, or any `authentication_failed` event | BLOCKED_AUTH (abort on the first `api_retry` with that error) |

4. **Budget enforcement:** `--max-budget-usd` overshoots by up to one request. Set it to (remaining budget − worst-case single-request cost), and keep Orbit's own ledger from `modelUsage[*].costUSD`.
5. **Model registry:** resolve aliases via `system/init.model` at registration time. Store `contextWindow`, and record `maxOutputTokens` as "CLI request cap", separately from the API model maximum.
6. **Isolation tier choice:**
   - srt around `claude` works only with env credentials, plus the writable set in V5, plus `srt … --`.
   - Do not enable Claude's built-in sandbox inside srt.
   - For trusted checks, prefer srt or Docker around the *check command* (verified in the earlier files), not around Claude.
7. **Codex reviewer:**
   - Add `--disable multi_agent` and `-c web_search='"disabled"'`.
   - Always validate `-o`/`agent_message` with ajv (Codex won't).
   - Treat exit 0 with invalid JSON as `REVIEW_INVALID`.
   - Expect `request_user_input` to be offered. Instruct the reviewer not to use it, and treat exit 1 as a review failure, not a pass.
8. **Static security gate:**
   - Run `gitleaks dir <worktree> -c <trusted config> -i <trusted dir> --ignore-gitleaks-allow --redact -f json -r <evidence>/gitleaks.json --no-banner`.
   - Treat any diff that adds `.gitleaks.toml`, `.gitleaksignore` or `gitleaks:allow` as an oracle-weakening change requiring review.
   - SAST is unavailable on this machine, so report it as unverified.
9. **Dependency gate:** `npm audit --json` and compute policy from `metadata.vulnerabilities`; the exit code depends on `--audit-level`. Record `auditReportVersion`.
10. **Service install (macOS):**
    - `launchctl bootout gui/$UID/<label>` (accept exit 3), then `bootstrap` (exit 5 means already loaded).
    - Probe with `print` (0 or 113).
    - Log dirs are auto-created, but pre-create them with 0700 to avoid world-readable logs.
11. **UI runner:** exit 130 or any `interrupted` result means CANCELLED. Never treat it as PASS, even though `stats.unexpected===0`.
12. **No `timeout` binary on macOS:** implement all wall-clock limits in Node with process-group kill.
13. **Delivery token:** use a fine-grained PAT with Contents write and Pull requests write, and **without** Workflows write, so pushes touching `.github/workflows` fail server-side as well. Poll CI via Actions read (`gh run list --commit`) until check-run reads with fine-grained PATs are verified.
