---
change: change-20260911-debounce-untracked-file-open
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Requirements

- **FR-UFO-001:** When file-open priority finds no `SyncRecord`, it shall classify
  the path as untracked without requesting an immediate normal lifecycle.
- **FR-UFO-002:** The scheduler shall route that typed untracked outcome through
  its existing five-second vault debounce. It shall coalesce with any pending
  create, modify, delete, or rename event.
- **FR-UFO-003:** An untracked open without a preceding vault event shall still
  schedule one normal lifecycle after the debounce interval.
- **FR-UFO-004:** A scheduler destroyed while priority lookup is pending shall not
  schedule or execute a later sync from the completed outcome.
- **FR-UFO-005:** A tracked record without remote identity, detached observation
  contradiction, local race, provider failure, CAS loss, and active-batch defer
  shall retain their existing immediate normal-lifecycle and invalidation behavior.

## Acceptance

- Create and immediate file-open do not call `runSync` before the quiet interval.
- A rename or edit inside the interval resets the same timer, so the first batch
  observes the final local path and content rather than publishing the transient name.
- Repeated qualifying events produce one batch after the final event.
- Plugin unload cannot revive a cancelled debounce.
