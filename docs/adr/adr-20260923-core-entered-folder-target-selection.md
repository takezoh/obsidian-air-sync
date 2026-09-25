---
id: adr-20260923-core-entered-folder-target-selection
kind: adr
title: Core owns per-call entered-folder target selection for Google Drive delta completion
status: accepted
created: '2026-09-23'
updated: '2026-09-23'
decision_makers:
- project owner
consulted:
- dev:design planner, critic, and integrator
consequences:
  positive:
  - The scope rule accepted in adr-20260916-gdrive-delta-relists-entered-folders has a
    live implementing consumer again; a steady-state warm/hot delta issues zero
    subtree-listing requests.
  - Target resolution, ordering, nested dedup and the upsert-only merge stay in the single
    layer that owns the metadata cache, so move/rename accounting and the fail-closed drop
    of unresolvable parents keep one owner.
  - The entered set is per-call bookkeeping only; nothing is persisted and no new
    correctness owner is added to SyncOrchestrator.
  negative:
  - A delta that brings a folder into the bound root still issues one recursive subtree
    read per topmost entered folder, sequentially, and cycle duration grows with the size
    of that subtree.
  - A rejected subtree read still aborts the whole attempt; the durable checkpoint does not
    advance and the next attempt re-derives the same targets.
  - The Backend Module API gains an optional operation, so its surface, adapter validation
    and contract-harness registration must ship in the same change.
  - The shared `CachingRemoteFs` cursor-expiry fallback gains one seam: a delta route that
    mutated the working view before discovering it needs the fallback hands back its
    pre-apply path↔id view and the changed paths it already observed, so the fallback diff
    is measured from the true pre-delta view and keeps a same-id/same-path content update a
    path↔id diff cannot re-derive.
  neutral:
  - OneDrive and Dropbox production code and request shapes are unchanged.
  - The whole-drive changes.list drain is unchanged; only the re-list target selection
    changes.
  - RB-CHK-003 and the sync-state ownership guard are unchanged; the fallback seam carries
    per-call facts only and persists nothing.
confirmation: >-
  The shared caching contract records zero declared-operation listing requests for a
  steady-state delta, and the scope-entry case asserts the exact {F, F/a.md, F/sub,
  F/sub/b.md} fact set for Google Drive, OneDrive and Dropbox over unchanged OneDrive and
  Dropbox production code. npm run test:e2e:google covers the live move-in, move-out and
  move-back-in scenario. npm run lint:bot-repro keeps the backend-boundary and sync-state
  ownership guards green.
tags:
- sync
- googledrive
- delta
owners: []
relations:
- {type: originatedFrom, target: change-20260923-gdrive-delta-relist-scope}
- {type: references, target: adr-20260916-gdrive-delta-relists-entered-folders}
- {type: references, target: adr-20260920-backend-module-boundary}
- {type: references, target: adr-20260921-backend-module-api-v3}
source_paths:
- src/fs/managed/delta-projection.ts
- src/fs/managed/managed-remote-fs.ts
- src/backend-api/remote-adapter.ts
- src/backends/googledrive/adapter.ts
- tests/fs/remote-backend-contracts.test.ts
summary: Core derives the per-call entered-folder target set at apply time, resolves and
  deduplicates it, drives one declared provider subtree read per topmost target after the
  drain, and merges the facts upsert-only; only the raw subtree read is delegated.
---

# Core owns per-call entered-folder target selection for Google Drive delta completion

## Context

`adr-20260916-gdrive-delta-relists-entered-folders` decided that only folders that newly
enter the bound root are re-listed, and that detection happens at apply time through
`IdDeltaResult.enteredFolderIds` with the multi-step target selection (resolve, drop
unresolved, drop nested) owned by the layer that holds the metadata cache. When built-in
backends moved behind the Backend Module API (`32d15bf`, `70cf4cb`), the stateless
`GoogleDriveAdapter` could no longer observe which folders newly entered, and substituted
"re-list the whole subtree of every changed folder" (`adapter.ts` `changedFolderIds`). This
walks folders outside the bound root and folders already present in the cache, so a
warm/hot cycle's cost tracks account-wide folder activity rather than the vault scope.
`src/fs/managed/delta-projection.ts` still builds the `IdDeltaResult` accumulator but
returns only `changedPaths`, `renamedPaths` and `contended`, discarding
`enteredFolderIds`.

## Decision

1. The per-call entered-folder target set is derived in core at apply time from
   `enteredFolderIds` (a folder upsert with no previous cached path that gains a path), and
   projected into the call's result together with the changed paths.
2. Core resolves each target's current path from the metadata cache, drops ids that no
   longer resolve, drops a target nested under another target, and orders the remainder by
   first-entered order. This selection and ordering is not delegated.
3. After the whole drain, core drives one declared provider subtree read per remaining
   topmost target, strictly one at a time, and merges the returned observations through the
   existing `applyIdDeltaPage` upsert-only path. Absence from a listing never removes,
   tombstones or re-keys a cached entry.
4. A rejected subtree read propagates through the existing attempt boundary: the working
   view aborts, the durable checkpoint does not advance, and the next attempt re-derives the
   same targets. Nothing is persisted; the target set lives on the per-call accumulator.
5. Core translates a typed `cursor_invalid` result from the declared operation into the
   existing full-scan fallback, and the fallback is measured from the true pre-delta view:
   a completion route that already applied the adapter delta hands the fallback the
   pre-apply path↔id view and the changed paths it observed, and a path still present after
   the fresh scan is unioned into `modified`. Without this the path↔id diff would read an
   already-applied change as pre-existing, and a same-id/same-path content update would be
   silently dropped even though the cursor advanced. This is the one shared
   `CachingRemoteFs` seam this change touches, and it carries per-call facts only.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Backend-owned entered-folder detection, resolution and merge | A stateless adapter cannot read the metadata cache, cannot import `applyIdDeltaPage` across the module boundary, and must not distinguish a move-in from an in-root rename with forbidden prior state. |
| Reuse whole-root `listAll()` on any entry | Cost becomes proportional to the whole vault. |
| Resolve the target's path at record time instead of drain end | A later rename or tombstone in the drain invalidates the path. |

## Consequences

Positive: the accepted scope rule has a live consumer; steady-state cycles issue zero
listings; one owner for resolution, ordering and merge. Negative: an entered subtree still
lengthens the cycle and a failed read still aborts the attempt. Neutral: OneDrive, Dropbox
and the whole-drive drain are unchanged.

## Confirmation

The shared caching contract records zero declared-operation listing requests for a
steady-state delta and asserts the exact entered-subtree fact set for all three families;
`npm run test:e2e:google` covers the live entry scenario; the boundary and sync-state
ownership guards stay green.
