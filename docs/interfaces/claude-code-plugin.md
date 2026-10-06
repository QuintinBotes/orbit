# Claude Code plugin interfaces: verified reference for Orbit

Verified 2026-10-03 against Claude Code CLI **2.1.288** (`claude --version`), macOS, Node v22.18.0.

How each fact was checked:
- **[doc]** means the official docs at `https://code.claude.com/docs/en/<page>.md` (fetched raw with curl on 2026-10-03). The pages used were `plugins/manifest-reference`, `plugins/components`, `plugins/cli-reference`, `plugins/loading`, `skills`, `sub-agents`, `hooks`, `hooks-guide`, `goal`, `headless`, `cli-reference`, `env-vars`, `settings`, `settings-reference`, `tools-reference`, `permission-modes` and `agent-sdk/typescript`.
- **[cli]** means local command output, with the command quoted.
- **[probe]** means local runtime probes. These used a scratch plugin plus a **mock Anthropic Messages API** on `127.0.0.1`, set through `ANTHROPIC_BASE_URL` and a fake `ANTHROPIC_API_KEY`, with a fresh `CLAUDE_CONFIG_DIR=$(mktemp -d)` and `env -i`. No paid model calls were made, and no user config was touched. The mock returned scripted `tool_use` and `text` blocks so that real hooks fired on real tool calls.
- **UNVERIFIED** marks anything that neither docs nor local evidence confirmed.

---

## 1. `.claude-plugin/plugin.json`

The manifest is optional. Without it, the plugin name comes from the directory name (`--plugin-dir`) or from the marketplace entry. `name` is the only required key. [doc manifest-reference]

| Field | Type | Notes |
|---|---|---|
| `$schema` | string | Ignored at load. |
| `name` | string | **Required.** Use kebab-case. It can't contain spaces, `@`, `:` or `/`. It namespaces every component (`orbit:verifier`, `/orbit:run`). Validate **errors** on names starting `claude-`, `anthropic-`, `anthropics-` or `cc-plugin-`, on the bare names `claude`, `anthropic`, `claude-code`, `claude-mods`, and on `official` next to `claude` or `anthropic`. `orbit` is fine. |
| `displayName` | string | UI only. |
| `version` | string | Not checked as semver. Setting it **pins** users to that version until it changes. |
| `description` | string | Validate warns if it is missing. |
| `author` | object | `{name (required), email?, url?}`. Validate warns if it is missing. |
| `homepage` | string | **Must parse as a URL or the plugin fails to load.** |
| `repository` | string | Not validated. |
| `license` | string | An SPDX id. |
| `keywords` | string[] | |
| `metadata` | object | Free-form. Claude Code ignores it (v2.1.222+). |
| `icon`, `documentationUrl`, `supportUrl`, `privacyPolicyUrl`, `termsOfServiceUrl` | string | Used only for Anthropic's directory listing. Ignored at load. Accepted without warning on v2.1.281+. |
| `defaultEnabled` | bool | Defaults to `true`. |
| `dependencies` | (string \| {name, marketplace?, version?})[] | Other plugins this one needs. |
| `settings` | object | Only `agent` and `subagentStatusLine` take effect. A root `settings.json` wins over this key. |
| `userConfig` | object | See below. Strict schema. |
| `channels` | object[] | Strict. Bound to one of the plugin's MCP servers. |
| `skills` | path \| path[] | **Adds to** the default `skills/` scan. `"."` or `"./"` means the plugin root. |
| `commands` | path \| path[] \| map | **Replaces** the `commands/` scan. Commands are the legacy format; use skills. |
| `agents` | path \| path[] | `.md` files only, not directories. **Replaces** the `agents/` scan. |
| `hooks` | path \| inline object \| array | **Merges** with `hooks/hooks.json`. A hooks *file* needs the top-level `"hooks"` wrapper. An *inline* object is the bare event map. |
| `mcpServers` | path \| `.mcpb`/`.dxt` \| inline map \| array | Merges with `.mcp.json`. |
| `lspServers` | path \| inline \| array | Merges with `.lsp.json`. Strict schema. |
| `outputStyles`, `workflows` | path \| path[] | Each replaces its default directory. |
| `types` | path | `.d.ts` for mods. |
| `experimental` | object | Holds only `themes`, `monitors` and `evals`. Any other key gets a validate warning. [cli] |

**Path rules.** Every component path must start with `./`. It must also resolve inside the plugin root and must exist. A path containing `..` is an error. [doc]

**Unknown top-level keys** are stripped at load and produce a validate *warning*, so `--strict` fails on them. [cli] For example, `"bin": "./bin"` gave the warning `Unknown field 'bin' (commonly seen in an npm package.json)`.

