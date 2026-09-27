---
change: change-20260927-empty-parent-cleanup
role: requirements
functional_requirements:
- id: FR-EPC-001
  priority: must
  statement: >
    WHEN an admitted file deletion or file rename propagates an opposite-side change
    to the receiving filesystem, IF the removal leaves an ancestor directory of the
    removed source path empty on that filesystem, THEN the system shall delete that
    directory and each now-empty ancestor, deepest first, up to but excluding the
    sync root; each candidate directory shall be read at most once per sync cycle.
- id: FR-EPC-002
  priority: must
  statement: >
    The side that originated the change shall not have directories pruned; only the
    filesystem that received the propagated deletion or rename is a prune target.
- id: FR-EPC-003
  priority: must
  statement: >
    Only Admission shall bind a prune candidate set to an action, and it shall bound it
    to the removed source path's ancestry that is itself in sync scope, excluding the
    sync root; execution shall run one deduplicated pass after all admissible removals
    in the cycle, deleting a candidate only after re-proving from current facts that it
    has no children, and shall skip, never force, a candidate whose facts changed.
- id: FR-EPC-004
  priority: must
  statement: >
    A directory shall not be deleted when it, or any candidate in its prune chain,
    holds any child that is not removed by the same admitted action, including an
    out-of-scope, ignored, dot-prefixed, or hidden child; when occupancy cannot be
    proven; when it is the sync root or a reserved path; or when it is itself
    out of sync scope.
- id: FR-EPC-005
  priority: must
  statement: >
    Directory pruning shall add no durable state: no folder SyncRecord, no persisted
    intent or recovery marker, no new keyword in the closed action-type set, and no
    IndexedDB schema change.
- id: FR-EPC-006
  priority: should
  statement: >
    WHEN two or more admitted actions could prune the same directory in one cycle,
    the directory shall be deleted at most once and a duplicate or concurrent prune
    shall be harmless.
- id: NFR-EPC-001
  priority: must
  statement: >
    Directory pruning shall reuse the existing fact-first pipeline, executor target
    filesystem, deletion-safety layers, and commit lifecycle; it shall introduce no
    durable or retained correctness owner, no new state owner, and no recovery branch.
- id: NFR-EPC-002
  priority: must
  statement: >
    The added cost shall be bounded to at most one direct-child read per candidate
    directory per sync cycle (deduplicated across every action, on the receiving
    filesystem only), shall trigger no full scan, and shall issue no provider request
    beyond the existing direct-child read and the folder delete itself.
- id: NFR-EPC-003
  priority: must
  statement: >
    The behaviour shall hold for the local vault and every registered remote backend
    through the IFileSystem boundary, with no backend-identity branch in the sync
    engine or the shared caching base.
- id: NFR-EPC-004
  priority: must
  statement: >
    Local direct-child observation used for emptiness shall report the actual on-disk
    children of a directory, including dot-prefixed and hidden entries excluded from
    the vault index, so an unobserved child can never be mistaken for emptiness.
role: requirements
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Outcome

Deleting or renaming a file out of a folder on one device no longer leaves an
accumulating empty shell of that folder on the other side. When a propagated
opposite-side removal empties an on-device folder, that folder (and any ancestor it
empties in turn) is removed on the receiving side alone, under the same strict
deletion-safety rules the engine already applies to files.

## Scope boundary

This is **not** full empty-folder synchronization. Empty folders are still not synced
as first-class facts: creating an intentionally empty folder, renaming an empty folder,
or deleting a folder that is already empty on both sides still propagates nothing. The
only new behaviour is cleanup of a directory that became empty *as a consequence of a
file removal this cycle admitted on the receiving filesystem*. This deliberately keeps
the change out of the four layers catalogued in
[issue-20260916-empty-folders-never-sync-on-any-backend](../../issue/issue-20260916-empty-folders-never-sync-on-any-backend.md)
(Observation entries, Admission folder identities, action kinds, folder records).

## Functional requirements

### FR-EPC-001 — Empty-ancestor cleanup on propagation

