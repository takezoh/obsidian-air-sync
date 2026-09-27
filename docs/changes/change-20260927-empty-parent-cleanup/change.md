---
id: change-20260927-empty-parent-cleanup
kind: change
title: Prune folders emptied by an opposite-side delete or rename
status: active
created: '2026-09-27'
updated: '2026-09-27'
profile: sdd@1
summary: 反対側の削除・リネーム伝播で空になったフォルダを、受け側だけで安全に削除する。
intent: >-
  Removing the last file of a folder on one device leaves the folder as an empty shell
  on the other device forever. Empty folders are not sync facts, so nothing removes one
  when its last child disappears and both sides accumulate unexplained empty shells.
  This change deletes, on the receiving side only, a directory emptied by a propagated
  opposite-side file delete or rename, and cascades through ancestors it also empties,
  under the existing deletion-safety rules.
outcomes:
- A remote deletion of the last file of a folder removes that folder, and each
  ancestor the cascade empties, from the local vault after the propagation.
- A local deletion of the last file of a folder removes that folder, and each ancestor
  the cascade empties, from the remote backend after the propagation.
- A rename that moves the last file out of a folder prunes the source folder on the
  receiving side only.
- A folder holding any in-scope, ignored, dot-prefixed, or hidden child, or whose
  occupancy cannot be authoritatively proven, is never deleted; the sync root and
  out-of-scope ancestors are never deleted.
- The originating side keeps its own now-empty folder, by decision.
- Each candidate directory is read at most once per sync cycle, shared across the
  actions that emptied it.
- No new SyncActionType, folder SyncRecord, IndexedDB schema change, or persisted
  intent is introduced, and both sync AST guards stay green with no fixture edits.
scope:
- src/sync/types.ts — optional `pruneEmptyAncestors` protocol on SyncActionBase and a
  `ScopeProjection.includes` path predicate.
- src/sync/scope-projection.ts — populate `includes` from the projection's `isIncluded`.
- src/sync/sync-cycle-planning.ts — thread `includes` through captureBatchObservation.
- src/sync/identity-component-decision.ts — attach the scope-filtered, deepest-first
  ancestor chain to admitted delete and file-rename actions.
- src/sync/prune-empty-parents.ts — the cycle-level deduplicated cleanup pass over
  succeeded actions' candidate chains, each directory read at most once.
- src/sync/plan-executor.ts — invoke the pass once, after all serial removals.
- src/fs/interface.ts — replace the unused metadata-rich `listDir` with `hasChildren`,
  the authoritative direct-child occupancy query.
- src/fs/local/disk-surface.ts — the disk authority (existence, actual casing, occupancy,
  hidden-path mutation), renamed from DotPathAdapter.
- src/fs/local/vault-surface.ts — the index authority (indexed mutation and discovery).
- src/fs/local/index.ts — compose the two authorities; own the authority rule,
  cross-regime parent creation, and cross-regime rename.
- src/fs/caching/remote-fs.ts — answer `hasChildren` from the derived cache.
- src/sync/plan-executor.test.ts, src/sync/plan-admission.test.ts,
  src/sync/orchestrator.test.ts, src/fs/local/local-fs.test.ts,
  src/fs/local/disk-surface.test.ts, tests/fs/contracts/ifilesystem-writes.contract.ts —
  witnesses and negative controls.
- docs/adr/adr-20260927-receiver-side-empty-parent-cleanup.md — the accepted decision.
- docs/adr/adr-20260916-gdrive-delta-relists-entered-folders.md — narrow the accepted
  empty-folder note to the cases still out of scope.
- docs/sync-pipeline.md, AGENTS.md — deletion-safety and project-gotcha updates.
non_goals:
- First-class empty-folder sync (issue #77 / PR #78): creating, renaming, or deleting
  an already-empty folder still propagates nothing.
- Any directory entry in Observation, any folder identity in Admission, any new
  SyncActionType, any folder SyncRecord, or any IndexedDB/schema change.
- Any backend module change; behaviour is expressed only through IFileSystem.
- Pruning the originating side, or pruning a folder emptied in an earlier cycle whose
  action re-plans as state-only cleanup.
- A persisted prune intent, failure record, or recovery marker.
change_classes:
- behavior
- invariant
governance:
  gate: soft
  reasons:
  - Adds a destructive directory mutation on the receiving filesystem that the
    sync engine issues as a fixed consequence of an admitted action.
  - Narrows an accepted-current-behavior note recorded in
    adr-20260916-gdrive-delta-relists-entered-folders, so the withdrawal must be
    recorded.
members:
- role: requirements
  path: changes/change-20260927-empty-parent-cleanup/requirements.md
  required: true
- role: implementation
  path: changes/change-20260927-empty-parent-cleanup/implementation.md
  required: true
- role: verification
  path: changes/change-20260927-empty-parent-cleanup/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags:
- sync-engine
- deletion-safety
- folders
owners: []
relations:
- {type: conformsTo, target: design-four-stage-sync-pipeline}
- {type: modifies, target: adr-20260916-gdrive-delta-relists-entered-folders}
source_paths:
- src/sync/types.ts
- src/sync/scope-projection.ts
- src/sync/sync-cycle-planning.ts
- src/sync/identity-component-decision.ts
- src/sync/prune-empty-parents.ts
- src/sync/plan-executor.ts
- src/fs/interface.ts
- src/fs/local/disk-surface.ts
- src/fs/local/vault-surface.ts
- src/fs/local/index.ts
- src/fs/caching/remote-fs.ts
evidence_refs:
- type: test
  ref: npm run test:coverage (118 files, 2443 tests)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (69 guard tests, no fixture edits)
- type: command
  ref: npm run build
---

## Summary

Deleting or renaming the last file out of a folder on one device leaves an empty
folder on the other device forever, because folders are not sync facts. This change
prunes, on the receiving side only, a directory emptied by a propagated opposite-side
file delete or file rename, cascading through ancestors the cascade also empties and
stopping before the sync root. Admission attaches the scope-filtered ancestor chain to
the admitted action; execution re-proves each directory is empty from current facts with
`IFileSystem.hasChildren`, so a hidden or ignored child can never be mistaken for
emptiness. The local filesystem is split into a disk authority and an index authority
that `LocalFs` composes.

It is deliberately not full empty-folder sync: creating, renaming, or deleting an
already-empty folder still propagates nothing.

## Closure Notes

Implemented 2026-09-27 with the recommended defaults from the design's unresolved
decisions, which are now settled and recorded here:

- **Prune failure is best-effort.** A failed emptiness read or directory delete is logged
  at warn and never fails the primary action; it is not persisted or retried. A missed
  prune is reclaimed only by another delete in the same folder.
- **No prune on state-only `cleanup`.** When both sides are already absent the origin is
  not recorded, so the receiver side cannot be named without new state.
- **Full empty-folder sync (issue #77 / PR #78) is deferred**, not superseded, and remains
  a separate decision.
