---
change: change-20260904-case-only-rename-continuity
role: implementation
---

<!-- lifecycle is owned by change.md -->

# Implementation

## Content

### Unit 1 — Replace incremental cache bookkeeping with one final snapshot

In `CachingRemoteFs`, delete `touchedPaths`, `pendingFullPersist`, and all branches that
populate, clear, retry, or interpret them. At the existing clean checkpoint boundary,
take one complete snapshot of the live metadata cache while holding the existing cache
mutex and pass it to the existing atomic metadata-store replacement together with the
live cursor and checkpoint-validity metadata.

Do not add a replacement field or operation ledger. A failed save propagates and leaves
the prior durable transaction intact. The mutated live cache may remain only as the
ordinary runtime view; it carries no pending-commit meaning. Preserve existing reset,
full-scan, stale-guard, provider-I/O, and cursor rules.

Update the shared caching-backend contract and the focused Google restart regression to
prove that write, implicit parent creation, rename, delete, and subtree changes survive
recreation exactly as represented in the final live snapshot. Remove speculative
Admission/self-echo RED tests introduced for this incident because this unit fixes the
proven persistence cause without changing Admission.

### Unit 2 — Cold-start only the derived cache

Bump `METADATA_CACHE_VERSION` from 3 to 4 and prove that the existing upgrade handler
drops and recreates its stores. Keep the SyncState version at 7 and preserve all
`SyncRecord` and sync-content rows. Do not add migration, dual-store coordination,
legacy record inspection, or first-COLD special behavior.

Verify that opening the new metadata version has no checkpoint, performs the ordinary
provider full scan, and can commit a replacement cache/cursor while the retained
SyncRecords remain available to normal reconciliation.

### Unit 3 — Pin the state boundary

Clarify ADR 0001, `AGENTS.md`, and `docs/code-enforcement.md` with the same closed rules:

- remote cursor at wholly clean cycle completion and per-file `SyncRecord` after
  successful admitted I/O are the only authoritative durable states;
- checkpoint is the cursor commit operation, not stored state;
- the metadata cache is a subordinate complete projection co-committed with the cursor;
- no new in-memory recovery or pending-commit owner is allowed; and
- additions to `SyncOrchestrator` instance state require an explicit architectural
  review and coordinated rule update.

Add one source-contract test to the normal gate. It shall compare the parsed
`SyncOrchestrator` instance fields with an exact reviewed allowlist, pin the exact
two-item authority catalog used by the documentation contract, and reject the removed
cache-bookkeeping identifiers. Keep the fixture declarative and readable: changing its
expected list must be visibly harder than accidentally adding a field.

### Dependency order

Unit 1 precedes Unit 2 so the first version-4 checkpoint cannot persist the old partial
projection. Unit 3 follows the settled implementation so its inventory describes the
actual boundary. Then run all focused tests and the complete repository gate.

### Implementation exclusions

Do not modify Admission, identity evidence, identity-component graphs, action/status
vocabularies, `SyncStateStore` schema/version, or Orchestrator behavior. Do not add a
second checkpoint, per-operation cache persistence, COLD relation inference, folder
identity aggregation, journal, receipt, or recovery status.
