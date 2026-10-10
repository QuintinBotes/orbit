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