When a file is deleted or renamed out of a folder by an admitted action that applies
an opposite-side change, and the removal empties that folder on the receiving
filesystem, the folder is deleted and the cleanup cascades upward through ancestors
that the cascade also empties. The chain stops before the sync root. A file deleted
at the sync root has no candidate and no cleanup occurs.

### FR-EPC-002 — Receiver-side only

The prune target is the filesystem mutated by the action. For `delete_local` and
`rename_local` that is the local vault; for `delete_remote` and `rename_remote` that is
the remote backend. This is exactly the receiving side of the propagated change, so
the originating side keeps its own now-empty folder, matching the project owner's
decision.

### FR-EPC-003 — Admission authorizes, execution re-proves

Directory deletion is destructive, so only Admission may authorize it. Admission
derives the candidate ancestor chain and authorizes pruning each candidate only from
complete current-cycle occupancy facts (each candidate's direct children on the
receiving side). Execution, after the primary file effect, re-reads each candidate's
direct children and deletes it only if it is empty; a candidate that gained a child is
skipped, not forced, and its ancestors are not considered.

### FR-EPC-004 — Strict survival guarantees

A candidate is never deleted when it holds any child that the same admitted action
does not remove. Out-of-scope, ignored, dot-prefixed, and hidden children all count as
children, so the local emptiness observation must see the real on-disk contents
(NFR-EPC-004). A candidate whose occupancy is unknown, a reserved path, the sync root,
and any out-of-scope candidate are never pruned.

### FR-EPC-005 — No new durable authority

No folder `SyncRecord`, no persisted prune intent, no recovery marker, no cursor
change, and no new member of the closed `SyncActionType` set. The prune is a fixed
protocol carried by the admitted delete/rename action, in the same form `ConflictAction`
already carries a fixed execution protocol.

### FR-EPC-006 — Idempotent cleanup

Deleting an already-absent directory is a no-op. Two admitted actions whose candidates
overlap, or a retry after a partial cycle, must converge without error or duplication.

## Non-functional requirements

### NFR-EPC-001 — Authority and lifecycle bound

The prune rides the existing fact-first pipeline: Admission binds the candidate set,
Execution performs the exact effects and re-proves occupancy from current facts, and the
existing per-action commit/checkpoint lifecycle is unchanged. It adds no durable or
retained correctness owner, no store, and no recovery branch.

### NFR-EPC-002 — Cost bound

At most one `hasChildren` read per candidate directory per sync cycle, deduplicated across
the actions that emptied it, on the receiving filesystem only. No full scan is introduced
and no remote metadata is re-listed beyond that read.

### NFR-EPC-003 — Cross-backend through IFileSystem

Behaviour is expressed only through `IFileSystem` (`hasChildren` + `delete`) and the
existing scope filter; no backend identity is tested in the sync engine.

### NFR-EPC-004 — Authoritative local occupancy

`hasChildren` answers from each backend's own authority: the local disk authority, which
sees dot-prefixed entries the vault index omits, so a directory containing only a hidden
child is not reported empty; a remote backend's derived cache, which holds out-of-scope
objects.

## Accepted limitations (v1)

- A directory emptied by an opposite-side removal that was already fully applied in a
  prior cycle (both sides absent, admitted as state-only `cleanup`) is not pruned; the
  re-planning side has no origin fact. This is the retry boundary of FR-EPC-003.
- The originating side keeps its empty folder by decision (FR-EPC-002).

## Acceptance

- Deleting the last file of `notes/` on the remote removes `notes/` locally after the
  `delete_local` action; the remote keeps `notes/` if the deletion originated remotely.
- Deleting the last file of `notes/` on the local vault removes `notes/` remotely after
  the `delete_remote` action; the local vault keeps `notes/`.
- A rename that moves the last file out of a folder prunes the source folder on the
  receiving side only.
- A folder containing an in-scope sibling, an ignored sibling, a dot-prefixed sibling,
  or failing occupancy proof is never pruned; a nested empty chain prunes deepest-first
  and stops before the sync root.
- Deleting two sibling files in one folder in one cycle reads that folder once, not once
  per action.
- No new action kind, stored record, schema version, or durable intent is added, and the
  full repository gate passes.
