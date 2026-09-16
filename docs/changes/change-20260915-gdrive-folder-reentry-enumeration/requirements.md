---
change: change-20260915-gdrive-folder-reentry-enumeration
role: requirements
functional_requirements:
- id: FR-1
  statement: WHEN Google Drive incremental delta application applies a folder change
    whose stable id has no cached path immediately before that change is applied,
    and that folder still resolves inside the bound root when the changes drain ends,
    the Google Drive filesystem SHALL include in the same getChangedPaths() or list()
    working view that folder and every descendant the configured OAuth grant lists
    under it, each descendant reported as modified, or as a renamed pair when its
    id was cached at another path.
  priority: MUST
- id: FR-2
  statement: IF more than one folder satisfies FR-1 in one changes drain and one folder's
    post-drain path is a '/'-delimited descendant of another's, THEN the Google Drive
    filesystem SHALL list only the topmost folder, and a folder whose name merely
    extends another folder's name SHALL still be listed.
  priority: MUST
- id: FR-3
  statement: WHEN a Google Drive changes drain contains no folder that satisfies FR-1,
    including a rename or move of an already-cached folder, the Google Drive filesystem
    SHALL issue no subtree listing request.
  priority: MUST
- id: FR-4
  statement: IF a subtree listing for FR-1 fails after the listing's own bounded retries,
    THEN getChangedPaths() and list() SHALL reject with that error, the durable checkpoint
    SHALL remain unchanged, and the next attempt SHALL list the same folders again
    from the committed window; an HTTP 410 takes the existing full-scan fallback.
  priority: MUST
- id: FR-5
  statement: WHEN a folder with pre-existing descendants moves into the bound root
    on OneDrive or Dropbox, the existing delta application SHALL report the folder
    and every descendant in the same result, without a production code change and
    without any request beyond its ordinary delta pages.
  priority: MUST
- id: NFR-1
  statement: Within one Google Drive changes drain, subtree listings SHALL run sequentially
    with at most one listAllFiles walk in flight, their count SHALL NOT exceed the
    number of topmost folders satisfying FR-1, and no retry layer SHALL be added around
    listAllFiles.
  priority: MUST
- id: NFR-2
  statement: The system SHALL keep the entered-folder set and listing targets only
    within one delta application call, SHALL persist no new field, cursor, evidence
    or recovery marker, SHALL never remove, tombstone or re-key a cached entry because
    it is absent from a subtree listing, and SHALL keep sync-state-ownership-guard.test.mjs
    and sync-admission-authority-guard.test.mjs green without fixture edits.
  priority: MUST
---

<!-- lifecycle is owned by change.md -->

# Requirements

## Context

Google Drive's `changes.list` reports one change for each changed item. Moving a folder
reports only that folder. `applyEntry()` in `src/fs/caching/id-delta.ts` walks descendants
only when the folder was already cached. A folder whose id has no cached path therefore
enters the cache alone, and its pre-existing descendants never sync. Such a folder may have
been never tracked, evicted after leaving the root, or trashed and restored.

A live probe on 2026-09-16 showed the defect on Google Drive. After a folder moved out and
back in, the incremental view contained only the folder, while a COLD scan found all four
items. The same probe, run against the other two backends on the same day, showed that
OneDrive's folder-scoped Graph delta and Dropbox's path-based recursive delta each report the
entering folder together with all its pre-existing descendants, on the first move-in and on
the move back in. All three backends are therefore measured, and only Google Drive is
incomplete.

## EARS requirements

