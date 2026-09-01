---
id: change-20260901-admission-priority-pull
kind: change
title: Integrate priority file-open pull with Admission
status: active
created: '2026-09-01'
profile: sdd@1
intent: Preserve PR54 Admission authority while making file-open pull safely preemptive
  between exact actions.
outcomes:
- Opened tracked files can pull fresh remote content before later batch actions without
  rerouting the batch.
- Only an Admission-marked pending singleton pull can be superseded after whole-record
  CAS succeeds.
- Normal batch targeted API call count and hash-enrichment diagnostics remain unchanged.
scope:
- src/fs/ remote filesystem contracts, backend harnesses, registry guard, and Google
  content token
- src/__mocks__/ and local shared-contract consumers
- e2e/ live filesystem and priority fidelity wiring
- vitest.config.ts unit discovery and coverage ownership
- docs/e2e-testing.md live E2E ownership documentation
- docs/adr/ testing responsibility ADRs
- docs/google-drive-backend.md Google Priority content-token responsibility
- docs/changes/change-20260831-sync-decision-resource-components/ active verification
  references affected by harness moves
- AGENTS.md agent operating and release gate
- ARCHITECTURE.md swappable production-core principle and module map
- CONTRIBUTING.md contributor gate and live E2E guidance
- docs/code-enforcement.md remote backend completeness enforcement
non_goals:
- Universal execution-time Admission or action rerouting
- Epochs, member obligations, component receipts, or EffectCommitResult
- Per-component targeted Remote calls during normal batch sync
- Removing global phase barriers or changing rename debt lifecycle
change_classes:
- behavior
- responsibility
- boundary
- capability
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260901-admission-priority-pull/requirements.md
  required: true
- role: implementation
  path: changes/change-20260901-admission-priority-pull/implementation.md
  required: true
- role: verification
  path: changes/change-20260901-admission-priority-pull/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: conformsTo, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: conformsTo, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
- {type: introduces, target: adr-20260901-admission-priority-pull}
source_paths:
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/fs/googledrive/index.ts
- src/fs/dropbox/index.ts
- src/fs/onedrive/index.ts
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/orchestrator.ts
- src/sync/sync-cycle-finalization.ts
summary: Add a narrow detached priority pull to the PR54 Admission pipeline without
  runtime replanning.
updated: '2026-09-01'
---

## Summary

PR #54 の Admission-centered pipeline を正本として保ち、file-open を detached observation と exact singleton pull の置換に限定した priority operation として統合する。通常 action の再 Admission、runtime reroute、epoch/receipt は導入しない。

## Closure Notes
