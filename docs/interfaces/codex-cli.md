# Codex CLI as an independent review provider: verified interface reference

Verified 2026-10-03 against **codex-cli 0.153.4** (`~/.local/bin/codex` -> `~/.codex/packages/standalone/current/bin/codex`), macOS 27.
`codex doctor --json` reports that **0.160.0** is the latest release. The installed CLI is behind it, and that has consequences (see §6).

Evidence tags used below:
- **[CLI]**: local command output. The command is quoted.
- **[DOC]**: official docs. `developers.openai.com/codex/*` now 308-redirects to `learn.chatgpt.com/docs/*`, and the Markdown twins are at `/docs/<slug>.md`.
- **[SRC]**: openai/codex source at tag `rust-v0.153.4` (sha 042fb41b), which matches the installed binary.
- **[LIVE]**: observed by running the binary. Where a run needed no credentials, it used a throwaway `CODEX_HOME=$(mktemp -d)`.
- **UNVERIFIED**: not confirmed. Do not build on it without checking.

Primary doc pages:
- NI = https://learn.chatgpt.com/docs/non-interactive-mode
- SEC = https://learn.chatgpt.com/docs/agent-approvals-security
- CFG = https://learn.chatgpt.com/docs/config-file/config-reference
- ENV = https://learn.chatgpt.com/docs/config-file/environment-variables
- AUTH = https://learn.chatgpt.com/docs/auth
- CMD = https://learn.chatgpt.com/docs/developer-commands?surface=cli
- MOD = https://learn.chatgpt.com/docs/models
- SO = https://developers.openai.com/api/docs/guides/structured-outputs
- DATA = https://developers.openai.com/api/docs/guides/your-data

---

## 0. Recommended invocation for Orbit's review adapter

```bash
# cwd = candidate worktree (a git repo). The prompt goes in on stdin; stdin is then closed.
codex exec \
  --sandbox read-only \
  --ephemeral \                      # or omit to allow `codex exec resume <thread_id>`
  --ignore-user-config \             # skip $CODEX_HOME/config.toml (model, notify, MCP servers...)
  --json \
  --output-schema /abs/review-findings.schema.json \
  -o /abs/run/<id>/last-message.json \
  -m <model-from-catalog> \
  -c model_reasoning_effort='"high"' \
  -c web_search='"disabled"' \
  --disable multi_agent \            # verified: removes the multi_agent_v1 (subagent) tool from the request
  -C /abs/worktree \
  -  < /abs/run/<id>/review-packet.md
```

- **Spawn settings.** Use `stdio: ['pipe' (write packet, then end), 'pipe', 'pipe']`, or pass `'ignore'` for stdin if the prompt is an argument. See §2 for the stdin deadlock.
- **Model.** Always pass `-m` explicitly, with a model taken from `codex debug models` for the installed CLI. See §6: the user's configured default does not work on 0.153.4.
- **Process group.** Spawn with `detached: true` and kill the process group on cancel. See §7.

---

## 1. `codex exec` flags (0.153.4)

Source: [CLI] `codex exec --help`. Alias: `codex e` [CLI `codex --help`].

| Flag | Meaning / values |
|---|---|
| `[PROMPT]` | The prompt. If it is omitted or is `-`, the prompt is read from stdin. If stdin is piped **and** a prompt argument is given, stdin is appended as a `<stdin>` block. |
| `-c, --config <key=value>` | Overrides a config value using a dotted path. The value is parsed as TOML, falling back to a literal string. Example: `-c model_reasoning_effort='"high"'`. |
| `--enable/--disable <FEATURE>` | Equivalent to `-c features.<name>=true/false`. |
| `--strict-config` | Errors on unknown config fields. |
| `-i, --image <FILE>...` | Attaches images to the initial prompt. Sent as `UserInput::LocalImage` [SRC lib.rs]. |
| `-m, --model <MODEL>` | Model slug. |
| `--oss`, `--local-provider <lmstudio\|ollama>` | Local model provider. |
| `-p, --profile <NAME>` | Layers `$CODEX_HOME/<name>.config.toml` on top of the base config. |
| `-s, --sandbox <MODE>` | One of `read-only`, `workspace-write`, `danger-full-access`. Any other value exits 2 [LIVE]. |
| `--approve-for-me` (alias `--not-so-yolo` [SRC shared_options.rs]) | Routes approval requests through automatic review using the workspace-write sandbox. Conflicts with `--sandbox` and with `--dangerously-bypass-approvals-and-sandbox` [SRC]. |
| `--dangerously-bypass-approvals-and-sandbox` (alias `--yolo` [SRC]) | No sandbox and no approvals. It also skips the git-repo check [SRC lib.rs:801]. |
| `--dangerously-bypass-hook-trust` | Runs enabled hooks without persisted trust. |
| `-C, --cd <DIR>` | Working root. |
| `--add-dir <DIR>` | Additional writable dirs. |
| `--thread-source <SOURCE>` | Thread classification. |
| `--skip-git-repo-check` | Allows running outside a git repo. |
| `--ephemeral` | Does not persist session files. A run made this way cannot be resumed. |
| `--ignore-user-config` | Does not load `$CODEX_HOME/config.toml`. Auth still comes from `CODEX_HOME`. |
| `--ignore-rules` | Skips user and project execpolicy `.rules` files. |
| `--output-schema <FILE>` | JSON Schema file for the final response. |
| `--color <always\|never\|auto>` | Defaults to `auto`. |
| `--json` (hidden alias `--experimental-json` [SRC cli.rs:61], which the TS SDK uses) | stdout becomes JSONL. |
| `-o, --output-last-message <FILE>` | Writes the final agent message to a file. |

