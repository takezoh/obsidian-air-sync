---
id: adr-20260916-gdrive-delta-relists-entered-folders
kind: adr
title: Google Drive delta application re-lists folders that newly enter the bound
  root
status: accepted
created: '2026-09-16'
updated: '2026-09-16'
decision_makers:
- project owner
consulted:
- dev:design planner, critic, and integrator
consequences:
  positive:
  - A folder that enters the bound root through an external move, trash restore, or
    re-entry after an earlier move-out brings its complete current subtree into the
    same getChangedPaths() result, so RB-CHK-003 holds for Google Drive without a
    COLD rescan.
  - Detection does not depend on the order or page in which Google Drive delivers
    changes, including a folder evicted earlier in the same page by an ancestor tombstone.
  - The merge reuses applyIdDeltaPage, so move/rename accounting and the fail-closed
    drop of unresolvable parents stay single-owner.
  - Steady-state deltas and renames of already-cached folders issue no listing request.
  - OneDrive and Dropbox production code is unchanged, and all three families run
    one shared scope-entry case.
  negative:
  - A delta that brings a folder into scope now issues one recursive files.list walk
    per topmost entered folder, sequentially, while CachingRemoteFs.cacheMutex is
    held. Cycle duration grows with the size of that subtree.
  - A listing failure aborts the whole attempt. Under sustained rate limiting, each
    replay repeats the same listings until one succeeds.
  - IdDeltaResult gains a field that OneDrive computes and never reads.
  - The shared caching harness interface gains two required members, which every registered
    caching family must implement.
  neutral:
  - The listing result is a current observation. A change after the drain's new start
    token is delivered in the next window and applied by id without harm.
  - RB-CHK-003, the qualification worksheet, AbstractMetadataCache, CachingRemoteFs,
    the sync-state ownership guard, and the Admission authority guard are unchanged.
  - Under the drive.file grant, the listing contains only app-visible items. That
    is the complete current fact for that grant, not an error.
confirmation: src/fs/googledrive/incremental-sync.test.ts pins never-tracked, re-entry,
  within-page eviction, child-before-parent, stale-path, nested, name-prefix sibling,
  left-scope, tracked-rename, failure, sequential, grant-subset, and cached-elsewhere
  cases against the real GoogleDriveMetadataCache. tests/fs/remote-backend-contracts.test.ts
  runs the shared scope-entry case for Google Drive, OneDrive, and Dropbox. npm run
  test:e2e:google runs the live move-in, move-out, move-back-in case. npm run lint:bot-repro
  keeps both ownership guards green. The OneDrive and Dropbox cells of the shared
  case pass over unchanged production code, with no added client method and no request
  beyond their ordinary delta pages.
tags:
- sync
- googledrive
- delta
owners: []
relations:
- {type: originatedFrom, target: change-20260915-gdrive-folder-reentry-enumeration}
- {type: references, target: design-remote-backend-implementation-contract}
- {type: references, target: adr-20260903-stateless-current-state-recovery}
source_paths:
- src/fs/caching/id-delta.ts
- src/fs/googledrive/incremental-sync.ts
- src/fs/googledrive/list-all.ts
- tests/fs/contracts/caching-remote-fs.contract.ts
- e2e/googledrive.e2e.ts
summary: A Google Drive folder whose id gains a cached path during a changes drain
  has its current subtree listed and merged through the existing delta apply inside
  the same attempt-bounded working view.
updated: '2026-09-16'
---

# Google Drive delta application re-lists folders that newly enter the bound root

## Context

Google Drive's `changes.list` reports one change for each changed item. Moving a folder
reports only that folder. Its unchanged descendants produce no change. `applyEntry()` in
`src/fs/caching/id-delta.ts` re-walks descendants only in its `moved` branch, which
requires that the folder already had a cached path. When a folder's id has no cached path,
the folder enters the cache alone. This happens when the folder was never tracked, or was
evicted when it left the root, was trashed, or was displaced. Its pre-existing descendants
never reach the cache, `getChangedPaths()`, or the vault until a COLD scan runs.

A live probe on 2026-09-16 confirmed the gap (Google Drive, `drive.file` grant, own OAuth
client). After a folder moved out and back in, `changes.list` reported only `F`, and the
incremental view contained only `F`. A COLD scan found `F`, `F/a.txt`, `F/sub`, and
`F/sub/b.txt`. The first move-in was not reliable either: `F/sub` and `F/sub/b.txt` were
missing. The same probe against OneDrive showed that Graph's folder-scoped delta reports
the folder and every pre-existing descendant on each scope entry. The shared
`applyIdDeltaPage` therefore already yields complete facts for OneDrive. A third run of the
same probe, against Dropbox, showed that its path-addressed `list_folder/continue` delta also
reports the entering folder together with every pre-existing descendant, on both the first
move-in and the move back in, so `applyDropboxDelta` is complete as well. All three backends
are measured, and only Google Drive is incomplete.

`docs/design/design-remote-backend-implementation-contract.md` RB-CHK-003 already requires
complete `modified` facts regardless of provider event order. ADR 0001 makes the live
cache/cursor an attempt-bounded working view that commits only after a wholly clean cycle.
`adr-20260903-stateless-current-state-recovery` forbids recovery markers and requires
re-derivation from current facts.

## Decision

1. **Detect at apply time in the shared seam, without I/O.** `IdDeltaResult` gains
   `enteredFolderIds: Set<string>`. `applyEntry` adds `entry.id` exactly when the entry is an
   upsert, `oldPath` from `applyFileChangeDetectMove` is `undefined`, `newPath` is defined,
   and `entry.isFolder` is true. `FileChangeResult.wasFolder` describes the old path and is
   never used for this test. The sort comparator, tombstone branch, moved-outside branch,
   and `moved` branch are unchanged. `id-delta.ts` stays synchronous with type-only imports.

