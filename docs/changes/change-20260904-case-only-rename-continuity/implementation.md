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

### Unit 2 — Cold-start incompatible persisted sync state once

Bump `METADATA_CACHE_VERSION` from 3 to 4 and prove that the existing upgrade handler
drops and recreates its stores. Keep the already-established SyncState 7-to-8
cold-start; do not add a version 9 reset to recover from a prior implementation attempt.
Do not add migration, dual-store coordination, legacy record inspection, or first-COLD
special behavior.

Verify that opening the new metadata version has no checkpoint, performs the ordinary
provider full scan, and that opening SyncState v7 as v8 removes incompatible old path
identity. Unit 3 must work for empty, partial, and established stores alike.

### Unit 3 — Canonicalize case aliases from current component facts

Make `DotPathAdapter` resolve actual casing one segment at a time through raw-adapter
directory listings. In `LocalFs.list()`, pay that I/O only for case-fold collisions and
discard an indexed spelling only when multiple requested spellings resolve to one
actual path. Route `LocalFs.stat()` through this authoritative resolution. Preserve
both names when the adapter proves a genuine case-sensitive collision.

Observation records the local old-to-new alias, exact remote old endpoint, absent remote
new endpoint, unique remote identity, and direct content hashes. It must not emit rename
evidence or inspect acquisition temperature, global record count, prior errors, or
database versions.

Admission is the sole decision owner. It normalizes the component's current facts and
component-local baseline, then exhaustively chooses execute, settled, or reject. A
complete unbaselined alias becomes one explicitly tagged cycle-local
`case_alias_canonicalization` action whose effect is `rename_remote`; incomplete or
contradictory alias proof rejects instead of falling through to unrelated path-local
rules. The tag is an action protocol, not a persisted status or intermediate state.

Executor uses that explicit protocol to revalidate endpoint/content preconditions
immediately before the move and to prove old absence, new identity, and equal
local/remote bytes afterward. Commit the normal `SyncRecord` only after terminal proof;
a race blocks the cycle. The same complete component facts must produce the same
Admission result in COLD, WARM, and HOT cycles and in the presence of unrelated records.

### Unit 4 — Pin the state boundary

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
projection. Unit 3 restores convergence after Unit 2 removed the old baseline. Unit 4
follows the settled implementation so its inventory describes the actual boundary.
Then run all focused tests and the complete repository gate.

### Implementation exclusions

Do not add a second checkpoint, per-operation cache persistence, general rename
inference, folder identity aggregation, journal, receipt, recovery status, or persistent
relation. Do not weaken Admission or extend persisted status vocabularies. The only new
protocol is the strict file-level case-alias canonicalization action derived by
Admission from current component facts; it must never key off acquisition temperature,
whole-store emptiness, a past error, or a stopped status.
