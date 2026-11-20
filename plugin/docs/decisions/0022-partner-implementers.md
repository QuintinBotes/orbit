# 0022. Partner implementers, and one fresh pass plus one cross-model pass

Status: accepted (2026-11-20). Issue #176. Replaces ADR 0017, whose reviewer
rules stay in force as amended here.

## Context

Every role but the reviewer was Claude's: routing offered only claude-cli
models for implementation, and the Codex and Muse adapters refused any task
that was not read-only (ADR 0017 deferred Muse as an implementer). A
controlled study found that one same-model plus one cross-model review caught
56.7% of planted errors, against 42.7% for two same-model passes, and that a
weak cross-model reviewer added nothing. On price partners no longer win;
their value is a separate allowance and different blind spots.

## Decision

### Who may implement

`routing.implementers` names the providers that may implement, in preference
order. The default is `[claude]`. **Partner implementers ship off**, and the
release note says they stay off until a full benchmark (issue #172) shows they
help. Listing `codex` or `muse` (configured under `providers`) turns them on;
anything else is a configuration error naming the key. Claude is always the
fallback.

Routing (`routing/router.ts:routePartner`) sends routine candidate work
(routine-code and focused-tests: one implementation attempt, or one parallel
work unit with disjoint paths) to the first listed partner that may take it,
on `providers.<id>.model` at `providers.<id>.reasoning_effort`. It passes a
partner over, and the route says why:

- after `PARTNER_MAX_FAILURES` (2) of its candidates in the run failed
  verification or review (route outcomes `failed` or `rejected` of this run):
  the third attempt goes to Claude;
- for the rest of the run once it was skipped (below);
- when `providers.<id>.data_policy_eligible` is not true, or no model is named;
- when its measured pass rate for the task class (`route_outcomes`, recorded per
  provider) is below `routing.learning.min_pass_rate` after `min_samples`
  judged outcomes. Calibration can drop a partner; the policy order prefers one.

A partner whose quota or login fails during a session is skipped for the rest
of the run: the adapters class a used-up allowance (Codex "usage limit",
`insufficient_quota`; Muse "usage limit", "quota exceeded") and a failed login
as `auth_failed`, the controller records `routing.partner-skipped` with failure
class `credentials`, and the attempt the partner held goes on with the next
route (`implement:<n>~<partner>`) without spending another attempt. The route
outcome of that attempt is the route it really ran on. A plain 429 rate limit
stays a transient error. Preflight skips the same way a partner whose CLI, whose
writable tier or whose credentials are unusable, so an unusable partner never
blocks a run.

### The writable worktree tier

Both adapters accept a task that is not read-only only for the implementer
role, in its own worktree. Partner output is untrusted: it is shaped by
`--output-schema` and parsed against Orbit's own copy of the implementer
schema, as a review is; anything else is malformed output.

- **Codex.** The codex-sandbox tier runs `--sandbox workspace-write` (Codex's
  own sandbox: the commands it runs write only the worktree, the network off);
  the os-sandbox tier runs inside `srt` with `danger-full-access` and a profile
  that adds the worktree to the reviewer's write set. The data-sharing switches
  the CLI has stay as for a review: `--ephemeral`, `--ignore-user-config`,
  web search disabled, OpenTelemetry export off unless configured. Whether an
  account's prompts may train models is not a CLI setting (API keys: no by
  default; ChatGPT plans: the account's data controls).
- **Muse.** Only the os-sandbox tier (`META_API_KEY` plus `srt`): nothing else
  confines Muse's writes to the worktree, which ADR 0017 required of reads too.
  The invocation drops `:read-only` and `--disable-write`, keeps the shell, web
  tools, question tool and session log disabled, and adds `--worktree off` (the
  edits stay in Orbit's worktree), `--contributor-mode off` (nothing sent trains
  Meta's models) and `--disable-approval`, which `buildMuseArgv` refuses
  outside the sandbox-runtime wrapper and the adapter refuses unless the
  launched argv ends with the bare one. A Muse without those flags, or without
  srt and the key, reports its writable tier unusable.

The scope, protected-path, secret and verification gates run on the
candidate whoever wrote it. The in-session guard hook is Claude Code's; a
partner session is bounded by its sandbox tier instead, and its candidate meets
the same gates afterwards.

### Review: one fresh pass plus one cross-model pass

Independence is computed per run from who implemented: a reviewer counts as
independent only when its family differs from every provider whose
implementer session ran in the run (one that failed its login at once wrote
nothing), and Claude is an independent reviewer of a partner's work even
though `review.providers` lists only Codex and Muse.

A change is risky when the planning assessment classes it `complex`. A risky
change gets two passes: the cross-model pass, from another provider's top tier
(a Claude model at the opus-class floor, or a Codex or Muse model that is the
provider's recommended model in its live catalog, carries a safety-review
evaluation, or is named in configuration with no catalog to compare it with),
and a fresh session from the implementer's own family (Claude at the
opus-class floor, preferring a tier other than the implementer's; a partner's
own qualified review model), run after the cross-model units and recorded beside
them under the purpose `review-family:<candidate>`. If the same-family pass
gives no review, that is recorded (`review.family-pass-failed`) and the tree is
decided on the cross-model review.

A cross-model reviewer below its provider's top tier adds nothing to a risky
change, so it is not used: the cross-model pass is skipped, the selection
records `crossModelSkipped`, the final report says "Cross-model review skipped"
and why, and `review.when_unavailable` decides whether the same-family review
stands alone (`claude`), needs a person's yes (`ask`) or blocks (`block`). A
change that is not risky keeps one review, as before.

## Consequences

The deterministic parts are on by default: independence from who implemented,
the review pair for risky changes, quota as a credential failure, and outcomes
per provider. Partner implementation is off until a person lists a partner.

Nothing here was run against the real CLIs (issue #176 forbids model calls in
its tests): the lab drives the fake Codex and Muse behind the real adapters and
shim. Unverified live: Codex's `workspace-write` on an implementer's worktree,
the Muse flags `--worktree`, `--contributor-mode` and `--disable-approval`
(taken from claude-stack's `stack-partner`, which checks them against
`muse exec --help` before every run, not probed by Orbit), Muse's wording for a
used-up allowance, and both os-sandbox tiers end to end. In the lab Muse runs
behind a stand-in for srt that does not confine.

A same-provider review of a partner's work is not defined at a quality floor,
as before: a Codex implementer with no usable cross-model reviewer blocks
rather than reviewing itself. Two review passes cost a review round each. The
live benchmark per implementer (pass rate and cost per accepted task, a partner
recommended only where it is not worse on both) waits on issue #172.
