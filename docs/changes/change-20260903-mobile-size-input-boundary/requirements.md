---
change: change-20260903-mobile-size-input-boundary
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Content

### R1 — Mobile size is input scope

Given a mobile cycle and a currently existing file larger than the configured maximum,
when local events or collected facts cross a sync-input boundary, then the path and its
connected rename facts must not enter `LocalChangeTracker` or `BatchObservation`.
There is no engine disposition equivalent to `mobile_deferred`.

### R2 — Current facts own size eligibility

Current local and remote entities are authoritative; when both exist, the larger size
governs. A file rename applies the same current entity size to both endpoints. Baseline
size alone never keeps an absent or subsequently shrunk file out of scope.

### R3 — Mixed folder rename is file-scoped

Given an included folder rename with both eligible and oversized descendants, local
event ingress must expand it to eligible file changes only. It must not retain a native
folder edge capable of moving the excluded descendant.

### R4 — Priority pull obeys the same boundary

If local metadata already proves an opened file oversized, priority sync performs no
remote observation. If only remote observation proves it oversized, metadata observe
is allowed but content read, local write, baseline commit, tracker mutation, and
recovery scheduling are forbidden.

### R5 — Scope widening is re-observed

The effective mobile threshold is part of the committed scope fingerprint. Raising it
forces exactly one cold reconcile so unchanged remote files behind the delta cursor
become observable; unchanged effective scope does not repeatedly scan cold.

### R6 — Recovery remains stateless

Filtering writes no excluded-path, deferred-operation, or recovery record. A later
eligible current state is planned from fresh facts and the last completed baseline.

### Counterexamples

- Renaming `mobile_deferred` while keeping its Admission branch is invalid.
- Using baseline size as a sticky exclusion is invalid.
- Allowing a mixed folder native rename to carry an oversized child is invalid.
- Scheduling the normal batch merely because priority rejected a deterministic size
  exclusion is invalid.
