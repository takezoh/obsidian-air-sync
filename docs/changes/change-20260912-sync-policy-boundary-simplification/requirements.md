---
change: change-20260912-sync-policy-boundary-simplification
role: requirements
functional_requirements:
- id: FR-SP-001
  statement: The pipeline retains exactly four forward owners and Admission remains
    the sole action and conflict-policy authority.
  priority: must
- id: FR-SP-002
  statement: Conflict strategy is captured once per cycle burst and remains consistent
    across acquisition, retries, Admission, execution provenance, and audit.
  priority: must
- id: FR-SP-003
  statement: Only Prefer local performs the existing bounded post-scope proof enrichment.
  priority: must
- id: FR-SP-004
  statement: Every admitted conflict action carries one required closed typed execution policy.
  priority: must
- id: FR-SP-005
  statement: Execution consumes only the admitted policy and rejects invalid policy before I/O.
  priority: must
- id: FR-SP-006
  statement: Equal complete facts and strategy preserve actions, effects, ordering,
    publication, completion, and retry convergence.
  priority: must
- id: FR-SP-007
  statement: Conflict audit projects strategy provenance from each admitted action.
  priority: must
- id: NFR-SP-001
  statement: Structural guards reject downstream raw-policy interpretation, optional
    policy defaults, foreign Admission-helper imports, and new state owners.
  priority: must
- id: NFR-SP-002
  statement: The refactor adds no provider calls, persistence, retries, scheduling changes,
    or non-Prefer-local proof reads.
  priority: must
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

- Observation shall remain fact-only. A responsibility-local pure predicate may select
  Prefer-local hash acquisition, but it shall not authorize an action or policy.
- Admission shall map the captured strategy and already-bound current component facts
  to a required discriminated `ConflictExecutionPolicy` on every conflict action.
- `ExecutionContext`, resolver calls, and audit projection shall not receive a cycle-global
  raw strategy for behavioral decisions.
- Missing, malformed, or protocol-incompatible conflict policy shall fail before conflict
  I/O and before publication; no fallback strategy is permitted.
- Commit/finalization shall continue to publish only proven successful actions and commit
  a checkpoint only after a wholly clean cycle; incomplete attempts settle siblings and abort.
- Helpers are permitted only within their owning responsibility, pure and attempt-local.
  No shared strategy service, policy registry, retained proof, or additional correctness owner is allowed.

The closed mapping and full EARS/NFR trace are canonical in
`design-plan/design.md` and `design-plan/spine.yaml`.