2. **Re-list only in Google Drive, once, after the whole drain.** After the page loop of
   `applyIncrementalChanges` ends, inside its existing `try`:
   - Snapshot `enteredFolderIds` in insertion order. Ids added later are never read.
   - Resolve each id's current path with `getPathById`. Drop an id that no longer resolves.
   - Drop a target whose path `p` has another target path `q` with `p.startsWith(q + "/")`.
   - For each remaining target, in first-entered order and strictly one at a time, call
     `client.listAllFiles(id)`.
   - Merge the result with `applyIdDeltaPage(cache, acc, entries)`. A private mapper builds
     each entry as `{ id, isFolder: mimeType === FOLDER_MIME, file }`.
   The targets are computed once. No other request, concurrency, or retry layer is added.

3. **Merge through the existing apply, upsert-only.** `list-all.ts` records every item before
   it lists that item's folder, so each descendant follows its ancestor. (It records into a
   `Map` keyed by stable id; overwriting keeps the first insertion position, so a folder
   re-reported by a second parent does not move behind its own child.) `applyIdDeltaPage`
   sorts every folder before every file. Uncached folders compare equal at depth 1, and the
   stable sort keeps listing order. An already-cached folder resolves through `idToPath`
   wherever it sorts. An entry with an unknown parent is dropped by `applyFileChange`. A
   listed descendant cached at another path yields a rename pair. Absence from a listing
   never removes, tombstones, or re-keys a cached entry.

4. **A listing failure aborts the attempt.** A rejected `listAllFiles` propagates through the
   existing `catch` of `applyIncrementalChanges`. `getChangedPaths()` or `list()` then rejects,
   `runSyncCycleAttempt` aborts the working view, and the durable checkpoint stays replayable.
   The next attempt replays the same window and derives the same targets. An HTTP 410 from
   any request in the function takes the existing full-scan fallback, which yields complete
   facts. Nothing is persisted: the target list is local to the call, and the entered-folder
   set lives on the per-call accumulator.

5. **OneDrive and Dropbox gain no code or I/O. All three families run one shared case.**
   `applyOneDriveDelta` and `applyDropboxDelta` are unchanged. `runCachingRemoteFsContract`
   gains a scope-entry case with two required harness members, implemented by the Google
   Drive, OneDrive, and Dropbox harnesses. Each harness models its provider's recorded delta
   shape:
   - Google Drive: the folder change only, with `listAllFiles(folderId)` scoped to that folder.
   - OneDrive: the folder plus every descendant.
   - Dropbox: the folder plus every descendant, as its own live probe recorded.
   Every shape is bound to a recorded live observation, so no fake is guessed. No skip,
   optional member, or family-filtered module is introduced, and a family whose real API
   later contradicts its recorded shape is fixed rather than opted out.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Put the fix in the shared seam for both id-addressed backends, as the planning source first asked | `live-probe-onedrive` shows OneDrive already receives complete facts; the fix would add redundant requests for OneDrive. |
| Keep detection entirely in Google Drive: snapshot `hasId` before each page or before the drain | A folder evicted in the same page by its ancestor's tombstone (the depth sort applies `A` before `A/F`) still had a path at sampling time. Its children would stay missing. Apply-time recording is the only exact signal. |
| Record the entered folder's path, then look up `idAt(path)` after the drain | A later rename or tombstone in the drain invalidates the path. The lookup then returns `undefined`, and the implementation either skips the subtree or fails every replay. |
| Add a subtree-merge resolver to `AbstractMetadataCache` that generalizes `resolveFilePathCached` | It rests on a false premise: re-feeding is order-safe, per decision 3. It would add a second resolution path to the base class shared by full scans without preventing any failure. |
| List per page, or list every entered folder concurrently | Per-page listing repeats work for folders a later page nests. Concurrent calls start one AdaptivePool per folder, up to 8 each, so a large move multiplies rate-limit pressure. |
| Place re-listing in the `CachingRemoteFs` base class | It would make every backend pay for, or opt out of, a Google-Drive-specific need, and it changes the RB-CHK-001 shared base. |
| Amend RB-CHK-003 and add a qualification-worksheet bullet | The existing text already requires complete `modified` facts regardless of order. A backend author's own fake could satisfy the proposed enforcement vacuously. |
| Register the scope-entry case only for Google Drive and OneDrive, in a separate module | The remote backend contract forbids opting a backend out of a shared case. Leaving Dropbox unchecked turns missing evidence into an unstated exemption. |
| Amend ADR 0006 | ADR 0006 reorders a complete path-addressed delta. This decision recovers entries a provider never sends. The mechanisms and their failure modes are different. |
| Treat the empty local folder left after a move-out as part of this change | The empty folder is left by `change-detector.ts`'s directory filtering, a separate mechanism. The project owner accepted it as current behavior. |

## Consequences

The positive, negative, and neutral consequences are listed in the frontmatter.
`docs/google-drive-backend.md` and the `list-all.ts` doc comment must stop claiming that
`listAllFiles` never runs on the incremental path. They must describe this single scoped
exception.

## Confirmation

The frontmatter `confirmation` lists the executable checks. Write each Google Drive unit
witness RED-first against the unmodified production code before implementing the change.


{% transition from="proposed" to="accepted" date="2026-09-16" %}
design consult 2026-09-16: project owner accepted the proposed ADR (consultation-gdrive-folder-reentry-enumeration-r3)
{% /transition %}
