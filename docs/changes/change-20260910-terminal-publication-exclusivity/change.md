---
id: change-20260910-terminal-publication-exclusivity
kind: change
title: Keep terminal publication single-owner after in-flight renames
status: active
created: '2026-09-10'
profile: sdd@1
intent: Converge local notes renamed during a completed first push without optional
  merge-base warnings or duplicate Admission publication at one key.
outcomes:
- A completed first push stores its optional merge base from already proved bytes
  after the old local path disappears.
- Admission cannot authorize two independent publishers by binding one current local
  or remote occurrence twice.
scope:
- src/sync/state-committer.ts
- src/sync/state-committer.test.ts
- src/sync/convergence.test.ts
- src/sync/identity-component-decision.ts
- src/sync/admission-action-uniqueness.test.ts
- docs/sync-pipeline.md
- docs/adr/adr-20260908-converge-relational-ambiguity-with-a-pre.md
non_goals:
- No weaker terminal proof, publication CAS, checkpoint rule, conflict strategy, or
  persistent recovery state.
change_classes:
- behavior
- responsibility
- invariant
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260910-terminal-publication-exclusivity/requirements.md
  required: true
- role: implementation
  path: changes/change-20260910-terminal-publication-exclusivity/implementation.md
  required: true
- role: verification
  path: changes/change-20260910-terminal-publication-exclusivity/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
source_paths:
- src/sync/state-committer.ts
- src/sync/identity-component-decision.ts
summary: Reuse proved transfer bytes for merge-base projection and bind each current
  occurrence once in Admission.
updated: '2026-09-10'
---

## Summary

## Closure Notes
