---
id: task-20260831-fs-evidence-conformance
kind: task
title: unit-0-provider-evidence-preverification
status: todo
created: '2026-08-31'
priority: normal
effort: medium
files_touched:
- src/fs/ifilesystem-contract.test.ts
- src/fs/caching/remote-fs-contract.test.ts
- src/fs/googledrive
- src/fs/dropbox
- src/fs/onedrive
- e2e
pr: null
tags: []
owners: []
relations:
- type: partOf
  target: change-20260831-sync-decision-resource-components
source_paths: []
change: change-20260831-sync-decision-resource-components
summary: Prove Google Drive, Dropbox, and OneDrive against mandatory shared faithful-fake/interface
  contracts and target live preverification only at a backend with concrete representation-gap
  evidence.
max_diff_loc: 300
pinned_context:
- docs/changes/change-20260831-sync-decision-resource-components/tasks/task-20260831-fs-evidence-conformance.md
- docs/changes/change-20260831-sync-decision-resource-components/design-plan
---

## Responsibility

Prove Google Drive, Dropbox, and OneDrive against mandatory shared faithful-fake/interface contracts and target live preverification only at a backend with concrete representation-gap evidence.

## Execution contract

- Output: Shared conformance results, backend-local fixes for representable failures, and targeted live evidence only when triggered.
- Tool guidance: Reuse public IFileSystem contracts; preserve ADR 0003 opt-in/non-CI live suites and credential-missing skip semantics.
- Boundaries: Do not change sync decision code, add provider switches, weaken shared cases, or extend IFileSystem without an exact unrepresentable live response and separate design.

## Acceptance

- AC-SD-006
