---
change: change-20260923-gdrive-delta-relist-scope
functional_requirements:
- id: FR-001
  priority: must
  statement: When an id-addressed delta upsert describes a folder that had no cached
    path before its own application and resolves to a path, the system shall record
    that folder's stable id in the per-call entered-folder target set in first-entered
    order.
- id: FR-002
  priority: must
  statement: The system shall restrict the delta-completion subtree read to the per-call
    entered-folder target set, reading each remaining topmost target exactly once
    after the whole drain.
- id: FR-003
  priority: must
  statement: While a Google Drive delta drain reports no folder that newly entered
    the bound root, the system shall issue zero subtree-listing requests.
- id: FR-004
  priority: must
  statement: When a folder enters the bound root, the system shall yield the folder
    and its pre-existing descendants as complete modified facts in the same getChangedPaths()
    result, with no deleted or renamed facts and without a COLD rescan, for Google
    Drive, OneDrive, and Dropbox.
- id: FR-005
  priority: must
  statement: If a delta-completion listing request rejects, then the system shall
    not advance the durable checkpoint and shall not publish a partial delta.
- id: FR-006
  priority: must
  statement: The system shall keep entered-folder bookkeeping per-call and discard
    it with the call, never persisting it and never copying it into IncrementalChangesResult.
- id: FR-007
  priority: must
  statement: A backend module shall report provider facts and perform provider mutations
    only, and shall not read the metadata cache, cursor, scope, or stores.
- id: FR-008
  priority: must
  statement: If any request in the delta-completion path returns HTTP 410, then the
    system shall take the existing complete full-scan fallback rather than publish
    a partial delta or advance the cursor past unfetched facts.
- id: FR-009
  priority: must
  statement: Where a backend adapter declares the delta-completion operation, the
    system shall invoke it for the per-call target set; an adapter that does not declare
    it shall remain valid and unchanged.
- id: FR-010
  priority: should
  statement: When documentation or a doc comment describes the incremental re-list
    scope, the system shall describe only the single entered-folder exception and
    shall not claim an account-wide per-changed-folder re-list and shall not claim
    that the completion listing never runs on the incremental path.
- id: NFR-001
  priority: null
  statement: A warm/hot delta cycle with no folder entering the bound root issues
    zero declared-operation (subtree-listing) requests, and a cycle whose only in-scope
    change is an entered folder issues exactly one subtree listing per topmost entered
    target.
- id: NFR-002
  priority: null
  statement: OneDrive and Dropbox production code and request shapes are unchanged,
    the three canonical modules keep their behavior, and the required-contract catalog
    stays complete.
- id: NFR-003
  priority: null
  statement: A failed delta-completion listing aborts the attempt, the durable checkpoint
    is not advanced, and the next attempt re-derives the same targets from the same
    committed window.
role: requirements
---
# Requirements

## Overview

The Google Drive delta drain currently re-lists the whole subtree of every changed folder,
including folders outside the bound root and folders already present in the cache. That
regressed the target selection accepted in
`adr-20260916-gdrive-delta-relists-entered-folders`. This change restores the scope rule:
core selects the per-call entered-folder target set and the declared backend delta-completion
operation lists exactly those subtrees once after the drain, so a steady-state warm/hot
cycle issues zero subtree listings while a folder entering the bound root still yields
complete facts on Google Drive, OneDrive and Dropbox.

## Authority

- `adr-20260916-gdrive-delta-relists-entered-folders` (accepted) is the scope rule being
  restored, and `adr-20260920-backend-module-boundary` is the boundary this design must not
  cross.
- `adr-20260923-core-entered-folder-target-selection` refines adr-20260916 decision 2: core
  keeps target resolution, ordering and merge ownership and delegates only the raw provider
  subtree read.
- `adr-20260923-backend-delta-completion-operation` adds the optional declared operation to
  the Backend Module API surface.
- `adr-20260923-executable-relist-cost-measurement` requires an executable RED/GREEN
  measurement.

## Functional requirements

The EARS statements are carried in this member's frontmatter
(`functional_requirements`) and expanded here by identifier.

### FR-001 — record entered-ness at apply time

When an id-addressed delta upsert describes a folder that had no cached path before its own
application and resolves to a path, the system records that folder's stable id in the
per-call entered-folder target set in first-entered order. Recording at apply time is the
only signal that catches a folder evicted earlier in the same page by its ancestor's
tombstone.

### FR-002 — read only the per-call entered targets

The declared delta-completion subtree read is restricted to the per-call entered-folder
target set, reading each remaining topmost target exactly once after the whole drain.

### FR-003 — steady state issues no listing

While a Google Drive delta drain reports no folder that newly entered the bound root, the
system issues zero declared-operation subtree-listing requests.

### FR-004 — complete facts for an entering folder on all three families

When a folder enters the bound root, the same `getChangedPaths()` result yields the folder
and its pre-existing descendants as complete modified facts, with no deleted or renamed
facts and without a COLD rescan, for Google Drive, OneDrive and Dropbox.

