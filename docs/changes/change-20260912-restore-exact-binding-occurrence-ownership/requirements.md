---
change: change-20260912-restore-exact-binding-occurrence-ownership
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Requirements

- **FR-EOO-001:** When Admission binds an exact baseline path, it shall claim every
  present local and remote occurrence used by that binding before later binders run.
- **FR-EOO-002:** Admission shall not authorize more than one action from the same
  current occurrence.
- **FR-EOO-003:** If an alias leaves an independently present endpoint without complete
  opposite-side facts, Admission shall fail the component with `unknown_observation`
  and publish no actions.
- **FR-EOO-004:** A historical baseline whose remote identity does not match the
  current exact-path remote shall not exact-bind that remote occurrence before its
  tracked identity is evaluated.
- **FR-EOO-005:** The architecture guard shall reject replacing either ordinary
  exact-binding dispatch site with a hand-built structural materialization.

## Acceptance

- A baseline-backed exact path plus a competing local alias cannot produce both a
  conflict and `rename_remote` for the same destination.
- A historical replacement expectation cannot bind another tracked identity's current
  remote occurrence, regardless of baseline iteration order.
- Exact binding claims the concrete endpoints read by its materializer even when a
  provider cannot supply an optional stable identity.
- Relation abandonment preserves either one-sided present endpoint and retains its
  publication CAS.
- Exact deletion, cleanup, ordinary native alias rename, and relation-abandonment
  behavior remain unchanged.
