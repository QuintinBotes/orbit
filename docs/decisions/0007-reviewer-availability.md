# 0007. Reviewer availability: a preference order and an explicit fallback

Status: accepted (2026-10-06). Issues #6 and #8.

## Context

Independent review (a model from another provider, Codex today) was governed by
two booleans, `review.independent_provider_required` and
`review.fallback_same_provider_allowed`. That allowed only "block the run when
the independent reviewer is unusable" or "always allow a same-provider review",
and a fresh setup failed `orbit doctor` until Codex was configured. The owner
asked for automatic fallback to Claude, clearly reported, as the default (#8),
and for a variant that asks the person first (#6).

## Decision

```yaml
review:
  providers: [codex]          # independent providers, in preference order
  when_unavailable: claude    # claude | ask | block
```

- `providers` lists independent providers Orbit supports, in preference order;
  the first that is installed, authenticated, data-policy eligible and has a
  qualified model reviews. Unknown or unsupported ids are a configuration error
  that names the supported ones (an adapter is needed before a provider such as
  Gemini can be listed).
- `when_unavailable` decides what happens when none is usable at run time:
  - `claude` (default): Claude reviews in a separate reviewer session at the
    safety-review quality floor (mandatory safety review is never routed down);
  - `ask`: the run raises a material question ("no independent reviewer is
    usable: allow a same-provider review for this run?") and continues only on
    a person's yes;
  - `block`: the run blocks, as `independent_provider_required: true` did.
- Every report, evidence record and `orbit doctor` states which reviewer was
  used and, for a same-provider review, that the independent reviewer was
  unavailable and why. A same-provider review is never presented as
  independent.
- The two legacy keys stay valid and map onto the new key
  (`required: true` with no fallback is `block`; otherwise `claude`); setting a
  legacy key that contradicts `when_unavailable` is a configuration error.
- `orbit init` writes the default and says how to choose `ask` or `block`; the
  `/orbit:init` skill asks the person.

## Consequences

A fresh setup reviews out of the box. Independence becomes a stated property of
each run's evidence rather than a precondition; anyone who needs it guaranteed
sets `block`.

## Amendment: a reviewer that fails at run time (#116)

`providers` was consulted only at selection, so a selected reviewer that then
failed (a timeout, a non-zero exit, a malformed answer after the bounded
regenerations) blocked the run even when a later listed reviewer would have
worked. Now, once a reviewer's regenerations are used, the failure is recorded
with its reason (`review.reviewer-failed`), its other sessions of the candidate
are stopped, and the selection runs again with that provider excluded. The next
listed independent reviewer reviews; with none left, `when_unavailable` applies
exactly as at selection. This holds for every reviewer family, Codex included.

- A substitute reviews under its own provider id and is recorded as a separate
  `review.select` decision that names the failure; it is never labelled as the
  provider it replaced. The final report names every reviewer that failed in
  the run and why, and says so when no review of the tree stands.
- Every session that ran is charged and counts as a review round. The rounds a
  reviewer spent on the candidate before it was replaced raise the effective
  `review_rounds` hard cap by the same number, recorded as `rounds_granted` on
  its `review.reviewer-failed` decision and summed from those decisions, so a
  replay or a restart cannot grant twice. At the default cap of 4, a reviewer
  that fails after two rounds would otherwise leave the fallback no room. The
  stored cap keeps the snapshot's value. The grant is bounded: a listed reviewer
  fails at most once until a resume, and resumes that start reviewers again
  spend `recovery_attempts`. Cost, wall-clock and the other limits do not move.
- The exclusion holds for the rest of the run, every candidate included, so a
  broken reviewer does not spend the review rounds of each later candidate. It
  ends at `orbit resume`, since a person may have fixed the cause: a run
  resumed after it blocked because every listed reviewer failed tries them in
  order again, and the first continues at its next attempt, which spends one
  recovery attempt as any resume reset does. A run waiting on a person's answer
  under `ask` keeps the selection it asked about.
- One reviewer reviews every unit of a change. When parallel security and UI
  units run and the reviewer fails on one, its other sessions are stopped and
  any review it gave is set aside (invalidated); the next reviewer reviews all
  units, so independence remains one property of the change. When a resume
  selects the same reviewer again, a set-aside review does not count: its unit
  starts a new session, for one recovery attempt, and the run cannot clear until
  every unit has a standing review.
- A block that follows a run-time reviewer failure is not a frozen-policy block,
  even when another listed reviewer is ineligible by policy, since a resume tries
  the failed reviewer again.
- A credential failure or a refused session still blocks the run for a person,
  as before.
