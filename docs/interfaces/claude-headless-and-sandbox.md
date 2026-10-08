# Claude Code headless execution, auth, sandboxing, models, Agent SDK

Verified 2026-10-03 against Claude Code CLI **2.1.288** (`claude --version`), macOS 27 (Darwin 27.0.0), Node v22.18.0.
Sources are cited inline. `[CLI]` means local command output, `[DOC <page>]` means `https://code.claude.com/docs/en/<page>`
(the `.md` source was fetched on this date). `UNVERIFIED` means neither source confirmed the item.

Doc pages used: `headless`, `cli-reference`, `permission-modes`, `permissions`, `sandboxing`, `sandbox-environments`,
`settings`, `settings-reference`, `authentication`, `errors`, `env-vars`, `model-config`, `sub-agents`,
`agent-sdk/typescript`, `agent-sdk/hosting`, `agent-sdk/overview`, `agent-sdk/quickstart`, `agent-sdk/claude-code-features`.

---

## 1. `claude -p` (print / headless mode)

### 1.1 Flags (all confirmed by `claude --help` [CLI] unless marked)

| Flag | Values / syntax | Notes |
|---|---|---|
| `-p, --print` | — | Skips the workspace trust dialog. **Settings files that fail validation are silently ignored in this mode** [CLI help text]. |
| `--output-format` | `text` (default), `json`, `stream-json` | Print mode only. |
| `--verbose` | — | **Required** with `--output-format stream-json`. Without it: `Error: When using --print, --output-format=stream-json requires --verbose`, exit 1 [CLI probe]. |
| `--input-format` | `text` (default), `stream-json` | Print mode only. stream-json lines are `SDKUserMessage` objects (`{"type":"user","message":{"role":"user","content":...},"parent_tool_use_id":null}`) [DOC agent-sdk/typescript]. The exact CLI line example is not on the CLI page, so treat the line shape as derived. Max 256M chars without a newline, then exit 1 [DOC errors]. |
| `--include-partial-messages` | — | Requires `-p` and `stream-json`. Emits `stream_event` lines. |
| `--include-hook-events` | — | Requires stream-json. |
| `--forward-subagent-text` | — | Requires `-p` and stream-json. Forwards subagent text and thinking blocks with `parent_tool_use_id`. |
| `--replay-user-messages` | — | Requires stream-json input and output. |
| `--json-schema <schema>` | inline JSON Schema string | Print mode. Result goes in `structured_output`. An invalid schema gives `Error: --json-schema is not a valid JSON Schema: <diag>`, exit 1 [CLI probe]. `format` is accepted as an annotation only and is not enforced [DOC headless]. |
| `--model <m>` | alias (`fable`, `opus`, `sonnet`, `haiku`, `best`, `sonnet[1m]`, `opus[1m]`, `opusplan`, `default`) or full ID | [CLI][DOC model-config]. |
| `--fallback-model <a,b,c>` | comma list, max 3 after dedupe | Covers availability failures only (overloaded, unavailable, 5xx). It never covers auth, billing, rate-limit, or request-size errors. The switch lasts one turn [DOC model-config]. |
| `--max-turns <n>` | int | Print mode. "Exits with an error when the limit is reached" and gives result `subtype: "error_max_turns"` [DOC cli-reference, agent-sdk/typescript]. **Verified (mock API, see gaps-and-contradictions.md V1): exit 1**, `is_error:true`, `terminal_reason:"max_turns"`, `errors:["Reached maximum number of turns (2)"]`, no `result` key, and `num_turns` reported as **max+1** (3 for `--max-turns 2`). |
| `--max-budget-usd <amt>` | decimal | **Exists.** Print mode only. Subagent spend counts toward it. On `--resume`, spend restored from earlier runs does **not** count. Gives result `subtype: "error_max_budget_usd"` [CLI][DOC cli-reference]. **Verified (mock): exit 1**, `terminal_reason:"budget_exhausted"`, `errors:["Reached maximum budget ($0.5)"]`. **It is checked after a response, so it overshoots**: one request costing $1.20 ran under a $0.50 cap (`total_cost_usd:1.2`). Not a hard spend guarantee; reserve one max-cost request of headroom. |
| `--permission-mode <m>` | help lists `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` | `default` is also accepted (`manual` is its alias) [DOC cli-reference]. Confirmed: `--permission-mode default` passes arg validation [CLI probe]. An invalid value gives `error: option '--permission-mode <mode>' argument 'yolo' is invalid. Allowed choices are ...`, exit 1. **Help and docs disagree on whether `default` is listed. Both values work.** |
| `--permission-prompts <t>` | `host` (default), `none` | Requires ≥2.1.259. `none` denies anything that would prompt, tells Claude not to retry, and removes `AskUserQuestion`. |
| `--permission-prompt-tool <mcp_tool>` | MCP tool name | In `cli-reference` but **not in `--help`**. The docs say `--help` "does not list every flag". |
| `--allowedTools`, `--allowed-tools` | comma or space list of rules | Auto-approves the listed rules. It does **not** restrict the tool set (use `--tools` for that). |
| `--disallowedTools`, `--disallowed-tools` | rules | A bare name such as `Edit`, `*`, or `mcp__*` **removes the tool from context**. A scoped rule such as `Bash(rm *)` denies matching calls in every mode, including bypass. |
| `--tools <list>` | `""` (none), `"default"`, `"Bash,Edit,Read"` | Restricts the built-in tools. **The default set on macOS/Linux leaves out `Glob` and `Grep`**, so name them explicitly. It does not affect MCP tools [DOC cli-reference]. **Verified (mock, `system/init.tools`)**: `--tools "default,Glob,Grep"` yields **only** `Glob, Grep` (the `default` preset does not combine with names). `--tools "Read,Glob,Grep,Edit,Bash"` yields exactly those five. Naming `Glob`/`Grep` in `--allowedTools` (without `--tools`) **adds** them to the default set. Note `system/init.tools` calls the Agent tool `Task`, while the API request and hook `tool_name` use `Agent`. |
| `--settings <file-or-json>` | path or inline JSON | Merged as the "command line" precedence level, above local/project/user and below managed. The file must be a regular file ≤2 MiB. |
| `--setting-sources <list>` | comma list of `user,project,local` | Excluding `project` skips the repo's `.claude/settings.json` and `.mcp.json` [DOC permissions]. `--setting-sources ""` passed arg parsing [CLI probe]. **Verified (mock + marker hooks, gaps V4)**: `""` loads **no** user/project/local settings: no user hooks, no user-enabled plugins, no repo `.claude/settings.json` hooks, no repo `.mcp.json` servers. `--settings <file>` hooks and `--plugin-dir` plugin hooks **still fire** with `""`. `--setting-sources user` **does** load user-enabled plugins (on this machine `codex@openai-codex`, whose Stop hook has a 900 s timeout). Built-in plugins (`cc-plugin-agents-md@builtin`, `cc-plugin-plugin-authoring@builtin`) load regardless. |
| `--strict-mcp-config` | — | Use only `--mcp-config` servers. Also suppresses claude.ai connectors (SDK equivalent `strictMcpConfig`) [DOC agent-sdk/claude-code-features]. |
| `--mcp-config <cfgs...>` | files or JSON strings | Waits up to `MCP_TIMEOUT` (30 s) for servers. Entries that fail validation are skipped silently. Check `mcp_server_errors` in `system/init` [DOC headless]. |
| `--system-prompt <txt>` / `--system-prompt-file <path>` | replace the default prompt | A missing file gives `Error: System prompt file not found: <path>`, exit 1 [CLI probe]. `--system-prompt-file` is not in `--help` but is accepted. |
| `--append-system-prompt <txt>` / `--append-system-prompt-file <path>` | append | Both can be combined (≥2.1.283). The file contents come first [DOC cli-reference]. `--append-system-prompt-file` was accepted [CLI probe]. |
| `--system-prompt-snapshot on\|off` | default `on` | The prompt is recorded on the first request and reused on resume until compaction. **A changed `--append-system-prompt` on `--resume` is ignored unless you pass `off`.** In `--bare`, recording is off unless you pass `on` [DOC cli-reference]. |
| `--add-dir <dirs...>` | paths | Grants file access. It also loads that dir's `.claude/skills`, `commands`, `agents` (via the `project` source). |
| `--session-id <uuid>` | must be a valid UUID | Pre-assigns the session ID, so the controller knows it before spawn. |
| `-r, --resume [id\|name\|/abs/path.jsonl]` | | Searches all projects on the machine (≥2.1.223). |
| `-c, --continue` | | Most recent conversation in cwd. In `-p` it includes `-p`/SDK sessions. |
| `--fork-session` | | Use with resume to get a new session ID. |
| `--no-session-persistence` | | Print mode. No transcript is written, so the session **cannot be resumed**. |
| `--effort <level>` | help: `low, medium, high, xhigh, max`; docs add `ultracode` (≥2.1.203) | `ultracode` was accepted silently [CLI probe]. **An invalid value is NOT an error**: it prints `Warning: Unknown --effort value 'bogus' — ignoring it and using the default effort` and continues [CLI probe]. Validate effort values yourself. `CLAUDE_CODE_EFFORT_LEVEL` env takes precedence over `--effort` [DOC env-vars]. |
| `--agents <json-or-file>` | `{"name":{"description":..,"prompt":..,"tools":[..],"model":..}}` | With `-p`, the value may be a file path. Validated at startup, and exits on invalid input [CLI][DOC sub-agents]. Also accepts the frontmatter fields `disallowedTools`, `permissionMode`, `maxTurns`, `skills`, `mcpServers`, `hooks`, `effort`, `background`, `omitClaudeMd` [DOC sub-agents]. |
| `--agent <name>` | | Main-thread agent. |
| `--bare` | | Skips hooks, plugins, skills discovery, MCP auto-discovery, CLAUDE.md, auto memory, and keychain. **Auth must be `ANTHROPIC_API_KEY` or `apiKeyHelper` via `--settings`. OAuth, keychain, and `CLAUDE_CODE_OAUTH_TOKEN` are all ignored** [CLI][DOC headless, authentication]. Confirmed: `--bare` with no API key gives `Not logged in` [CLI probe]. |
| `--restricted` | | Removes Bash and other code-running tools plus WebFetch unless `--tools` names them. Ignores user/project/local settings. Confines file tools to the working dirs. Refuses bypass [CLI]. |
| `--safe-mode` | | Disables customizations but keeps auth and permissions [CLI]. |
| `--disable-slash-commands` | | Disables all skills [CLI]. |
| `--exclude-dynamic-system-prompt-sections` | | Improves cross-machine cache reuse [CLI]. |
| `--bg` | | **Cannot be combined with `-p`** [DOC headless]. |
| `-w, --worktree [name]` | | Creates `<repo>/.claude/worktrees/<name>` [CLI][DOC cli-reference]. Orbit should manage its own worktrees instead. |

