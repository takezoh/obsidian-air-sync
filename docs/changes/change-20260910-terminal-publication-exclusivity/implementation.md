---
change: change-20260910-terminal-publication-exclusivity
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Responsibility-preserving changes

`StateCommitter.maybeStoreMergeBase` accepts the executor's optional proved transfer
bytes. `commitAction` supplies them only when the terminal proof belongs to the exact
action. Existing hash/size verification and record-bound content CAS still decide
whether the projection is stored. The fallback path continues to read the current
local endpoint for actions without proved transfer bytes.

`identity-component-decision.bindFiles` claims resolved local and remote occurrences
symmetrically. The baseline loop skips a binding when either current occurrence was
already assigned to a preceding relation binding. That preceding binding already
carries the exact destination baseline in its publication contract; emitting another
action would create two authorities for one record key.

No persistent state, provider API, conflict strategy, executor retry, or CAS behavior
changes.
