---
id: adr-20260914-publish-captured-push-revision
kind: adr
title: Publish the captured revision of an exactly proved push
status: accepted
created: '2026-09-14'
decision_makers:
- project owner
consulted:
- Codex design workflow
consequences:
  positive:
  - A completed exact push is published even when a later local revision arrives during
    provider I/O, avoiding a manufactured unbaselined conflict.
  - The later revision remains ordinary current input and converges through the next push.
  - Existing proof, publication, tracker, and checkpoint owners remain sufficient.
  negative:
  - Push terminal proof has direction-specific semantics for its local publication entity.
  - Tests and active documentation must distinguish the captured historical local half from
    the current local endpoint.
  - The earlier accepted ADR requires a narrow supersession cross-reference.
  neutral:
  - Exact remote target proof, exact record CAS, non-push strictness, two durable authorities,
    and clean-only checkpoint publication remain unchanged.
  - No provider contract, state schema, action, status, retry mode, or migration changes.
  - A live-provider reproduction is optional corroboration, not acceptance authority.
confirmation: Deterministic same-size and different-size interleavings under SHA-256 and
  MD5-only remote metadata; hashless-capture and remote-corruption controls; exact-CAS,
  pull, rename, conflict, tracker-generation, checkpoint, ownership-guard, and full-gate
  verification.
tags:
- sync
- concurrency
- publication
owners: []
relations:
- {type: originatedFrom, target: change-20260914-in-flight-local-edit-publication}
- {type: modifies, target: adr-20260908-converge-relational-ambiguity-with-a-pre}
source_paths:
- src/sync/content-snapshot.ts
- src/sync/plan-executor.ts
- src/sync/execution-result.ts
- src/sync/state-committer.ts
- src/sync/local-tracker.ts
- src/sync/orchestrator.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/local-edit-during-push.repro.test.ts
- src/sync/plan-executor.test.ts
- src/sync/orchestrator.test.ts
- src/sync/sync-cycle-finalization.test.ts
- docs/adr/adr-20260908-converge-relational-ambiguity-with-a-pre.md
- docs/sync-pipeline.md
- docs/error-handling.md
summary: An exactly proved ordinary push publishes its captured local revision; a later local
  edit remains next-cycle work instead of invalidating the completed transfer.
---

# Publish the captured revision of an exactly proved push

## Context

An ordinary push captures exact local bytes, revalidates its admitted publication inputs,
writes a copy of those bytes, and proves the remote terminal before publishing a
`SyncRecord`. Current behavior then re-stats the local source. If the same path contains a
newer revision, generic two-endpoint equality rejects the completed push even though the
remote exactly contains the captured bytes. The stale baseline makes the next observation
see two unbaselined versions and manufacture a conflict.

The deterministic reproduction covers same-size and different-size later revisions with
SHA-256 and MD5-only remote metadata. Runtime logs show the same blocked-push-to-conflict
sequence but do not prove the writer; the deterministic reproduction is the decision
authority.

The accepted `adr-20260908-converge-relational-ambiguity-with-a-pre` permits the captured
local entity only when the source disappeared, and says a still-present changed source is
non-clean. The request to correct the problem structurally, followed by the instruction to
continue after this cross-responsibility conflict was surfaced, approves the narrow
supersession recorded here.

## Decision

After an ordinary push passes its final pre-write validation, the immutable
`ExactSnapshot` is the local revision transferred by that action. If the admitted remote
terminal proves the same path/identity, kind, size, and bytes, the existing executor-branded
`TerminalActionProof` uses the captured entity as its historical local publication half and
retains the captured bytes as `intendedContent`.

Current local liveness or content after the remote write is not a success condition for that
completed push. A changed, replaced, or absent current local endpoint is current input for a
later action. `commitAction` remains the only record publisher and uses its existing exact
CAS. Its optional merge-base projection uses and validates the captured `intendedContent`.

This decision supersedes only the earlier ADR's claim that a still-present changed local
source necessarily makes an otherwise exactly proved ordinary push non-clean. The earlier
rule remains fully applicable to pre-write source change, an unproved or corrupt remote
target, pull source change/disappearance, rename identity/descendant proof, conflict
preservation/terminal proof, destination occupancy, state CAS, and checkpoint closeout.

The implementation uses the existing `ExactSnapshot` to `TerminalActionProof` path. It does
not introduce a `PushExecutionReceipt`, discriminated receipt union, exported evidence
carrier, registry, retained proof, durable intent, recovery marker, provider API, action, or
status.

## Consequences

An exactly transferred revision can be published and its cycle can close cleanly while a
later tracker generation remains dirty. The next HOT cycle compares that later revision
with the captured baseline and admits an ordinary push. This is current-fact convergence,
not stopped-state recovery.

Remote proof remains exact. A missing, replaced, corrupt, or unavailable target; stale
pre-write input; or CAS failure publishes no affected record and prevents clean checkpoint
completion under existing rules. Pull, rename, and conflict semantics do not inherit the
push exception.

The direction-specific proof meaning must be pinned by positive and adversarial tests. No
additional whole-file buffer or provider call is required.

## Rejected alternatives

- **Keep the disappearance-only exception:** discards a proved remote effect and reproduces
  the stale-baseline conflict.
- **Publish the newest local revision:** attests bytes that were never written remotely and
  corrupts the merge base.
- **Reread and re-upload until stable:** changes one admitted action into an unbounded loop
  that can starve under active editing.
- **Withhold the record:** preserves the defect's two-unbaselined-version state.
- **Persist pending captured work:** creates a third durable authority and recovery branch.
- **Add a new receipt or discriminated evidence union:** duplicates action, captured entity,
  bytes, and remote terminal already closed by the executor-owned branded proof without
  preventing a demonstrated failure.
- **Ignore terminal mismatches generally:** would weaken remote target, pull, rename, and
  conflict safety rather than making the required push-only distinction.

## Confirmation

The focused reproduction must prove captured record and merge-base publication for both
edit sizes and checksum shapes, followed by a conflict-free ordinary push of the later
revision. Executor tests must cover a captured entity without a locally computable key,
remote corruption and identity replacement, pre-write mutation, exact CAS, pull, rename,
and conflict negatives. An orchestrator test must prove later-generation retention, clean
first checkpoint, next HOT push, and unchanged third cycle. The state ownership guard and
the complete repository gate must pass without inventory expansion.