### 1.2 Exit codes and process behaviour
- `0` on success and non-zero on failure. Invalid flags go to stderr before the run starts. Failures inside the run, such as missing auth, are printed **as the result on stdout** [DOC headless].
- Observed: arg-validation errors → stderr, exit **1**. Not logged in → exit **1**, result on stdout, about 1 s. Invalid API key → exit **1**, result on stdout, **about 189 s** (see §2.4) [CLI probes].
- SIGTERM gives exit **143**. The in-progress turn is left unfinished with no result recorded. The process tree of a running Bash command is killed and `SessionEnd` hooks run. **To end a turn cleanly, send SIGINT first** [DOC headless].
- **Verified (mock, gaps V9)**: SIGTERM mid-request → exit 143 in 0.02 s, no `result` line. **SIGINT mid-request → exit 0** in 0.04 s, **no `result` line**; the stream ends with a `user` message whose text is `[Request interrupted by user]`. So **exit 0 does not imply a result**: require a `type:"result"` line. In both cases the transcript for a pre-assigned `--session-id` was on disk, and `--resume <id>` continued it (same `session_id`, prior messages re-sent).
- Background Bash tasks are killed about 5 s after the final result plus stdin close. Background subagents/workflows keep `-p` alive for up to 10 min idle (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, `0` means no limit) [DOC headless].
- Piped stdin is capped at 10 MB. An unreadable stdin gives a warning and the run continues [DOC headless]. **Spawn workers with stdin = `/dev/null`** (all local probes used `</dev/null`).
- With a slow consumer, the process waits up to 30 s for stdout to drain before exit [DOC headless].
- If the cwd is deleted mid-run, the session keeps running and shell commands fail [DOC headless].

### 1.3 Final result object (`--output-format json`, or the last line of stream-json)
Type `SDKResultMessage` [DOC agent-sdk/typescript]:

