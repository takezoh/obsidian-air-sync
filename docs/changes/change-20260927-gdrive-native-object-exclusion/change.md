---
id: change-20260927-gdrive-native-object-exclusion
kind: change
title: Exclude Google Drive Workspace-native objects from the remote sync view
status: active
created: '2026-09-27'
summary: Google Drive now drops provider-native Docs Editors objects at the adapter
  boundary instead of projecting them as ordinary files that fail every pull.
profile: sdd@1
intent: >-
  A Google Drive bound root containing a provider-native Workspace object (Docs Editors
  document/sheet/slide, form, script, or shortcut) currently breaks every sync cycle.
  normalizeGoogleDriveObject projects any non-folder mimeType as kind "file", core plans
  a pull, and files.get?alt=media answers 403 fileNotDownloadable, so the object is
  reported remote-only and fails on every cycle. RB-SVC-010 requires such objects to be
  excluded from the remote sync view or rejected before Admission, never projected as an
  ordinary file with incomplete content evidence.
outcomes:
- A provider-native Google Workspace object never enters the remote sync view through
  listAll, listSubtreeById, getById, getByPath, or the changes feed.
- A sync cycle over a bound root containing such an object completes with no pull for it
  and no failure, and a byte-backed file in the same root still syncs unchanged.
- A version-bound read of a native object fails closed as unverifiable instead of
  attempting a media download.
scope:
- src/backends/googledrive/types.ts
- src/backends/googledrive/normalize-object.ts
- src/backends/googledrive/adapter.ts
- src/backends/googledrive/types.test.ts
- src/backends/googledrive/adapter.test.ts
- tests/fs/googledrive/managed.contract-harness.ts
- docs/design/design-remote-backend-implementation-contract.md
- docs/changes/change-20260927-gdrive-native-object-exclusion/**
non_goals:
- Exporting, converting, or otherwise synchronizing the bytes of a Google Workspace-native
  object. They are excluded, not represented.
- Changing the OneDrive or Dropbox backends or the shared backend-module contracts.
- Adding a new RemoteObject kind or a core-side unsupported-object policy branch.
change_classes:
- behavior
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260927-gdrive-native-object-exclusion/requirements.md
  required: true
- role: implementation
  path: changes/change-20260927-gdrive-native-object-exclusion/implementation.md
  required: true
- role: verification
  path: changes/change-20260927-gdrive-native-object-exclusion/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: conformsTo, target: design-remote-backend-implementation-contract}
- {type: conformsTo, target: adr-20260920-backend-module-boundary}
source_paths:
- src/backends/googledrive/normalize-object.ts
- src/backends/googledrive/adapter.ts
- tests/fs/googledrive/managed.contract-harness.ts
evidence_refs:
- type: test
  ref: npm run test:coverage (118 files, 2424 tests)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (69 guard tests)
- type: command
  ref: npm run build
---

## Summary

## Closure Notes
