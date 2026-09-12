---
id: change-20260910-terminal-publication-exclusivity
kind: change
title: Keep terminal publication single-owner after in-flight renames
status: done
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
promotion:
- target: none
  section: none
  action: none
  item: {}
  reason: The terminal publication and occurrence-ownership rules are already recorded
    in the accepted pipeline design and rename-ambiguity ADR; no further promotion
    is required.
unresolved_decisions: []
tags: []
owners: []
relations:
- {type: modifies, target: design-four-stage-sync-pipeline}
source_paths:
- src/sync/state-committer.ts
- src/sync/identity-component-decision.ts
evidence_refs:
- type: test
  ref: npm run test:coverage (96 files, 1985 tests)
- type: command
  ref: npm run lint
- type: command
  ref: npm run lint:bot-repro (55 guard tests)
- type: command
  ref: npm run build
- type: command
  ref: dev-evidence out-of-scope-changes.v2 PASS
summary: Reuse proved transfer bytes for merge-base projection and bind each current
  occurrence once in Admission.
updated: '2026-09-12'
closure:
  closed_at: '2026-09-12T03:57:03.259240+00:00'
  content_hash: sha256:09a856d6ec2f51c55ff668558be13216e08a52d1624356baf453c8c8139d39d8
---

## Summary

## Closure Notes


{% transition from="active" to="closing" date="2026-09-12" %}
Implementation and recorded repository gate are complete; preparing closure before the dependent exact-path Admission change.
{% /transition %}