```ts
// success arm
{ type:"result", subtype:"success", uuid, session_id, duration_ms, duration_api_ms,
  is_error:boolean, api_error_status?:number|null, num_turns, result:string,
  stop_reason:string|null, total_cost_usd, usage:NonNullableUsage,
  modelUsage:{[model:string]:ModelUsage}, permission_denials:SDKPermissionDenial[],
  structured_output?:unknown, deferred_tool_use?:{id,name,input},
  terminal_reason?:TerminalReason, result_index?, queued_turn_count?, fast_mode_state?, ... }
// error arm
{ type:"result", subtype:"error_max_turns"|"error_during_execution"|"error_max_budget_usd"
          |"error_max_structured_output_retries",
  ...same accounting fields..., errors:string[], startup_failure_reason?:SDKStartupFailureReason }
```
- `usage` (BetaUsage): `input_tokens, output_tokens, cache_creation_input_tokens, cache_read_input_tokens, cache_creation{ephemeral_5m_input_tokens, ephemeral_1h_input_tokens}, server_tool_use, service_tier, speed, inference_geo, iterations, output_tokens_details`. **`usage` covers the main loop only.** Use `modelUsage` for accounting [DOC].
- `ModelUsage`: `{inputTokens, outputTokens, thinkingTokens?, cacheReadInputTokens, cacheCreationInputTokens, webSearchRequests, costUSD, contextWindow, maxOutputTokens, canonicalModel?, provider?, costBasis?:'list'|'managed'|'unknown'}`. `outputTokens` already includes thinking. `contextWindow` gives the runtime context limit [DOC]. **Correction (verified, mock):** `maxOutputTokens` is Claude Code's per-request `max_tokens` cap, **not** the API model maximum. Observed `haiku` → 32000 (API max 64K) and `fable` → 64000 (API max 128K), and the request bodies carried `max_tokens: 32000` and `128000` (opus) respectively.
- `total_cost_usd` and `costUSD` are client-side estimates. They are cumulative across `--resume` (earlier runs are included) [DOC headless].
- `SDKPermissionDenial = {tool_name, tool_use_id, tool_input}`.
- `terminal_reason` ∈ `completed, max_turns, tool_deferred, aborted_streaming, aborted_tools, hook_stopped, stop_hook_prevented, background_requested, blocking_limit, rapid_refill_breaker, prompt_too_long, image_error, model_error, api_error, malformed_tool_use_exhausted, budget_exhausted, structured_output_retry_exhausted, tool_deferred_unavailable, turn_setup_failed` [DOC].
- **GOTCHA (observed): auth failures return `subtype:"success"` with `is_error:true`.** Never treat `subtype==="success"` as success on its own. Require `exit==0 && is_error===false && subtype==="success"`.
- **Observed extra keys not in the docs type**: `subagent_stats{...}`, `usage.fallback_credit`, `usage.output_tokens_details.thinking_tokens`, `usage.server_tool_use.web_fetch_requests`, `fast_mode_disabled_reason:"sdk_opt_in_required"`. The schema should allow additional properties.
- Observed invalid-key result (verbatim, trimmed):
  ```json
  {"type":"result","subtype":"success","is_error":true,"api_error_status":401,
   "result":"Failed to authenticate. API Error: 401 API key is invalid.",
   "terminal_reason":"api_error","num_turns":1,"total_cost_usd":0,"modelUsage":{},
   "permission_denials":[],"duration_ms":188704,"duration_api_ms":0,"stop_reason":"stop_sequence",
   "session_id":"<uuid>","result_index":0}
  ```
- Observed no-credentials result: `{"subtype":"success","is_error":true,"result":"Not logged in · Please run /login","api_error_status":null,"terminal_reason":"api_error"}`, exit 1, stderr empty.

### 1.4 stream-json events worth consuming [DOC headless, agent-sdk/typescript]
- `system/init` (first event unless hook or plugin_install events precede it): `session_id, apiKeySource, claude_code_version, cwd, tools[], mcp_servers[{name,status,source?}], mcp_server_errors?, model, permissionMode, slash_commands, skills, plugins[{name,path}], plugin_errors?, capabilities?[]`. Use it to assert the effective model and `permissionMode`, and to check that no unexpected tools or MCP servers loaded.
- `system/api_retry`: `{attempt, max_retries, retry_delay_ms, error_status, error}`. `error` ∈ `authentication_failed, oauth_org_not_allowed, account_on_hold, billing_error, rate_limit, overloaded, invalid_request, model_not_found, server_error, max_output_tokens, cloud_credential_error, unknown`. **Use it to detect auth failure early instead of waiting about 3 min.**
- `system/permission_denied`: `{tool_name, tool_use_id, decision_reason_type?, decision_reason?, message}`. This is best-effort. `permission_denials` on the result is authoritative.
- `assistant` messages may carry `error` (the same enum as above).
- `CLAUDE_CODE_STARTUP_FAILURE_RESULTS=1` makes startup refusals emit an `error_during_execution` result with `startup_failure_reason` [DOC env-vars].

### 1.5 Permission modes in `-p` (deny vs hang)
**A bare `-p` run with no `canUseTool` host and no `--permission-prompt-tool` never hangs. Anything that would prompt is denied** and recorded in `permission_denials` [DOC headless, agent-sdk/typescript `SDKPermissionDeniedMessage`]. `--permission-prompts none` also tells Claude not to retry and removes `AskUserQuestion`.

| Mode | Runs without prompt | In `-p`, everything else |
|---|---|---|
| `default` (alias `manual`) | reads in working dirs, built-in read-only Bash set (`ls cat echo pwd head tail grep find wc which diff stat du cd`, read-only git) | denied |
| `acceptEdits` | above + Edit/Write in working dirs and `additionalDirectories` + `mkdir touch rm rmdir mv cp sed` on in-scope paths | other Bash/network denied unless allow-listed |
| `plan` | reads. No edits (plan blocks hold in `-p`) | commands outside the read-only set: classifier if auto is available and `useAutoModeDuringPlan` (default on), otherwise denied |
| `auto` | classifier-reviewed actions | Needs Opus ≥4.6, Sonnet ≥4.6, or Fable. **Haiku is not supported**, and if auto is unavailable the session starts in Manual. Repeated blocks (3 consecutive or 20 total) in `-p`: the action doesn't run and the run continues. Critical-path `rm` is denied immediately |
| `dontAsk` | reads, read-only Bash, allow rules, PreToolUse-hook approvals | **denied deterministically**. Ask rules are denied. Recommended for CI |
| `bypassPermissions` | everything, including protected-path writes | still denied/prompted: ask rules, `AskUserQuestion`, `requiresUserInteraction` MCP tools, critical-path `rm`/`rmdir`. **Refuses to start as root/sudo** |

- **The starting mode when none is given in `-p`** is `default` in sessions that fetch feature flags. It is **`auto`** (≥2.1.285) when flags aren't fetched, for example on a 3P provider or with telemetry off [DOC permission-modes]. **Always pass `--permission-mode` explicitly.**
- Rule precedence: **deny > ask > allow**. First match wins and specificity is irrelevant. A deny at any level, including user, cannot be overridden by `--allowedTools`. Managed deny beats everything [DOC permissions].
- Protected paths are never auto-approved except in bypass: `.git .claude(except .claude/worktrees) .vscode .idea .husky .cargo .devcontainer .yarn .mvn .config/git`, `--plugin-dir` dirs, and files such as `.gitconfig .gitmodules`, shell rc files, `.npmrc .yarnrc*`, `.mcp.json`, `.claude.json`, `.pre-commit-config.yaml`, lefthook. In `dontAsk` they are **denied** [DOC permission-modes].

