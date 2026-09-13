---
id: change-20260912-issue73-local-win
kind: change
title: Evaluate local-wins conflict resolution
status: active
created: '2026-09-12'
profile: sdd@1
intent: Define Prefer local as a general conflict-resolution strategy that preserves
  Like air automation and cannot let uncertain or stale local state silently discard
  a recoverable remote version.
outcomes:
- Prefer local applies only after Air Sync classifies a conflict; ordinary one-sided
  edits and creations remain bidirectional.
- Proven tracked edit/edit conflicts publish the local content at the original path
  without an ordinary conflict copy.
- Baseline-free or content-proof-unavailable collisions preserve both versions without
  prompting, including cold starts from stale devices.
- Edit/deletion and compound identity conflicts retain their existing preservation
  guarantees.
- Prefer local appears beside Auto merge and Duplicate, with its safety boundary explained
  before selection.
scope:
- src/settings-normalize.ts
- src/settings-normalize.test.ts
- src/ui/settings.ts
- src/sync/**
- README.md
- ARCHITECTURE.md
- docs/conflict-resolution.md
- docs/sync-pipeline.md
- docs/code-enforcement.md
- docs/changes/change-20260912-issue73-local-win/**
- src/__mocks__/obsidian.ts
- src/ui/settings.test.ts
non_goals:
- Adding a new durable proof store, recovery marker, or storage migration.
- Changing ordinary bidirectional synchronization semantics.
- Reintroducing per-conflict prompts.
- Addressing unrelated bug reports.
change_classes:
- behavior
- capability
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260912-issue73-local-win/requirements.md
  required: true
- role: implementation
  path: changes/change-20260912-issue73-local-win/implementation.md
  required: true
- role: verification
  path: changes/change-20260912-issue73-local-win/verification.md
  required: true
- role: ux
  path: changes/change-20260912-issue73-local-win/ux.md
  required: false
promotion: []
unresolved_decisions: []
tags:
- conflict-resolution
- issue-73
owners: []
relations: []
source_paths:
- src/sync/change-hash-enrichment.ts
- src/sync/decision-engine.ts
- src/sync/identity-component-decision.ts
- src/sync/conflict-resolver.ts
- src/sync/plan-executor.ts
- src/sync/types.ts
- src/settings-normalize.ts
- src/ui/settings.ts
summary: Define whether local-wins can return as a general, Like-air conflict policy
  without letting untracked or stale vault state discard newer shared content.
updated: '2026-09-12'
---

## Summary

Evaluate and specify a safe, automatic Prefer local conflict strategy while preserving
the existing bidirectional and data-recovery guarantees.

## Closure Notes
