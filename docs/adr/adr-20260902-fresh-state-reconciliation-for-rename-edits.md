---
id: adr-20260902-fresh-state-reconciliation-for-rename-edits
kind: adr
title: Reconcile local rename edits from fresh state
status: accepted
created: '2026-09-02'
decision_makers:
- user
tags:
- sync
- convergence
- rename
owners: []
relations:
- {type: originatedFrom, target: change-20260902-sync-outcome-convergence}
- {type: supersedes, target: adr-20260902-authorized-operation-journal-with-nonreplaying-attention}
- {type: supersedes, target: adr-20260902-compound-conflict-resolution-and-conditional-mutation}
- {type: modifies, target: adr-20260831-admission-owns-identity-component-decisi}
- {type: modifies, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
source_paths:
- src/sync/sync-cycle-planning.ts
- src/sync/plan-admission.ts
- src/sync/identity-component-decision.ts
- src/sync/plan-executor.ts
- src/sync/conflict-resolver.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/rename-debt.ts
- src/sync/orchestrator.ts
summary: Treat a local rename plus edit as fresh convergence work, use existing conflict
  strategy only for observed remote change, and recover without pending state.
consequences:
  positive:
  - Unchanged remote rename edits converge automatically without indefinite deferred replay.
  - Failure recovery uses current local/baseline/remote truth and adds no sensitive durable payload or workflow.
  - Existing provider/checkpoint interfaces and shared contract discipline remain unchanged.
  negative:
  - Every recovery invocation pays fresh observation cost and may return retryable unknown when correlation cannot be proved.
  - Existing interfaces do not provide linearizability against an external writer racing after the final snapshot.
  neutral:
  - ConflictStrategy remains auto_merge or duplicate and existing commit-last/COLD recovery remains authoritative.
  - SyncState v6 is not migrated; existing debt becomes candidate endpoint evidence only.
confirmation: Exhaustive fresh-state, partial-effect restart, existing conflict-adapter,
  retryable-no-row, exact legacy release, and full project gate tests.
updated: '2026-09-04'
---

# Reconcile local rename edits from fresh state

## Context

A synchronized local rename plus content edit currently fails native rename shaping and can become an indefinitely replayed `rename_mismatch`. The user confirmed that the local rename/edit is not conflict: unchanged remote baseline must converge to the new path/content; only observed remote identity/content/path or destination change uses configured conflict handling.

The same consultation rejected a durable operation journal, pinned payload, pending replay, `requires_attention`, new all-provider conditional mutation, and operation-bound checkpoint receipt.

## Decision

Each invocation derives the component solely from current local state, committed `SyncRecord`, and fresh remote identity/content/endpoint observations through existing interfaces. The exclusive states are:

1. remote baseline identity/content at old and destination absent;
2. same identity already at new with baseline content;
3. same identity at new with current local content;
4. remote identity/content/path changed;
5. destination occupied by a distinct identity;
6. required evidence unknown or contradictory.

The same rule applies to a current local case alias with no baseline. Observation emits
only the alias and endpoint/identity/content facts. Admission treats the local physical
spelling as canonical only under complete proof and emits an explicit cycle-local
protocol; otherwise it rejects the component. Acquisition temperature, global record
count, schema version, and previous failure do not select a state.

Admission authorizes one serial compound rename/write only for state 1, write-only for state 2, and state-only baseline repair for state 3. States 4–5 enter a narrow path-aware adapter to existing `auto_merge | duplicate`; no rename/write happens first. State 6 is a retryable current-invocation error with no action or pending row.

For aligned children of one proven case-only parent transition, Admission factors that
same fresh classification into content and topology: a locally edited child remains an
ordinary push at the provider-current path, a remotely changed child remains conflict
work, and only the redundant child rename is consumed. One parent folder rename follows
through the existing structural phase and rewrites the successful descendant records.

The executor uses existing rename/write operations and commits the admitted record only after terminal verification. Failure or crash never commits the remote checkpoint; already successful per-file records retain their ordinary post-I/O semantics. The next ordinary sync uses the last committed checkpoint/baseline and current observations to classify again. No raw rename retry and no rollback rename are allowed.

Conflict adaptation is transient. It supplies old merge-base path, new local path, current remote path, and target path to existing resolver behavior. Each fresh invocation delegates at most once to configured existing resolver semantics. Content equality does not establish ownership of a prior conflict output, and this ADR adds no exactly-once conflict-artifact guarantee or durable conflict-result state.

Existing v6 `RenameDebt` does not authorize replay. It may keep old/new endpoints in COLD acquisition, after which fresh observations alone authorize. It remains physically unchanged and is exact-released only through existing successful consequence plus clean checkpoint finalization. No migration, quarantine store, marker, or special rollback workflow is added.

Existing provider and checkpoint interfaces remain. This decision is snapshot-bounded and does not claim an atomic guard against an external remote writer after the final observation.

## Rejected alternatives

- Journal, pinned content, pending replay, attention workflow, quota/security lifecycle.
- New provider-wide conditional mutation and operation checkpoint receipt.
- Treat local rename/edit itself as conflict.
- Execute independent delete plus push or blindly retry a timed-out rename.
- Roll back a partial rename.
- Migrate, transform, broadly delete, or convert v6 debt into authority.

## Consequences

{% consequence kind="positive" %} The intended unchanged-remote case converges with no durable recovery mechanism, and observed remote change still uses configured conflict handling. {% /consequence %}

{% consequence kind="negative" %} Recovery repeats fresh observation and can remain retryable unknown when evidence cannot prove one component; external post-snapshot races retain current interface limits. {% /consequence %}

{% consequence kind="neutral" %} Existing Admission ownership, provider abstraction, COLD recovery, conflict strategies, SyncState v6, and checkpoint-last finalization remain the governing boundaries. {% /consequence %}

## Consultation provenance

Accepted from `consultation-fresh-reconciliation-20260902`, evidence `user-approve-fresh-reconciliation-20260902`, confidence confirmed. The user explicitly approved this direction and rejected both earlier proposed mechanisms.

## Confirmation

Verify all six fresh rows, unchanged convergence, remote/destination conflict before mutation, every partial-effect restart cut, retryable failure with no row, at most one existing-resolver delegation per fresh invocation, exact v6 release after clean checkpoint, unchanged provider/checkpoint interfaces, and the full repository gate. Do not assert cross-invocation conflict-artifact deduplication.

{% transition from="proposed" to="accepted" date="2026-09-02" %}
Confirmed user consultation approved stateless fresh reconciliation and existing boundaries.
{% /transition %}