**Executables: there is no manifest field for them.** Files in a top-level **`bin/`** directory are on the Bash tool's `PATH` while the plugin is enabled, **appended after** the user's PATH, so they cannot shadow `git` and similar commands. [doc components#executables] [probe] The Bash tool resolved `command -v orbit` to `<plugin>/bin/orbit`.
- Gotcha: **claude.ai and Cowork refuse to install a plugin that has a top-level `bin/`.** [doc]
- Gotcha: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR` are **not** set in Bash tool commands. The probe printed `ROOT=unset DATA=unset PROJ=unset`. Substitute `${CLAUDE_PLUGIN_ROOT}` into skill or agent *text* instead. [doc] [probe]

**`userConfig`** keys must match `[A-Za-z_][A-Za-z0-9_]*`. Each option is a *strict* object: an unknown key fails to load. [doc]
- Fields:
  - `type` (required): one of `string|number|boolean|directory|file`
  - `title` (required)
  - `description` (required)
  - optional: `required`, `default`, `options` (string only; v2.1.271+; older versions can't load the plugin), `multiple`, `sensitive`, `min`/`max`
- Values are stored under `pluginConfigs["<plugin>@<marketplace>"].options` in **user or managed settings only**. Project and local entries are ignored. Sensitive values go to the keychain.
- Hooks receive each option as `CLAUDE_PLUGIN_OPTION_<UPPERKEY>`.
- `${user_config.KEY}` is substituted in:
  - MCP and LSP config
  - **exec-form** hook `args`
  - skill and agent text (non-sensitive values only)
- Shell-form hooks **reject** `${user_config.*}`.
- [probe] `--settings '{"pluginConfigs":{"orbit@inline":{"options":{"mode":"autonomous"}}}}'` produced `CLAUDE_PLUGIN_OPTION_MODE=autonomous` in the hook env.
- [probe] With nothing configured, `CLAUDE_PLUGIN_OPTION_MODE` was **empty** even though the option declares `"default": "supervised"`. **Do not rely on `default` reaching hook env.** Apply defaults in the runtime.
- `claude plugin install --config KEY=VALUE` and `claude plugin configure <plugin> --values-stdin` set values from the shell. [cli `claude plugin install --help`, `claude plugin --help`]

**Variables** [doc manifest-reference#environment-variables]

| Var | Value | Where it resolves | Exported to |
|---|---|---|---|
| `CLAUDE_PLUGIN_ROOT` | Install dir of the current version. It changes on update, so never write state there. | Hook `command`/`args`; skill, agent and command bodies; MCP/LSP config | hook, MCP, LSP processes |
| `CLAUDE_PLUGIN_DATA` | `~/.claude/plugins/data/<id>/` per the docs. **In practice it is `$CLAUDE_CONFIG_DIR/plugins/data/<id>/`** (probe below; this machine uses `$CLAUDE_CONFIG_DIR`). Every char of `<id>` outside `[A-Za-z0-9_-]` becomes `-`. It survives updates. | same | hook, MCP (stdio), LSP |
| `CLAUDE_PROJECT_DIR` | The project root where the session started. It does not follow `cd` or worktrees; hook input `cwd` does. | same | hook, LSP |

[probe] For a `--plugin-dir` plugin, the id is `orbit@inline`, so `CLAUDE_PLUGIN_DATA=$CLAUDE_CONFIG_DIR/plugins/data/orbit-inline`.

**Standard layout** [doc]

| Component | Location |
|---|---|
| Skills | `skills/<name>/SKILL.md` |
| Commands | `commands/*.md` |
| Agents | `agents/**/*.md`, scanned recursively; subfolders become name segments: `agents/review/sec.md` → `orbit:review:sec` |
| Hooks | `hooks/hooks.json` |
| MCP servers | `.mcp.json` |
| LSP servers | `.lsp.json` |
| Other components | `output-styles/`, `workflows/`, `themes/`, `monitors/monitors.json` |
| Executables | `bin/` |
| Settings | `settings.json` |

- A **`CLAUDE.md` at the plugin root is not loaded**, and validate warns about it, so `--strict` fails. [cli] The warning reads `root: CLAUDE.md at the plugin root is not loaded as project context`.
- **Node dependency auto-install** happens when the plugin is cached from a marketplace. [doc plugins/loading#node-js-package-dependencies] It needs a root `package.json` plus `package-lock.json`/`npm-shrinkwrap.json` (lockfileVersion 2 or 3) or `bun.lock`. It installs registry dependencies only, pinned exactly, with **`--ignore-scripts`** (so native addons don't compile), no `overrides`, and a 60 s timeout. It is **not** done for `--plugin-dir` or for in-place local-marketplace plugins. For npm-source plugins, use `npm-shrinkwrap.json`.

## 2. Skills: `skills/<name>/SKILL.md`

The frontmatter is read only if `---` is line 1. **Unknown fields are silently ignored**, and `claude plugin validate` does **not** flag them; it only flags YAML that fails to parse. [doc skills#frontmatter-reference] [cli] A skill with `unknownSkillField: true` passed `--strict`.

| Field | Meaning |
|---|---|
| `name` | Sets the last command segment. In a plugin, `/<plugin>:<name>`. Defaults to the directory name. A name that already carries the `orbit:` prefix is not doubled (v2.1.246+). |
| `description` | Recommended. Truncated together with `when_to_use` at **1,536 chars**. |
| `when_to_use` | Appended to `description`. |
| `argument-hint` | Autocomplete hint, e.g. `"<goal>"`. |
| `arguments` | Names for `$name` substitution; a space-separated string or a YAML list. |
| `disable-model-invocation` | `true` means user-only. The description is removed from context. It also **can't be preloaded into subagents** and won't run as a scheduled-task prompt. |
| `user-invocable` | `false` means Claude-only (hidden from the `/` menu). |
| `allowed-tools` | Pre-approves tools **for the invoking turn only**; the grant clears on the next user message. Space- or comma-separated string, or a list. It does not restrict tools. Deny and ask rules still win. |
| `disallowed-tools` | Removes tools while the skill is active, e.g. `AskUserQuestion` for unattended loops. |
| `model` | Override for the rest of the turn; accepts `inherit`. With `context: fork`, it sets the fork's model. |
| `effort` | `low\|medium\|high\|xhigh\|max` |
| `context` | `fork` runs the skill in a new subagent. It does not see the conversation history. |
| `agent` | Subagent type used with `context: fork`. Defaults to `general-purpose`. |
| `background` | Applies with `context: fork`. Default `true` (runs in background). `false` makes the turn wait for the result. Forks always wait in `-p`/SDK. |
| `hooks` | Registered on invoke and kept **for the rest of the session**. Handlers here support `once: true`. |
| `paths` | Globs that gate auto-activation. |
| `shell` | `bash` (default) or `powershell` for injected `` !`cmd` `` blocks. |
| `metadata`, `license`, `compatibility` | Accepted; no effect. |

- **Portability.** claude.ai uploads, the Skills API and `package_skill.py` accept only `name`, `description`, `license`, `compatibility`, `metadata` and `allowed-tools`. Any other key is a **hard error** there. [doc]
- **Substitutions** (in the body, and in the `allowed-tools` Bash rules for the `${...}` forms):
  - `$ARGUMENTS`: the full string as typed, quotes kept. If no placeholder receives the arguments, Claude Code appends `ARGUMENTS: <value>`.
  - `$ARGUMENTS[N]`, `$N`: 0-based, shell-quoted splitting.
  - `$name`: from `arguments`.
  - `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`
  - `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}` (plugin skills only)
  - Escape a literal `$` with `\$1`. [doc]
- [probe] `claude -p '/orbit:run "Implement CSV export" --mode autonomous'` sent the model:
  - `<command-name>/orbit:run</command-name><command-args>"Implement CSV export" --mode autonomous</command-args>`
  - then `Base directory for this skill: <plugin>/skills/run` followed by the body. `$ARGUMENTS` became `"Implement CSV export" --mode autonomous`, quotes kept, and `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` were replaced with absolute paths.
  - `/orbit:status run-42 extra` turned `$0` into `run-42` and `$ARGUMENTS` into `run-42 extra`.
- **Namespacing and collisions.** [probe] The `-p` init event listed `slash_commands` as `orbit:run`, `orbit:status`, `orbit:resume`, `orbit:verify`, plus the **bundled** `run` and `verify` skills.
  - The bare `/run` and `/verify` resolve to the bundled skills, and `/status` and `/resume` are built-in commands. **Always document and invoke the `/orbit:<name>` form.**
- **Injected commands** (`` !`cmd` ``) run before the skill renders. Any non-zero exit **aborts the whole invocation**. A command that needs permission and isn't pre-approved also aborts (outside auto mode). [doc]
- Typing `/orbit:x` bypasses `PreToolUse(Skill)`. Use the **`UserPromptExpansion`** hook (input: `command_name`, `command_args`, `command_source: "plugin"`) to gate or annotate direct invocations. [doc]
- Plugin skills are **not** affected by the `skillOverrides` setting. [doc]

## 3. Agents: `agents/<name>.md`

Only `name` and `description` are required. Field names are camelCase. Unknown fields are silently ignored. [doc sub-agents#supported-frontmatter-fields]

| Field | Notes |
|---|---|
| `name` | Must not contain `:` or start with `-`. Plugin form: `orbit:<name>` (hooks see this as `agent_type`). |
| `description` | When Claude should delegate to this agent. |
| `tools` | Allowlist (comma string or list). If omitted, the agent inherits all tools. If no entry resolves, the agent fails to launch. |
| `disallowedTools` | Applied before `tools`. An entry with a specifier, such as `Bash(git push *)`, removes the **whole** tool. Use permission deny rules for specific commands. |
| `model` | `sonnet\|opus\|haiku\|fable\|<full id>\|inherit`. A family alias that matches the main session's family resolves to the main session's exact model. |
| `permissionMode` | **Ignored for plugin agents.** |
| `maxTurns` | When reached, output is returned marked partial (v2.1.246+). |
| `skills` | Preloads the full skill content. **Skills with `disable-model-invocation: true` can't be preloaded**; they are skipped with a debug-log warning. |
| `mcpServers` | **Ignored for plugin agents.** |
| `hooks` | **Ignored for plugin agents.** (Elsewhere, a `Stop` hook here is converted to `SubagentStop`.) |
| `memory` | `user\|project\|local` |
| `background` | `true` forces the background. |
| `omitClaudeMd` | v2.1.271+ |
| `effort` | |
| `isolation` | Only `worktree`. Branches from the **default branch**, not from the parent `HEAD`. Auto-cleaned if the agent made no changes. |
| `color` | `red\|blue\|green\|yellow\|purple\|orange\|pink\|cyan` |
| `initialPrompt` | **Ignored for plugin agents.** |
| `experimental.cacheTtl` | `5m\|1h` |

**Plugin agents.** The supported fields are `name`, `description`, `model`, `effort`, `maxTurns`, `tools`, `disallowedTools`, `skills`, `memory`, `background`, `omitClaudeMd`, `isolation`, `color` and `experimental.cacheTtl`. **Ignored:** `permissionMode`, `hooks`, `mcpServers`, `initialPrompt`. Ship hooks in `hooks/hooks.json` and MCP servers in `.mcp.json` instead. [doc plugins/components#frontmatter-fields-in-plugin-agents]
- Gotcha: `claude plugin validate --strict` **does not warn** about these ignored fields [cli]. An agent with `permissionMode: bypassPermissions`, `hooks`, `mcpServers`, `initialPrompt` and an unknown key passed. Orbit should lint this itself.
- Plugin agent YAML that fails to parse still loads, named after the file with all fields dropped. Validate reports it as an error. [doc] [cli]

**Runtime limits** [doc sub-agents]
- Subagents can't use `AskUserQuestion`, `EnterPlanMode` or `EndConversation`.
- **Background** subagents keep only these built-ins: Read, Grep, Glob, LSP, Bash, PowerShell, Edit, Write, NotebookEdit, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch, Enter/ExitWorktree, Monitor, TaskStop, SendMessage, Artifact (plus MCP tools).
- Fork mode is **off** in `-p`/SDK.
- Nesting depth defaults to 3 (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`).
- At most 20 subagents run concurrently (`CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`).
- A subagent's `permissionMode` is ignored when the main session runs in `bypassPermissions`, `acceptEdits` or `auto`.

