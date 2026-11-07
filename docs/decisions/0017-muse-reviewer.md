# 0017. Muse as an independent reviewer

Status: accepted (2026-10-20). Issue #108.

## Context

Codex was the only independent reviewer Orbit supported. When Codex was not
eligible or not usable, a run blocked or fell back to a review that was not
independent (ADR 0007). Muse (Wonder Full) was already used as a reviewer
outside Orbit, against a write-protected snapshot, but the result was not part
of a run's evidence or of the independence gate. Muse 1.4.11 was probed live
before building on it and 1.4.14 measured again later; the verified facts are
in docs/interfaces/muse.md.

## Decision

Muse is a reviewer only. The implementer stays Claude, and the Muse adapter
refuses any task that is not read-only (`POLICY_DENIED`). It is configured like
Codex, opt in per repository:

```yaml
providers:
  muse:
    command: muse
    data_policy_eligible: false   # a person's edit, as for Codex
    model: muse-wonder-full-1.0
    reasoning_effort: high
    tier: auto                    # auto | os-sandbox | muse-sandbox
review:
  providers: [codex, muse]        # tried in this order
```

- A provider id `muse`, `muse-*` or `muse_*` is a Muse provider. Any other
  key, the Codex-only `review_reasoning_effort`, the cross-family tiers
  (`codex-sandbox` on Muse, `muse-sandbox` on Codex) and `tier` on a Claude
  provider are configuration errors that name the key. The model is passed
  through unchanged; Orbit never substitutes another. `reasoning_effort: none`
  is refused, since the meta provider rejects it.
- The review checkout's read-only state rests on an external boundary,
  never on Muse's own settings alone. Two tiers, chosen by `providers.muse.tier`:
  - `os-sandbox`: `srt` wraps the whole muse process. Writes to the worker
    directory only, egress to `api.meta.ai` only, the user's Muse login
    directory denied, so the tier runs on `META_API_KEY` with a private
    config directory. Chosen explicitly without `srt` or without
    `META_API_KEY`, Muse reports as unavailable with a reason that names the
    setting, so selection moves on to the next listed reviewer or
    `review.when_unavailable`. If it still reaches launch, it fails closed
    (`ISOLATION_UNAVAILABLE`). Claim 7 asked for no write grants; `srt` grants
    the worker directory, where the files the controller trusts (`log.jsonl`,
    `exit.json`, `result.json`, `launch.json` and the others of
    `WORKER_DIR_READ_ONLY`) stay denied.
  - `muse-sandbox`: no `srt`. Muse's own `:read-only` profile applies, with
    the shell disabled, against a review checkout Orbit has already
    write-protected on disk; the adapter refuses to launch unless every
    directory and file in it is write-protected. Without a shell nothing
    running as the checkout's owner can chmod it back. Outside the checkout
    (the home directory, the repository's `.git`) writes rest on Muse's own
    profile and `--disable-write`. Reads are not confined: measured on Muse
    1.4.14, `read_file` under these flags read a file outside `--workspace`,
    so nothing stops it reading other files, including credentials the login
    user can read, and a prompt in the candidate could steer them into a
    review or to the Meta API. The worker record, `orbit doctor` and the final
    report say so. Use `os-sandbox` (`META_API_KEY` plus `srt`) where that
    matters.
  - `auto` (default) picks `os-sandbox` only with `META_API_KEY` in the
    worker environment and an `srt` that starts, else `muse-sandbox`.
- The invocation is fixed: `muse exec` with `--model`, `--reasoning-effort`,
  `--workspace`, `--permission-profile :read-only`,
  `--disable-request-user-input`, `--disable-write`, `--disable-shell`,
  `--no-foreign-personal-context`, `--disable-web-tools`, `--no-session-log`,
  `--json`, `--output-schema`, `--max-model-steps 200` and the packet in
  `--prompt-file`. Any `extra_args` entry is refused, as are `--yolo`,
  `--disable-sandbox`, `--disable-approval`, `--trust-workspace` and an
  `:unrestricted` profile in any argv. The step cap of 200 bounds a review
  session the way a turn cap bounds a Claude one.
- `--approval-mode never` is not passed. Claim 5 of issue #108 asked for it,
  and the issue's second comment amended the claim to drop it, because Muse
  1.4.11 refuses `--approval-mode` together with `--permission-profile`
  (exit 2). A run still cannot wait on a person: the question tool is withheld
  (`--disable-request-user-input`), the step cap bounds the session, and the
  reviewer's wall-clock cap kills the whole process group. The cap is what
  ends a session that runs away producing output with no terminal event, which
  one sample on Muse 1.4.14 did.
- The verdict comes only from the final answer shaped by `--output-schema`,
  parsed and validated against Orbit's own copy of the review schema. There
  is no fenced-JSON fallback: invalid output is a malformed review, never "no
  findings" (issue #108, open question 1). A stale revision is rejected
  exactly as for Codex.
- The worker environment is an allowlist: `META_API_KEY` and
  `XDG_CONFIG_HOME` pass, `MUSE_NO_AUTO_UPDATE=1` is set, and every other
  `MUSE_*` variable is refused as an extra, `MUSE_PERMISSION_PROFILE_FAIL_OPEN`
  above all. The login directory (`~/.config/muse`,
  `$XDG_CONFIG_HOME/muse`) is read-denied to every worker and check, as a
  credential like any other.
- Selection is generic (ADR 0007): Muse qualifies through its configured
  model and a tier that can run. Independence compares provider families, as
  the issue's first comment asked: a review is independent only when both ids
  resolve to a family and the families differ, so an alias of the implementer's
  family or an unknown id never counts. The final report names the reviewer,
  model, tier, why that tier and its limitations. `orbit doctor`
  reports the tier and why, the credential source, the model and the
  eligibility (`<id>.worker-tier`). Muse has no login status command, so
  the credential check is a one-step real `muse exec` in an empty private
  directory. Review depth (ADR 0016) reads Muse transcripts: tool results
  and the reasoning tokens of `run.usage`.

## Consequences

A repository with Codex unusable can still get an independent review, from a
second provider family, without weakening the read-only rule. Two things are
unverified live and recorded as such in docs/interfaces/muse.md: the
`os-sandbox` tier end to end (the probe machine had no `META_API_KEY` or
`srt`), and whether Muse's own shell sandbox starts inside `srt`. The probe
also could not show Muse itself denying a write under `:read-only`, since
the model declined first; nothing in the design depends on it. The cost of the
`muse-sandbox` tier is that reads are not confined, which the measurement
above shows. A failed Muse session (a timeout, a non-zero exit, the step cap) is recorded
with its reason and handled as any reviewer failure is: bounded regeneration
with the same reviewer, then a block. Issue #108 asked for the next listed
reviewer to be tried instead; that is deferred to its own change, since doing
it here would also change how a failed Codex review is handled. Muse as an
implementer stays out of scope: it needs routing and a write-capable adapter,
which is a separate spec.
