---
id: adr-20260902-compound-conflict-resolution-and-conditional-mutation
kind: adr
title: Resolve compound rename conflicts through conditional mutation receipts
status: rejected
created: '2026-09-02'
decision_makers:
- user
tags:
- sync
- conflict
- filesystem
- checkpoint
owners: []
relations:
- {type: originatedFrom, target: change-20260902-sync-outcome-convergence}
- {type: references, target: adr-20260902-authorized-operation-journal-with-nonreplaying-attention}
source_paths:
- src/fs/interface.ts
- src/fs/caching/remote-fs.ts
- src/sync/plan-executor.ts
- src/sync/conflict-resolver.ts
- src/sync/conflict.ts
- src/sync/merge.ts
- src/sync/sync-cycle-finalization.ts
summary: Rejected conditional-provider and checkpoint-receipt proposal; confirmed
  consultation retained existing interfaces and conflict strategies.
updated: '2026-09-02'
consequences:
  positive:
  - Concurrent remote changes cannot be overwritten between observation and mutation.
  - Auto-merge and duplicate recover the same exact result after every crash boundary.
  - Exact checkpoint receipts distinguish this operation from an older committed checkpoint.
  negative:
  - Every backend must implement and prove a stronger conditional mutation and checkpoint contract before rollout.
  - Conflict execution and finalization require additional receipt persistence and readback.
  neutral:
  - ConflictStrategy remains auto_merge or duplicate and no interactive conflict UI is added.
  - Provider-specific wire details remain behind IFileSystem and its shared contracts.
confirmation: All-provider shared and live capability evidence, compound resolver crash
  tests, precondition race tests, deterministic duplicate tests, and receipt readback tests.
---

# Resolve compound rename conflicts through conditional mutation receipts

## Consultation disposition

Rejected by confirmed consultation `consultation-fresh-reconciliation-20260902` (`user-approve-fresh-reconciliation-20260902`). The user retained existing provider/checkpoint interfaces and configured conflict strategies, with fresh state recomputation after failure. This document remains the historical rejected alternative; it is not an implementation contract.

## Context

Current `ConflictResolverContext` describes one path and existing resolver writes are unconditional. A rename-plus-edit conflict needs old-path baseline bytes, new-path local bytes, current remote bytes/path/version, stable identity, both endpoint occupants, and authorization identity. Without that context, `auto_merge` can read the wrong base/path and `duplicate` can allocate a second suffix after crash. A detached preflight token alone does not prevent a remote change between observation and mutation.

Current `IncrementalCheckpoint` proves only checkpoint existence/scope. After terminal baseline commit and crash, that proof cannot distinguish a checkpoint containing this operation from an older one, so journal cleanup cannot be justified.

## Decision

The provider-neutral filesystem boundary shall expose detached identity/path/content observation and conditional rename/write whose preconditions are enforced by remote authority against exact stable identity, version, source path, and destination occupancy. Results are `applied` with an exact receipt, `precondition_changed` with zero effect, or typed transport/auth failure. A local `stat` followed by unconditional mutation is forbidden.

Provider capability is unverified today. The first delivery unit is a rollout-blocking spike using official/API evidence, RED shared witnesses, and targeted live scenarios for Google Drive, Dropbox, and OneDrive. All registered families must satisfy one contract before the feature is enabled anywhere. Missing credentials are unverified; unsupported capability blocks delivery; neither permits preflight-only fallback.

Fresh authority classifies exactly six domain states: baseline identity at old with destination absent; identity moved with baseline content; fully converged target; changed remote identity/content; distinct destination occupant; or unknown. Contradictory provider results are epistemic inconclusive. Only the first two permit their exact conditional effect; convergence performs none; changed/destination states enter compound conflict; bounded unknown/inconclusive enters the journal ADR's attention authority.

For this operation only, the resolver receives an immutable compound context: operation/authorization digest, stable remote identity, old-path baseline bytes, new-path pinned local bytes, current remote bytes/path/version, both endpoint occupants, and configured strategy. It returns a typed prepared result, not unrestricted filesystem handles.

`auto_merge` computes pure result bytes/digest and persists them before guarded move/write. `duplicate` derives a deterministic path from operation ID and side, persists path/bytes before I/O, and requires absence. Each local/remote effect has an expected condition and exact result witness. Recovery reobserves the same identity/digest/path. A different deterministic-path occupant becomes attention; it never allocates `.conflict-2`. A newer remote token is never overwritten.

Checkpoint proof becomes operation-bound. Before commit, Finalization persists an expected binding containing prior checkpoint generation, next provider checkpoint value digest, scope fingerprint, sorted terminal operation authorization digests, and terminal `SyncRecord` versions. The backend atomically commits cursor/cache plus binding and returns `{generation, bindingDigest}`. Repeating the same commit is idempotent and returns the same receipt; a different existing binding is conflict. Exact fresh readback is required before cleanup. `hasCheckpoint()`, scope match alone, old generation, or mismatched binding cannot release a row.

## Rejected alternatives

- Preflight observation plus existing unconditional `rename/write`: leaves a check-to-use overwrite window.
- Pass the compound operation through current one-path resolver: loses a version/path/identity input and exposes unconditional effects.
- Let duplicate allocate the next free suffix on recovery: one operation can create `.conflict-2`.
- Trust journal phase or an acknowledged response as effect truth: crash/lost responses can duplicate effects.
- Treat checkpoint existence as operation proof: it cannot distinguish old and current commit.
- Enable providers independently: backend-dependent correctness would enter the backend-agnostic sync core.

## Consequences

{% consequence kind="positive" %} Every remote/resolver effect is identity/version/path guarded and an uncertain response is resolved by exact reobservation. {% /consequence %}

{% consequence kind="negative" %} Rollout cannot proceed until every registered provider proves the stronger capability and checkpoint receipt contract. {% /consequence %}

{% consequence kind="neutral" %} Conflict settings remain `auto_merge | duplicate`; provider wire differences stay behind shared filesystem contracts. {% /consequence %}

## Confirmation

Run the mandatory shared family matrix and targeted live scenarios. Inject token changes between observation and effect and require zero overwrite. Crash before/after every merge/duplicate effect and require the same result/path/audit. Crash after checkpoint commit and require exact binding readback; old/existence-only/mismatched receipts must retain the row and repeat no effect.

{% transition from="proposed" to="rejected" date="2026-09-02" %}
Confirmed user consultation rejected new conditional-provider and operation-receipt mechanisms.
{% /transition %}