## 4. Hooks: `hooks/hooks.json`

```json
{
  "description": "optional",
  "hooks": {
    "<Event>": [
      { "matcher": "<pattern>", "hooks": [ { "type": "command", "command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/pre.js"], "timeout": 10 } ] }
    ]
  }
}
```

Plugin hooks register when the plugin loads and fire on every matching event, whether or not an Orbit skill is in use. They also fire inside subagents, where the input carries `agent_id` and `agent_type`. All matching handlers run **in parallel**. [doc] An unknown event name gets the validate warning `unknown hook event; entry ignored at runtime`. [cli]

### Events (current list, 33) [doc hooks#hook-lifecycle]

Session and turn:
- `SessionStart` (matcher: `startup|resume|clear|compact|fork`)
- `Setup` (`init|maintenance`; fires only with `--init-only`, or with `-p --init` or `-p --maintenance`)
- `UserPromptSubmit`
- `UserPromptExpansion` (matcher: command name)
- `Stop`
- `StopFailure` (matcher: error type)
- `SessionEnd` (`clear|resume|logout|prompt_input_exit|other`)

Tool loop (matcher: tool name):
- `PreToolUse`, `PermissionRequest`, `PermissionDenied`, `PostToolUse`, `PostToolUseFailure`
- `PostToolBatch` (no matcher)

