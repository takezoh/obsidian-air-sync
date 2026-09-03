---
id: adr-20260902-authorized-operation-journal-with-nonreplaying-attention
kind: adr
title: Use an authorized operation journal with non-replaying attention
status: rejected
created: '2026-09-02'
decision_makers:
- user
tags:
- sync
- convergence
- recovery
- security
owners: []
relations:
- {type: originatedFrom, target: change-20260902-sync-outcome-convergence}
- {type: references, target: adr-20260831-admission-owned-local-rename-constraint-lifecycle}
- {type: references, target: adr-20260831-admission-owns-identity-component-decisi}
source_paths:
- src/sync/plan-admission.ts
- src/sync/plan-executor.ts
- src/sync/sync-cycle-finalization.ts
- src/sync/rename-debt.ts
- src/sync/state.ts
- src/sync/orchestrator.ts
summary: Rejected journal and attention proposal; confirmed consultation selected
  stateless fresh reconciliation instead.
updated: '2026-09-02'
consequences:
  positive:
  - Crash recovery preserves exact admitted bytes and effect evidence without reinterpreting rename paths independently.
  - Persistent uncertainty terminates visibly and ordinary triggers cannot create an indefinite replay loop.
  - Numeric capacity, trust, retention, and exact cleanup make durable content capture bounded and observable.
  negative:
  - Up to 256 MiB of plaintext file content may be retained per connected namespace and needs explicit user disclosure.
  - Attention requires a user retry or resolution and blocks the global checkpoint meanwhile.
  - Rollout is forward-only while incompatible legacy quarantine rows remain.
  neutral:
  - Admission remains the sole executable-authority owner and SyncState v6 receives no migration or field transformation.
  - Existing commit-last and disconnected-component execution rules remain binding.
confirmation: Journal fault injection, quota/corruption/security tests, attention restart
  and zero-I/O selection tests, v6 quarantine fixtures, and full repository gate.
---

# Use an authorized operation journal with non-replaying attention

## Consultation disposition

Rejected by confirmed consultation `consultation-fresh-reconciliation-20260902` (`user-approve-fresh-reconciliation-20260902`). The user selected per-invocation fresh local/baseline/remote reconciliation and explicitly rejected journal, pinned payload, pending replay, and attention workflow. This document remains the historical rejected alternative; it is not an implementation contract.

## Context

SyncState v6 `RenameDebt` retains a candidate old/new edge and ordinary triggers replay it until Admission proves a safe consequence. A rename plus local content edit can therefore remain `rename_mismatch` forever even when the remote baseline is unchanged. Renaming that durable state would not solve the authority defect: an unverifiable row selected on every normal trigger is still indefinite automatic replay.

Journal-free reconstruction is smaller but cannot preserve the exact bytes Admission authorized when the local file changes again or the process restarts. Conversely, storing full bytes without capacity and trust rules makes a finite correctness mechanism an unbounded sensitive-data store.

## Decision

Introduce a dedicated namespace-scoped IndexedDB operation journal. A row exists only after Admission has authorized one concrete regular-file rename-plus-edit intent. It contains deterministic operation/authorization identities, immutable admitted bytes and digest, baseline stable identity/version/content, old/new path, scope fingerprint, effect/conflict receipts, terminal `SyncRecord` version, expected checkpoint binding, invocation generation, and attention/retention metadata. Stored phase is diagnostic and never effect authority.

Before selected filesystem I/O, the journal atomically consumes the eligible invocation and sets ordinary replay false. Fresh remote identity/version/content derives the legal next effect. A bounded invocation may use at most four guarded effects, twelve targeted authority observations, and three transport attempts per individual call. When authority remains `unknown` or internally contradictory (`inconclusive`), the row becomes terminal `requires_attention`. If writing the label fails, the consumed invocation still makes the row attention-ineligible on next load.

`requires_attention` is authority, not presentation. Ordinary triggers cannot issue identity/path/read/mutation I/O selected for that row and cannot mint another generation. They may continue unrelated global collection and disconnected authorized components, but the checkpoint remains blocked. Only explicit “retry” may perform fresh observation and mint a new generation when determinate. Explicit confirmed discard performs no remote mutation, deletes exact retained payload, and forces one COLD authoritative reconcile. Confirmed disconnect/reset may exact-delete only its old namespace.

Capacity is fixed: `67,108,864` bytes per operation, `268,435,456` active bytes per namespace, and at least `67,108,864` bytes reported storage headroom after admission. Unavailable quota estimate, limit failure, or IndexedDB quota exception yields a visible zero-remote-I/O outcome and no partial new row.

Pinned bytes are plaintext inside the same Obsidian host-profile/IndexedDB trust boundary as sync state. They are never logged or exported. Diagnostics expose operation ID, paths, digests, retained count/bytes, and reason only. Exact completion/discard/disconnect deletes payload/result rows. Corruption is fail-closed attention. Plugin uninstall cannot guarantee that the host deletes IndexedDB; the attention surface discloses that limitation and retained byte count.

Existing v6 `RenameDebt` is not migrated or transformed. New code treats each row as non-authoritative quarantine input to one mandatory COLD snapshot and fresh identity reconciliation. The row cannot authorize mutation and remains byte-for-byte stored until a fully authorized journal/no-action result or terminal attention handoff exists. Exact legacy deletion is coupled to terminal checkpoint receipt or explicit resolution; a new-store rollout marker records exact reconciled/deleted keys. Rollout is forward-only while quarantine remains. An older binary is unsupported because it may resume legacy replay; this ADR makes no claim that old code respects quarantine.

## Rejected alternatives

- Keep ordinary-trigger replay and rename `deferred` to `retryable`: status changes no authority.
- Drop journal bytes and re-read the path: later local edits change authorized intent.
- Expire or attempt-count-delete unresolved work: this can erase the only relationship/evidence.
- Convert v6 rows to journal rows: they lack bytes, version, and authorization and cannot be truthfully upgraded.
- Bump SyncState and cold-start all stores: it destroys unrelated baselines and does not prove the operation.
- Claim safe rollback to old replay code: old binaries have no quarantine semantics.

## Consequences

{% consequence kind="positive" %} Authorized intent, exact payload, and recovery evidence survive every crash cut while ordinary uncertainty has a finite terminal authority. {% /consequence %}

{% consequence kind="negative" %} Sensitive plaintext content can be retained up to the numeric limits and attention requires explicit user action while withholding checkpoint. {% /consequence %}

{% consequence kind="neutral" %} SyncState v6 stays physically compatible and unchanged; legacy rows are control-flow quarantine, not migrated data. {% /consequence %}

## Confirmation

Fault-inject every journal transaction and restart cut. Prove consumed/crashed/attention rows are absent from ordinary selection, ten ordinary triggers issue zero targeted calls, only explicit retry mints a generation, numeric/quota/corruption cases have zero remote I/O, logs/exports contain no payload, exact cleanup follows checkpoint receipt, and v6 fixtures never authorize replay.

{% transition from="proposed" to="rejected" date="2026-09-02" %}
Confirmed user consultation rejected the journal/attention mechanism in favor of fresh reconciliation.
{% /transition %}
