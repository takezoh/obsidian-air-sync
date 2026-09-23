# Restrict Google Drive delta subtree re-listing to folders newly entering the bound root

<!-- anchor: goal -->
## Goal

Restore the scope rule accepted in
`adr-20260916-gdrive-delta-relists-entered-folders`: a delta cycle re-lists only the
folders that newly enter the bound root in that drain, and nothing else. Core selects the
per-call entered-folder target set, resolves and deduplicates it, drives one declared
provider subtree read per topmost target after the whole drain, and merges the returned
provider facts upsert-only. A steady-state warm/hot cycle therefore issues zero subtree
listings, while a folder entering the bound root still yields complete facts on Google
Drive, OneDrive and Dropbox.

## Approach

The regression appeared when built-in backends moved behind the Backend Module API: the
stateless Google Drive adapter can no longer observe which folders newly entered the bound
root, so it substituted "re-list every changed folder's subtree", making cycle cost track
account-wide folder activity. The fix does not re-file that walk into the adapter. Core —
the layer that owns the metadata cache and observes a folder gaining a cached path at
apply time — keeps target selection, path resolution, nested-target dedup, ordering and
the `applyIdDeltaPage` upsert-only merge. The adapter gains only an optional, declared,
identity-addressed subtree read with a typed result; the Google Drive module implements it
as a pure `client.listAllFiles(folderId)` read. OneDrive and Dropbox declare nothing and
stay unchanged.

## Scope

In scope: the shared core apply seam and its per-call entered-target projection; core-side
resolution, dedup, one-at-a-time orchestration, upsert-only merge and the `410`
full-scan translation; the optional declared provider delta-completion operation on the
Backend Module API with adapter validation including malformed declarations; the Google
Drive identity-addressed subtree read; the shared scope-entry completeness case and the
central required-contract catalog for all three families; an executable RED/GREEN
measurement; and documentation accuracy for the single scoped exception.

Out of scope: changing the whole-drive `changes.list` drain or narrowing the Google Drive
changes feed; changing OneDrive or Dropbox production code or request shapes; persisted or
cross-cycle entered-folder state, recovery markers or a second correctness owner; and
amending RB-CHK-003. The shared `CachingRemoteFs` base class is NOT left untouched: its
cursor-expiry fallback gains one narrow seam so a delta route that mutated the working view
before discovering the fallback can hand back the pre-apply view and the changed paths it
already observed, and the fallback diff is measured from the true pre-delta view and keeps
the facts a path↔id diff cannot re-derive. That extension is decided in
`adr-20260923-core-entered-folder-target-selection`; nothing else on the shared base
changes. `design_dimensions` classifies this plan as `boundary-complete`.

<!-- anchor: fr-001 -->
### FR-001 — record entered-ness at apply time

When an id-addressed delta upsert describes a folder that had no cached path before its own
application and resolves to a path, the folder's stable id enters the per-call
entered-folder target set in first-entered order. Recording at apply time is the only
signal that catches a folder evicted earlier in the same page by its ancestor's tombstone;
sampling before or after a page misses it.

<!-- anchor: fr-002 -->
### FR-002 — read only the per-call entered targets after the drain

The declared delta-completion subtree read is restricted to the per-call entered-folder
target set, reading each remaining topmost target exactly once after the whole drain. This
restores `adr-20260916` decision 2 target selection; the read is a snapshot taken and
merged after the whole drain.

<!-- anchor: fr-003 -->
### FR-003 — steady state issues no listing

While a Google Drive delta drain reports no folder that newly entered the bound root, the
system issues zero declared-operation subtree-listing requests. Steady-state cost tracks
in-scope work, not account-wide activity.

<!-- anchor: fr-004 -->
### FR-004 — complete facts for an entering folder on all three families

When a folder enters the bound root, the same `getChangedPaths()` result yields the folder
and its pre-existing descendants as complete modified facts, with no deleted or renamed
facts and without a COLD rescan, for Google Drive, OneDrive and Dropbox. This is the
RB-CHK-003 complete-facts guarantee on all three families.

<!-- anchor: fr-005 -->
### FR-005 — a rejected completion listing does not publish

