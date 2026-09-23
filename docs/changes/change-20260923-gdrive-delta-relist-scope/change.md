---
id: change-20260923-gdrive-delta-relist-scope
kind: change
title: Restrict Google Drive delta subtree re-listing to folders newly entering the
  bound root
status: draft
created: '2026-09-23'
profile: sdd@1
intent: >-
  The Google Drive delta drain re-lists the whole subtree of every changed folder,
  including folders outside the bound root and folders already present in the cache.
  That regressed the target selection accepted in
  adr-20260916-gdrive-delta-relists-entered-folders, where only folders that newly
  enter the bound root are re-listed. Warm/hot cycle duration is therefore
  proportional to drive-wide folder activity rather than to the vault scope.
outcomes:
- A delta's subtree re-listing is bounded by the folders that newly enter the bound
  root in that drain, so a steady-state delta issues no listing request.
- Folders outside the bound root and folders already addressable in the working view
  issue no listing request and are never walked.
- The complete-subtree guarantee for a folder entering the bound root is preserved
  without a COLD rescan on all three providers.
scope:
- src/backend-api/index.ts
- src/backend-api/remote-adapter.ts
- src/backends/googledrive/adapter.ts
- src/backends/googledrive/adapter.test.ts
- src/backends/googledrive/list-all.ts
- src/fs/caching/remote-fs.ts
- src/fs/managed/delta-projection.ts
- src/fs/managed/managed-remote-fs.ts
- src/fs/modules/validate-module.ts
- tests/backend-api/validate-module.test.ts
- tests/fs/managed/delta-completion.test.ts
- eslint.config.mts
- docs/adr/adr-20260923-core-entered-folder-target-selection.md
- docs/adr/adr-20260923-backend-delta-completion-operation.md
- docs/adr/adr-20260923-executable-relist-cost-measurement.md
- docs/changes/change-20260923-gdrive-delta-relist-scope/change.md
- docs/changes/change-20260923-gdrive-delta-relist-scope/requirements.md
- docs/changes/change-20260923-gdrive-delta-relist-scope/implementation.md
- docs/changes/change-20260923-gdrive-delta-relist-scope/verification.md
- docs/changes/change-20260923-gdrive-delta-relist-scope/design-plan/design.md
- docs/changes/change-20260923-gdrive-delta-relist-scope/design-plan/spine.yaml
non_goals:
- Changing the OneDrive or Dropbox delta shape.
- Narrowing or replacing the Google Drive changes feed itself.
change_classes:
- behavior
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260923-gdrive-delta-relist-scope/requirements.md
  required: true
- role: implementation
  path: changes/change-20260923-gdrive-delta-relist-scope/implementation.md
  required: true
- role: verification
  path: changes/change-20260923-gdrive-delta-relist-scope/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations: []
source_paths: []
---

## Summary

## Closure Notes
