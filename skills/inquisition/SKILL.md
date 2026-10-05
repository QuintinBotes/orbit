---
name: inquisition
description: Interactively grill a goal or plan with Orbit Inquisition. Asks the minimum high-leverage questions and records decisions. Invoke as /orbit:inquisition.
argument-hint: "<goal-or-plan> [--run <run-id>]"
disable-model-invocation: true
---
# /orbit:inquisition

Turn unsafe assumptions in a goal or plan into testable decisions.

User arguments, verbatim: `$ARGUMENTS`

## Procedure

1. Gather evidence first by inspecting the repository, the plan text and any attached run. Separate facts, assumptions and unknowns.
2. Choose a mode: Clarify, Challenge, Reconcile, Diagnose, Risk review or Decision record.
3. Resolve what you can yourself: follow established conventions with evidence, pick reversible details, and name the smallest experiment for technical hypotheses.
4. Ask only about material uncertainty (product semantics, security rules, financial effects, irreversible data behavior). Each question must change implementation, proof, authority or scope, be unanswerable by inspection, and carry:
   - the evidence you found,
   - lettered options with consequences,
   - a recommendation and whether a safe default exists,
   - the work that stays unblocked meanwhile.
5. Ask the person one batch at a time, highest impact first, and stop asking when the remaining unknowns are low impact or reversible.

## Recording decisions

If the arguments name a run (`--run <run-id>`) or a run is attached, list the questions it is waiting on, put each one to the person, then record the answer they give:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" questions <run-id>
node "${CLAUDE_PLUGIN_ROOT}/dist/orbit.mjs" decide <run-id> <question-id> "<answer, option letter or text>"
```

`decide` needs the run id and the question id, in that order. Only record answers the person actually gave in this conversation. Never answer on their behalf, and never record a model or worker as the decider. When a BLOCKED run has no open questions left, point to `/orbit:resume <run-id>`.

With no run, the grill stays in this conversation: work through the procedure above over the goal or plan text in `$ARGUMENTS`, and nothing is recorded or started. Once the person is satisfied, offer `/orbit:run` with the sharpened goal.

## Reading the result

Summarise as: decisions made (with evidence), assumptions left unverified, and the remaining questions. A non-zero exit prints an error code; report it as printed.