### FR-005 — a rejected completion listing does not publish

If a delta-completion listing request rejects, the system does not advance the durable
checkpoint and does not publish a partial delta.

### FR-006 — per-call bookkeeping only

Entered-folder bookkeeping stays per-call and is discarded with the call; it is never
persisted and never copied into `IncrementalChangesResult`.

### FR-007 — the module reports provider facts only

A backend module reports provider facts and performs provider mutations only, and reads no
metadata cache, cursor, scope or store.

### FR-008 — HTTP 410 takes the full-scan fallback

If any request in the delta-completion path returns HTTP 410, the system takes the existing
complete full-scan fallback rather than publish a partial delta or advance the cursor past
unfetched facts.

### FR-009 — the declaration is optional

Where a backend adapter declares the delta-completion operation, the system invokes it for
the per-call target set; an adapter that does not declare it remains valid and unchanged.

### FR-010 — documentation describes only the single exception

When documentation or a doc comment describes the incremental re-list scope, it describes
only the single entered-folder exception, does not claim an account-wide per-changed-folder
re-list, and does not claim that the completion listing never runs on the incremental path.

## Non-functional requirements

### NFR-001 — cost bounded by entered work

A warm/hot delta cycle with no folder entering the bound root issues zero
declared-operation subtree-listing requests, and a cycle whose only in-scope change is an
entered folder issues exactly one subtree listing per topmost entered target. Measured by
the deterministic managed delta tests (`tests/fs/managed/delta-completion.test.ts`) counting
declared-operation invocations, plus a RED-first adapter unit
(`src/backends/googledrive/adapter.test.ts`) proving the unmodified delta path walked changed
folders. The opt-in live Google Drive e2e covers the move-in completeness scenario, not the
count.

### NFR-002 — compatibility

OneDrive and Dropbox production code and request shapes are unchanged, the three canonical
modules keep their behavior, and the required-contract catalog stays complete. Measured by
the module conformance catalog asserting zero issues over the three families.

### NFR-003 — abort atomicity

A failed delta-completion listing aborts the attempt, the durable checkpoint is not
advanced, and the next attempt re-derives the same targets from the same committed window.
Measured by the managed delta-completion rejection test over a cursor-sensitive provider
fake (`tests/fs/managed/delta-completion.test.ts`): the durable checkpoint and scope
fingerprint are unchanged after the rejection and a retry re-derives the same complete
subtree.

## Acceptance criteria

| id | criterion | requirements |
|---|---|---|
| AC-001 | The per-call entered target set contains exactly the folders whose prior cached path was undefined and whose new path resolved, in first-entered order, is empty on a steady-state page, and is discarded with the call | FR-001, FR-002, FR-006 |
| AC-002 | Zero declared-operation listings on a no-entry drain; exactly one for the topmost remaining target otherwise; the account-wide walk on the delta path is absent, pinned RED-first by an adapter unit | FR-002, FR-003, NFR-001 |
| AC-003 | The shared scope-entry case reports exactly F, F/a.md, F/sub and F/sub/b.md modified, no deleted or renamed, repeated after `abortWorkingView`, on all three families | FR-004 |
| AC-004 | An injected listing rejection aborts the attempt, leaves the durable checkpoint and scope fingerprint unchanged (cursor-sensitive fake), and the next attempt re-derives the same complete subtree | FR-005, NFR-003 |
| AC-005 | `cursor_invalid` makes `fetchChanges` return `needsFullScan` and take the full-scan fallback, publishing no partial delta and keeping a same-path content update the diff cannot re-derive | FR-008 |
| AC-006 | One invocation issues one scoped listing for the supplied identity, returns provider entries, reads no core state; an omitting adapter stays valid and is issued no request | FR-004, FR-007, FR-009 |
| AC-007 | The three canonical modules validate with and without the optional member; a malformed member is rejected at registration; catalog issues are zero; OneDrive and Dropbox production code is unchanged | FR-009, NFR-002 |
| AC-008 | The adapter class doc and the `list-all.ts` comment name only the single entered-folder exception | FR-010 |
| AC-009 | The opt-in live Google Drive e2e exercises the move-in scenario and confirms the complete entered subtree surfaces outside the gate; the steady-state zero-listing count is evidenced by the deterministic managed delta test, not by the live e2e | NFR-001 |

## Non-goals

- Changing the whole-drive `changes.list` drain or narrowing/replacing the Google Drive
  changes feed.
- Changing OneDrive or Dropbox production code or request shapes.
- Persisted or cross-cycle entered-folder state, recovery markers, or a second correctness
  owner.
- Amending RB-CHK-003.
- Changing the sort comparator, tombstone branch or moved branch of the delta apply.

## Open questions

- Resolved: the account-wide RED baseline is observed by the adapter-level unit
  (`src/backends/googledrive/adapter.test.ts`) against unmodified production code, and the
  declared-operation count in the managed delta test is the GREEN steady-state / one-per-
  target witness. The live e2e cannot re-observe the pre-fix count and is not asked to.