Agents and tasks:
- `SubagentStart`, `SubagentStop` (matcher: agent type; plugin agents need `^orbit:verifier$`)
- `TaskCreated`, `TaskCompleted`, `TeammateIdle`

Environment:
- `InstructionsLoaded`, `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged` (matcher: literal filenames)
- `WorktreeCreate`, `WorktreeRemove`
- `PreCompact`, `PostCompact` (`manual|auto`)
- `PreModelSwitch`, `PostModelSwitch`
- `Notification`, `MessageDisplay`
- `Elicitation`, `ElicitationResult`

### Matcher syntax [doc hooks#matcher-patterns]
- `"*"`, `""` or an omitted matcher matches everything.
- A matcher with only `[A-Za-z0-9_\- ,|]` is an **exact** match, with alternatives separated by `|` or `,`.
- Anything else is an **unanchored JS regex**: `Edit.*` also matches `NotebookEdit`. Anchor with `^...$`.
- For MCP tools, `mcp__<server>__.*`; a bare `mcp__server` matches nothing. Plugin MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`.
- A matcher on an event without matcher support is silently ignored.
- The handler-level `"if": "<one permission rule>"` (e.g. `"Bash(git push *)"`, `"Edit(src/**)"`) works only on tool events. On other events, a handler with `if` **never runs**. `if` is best effort for Bash, so it is not a security boundary.

### Handler types and fields [doc hooks#hook-handler-fields]
- **Common to all types:**
  - `type`: `command|http|mcp_tool|prompt|agent`
  - `if`, `timeout` (**seconds**), `statusMessage`
  - `once`: honored only in skill frontmatter
- **`command`:**
  - `command`; `args` (exec form: no shell, `${VAR}` substituted per element)
  - `async`, `asyncRewake`, `shell` (`bash|powershell`)
  - Shell form runs via `sh -c`. **Quote `"${CLAUDE_PLUGIN_ROOT}"`**: validate warns on an unquoted placeholder in shell form, so `--strict` fails. [cli]
- **`http`:** `url`, `headers`, `allowedEnvVars`. Non-2xx responses are non-blocking. A block needs a 2xx response with a JSON body.
- **`mcp_tool`:** `server` (plugin servers: `plugin:orbit:<server>`), `tool`, `input` with `${tool_input.x}`. Skipped on `SessionStart` at launch and on `Setup`.
- **`prompt` and `agent`:** `prompt` (with `$ARGUMENTS`), `model`. `prompt` also takes `continueOnBlock`. The response is `{"ok":bool,"reason":str,"impossible"?:bool}`. Agent hooks are **experimental**.
- **Default timeouts:**
  - `command`, `http`, `mcp_tool`: 600 s (30 s on UserPromptSubmit and the model-switch events, 10 s on MessageDisplay)
  - `prompt`: 30 s
  - `agent`: 60 s
  - SessionEnd shares a 1.5 s budget (`CLAUDE_CODE_SESSIONEND_HOOKS_TIMEOUT_MS`). **Timeouts set on plugin hooks don't raise that budget.**
- **A timed-out command hook on PreToolUse does NOT block.** The call falls back to the normal permission flow.

### Input (stdin JSON)

**Common fields:**
- `session_id`, `transcript_path`, `cwd`, `hook_event_name`
- Usually present: `prompt_id`, `permission_mode` (`default|plan|acceptEdits|auto|dontAsk|bypassPermissions`; Manual arrives as `default`), `effort: {level}`
- Optional: `scratchpad_dir`
- In subagents: `agent_id`, `agent_type`
- MCP tools also get `mcp_server: {name, source}`

[doc] [probe] These were seen in real payloads:

```json
{"session_id":"…","transcript_path":"…/<sid>.jsonl","cwd":"/abs/work","prompt_id":"…","permission_mode":"default","effort":{"level":"medium"},"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"echo orbit-probe","description":"probe bash"},"tool_use_id":"toolu_…"}
```

`Setup` and `SessionStart` payloads carried only `session_id`, `transcript_path`, `cwd`, `hook_event_name` plus `trigger: "init"` or `source: "startup"`, respectively. They had no `permission_mode`. [probe]

**PreToolUse `tool_input` by tool.** File paths are always absolute; on Windows they use backslashes.

| Tool | `tool_input` fields | Evidence |
|---|---|---|
| `Bash` | `command`, `description?`, `timeout?` (ms), `run_in_background?` | doc + probe |
| `Write` | `file_path`, `content` | doc + probe |
| `Edit` | `file_path`, `old_string`, `new_string`, `replace_all?` | doc + probe |
| `NotebookEdit` | `notebook_path`, `cell_id?`, `new_source`, `cell_type?` (`code\|markdown`), `edit_mode?` (`replace\|insert\|delete`) | SDK type doc + probe |
| `Read` | `file_path`, `offset?`, `limit?`, `pages?` | doc + probe |
| `PowerShell` | same as Bash | doc |
| `Agent` | `prompt`, `description`, `subagent_type`, `model?` | doc |

- **`MultiEdit` does not exist** in 2.1.288. It is absent from `tools-reference`, from the SDK `ToolInputSchemas` union, and from the tool list the CLI sent to the mock. The list for `-p`, default mode and the probe plugin was: Agent, Bash, CronCreate/Delete/List, Edit, EnterWorktree, ExitWorktree, ListAgents, NotebookEdit, Read, ReportFindings, ScheduleWakeup, SendMessage, Skill, TaskStop, WebFetch, WebSearch, Workflow, Write. **Glob and Grep are absent by default on macOS.** Do not match `MultiEdit`.
- **Ordering gotcha** [probe]: an unread-file `NotebookEdit` call failed with `File has not been read yet` **before** PreToolUse fired, so no hook ran. An unread-file `Edit` call *did* reach PreToolUse. Tool input validation can preempt hooks, so the policy engine must not assume it sees every attempted call.
- PostToolUse adds `tool_response` and `duration_ms`. For Bash, `tool_response` was `{"stdout","stderr","interrupted","isImage","noOutputExpected"}`. [probe]
- **Stop input:** `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]`. [probe]
- **SubagentStop input** adds `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`. [doc]

### Output contract [doc hooks#exit-code-output, #json-output, #decision-control]

- **Exit 0.** Stdout is parsed as JSON if it starts with `{` and ends with `}`. Plain-text stdout becomes context only on `UserPromptSubmit`, `UserPromptExpansion`, `SessionStart` and `PostModelSwitch`. Stderr goes to the debug log.
- **Exit 2: blocking.** It overrides even a JSON `allow`. The blocking reason is the JSON reason if one is present, otherwise stderr.
  - Blocks: PreToolUse (tool call), UserPromptSubmit, UserPromptExpansion, Stop/SubagentStop (forces continue), TaskCreated, TaskCompleted, TeammateIdle, ConfigChange, PostToolBatch, PreCompact, PreModelSwitch, Elicitation(Result), WorktreeCreate/Remove (any non-zero exit).
  - **Ignored on PermissionRequest.**
  - PostToolUse and PostToolUseFailure show stderr to Claude.
- **Any other exit code is non-blocking.** The action proceeds with a `hook error` notice. **Exit 1 does not block.** [probe] A PreToolUse `Read` hook that exited 1 let the read run.
- A **missing or non-executable script** gives exit 127, which is non-blocking. That leaves the gate **silently disabled**.
- **Universal JSON fields:** `continue` (false stops Claude entirely), `stopReason`, `systemMessage`, `terminalSequence`, `suppressOutput` (no-op). `additionalContext`, `systemMessage` and plain stdout are each capped at **10,000 chars**; anything longer is spilled to a file with a 2k-char preview.
- **PreToolUse:**
  - Fields:
    ```json
    {"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow|deny|ask|defer","permissionDecisionReason":"…","updatedInput":{…},"additionalContext":"…"}}
    ```
  - Precedence across hooks is `deny > defer > ask > allow`. Deny and ask *rules* are still evaluated after a hook `allow`.
  - The top-level `decision: approve|block` is deprecated.
  - `updatedInput` replaces the whole input.
  - `defer` works only in `-p` and only with a single tool call. The process then exits with `stop_reason: "tool_deferred"`.
  - [probe] With `deny`, Claude got `tool_result {is_error:true, content:"PreToolUse:Write hook error: probe deny write"}`.
  - [probe] With exit 2, Claude got `"PreToolUse:Edit hook error: [<cmd>]: <stderr>"`.
  - [probe] With **`ask` in `-p` and no permission host**, the call was **denied**, and Claude saw `permissionDecisionReason` as the error.
  - [probe] All of these appear in the `-p` result's `permission_denials[]` (`tool_name`, `tool_use_id`, `tool_input`).
- **Stop / SubagentStop:** `{"decision":"block","reason":"…"}` makes Claude continue with `reason` as feedback. Alternatively, `hookSpecificOutput.additionalContext` continues without an error label.
  - [probe] The block reached the model as `"Stop hook blocking error from command: \"<cmd>\": <reason>"`. The next Stop input had `stop_hook_active: true`.
  - **Cap: 8 consecutive blocks**, after which Claude Code forces the stop (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`; `0` disables the cap). Always check `stop_hook_active`.
