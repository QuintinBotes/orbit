# Muse as an independent review provider: verified interface reference

Verified 2026-10-20 against **Muse Code 1.4.11** (`muse --version` prints
`Muse Code 1.4.11 (1.4.11-R6667.1)`), by running the binary. Orbit uses Muse
as a reviewer only (ADR 0017). Where a fact was not probed, this file says so.

## 0. The invocation Orbit uses

```bash
muse exec \
  --model <model> \
  --reasoning-effort <effort> \
  --workspace <review checkout> \
  --permission-profile :read-only \
  --disable-request-user-input \
  --disable-write \
  --no-foreign-personal-context \
  --disable-web-tools \
  --no-session-log \
  --json \
  --output-schema <worker dir>/schema.json \
  --max-model-steps 200 \
  --prompt-file <worker dir>/prompt.md
```

The prompt goes in a file (`--prompt-file`), never on stdin. Read-only never
rests on these flags alone: the review runs either inside `srt` (tier
`os-sandbox`, writes to the worker directory only, egress to `api.meta.ai`
only) or against a checkout Orbit has write-protected on disk (tier
`muse-sandbox`), and the adapter refuses to launch the second tier against a
writable checkout.

## 1. Flags, as probed

| Flag | What was observed |
|---|---|
| `--permission-profile :read-only` | Works. The colon is required: `read-only` without it exits 1 with "Permission profile 'read-only' is unavailable: profile does not exist." |
| `--approval-mode` with `--permission-profile` | Refused together: exit 2, "--permission-profile cannot be used with --approval-mode." Orbit does not pass `--approval-mode never`; a profile-only run completed in 22 s without waiting on anyone. |
| `--model muse-wonder-full-1.0` | Resolves: the `run.model.configured` event carries `model_id: muse-wonder-full-1.0`. There is no model catalog command, so Orbit passes the configured model through unchanged. |
| `--reasoning-effort` | With the meta provider: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. `none` exits 2: "choose minimal\|low\|medium\|high\|xhigh\|max\|ultra". |
| `--output-schema <FILE>` | The final answer in `run.terminal.completed` was schema-shaped JSON. Orbit still parses and validates it with its own copy of the schema; anything else is a malformed review. |
| `--max-model-steps <N>` | The step cap. At the cap the run ends failed (below). Orbit uses 200 for a review. |
| `--no-session-log` | Keeps session logs off disk. |
| `--disable-write`, `--disable-request-user-input`, `--no-foreign-personal-context`, `--disable-web-tools` | Accepted. Asked to write a file under `:read-only` with `--disable-write`, the model declined without attempting a write, so the probe could not show Muse itself denying one. The design relies on the external boundary, not on this. |

Never passed, and refused if they appear in any argv Orbit launches:
`--yolo`, `--disable-sandbox`, `--disable-approval`, `--trust-workspace`, and
an `:unrestricted` profile. The environment variable
`MUSE_PERMISSION_PROFILE_FAIL_OPEN` is likewise never passed to a worker:
every `MUSE_*` variable is refused as a worker extra, and the one Orbit sets
itself is `MUSE_NO_AUTO_UPDATE=1`, so the launcher cannot update itself
mid-run.

## 2. Exit codes

| Code | Meaning, as observed |
|---|---|
| 0 | Success. |
| 1 | Run failure. At the step cap: stderr "run ended with Failed: model did not reach a terminal state within 1 step(s)" and a `run.terminal.failed` event with a `reason`. Missing login: "missing meta credentials: run `muse login` or set META_API_KEY, or save credentials at <XDG_CONFIG_HOME>/muse/auth.json". |
| 2 | Usage error (bad flag, bad value, conflicting flags). |

## 3. `--json` output

Each line is a JSONL envelope:
`{schema_version, id, stream, sequence, recorded_at, record_type, durability, causation_id, payload_type, payload_schema_version, payload}`.
The `payload_type` names the event. Types seen:

- `runtime.command.accepted`, `session.run.linked`, `run.lifecycle.started`
- `run.model.configured` (`model_id`)
- `turn.input.user`, `task.lifecycle.*`
- `tool.result` (`payload.correlation_facts.tool_name`, `payload.text`)
- `run.output.delta`
- `run.usage` (`payload.models[]`, each with `input_tokens`, `cached_tokens`,
  `output_tokens`, `reasoning_tokens`, `calls`); no cost is reported
- `run.terminal.completed` (`payload.text` is the final answer,
  `payload.reason` null)
- `run.terminal.failed` (`payload.text` empty, `payload.reason` set)

Only the two `run.terminal.*` events are terminal. A process that exits with
neither was interrupted or crashed, and Orbit classifies it that way
(`src/adapters/muse-events.ts`). Unknown event types are ignored.

## 4. Credentials

The login is a file at `$XDG_CONFIG_HOME/muse/auth.json` (default
`~/.config/muse`), not a keychain entry. `META_API_KEY` wins over that login.
There is no login status command, so Orbit's credential check is the smallest
real request: one model step, no tools, in an empty private directory. A
missing login fails before any request, with the message in section 2.

Inside `srt` the user's login directory is denied, so the `os-sandbox` tier
runs only on `META_API_KEY`, with a private config directory in the worker
directory as Muse's `XDG_CONFIG_HOME`. Every worker and check profile denies
`~/.config/muse` and `$XDG_CONFIG_HOME/muse` for reading.

## 5. Network

Through a logging HTTPS proxy, a full run connected only to `api.meta.ai:443`.
Muse honours `HTTPS_PROXY`. The `os-sandbox` profile accordingly allows only
the host `api.meta.ai`.

## 6. Not verified live

- The `os-sandbox` tier end to end: the probe machine had no `META_API_KEY`
  and no `srt`.
- Whether Muse's own shell sandbox starts inside `srt`. Under `srt` the
  profile is the boundary either way; Muse's file tools still read the
  checkout.
- Whether Muse itself denies a write under `:read-only` plus
  `--disable-write` (the model declined before attempting one; section 1).
