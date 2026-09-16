---
id: change-20260915-gdrive-folder-reentry-enumeration
kind: change
title: Re-list folders that newly enter the Google Drive synced root
status: ready
created: '2026-09-15'
profile: sdd@1
intent: When a Google Drive folder enters the bound synced root through an external
  move-in, a trash restore, or re-entry after an earlier move-out, sync its pre-existing
  descendants in the same cycle. Today only the folder syncs, and its files stay missing
  until a manual rescan.
outcomes:
- A Google Drive folder whose id gains a cached path during a changes drain reports
  every grant-visible descendant as modified, or as renamed when that descendant was
  cached elsewhere, in the same getChangedPaths() result.
- Detection does not depend on change order or paging, including a folder evicted
  earlier in the same page by its ancestor's tombstone.
- Nested entered folders are listed once, one listing at a time. Deltas without an
  entered folder issue no listing request.
- A listing failure aborts the attempt with no commit. The next attempt re-derives
  the same listings from the committed window.
- OneDrive and Dropbox production code is unchanged. Live probes measured both as
  already complete on scope entry. One shared caching-contract case verifies scope-entry
  completeness for all three families, over fakes that follow those recorded live
  delta shapes.
scope:
- src/fs/caching/id-delta.ts
- src/fs/googledrive/incremental-sync.ts
- src/fs/googledrive/incremental-sync.test.ts
- src/fs/googledrive/list-all.ts
- docs/google-drive-backend.md
- tests/fs/contracts/caching-remote-fs.contract.ts
- tests/fs/googledrive/caching-remote-fs.contract-harness.ts
- tests/fs/onedrive/caching-remote-fs.contract-harness.ts
- tests/fs/dropbox/caching-remote-fs.contract-harness.ts
- src/fs/caching/remote-fs.contract.test.ts
- e2e/googledrive.e2e.ts
- docs/e2e-testing.md
- docs/adr/adr-20260916-gdrive-delta-relists-entered-folders.md
non_goals:
- No OneDrive or Dropbox production change and no new OneDrive or Dropbox request.
- No handling of the empty local folder left after a remote folder moves out of the
  root. This is accepted current behavior and no follow-up issue is filed.
- No change to RB-CHK-003 wording, the qualification worksheet, AbstractMetadataCache,
  CachingRemoteFs, or the applyIdDeltaPage sort and move branches.
- No new persisted field, cursor, evidence, retained set, recovery marker, retry layer,
  or ownership-guard fixture edit.
- No change to the drive.file visibility limitation (issue 79). The deleted reproduction
  test is not restored.
change_classes:
- behavior
- internal_design
governance:
  gate: soft
  reasons:
  - Adds Google Drive files.list requests to the incremental delta path, and changes
    the documented claim that listAllFiles never runs there.
  - Widens the shared IdDeltaResult and the CachingRemoteFsHarness interface used
    by three backend families. Proposes a new ADR.
members:
- role: requirements
  path: changes/change-20260915-gdrive-folder-reentry-enumeration/requirements.md
  required: true
- role: implementation
  path: changes/change-20260915-gdrive-folder-reentry-enumeration/implementation.md
  required: true
- role: verification
  path: changes/change-20260915-gdrive-folder-reentry-enumeration/verification.md
  required: true
promotion:
- target: none
  section: none
  action: none
  item: {}
  reason: RB-CHK-003 in design-remote-backend-implementation-contract already requires
    complete modified facts regardless of provider order. This change makes Google
    Drive meet that obligation and changes no responsibility, boundary, dependency,
    invariant, or capability. The Google Drive mechanism is owned by adr-20260916-gdrive-delta-relists-entered-folders.
unresolved_decisions: []
tags:
- sync
- googledrive
- delta
owners: []
relations:
- {type: conformsTo, target: design-remote-backend-implementation-contract}
- {type: introduces, target: adr-20260916-gdrive-delta-relists-entered-folders}
- {type: conformsTo, target: adr-20260903-stateless-current-state-recovery}
source_paths:
- src/fs/caching/id-delta.ts
- src/fs/caching/metadata-cache.ts
- src/fs/caching/remote-fs.ts
- src/fs/googledrive/incremental-sync.ts
- src/fs/googledrive/list-all.ts
- src/fs/onedrive/incremental-sync.ts
- src/fs/dropbox/incremental-sync.ts
- tests/fs/contracts/caching-remote-fs.contract.ts
- docs/design/design-remote-backend-implementation-contract.md
summary: Google Drive delta application records folders whose id gains a cached path,
  then lists each topmost one once after the drain, so their pre-existing subtrees
  reach the same cycle. OneDrive and Dropbox stay unchanged under one shared scope-entry
  contract case.
updated: '2026-09-16'
---

## Summary

Google Drive's `changes.list` reports a moved folder but not its unchanged descendants. The
shared `applyIdDeltaPage` walks descendants only for a folder that was already cached, so a
folder that enters the root arrives alone. This change adds three pieces:

- `applyEntry` records the ids of folders that gained a cached path.
- After the drain, Google Drive lists each topmost entered folder once, sequentially, and
  merges the result through the existing apply.
- Every caching family runs a shared scope-entry case, with each backend's fake following
  recorded live evidence.

The plan is in `design-plan/`, and the decision is in
`adr-20260916-gdrive-delta-relists-entered-folders`.

## Closure Notes


{% transition from="draft" to="ready" date="2026-09-16" %}
design closed 2026-09-16: plan r3 materialized, ADR accepted, minimality gate continue, verify-final approved
{% /transition %}