- **PermissionRequest:** `hookSpecificOutput.decision = {behavior: allow|deny, updatedInput?, updatedPermissions?, message?, interrupt?}`. In sessions that can't prompt, the call is denied unless a hook decides.
- **PostToolUse:** `decision: "block"` plus `reason` (an annotation; the tool already ran), `additionalContext`, `updatedToolOutput` (must match the tool's output shape).
- **SessionStart:** `additionalContext`, `initialUserMessage` (`-p`), `sessionTitle`, `watchPaths`, `reloadSkills`. It also gets `CLAUDE_ENV_FILE` for persisting env vars.

### Environment in hook processes [probe]

Seen in the probe, for both a `Setup` and a `SessionStart` plugin hook:
- `CLAUDE_PLUGIN_ROOT=<plugin dir>`
- `CLAUDE_PLUGIN_DATA=<cfg>/plugins/data/orbit-inline`
- `CLAUDE_PROJECT_DIR=<launch dir>`
- `CLAUDE_ENV_FILE=<cfg>/session-env/<sid>/<event>-hook-1.sh`
- `CLAUDE_EFFORT`
- `CLAUDE_PLUGIN_OPTION_<KEY>`

Processes inherit the parent env, minus `OTEL_*` and minus whatever `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` removes. Hooks run with no controlling TTY. [doc]

### Hooks for headless runs
- **`--settings <file-or-json>` accepts `hooks`.** [doc settings: "can set any key your user settings file can set"] [probe] Setup and SessionStart hooks passed via `--settings` fired alongside the plugin's own hooks, and settings hooks gated PreToolUse in `-p` runs. Hook arrays **merge** across levels rather than replacing each other.
- `--settings '{"disableAllHooks":true}'` turns off **plugin hooks too**. [probe]
- `-p` treats the folder as trusted, so a repository's `.claude/settings.json` hooks run as well. [doc]
- **`--bare` skips all hooks**, including `--settings` hooks and hooks from a `--plugin-dir` plugin. The plugin's skills still load (`orbit:run` appeared). [probe] This held for `--init-only` and for `-p`.
  - **Docs vs CLI:** `headless.md` lists `--settings` and `--plugin-dir` as the way to load context in bare mode. `claude --help` says `--bare` "skip[s] hooks (those defined in settings and by installed plugins…)". The local behavior matches the CLI help.
- `claude --init-only` runs Setup and SessionStart hooks, then exits with no model call. It is a free smoke test for hook wiring. [doc] [probe]

## 5. Native `/goal` [doc goal; probe]

- `/goal <condition ≤4000 chars>` sets a single session-scoped goal and **immediately starts a turn**. `/goal` with no argument shows status. `/goal clear` (aliases `stop|off|reset|none|cancel`) clears it, and `/clear` removes it too.
- An active goal is restored on resume, with its counters reset.
- It works in `-p`: `claude -p "/goal …"` runs the loop to completion in one invocation.
- It is implemented as a **session-scoped prompt-based Stop hook**. After each turn, an evaluator model gets the conversation plus the condition and returns `{ok, reason, impossible?}`. The outcomes are not met (continue, with `reason` as guidance), met (cleared), or impossible (cleared as failed).
  - **The evaluator has no tools.** It cannot run commands or read files and judges only from transcript evidence.
- [probe] The evaluator request used `output_config.format` json_schema `{ok:boolean, reason:string, impossible?:boolean}`. Its system prompt said to answer from transcript evidence only. The user content was `Condition: …` plus `ARGUMENTS: <Stop hook input JSON>`.
- [probe] The verdict reached the model as `"Stop hook feedback:\n[<condition>]: <reason>"`.
- [probe] **User Stop hooks still fire on every goal turn.** A settings Stop hook saw `stop_hook_active:false`, then `true`. So Orbit's Stop hook and `/goal` coexist, and both count toward the same continuation loop protections. UNVERIFIED: whether goal continuations count against `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
- Evaluation is skipped while background subagents or shells are running. Check-ins come after 30 min (`CLAUDE_CODE_GOAL_CHECKIN_MINUTES`, `0` disables).
- The goal is cleared on errors you must fix: auth, exhausted credits, an unrecoverable context overflow, or a missing model.
- It is unavailable when `disableAllHooks` is true or `allowManagedHooksOnly` is set.
- The evaluator model is documented as the "small fast model" (`ANTHROPIC_DEFAULT_HAIKU_MODEL`).
  - **Disagreement:** in the mock run with a custom `ANTHROPIC_BASE_URL`, the evaluator request carried `model: claude-opus-5-5`, the session model. UNVERIFIED which model is used on first-party auth.

## 6. Testing plugin loading

| Command | Behavior | Evidence |
|---|---|---|
| `claude plugin validate <path> [--strict] [--json]` | Validates the manifest, `hooks/hooks.json`, and the YAML parse of agents and skills. Exit codes: 0 = pass (with or without warnings), 1 = fail (or any warning under `--strict`), 2 = validator crash. `--json` emits `{success, strict, target, manifest:{errors,warnings,notes}, contents:[{file,…}]}`. | cli |
| `claude --plugin-dir <dir> plugin details orbit` | Shows the component inventory and token cost. The plugin must be loaded first, so pass `--plugin-dir` **before** the subcommand. A missing plugin gives exit 1. | cli: `Skills (1) run / Agents (1) verifier / Hooks (5) PreToolUse, Stop, SubagentStop, SessionStart, Setup … Always-on: ~51 tok` |
| `claude --plugin-dir <dir> plugin list --json` | Prints `[{"id":"orbit@inline","version":"0.1.0","scope":"session","enabled":true,"installPath":…,"hasUserConfig":true}]` | cli |
| `claude --plugin-dir <dir> …` | Session-only load; repeatable. A folder of plugins loads each child that has a `.claude-plugin/plugin.json`. A session-only copy beats an installed plugin with the same name. | doc + cli help |
| `claude -p … --output-format stream-json --verbose` | The init event lists `plugins[]`, `skills[]`, `slash_commands[]` and `agents`. `plugin_errors[]` is present when a plugin fails to load. | probe + doc headless |
| `claude --debug-file <f> --init-only` | Logs lines such as `Loading hooks from plugin: orbit`, `Registered N hooks`, `Loaded 1 agents from plugin orbit`. | probe |
| `/reload-plugins [--force]` | Applies plugin changes mid-session; also works in `-p` when typed. | doc |
| `claude plugin tag [path]` | Creates the git tag `{name}--v{version}` after checking that `plugin.json` and the marketplace entry agree. | cli help |
| `claude plugin eval` | Runs eval cases (`evals/**/case.yaml`) against a plugin, compared with a no-plugin baseline. | cli help |

**What validate does NOT check** [cli]:
- unknown or ignored frontmatter keys in skills and agents (`permissionMode` in a plugin agent included)
- leniently parsed YAML (`description: [unclosed` passed)
- unknown keys inside hook handlers (`bogusField` passed)
- agent names containing `:` (they passed)
- a root `SKILL.md`
- `.lsp.json`

**Scratch plugin that passes `claude plugin validate --strict`** [cli, exit 0]:

`.claude-plugin/plugin.json`:
```json
{
  "name": "orbit", "displayName": "Orbit", "version": "0.1.0",
  "description": "An autonomous, evidence-driven engineering loop for Claude Code.",
  "author": { "name": "Quintin Botes", "url": "https://github.com/QuintinBotes" },
  "homepage": "https://github.com/QuintinBotes/orbit",
  "repository": "https://github.com/QuintinBotes/orbit",
  "license": "MIT",
  "keywords": ["claude-code", "autonomous", "verification", "self-healing", "engineering"],
  "userConfig": { "mode": { "type": "string", "title": "Execution mode", "description": "Default Orbit execution mode", "options": ["supervised", "autonomous"], "default": "supervised" } }
}
```

`skills/run/SKILL.md` frontmatter:
```yaml
name: run
description: Start an Orbit goal run. Use when the user asks Orbit to implement, fix, or deliver a goal end to end.
argument-hint: "<goal>"
arguments: [goal]
disable-model-invocation: true
allowed-tools: Bash(orbit *) Bash(${CLAUDE_PLUGIN_ROOT}/bin/orbit *) Read
model: inherit
effort: high
```

`agents/verifier.md` frontmatter:
```yaml
name: verifier
description: Runs Orbit verification checks and reports evidence. Use after implementation steps.
tools: Read, Grep, Glob, Bash
disallowedTools: Write, Edit
model: sonnet
effort: medium
maxTurns: 30
isolation: worktree
color: cyan
background: false
omitClaudeMd: false
```

Do not list `skills: [run]` on this agent. It validates, but `run` has `disable-model-invocation: true`, so the preload is skipped at runtime.

`hooks/hooks.json` (all exec form, so no quoting is needed):
```json
{ "description": "Orbit policy and lifecycle hooks", "hooks": {
  "PreToolUse":   [{ "matcher": "Bash|Edit|Write|NotebookEdit", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "args": ["pretooluse"], "timeout": 10 }] }],
  "Stop":         [{ "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "args": ["stop"], "timeout": 30 }] }],
  "SubagentStop": [{ "matcher": "^orbit:verifier$", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "args": ["subagentstop"] }] }],
  "SessionStart": [{ "matcher": "startup|resume", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "args": ["sessionstart"] }] }],
  "Setup":        [{ "matcher": "init", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/hook.sh", "args": ["setup"] }] }]
}}
```

---

## Docs vs CLI disagreements (local behavior wins)

1. `--bare` plus `--settings` or `--plugin-dir`: the docs imply these restore context in bare mode, but **hooks never run under `--bare`** (CLI help and probe). Skills from `--plugin-dir` do load.
2. `/goal` evaluator model: the docs say small fast model, but the mock run used the session model (`claude-opus-5-5`). This may be caused by the custom base URL, so it is UNVERIFIED for first-party auth.
3. `userConfig.default`: the docs say it is the "value used when the user provides nothing", but the probe found an empty `CLAUDE_PLUGIN_OPTION_<KEY>` in hook env when the option was unset.
4. The default permission mode in `-p` with nonessential traffic disabled was `auto` (hook `permission_mode:"auto"`). This **matches** permission-modes.md: `-p` uses `auto` on v2.1.285+ when feature flags aren't fetched, and `default` otherwise. Always pass `--permission-mode` explicitly.

## UNVERIFIED
- The PreToolUse `tool_input` for `PowerShell` and `Agent` (taken from docs only; not probed).
- Whether `/goal` continuations count toward `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`.
- The `/goal` evaluator model on first-party auth.
- That plugin-agent `permissionMode`, `hooks` and `mcpServers` are ignored at runtime (docs only; no subagent was spawned in the probes).
- Whether `${CLAUDE_PLUGIN_ROOT}` inside `allowed-tools` resolves for plugin skills at runtime (documented; only the body substitution was observed).
- Behavior of `"defer"` (documented; not probed).

## Implications for Orbit (recommendations)

1. **Manifest:** use the validated `plugin.json` above. Keep `name: "orbit"`, set `version` explicitly (it pins users), and make `homepage` a valid URL. Gate CI on `claude plugin validate . --strict --json`.
2. **Repo root = plugin root:**
   - **Do not commit a root `CLAUDE.md`**, since it fails `--strict`. Put contributor guidance in `CONTRIBUTING.md` or `docs/`.
   - The existing top-level `bin/` puts every file there on Claude's Bash PATH, and it blocks claude.ai and Cowork installs. Keep `bin/` containing only the `orbit` CLI shim, and accept that this rules out claude.ai and Cowork distribution. Alternatively, move the shim elsewhere and call `node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js"` from skills.
   - Never write run state under `CLAUDE_PLUGIN_ROOT`. Store state in `<repo>/.orbit/` (per the spec) and caches in `CLAUDE_PLUGIN_DATA`.
3. **Dependencies:** marketplace installs run `npm ci --ignore-scripts`-style installs, so **avoid native addons** such as `better-sqlite3`. `node:sqlite` works on local Node v22.18.0 (it prints an ExperimentalWarning). Commit `package-lock.json` (or `npm-shrinkwrap.json` for npm sources) with registry-only, exactly pinned dependencies. Better still, ship a bundled `dist/` so hooks have no runtime dependencies at all.
4. **Skills:**
   - Give the eight skills `disable-model-invocation: true`, an `argument-hint`, and **document only `/orbit:<name>`**. Bare `/run`, `/verify`, `/status` and `/resume` collide with bundled or built-in commands.
   - `$ARGUMENTS` keeps the user's quotes. Pass it through to the CLI verbatim and let `orbit` parse it.
   - Keep the frontmatter to fields Claude Code accepts. If claude.ai portability matters later, restrict it to the six Agent-Skills fields.
5. **Agents:**
   - Use `tools` and `disallowedTools`, `model`, `maxTurns`, `effort` and `isolation: worktree` for the writer roles.
   - **Do not rely on `permissionMode`, `hooks` or `mcpServers` in plugin agents.** Enforce policy through `hooks/hooks.json`, using `agent_type` (`orbit:implementer` and so on) from the hook input to apply per-role rules.
   - Don't preload skills marked `disable-model-invocation`.
   - Add an Orbit lint for ignored and unknown frontmatter keys, because validate won't catch them.
6. **Hooks (policy engine):**
   - Use **exec form** (`command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/dist/hooks/<x>.js"]`).
   - Deny with JSON `permissionDecision: "deny"` plus a reason, and use **exit 2 as the fail-closed path**. Never use exit 1.
   - Make the hook **fail closed** internally: catch every error and exit 2. A crash, a missing file (exit 127) or a timeout all *fail open*.
   - Keep PreToolUse hooks fast (set `timeout` ≤ 10 s); a timeout fails open.
   - Match `Bash|PowerShell|Edit|Write|NotebookEdit` plus `mcp__.*` as needed. **Do not reference `MultiEdit`.**
   - Normalize paths before comparing them (absolute; backslashes on Windows).
   - Do not treat PreToolUse as the only control: tool input validation can preempt it, and `if` filters are best effort. Also add permission deny rules, through `--settings` on controller-launched sessions, together with worktree or container isolation.
7. **Stop hook vs controller:**
   - The Stop hook should only point back to the controller (e.g. "run `orbit verify <run-id>`") via `decision: "block"`.
   - Respect `stop_hook_active` and expect the 8-block cap (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`).
   - **Completion authority stays in the controller and evidence runner**, not in hook loops and not in `/goal`.
8. **Headless worker launches (Claude adapter):**
   - Launch with `claude -p --setting-sources "" --strict-mcp-config --plugin-dir <orbit> --settings <run-policy.json> --permission-mode <explicit> --output-format stream-json --verbose`.
   - **Added (gaps V4):** without `--setting-sources ""`, the user's enabled plugins load into every worker. On this machine that is `codex@openai-codex`, with a Stop hook that has a 900 s timeout. The repo's own `.claude/settings.json` hooks and `.mcp.json` servers load too. With `""`, `--settings` and `--plugin-dir` hooks were verified to still fire.
   - Put Orbit's policy hooks and permission rules in the per-run `--settings` file, in addition to the plugin hooks, so that enforcement doesn't depend on plugin enablement.
   - **Do not use `--bare` for workers that need hooks.**
   - Use `--permission-prompts none` for unattended runs.
   - Read `permission_denials[]` and `plugin_errors[]` from the result and init events.
   - Pass userConfig values through `pluginConfigs` in `--settings`. Apply option defaults in the runtime.
9. **`/goal`:** treat it as an optional interactive aid (spec §4). Its evaluator only sees the transcript, so if Orbit surfaces a goal, phrase it as "`orbit report <run-id>` prints `STATUS: delivered`". The controller must work with `/goal` absent, or disabled by `disableAllHooks` or `allowManagedHooksOnly`.
10. **Tests:**
    - Use `claude --plugin-dir . --init-only` (free) to smoke-test Setup and SessionStart wiring.
    - Run `claude --plugin-dir . plugin details orbit` in `orbit doctor`.
    - For hermetic integration and fault-injection tests of hook contracts, adopt the **mock Messages API** pattern used here: a local HTTP SSE server, `ANTHROPIC_BASE_URL=http://127.0.0.1:<port>`, a fake key, `CLAUDE_CONFIG_DIR=$(mktemp -d)` and `env -i`. It exercises real tool calls and hooks with zero model spend. The probe sources are in the session scratchpad, which is ephemeral, so copy them in if you need them: `<scratchpad>/mock/{server.js,hook.js}`, with the scratch plugin at `…/scratchpad/orbit-probe/`.