If a delta-completion listing request rejects, the system does not advance the durable
checkpoint and does not publish a partial delta. The attempt-bounded working view aborts;
the next attempt re-derives the same targets from the same committed window.

<!-- anchor: fr-006 -->
### FR-006 — per-call bookkeeping only

Entered-folder bookkeeping stays per-call and is discarded with the call; it is never
persisted and never copied into `IncrementalChangesResult`. No durable or cross-cycle
correctness owner is added.

<!-- anchor: fr-007 -->
### FR-007 — the module reports provider facts only

A backend module reports provider facts and performs provider mutations only, and reads no
metadata cache, cursor, scope or store. This is the Backend Module API boundary of
`adr-20260920-backend-module-boundary`.

<!-- anchor: fr-008 -->
### FR-008 — HTTP 410 takes the full-scan fallback

If any request in the delta-completion path returns HTTP 410, the system takes the existing
complete full-scan fallback rather than publish a partial delta or advance the cursor past
unfetched facts. Cursor invalidation must not be mistaken for an empty delta; the operation
surfaces it as a typed outcome core translates.

<!-- anchor: fr-009 -->
### FR-009 — the declaration is optional

Where a backend adapter declares the delta-completion operation, the system invokes it for
the per-call target set; an adapter that does not declare it remains valid and unchanged.
OneDrive and Dropbox already receive complete facts and need no request.

<!-- anchor: fr-010 -->
### FR-010 — documentation describes only the single exception

When documentation or a doc comment describes the incremental re-list scope, it describes
only the single entered-folder exception, does not claim an account-wide per-changed-folder
re-list, and does not claim that the completion listing never runs on the incremental path.
The claims that become false are the adapter class doc and the `list-all.ts` reference to
the removed incremental-sync walk; `docs/google-drive-backend.md` already states the single
entered-folder exception correctly.

<!-- anchor: nfr-001 -->
### NFR-001 — cost bounded by entered work

A warm/hot delta cycle with no folder entering the bound root issues zero
declared-operation subtree-listing requests, and a cycle whose only in-scope change is an
entered folder issues exactly one subtree listing per topmost entered target. Measured by the
deterministic managed delta test counting declared-operation invocations, plus a RED-first
adapter unit that fails against the unmodified delta path's account-wide walk. The opt-in
live Google Drive e2e covers the move-in completeness scenario, not the count.

<!-- anchor: nfr-002 -->
### NFR-002 — compatibility

OneDrive and Dropbox production code and request shapes are unchanged, the three canonical
modules keep their behavior, and the required-contract catalog stays complete. Measured by
the module conformance catalog asserting zero issues over the three families.

<!-- anchor: nfr-003 -->
### NFR-003 — abort atomicity

A failed delta-completion listing aborts the attempt, the durable checkpoint is not
advanced, and the next attempt re-derives the same targets from the same committed window.
Measured by the managed caching contract witness injecting a listing rejection and
asserting the durable store is unchanged after abort.

<!-- anchor: component-core-delta -->
### component-core-delta — core delta projection, target selection and orchestration

Owns the per-call entered-folder target set: records it at apply time in the shared seam,
projects it out of `applyRemoteChanges`, resolves and deduplicates targets, drives the
declared completion operation one target at a time after the drain, merges returned provider
facts upsert-only, translates `cursor_invalid` to the full-scan fallback, and discards all
of it with the call. Grounded in `src/fs/caching/id-delta.ts`,
`src/fs/managed/delta-projection.ts` and `src/fs/managed/managed-remote-fs.ts`. The cache
owner is the only layer that observes a folder gaining a cached path (`applyIdDeltaPage`
computes `oldPath`/`newPath`) and the only layer that may resolve ids, deduplicate targets
and merge through `applyIdDeltaPage` without violating the backend-module boundary.

<!-- anchor: component-backend-api -->
### component-backend-api — Backend Module API surface and validation

Declares the optional, provider-neutral delta-completion operation on the Backend Module API
and validates it without requiring it of backends that do not need it. Grounded in
`src/backend-api/remote-adapter.ts`, `src/backend-api/module.ts`, `src/backend-api/index.ts`
and `src/fs/modules/validate-module.ts`. The operation is a provider fact operation, so it
belongs on the adapter surface, not in core-specific sync state.

