# Test fakes

Stand-ins for the provider CLIs and the Anthropic API, so integration,
fault-injection and acceptance tests run Orbit's real adapters, shim, files
and classification without any model spend.

| File | Stands in for | Used by |
|---|---|---|
| `fake-claude.mjs` | the `claude` CLI | `FakeAdapter` (`src/adapters/fake.ts`), or `providers.claude.command` pointing at it |
| `fake-codex.mjs` | the `codex` CLI | `FakeAdapter`, or `providers.codex.command` pointing at it |
| `fake-anthropic-api.mjs` | the Anthropic Messages API | tests that run the REAL `claude` binary (`ANTHROPIC_BASE_URL`) |
| `scenario.mjs` | shared scenario loading for the two CLI fakes | |
| `reference/` | the verified probes the fakes were derived from; do not edit | |

## CLI fakes

Both fakes accept the argv the real adapters build. They answer `--version`,
`claude auth status`, `codex login status`, `codex doctor --json`,
`codex exec --help` and `codex debug models` with the verified shapes, and a
task run (`claude -p ...`, `codex exec ... -`) with a realistic transcript:
stream-json for Claude (`system/init`, assistant tool uses, a `result` line
with `modelUsage` and `structured_output`) and `--json` events for Codex
(`thread.started` ... `turn.completed` with usage, the final message also
written to `-o`). The prompt is read from stdin, as the adapters send it.

A fake finds its role from the title of the output schema it is given
(`--json-schema` for Claude, the `--output-schema` file for Codex):
planner, implementer, verifier (diagnosis), reviewer, inquisitor, curator.

### Environment

| Variable | Meaning |
|---|---|
| `ORBIT_FAKE_SCENARIO` | path to the scenario JSON file (below) |
| `ORBIT_FAKE_ARGV_LOG` | optional: each call appends `{tool, role, call, argv, envKeys, cwd, promptBytes}`; env values are never logged |
| `ORBIT_FAKE_CLAUDE_VERSION`, `ORBIT_FAKE_CODEX_VERSION` | override the reported version |

The adapters drop every variable not on their allowlist, so these reach a
fake only through `FakeAdapter` (which passes them through) or `TaskSpec.env`.

### Scenario format

```json
{
  "auth": { "loggedIn": true, "authMethod": "api_key", "method": "chatgpt", "valid": true },
  "roles": {
    "implementer": [ { "...step for call 0..." }, { "...step for call 1..." } ],
    "reviewer": [ { "structured": { "verdict": "APPROVE", "candidate_revision": "abc1234", "findings": [] } } ],
    "*": [ { "...used for roles without their own list..." } ]
  }
}
```

Calls are counted per role (from 0) in a counter file next to the scenario
(`<scenario>.<role>.count`, one byte per call, appended atomically so
concurrent fakes do not race). Once a role's list is exhausted its last step
repeats. `auth` drives `claude auth status` (`loggedIn`, `authMethod`) and
`codex login status` / `codex doctor` (`loggedIn`, `method`: `chatgpt` or
`api_key`, `valid`; doctor also counts `CODEX_API_KEY` as present).
`plugins` (Claude, optional) lists installed plugins as
`[{ "id": "name@marketplace", "scope": "managed", "enabled": true }]`:
`claude plugin list --json` answers with them, and `system/init` lists a
built-in plus each enabled one a worker would load (with
`--setting-sources ""`, not those of scope user, project or local), as
`{name, path, source}` with no scope, like the real CLI.

A step:

| Key | Effect |
|---|---|
| `edits` | `[{ "op": "write", "path", "content" }, { "op": "replace", "path", "find", "replace" }, { "op": "delete", "path" }]` applied in the cwd (relative paths) before the result |
| `forbiddenWrite` | `{ "path", "content"? }`: tries a write the worker must not be able to make and reports the outcome in the transcript (`denied: EPERM` under the os-sandbox tier) instead of failing |
| `crash` | `{ "path", "content" }`: writes the first half of the content, then exits 137 (a crash mid-edit) |
| `sleepMs` | waits before finishing (cancellation and timeout tests) |
| `ignoreSignals` | ignores SIGINT and SIGTERM, so only SIGKILL ends it |
| `grandchildPidFile` | (Claude) starts `/bin/sleep 600` in the same process group and writes its pid here |
| `structured` | the structured output of a successful run |
| `usage` | Claude: `modelUsage` fields (`inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, `costUSD`); Codex: `turn.completed.usage` fields |
| `model` | (Claude) the model reported in `system/init` and `modelUsage`; default resolves `--model` aliases |
| `outcome` | how the run ends (below); default `success` |
| `exitCode` | override the exit code of `success` or `no_result` |
| `hangAfterRetry` | (Claude `auth_failure`) waits this long after the first `api_retry`, to prove the shim aborts on it |

Any string in a step (`structured`, edit `content`, ...) may use two
placeholders, resolved by the fake from the prompt the worker was given, so
a static scenario can echo what only exists during a run:

| Placeholder | Resolved from | Used for |
|---|---|---|
| `$CANDIDATE` | the first `- revision: <40 hex>` line of the prompt | a review's `candidate_revision` |
| `$FINGERPRINT` | `Failure fingerprint: <id>` in the prompt | the fingerprint a repair brief or diagnosis must name |

A placeholder whose value is not in the prompt is left as written.

Outcomes:

| `outcome` | Claude | Codex |
|---|---|---|
| `success` | `StructuredOutput` tool use, `result` subtype `success`, exit 0 | final `agent_message` with the JSON, `turn.completed`, exit 0 |
| `auth_failure` | `api_retry` with `authentication_failed`, then a 401 result (`is_error: true`, subtype `success`), exit 1 | retry notice and `turn.failed` with the verified 401 text, exit 1 |
| `not_logged_in` | `Not logged in` result with a null status, exit 1 | |
| `max_turns` | `error_max_turns`, exit 1 | |
| `max_budget` | `error_max_budget_usd`, exit 1 | |
| `structured_retries` | `error_max_structured_output_retries`, exit 1 | |
| `transient` | `api_retry` `overloaded`, 529 result, exit 1 | `turn.failed` with status 503, exit 1 |
| `malformed` | a torn `result` line, exit 1 | `not json at all` as the final message, exit 0 |
| `model_rejected` | | `turn.failed` with status 400, exit 1 |
| `no_result` | exit without a result line (default 0, like SIGINT) | exit without a terminal event (default 1) |

Signals follow the verified behaviour: fake-claude exits 0 on SIGINT after
writing `[Request interrupted by user]` and 143 on SIGTERM, with no result
line; fake-codex exits 1 on SIGINT with no terminal event.

## Fake Anthropic API

`startFakeAnthropicApi({ steps })` serves the Messages API on 127.0.0.1 with
SSE streaming. Requests that carry tools are the main loop and consume
`steps` in order (the last repeats); side requests get a short reply.

| Step | Reply |
|---|---|
| `{ "text": "..." }` | assistant text |
| `{ "tool": "Write", "input": { ... } }` | one `tool_use` |
| `{ "structured": { ... } }` | a `tool_use` of the `StructuredOutput` tool the CLI adds for `--json-schema` |
| `{ "status": 401, "error": { "type", "message" } }` | an HTTP error (401, 403, 429, 529, ...) |
| `delayMs`, `usage` | delay before replying; token counts (`input`, `output`, `cacheRead`, `cacheWrite`) |

`api.requests` logs every request (model, tool names, tool results, whether
an API key was sent; never the key). Point the real CLI at it the way
`reference/claude-against-mock.reference.sh` does: a minimal environment,
`ANTHROPIC_BASE_URL=<api.url>`, `ANTHROPIC_API_KEY=sk-ant-fake-000`, a
throwaway `CLAUDE_CONFIG_DIR`. The CLI must be started asynchronously
(`spawn`, not `spawnSync`) when the API runs in the same Node process.