| ID | Type | Requirement |
|---|---|---|
| FR-1 | Event-driven | WHEN Google Drive incremental delta application applies a folder change whose stable id has no cached path immediately before that change is applied, and that folder still resolves inside the bound root when the changes drain ends, the Google Drive filesystem SHALL include in the same `getChangedPaths()` or `list()` working view that folder and every descendant the configured OAuth grant lists under it. It SHALL report each descendant as `modified`, or as a `renamed` pair when that descendant's id was cached at another path. |
| FR-2 | Unwanted behavior | IF more than one folder satisfies FR-1 in one changes drain, and one folder's post-drain path is a `/`-delimited descendant of another's, THEN the Google Drive filesystem SHALL list only the topmost folder. A folder whose name merely extends another folder's name SHALL still be listed. |
| FR-3 | Event-driven | WHEN a Google Drive changes drain contains no folder that satisfies FR-1, including a rename or move of an already-cached folder, the Google Drive filesystem SHALL issue no subtree listing request. |
| FR-4 | Unwanted behavior | IF a subtree listing for FR-1 fails after the listing's own bounded retries, THEN `getChangedPaths()` and `list()` SHALL reject with that error. The durable checkpoint SHALL remain unchanged, and the next attempt SHALL list the same folders again from the committed window. An HTTP 410 takes the existing full-scan fallback. |
| FR-5 | Event-driven | WHEN a folder with pre-existing descendants moves into the bound root on OneDrive or Dropbox, the existing delta application SHALL report the folder and every descendant in the same result. It SHALL need no production code change and send no request beyond its ordinary delta pages. |
| NFR-1 | Performance | Within one Google Drive changes drain, subtree listings SHALL run sequentially, with at most one `listAllFiles` walk in flight. Their count SHALL NOT exceed the number of topmost folders that satisfy FR-1. No retry layer SHALL be added around `listAllFiles`. |
| NFR-2 | Ubiquitous (invariant) | The system SHALL keep the entered-folder set and listing targets only within one delta application call. It SHALL persist no new field, cursor, evidence, or recovery marker. It SHALL never remove, tombstone, or re-key a cached entry because that entry is absent from a subtree listing. `sync-state-ownership-guard.test.mjs` and `sync-admission-authority-guard.test.mjs` SHALL stay green without fixture edits. |

FR-1 covers four ways a folder can enter the root:

- It was never tracked.
- It was re-entered after a move-out.
- It was restored from trash.
- It was evicted in the same page by an ancestor's tombstone.

It also covers a child change delivered before its parent's change, and a folder re-keyed
later in the same drain. Under the `drive.file` grant, the app-visible subset of the
subtree is the complete fact and is not treated as an error.

## Acceptance criteria

- **AC-1 (FR-1):** For each FR-1 case, the same `getChangedPaths()` result contains the
  folder and every descendant the grant can see. The shared scope-entry case passes for
  Google Drive, and so does the live re-entry case.
- **AC-2 (FR-2):** Nested entered folders produce exactly one listing, for the topmost
  folder. `Notes` and `Notes2` produce two listings.
- **AC-3 (FR-3):** A drain with no entered folder, including a rename of a cached folder,
  makes zero `listAllFiles` calls.
- **AC-4 (FR-4):** A rejected listing makes `applyIncrementalChanges` reject with the same
  error. No later target is listed and nothing is committed. After an abort and replay, the
  shared case yields the same subtree facts.
- **AC-5 (FR-5):** OneDrive and Dropbox production files are unchanged. The shared
  scope-entry case passes for both, each over a fake that emits the delta shape its live
  probe recorded, with no added client method or extra request.
- **AC-6 (NFR-1):** Listings run strictly one at a time, and their count equals the number
  of topmost targets.
- **AC-7 (NFR-2):** No new persisted or retained state exists. Absence from a listing never
  removes a cached entry. Both ownership guards pass without fixture edits.

## Invariants

- The entered-folder fact records a stable id at apply time. That fact is valid only when
  the folder's old cached path is `undefined` and its new path resolves. `wasFolder` never
  decides it.
- Listing targets use each id's current path at the end of the drain. They are computed
  once and never persisted.
- A subtree listing is an upsert-only current observation. A later provider change reaches
  the next delta window.

## Failure modes

| Failure | Classification | Observable result |
|---|---|---|
| Listing rejects: auth, permission, notFound, retries exhausted, or pagination cap | External, unknown | The attempt rejects and aborts. The checkpoint is unchanged, and the next attempt re-lists. |
| Listing or delta request returns HTTP 410 | External | The existing full-scan fallback runs and yields complete facts. |
| A backend's real delta contradicts its recorded scope-entry shape | Fidelity divergence | The shared case turns red for that family. Fix the fake or the backend; never skip the family or relax the assertion. |

## Non-goals

- Production changes or new requests for OneDrive or Dropbox.
- The empty local folder left after a remote folder moves out of the root. This is accepted
  current behavior, and no follow-up issue is filed.
- RB-CHK-003 wording or qualification worksheet changes.
- Changes to `AbstractMetadataCache` or `CachingRemoteFs`.
- The `drive.file` visibility limitation (issue 79).
- Restoring the deleted reproduction test `src/fs/googledrive/folder-reentry-delta.test.ts`.