<!-- anchor: component-googledrive-adapter -->
### component-googledrive-adapter — Google Drive identity-addressed subtree read

Implements the declared operation as a pure folder-identity subtree read over the existing
client, returning the provider's current entries or a typed `cursor_invalid` outcome and
reading no cache, cursor, scope or store. Grounded in
`src/backends/googledrive/adapter.ts` and `src/backends/googledrive/list-all.ts`. The raw
subtree read and its `410` classification stay inside the Google Drive module; path
resolution, ordering, dedup and merge stay in core.

<!-- anchor: component-contract-harness -->
### component-contract-harness — shared backend contract harness and catalog

Runs the one shared scope-entry completeness case for all three families and keeps the
central required-contract catalog complete. Grounded in
`tests/fs/contracts/caching-remote-fs.contract.ts`,
`tests/fs/contracts/remote-backend-family.ts`, `tests/fs/remote-backend-contracts.test.ts`
and `tests/fs/googledrive/managed.contract-harness.ts`. RB-CHK-003 is a shared contract
obligation; the case runs for every registered family with no opt-out.

<!-- anchor: contract-entered-target-projection -->
### contract-entered-target-projection — per-call projection of the entered set

Owned by `component-core-delta`, dimension `data_model`. Two decision rules: record the
folder's stable id at apply time when an id-addressed upsert had no prior cached path,
resolves to a path and is a folder; and project the accumulator's entered ids out of
`applyRemoteChanges` to the caller for this call only. The observable
`observable-entered-target-set` is the ordered ids the delta caller receives. Invariants:
populated at apply time, never sampled before or after a page; discarded with the call and
never persisted or copied into `IncrementalChangesResult`; a folder already addressable in
the working view is never added. Failure `failure-target-set-not-projected` is an internal
contract violation that fails fast, because a missing projection would leave descendants
invisible until a COLD rescan. The three private interior choices the planner left open
(target iteration placement, carrier shape and entered-detection encoding) are delegated as
this contract's `implementation_discretion`, each authorized by the projection unit's files
and each preserving the contract.

<!-- anchor: contract-completion-orchestration -->
### contract-completion-orchestration — core orchestration over the entered targets

Owned by `component-core-delta`, dimension `control_flow`. Four decision rules: after the
whole drain, resolve each target's current cached path, drop ids that no longer resolve and
targets nested under another target, and walk the remainder in first-entered order strictly
one at a time (`decision-orchestrate-after-drain`); merge returned entries through
`applyIdDeltaPage` upsert-only, so absence never removes, tombstones or re-keys
(`decision-merge-upsert-only`); translate `cursor_invalid` for any target into the existing
`needsFullScan` outcome for the whole call (`decision-cursor-invalid-full-scan`); and drive
the walk inside `ManagedRemoteFs.fetchChanges` after the adapter delta, while the cache
mutex is held (`decision-invoke-in-fetch-changes`). Observables `observable-relist-walk`
and `observable-scope-completeness` carry the invocation count/order and the complete-or-
full-scan result. Invariants: no per-page listing, concurrency or retry layer; unresolved
and nested targets are dropped; resolution, dedup, ordering and merge stay in core.
Failures: a transient listing rejection aborts the attempt and publishes no partial delta;
`cursor_invalid` degrades to the complete full-scan fallback; a published partial delta is
an internal violation that fails fast under owner acceptance.

<!-- anchor: contract-googledrive-subtree-read -->
### contract-googledrive-subtree-read — identity-addressed subtree read

Owned by `component-googledrive-adapter`, dimension `integration_contract`. Decision rules:
on invocation with a folder's stable id, list the provider subtree scoped to that id via
the existing `client.listAllFiles(id)` and return the entries as provider facts, reading no
cache, cursor, scope or store; and on `410` return `cursor_invalid` while propagating
retryable errors, never returning a partial subtree as complete. Observable
`observable-subtree-result` is the returned subtree or the typed invalid outcome.
Invariants: addressed by provider identity, never by a derived path; one invocation issues
one scoped recursive listing; no core state is read.

