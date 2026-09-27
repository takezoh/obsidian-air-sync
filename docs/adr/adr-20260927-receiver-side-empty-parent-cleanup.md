---
id: adr-20260927-receiver-side-empty-parent-cleanup
kind: adr
title: Empty folders emptied by an opposite-side removal are pruned on the receiving side
status: accepted
created: '2026-09-27'
updated: '2026-09-27'
decision_makers:
- project owner
consulted:
- change-20260927-empty-parent-cleanup
confirmation: >-
  src/sync/plan-executor.test.ts pins that a listed ancestor is deleted only after an
  empty hasChildren, that a child or a failed read keeps it, and that a shared directory
  is read at most once per cycle across actions; src/fs/local/local-fs.test.ts pins that
  hasChildren sees dot-prefixed children; both sync AST guards stay green with no fixture
  edits.
relations:
- {type: modifies, target: adr-20260916-gdrive-delta-relists-entered-folders}
- {type: conformsTo, target: design-four-stage-sync-pipeline}
consequences:
  positive:
  - A folder emptied by a propagated opposite-side file deletion or rename no longer
    survives as an empty shell on the other device, so the accumulation the reporter
    of issue #77 saw is removed without making empty folders first-class sync facts.
  - The mutation is bounded to directories that an admitted action emptied, in sync
    scope, and authoritatively proven empty at execution, so the existing four
    deletion-safety layers still apply.
  - Nothing new is persisted and no action kind, folder record, or schema changes, so
    both sync AST guards stay green unmodified.
  negative:
  - The originating side keeps its own now-empty folder, so the two sides are
    momentarily asymmetric until the user acts there; this is the owner's chosen
    policy, not a defect.
  - A prune that fails I/O is best-effort and not retried, so one can be left behind
    until another delete occurs in the same folder.
  - Execution, not Admission, evaluates the emptiness precondition, so the destructive
    authorization is a scope-approved candidate set plus a current-fact re-proof rather
    than an observed empty-chain fact.
  neutral:
  - `IFileSystem.hasChildren` is added as the authoritative direct-child occupancy
    query, and `listDir` (a metadata listing with no production caller) is retired; the
    local filesystem composes a disk authority (existence, casing, occupancy, hidden-path
    mutation) with an index authority (indexed mutation and discovery).
  - The pass runs after all serial removals and deduplicates shared directories, so a
    folder emptied by several actions is read once per cycle rather than once per action.
  - Full empty-folder synchronization (issue #77 / PR #78) remains a separate,
    unimplemented decision.
---

# Empty folders emptied by an opposite-side removal are pruned on the receiving side

## Context

Folders are not sync facts: a folder exists on the far side only as a side effect of a
file write. When the last file of a folder is deleted or renamed away on one device,
the propagated action removes the file but leaves the other device's folder as an
empty shell that never disappears. Commit `2996de7` had a v1 `removeEmptyParents()`
sweep; it was removed with the v1 engine in `fa2e878` and never returned in v2.
`docs/adr/adr-20260916-gdrive-delta-relists-entered-folders.md` and
`change-20260915-gdrive-folder-reentry-enumeration` recorded the leftover empty folder
as **accepted current behavior**.

Making empty folders first-class (issue #77 / PR #78) requires directory entries in
Observation, folder identity in Admission, a new action kind in the closed
`SyncActionType` set, and a folder `SyncRecord` representation. That is a large
structural change touching three AST guards and two accepted non-goals. The project
owner instead chose the narrow cleanup: delete a folder on the receiving side when an
opposite-side file removal empties it.

## Decision

When an admitted `delete_local`, `delete_remote`, file `rename_local`, or file
`rename_remote` action removes the last child of a directory on the filesystem it
targets, that directory — and each ancestor the cascade also empties, deepest first,
stopping before the sync root — is deleted on that filesystem.

- **Receiver side only.** The origin side keeps its folder. `delete_local` /
  `rename_local` prune the local vault; `delete_remote` / `rename_remote` prune the
  remote backend.
- **Admission carries the candidate set.** The admitted action carries a
  `pruneEmptyAncestors` protocol: the deepest-first ancestry of the removed source path,
  filtered to directories that are themselves in sync scope and excluding the root. This
  is an action-carried protocol, not a new `SyncActionType`.
- **Execution proves emptiness from current facts in one deduplicated pass.** After every
  serial removal in the cycle, the executor takes the union of the succeeded actions'
  candidate chains, keyed by side and directory, and asks each candidate's
  `IFileSystem.hasChildren` at most once per cycle, deepest-first; it deletes a directory
  only when the answer is false. Any child, any failed read, and any candidate that is
  out of scope or the root prevents deletion and skips its ancestors unread. The local
  `hasChildren` reads the disk authority, so dot-prefixed and hidden entries count.
- **Nothing is persisted.** No folder `SyncRecord`, prune intent, failure record,
  recovery marker, cursor change, or schema change.

## Consequences

- The accepted-current-behavior note in
  `adr-20260916-gdrive-delta-relists-entered-folders` is narrowed: the after-move-out
  empty folder that this change now prunes is no longer accepted; cases this change
  does not cover (an already-empty folder created, renamed, or deleted) stay non-goals.
- The write boundary moves slightly: a directory delete is issued by the executor as a
  fixed consequence of an admitted action rather than as a distinct admitted action.
  The candidate set is authorized by Admission; the emptiness precondition is
  re-proved at execution like every other endpoint precondition.
- The durable authority, action-kind, and store surfaces are unchanged, so both sync
  AST guards remain green with no fixture edits and no ADR 0001 consequences change.
- A failed prune is best-effort and not retried; a folder already empty on both sides
  re-plans as state-only `cleanup` and is not pruned.

## Alternatives

- **Observe folder occupancy in Observation and authorize the exact empty chain in
  Admission.** Strictest fact-first cut, but it needs a new observed-fact member on
  `BatchObservation`, whose member set `sync-admission-authority-guard.test.mjs` pins.
  Deferred as the upgrade path.
- **An optional `IFileSystem.pruneEmptyAncestors()` capability, as namespace
  reconciliation did.** Adds a shared-boundary method with contract/harness obligations
  for every family, for a cleanup the normal `delete` path already handles correctly.
- **A new state-only `prune_folder` action kind.** Grows the closed action-type set for
  a cleanup.
- **Make empty folders first-class sync facts (issue #77 / PR #78).** Out of the agreed
  scope; remains a separate decision.
- **Prune both sides.** Rejected: it would delete folders the user emptied on purpose on
  the device where they work.

{% transition from="proposed" to="accepted" date="2026-09-27" %}
implemented 2026-09-27 per the project owner's instruction, with best-effort prune and no
prune on state-only cleanup.
{% /transition %}