Subcommands [CLI `codex exec --help`]:
- `resume [SESSION_ID] [PROMPT]` takes `--last` and `--all`.
- `fork <SESSION_ID> [PROMPT]`.
- `review [PROMPT]` takes `--uncommitted`, `--base <BRANCH>`, `--commit <SHA>` and `--title`. A top-level `codex review` exists with the same flags and runs the same code path [SRC cli/main.rs:1160].

### Flags that DO NOT exist on `codex exec` 0.153.4 (docs disagree)

| Flag | [LIVE] result | What the docs say |
|---|---|---|
| `--full-auto` | `error: unexpected argument '--full-auto' found`, exit 2 | NI and SEC: "deprecated compatibility flag and prints a warning". **Docs are stale for 0.153.4. Never emit this flag.** |
| `-a` / `--ask-for-approval` | `error: unexpected argument '-a' found`, exit 2 | SEC: `--sandbox read-only --ask-for-approval never` for "Read-only non-interactive (CI)". **Rejected by `exec`.** `-a` exists only on the top-level TUI (`codex --help`: `on-request`, `never`). `codex -a never exec ...` parses, but the root `approval_policy` is **not inherited** by exec. Only shared options are inherited [SRC cli/main.rs:1150 `inherit_exec_root_options`]. |

---

## 2. Approvals and prompt input: exec never blocks on an approval prompt

- **Headless policy.** Exec forces `approval_policy = Never` as a harness override [SRC lib.rs:411-413: "Default to never ask for approvals in headless mode"]. The one exception is when the resolved `approvals_reviewer == auto_review`, which happens with `--approve-for-me` or `-c approvals_reviewer=auto_review` [SRC lib.rs:587-618].
- **Approval requests are rejected.** If any approval request still reaches the client, it is rejected with JSON-RPC error `-32000` and the message `"... approval is not supported in exec mode for thread ..."`. This covers command exec, file change, apply_patch, permissions, `request_user_input` and dynamic tools [SRC lib.rs:1831-1940]. **The rejection sets `error_seen`, so the process exits 1.**
- **MCP elicitations** are auto-cancelled, not prompted [SRC lib.rs:~1810].
- **Under `never`,** "Execution failures are immediately returned to the model" [CLI `codex --help`, `-a` description]. CFG says to use `never` for non-interactive runs.
- **Sandbox remains independent of approvals.** `--sandbox read-only` still applies.
  - `read-only`: network is off.
  - `workspace-write`: network is off unless `sandbox_workspace_write.network_access=true`.
  - Protected paths stay read-only even when writable: `.git`, `.agents` and `.codex` under each writable root [DOC SEC].
- **Exec default sandbox is `read-only`** [DOC NI "By default, `codex exec` runs in a read-only sandbox"]. `codex doctor` with an empty home reports `approval policy = OnRequest`, which is the TUI default; exec overrides it as described above.

### Prompt input and the stdin gotcha

Source: [SRC lib.rs:2049-2133] and [LIVE].

- **Prompt as an argument, stdin not a TTY.** Exec reads stdin **to EOF** (stderr: `Reading additional input from stdin...`) before it starts. [LIVE] With an open, never-closed pipe there was no output for 5 s. `thread.started` appeared only after stdin was closed. Node's default `stdio: 'pipe'` will therefore **hang forever** unless you `child.stdin.end()` or use `stdio: ['ignore', ...]`.
- **Combined prompt format.** With both an argument and piped stdin, the prompt becomes `"{prompt}\n\n<stdin>\n{stdin}\n</stdin>"`.
- **`-`, or no argument with piped stdin.** Stdin is the whole prompt. Empty stdin gives `No prompt provided via stdin.` and exit 1 [LIVE].
- **No argument and stdin is a TTY.** Gives `No prompt provided. Either specify one as an argument or pipe the prompt into stdin.` and exit 1.
- **Encoding.** Stdin must be UTF-8. UTF-16 with a BOM is decoded; other encodings fail with exit 1.
- **What the official TS SDK does.** It runs `exec --experimental-json [--config ...] [--model] [--sandbox] [--cd] [--skip-git-repo-check] [--output-schema]`, then `stdin.write(input); stdin.end()` [SRC sdk/typescript/src/exec.ts:92-209]. Orbit should copy that pattern.