<!-- anchor: contract-relist-attempt-atomicity -->
### contract-relist-attempt-atomicity — attempt-bounded completion

Owned by `component-core-delta`, dimension `failure_recovery`. Decision rules: a rejected
completion listing makes `getChangedPaths()` reject, `runSyncCycleAttempt` aborts the
working view and the durable checkpoint is not advanced; and a subsequent attempt replays
the same committed window and re-derives the same targets from current facts with no
persisted recovery marker. Observable `observable-checkpoint-unmutated` is that the
durable cursor, metadata-cache projection and scope checkpoint are unmutated and no
entered-folder state is persisted. Invariants: the entered list is local to the call and
never persisted; no recovery marker, intent log or second correctness owner is added; the
checkpoint commits only after a wholly clean cycle. A published partial delta is an
internal violation that fails fast under owner acceptance.

<!-- anchor: contract-relist-cost-bound -->
### contract-relist-cost-bound — cost bounded by in-scope entered work

Owned by `component-core-delta`, dimension `performance_budget`. Decision rules: a
warm/hot drain reporting no entered folder issues zero subtree-listing requests
(`decision-zero-steady-state`); one topmost entered folder yields exactly one
declared-operation subtree listing (`decision-one-walk-per-target`). Observable
`observable-listing-count` is the declared-operation request count. The
`profile-relist-cost` `cost_convergence` profile bounds the count by the number of topmost
folders that newly enter the bound root in that drain, with no request when none enters.
Invariant: listing cost is proportional to the entered subtree, never to whole-drive folder
activity; a change to an already-cached folder never triggers a listing. The account-wide
re-list is the regression to remove, not a tolerated cost.

<!-- anchor: contract-shared-scope-entry-completeness -->
### contract-shared-scope-entry-completeness — one shared case for all families

Owned by `component-contract-harness`, dimension `integration_contract`. Decision rules:
every registered family runs the one shared scope-entry case with no family filtered out;
and a family harness emits its own recorded provider delta shape for a move into the root,
so the working view must end up holding what a cold scan would. Observables
`observable-scope-entry-set` (exactly `{F, F/a.md, F/sub, F/sub/b.md}` modified, no deleted,
no renamed, repeated after `abortWorkingView`) and `observable-catalog-completeness`
(zero catalog issues, five contracts per canonical cell). Invariants: no skip, optional
member or family-filtered module; OneDrive and Dropbox production code unchanged; the
exact-set assertion runs through list/stat/getChangedPaths only, never the cache.

<!-- anchor: contract-provider-delta-completion -->
### contract-provider-delta-completion — optional declared completion operation

Owned by `component-backend-api`, dimension `integration_contract`. Decision rules: an
adapter that declares the delta-completion capability lets core invoke the declared
operation for the per-call target set without adding a required member to a backend that
does not need it; and on invocation with one folder identity the module returns that
folder's current subtree entries or a `cursor_invalid` outcome, reading no cache, cursor,
scope or store. Observables `observable-completion-declaration` and
`observable-completion-facts`. Invariants: a module reads no metadata cache, cursor, scope
or store; OneDrive and Dropbox production adapters and request shapes are unchanged; the
operation is addressed by provider identity, never by a derived path. An undeclared
operation means core treats the backend's delta as complete and issues no request; a module
reaching into core sync state fails the boundary guard.

<!-- anchor: contract-module-api-version-evolution -->
### contract-module-api-version-evolution — additive API evolution

Owned by `component-backend-api`, dimension `migration_compatibility`. Decision rules: the
operation is optional and declared, so a backend that omits it remains valid and unchanged
(`decision-optional-additive-member`); and a declared-but-malformed member is rejected by
`validateAdapter` with an `invalid_member` issue before it reaches `ManagedRemoteFs`, while
a valid omitting adapter is accepted (`decision-declaration-shape-validated`). Observable
`observable-version-compatibility`. The `profile-api-evolution` `contract_evolution`
profile records the `RemoteBackendAdapter` surface, its component and third-party
consumers, `backward_compatible` compatibility, the additive optional migration strategy,
same-change rollout, rollback by dropping the member, and `verify-module-compat` as the
baseline and target verification. Invariants: no required member is forced on a backend
that does not need it; the operation is declared, never silently assumed; the API version
stays at 3.

