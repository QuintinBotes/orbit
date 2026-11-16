## Summary

A goal is free text today; nothing reads an issue. Published results (one vendor, 50 tickets) show specs covering most of a checklist merged 89% against 60%, and no gain from specs on bug fixes or one-file changes. Orbit should accept an issue whose body is a Spec Kit-format spec, check it mechanically, and report back on the issue.

## User Scenarios & Testing

### User Story 1 - Run an issue (Priority: P1)

A person runs `orbit run --issue 42` and Orbit uses the issue's spec as the goal and its acceptance scenarios as contract criteria.

**Why this priority**: It makes the issue tracker the single source of work.

**Independent Test**: Run against a fixture issue and confirm the contract contains one criterion per acceptance scenario.

**Acceptance Scenarios**:

1. **Given** an issue whose body passes the spec check, **When** `orbit run --issue <n>` starts, **Then** the contract maps every Given/When/Then scenario to a criterion and records the issue number.
2. **Given** a delivered run, **When** the pull request opens, **Then** it says `Closes #<n>` and the issue receives one comment with the evidence summary.

### User Story 2 - Refuse a spec that cannot be executed (Priority: P1)

A spec with unresolved questions or no testable scenario is refused before any model is called.

**Why this priority**: A vague spec is the most expensive input a loop can take.

**Independent Test**: Run `orbit spec check` on fixtures with each defect and read the reasons.

**Acceptance Scenarios**:

1. **Given** a body containing a `NEEDS CLARIFICATION` marker, **When** it is checked, **Then** the run is refused and the marker is quoted.
2. **Given** a story without an Independent Test or a Given/When/Then line, **When** it is checked, **Then** the run is refused and the story is named.

### User Story 3 - Small fixes need no spec (Priority: P2)

An issue labelled as a bug with a reproduction runs without the full template.

**Why this priority**: Specs gave no measured gain on bug fixes.

**Independent Test**: Run a bug-labelled fixture with only a reproduction and confirm it starts.

**Acceptance Scenarios**:

1. **Given** an issue labelled `bug` with a reproduction section, **When** it is run, **Then** it starts as a repair run with the reproduction as the fail-before check.

### Edge Cases

- A closed issue, or one with an open blocking issue, is refused with the reason.
- The body is edited during the run: the run keeps the version it started with and says so in its comment.
- Issue text is untrusted input and goes into the prompt as a bounded, marked block.

## Requirements

### Functional Requirements

- **FR-001**: `orbit run` MUST accept `--issue <number|url>`.
- **FR-002**: `orbit spec check <file|issue>` MUST verify: the headings User Scenarios & Testing, Requirements and Success Criteria exist; each story has a priority, a reason, an Independent Test and at least one Given/When/Then line; requirement and criterion ids match `FR-###` and `SC-###`; no clarification marker remains.
- **FR-003**: The check MUST be deterministic and make no model call.
- **FR-004**: The run MUST record the issue number and body hash.
- **FR-005**: On every terminal state the issue MUST get one comment: outcome, failure class, evidence links, spend.
- **FR-006**: The "Implementation notes" section MUST be passed to the planner as hints, separate from the spec.

### Key Entities

- **Issue goal**: issue number, body hash, parsed stories, requirements and criteria.

## Success Criteria

### Measurable Outcomes

- **SC-001**: Every issue in this tracking set passes `orbit spec check`.
- **SC-002**: A fixture run from an issue ends with a linked pull request and exactly one issue comment.

## Assumptions

- The Spec Kit spec template (v1.4.0) is the format; Orbit does not need the `specify` CLI installed.

## Implementation notes (outside the spec)

- Where: `src/cli/commands/run.ts`, `src/controller/start.ts`, `src/delivery/github.ts`, new `src/intake/`.
- Check: `npm run verify`. Size: medium. Tests requested: yes.