---

## 3. `--json` JSONL event stream

stdout is **only** JSONL, one object per line. stderr carries `Reading ... stdin...` and `RUST_LOG` lines; exec defaults to `error` level [DOC ENV].

Event types [SRC exec_events.rs; DOC NI]:

```ts
type ThreadEvent =
  | { type: "thread.started"; thread_id: string }            // first line; = session id for `exec resume`
  | { type: "turn.started" }
  | { type: "turn.completed"; usage: Usage }                 // terminal success
  | { type: "turn.failed"; error: { message: string } }      // terminal failure
  | { type: "item.started" | "item.updated" | "item.completed"; item: ThreadItem }
  | { type: "error"; message: string };                      // NOT necessarily fatal (see below)

type Usage = { input_tokens: number; cached_input_tokens: number;
               cache_write_input_tokens: number;   // present in 0.153.4 struct; absent from doc sample; SDK does `??= 0`
               output_tokens: number; reasoning_output_tokens: number };

type ThreadItem = { id: string } & (
  | { type: "agent_message"; text: string }   // with --output-schema, text is a JSON string
  | { type: "reasoning"; text: string }
  | { type: "command_execution"; command: string; aggregated_output: string; exit_code: number|null;
      status: "in_progress"|"completed"|"failed"|"declined" }
  | { type: "file_change"; changes: {path: string; kind: "add"|"delete"|"update"}[]; status: "in_progress"|"completed"|"failed" }
  | { type: "mcp_tool_call"; server: string; tool: string; arguments: unknown;
      result: {content: unknown[]; structured_content: unknown|null; _meta?: unknown}|null;
      error: {message: string}|null; status: "in_progress"|"completed"|"failed" }
  | { type: "collab_tool_call"; tool: "spawn_agent"|"send_input"|"wait"|"close_agent"; sender_thread_id: string;
      receiver_thread_ids: string[]; prompt: string|null; agents_states: Record<string,{status: string; message: string|null}>;
      status: "in_progress"|"completed"|"failed" }   // not in docs; in SRC
  | { type: "web_search"; id: string; query: string; action: unknown; results?: unknown[] }
  | { type: "todo_list"; items: {text: string; completed: boolean}[] }
  | { type: "error"; message: string } );        // non-fatal warning item (e.g. deprecation, model-metadata fallback)
```

### Semantics

Sources: [SRC event_processor_with_jsonl_output.rs, lib.rs:1039-1145] and [LIVE].

- **Ordering.** `thread.started` comes first. An `item.completed{type:"error"}` warning can arrive **before** `turn.started` [LIVE].
- **Top-level `error` events are emitted for retries.** One example is `"Reconnecting... 2/5 (...)"`. Do **not** treat `error` as terminal. Only `turn.completed` / `turn.failed` are terminal, or process exit when interrupted.
- **Final message.** It is the last `item.completed` whose `item.type == "agent_message"`, captured on `turn.completed`.
- **No usage on failure.** `turn.failed` carries no usage, so Orbit gets no token usage on failure.
- **Interrupt.** On interrupt there is **no** `turn.completed` / `turn.failed` line; see §7.
- **Version drift.** Docs examples omit `cache_write_input_tokens` and `collab_tool_call`. Parse tolerantly and ignore unknown `type`s.

### Live samples (trimmed)

**A. The single permitted real call.** It failed with HTTP 400 before inference. Command (cwd = scratch dir, real `CODEX_HOME`, ChatGPT login):

`codex exec --skip-git-repo-check --ephemeral --ignore-user-config --sandbox read-only --json --output-schema schema.json -o last.json -m gpt-6.1-sol -c model_reasoning_effort='"low"' '<prompt>' </dev/null`

Result: exit 1, 3.0 s. `last.json` was **not created**. stderr: `Reading additional input from stdin...`

