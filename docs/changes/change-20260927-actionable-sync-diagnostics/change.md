---
id: change-20260927-actionable-sync-diagnostics
kind: change
title: Make sync failures actionable with root-cause diagnostics
status: ready
created: '2026-09-27'
profile: sdd@1
intent: >-
  A failed sync currently reports only counts ("Sync: 3 pushed, 1 error") or a raw
  "Sync error: <message>", so the user cannot tell which stage or operation failed or
  why (issue #101). Retry-to-convergence is the design policy and the plugin does not
  assign work to the user, so the fix is to make the existing failure notice name the
  failing operation/phase, the HTTP status when present, and the neutral classification
  the retry policy actually applied, as at most one bounded breakdown per cycle, without
  changing retry/abort policy, gating, or the opt-in log's whole-body evidence.
outcomes:
- Every user-visible sync failure notice (the gated completion notice and each ungated
  cycle-abort notice) names the failing operation/phase, the HTTP status when the
  provider supplied one, and the backend-neutral classification, as at most one bounded
  clause per cycle, with no per-file notice. It assigns no user work, except an
  authentication failure, which names the reconnect action.
- No notice string contains a file path, file name, raw provider text, provider code, or
  credential material; the opt-in diagnostic log keeps its whole-body provider evidence
  unchanged and logging stays opt-in.
- No new setting, command, Settings surface, export control, persisted field, durable
  owner, or migration is added; retry/abort policy and the two error-kind vocabularies'
  ownership are unchanged.
scope:
- src/sync/failure-facts.ts
- src/sync/failure-notice.ts
- src/sync/plan-executor.ts
- src/sync/execution-result.ts
- src/sync/sync-notification.ts
- src/sync/orchestrator.ts
- src/main.ts
- docs/error-handling.md
- docs/note/note-20260927-abort-notice-auth-asymmetry.md
- src/sync/*.test.ts
- docs/changes/change-20260927-actionable-sync-diagnostics/**
non_goals:
- Any change to the opt-in log's whole-body provider evidence, any allowlisted
  provider-code projection, or any path/name stripping of retained evidence.
- Any new setting, command, Settings section, copy/export control, persisted field, or
  migration.
- Any change to retry/abort policy, decideRetry, or AuthError cycle-abort semantics, or
  re-gating the cycle-abort notice on showSyncNotifications.
change_classes:
- behavior
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260927-actionable-sync-diagnostics/requirements.md
  required: true
- role: implementation
  path: changes/change-20260927-actionable-sync-diagnostics/implementation.md
  required: true
- role: verification
  path: changes/change-20260927-actionable-sync-diagnostics/verification.md
  required: true
- role: ux
  path: changes/change-20260927-actionable-sync-diagnostics/ux.md
  required: false
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: conformsTo, target: design-remote-backend-implementation-contract}
- {type: conformsTo, target: design-backend-module-api}
- {type: references, target: note-20260927-abort-notice-auth-asymmetry}
source_paths:
- src/sync/failure-facts.ts
- src/sync/failure-notice.ts
- src/sync/plan-executor.ts
- src/sync/execution-result.ts
- src/sync/sync-notification.ts
- src/sync/orchestrator.ts
- src/main.ts
- docs/error-handling.md
- docs/note/note-20260927-abort-notice-auth-asymmetry.md
summary: Surface a failed sync's operation/phase and neutral classification in the
  existing notices without user instructions, log loss, or new durable state.
---

## Summary

See `requirements.md`, `design-plan/design.md`, `implementation.md`, and
`verification.md`.

## Closure Notes
