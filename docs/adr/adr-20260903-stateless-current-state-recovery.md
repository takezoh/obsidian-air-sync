---
id: adr-20260903-stateless-current-state-recovery
kind: adr
title: Recover sync from committed facts and current observation
status: accepted
created: '2026-09-03'
decision_makers:
- project owner
consequences:
  positive:
  - Recovery has one path and cannot replay an obligation that contradicts current state.
  - A failed action is eligible again on the next explicit sync.
  negative:
  - A Dropbox case-only two-leg move cannot be made crash-atomic without provider support or a prohibited journal.
  neutral:
  - Native rename evidence remains a current-cycle optimization, not correctness state.
confirmation: Production has no operation journal or cross-cycle failure quarantine;
  failure/restart convergence tests, versioned cold-start tests, and the repository gate pass.
tags: []
owners: []
relations:
- {type: supersedes, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
- {type: supersedes, target: adr-20260902-authorized-operation-journal-with-nonreplaying-attention}
- {type: modifies, target: adr-20260903-four-stage-sync-pipeline}
- {type: references, target: adr-20260902-fresh-state-reconciliation-for-rename-edits}
source_paths:
- src/sync/state.ts
- src/sync/orchestrator.ts
- src/sync/plan-admission.ts
- src/sync/sync-cycle-finalization.ts
- src/fs/dropbox/index.ts
- src/store/metadata-store.ts
summary: Persist terminal facts only; after any error, re-observe current endpoints and replan.
updated: '2026-09-04'
---

## Context

`RenameDebt` persisted local rename evidence before provider I/O and released it only
after a safe checkpoint. Dropbox separately persisted `dropboxCaseRenamePending` and
resumed a two-leg case-only move during initialization. These mechanisms attempted to
survive restart, but made incomplete commands durable and introduced replay, release,
startup mutation, and contradiction handling beside the ordinary sync algorithm.

The four-stage architecture already has sufficient commit boundaries: execution can
commit a verified successful unit's `SyncRecord`, while finalization commits remote
cache/cursor/scope only for a clean cycle. A failure can therefore retain the last
committed baseline and obtain current endpoint state on the next sync.

## Decision

Persist only verified successful-unit `SyncRecord` bundles and the clean-cycle remote
checkpoint. Do not persist or replay observation, rename evidence, operation intent,
debt, pending/deferred work, startup resume instructions, or failure quarantine.

Rename evidence belongs only to the current Observation snapshot. After failure, the
checkpoint owner aborts its live working view; same-process retry and restart therefore
both restore the last committed cursor/baseline and observe endpoints again. A
general rename whose evidence is gone falls back to ordinary new-path transfer and
old-path delete/conflict logic. Rename plus local content change is not itself a
conflict; a remote change from the baseline is.

Schema invalidation remains the one-time exception to restoring an old baseline. When
persisted semantics are incompatible, each database owner uses the project-wide
drop-and-recreate policy. The 2026-09-04 repair applies that policy to metadata cache
v3→v4 and SyncState v7→v8 because retaining v7 path identity can preserve a component
created by the defective checkpoint projection. This stores no recovery instruction:
the next ordinary no-checkpoint, no-baseline COLD cycle observes current endpoints and
re-establishes terminal facts.

A case-only relation may be canonicalized without operation history from complete
current component facts. For an unbaselined component in every acquisition mode the raw local adapter must prove
old→new aliasing, exact local new and remote old, stat-authoritative remote-new absence,
one remote identity occurrence, and byte-identical direct reads. Observation publishes
only endpoint, identity, SHA-256, and size facts; Admission normalizes the component and
alone authorizes an explicit `case_alias_canonicalization`/`rename_remote` protocol
after validating equal content and included scope. The rule never depends on a zero-
record store, schema version, prior failure, or COLD/WARM/HOT selection. This is not
general content-based identity inference and persists nothing. Provider canonical/
display spelling must still distinguish exact old/new/temp. For folders, current-cycle
tracker evidence may be coalesced from managed descendants; excluded descendants never
enter the evidence surface.

When a terminal baseline exists, the alias feeds the ordinary fresh-reconciliation
table instead: baseline-relative local and remote changes determine rename/write,
conflict, or settlement. This remains current-fact Admission, not a recovery branch.

Dropbox retains its non-atomic `old -> temp -> new` implementation only inside one
provider invocation. On a returned second-leg error it re-observes old/new/temp by stable
id and exact display casing. Exact new is success; exact temp permits one rollback to old
and mandatory verification; exact old alone returns the original failure; ambiguous,
foreign, missing, or unobservable placement is indeterminate. Cache changes only after
verified exact-new success. The engine then commits `SyncRecord` only after provider
success and checkpoint only after the whole cycle is clean.

Remove `FailedActionTracker` and the prior-cycle TTL blocker because a decision based
on an earlier cycle contradicts current-state replanning. Current-cycle `blocked` /
`superseded` priority invalidation and bounded provider retries remain separate
mechanisms.

## Responsibility boundaries

1. **Observation** acquires committed baseline plus current included local/remote facts
   and emits optional cycle-local rename/case-only evidence. Excluded paths do not leave
   this boundary.
2. **Admission** is the sole action authority. It accepts frozen facts, verifies identity,
   occupancy, casing, scope, and conflict conditions, and returns an executable plan or
   invocation-local failure. It owns no persistence lifecycle.
3. **Execution/provider** performs authorized effects and returns terminal proof.
   Dropbox settlement and rollback stay inside one invocation and expose no temp/pending
   model to the engine.
4. **Commit/finalization** persists successful unit facts and, only for a clean cycle,
   the remote checkpoint. On failure it aborts the live derived view, retains the old
   checkpoint, and writes no recovery instruction. The next ordinary acquisition chooses
   COLD, WARM, or HOT from durable/current facts only.

## Consequences

{% consequence kind="positive" %}
Reverted or superseded rename history cannot turn an already converged current state back
into an Admission error, and explicit retry is never delayed by past failure TTL.
{% /consequence %}

{% consequence kind="negative" %}
A hard kill between Dropbox moves, or rollback that cannot be observed or completed,
cannot be guaranteed to converge automatically without a journal or provider atomic
primitive. The implementation reports indeterminate failure and makes no success claim.
{% /consequence %}

{% consequence kind="neutral" %}
After restart, a non-case-only rename may lose native-rename optimization and execute as
ordinary current-path actions. This changes cost, not the safety contract.
{% /consequence %}

## Rejected alternatives

- Rename debt as deferred, pending, retry, non-authoritative, or quarantine state. This
  preserves the same second recovery mechanism under another name.
- Reconcile opposing persisted debts. It adds branches to repair contradictions created
  by state that should not exist.
- Move the Dropbox journal to settings, another store, or a deterministic remote temp
  name. That changes storage location, not semantics.
- Treat rollback failure or unknown placement as success. This would commit an unverified
  endpoint and violate commit-last.
- Infer general folder renames from descendants or content similarity after restart.
  Those facts do not prove identity and can overwrite an independent remote change.

{% transition from="proposed" to="accepted" date="2026-09-03" %}
Approved by the project owner: remove both persisted intermediate states and preserve
error convergence through ordinary re-sync.
{% /transition %}
