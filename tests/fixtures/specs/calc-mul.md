## Summary

The calculator can only add. It should multiply too.

## User Scenarios & Testing

### User Story 1 - Multiply two numbers (Priority: P1)

A caller multiplies two numbers with `mul`.

**Why this priority**: It is the feature.

**Independent Test**: Call `mul` and compare the result with the product.

**Acceptance Scenarios**:

1. **Given** two integers, **When** `mul(2, 3)` is called, **Then** it returns 6.
2. **Given** a zero operand, **When** `mul(0, 5)` is called, **Then** it returns 0.

### User Story 2 - Addition is unchanged (Priority: P2)

Existing callers of `add` see no change.

**Why this priority**: A new function must not break the old one.

**Independent Test**: Run the existing add test.

**Acceptance Scenarios**:

1. **Given** the existing `add`, **When** `add(2, 3)` is called, **Then** it still returns 5.

### Edge Cases

- Negative numbers multiply as usual.

## Requirements

### Functional Requirements

- **FR-001**: `apps/calc.mjs` MUST export `mul`.

### Key Entities

- **Calculator**: the module `apps/calc.mjs`.

## Success Criteria

### Measurable Outcomes

- **SC-001**: The unit check passes with a test for `mul`.

## Implementation notes (outside the spec)

- Where: `apps/calc.mjs`. Check: `npm run verify`. Size: small.