### 1.6 Rule syntax (`--allowedTools`, `permissions.allow|ask|deny`) [DOC permissions]
- `Tool` or `Tool(specifier)`. `Bash(*)` ≡ `Bash`. As deny, a bare tool name removes the tool.
- Bash: `Bash(npm run *)`, where the space before `*` matters (`Bash(ls*)` also matches `lsof`). `Bash(npm test:*)` ≡ `Bash(npm test *)`, and `:*` only works at the end. Compound commands are split on `&& || ; | |& &` and newlines, and **every** subcommand must match an allow rule. Deny and ask match any subcommand, including inside `$(...)`, subshells, and loops. Wrappers stripped before matching: `timeout time nice nohup stdbuf command builtin noglob`, bare `xargs`, and safe env assignments. `npx`, `docker exec`, `devbox run` are NOT stripped. **Bash rules are not a security boundary**: `/bin/rm`, `sh -c '...'`, and `git -C . push` evade them.
- Read/Edit paths use gitignore syntax: `//abs/path`, `~/home/path`, `/path` (**relative to the settings source**: project settings → project root, `--settings <file>` → that file's dir, CLI flags → cwd), and `path`/`./path` (cwd). `Edit(...)` covers all edit tools. `Write(...)`/`NotebookEdit(...)`/`Glob(...)` path rules are accepted but **never consulted**, with a startup warning. A `Read` deny also blocks Edit/Write on that path. Single-segment `src/**` matches only `<cwd>/src` as allow, and any depth as deny/ask. Symlinks: allow needs both the link and its target to match, deny matches either.
- Read/Edit deny rules apply to built-in tools, recognized Bash file commands (`cat head tail sed tee`), and redirect targets. **They do not apply to arbitrary subprocesses** such as node or python scripts. Use the sandbox for that.
- WebFetch: `WebFetch(domain:example.com)`, `WebFetch(domain:*.example.com)`. `domain:` rules also feed the sandbox network lists, but a bare `WebFetch` rule does not.
- MCP: `mcp__server`, `mcp__server__*`, `mcp__server__tool`. Parameter matching: `Agent(model:opus)`, `Bash(run_in_background:true)`, `Bash(dangerouslyDisableSandbox:true)` (deny/ask only).

### 1.7 Untrusted-repo exposure in `-p` [DOC permissions "What runs before you trust a folder"]
`claude -p` in a never-trusted repo **still runs**: hooks from project settings, the project `env` block, `apiKeyHelper`/helpers, skill `allowed-tools`, and **all `.mcp.json` servers (connected without asking)**. Project `permissions.allow` and `additionalDirectories` are NOT applied (a stderr warning is printed). Mitigations from the docs:
`--setting-sources user` (skips project settings and `.mcp.json`), `--bare` (needs an API key), `--settings '{"disableAllHooks": true}'` (must be passed via the flag, because user settings can be overridden by project settings), and `disabledMcpjsonServers`.

---

## 2. Authentication

### 2.1 Precedence (first match wins) [DOC authentication]
1. Cloud provider, when `CLAUDE_CODE_USE_BEDROCK|VERTEX|FOUNDRY` is set (a Claude apps gateway session outranks all).
2. `ANTHROPIC_AUTH_TOKEN` (Bearer).
3. `ANTHROPIC_API_KEY` (X-Api-Key). **In `-p` it is always used when present**, with no approval prompt.
4. `apiKeyHelper` script output, set in settings. In `--bare` it is read only from `--settings`.
5. `CLAUDE_CODE_OAUTH_TOKEN`, a 1-year token from `claude setup-token`. Needs a Pro/Max/Team/Enterprise subscription. It can only make model requests (no Remote Control, no claude.ai connectors). **Not read in `--bare`.**
6. Anthropic profile or WIF credentials (`ANTHROPIC_PROFILE`, federation vars). Not read in `--bare`.
7. Subscription OAuth from `/login`. Stored in the macOS Keychain, keyed to `CLAUDE_CONFIG_DIR`. On Linux it is `~/.claude/.credentials.json` (0600).

- **This machine sets `CLAUDE_CONFIG_DIR`**: `claude auth status` reports `configDirectory: $CLAUDE_CONFIG_DIR` [CLI]. Orbit must not hardcode `~/.claude`. Pass the env through to workers, or resolve the directory via `claude auth status`.
- A stale `ANTHROPIC_API_KEY` in the environment silently shadows a valid subscription login in `-p`. Orbit should scrub or pin the auth env explicitly per worker.

### 2.2 Non-interactive status check: `claude auth status` [CLI][DOC cli-reference]
- `claude auth status [--json (default) | --text]`. **Exit 0 if logged in, 1 if not.**
- Logged out (fresh `CLAUDE_CONFIG_DIR`): `{"loggedIn":false,"authMethod":"none","apiProvider":"firstParty","analyticsDisabled":false,"projectsDirectory":"...","configDirectory":"..."}`, exit 1. `--text` prints `Not logged in. Run claude auth login to authenticate.`
- Subscription: `{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty",...,"email","orgId","orgName","subscriptionType":"max"}`, exit 0.
- `authMethod` ∈ `none, claude.ai, oauth_token, api_key, api_key_helper, third_party`. An API key also adds `"apiKeySource":"ANTHROPIC_API_KEY"`.
- **GOTCHA (observed): `auth status` does not validate credentials.** `ANTHROPIC_API_KEY=sk-ant-invalid` gives `loggedIn:true, authMethod:"api_key"`, exit 0. It also does not detect an expired login, because the docs place that state in `/status` (interactive) and in request failures. `orbit doctor` therefore needs a real validation. The options are a minimal `-p` call with low retries (costs a tiny call), or treating the first worker's `api_retry`/result `authentication_failed` as the signal.

### 2.3 Error results for bad or expired credentials [DOC errors]
| Condition | `-p`/SDK result text | Structured |
|---|---|---|
| No credential | `Not logged in · Please run /login` (observed) | exit 1, `api_error_status:null` |
| Invalid API key | `Failed to authenticate. API Error: 401 API key is invalid.` (observed) | `api_error_status:401` |
| OAuth revoked | `Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.` | `authentication_failed` |
| OAuth expired (API rejection) | `Failed to authenticate. API Error: 401 OAuth token has expired ...` | `authentication_failed` |
| Saved login expired and refresh failed | `Failed to authenticate: OAuth session expired and could not be refreshed` (no request sent) | `authentication_failed` |
| Account/org revoked or disabled | `... API Error: 401 Invalid authentication credentials` | 401 |
| `apiKeyHelper` failing | `Your apiKeyHelper script is failing` (within 3 attempts) | — |
Before expiry, interactive startup warns `Your login expires in 3 days`. That warning is not available headless.

### 2.4 Retry timing (important for "block on expired credentials")
- The probe `ANTHROPIC_API_KEY=sk-ant-invalid CLAUDE_CONFIG_DIR=$(mktemp -d) claude -p "hi" --output-format json --max-turns 1` took **189 s wall / `duration_ms` 188704 / `duration_api_ms` 0 before failing** [CLI probe]. That matches the full retry budget (default `CLAUDE_CODE_MAX_RETRIES=10`, exponential backoff). **Docs and observation disagree**: `errors#automatic-retries` lists 401/403 retries only for `apiKeyHelper` credentials, yet a plain invalid API key was evidently retried. Prefer the observed behaviour.
- **Confirmed (mock returning HTTP 401 `authentication_error`, gaps V2)**: with `CLAUDE_CODE_MAX_RETRIES=2` and a plain `ANTHROPIC_API_KEY`, the mock received **3** requests. The stream carried `system/api_retry {attempt:1|2, max_retries:2, error_status:401, error:"authentication_failed"}`, then `assistant {error:"authentication_failed", is_api_error_message:true}`, then a result with `subtype:"success", is_error:true, api_error_status:401, terminal_reason:"api_error"` and `result:"Invalid API key · Fix external API key"`. Exit 1; `duration_ms` 2687, about 5 s wall clock including startup.
- Mitigations: set `CLAUDE_CODE_MAX_RETRIES=1..2` for preflight/doctor calls, consume stream-json and abort on the first `system/api_retry` with `error:"authentication_failed"`, and apply a wall-clock timeout. `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429/529 indefinitely. Do not use it for preflight.

---

## 3. Native Claude Code sandbox (`settings.sandbox`) [DOC sandboxing, settings-reference]

### 3.1 Scope
- It covers **only Bash, PowerShell, and Monitor commands and their child processes**. Read/Edit/Write/WebFetch/WebSearch, MCP servers, hooks, LSP, statusline, and `apiKeyHelper` run **outside** it and are governed by permission rules only. `denyRead` does not stop the Read tool, and `allowedDomains` does not limit WebFetch.
- macOS uses Seatbelt (`/usr/bin/sandbox-exec` present [CLI]) with no extra install. Linux/WSL2 needs `bubblewrap` + `socat` (Ubuntu ≥24.04 needs an AppArmor userns profile). The seccomp Unix-socket filter is optional. Native Windows is unsupported.
- Sandbox is **off by default**. If the sandbox cannot start, commands run **unsandboxed** unless `failIfUnavailable: true` is set.

### 3.2 Schema (all keys confirmed in settings-reference)
```jsonc
{
  "sandbox": {
    "enabled": true,                       // default false
    "failIfUnavailable": true,             // default false: exit at startup if the sandbox can't start
    "autoAllowBashIfSandboxed": true,      // default true: sandboxed Bash runs without a prompt
    "allowUnsandboxedCommands": false,     // default true; false = "strict": ignore dangerouslyDisableSandbox retries
    "excludedCommands": ["docker compose *"], // Bash-rule syntax; these run UNSANDBOXED (not a security boundary)
    "filesystem": {
      "allowWrite": ["/tmp/build", "~/.kube"], // beyond cwd + per-user TMPDIR + --add-dir dirs
      "denyWrite": ["/etc"],
      "denyRead":  ["~/"],
      "allowRead": ["."],                  // re-opens inside denyRead; narrower path wins
      "allowManagedReadPathsOnly": false,  // managed-only
      "disabled": false                    // user/managed only; turns the FS layer off, keeps network
    },
    "network": {
      "allowedDomains": ["registry.npmjs.org", "*.github.com", "api.example.com:443", "[::1]"],
      "deniedDomains": ["uploads.github.com"],
      "strictAllowlist": true,             // user/managed/--settings only (≥2.1.219): deny instead of prompt
      "allowManagedDomainsOnly": false,    // managed-only
      "allowUnixSockets": ["/path.sock"],  // macOS only
      "allowAllUnixSockets": false,
      "allowLocalBinding": false,          // macOS: listen/connect localhost (dev servers!)
      "allowMachLookup": ["com.apple.coresimulator.*"], // XPC, needed by e.g. Playwright
      "httpProxyPort": 8080, "socksProxyPort": 8081,     // bring your own proxy
      "tlsTerminate": {}                   // experimental; user/managed only
    },
    "credentials": {
      "files":   [{ "path": "~/.aws/credentials", "mode": "deny" }],
      "envVars": [{ "name": "GITHUB_TOKEN", "mode": "deny" }]   // or "mask" (needs tlsTerminate)
    },
    "ignoreViolations": { "*": ["/etc/hosts"] },
    "enableWeakerNestedSandbox": false,    // Linux in unprivileged Docker
    "enableWeakerNetworkIsolation": false, // macOS trustd for Go TLS with a MITM proxy
    "allowAppleEvents": false, "ripgrep": {}, "bwrapPath": "...", "socatPath": "..."
  }
}
```
- Sandbox path prefixes are **standard** (`/abs`, `~/`, `./` = project root for project settings or `~/.claude` for user settings). This differs from permission rules, where `//abs` is absolute and `/path` is settings-relative. Linux `allowWrite`/`denyWrite` ignore globs.
- Permission rules merge into the sandbox config: `Edit` allow/deny → `allowWrite`/`denyWrite`, `Read` deny → `denyRead`, `WebFetch(domain:)` → domain lists. Arrays merge across scopes.
- Hosts outside `allowedDomains` per mode: bypass → allowed, default/acceptEdits/plan → prompt (**so denied in `-p`**), auto → refused unless per-command domains are approved, dontAsk → refused. `strictAllowlist`/managed lock → refused in every mode.
- Network works through a local proxy via `HTTP(S)_PROXY`/`ALL_PROXY`. Tools that ignore the proxy (raw ssh, most DB drivers) cannot connect. UDP/QUIC/ICMP are blocked. Hostnames that resolve to loopback, link-local, or own addresses are refused unless the IP literal is allow-listed.
- Sandbox-protected paths (not exemptable): `.claude` settings/skills/agents/commands/hooks, `.mcp.json`, shell rc files, `.gitconfig`, `.git/hooks`, `.git/config`, bare-repo markers, and most of `~/.claude` / `$CLAUDE_CONFIG_DIR`.
- `--setting-sources` excluding a source drops that source's `sandbox.filesystem`, `Edit` rules, `Read` denies, and credentials. User `credentials.deny` entries are still applied (≥2.1.246).
- A `false` for `allowUnsandboxedCommands` from `--settings` or managed settings makes the sandbox "admin-required". Repo settings can then no longer loosen it (`excludedCommands` in `.claude/settings*.json` is ignored).
- **GOTCHA**: `-p` silently ignores settings files that fail validation [CLI help]. If the `sandbox` block is malformed the run proceeds unsandboxed, and `system/init` doesn't report sandbox state. Validate settings JSON against `https://json.schemastore.org/claude-code-settings.json` before spawning. The schema can lag the CLI [DOC settings].

---

## 4. Sandbox runtime `@anthropic-ai/sandbox-runtime` (`srt`)

### 4.1 Package facts [CLI `npm view`]
- name `@anthropic-ai/sandbox-runtime`, **version 0.0.78** (modified 2026-10-01), license Apache-2.0, `bin: {"srt":"dist/cli.js"}`, engines `node >=20.11.0`.
- Repository: **`github.com/anthropics/sandbox-runtime`**. This corrects the task brief's "anthropic-experimental". The docs link the same repo. Status: "Beta Research Preview; APIs and configuration formats may evolve" [README].
- Claude Code's built-in sandbox is built on this package [DOC sandboxing].

### 4.2 CLI [CLI `srt --help`]
```
srt [options] [command...]            # argv form: srt node -e '...'
srt -c '<command string>'             # like sh -c, no escaping
  -s, --settings <path>               # default ~/.srt-settings.json
  -d, --debug                         # or SRT_DEBUG
  --control-fd <fd>                   # fd>=3, JSON-lines config updates; only network lists change live
  windows-install / windows-uninstall # Windows alpha
```
- **GOTCHA (verified, gaps V5): srt parses its own options anywhere in argv unless `--` precedes the command.** `srt --settings f.json claude --version` printed srt's own version `0.0.78`. `srt --settings f.json sh -c '…' x --settings /nonexistent` failed with `Error: /nonexistent does not exist.` Use **`srt --settings f.json -- <cmd> <args…>`**; with `--`, the arguments pass through untouched. This matters because `claude` also has `--settings`.
- With no `~/.srt-settings.json` and no `--settings`, srt **still starts** with defaults: no network, writes only to `/tmp/claude`, `~/.npm/_logs`, `~/.claude/debug`. An empty, unreadable, or invalid settings file, or a missing `--settings` path, means **srt refuses to start** [README, DOC sandbox-environments]. That is a good fail-closed property.

### 4.3 Settings file (keys confirmed in the shipped zod schema `dist/sandbox/sandbox-config.js` plus README)
```jsonc
{
  "network": {
    "allowedDomains": ["registry.npmjs.org"],   // allow-only; [] = no network; ":port" suffix ok; "*.x.com"
    "deniedDomains": [],                         // checked first; "*" allowed for deny-all
    "deniedDomainReasons": {"github.com:22": "use https"},
    "deniedResolvedAddresses": ["10.0.0.0/8","172.16.0.0/12","192.168.0.0/16"],
    "allowLocalBinding": false,                 // macOS: listen/connect localhost
    "allowUnixSockets": [], "allowAllUnixSockets": false, "allowMachLookup": [],
    "httpProxyPort": null, "socksProxyPort": null, "parentProxy": {}, "mitmProxy": {}, "tlsTerminate": {}
  },
  "filesystem": {
    "denyRead": ["~/.ssh"], "allowRead": [],     // reads allowed by default; allowRead BEATS denyRead
    "allowWrite": ["."],    "denyWrite": [],     // writes denied by default; denyWrite BEATS allowWrite
    "allowGitConfig": false
  },
  "credentials": { "files": [], "envVars": [] },
  "ignoreViolations": {}, "mandatoryDenySearchDepth": 3,
  "enableWeakerNestedSandbox": false, "enableWeakerNetworkIsolation": false,
  "allowAppleEvents": false, "allowPty": false
}
```
- **Read precedence is the opposite of Claude settings**: in srt `allowRead` overrides `denyRead`, except that a more specific `denyRead` inside an `allowRead` region stays denied. `denyWrite` overrides `allowWrite`.
- Mandatory write-denies, always on: `.bashrc .bash_profile .zshrc .zprofile .profile .gitconfig .gitmodules .ripgreprc .mcp.json`, `.vscode/ .idea/ .claude/commands/ .claude/agents/ .git/hooks/ .git/config` (unless `allowGitConfig`). On Linux these are scanned only to depth `mandatoryDenySearchDepth` at launch, so files created later are not covered. macOS checks at write time.
- Library API: `SandboxManager.initialize(config)`, `await SandboxManager.wrapWithSandbox(cmd, ..., {commandId, commandText})` returns a shell string to `spawn(..., {shell:true})`, plus `SandboxManager.annotateStderrWithSandboxFailures(id, stderr)`, `getViolationsForCommand(id)`, `cleanupAfterCommand()`, and `SandboxManager.reset()`. Types: `SandboxRuntimeConfig`, `NetworkConfig`, `FilesystemConfig`, ... [README]. Linux wrap-time failures throw `LinuxSandboxProfileError` with `.code`.
- Linux deps: `bubblewrap`, `socat`, `ripgrep`. Root callers need `CAP_SETFCAP`, so prefer non-root. macOS: the README lists `ripgrep` as required, **but the probes below succeeded with no `rg` binary on PATH** (only a shell function existed). Disagreement recorded; install rg to be safe.
- srt **does not limit CPU, memory, process count, or wall time**. It covers filesystem and network only.

### 4.4 Local verification on macOS (no model calls) [CLI probes, srt 0.0.78]
Settings: `{"network":{"allowedDomains":["registry.npmjs.org"],"deniedDomains":[]},"filesystem":{"denyRead":["~/.ssh"],"allowWrite":["."],"denyWrite":[]}}`

| Command under `srt --settings f.json -c ...` | Result |
|---|---|
| `curl https://registry.npmjs.org/` | `200`, exit 0 |
| `curl https://example.com/` | `curl: (56) CONNECT tunnel failed, response 403`, exit 56 |
| `echo ok > inside.txt` (cwd) | ok, exit 0 |
| `touch $HOME/x` | `Operation not permitted`, exit 1 |
| `ls ~/.ssh` (denyRead) | `Operation not permitted`, exit 1 |
| `exit 7` / argv form `node -e 'process.exit(3)'` | exit 7 / exit 3. **The wrapped exit code propagates** |
| `npm test` (package.json script) | runs, exit 0 |
| `npm install ...` without `~/.npm` writable | fails with EPERM on `~/.npm`. Add `"~/.npm"` to `allowWrite` or set `npm_config_cache=<worktree>/.npm-cache` |
| env inside | `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` (and lowercase) = `http://localhost:<port>`, `NO_PROXY` = local/private ranges, **`TMPDIR=/tmp/claude`** |

**Conclusion: yes, srt can wrap arbitrary commands such as `npm test` with a domain allowlist on macOS. Exit codes propagate, and network denials appear as proxy 403s.**

---

## 5. Models (claude-api skill, cached 2026-09-25, plus DOC model-config)

| Model | API ID | Context | Max out | $/MTok in | out | cache write 5m / 1h† | cache read |
|---|---|---|---|---|---|---|---|
| Claude Fable 5.1 | `claude-fable-5-1` | 1M | 128K | 10.00 | 50.00 | 12.50 / 20.00 | **0.25** |
| Claude Fable 5 | `claude-fable-5` | 1M | 128K | 10.00 | 50.00 | 12.50 / 20.00 | 1.00 |
| Claude Opus 5.5 | `claude-opus-5-5` | 1M | 128K | 4.00 | 20.00 | 5.00 / 8.00 | **0.20** |
| Claude Opus 5 | `claude-opus-5` | 1M | 128K | 5.00 | 25.00 | 6.25 / 10.00 | 0.50† |
| Claude Opus 4.8 / 4.7 / 4.6 | `claude-opus-4-8` / `-4-7` / `-4-6` | 1M | 128K | 5.00 | 25.00 | 6.25 / 10.00 | 0.50† |
| Claude Sonnet 5.5 | `claude-sonnet-5-5` | 1M | 128K | 2.00 | 10.00 | 2.50 / 4.00 | **0.20** |
| Claude Sonnet 5 | `claude-sonnet-5` | 1M | 128K | 2.00 | 10.00 | 2.50 / 4.00 | 0.20† |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | 128K | 3.00 | 15.00 | 3.75 / 6.00 | 0.30† |
| Claude Haiku 4.5 | `claude-haiku-4-5` (snapshot `claude-haiku-4-5-20251001`) | 200K | 64K | 1.00 | 5.00 | 1.25 / 2.00 | 0.10† |
| (Mythos 5.1 / 5) | `claude-mythos-5-1` / `claude-mythos-5` | Project Glasswing only. Not for Orbit | | | | | |

† marks values **derived** from the skill's documented multipliers (cache write 1.25× for 5m and 2× for 1h, cache read about 0.1× base). Bold cache-read values are stated explicitly. Fast mode is available on Opus 5.5 (Claude API only) at $8/$40. Batch is 50%. **Prefer runtime numbers**: `ModelUsage.contextWindow`, `maxOutputTokens`, `costUSD`, and `costBasis` in every result (§1.3).

**Claude Code CLI aliases** [DOC model-config][CLI help]: `fable` → Fable 5.1, `opus` → Opus 5.5, `sonnet` → Sonnet 5.5 (on the Anthropic API; providers differ: Bedrock/Vertex `sonnet` → Sonnet 4.5, Foundry `opus` → Opus 4.6), `haiku` → "the fast and efficient Haiku model" (the version is not named on the page). **Verified against the mock API: `haiku` → `claude-haiku-4-5-20251001`** (the dated snapshot, not the alias ID). The other resolutions were also verified there: `sonnet` → `claude-sonnet-5-5`, `opus` and `default` → `claude-opus-5-5`, `fable` and `best` → `claude-fable-5-1`, and `opusplan` → `claude-sonnet-5-5` in `-p`. These used an API key and a custom `ANTHROPIC_BASE_URL`; subscription resolution was not checked. `best` → fable if available, otherwise opus, plus `opusplan`, `sonnet[1m]`, `opus[1m]`, `default`. Minimum CLI versions: Sonnet 5.5 ≥2.1.284, Opus 5.5 ≥2.1.280, Fable 5.1 ≥2.1.257. 2.1.288 satisfies all of them.

**CLI vs API differences that matter**
- Fable in Claude Code on a subscription may bill **usage credits**. **In `-p` Claude Code never asks for consent and bills credits without asking** [DOC model-config]. Gate `fable` behind explicit policy.
- Automatic content fallback: Fable 5.x/Opus 5.5 bio → Opus 5, cyber → Opus 4.8. Sonnet 5.5 cyber → Sonnet 5. The session **continues on the fallback model** [DOC model-config]. Read the actual model from `modelUsage` keys, not from the requested model.
- Effort levels: Fable/Opus 5.x/Sonnet 5.x/Opus 4.7–4.8 support `low…max`. Opus 4.6/Sonnet 4.6 have no `xhigh`. Haiku 4.5 has **no effort support**. Defaults are `medium` for Opus 5.5 and Sonnet 5.5, `xhigh` for Opus 4.7, and `high` otherwise [DOC model-config].
- Auto permission mode does not support Haiku.
- Agent SDK `Query.supportedModels()` lists models available to the account [DOC agent-sdk/typescript]. There is no confirmed CLI equivalent (UNVERIFIED), so validate a model by a minimal run or `system/init.model`.

---

## 6. Agent SDK (TypeScript `@anthropic-ai/claude-agent-sdk`)
- npm `@anthropic-ai/claude-agent-sdk` **0.3.288**, engines node ≥18. It bundles the native CLI via optionalDependencies `@anthropic-ai/claude-agent-sdk-<platform>` (darwin-arm64, ...). SDK 0.3.N bundles CLI 2.1.N [CLI npm view][DOC agent-sdk/typescript].
- **It spawns the CLI**: "`query()` ... spawns a separate `claude` CLI process and talks to it over stdio". There is one subprocess per session [DOC agent-sdk/hosting]. `pathToClaudeCodeExecutable` overrides the binary and `spawnClaudeCodeProcess` customizes the spawn (VM/container).
- `query({prompt: string | AsyncIterable<SDKUserMessage>, options})` returns `Query` (an AsyncGenerator of `SDKMessage` with `interrupt()`, `setPermissionMode()`, `setModel()`, `applyFlagSettings()`, `supportedModels()`, `mcpServerStatus()`, `streamInput()`, `stopTask()`, `close()`, ...).
- Options confirmed: `model`, `fallbackModel`, `maxTurns`, `maxBudgetUsd`, `permissionMode` (`default|acceptEdits|bypassPermissions|plan|dontAsk|auto`), `allowDangerouslySkipPermissions` (required for bypass), `permissionPrompts: 'host'|'none'`, `canUseTool(toolName, input, {signal, toolUseID, requestId, ...}) => Promise<PermissionResult|null>` (it is called only when the flow falls through to a prompt. **Returning `null` without answering blocks forever, because prompts don't time out**), `hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>`, `settingSources: ('user'|'project'|'local')[]` (omitted = load all three like the CLI; `[]` = load none), `settings` (object/path/JSON), `managedSettings`, `cwd`, `additionalDirectories`, `abortController`, `outputFormat: {type:'json_schema', schema}`, `systemPrompt` (string or `{type:'preset',preset:'claude_code',append?,excludeDynamicSections?}`), `tools`, `allowedTools`, `disallowedTools`, `mcpServers`, `strictMcpConfig`, `agents`, `effort`, `thinking`, `env` (**replaces** process.env, so spread it), `sessionId`, `resume`, `forkSession`, `persistSession`, `sandbox`, `stderr`, `executable`, `pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess`, `projectConfigRoot` [DOC agent-sdk/typescript].
- `settingSources` does NOT control managed policy, `~/.claude.json`, auto memory (`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`), claude.ai connectors (`strictMcpConfig`), or user `sandbox.credentials` denies [DOC agent-sdk/claude-code-features].
- **Policy note** [DOC agent-sdk/overview, quickstart]: "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods..." This needs a product/legal decision for an open-source Orbit that drives a user's subscription-authenticated `claude`. Escalate to the lead. It is not decided here.

### Recommendation: CLI subprocess vs SDK for crash-surviving workers
**Use the CLI (`claude -p`) as a detached subprocess. Do not run workers in-process through the SDK.**
- The SDK's control channel is the parent's stdio. `canUseTool`, SDK hooks, and `streamInput` all live in the controller process. If the controller dies, the pipe closes. The docs say that ending input cancels a pending prompt [DOC headless SIGTERM section]. Whether the child keeps working after its SDK parent exits is UNVERIFIED and not designed for.
- The CLI writes the same message stream (`--output-format stream-json --verbose`) to a **file** that survives controller crashes. The session transcript persists on disk, and `--session-id <uuid>` lets the controller record the ID **before** spawn, then `--resume <uuid>` after a crash. `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` continues an interrupted turn.
- In TypeScript, use `spawn('claude', args, {detached: true, stdio: ['ignore', fd(out.jsonl), fd(err.log)]})` + `child.unref()`. Record pid, pgid, and session-id in SQLite. For reconciliation, check pid liveness, then read the last line of `out.jsonl` for `type:"result"`.
- Policy must be deterministic without a live callback, so use `--permission-mode dontAsk` + an explicit `--allowedTools`/`--disallowedTools` + `--permission-prompts none`. PreToolUse policy hooks go in `--settings` (command hooks run as separate processes and don't need the controller alive).
- Reuse the SDK's **types** (`SDKResultMessage`, etc.) for parsing if useful, by importing types only.

---

## 7. Implications for Orbit

1. **Worker invocation template** (Claude adapter `startTask`):
   ```bash
   CLAUDE_CODE_MAX_RETRIES=4 CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 \
   claude -p --session-id "$UUID" --output-format stream-json --verbose \
     --model "$MODEL_ID" --effort "$EFFORT" --max-turns 30 --max-budget-usd "$BUDGET" \
     --permission-mode dontAsk --permission-prompts none \
     --allowedTools "Read" "Grep" "Glob" "Edit" "Bash(npm test *)" \
     --disallowedTools "WebFetch" "WebSearch" "mcp__*" "Bash(git push *)" \
     --setting-sources "" --strict-mcp-config \
     --plugin-dir "$ORBIT_PLUGIN_ROOT" \
     --settings "$RUN_DIR/worker-settings.json" \
     --append-system-prompt-file "$RUN_DIR/worker-prompt.md" \
     "$TASK_PROMPT" </dev/null >"$RUN_DIR/logs/$UUID.jsonl" 2>"$RUN_DIR/logs/$UUID.err"
   ```
   - **Corrected (gaps V4):** the template originally used `--setting-sources user`. That was verified to load the user's hooks **and user-enabled plugins** (here `codex@openai-codex`, which has a Stop review-gate hook). Use `--setting-sources ""`, which was verified to load no user, project or local settings, hooks, plugins or `.mcp.json` servers while still honoring `--settings` and `--plugin-dir` hooks. Do not use `disableAllHooks`: it also disables Orbit's own hooks. If a user's auth depends on `apiKeyHelper` in user settings, pass it through `--settings` instead.
   - `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` also disables feature-flag fetching, which **flips the `-p` default mode to `auto`**. That is harmless only because the mode is always passed explicitly.
   - Do not use `--bare` for subscription users, because it ignores OAuth and `CLAUDE_CODE_OAUTH_TOKEN`. It is fine for API-key users and CI.
   - **Added (review of issue #31, 2.1.292):** `-p` writes its `result` line and then does not exit while a background task of the session is alive: a Bash command run with `run_in_background`, or a foreground command the CLI moves to the background when it outlives its Bash timeout ("was moved to the background"). A server left there held the session until Orbit's worker timeout. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` removes `run_in_background` from the Bash tool (passing it is an `InputValidationError`) and ends a foreground command at its timeout (exit 143, "Command timed out"); the session then exits with its result. Measured against a fake API in both tiers; `permissionMode` stays `dontAsk`.
2. **Result classification**: success iff `exit==0 && result.is_error===false && result.subtype==="success"`. Auth failure iff `api_error_status∈{401,403}`, or a `system/api_retry.error==="authentication_failed"` appears, or an `assistant.error==="authentication_failed"` appears, or `result` starts with `Not logged in` (that one has `api_error_status:null`). **Correction:** do not rely on `Failed to authenticate` text. The same 401 surfaced as `Invalid API key · Fix external API key` against the mock, and that string is the one documented in `errors#invalid-api-key`. The run is then **BLOCKED_AUTH**, never retried (spec §4, §14). Budget/turn exhaustion maps to `error_max_budget_usd`/`error_max_turns`. Schema failure maps to `error_max_structured_output_retries`. Use `modelUsage` for token and cost accounting, not `usage`.
3. **`orbit doctor`**: run `claude --version` (≥2.1.284 for Sonnet 5.5), `claude auth status` (exit code, `authMethod`, `configDirectory`), and an optional opt-in live check (`-p` with `CLAUDE_CODE_MAX_RETRIES=1`, `--max-turns 1`, `--tools ""`, cheapest model) because `auth status` cannot detect an invalid or expired credential. Also check `npm view`/presence of `srt`, `sandbox-exec` (macOS), or `bwrap`+`socat`+`rg` (Linux).
4. **Isolation of trusted checks (repo test suites = untrusted code)**: run them through **srt**, not through Claude's built-in Bash sandbox. The built-in sandbox covers only Claude's Bash tool and can be silently disabled by an invalid settings file. srt fails closed on bad config, propagates exit codes, and has a library API for violation evidence (`getViolationsForCommand`). Template: `allowWrite: ["<worktree>", "<worktree>/.npm-cache"]`, `denyRead: ["~/.ssh","~/.aws","~/.config/gh","~/.claude*","~/.npmrc"]`, `allowedDomains` from `config.network.allowed_hosts` (often `[]` for tests), `deniedResolvedAddresses` for private ranges, and `allowLocalBinding: true` for UI fixtures and for checks by their `local_binding` (default true), never for workers. **Measured (issue #31, macOS 27.0.1, srt 0.0.78, Claude Code 2.1.292):** it is not loopback only. srt writes `(local ip "*:*")` for bind and inbound, a listener on 0.0.0.0 or `::` answered a connection made to the machine's LAN address, Claude Code's `sandbox.network.allowLocalBinding` behaved the same, and no Seatbelt rule narrows it: `(local ip "localhost:*")` admits every address of the machine, and a numeric host is refused (ADR 0001, "Workers and loopback"). On Linux it does nothing: srt always runs `bwrap --unshare-net`. **srt has no CPU/memory/pids/time limits**, so add a wall-clock kill (process group) and `ulimit`. For hard resource limits use a Docker/OrbStack container (`--network none` or a proxy, `--cpus`, `--memory`, `--pids-limit`) as the stronger tier.
5. **Isolating Claude workers themselves**: the spec requires that workers cannot touch policy or trusted storage, and Read/Edit rules don't bind subprocesses. Wrap the whole `claude` process in srt or a container. Per the docs, srt needs write access to the worktree, `$CLAUDE_CONFIG_DIR` + `~/.claude.json`, and `/private/tmp`, plus network to `api.anthropic.com`, `claude.ai`, and `platform.claude.com` (OAuth refresh). Mount `.orbit/` read-only or keep it outside the writable set.
   - **Verified (gaps V5).** Wrapping `claude -p` in srt works only under these conditions:
     - Use `srt --settings f -- claude …`.
     - Claude's Bash tool needs these writable paths besides the worktree and `$CLAUDE_CONFIG_DIR`:
       - `/tmp/claude` (srt's TMPDIR)
       - `/private/tmp/claude-<uid>`
       - the glob `/tmp/claude-*-cwd`
       Globs worked on macOS.
     - Each of these produced an EPERM in the tool result until it was added.
   - **Nested Seatbelt fails.** With Claude's built-in sandbox enabled inside srt, every Bash call returned `sandbox-exec: sandbox_apply: Operation not permitted` (exit 71). With `failIfUnavailable:true` and `allowUnsandboxedCommands:false`, Claude did **not** exit at startup; each command failed closed instead. Pick one layer, not both.
   - **Subscription login is invisible under srt.** `claude auth status` inside srt reported `loggedIn:false, authMethod:"none"`; on the host it reported `claude.ai` / `max`. This held even with `allowMachLookup:["*"]` and the Anthropic domains allowed. The root cause is UNVERIFIED. srt-wrapped workers therefore need env credentials (`ANTHROPIC_API_KEY` was verified via the mock; `CLAUDE_CODE_OAUTH_TOKEN` is UNVERIFIED).
6. **Untrusted repo hardening**: never run `-p` in a target repo with default sources. A malicious `.claude/settings.json` hook or `.mcp.json` server runs on the host without a trust prompt (§1.7).
7. **Model registry**: seed the table in §5, then refresh from each result's `modelUsage` (`contextWindow`, `maxOutputTokens`, `costUSD`, `canonicalModel`). Record the resolved model because aliases move and content fallback switches models mid-session. Keep `fable` behind explicit policy because `-p` bills usage credits without consent. Pin full IDs, not aliases, for reproducible evidence.
8. **Validate before spawn**: effort values (an invalid one is ignored with only a warning), the settings JSON (an invalid one is silently ignored in `-p`), the `--json-schema` (fails fast, which is fine), and the permission-mode string.
9. **Cancellation**: send SIGINT to end the turn cleanly, then SIGTERM after a grace period (exit 143, no result recorded), then SIGKILL the process group. After SIGTERM the controller must synthesize a "cancelled" record, because no result line exists. **Verified: SIGINT also writes no result line and exits 0**, so classify "no result line" as cancelled or crashed regardless of exit code. A repo `.mcp.json` stdio server spawned by a default-sources `-p` run was **still running after `claude` exited** (gaps V4), so kill the whole process group.
10. **Escalate to the lead**: the policy statement on third-party products and claude.ai login (§6).
