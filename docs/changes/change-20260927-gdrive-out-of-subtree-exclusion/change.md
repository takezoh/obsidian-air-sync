---
id: change-20260927-gdrive-out-of-subtree-exclusion
kind: change
title: Keep Google Drive objects with no parent out of the remote sync view
status: active
created: '2026-09-27'
summary: Google Drive items with no provider parent (e.g. "Shared with me") are no
  longer seated at a bare-name root address and pulled into the vault.
profile: sdd@1
intent: >-
  The normalized `parent_id` location reserves `null` for the bound root AND ONLY the
  bound root, but `normalizeGoogleDriveObject` maps an object with no provider parent to
  `parentId: null`. `NormalizedMetadataCache.resolvePathFromCache` therefore reads such an
  object as a direct child of the bound root and seats it at a bare-name root address. The
  account-wide Google Drive changes feed reports items outside the bound subtree — an item
  in "Shared with me" has no accessible parent — so a shared file becomes a remote-only
  entry and is planned as a pull, even though it is not under the synced folder.
outcomes:
- A Google Drive object whose provider `parents` is empty never enters the remote sync
  view through listAll, listSubtreeById, getById, getByPath, or the changes feed.
- A bound-root file whose parent is the bound root, and any deeper in-subtree file whose
  parent resolves through the cache, continue to sync unchanged.
- Every exclusion is reached through the same representability predicate as the
  native-object exclusion, so core never sees a bare-name address for an object the
  provider did not place in the bound root.
scope:
- src/backends/googledrive/normalize-object.ts
- src/backends/googledrive/adapter.ts
- src/backends/googledrive/adapter.test.ts
- tests/fs/googledrive/managed.contract-harness.ts
- docs/design/design-core-backend-integration.md
- docs/changes/change-20260927-gdrive-out-of-subtree-exclusion/**
non_goals:
- Changing the `parent_id` / `provider_path` addressing contract or the
  `NormalizedMetadataCache` parent-chain resolution.
- Filtering the account-wide changes feed by root at the client (core still drops a
  resolvable-parent object that is not under the root).
- Representing an out-of-subtree object as a visible unsupported item; it is excluded.
change_classes:
- behavior
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260927-gdrive-out-of-subtree-exclusion/requirements.md
  required: true
- role: implementation
  path: changes/change-20260927-gdrive-out-of-subtree-exclusion/implementation.md
  required: true
- role: verification
  path: changes/change-20260927-gdrive-out-of-subtree-exclusion/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: conformsTo, target: adr-20260921-backend-module-api-v3}
- {type: references, target: change-20260927-gdrive-native-object-exclusion}
- {type: references, target: design-core-backend-integration}
source_paths:
- src/backends/googledrive/normalize-object.ts
- src/backends/googledrive/adapter.test.ts
- tests/fs/googledrive/managed.contract-harness.ts
evidence_refs:
- type: test
  ref: npm run test:coverage (118 files, 2427 tests)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (69 guard tests)
- type: command
  ref: npm run build
---

## Summary

## Closure Notes