```jsonl
{"type":"thread.started","thread_id":"01a10123-f667-7060-adfb-6c75b38078a2"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `gpt-6.1-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues."}}
{"type":"turn.started"}
{"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\"}}"}
{"type":"turn.failed","error":{"message":"{\"type\":\"error\",\"status\":400,\"error\":{\"type\":\"invalid_request_error\",\"message\":\"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.\"}}"}}
```

**B. No credentials** (empty `CODEX_HOME`, `--json "hi"`). Exit 1 after **16.9 s**: 5 WebSocket retries, a fallback to HTTPS, then 5 more retries.

```jsonl
{"type":"thread.started","thread_id":"01a10121-97fb-7b10-a5ba-1f2e746b7cc1"}
{"type":"turn.started"}
{"type":"error","message":"Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: wss://api.openai.com/v1/responses, cf-ray: ...)"}
... (3/5..5/5)
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport. unexpected status 401 Unauthorized: ..."}}
{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized: ..., url: https://api.openai.com/v1/responses, cf-ray: ..., request id: req_...)"}
... (2/5..5/5)
{"type":"error","message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, url: https://api.openai.com/v1/responses, ..."}
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer or basic authentication in header, ..."}}
```

**C. Invalid API key** (`CODEX_API_KEY=sk-invalid...`). Exit 1 after 19.4 s, and `-o` file not created. The final message contains a machine-matchable code:

```
{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Incorrect API key provided: sk-inval**************-000. ..., url: https://api.openai.com/v1/responses, cf-ray: ..., request id: req_..., auth error: 401, auth error code: invalid_api_key"}}
```

**D′. Success path captured against a local mock Responses API** (gaps V6; no OpenAI call). Command, with a temp `CODEX_HOME`:

`codex exec --ephemeral --ignore-user-config --sandbox read-only --json --output-schema review.schema.json -o last.json -m mock-model -c model_provider='"mock"' -c 'model_providers.mock={name="mock",base_url="http://127.0.0.1:47812/v1",env_key="MOCK_KEY",wire_api="responses",supports_websockets=false}' -c web_search='"disabled"' - < packet.md`

It exited 0 in about 1 s and wrote `-o` with the agent text. The captured request body had `POST /v1/responses`, `store:false`, `stream:true` and `text.format={"type":"json_schema","strict":true,"schema":<file>,"name":"codex_output_schema"}`, which confirms the [SRC] claim. Tools offered: `exec_command, write_stdin, request_user_input, view_image, multi_agent_v1`, plus `web_search` unless it is disabled.
```jsonl
{"type":"thread.started","thread_id":"01a10135-b266-7493-be87-a577cbd9146b"}
{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata for `mock-model` not found. Defaulting to fallback metadata; ..."}}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"{\"verdict\":\"PASS\",\"findings\":[]}\n"}}
{"type":"turn.completed","usage":{"input_tokens":1234,"cached_input_tokens":1000,"cache_write_input_tokens":0,"output_tokens":56,"reasoning_output_tokens":7}}
```

**D. Success-path shape from the docs.** The one permitted live call failed (A). The doc sample [DOC NI] and [SRC] agree:

```jsonl
{"type":"thread.started","thread_id":"0199a213-81c0-7800-8aa1-bbab2a035a53"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"Repo contains docs, sdk, and examples directories."}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

---

## 4. `--output-schema` and `-o`

- **How the schema is sent.** The file is read and parsed as JSON locally:
  - Missing file: `Failed to read output schema file X: No such file or directory`, exit 1 [LIVE].
  - Invalid JSON: `Output schema file X is not valid JSON: ...`, exit 1 [LIVE].
  - Neither failure makes a network call.

  The schema is then sent to the Responses API as `text.format = {"type":"json_schema","name":"codex_output_schema","strict":true,"schema":<file>}` [SRC codex-api/src/common.rs:389-406; exec test `exec/tests/suite/output_schema.rs` asserts `strict: true`].
- **OpenAI strict Structured Outputs rules apply** [DOC SO "Supported schemas"]:
  - The root must be `type: "object"` and must not be `anyOf`.
  - **Every property must be listed in `required`.** Emulate optional fields with `"type": ["string","null"]`.
  - **`additionalProperties: false` must be set on every object.**
  - Supported:
    - Types: string, number, boolean, integer, object, array, enum, anyOf. Each `anyOf` branch must itself follow this subset.
    - Defs: `$defs` and `$ref`, including recursion.
    - String keywords: `pattern`, plus `format` values `date-time`, `time`, `date`, `duration`, `email`, `hostname`, `ipv4`, `ipv6`, `uuid`.
    - Number keywords: `multipleOf`, `maximum`, `exclusiveMaximum`, `minimum`, `exclusiveMinimum`.
    - Array keywords: `minItems`, `maxItems`.
  - Unsupported: `allOf`, `not`, `dependentRequired`, `dependentSchemas`, `if`/`then`/`else`.
  - Limits:
    - At most 5000 object properties and 10 nesting levels.
    - At most 120,000 chars across all property names, definition names, enum values and const values.
    - At most 1000 enum values in total. When a single string enum has more than 250 values, those values may total at most 15,000 chars.
  - Keys are produced in schema order.
  - An unsupported schema under `strict: true` makes the API "return an error". The exact Codex surfacing is **UNVERIFIED**; it is presumably `turn.failed` with a 400 message, as in sample A.
- **How the result arrives.** The result is the `agent_message.text` **JSON string**. **Verified (mock, gaps V6): Codex does not validate it locally.** A mock reply of `not json at all`, and one of `{"verdict":"MAYBE","extra":1}`, each produced `turn.completed`, **exit 0**, and an `-o` file containing that text. Orbit must `JSON.parse` the result and validate it with its own schema validator (e.g. ajv).
- **`-o FILE` behaviour** [SRC event_processor.rs, jsonl processor:520-628; LIVE]:
  - Written **only after `turn.completed`**.
  - Not written on `turn.failed` or on interrupt [LIVE A, C, SIGINT test]. A stale file from an earlier run stays, so delete it before each run.
  - If the turn completed with no agent message, the file is written empty and stderr gets `Warning: no last agent message; wrote empty content to ...`.
  - In non-JSON mode the final message also goes to stdout [DOC NI].
- **`codex exec review` ignores `--output-schema`.** The flag is accepted (global), but the review path sends `review/start` without a schema [SRC lib.rs:711-715, 1010-1030]. **For structured findings, use plain `codex exec` with an Orbit-built review packet, not `exec review`.**
- **Spec mismatch.** The spec's findings JSON (§12) must be adapted for strict mode. Nullable fields must still be listed in `required`, e.g. `"suggested_validation": {"type":["string","null"]}`. Use `"verdict": {"enum":[...]}`.

---

## 5. Exit codes (`codex exec`)

| Condition | Exit | Evidence |
|---|---|---|
| `turn.completed` | 0 | [SRC lib.rs:1141] |
| `turn.failed`, or a non-retry `error` for this turn | 1 | [SRC lib.rs:1083-1100; LIVE A/B/C] |
| Interrupted turn (SIGINT) | 1 | [SRC; LIVE] |
| Approval or other server request rejected in exec | 1 | [SRC lib.rs:1944] |
| Not in a git repo without `--skip-git-repo-check`: `Not inside a trusted directory and --skip-git-repo-check was not specified.` | 1 | [LIVE] |
| Bad `-c` override, bad rules file, missing or invalid schema, no prompt, login restriction violated | 1 | [SRC; LIVE] |
| Unknown flag or invalid enum value (clap) | 2 | [LIVE] |
| SIGTERM | killed by signal (Node: `code=null, signal='SIGTERM'`; shell 143) | [LIVE rc=-15] |

---

## 6. Auth, credentials and models

### `codex login status`

Run live:
- Logged in with ChatGPT: **stderr** `Logged in using ChatGPT`, exit **0**, stdout empty.
- No credentials: **stderr** `Not logged in`, exit **1** (temp `CODEX_HOME`).
- After `echo sk-fake... | codex login --with-api-key`: `Logged in using an API key - sk-fake-***67890`, exit 0. **The key is not validated.** A fake key reports logged in.
- `CODEX_API_KEY` / `OPENAI_API_KEY` set in the environment with no stored auth: `Not logged in`, exit 1, **even though `codex exec` does use `CODEX_API_KEY`** [DOC NI, ENV: "`CODEX_API_KEY`: Exec, review, TypeScript SDK, remote exec-server"; SRC lib.rs:554 `enable_codex_api_key_env: true`].
- Docs: "`codex login status` exits with `0` when credentials are present" [DOC CMD]. Presence is all it checks, not validity.

### Real credential check: `codex doctor --json`

[CLI] It took about 4.3 s. Exit 0 when overall ok; exit 1 with an empty home.
- `checks["auth.credentials"].status` is `"ok"` or `"fail"`. It includes `details["stored auth mode"]` (`chatgpt`) and a remediation hint.
- `checks["network.websocket_reachability"]` performs an **authenticated Responses WebSocket handshake**. Healthy: `handshake result: HTTP 101 Switching Protocols`. No auth: a `401 ... Missing bearer` error.
- `checks["config.load"].details.model` gives the configured model.
- `checks["updates.status"].details["latest version"]` gives the latest version.
- The report is redacted (`--json`: "Emit a redacted machine-readable report").

Use it as `validateCredentials()`, with `login status` as a 20 ms fast pre-check.

### Auth modes

[DOC AUTH; CLI `codex login --help`]
- **ChatGPT OAuth** (default `codex login`, or `--device-auth`).
- **`--with-api-key`** (key on stdin).
- **`--with-access-token`** (stdin; Enterprise Codex access tokens; env `CODEX_ACCESS_TOKEN`).
- **Workload identity** via env `OPENAI_FEDERATION_RULE_ID` / `OPENAI_IDENTITY_TOKEN_FILE` [DOC ENV].

Storage: `cli_auth_credentials_store = file|keyring|auto|ephemeral` [DOC AUTH].

`auth.json` shapes. These are key names only; secrets were not read.
- ChatGPT: `{auth_mode, OPENAI_API_KEY:null, tokens:{id_token,access_token,refresh_token,account_id}, last_refresh}`.
- API key: `{auth_mode, OPENAI_API_KEY}`.

Billing and endpoint:
- **API key** usage is billed at API rates and goes to `api.openai.com/v1/responses` [LIVE B/C].
- **ChatGPT auth** goes to `wss://chatgpt.com/backend-api/...` [CLI doctor] and uses plan credits.

### Expired or revoked ChatGPT credential

ChatGPT tokens auto-refresh during use [DOC AUTH]. Terminal refresh failures produce these exact strings [SRC login/src/auth/manager.rs:191-196]:
- `Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.`
- `... because your refresh token was already used. ...` (refresh tokens are single-use)
- `... because your refresh token was revoked. ...`
- `Your access token could not be refreshed. Please log out and sign in again.`
- `... because you have since logged out or signed in to another account. Please sign in again.`

How these reach the exec JSONL (presumably a `turn.failed` message) is **UNVERIFIED**. Match on the substring `Please log out and sign in again` or `sign in again`.

**Do not copy `auth.json` into a second `CODEX_HOME`.** A refresh in one home invalidates the refresh token in the other ("already used").

### Models and reasoning effort

- **Selection.** `-m/--model` or the `model` key in config [DOC MOD: `codex exec -m gpt-6.1-sol "..."`]. With no model set, "uses a recommended model" [DOC MOD]. Which slug that is was **UNVERIFIED**. The catalog `priority` suggests the lowest-priority listed slug, currently `gpt-6-astra`.
- **Listing.** `codex debug models` renders the raw catalog JSON and refreshes it for this client version [CLI]. `codex debug models --bundled` shows only the catalog shipped in the binary. Per-model fields: `slug`, `display_name`, `default_reasoning_level`, `supported_reasoning_levels[].effort`, `visibility` (`list`/`hide`), `supported_in_api`, `priority`.
- **Live catalog for 0.153.4 on this ChatGPT account** (2026-10-03):
  - `gpt-6-astra` (default effort `medium`)
  - `gpt-5.6-sol` (`low`)
  - `gpt-5.6-terra` (`medium`)
  - `gpt-5.6-luna` (`medium`, no `ultra`)
  - `gpt-5.5` (`medium`; efforts low through xhigh; retiring from ChatGPT/Codex on 2026-10-14 [DOC MOD])
  - hidden: `gpt-reserve`, `codex-auto-review`

  **`gpt-6.1-sol`, `gpt-6-sol` and `gpt-6-luna` are absent** for CLI 0.153.4. The desktop app's 0.159.2 cache did list `gpt-6.1-sol`.
- **Problem with the user's config.** `~/.codex/config.toml` sets `model = "gpt-6.1-sol"` and `model_reasoning_effort = "low"`. With CLI 0.153.4 this produced HTTP 400 `The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.` [LIVE A]. **An Orbit run that inherits user config will fail until the CLI is updated (0.160.0 is available).** Root cause (server gating by client version, or a catalog mismatch) is **UNVERIFIED**.
- **Shared cache.** `$CODEX_HOME/models_cache.json` is shared with the desktop app and is overwritten by whichever client fetched last. Its `client_version` flipped from 0.159.2 to 0.153.4 after these probes [CLI].
- **Reasoning effort.** Set it with `-c model_reasoning_effort='"<level>"'`. Levels are `low|medium|high|xhigh|max|ultra`, and availability depends on the model [DOC CFG; catalog]. `ultra` "uses subagents" [DOC MOD], so avoid it for an isolated reviewer. Related keys:
  - `model_reasoning_summary`: `auto|concise|detailed|none`
  - `model_verbosity`: `low|medium|high`
  - `service_tier` (`fast` maps to `priority`) [DOC CFG]

---

## 7. Cancellation, resume and fork

- **SIGINT.** Exec installs a `tokio::signal::ctrl_c` handler, which sends `turn/interrupt` [SRC lib.rs:946-1066]. [LIVE] SIGINT 2 s into an active turn gave exit **1** within about 0.1 s. **No** `turn.completed`/`turn.failed` line was emitted, and the `-o` file was not written. Orbit should treat "process exited and no terminal event was seen" as `cancelled`.
- **SIGTERM.** There is no handler [SRC: only ctrl_c]. [LIVE] The process was killed by the signal (rc -15), with no further events. Whether sandboxed child processes are cleaned up on SIGTERM is **UNVERIFIED**. Spawn detached and kill the process group: SIGINT first, then SIGKILL after a grace period.
- **Resume.** `codex exec resume <SESSION_ID|thread-name> [PROMPT]` or `codex exec resume --last [PROMPT]` [CLI].
  - `--last` is scoped to the current cwd. `--all` disables the cwd filter.
  - Resume accepts `--json`, `-o`, `--output-schema`, `-m`, `-i` and `--ephemeral`.
  - **Resume has no `--sandbox` flag.** Help lists only `--dangerously-bypass-approvals-and-sandbox`. Whether the original sandbox is restored is **UNVERIFIED**; `-c sandbox_mode='"read-only"'` is a likely override.
  - Session id = `thread.started.thread_id`. Rollouts are stored at `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl` [CLI ls].
  - `--ephemeral` runs cannot be resumed.
- **Fork.** `codex exec fork <SESSION_ID> [PROMPT]`. A fork with `-o`/`--output-schema` requires a prompt [SRC lib.rs:771].

---

## 8. Isolation knobs (what leaks into a "review" run)

- **`--ignore-user-config`** skips only the user `config.toml` layer [SRC config/src/loader/mod.rs:534]. **Project config (`<repo>/.codex/config.toml`) still loads.** Effects of the flag on `~/.codex/hooks.json` (this user has hooks on all events, including `PreToolUse`, `Stop` and `SessionStart`) and on `~/.codex/AGENTS.md` are **UNVERIFIED**.
- **Project trust.** `trust_level` entries in the user config control project trust. The exec git-repo check message says "trusted directory".
- **Execpolicy rules.** `--ignore-rules` skips user and project execpolicy `.rules`.
- **`CODEX_HOME`.** Defaults to `~/.codex`, and the directory must already exist [DOC ENV]. A dedicated `CODEX_HOME` plus `CODEX_API_KEY` gives full isolation in API-key mode. That isn't safe for ChatGPT auth because of refresh-token rotation (§6).
- **Hooks and MCP.** User-level hooks can fire inside exec. `--dangerously-bypass-hook-trust` exists, but Orbit must not use it. A required MCP server (`required = true`) that fails to init makes exec exit [DOC NI].
- **Web search.** Default `web_search = "cached"`, an OpenAI index. Set `-c web_search='"disabled"'` for reviewers [DOC CFG; SDK uses the same override].

---

## 9. Data handling and privacy (sending diffs to OpenAI)

- **Request storage.** Codex sends Responses requests with `store: false` [SRC core/src/client.rs:1022].
- **Request content.** Everything the model sees is transmitted: the prompt and review packet, AGENTS.md instructions, tool outputs, and **any file the agent reads**. The `read-only` sandbox blocks writes and network for commands, not reads of accessible files [DOC SEC: "read accessible files"].
  - Restrict reads with permissions profiles: `permissions.<name>.filesystem."<glob>" = "deny"`, `default_permissions` [DOC CFG].
  - Or rely on Orbit's packet plus a minimal worktree.
- **Policy depends on auth mode** [DOC AUTH]:
  - **ChatGPT login.** "Codex usage follows your ChatGPT workspace permissions, RBAC, and ChatGPT Enterprise retention and residency settings." Business, Enterprise and Edu data is "not used to train ... by default" [DOC enterprise/chatgpt-work-local-security]. For Free/Plus/Pro, training follows the account's ChatGPT Data Controls setting ([help.openai.com data controls](https://help.openai.com/en/articles/7730893-data-controls-in-chatgpt), as linked from the Codex manual). The exact defaults per personal plan are **UNVERIFIED** here.
  - **API key.** "Usage follows your API organization's retention and data-sharing settings." API data is "not used to train or improve OpenAI models (unless you explicitly opt in)". Abuse-monitoring logs may contain prompts and responses and are "retained for up to 30 days". ZDR and Modified Abuse Monitoring are available to approved orgs [DOC DATA]. `/v1/responses` row: training "No", abuse monitoring "30 days", ZDR-eligible "Yes, see limitations" [DOC DATA].
- **Telemetry.** OpenTelemetry export is opt-in; keep `otel.log_user_prompt = false` [DOC SEC, CFG]. Local transcripts go to `history.jsonl` (`history.persistence = save-all|none`) and to rollouts under `sessions/` unless `--ephemeral` [DOC CFG].
- **CI secrets.** Never put `CODEX_API_KEY`/`OPENAI_API_KEY` in a job-level env where repo code runs; set it inline for the codex process only [DOC NI].

---

## 10. Implications for Orbit (concrete)

1. **`discoverCapabilities()`**
   - Run `codex --version`.
   - Parse `codex exec --help` for `--output-schema`, `--json`, `--ephemeral` and `--ignore-user-config`, and assert that `--full-auto` and `-a` are absent. Don't trust the docs' flag list.
   - Run `codex debug models` to build an eligible model set: `visibility=="list"` plus the efforts each model supports.
   - Record `doctor.updates.status.latest version` and warn when the CLI is out of date.
2. **`validateCredentials()`**
   - Run `codex login status` (exit 0/1, read stderr) as the fast gate.
   - Then run `codex doctor --json` and require `auth.credentials.status=="ok"` and `network.websocket_reachability.status=="ok"`.
   - If `CODEX_API_KEY` is supplied, skip `login status`; it reports "Not logged in" even when exec works.
   - Without this preflight, a bad credential costs about 17-20 s of retries per run.
3. **`startTask()`**
   - Use the §0 command, with argv built as an array (no shell). Always pass `-m` (the user's default `gpt-6.1-sol` currently 400s on 0.153.4) and `--sandbox read-only`. Never pass `--yolo` or `--dangerously-*`.
   - Pass the prompt via stdin with `-` and then end stdin, or use stdin `'ignore'`.
   - Run inside the candidate's git worktree (no `--skip-git-repo-check`). Pin `-C`.
   - Delete any stale `-o` file first.
4. **`streamEvents()`**
   - Parse stdout line-by-line as JSON, tolerating unknown types and fields.
   - Map `error` to a warning or retry, and `item.completed{type:"error"}` to a warning. Only `turn.completed` / `turn.failed` are terminal.
   - Keep stderr in a bounded diagnostic buffer.
5. **`collectResult()`**
   - Take the last `agent_message.text`, or the `-o` file, only after `turn.completed`. Then `JSON.parse` it and validate it with Orbit's own copy of the schema.
   - Treat a parse or validation failure as `REVIEW_INVALID`, not as "no findings".
   - Strict-mode schema rules: every property in `required`, `additionalProperties:false` everywhere, nullable via a union, no `allOf`/`if`.
6. **`cancelTask()`**
   - Send SIGINT to the process group, wait 5-10 s, then send SIGKILL to the group.
   - Classify as `cancelled` when the process exited and no terminal event was seen.
   - Expect exit 1 after SIGINT and `signal=SIGTERM` after SIGTERM.
7. **`reportUsage()`**
   - Read `turn.completed.usage`, defaulting `cache_write_input_tokens` to 0.
   - On `turn.failed` or cancel, usage is unknown, so record `null`; do not record 0.
   - Cost depends on auth mode (API billing vs. plan credits), so record `auth_mode` from doctor.
8. **Data policy gate (spec §12, "Record provider/data-policy eligibility")**
   - Record the auth mode and endpoint (`chatgpt.com/backend-api` vs `api.openai.com`) per run.
   - Block repos marked "no external provider".
   - Strip secrets from the packet.
   - Consider a permissions profile denying `**/.env*` and similar paths.
9. **Isolation**
   - Prefer `--ignore-user-config --ephemeral -c web_search='"disabled"'`.
   - Document that project `.codex/config.toml` and user hooks may still apply.
   - For API-key mode, use a dedicated empty `CODEX_HOME` plus `CODEX_API_KEY` passed only to that child process.
10. **Do not use `codex exec review` for gated review.** It cannot return schema-constrained findings. It could still serve as an optional free-text second opinion.
11. **TypeScript SDK.** `@openai/codex-sdk` (npm `latest` 0.160.0, Node >= 18) bundles `@openai/codex` 0.160.0. It wraps this same exec JSONL protocol, with `codexPathOverride`, `env`, `config` and an `AbortSignal`. It is a viable alternative to hand-spawning. Its bundled CLI version would differ from the user's 0.153.4.

---

## 11. UNVERIFIED / open items

- **Success-path live capture against OpenAI.** The protocol shape is now verified against a local mock provider (§3 D′, gaps V6), but no real OpenAI success was captured. Re-run once with `-m gpt-6-astra` (or after `codex update`) to confirm real-model behaviour.
- **`request_user_input` is offered to the model in exec** (mock request body). If the reviewer model calls it, exec presumably rejects it and exits 1 (§2). That consequence is UNVERIFIED; no mock function call was attempted.
- **`--disable hooks`.** Whether it skips `$CODEX_HOME/hooks.json` is UNVERIFIED. (`--disable multi_agent` was verified to remove the `multi_agent_v1` tool.)
- **Strict-schema rejection.** How an invalid or non-strict schema surfaces in JSONL (expected: `turn.failed` with a 400 message).
- **Expired ChatGPT refresh token.** How it surfaces in exec JSONL; only the message strings are verified from source.
- **Default model when none is configured.** Inferred as the catalog's priority-1 listed model.
- **Server rejection reason.** Why `gpt-6.1-sol` is rejected for CLI 0.153.4 (likely client-version gating).
- **`--ignore-user-config` scope.** Whether it also ignores `~/.codex/hooks.json`, `~/.codex/AGENTS.md`, and the `notify` hook (notify lives in config.toml, so likely skipped).
- **Sandbox on resume.** Whether `exec resume` restores the original sandbox mode.
- **SIGTERM cleanup.** Whether SIGTERM orphans sandboxed child commands.
- **Read scope of `read-only` on macOS Seatbelt.** The exact readable roots were not confirmed.
- ~~**Local validation.**~~ Resolved: Codex does **not** validate output against the schema locally (gaps V6).
- **Personal-plan training default.** ChatGPT Plus/Pro training opt-out defaults for Codex usage.
