---
change: change-20260910-terminal-publication-exclusivity
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Requirements

- **FR-TPE-001:** When a completed push publishes from an immutable terminal proof
  because its old local address disappeared, optional three-way merge-base storage
  shall use the same proved bytes and shall not reread that obsolete address.
- **FR-TPE-002:** Merge-base projection shall validate bytes against the committed
  record and remain subordinate; its absence shall not invalidate a successful push.
- **FR-TPE-003:** Admission shall bind each current local and remote occurrence at
  most once inside a closed component. A destination baseline already consumed as
  another binding's publication expectation shall not produce a second independent
  publisher at that key.
- **FR-TPE-004:** Executor terminal proof and exact publication CAS shall remain
  unchanged. Execution shall not repair or reinterpret a duplicated Admission plan.

## Acceptance

- A baseline-free push renamed after capture completes without a merge-base warning,
  stores the proved bytes when three-way merge is enabled, then converges normally.
- A reported local rename with a retained destination baseline and absent remote
  destination emits one conflict publisher, not two publishers for the destination.
- A disappearing pull source and an existing-but-changed push source remain blocked.
