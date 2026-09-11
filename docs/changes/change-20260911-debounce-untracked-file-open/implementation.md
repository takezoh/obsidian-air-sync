---
change: change-20260911-debounce-untracked-file-open
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Responsibility-preserving implementation

`syncOpenedFilePriority` owns the baseline fact. It reads that fact inside its retryable
attempt boundary and before capability or active-batch checks. It returns the distinct
`untracked` outcome only when no `SyncRecord` exists and performs no lifecycle request.
A baseline read error, or a present record without stable remote identity, continues
through an immediate normal-lifecycle path; no tracked safety fallback is reclassified.

`SyncOrchestrator.pullSingle` keeps the priority coordinator and logging ownership. It
exposes only `"untracked" | undefined` to the scheduler, rather than leaking every
internal priority outcome into the scheduler contract.

`SyncScheduler` remains the sole owner of event timing. After an untracked result it
reuses the existing resettable `debouncedSync`. It checks `destroyed` after the awaited
priority operation and before scheduling, preventing an unload-time timer revival.
The timer is re-armed from the explicit outcome rather than inferred from dirty state,
which covers both event-order variation and an earlier incomplete cycle that already
consumed its timer.

No debounce duration, provider capability, Admission rule, executor behavior,
checkpoint rule, CAS, or persistent state changes.