<!-- anchor: contract-entered-bookkeeping-lifetime -->
### contract-entered-bookkeeping-lifetime — per-call lifetime and single writer

Owned by `component-core-delta`, dimension `concurrency`. Decision rules: when a delta
application call completes or aborts, the entered-folder target set is discarded with the
call and never read by a later cycle; and the set has exactly one writer (the apply seam)
and is read once by the same call. Observable `observable-no-cross-cycle-state` is that no
entered-folder field appears in `IncrementalChangesResult`, the metadata store or
`SyncOrchestrator` state after a cycle. Invariants: exactly two durable publication points
remain (the per-file `SyncRecord` and the wholly-clean-cycle checkpoint); no new mutable
correctness owner is added to `SyncOrchestrator`. Persisting or carrying entered state
across cycles fails the sync-state ownership guard.

<!-- anchor: adr-20260923-core-entered-folder-target-selection -->
### adr-20260923-core-entered-folder-target-selection

**Status: accepted.** Refines
`adr-20260916-gdrive-delta-relists-entered-folders` rather than superseding it: core keeps
resolution, ordering and merge ownership (adr-20260916 decision 2), and only the raw
provider subtree read is delegated to a declared operation. Core derives the per-call
entered-folder target set at apply time, resolves and deduplicates it from the metadata
cache, drives the completion read once after the whole drain one target at a time, merges
upsert-only through `applyIdDeltaPage`, and translates `cursor_invalid` to the existing
full-scan fallback. Alternatives rejected: backend-owned entered-folder detection,
resolution and merge (a stateless adapter cannot read the cache, cannot import
`applyIdDeltaPage` across the module boundary, and must not distinguish a move-in from an
in-root rename with forbidden prior state) and reusing whole-root `listAll()` on any entry
(cost becomes proportional to the whole vault). Consequences: the accepted scope rule has a
live implementing consumer again; steady-state warm/hot cycles issue zero subtree listings;
the entered set is discarded with the call; a large entered subtree still lengthens the
cycle and a failure still aborts the attempt.

<!-- anchor: adr-20260923-backend-delta-completion-operation -->
### adr-20260923-backend-delta-completion-operation

**Status: accepted.** Refines `adr-20260921-backend-module-api-v3`'s v3 adapter surface.
Adds an optional, declared, provider-neutral delta-completion (folder-scoped subtree read)
operation to the Backend Module API: it takes one folder stable id and returns a typed
result — the folder's current subtree entries or `cursor_invalid`; `validateAdapter` rejects
a declared-but-malformed member, and the API-surface, module-validation,
catalog/harness/contract-matrix and ADR updates ship in the same change. Alternatives
rejected: a generic folder-scoped listing primitive driven by core (moves sequencing, the
410 fallback and abort policy into core and forces every family to implement an operation
it does not need); keeping the account-wide re-list (violates adr-20260916 decisions 1-2);
and letting the operation reject on 410 for core to parse (core must not re-parse provider
errors; `cursor_invalid` is the one typed taxonomy outcome for expired cursors).
Consequences: OneDrive and Dropbox production adapters and request shapes stay unchanged; a
module without the operation remains valid; a malformed member is rejected at registration;
the surface evolves additively and stays at v3; the boundary guard stays green.

<!-- anchor: adr-20260923-executable-relist-cost-measurement -->
### adr-20260923-executable-relist-cost-measurement

**Status: accepted.** The design justifies the re-list scope by an executable measurement
rather than the cited logs. The deterministic managed delta test records zero
declared-operation listings in steady state and one per topmost entered target after the fix;
the account-wide RED witness is the adapter unit, which fails against unmodified production
code because the old delta path walked changed folders (the declared-operation count cannot
observe that walk on a module that declares no operation). The opt-in live e2e covers the
move-in completeness scenario and measures no counts. Alternatives rejected: proceeding on
the accepted ADR and code reading alone (the cited logs are absent here), relying on the live
e2e for the count (it observes completeness, not counts), and using the declared-operation
count as the RED witness (the unmodified module declares none). Consequences: the scope
benefit is justified by observed invocation counts; no instrumentation is added to production
code.
