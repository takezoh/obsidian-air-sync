---
id: change-20260827-late-bound-sync-execution
kind: change
title: Decide sync direction at work execution time
status: active
created: '2026-08-27'
profile: sdd@1
intent: Decide every direction-free member obligation from current Local, paired admitted-identity
  and current path-occupant Remote evidence, and current SyncRecord only after its
  component obtains execution ownership.
outcomes:
- File-open remains ahead of every unstarted normal component.
- Later normal work naturally resolves from current state without stale-plan deferral,
  provider version ordering, or drift-driven COLD recovery.
- Structural I/O remains bounded by complete frozen batch/delta component evidence.
- Ordinary incomplete cycles replay from a usable unchanged committed incremental
  checkpoint; provider cursor rejection/expiry retains its typed COLD policy.
scope:
- src/sync/ — direction-free Admission, execution-time decision, isolation outcomes,
  effect-shape commit, receipts, priority, and finalization.
- src/fs/ — detached endpoint observation and private schema-neutral committed-checkpoint
  replay.
- ARCHITECTURE.md — durable ownership and lifecycle boundary.
- docs/sync-pipeline.md — late execution and replay lifecycle.
- docs/error-handling.md — incomplete-cycle retry/replay behavior.
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md — narrow supersession notice.
- docs/adr/0002-backends-verified-by-shared-behaviour-contracts.md — shared replay contract.
- docs/adr/adr-20260828-late-bound-component-execution.md — accepted governing decision;
  stable plan alias is adr-late-bound-component-execution.
- docs/adr/adr-20260826-init.md — alias-registry impact acknowledgement.
- docs/adr/adr-issue43-destructive-authorization.md — predecessor Admission invariant
  refinement note.
- docs/adr/adr-20260607-metadata-cache-is-subordinate-to-commit-last.md — canonicalized
  predecessor ADR retained for relation resolution.
- docs/adr/adr-20260827-file-open-fast-pass-preserves-remote-change-batches.md — predecessor
  fast-pass concurrency decision superseded by this change.
- docs/adr/adr-20260827-file-open-fast-pass-uses-targeted-freshness.md — predecessor
  targeted-observation decision retained as history.
- docs/aliases.yaml — stable ADR aliases used by both change packages.
- docs/changes/change-20260827-fast-pass-remote-freshness/ — predecessor change package
  whose implementation is completed and revised by this change.
- docs/changes/change-20260825-issue43-destructive-authorization/change.md — follow-on
  relation and retained Admission invariant note.
- docs/code-enforcement.md — updated line-count ratchet inventory.
- eslint.config.mts — explicit responsibility-bound line-count ratchets required by the
  combined fast-pass and late-bound implementation.
- src/__mocks__/sync-test-helpers.ts — realistic whole-record CAS and remote path seams.
non_goals:
- Durable work queues, receipts, epochs, tokens, or retry state.
- SyncRecord/checkpoint/settings fields, DB_VERSION changes, migrations, expected-absence
  CAS, or multi-path CAS.
- Provider revision ordering, provider enumeration, or backend-specific sync engines.
- Redefining explicit rescan, scope-widening, backend-reset, or cursor-expiry COLD
  policy.
change_classes:
- behavior
- boundary
- invariant
- internal_design
governance:
  gate: auto
  reasons: []
members:
- role: requirements
  path: changes/change-20260827-late-bound-sync-execution/requirements.md
  required: true
- role: implementation
  path: changes/change-20260827-late-bound-sync-execution/implementation.md
  required: true
- role: verification
  path: changes/change-20260827-late-bound-sync-execution/verification.md
  required: true
promotion: []
unresolved_decisions: []
tags:
- sync
- concurrency
- fast-pass
owners: []
relations:
- {type: references, target: adr-20260828-late-bound-component-execution}
- {type: references, target: adr-20260607-metadata-cache-is-subordinate-to-commit-last}
source_paths:
- src/sync/orchestrator.ts
- src/sync/plan-executor.ts
- src/sync/decision-engine.ts
- src/sync/plan.ts
- src/sync/priority-coordinator.ts
- src/sync/local-mutation-barrier.ts
- src/fs/priority-observation.ts
- src/fs/caching/remote-fs.ts
- docs/sync-pipeline.md
- docs/error-handling.md
- docs/adr/0001-metadata-cache-is-subordinate-to-commit-last.md
- docs/adr/0002-backends-verified-by-shared-behaviour-contracts.md
- ARCHITECTURE.md
summary: Schedule path/component work first, then observe current Local, Remote, and
  SyncRecord and choose the operation immediately before execution.
updated: '2026-08-28'
---

## Summary

Replace frozen directional action authority with evidence-connected, direction-free
component/member-obligation authority. Admission fixes exact member IDs, complete path/
identity scope, and an in-memory authorization epoch. Execution observes current Local,
admitted Remote identity, independent current path occupant/absence, and SyncRecord, then
late-decides every member. File-open keeps strict priority. Current-state drift causes
bounded nonterminal re-observation, not stale-plan deferral or COLD.

Single-record content baseline replacement keeps the existing two-argument whole-record
`compareAndPut(expectedRecord, nextRecord)`; the records carry the path, so there is no
separate path argument. Structural state uses current component-owned ordered writes. A partial
structural failure emits no success/checkpoint commit and converges through replay without
an atomic transaction or precommit claim. Clean finalization requires one freshness-bound
latest-epoch component receipt with exact terminal completion evidence for every admitted
member. Partial member success followed by failure emits no component receipt/checkpoint.
For a usable committed cursor, private reversible state owned by `CachingRemoteFs`
replays target and sibling evidence without `list()`, COLD, or a recovery-only provider
call. Provider cursor rejection/expiry alone uses the existing typed COLD policy.

## Closure Notes

Planning content is complete and its governing architecture decision was accepted in
consultation `consultation-late-bound-sync-execution-20260828`. Implementation and the
repository gate are complete; change-package closure remains separate from implementation
while the feature branch is under review. The design fixes
late-bound execution, no stale-driven COLD recovery, existing schema-neutral content CAS,
and observable replay/isolation outcomes while delegating private reversible mechanisms.
The accepted ADR narrowly supersedes ADR 0001 Decision 2's mandatory same-session
`recoverViaColdScan` rule for ordinary incomplete work while retaining commit-last and
the existing typed COLD policy for rejected or expired provider cursors.


{% transition from="draft" to="ready" date="2026-08-28" %}
Design accepted in consultation consultation-late-bound-sync-execution-20260828
{% /transition %}


{% transition from="ready" to="active" date="2026-08-28" %}
Implementation authorized by user
{% /transition %}
